import { z } from "zod"
import {
  buildUrl,
  FeedUnauthorizedError,
  FetchFeedTransport,
  readJson,
  type FeedTransport,
} from "./transport.ts"

export const ACCOUNT_API_BASE = "https://api.fintables.com"

export interface FeedCredentials {
  username: string
  password: string
}

/**
 * The feed uses two tokens with different jobs, and mixing them up is the
 * single most confusing failure this integration has:
 *
 * - `accessToken` authenticates the account API.
 * - `streamToken` is the market data license. It is the *only* thing that lifts
 *   the 15-minute delay on exchange instruments, and the access token is
 *   rejected outright by the data endpoints.
 */
export interface FeedTokens {
  accessToken: string
  refreshToken: string
  streamToken: string
}

const TokenPairSchema = z.object({
  access: z.string().min(1),
  refresh: z.string().min(1),
})

const AccessOnlySchema = z.object({ access: z.string().min(1) })

const SessionCheckSchema = z.object({
  user: z.object({
    id: z.number(),
    email: z.string().nullable().optional(),
    stream_token: z.string().min(1),
  }),
  permissions: z.array(z.object({ action: z.string(), subject: z.string() })).default([]),
})

/** The entitlement that decides whether prices arrive live or a quarter-hour late. */
export const REALTIME_PRICE_PERMISSION = "prices.realtime"
export const DEPTH_PERMISSION = "orderbook"
/** Aracı kurum dağılımı: the brokerage distribution over the trade tape. */
export const DISTRIBUTION_PERMISSION = "akd"
/** The custody register, which the feed names after the settlement house. */
export const SETTLEMENT_PERMISSION = "custodies"

export interface FeedEntitlements {
  realtimePrices: boolean
  depth: boolean
  distribution: boolean
  settlement: boolean
  subjects: string[]
}

export interface FeedSessionState {
  tokens: FeedTokens
  entitlements: FeedEntitlements
}

export interface FeedSessionOptions {
  credentials: FeedCredentials
  transport?: FeedTransport
  baseUrl?: string
  /**
   * Notified when the license token is *replaced*, so an open connection bound to
   * the old one can redial. Deliberately silent on the first login: nothing is
   * bound yet, and announcing it there would cancel a connection that a consumer
   * had already started.
   */
  onStreamTokenRotated?: (streamToken: string) => void
}

/**
 * Owns the feed login and the market data license derived from it.
 *
 * The license token carries no expiry, so it is not refreshed on a timer.
 * Instead it is re-read when the feed rejects it, which is also how a license
 * change (a subscription starting or lapsing) surfaces.
 */
export class FeedSession {
  private state: FeedSessionState | null = null
  private pending: Promise<FeedSessionState> | null = null
  private readonly transport: FeedTransport
  private readonly baseUrl: string

  constructor(private readonly options: FeedSessionOptions) {
    this.transport = options.transport ?? new FetchFeedTransport()
    this.baseUrl = options.baseUrl ?? ACCOUNT_API_BASE
  }

  get entitlements(): FeedEntitlements | null {
    return this.state?.entitlements ?? null
  }

  /** The license token, logging in on first use. Concurrent callers share one login. */
  async streamToken(): Promise<string> {
    return (await this.ensure()).tokens.streamToken
  }

  async accessToken(): Promise<string> {
    return (await this.ensure()).tokens.accessToken
  }

  /** What the account may read, logging in first if that is not known yet. */
  async loadEntitlements(): Promise<FeedEntitlements> {
    return (await this.ensure()).entitlements
  }

  /**
   * Signs in again and returns the fresh account token.
   *
   * The account token is long lived — the one issued here carries an expiry over a
   * decade out — so this is not a refresh cycle. It is for the case where the
   * token stops being accepted anyway: revoked by a password change, or a session
   * invalidated server-side. Without it those reads would 401 for the life of the
   * process.
   */
  async renewAccessToken(): Promise<string> {
    this.state = null
    return (await this.ensure()).tokens.accessToken
  }

  private async ensure(): Promise<FeedSessionState> {
    if (this.state) return this.state
    // Collapse a burst of first-use callers into a single login rather than
    // racing several logins against the same account.
    this.pending ??= this.login().finally(() => {
      this.pending = null
    })
    return this.pending
  }

  /**
   * Re-reads the license after the feed rejected it, returning the fresh token.
   *
   * Tries the cheap path first — the account API can mint a new license from the
   * existing access token — and falls back to a full login when that is refused.
   */
  async renewStreamToken(): Promise<string> {
    const previous = this.state
    if (previous) {
      try {
        const refreshed = await this.check(previous.tokens.accessToken)
        this.adopt({
          tokens: { ...previous.tokens, streamToken: refreshed.streamToken },
          entitlements: refreshed.entitlements,
        })
        return refreshed.streamToken
      } catch (error) {
        if (!(error instanceof FeedUnauthorizedError)) throw error
      }

      const access = await this.refreshAccessToken(previous.tokens.refreshToken)
      if (access) {
        const refreshed = await this.check(access)
        this.adopt({
          tokens: { ...previous.tokens, accessToken: access, streamToken: refreshed.streamToken },
          entitlements: refreshed.entitlements,
        })
        return refreshed.streamToken
      }
    }

    this.state = null
    return (await this.ensure()).tokens.streamToken
  }

  private async login(): Promise<FeedSessionState> {
    const pair = await readJson(
      this.transport,
      {
        url: buildUrl(this.baseUrl, "/auth/token/"),
        method: "POST",
        body: { email: this.options.credentials.username, password: this.options.credentials.password },
      },
      TokenPairSchema,
    )
    const checked = await this.check(pair.access)
    const state: FeedSessionState = {
      tokens: { accessToken: pair.access, refreshToken: pair.refresh, streamToken: checked.streamToken },
      entitlements: checked.entitlements,
    }
    this.adopt(state)
    return state
  }

  private async refreshAccessToken(refreshToken: string): Promise<string | null> {
    try {
      const refreshed = await readJson(
        this.transport,
        {
          url: buildUrl(this.baseUrl, "/auth/token/refresh/"),
          method: "POST",
          body: { refresh: refreshToken },
        },
        AccessOnlySchema,
      )
      return refreshed.access
    } catch (error) {
      if (error instanceof FeedUnauthorizedError) return null
      throw error
    }
  }

  private async check(accessToken: string): Promise<{ streamToken: string; entitlements: FeedEntitlements }> {
    const checked = await readJson(
      this.transport,
      { url: buildUrl(this.baseUrl, "/auth/check/"), token: accessToken },
      SessionCheckSchema,
    )
    const subjects = checked.permissions.filter((entry) => entry.action === "read").map((entry) => entry.subject)
    // Several permissions are granted per market as well as outright, so
    // `orderbook.viop-10` entitles depth just as `orderbook` does.
    const granted = (permission: string): boolean =>
      subjects.some((subject) => subject === permission || subject.startsWith(`${permission}.`))
    return {
      streamToken: checked.user.stream_token,
      entitlements: {
        realtimePrices: subjects.includes(REALTIME_PRICE_PERMISSION),
        depth: granted(DEPTH_PERMISSION),
        distribution: granted(DISTRIBUTION_PERMISSION),
        settlement: granted(SETTLEMENT_PERMISSION),
        subjects: [...new Set(subjects)],
      },
    }
  }

  private adopt(state: FeedSessionState): void {
    const rotated = this.state !== null && this.state.tokens.streamToken !== state.tokens.streamToken
    this.state = state
    if (rotated) this.options.onStreamTokenRotated?.(state.tokens.streamToken)
  }
}

/**
 * Runs `read`, and on a rejected license mints a new one and tries once more.
 *
 * Every data call goes through this: the license rotates whenever the account's
 * subscriptions change, and the only signal is a 401 on an ordinary request.
 */
export async function withStreamToken<T>(
  session: Pick<FeedSession, "streamToken" | "renewStreamToken">,
  read: (streamToken: string) => Promise<T>,
): Promise<T> {
  const token = await session.streamToken()
  try {
    return await read(token)
  } catch (error) {
    if (!(error instanceof FeedUnauthorizedError)) throw error
    return read(await session.renewStreamToken())
  }
}

/**
 * The same, for the account API: runs `read`, and on a rejected token signs in
 * again and tries once more.
 *
 * The account token outlives any session, so this is not about expiry. It is the
 * difference between a revoked token costing one request and costing every
 * request until the process restarts.
 */
export async function withAccessToken<T>(
  session: Pick<FeedSession, "accessToken" | "renewAccessToken">,
  read: (accessToken: string) => Promise<T>,
): Promise<T> {
  const token = await session.accessToken()
  try {
    return await read(token)
  } catch (error) {
    if (!(error instanceof FeedUnauthorizedError)) throw error
    return read(await session.renewAccessToken())
  }
}

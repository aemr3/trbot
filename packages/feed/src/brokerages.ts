import { z } from "zod"
import { ACCOUNT_API_BASE, withAccessToken, type FeedSession } from "./session.ts"
import { buildUrl, FetchFeedTransport, readJson, type FeedTransport } from "./transport.ts"

/**
 * The directory of brokerage houses.
 *
 * Every broker feed speaks in short codes — `OYA`, `TGB`, `AKM` — which mean
 * nothing on screen, so the directory is read once per run and shared by the
 * trade tape, the distribution and the custody register alike.
 *
 * Codes the directory does not carry are rendered as themselves. The custody
 * register in particular reports a synthetic `FARK` row for the lots it cannot
 * attribute to a house, and a code on screen beats a blank where a name belongs.
 */

const BrokerageSchema = z.object({
  code: z.string(),
  title: z.string(),
  short_title: z.string().nullish(),
})

const BrokerageListSchema = z.array(BrokerageSchema)

export interface FeedBrokerageDirectoryOptions {
  transport?: FeedTransport
  baseUrl?: string
}

export class FeedBrokerageDirectory {
  private readonly transport: FeedTransport
  private readonly baseUrl: string
  private cached: Map<string, string> | null = null
  private loading: Promise<Map<string, string>> | null = null

  constructor(
    private readonly session: Pick<FeedSession, "accessToken" | "renewAccessToken">,
    options: FeedBrokerageDirectoryOptions = {},
  ) {
    this.transport = options.transport ?? new FetchFeedTransport()
    this.baseUrl = options.baseUrl ?? ACCOUNT_API_BASE
  }

  /** Short names by code, read once and reused. */
  async names(signal?: AbortSignal): Promise<Map<string, string>> {
    if (this.cached) return this.cached
    this.loading ??= withAccessToken(this.session, (token) =>
      readJson(
        this.transport,
        { url: buildUrl(this.baseUrl, "/brokerages/"), token, signal },
        BrokerageListSchema,
      ))
      .then((rows) => {
        const names = new Map(rows.map((row) => [row.code, row.short_title?.trim() || row.title]))
        this.cached = names
        return names
      })
      .finally(() => {
        this.loading = null
      })
    return this.loading
  }
}

/** The house's name, or the code itself when the directory does not carry it. */
export function brokerageName(names: Map<string, string>, code: string): string {
  return names.get(code) ?? code
}

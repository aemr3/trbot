import type { AuthOperationOptions, Credential, CredentialStore } from "@earendil-works/pi-ai"
import { CHATGPT_PROVIDER_ID, type ProviderState, type ProviderStateStore } from "./provider-state.ts"

interface StoredCredentialsOptions {
  now?: () => number
}

/**
 * The harness's credential store, over this application's own table.
 *
 * The harness resolves and refreshes credentials itself, but it does not own where
 * they live — so this is the adapter, and it is the only part of token handling
 * that stays ours. Everything it used to sit alongside (an expiry margin, a
 * single-flight refresh, a refresh call) belongs to the harness now.
 *
 * The rows are keyed by the harness's own provider id, so nothing here translates
 * a name; see `CHATGPT_PROVIDER_ID`.
 */
export class StoredCredentials implements CredentialStore {
  private readonly now: () => number

  /** One write at a time per provider, which is what `modify` promises. */
  private writes: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly states: ProviderStateStore,
    options: StoredCredentialsOptions = {},
  ) {
    this.now = options.now ?? Date.now
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const state = await this.states.get(providerId)
    return state ? toCredential(state) : undefined
  }

  async list(): Promise<readonly { providerId: string; type: Credential["type"] }[]> {
    const state = await this.states.get(CHATGPT_PROVIDER_ID)
    return state ? [{ providerId: CHATGPT_PROVIDER_ID, type: "oauth" }] : []
  }

  /**
   * The only write path, serialized so a refresh and a login cannot interleave
   * and lose a rotated token. One process holds this store — the same invariant
   * the monitors rely on — so a promise chain is the whole mechanism.
   */
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    const write = this.writes.then(async () => {
      const previous = await this.states.get(providerId)
      const next = await fn(previous ? toCredential(previous) : undefined)
      if (!next) return previous ? toCredential(previous) : undefined
      await this.states.put(this.toState(providerId, next, previous))
      return next
    })
    // Kept so the next writer waits for this one, whether or not it succeeded.
    this.writes = write.catch(() => undefined)
    return write
  }

  async delete(providerId: string): Promise<void> {
    const write = this.writes.then(() => this.states.delete(providerId))
    this.writes = write.catch(() => undefined)
    await write
  }

  private toState(providerId: string, credential: Credential, previous: ProviderState | null): ProviderState {
    if (credential.type !== "oauth") {
      throw new Error("The ChatGPT connection is an OAuth credential, not an API key")
    }
    const now = this.now()
    return {
      providerId,
      accessToken: credential.access,
      refreshToken: credential.refresh,
      expiresAt: credential.expires,
      accountId: accountIdOf(credential) ?? previous?.accountId ?? null,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
  }
}

function toCredential(state: ProviderState): Credential {
  return {
    type: "oauth",
    access: state.accessToken,
    refresh: state.refreshToken,
    expires: state.expiresAt,
    // Carried because the harness puts it there and reads it back; nothing in this
    // application decodes a token to find it.
    ...(state.accountId === null ? {} : { accountId: state.accountId }),
  }
}

function accountIdOf(credential: Credential): string | null {
  const accountId = (credential as { accountId?: unknown }).accountId
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null
}

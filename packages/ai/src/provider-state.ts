/**
 * The stored AI connection, named as the harness names the provider.
 *
 * A provider id is the harness's own vocabulary — it looks a credential up by this
 * exact string — so this is one of the few places an external name belongs in a
 * column. Naming it anything else only bought a translation on every read and
 * write.
 *
 * A connection stored under the earlier name, `openai`, is not found under this
 * one: that row is left where it is and the trader connects once more. No
 * migration rewrites it, because nothing but a fresh login can be sure the
 * credential in it is still good.
 */
export const CHATGPT_PROVIDER_ID = "openai-codex"

export interface ProviderState {
  providerId: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId: string | null
  createdAt: number
  updatedAt: number
}

export interface ProviderStateStore {
  get(providerId: string): Promise<ProviderState | null>
  put(state: ProviderState): Promise<void>
  delete(providerId: string): Promise<void>
}

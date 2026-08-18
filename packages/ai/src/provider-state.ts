export const CHATGPT_PROVIDER_ID = "openai"

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

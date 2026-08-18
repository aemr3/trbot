/**
 * The AI account as a client sees it.
 *
 * ChatGPT tokens live on the server beside the provider credentials, so nothing
 * here carries one: a client learns which account is connected, never how to
 * act as it.
 */
export interface AiAccountSummary {
  providerId: string
  accountId: string | null
  connectedAt: number
  updatedAt: number
}

/**
 * What a finished login hands to the server.
 *
 * The provider only redirects an authorization to a loopback address, so the
 * login runs where the trader is sitting and its result travels inward — the same
 * direction as the provider password on the sign-in route. This is the only
 * message in the protocol that carries a token, and it only ever travels this way.
 */
export interface AiCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId: string | null
}

export interface AiLoginOptions {
  signal?: AbortSignal
  /** Reported so a trader whose browser did not open can follow the link. */
  onAuthorizationUrl?: (url: string) => void
  onBrowserError?: (error: unknown) => void
  /**
   * Asked for the authorization code when the redirect could not be caught —
   * a machine with no browser, or one where the callback port is already taken.
   * Resolving with an empty string cancels the login.
   */
  onManualCode?: (message: string) => Promise<string>
}

export interface AiAccount {
  getState(): Promise<AiAccountSummary | null>
  connect(options?: AiLoginOptions): Promise<AiAccountSummary>
  disconnect(): Promise<void>
}

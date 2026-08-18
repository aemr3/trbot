/**
 * The AI account as a client sees it.
 *
 * ChatGPT tokens live on the server beside the provider credentials, so nothing
 * here carries one: a client learns which account is connected, never how to
 * act as it.
 */
export interface AiAccountSummary {
  providerId: string
  email: string | null
  accountId: string | null
  connectedAt: number
  updatedAt: number
}

/**
 * An authorization the server has begun and is waiting to finish.
 *
 * The provider only redirects to a loopback address, so the browser and the
 * listener that catches the redirect must both run on the trader's machine even
 * though the server owns the exchange. The client opens `authorizationUrl`,
 * listens on `redirectUri`, and posts the code back under `loginId`.
 */
export interface AiLoginStart {
  loginId: string
  authorizationUrl: string
  redirectUri: string
  expiresAt: number
}

/** What the client caught at the redirect. The code is single-use. */
export interface AiLoginCallback {
  loginId: string
  code: string
  state: string
}

export interface AiLoginOptions {
  signal?: AbortSignal
  /** Reported so a trader whose browser did not open can follow the link. */
  onAuthorizationUrl?: (url: string) => void
  onBrowserError?: (error: unknown) => void
}

export interface AiAccount {
  getState(): Promise<AiAccountSummary | null>
  connect(options?: AiLoginOptions): Promise<AiAccountSummary>
  disconnect(): Promise<void>
}

import type { AuthStore } from "./store.ts"

/** An auth store bound to an open resource, released when the session closes. */
export interface AuthSession {
  store: AuthStore
  close(): void
}

/**
 * Opens an auth session. The application supplies the implementation so callers
 * that need a store — the API client in particular — stay free of storage concerns.
 */
export type OpenAuthSession = () => Promise<AuthSession>

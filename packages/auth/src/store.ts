import type { AuthState } from "./state.ts"

export interface AuthStore {
  get(accountKey: string): Promise<AuthState | null>
  latest(): Promise<AuthState | null>
  put(state: AuthState): Promise<void>
}

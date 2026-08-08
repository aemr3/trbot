import { desc, eq } from "drizzle-orm"
import type { AuthState } from "../auth/state.ts"
import type { AuthStore } from "../auth/store.ts"
import type { AppDatabase } from "./client.ts"
import { authState } from "./schema.ts"

export class DrizzleAuthStore implements AuthStore {
  constructor(private readonly db: AppDatabase) {}

  async get(accountKey: string): Promise<AuthState | null> {
    const [state] = await this.db.select().from(authState).where(eq(authState.accountKey, accountKey)).limit(1)
    return state ?? null
  }

  async latest(): Promise<AuthState | null> {
    const [state] = await this.db.select().from(authState).orderBy(desc(authState.updatedAt)).limit(1)
    return state ?? null
  }

  async put(state: AuthState): Promise<void> {
    await this.db
      .insert(authState)
      .values(state)
      .onConflictDoUpdate({
        target: authState.accountKey,
        set: {
          memberUid: state.memberUid,
          accessToken: state.accessToken,
          refreshToken: state.refreshToken,
          accessTokenExpiresAt: state.accessTokenExpiresAt,
          deviceId: state.deviceId,
          userAgentUid: state.userAgentUid,
          privateKeyPem: state.privateKeyPem,
          publicKeyBase64: state.publicKeyBase64,
          loginReferenceCode: state.loginReferenceCode,
          updatedAt: state.updatedAt,
        },
      })
  }
}

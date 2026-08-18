import { eq } from "drizzle-orm"
import type { ProviderState, ProviderStateStore } from "@trbot/ai/provider-state.ts"
import type { AppDatabase } from "./client.ts"
import { providerState } from "./schema.ts"

export class DrizzleProviderStateStore implements ProviderStateStore {
  constructor(private readonly db: AppDatabase) {}

  async get(providerId: string): Promise<ProviderState | null> {
    const [state] = await this.db.select().from(providerState).where(eq(providerState.providerId, providerId)).limit(1)
    return state ?? null
  }

  async put(state: ProviderState): Promise<void> {
    await this.db
      .insert(providerState)
      .values(state)
      .onConflictDoUpdate({
        target: providerState.providerId,
        set: {
          accessToken: state.accessToken,
          refreshToken: state.refreshToken,
          expiresAt: state.expiresAt,
          accountId: state.accountId,
          updatedAt: state.updatedAt,
        },
      })
  }

  async delete(providerId: string): Promise<void> {
    await this.db.delete(providerState).where(eq(providerState.providerId, providerId))
  }
}

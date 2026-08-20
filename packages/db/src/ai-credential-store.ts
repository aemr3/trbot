import { eq } from "drizzle-orm"
import type { AiCredentialRecord, AiCredentialStore } from "@trbot/ai/credential-store.ts"
import { asCredential } from "@trbot/ai/credentials.ts"
import type { AppDatabase } from "./client.ts"
import { aiCredentials } from "./schema.ts"

/**
 * Provider credentials, one row per provider.
 *
 * The credential is stored as the harness handed it over, so a field this build has
 * never heard of survives a round trip. A row whose JSON no longer parses is reported
 * as absent rather than failing the read: the trader reconnects that provider, which
 * is the only thing that could fix it anyway.
 */
export class DrizzleAiCredentialStore implements AiCredentialStore {
  constructor(private readonly db: AppDatabase) {}

  async get(providerId: string): Promise<AiCredentialRecord | null> {
    const [row] = await this.db.select().from(aiCredentials).where(eq(aiCredentials.providerId, providerId)).limit(1)
    return row ? toRecord(row) : null
  }

  async list(): Promise<AiCredentialRecord[]> {
    const rows = await this.db.select().from(aiCredentials)
    const records: AiCredentialRecord[] = []
    for (const row of rows) {
      const record = toRecord(row)
      if (record) records.push(record)
    }
    return records
  }

  async put(record: AiCredentialRecord): Promise<void> {
    const row = {
      providerId: record.providerId,
      credential: JSON.stringify(record.credential),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
    await this.db
      .insert(aiCredentials)
      .values(row)
      .onConflictDoUpdate({
        target: aiCredentials.providerId,
        set: { credential: row.credential, updatedAt: row.updatedAt },
      })
  }

  async delete(providerId: string): Promise<void> {
    await this.db.delete(aiCredentials).where(eq(aiCredentials.providerId, providerId))
  }
}

function toRecord(row: typeof aiCredentials.$inferSelect): AiCredentialRecord | null {
  const credential = parseJson(row.credential)
  if (credential === undefined) return null
  return {
    providerId: row.providerId,
    credential,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function parseJson(value: string): ReturnType<typeof asCredential> {
  try {
    return asCredential(JSON.parse(value))
  } catch {
    return undefined
  }
}

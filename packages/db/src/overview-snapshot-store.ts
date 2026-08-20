import type {
  OverviewSnapshotStore,
  StoredOverviewSnapshot,
} from "@trbot/market/overview.ts"
import { MarketOverviewDigestSchema, type MarketOverviewDigest } from "@trbot/market/overview.ts"
import type { AppDatabase } from "./client.ts"
import { overviewSnapshots } from "./schema.ts"

// Digests are plain data compared by structural equality, so JSON is enough to
// round-trip them; a row whose digest no longer parses is dropped rather than
// failing the load, since the next run regenerates it anyway.
export class DrizzleOverviewSnapshotStore implements OverviewSnapshotStore {
  constructor(private readonly db: AppDatabase) {}

  async list(): Promise<StoredOverviewSnapshot[]> {
    const rows = await this.db.select().from(overviewSnapshots)
    const snapshots: StoredOverviewSnapshot[] = []
    for (const row of rows) {
      const digest = parseDigest(row.digest)
      if (!digest) continue
      snapshots.push({
        instrumentUid: row.instrumentUid,
        mode: digest.mode,
        digest,
        commentary: row.commentary,
        generatedAt: row.generatedAt,
      })
    }
    return snapshots
  }

  async put(snapshot: StoredOverviewSnapshot): Promise<void> {
    const digest = JSON.stringify(snapshot.digest)
    const row = {
      instrumentUid: snapshot.instrumentUid,
      mode: snapshot.mode,
      digest,
      commentary: snapshot.commentary,
      generatedAt: snapshot.generatedAt,
      updatedAt: Date.now(),
    }
    await this.db
      .insert(overviewSnapshots)
      .values(row)
      .onConflictDoUpdate({
        target: [overviewSnapshots.instrumentUid, overviewSnapshots.mode],
        set: {
          digest: row.digest,
          commentary: row.commentary,
          generatedAt: row.generatedAt,
          updatedAt: row.updatedAt,
        },
      })
  }
}

function parseDigest(value: string): MarketOverviewDigest | null {
  try {
    const parsed = MarketOverviewDigestSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

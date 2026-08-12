import { and, asc, eq, sql } from "drizzle-orm"
import type { CandleHistoryStore } from "../market/candle-history.ts"
import type { Candle, CandleInterval } from "../market/candle.ts"
import type { AppDatabase } from "./client.ts"
import { marketCandles } from "./schema.ts"

const INSERT_CHUNK_SIZE = 100

export class DrizzleCandleHistoryStore implements CandleHistoryStore {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  async put(instrumentUid: string, interval: CandleInterval, candles: Candle[]): Promise<void> {
    for (let offset = 0; offset < candles.length; offset += INSERT_CHUNK_SIZE) {
      const values = candles.slice(offset, offset + INSERT_CHUNK_SIZE).map((candle) => ({
        instrumentUid,
        interval,
        timestamp: candle.timestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        updatedAt: this.now(),
      }))
      if (values.length === 0) continue
      await this.db.insert(marketCandles).values(values).onConflictDoUpdate({
        target: [marketCandles.instrumentUid, marketCandles.interval, marketCandles.timestamp],
        set: {
          open: sql`excluded.open`,
          high: sql`excluded.high`,
          low: sql`excluded.low`,
          close: sql`excluded.close`,
          volume: sql`excluded.volume`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
    }
  }

  async list(instrumentUid: string, interval: CandleInterval): Promise<Candle[]> {
    const rows = await this.db.select().from(marketCandles)
      .where(and(eq(marketCandles.instrumentUid, instrumentUid), eq(marketCandles.interval, interval)))
      .orderBy(asc(marketCandles.timestamp))
    return rows.map((row) => ({
      timestamp: row.timestamp,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    }))
  }
}

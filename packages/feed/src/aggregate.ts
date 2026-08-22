import { calendarKey, type CalendarPeriod } from "@trbot/market/calendar.ts"
import type { Candle } from "@trbot/market/candle.ts"

/**
 * Folding finer candles into coarser ones.
 *
 * The feed serves only 1, 5, 15, and 60 minute bars plus daily — its
 * `supported_resolutions` advertises `30`, `240`, `W`, and `M` as well, but every
 * one of those is rejected with HTTP 400. The truthful list is the symbol's
 * `intraday_multipliers`. So the remaining grains are built here from the finest
 * one the feed will actually serve, which is what the charting library does when
 * a datafeed reports `has_weekly_and_monthly: false`.
 */

function fold(bucket: Candle[], timestamp: number): Candle | null {
  const first = bucket[0]
  const last = bucket[bucket.length - 1]
  if (!first || !last) return null

  let high = first.high
  let low = first.low
  let volume: number | null = null
  for (const candle of bucket) {
    if (candle.high > high) high = candle.high
    if (candle.low < low) low = candle.low
    if (candle.volume !== null) volume = (volume ?? 0) + candle.volume
  }

  // Open comes from the first bar in the bucket and close from the last, so the
  // folded bar spans exactly what its parts did.
  return { timestamp, open: first.open, high, low, close: last.close, volume }
}

/**
 * Folds candles into fixed `bucketMs` windows, aligned to the epoch.
 *
 * Epoch alignment is exact for the grains this serves: 15-minute bars land on
 * :00/:15/:30/:45, so pairs fold cleanly into half hours. A four-hour bucket is
 * aligned to absolute time rather than to the session's open, so the first bar
 * of a session can be shorter than the rest — the same compromise the charting
 * library makes.
 */
export function aggregateByDuration(candles: Candle[], bucketMs: number): Candle[] {
  if (bucketMs <= 0) return candles
  const folded: Candle[] = []
  let bucket: Candle[] = []
  let start: number | null = null

  for (const candle of candles) {
    const bucketStart = Math.floor(candle.timestamp / bucketMs) * bucketMs
    if (start !== null && bucketStart !== start) {
      const merged = fold(bucket, start)
      if (merged) folded.push(merged)
      bucket = []
    }
    start = bucketStart
    bucket.push(candle)
  }

  if (start !== null) {
    const merged = fold(bucket, start)
    if (merged) folded.push(merged)
  }
  return folded
}

/**
 * Folds candles into calendar weeks or months in the exchange's time zone.
 *
 * A bar is stamped with the first session it contains rather than the nominal
 * period start, so a week beginning on a holiday is not stamped to a day the
 * market never traded.
 */
export function aggregateByCalendar(candles: Candle[], period: CalendarPeriod): Candle[] {
  const folded: Candle[] = []
  let bucket: Candle[] = []
  let key: string | null = null
  let stamp = 0

  for (const candle of candles) {
    const current = calendarKey(candle.timestamp, period)

    if (key !== null && current !== key) {
      const merged = fold(bucket, stamp)
      if (merged) folded.push(merged)
      bucket = []
    }
    if (bucket.length === 0) stamp = candle.timestamp
    key = current
    bucket.push(candle)
  }

  if (key !== null) {
    const merged = fold(bucket, stamp)
    if (merged) folded.push(merged)
  }
  return folded
}


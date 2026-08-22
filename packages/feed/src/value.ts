import { z } from "zod"

/**
 * A single value as the feed sends it.
 *
 * The realtime protocol is untyped per field: one topic carries a price, the
 * next a session code, and a cleared field arrives as null. Parsing to this
 * union at the socket boundary is what lets everything downstream work with a
 * known shape instead of inspecting raw JSON.
 */
export const FeedValueSchema = z.union([z.number(), z.string(), z.boolean(), z.null()])

export type FeedValue = z.infer<typeof FeedValueSchema>

/** An object of feed values, as carried by depth and trade frames. */
export const FeedRecordSchema = z.record(z.string(), FeedValueSchema)

export type FeedRecord = z.infer<typeof FeedRecordSchema>

/**
 * A snapshot row. Most entries are plain values, but the order book arrives
 * nested: one `ob/<side>/<level>` key per level, each holding a level object.
 */
export const FeedSnapshotRowSchema = z.record(z.string(), z.union([FeedValueSchema, FeedRecordSchema]))

export type FeedSnapshotRow = z.infer<typeof FeedSnapshotRowSchema>

/** The nested level object, when this snapshot entry carries one. */
export function asRecord(value: FeedValue | FeedRecord | undefined): FeedRecord | null {
  const parsed = FeedRecordSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

const FiniteNumberSchema = z.number().finite()
const TextSchema = z.union([z.string().min(1), z.number().transform((value) => String(value))])

/** The value as a usable number, or null when the feed sent anything else. */
export function asNumber(value: FeedValue | undefined): number | null {
  const parsed = FiniteNumberSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** The value as text. Session and status codes arrive as either strings or numbers. */
export function asText(value: FeedValue | undefined): string | null {
  const parsed = TextSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** The first of `keys` that holds a number. */
export function pickNumber(record: FeedRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = asNumber(record[key])
    if (value !== null) return value
  }
  return null
}

/** The first of `keys` that holds text. */
export function pickText(record: FeedRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = asText(record[key])
    if (value !== null) return value
  }
  return null
}

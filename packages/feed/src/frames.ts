import { z } from "zod"
import { FeedRecordSchema, FeedSnapshotRowSchema, FeedValueSchema } from "./value.ts"

/**
 * The realtime protocol's frames.
 *
 * Everything arriving on the socket is parsed here before any consumer sees it,
 * so the rest of the package works with named shapes rather than poking at raw
 * JSON. The frames fall into two families: control frames carrying a `type`, and
 * data frames identified by which key they carry.
 */

/** Control frames: handshake, subscription acknowledgement, and session loss. */
export const ControlFrameSchema = z.object({
  type: z.string(),
  message: z.string().optional(),
  topics: z.array(z.string()).optional(),
  /** A snapshot row per symbol, each an object of field codes. */
  data: z.array(FeedSnapshotRowSchema).optional(),
})

export type ControlFrame = z.infer<typeof ControlFrameSchema>

/** One field changed on one symbol: `{"k":"GARAN/C","v":129.9}`. */
export const FieldFrameSchema = z.object({
  k: z.string().min(1),
  v: FeedValueSchema,
})

export type FieldFrame = z.infer<typeof FieldFrameSchema>

/** An order book level: `{"ob":"GARAN","v":{...}}`. */
export const DepthFrameSchema = z.object({
  ob: z.string().min(1),
  v: FeedRecordSchema,
})

export type DepthFrame = z.infer<typeof DepthFrameSchema>

/** A printed trade: `{"o":"GARAN","v":{...}}`. */
export const TradeFrameSchema = z.object({
  o: z.string().min(1),
  v: FeedRecordSchema,
})

export type TradeFrame = z.infer<typeof TradeFrameSchema>

export const CONTROL_FRAME_TYPES = {
  connectionAccepted: "connection_success",
  loginAccepted: "login_success",
  subscribed: "subscribe_success",
  /** The licence is now held by another device. */
  sessionTaken: "concurrent_session_error",
} as const

/** A parsed frame, or null when the payload is not one this client understands. */
export type FeedFrame =
  | { kind: "control"; frame: ControlFrame }
  | { kind: "field"; frame: FieldFrame }
  | { kind: "depth"; frame: DepthFrame }
  | { kind: "trade"; frame: TradeFrame }

/**
 * Parses one socket message.
 *
 * Order matters: control frames are checked first because they are the only ones
 * carrying `type`, and the data frames are distinguished by their own key.
 */
export function parseFrame(data: string): FeedFrame | null {
  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return null
  }

  const control = ControlFrameSchema.safeParse(payload)
  if (control.success) return { kind: "control", frame: control.data }

  const field = FieldFrameSchema.safeParse(payload)
  if (field.success) return { kind: "field", frame: field.data }

  const depth = DepthFrameSchema.safeParse(payload)
  if (depth.success) return { kind: "depth", frame: depth.data }

  const trade = TradeFrameSchema.safeParse(payload)
  if (trade.success) return { kind: "trade", frame: trade.data }

  return null
}

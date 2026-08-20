import { eq, lt } from "drizzle-orm"
import type { AppDatabase } from "@trbot/db/client.ts"
import { idempotencyKeys } from "@trbot/db/schema.ts"
import { ProtocolError } from "@trbot/protocol/error.ts"
import { isDefiniteRefusal } from "../errors.ts"
import { z } from "zod"

const RETENTION_MS = 24 * 60 * 60 * 1000
const IN_DOUBT = "IN_DOUBT"
const JsonValueSchema = z.json()
const JsonInputSchema = z.preprocess((value) => value, JsonValueSchema)
export type IdempotentInput = z.input<typeof JsonInputSchema>
type JsonValue = z.output<typeof JsonValueSchema>

interface RunningMutation {
  route: string
  requestHash: string
  result: Promise<JsonValue>
}

/**
 * Replays the stored response when a mutation is retried under the same key.
 *
 * A client that reconnects mid-order cannot tell whether its request arrived, so
 * it retries. Without this, that retry is a second live order.
 */
export class IdempotencyStore {
  /**
   * The mutations running right now.
   *
   * A record is only written once its mutation returns, so between the lookup
   * and the write there is nothing stored to replay — and that gap is precisely
   * when a client retries, because it retries when it cannot tell whether the
   * first request arrived. Without this the retry finds no record, runs, and
   * places a second live order; the primary key only complains afterwards, with
   * both orders already at the provider.
   *
   * Memory is enough because the provider session lives in exactly one process.
   * See docs/server-architecture.md.
   */
  private readonly running = new Map<string, RunningMutation>()

  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Runs `mutate` at most once for `key`: a repeat replays the stored response,
   * and a repeat arriving while the first is still in flight waits for it rather
   * than starting a second.
   *
   * A mutation the provider definitely refused stores nothing, so a retry is
   * free to try again. One that failed without an answer is recorded as being in
   * doubt, and a retry is refused: rerunning it is how a lost response becomes a
   * second live order.
   */
  async run(
    key: string,
    route: string,
    requestHash: string,
    mutate: () => Promise<IdempotentInput>,
  ): Promise<JsonValue> {
    const replayed = await this.replay(key, route, requestHash)
    if (replayed !== null) return replayed

    const running = this.running.get(key)
    if (running) {
      if (running.route !== route || running.requestHash !== requestHash) throw conflict(key)
      return running.result
    }

    const result = this.execute(key, route, requestHash, mutate)
    this.running.set(key, { route, requestHash, result })
    try {
      return await result
    } finally {
      this.running.delete(key)
    }
  }

  private async execute(
    key: string,
    route: string,
    requestHash: string,
    mutate: () => Promise<IdempotentInput>,
  ): Promise<JsonValue> {
    let response: JsonValue
    try {
      response = jsonValue(await mutate())
    } catch (error) {
      if (!isDefiniteRefusal(error)) await this.recordInDoubt(key, route, requestHash)
      throw error
    }
    await this.record(key, route, requestHash, response)
    return response
  }

  /** Drops records past their retention window. Called at startup. */
  async sweep(): Promise<void> {
    await this.db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, this.now() - RETENTION_MS))
  }

  /**
   * Returns a previously stored response for `key`, or null when the key is new.
   * A repeat carrying a different body is a client bug, so it is rejected rather
   * than silently treated as either the first or a fresh request.
   */
  async replay(key: string, route: string, requestHash: string): Promise<JsonValue | null> {
    const [stored] = await this.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key)).limit(1)
    if (!stored) return null

    if (stored.route !== route || stored.requestHash !== requestHash) throw conflict(key)
    if (stored.outcome === IN_DOUBT) {
      throw new ProtocolError(
        "outcome_unknown",
        "An earlier attempt at this request never reported whether it took effect. " +
          "Check the order book before sending it again.",
      )
    }

    try {
      return JsonValueSchema.parse(JSON.parse(stored.responseBody))
    } catch (error) {
      throw new ProtocolError("internal", "The stored idempotency response is corrupt", { cause: error })
    }
  }

  /**
   * Marks a key as having an outcome nobody learned, so a retry is refused
   * rather than run a second time.
   */
  async recordInDoubt(key: string, route: string, requestHash: string): Promise<void> {
    await this.db.insert(idempotencyKeys).values({
      key,
      route,
      requestHash,
      outcome: IN_DOUBT,
      responseBody: "null",
      createdAt: this.now(),
    })
  }

  async record(key: string, route: string, requestHash: string, response: IdempotentInput): Promise<void> {
    await this.db.insert(idempotencyKeys).values({
      key,
      route,
      requestHash,
      responseBody: JSON.stringify(jsonValue(response)),
      createdAt: this.now(),
    })
  }
}

function conflict(key: string): ProtocolError {
  return new ProtocolError("conflict", `Idempotency key "${key}" was already used with a different request`)
}

export function hashRequest(body: IdempotentInput): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(body ?? null)).digest("hex")
}

function jsonValue(input: IdempotentInput): JsonValue {
  const encoded = JSON.stringify(input ?? null)
  const parsed = JsonValueSchema.safeParse(JSON.parse(encoded))
  if (!parsed.success) throw new ProtocolError("internal", "Idempotent responses must be JSON serializable")
  return parsed.data
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { openDatabase, type DatabaseConnection } from "@trbot/db/client.ts"
import { ApiHttpError } from "@trbot/api"
import { isProtocolError, ProtocolError } from "@trbot/protocol/error.ts"
import { hashRequest, IdempotencyStore } from "./idempotency.ts"

const ROUTE = "/v1/orders"
const ORDER = { instrumentUid: "instrument-1", side: "BUY", quantity: 2, limitPrice: 400 }

describe("idempotency store", () => {
  let connection: DatabaseConnection
  let store: IdempotencyStore
  let now = 1_786_000_000_000

  beforeEach(async () => {
    connection = await openDatabase(":memory:")
    store = new IdempotencyStore(connection.db, () => now)
  })

  afterEach(() => {
    connection.close()
  })

  test("a new key has nothing to replay", async () => {
    expect(await store.replay("key-1", ROUTE, hashRequest(ORDER))).toBeNull()
  })

  test("replays the first response instead of acting twice", async () => {
    const hash = hashRequest(ORDER)
    await store.record("key-1", ROUTE, hash, { orderUid: "order-1" })

    expect(await store.replay("key-1", ROUTE, hash)).toEqual({ orderUid: "order-1" })
  })

  test("rejects the same key carrying a different order", async () => {
    await store.record("key-1", ROUTE, hashRequest(ORDER), { orderUid: "order-1" })

    const error = await store
      .replay("key-1", ROUTE, hashRequest({ ...ORDER, quantity: 99 }))
      .catch((caught: unknown) => caught)

    expect(isProtocolError(error) && error.code).toBe("conflict")
  })

  test("rejects the same key reused on another route", async () => {
    const hash = hashRequest(ORDER)
    await store.record("key-1", ROUTE, hash, { orderUid: "order-1" })

    const error = await store.replay("key-1", "/v1/positions/exit", hash).catch((caught: unknown) => caught)
    expect(isProtocolError(error) && error.code).toBe("conflict")
  })

  test("hashes are stable across key order and sensitive to values", () => {
    expect(hashRequest({ a: 1, b: 2 })).toBe(hashRequest({ a: 1, b: 2 }))
    expect(hashRequest(ORDER)).not.toBe(hashRequest({ ...ORDER, quantity: 3 }))
  })

  test("sweeping drops records past the retention window", async () => {
    await store.record("old", ROUTE, hashRequest(ORDER), { orderUid: "order-1" })
    now += 25 * 60 * 60 * 1000
    await store.sweep()

    expect(await store.replay("old", ROUTE, hashRequest(ORDER))).toBeNull()
  })

  test("sweeping keeps records still inside the window", async () => {
    await store.record("recent", ROUTE, hashRequest(ORDER), { orderUid: "order-1" })
    now += 60 * 60 * 1000
    await store.sweep()

    expect(await store.replay("recent", ROUTE, hashRequest(ORDER))).toEqual({ orderUid: "order-1" })
  })

  /**
   * The window a retry actually lands in. A record is written once its mutation
   * returns, so while the first order is at the provider there is nothing stored
   * to replay — and that is exactly when a client that cannot tell whether its
   * request arrived sends the same key again.
   */
  test("a repeat arriving mid-order waits for it instead of placing a second", async () => {
    const hash = hashRequest(ORDER)
    let placed = 0
    let release = (): void => {}
    const atProvider = new Promise<void>((resolve) => (release = resolve))
    const place = async (): Promise<{ orderUid: string }> => {
      placed += 1
      await atProvider
      return { orderUid: "order-1" }
    }

    const first = store.run("key-1", ROUTE, hash, place)
    // Let the first reach the provider and stop there, then retry underneath it.
    await Bun.sleep(1)
    const retry = store.run("key-1", ROUTE, hash, place)
    await Bun.sleep(1)
    release()

    expect(await first).toEqual({ orderUid: "order-1" })
    expect(await retry).toEqual({ orderUid: "order-1" })
    expect(placed).toBe(1)
  })

  test("a repeat after the order landed replays it rather than running again", async () => {
    const hash = hashRequest(ORDER)
    let placed = 0
    const place = async (): Promise<{ orderUid: string }> => {
      placed += 1
      return { orderUid: "order-1" }
    }

    expect(await store.run("key-1", ROUTE, hash, place)).toEqual({ orderUid: "order-1" })
    expect(await store.run("key-1", ROUTE, hash, place)).toEqual({ orderUid: "order-1" })
    expect(placed).toBe(1)
  })

  test("a key still in flight refuses a different order rather than answering with the wrong one", async () => {
    let release = (): void => {}
    const atProvider = new Promise<void>((resolve) => (release = resolve))
    const first = store.run("key-1", ROUTE, hashRequest(ORDER), async () => {
      await atProvider
      return { orderUid: "order-1" }
    })
    await Bun.sleep(1)

    const error = await store
      .run("key-1", ROUTE, hashRequest({ ...ORDER, quantity: 99 }), async () => ({ orderUid: "order-2" }))
      .catch((caught: unknown) => caught)

    expect(isProtocolError(error) && error.code).toBe("conflict")
    release()
    await first
  })

  // An order the provider read and rejected is not an order, so the key is free.
  test("a mutation the provider definitely refused leaves the key open", async () => {
    const hash = hashRequest(ORDER)
    const failure = await store
      .run("key-1", ROUTE, hash, () =>
        Promise.reject(new ProtocolError("invalid_request", "the provider rejected the order")),
      )
      .catch((caught: unknown) => caught as Error)

    expect(failure.message).toBe("the provider rejected the order")
    expect(await store.run("key-1", ROUTE, hash, async () => ({ orderUid: "order-1" }))).toEqual({
      orderUid: "order-1",
    })
  })

  /**
   * The case the whole mechanism exists for. A connection that drops after the
   * order left is indistinguishable from one that dropped before it, so running
   * it again is how a lost response becomes a second live order. Refusing the
   * retry hands the trader a question they can answer by looking; rerunning it
   * hands them a position they did not ask for.
   */
  test("a mutation that failed without an answer puts the key in doubt", async () => {
    const hash = hashRequest(ORDER)
    let attempts = 0
    const dropped = async (): Promise<never> => {
      attempts += 1
      throw new Error("The socket connection was closed unexpectedly")
    }

    await store.run("key-1", ROUTE, hash, dropped).catch(() => {})
    expect(attempts).toBe(1)

    const retry = await store
      .run("key-1", ROUTE, hash, dropped)
      .catch((caught: unknown) => caught as ProtocolError)

    expect(isProtocolError(retry) && retry.code).toBe("outcome_unknown")
    expect(retry.message).toMatch(/never reported whether it took effect/)
    // And it was not sent a second time.
    expect(attempts).toBe(1)
  })

  test("a provider that answered with a server error also leaves the outcome unknown", async () => {
    const hash = hashRequest(ORDER)
    await store
      .run("key-1", ROUTE, hash, () => Promise.reject(new ApiHttpError(503, "upstream is down")))
      .catch(() => {})

    const retry = await store
      .run("key-1", ROUTE, hash, async () => ({ orderUid: "order-1" }))
      .catch((caught: unknown) => caught as ProtocolError)

    expect(isProtocolError(retry) && retry.code).toBe("outcome_unknown")
  })

  test("a provider that answered with a client error frees the key", async () => {
    const hash = hashRequest(ORDER)
    await store
      .run("key-1", ROUTE, hash, () => Promise.reject(new ApiHttpError(422, "quantity is not tradable")))
      .catch(() => {})

    expect(await store.run("key-1", ROUTE, hash, async () => ({ orderUid: "order-1" }))).toEqual({
      orderUid: "order-1",
    })
  })
})

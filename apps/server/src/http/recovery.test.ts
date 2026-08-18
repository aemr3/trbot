import { afterEach, expect, test } from "bun:test"
import type { Server } from "bun"
import { HttpClient } from "@trbot/client/http.ts"
import { ProtocolError } from "@trbot/protocol/error.ts"
import { ROUTES } from "@trbot/protocol/routes.ts"
import type { ProviderSession, ProviderSources } from "../session.ts"
import type { SocketData } from "../stream-hub.ts"
import { startServer } from "./server.ts"

const TOKEN = "recovery-token"

const notUsed = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error("not used in this test")
    },
  },
)

const INSTRUMENTS = [{ uid: "future-1", symbol: "F_XU0300826" }]

/**
 * A session that refuses until it is recovered, which is what an expired
 * provider session looks like from a route.
 */
function lapsedSession(options: { recovers: boolean }) {
  const state = { recoveries: 0, calls: 0, live: false }
  const session = {
    get authenticated() {
      return state.live
    },
    require(): ProviderSources {
      state.calls += 1
      if (!state.live) throw new ProtocolError("unauthenticated", "The server has no provider session")
      return {
        instruments: { listInstruments: async () => INSTRUMENTS },
      } as unknown as ProviderSources
    },
    async recover(): Promise<boolean> {
      state.recoveries += 1
      state.live = options.recovers
      return options.recovers
    },
    onExpired(): void {},
    onSession(): void {},
  }
  return { session: session as unknown as ProviderSession, state }
}

const servers: Server<SocketData>[] = []

afterEach(() => {
  for (const server of servers.splice(0)) void server.stop(true)
})

function serve(session: ProviderSession): HttpClient {
  const server = startServer(
    { host: "127.0.0.1", port: 0, token: TOKEN, tls: null },
    {
      session,
      hub: notUsed as never,
      idempotency: notUsed as never,
      preferences: notUsed as never,
      overviewSnapshots: notUsed as never,
      ai: notUsed as never,
      chat: notUsed as never,
      alerts: notUsed as never,
      stops: notUsed as never,
      backlog: () => [],
      onDecision: () => {},
    },
  )
  servers.push(server)
  return new HttpClient({ url: `http://127.0.0.1:${server.port}`, token: TOKEN })
}

/**
 * The server signs itself back in unattended, so a request that arrives while
 * the old session is dead should be answered rather than refused. Refusing it
 * puts the trader on the sign-in screen for a session the server rebuilt a
 * moment later — and the terminal has no way to tell that happened.
 */
test("a request that outlives the session is answered by the recovered one", async () => {
  const { session, state } = lapsedSession({ recovers: true })

  expect(await serve(session).get<typeof INSTRUMENTS>(ROUTES.instruments)).toEqual(INSTRUMENTS)
  expect(state.recoveries).toBe(1)
  // Refused once, then run again on the session that replaced it.
  expect(state.calls).toBe(2)
})

test("a recovery that fails still reports the expiry, so the trader is asked to sign in", async () => {
  const { session, state } = lapsedSession({ recovers: false })

  const failure = await serve(session)
    .get(ROUTES.instruments)
    .then(() => null, (error: unknown) => error as ProtocolError)

  expect(failure?.code).toBe("unauthenticated")
  expect(state.recoveries).toBe(1)
})

/**
 * The retry re-reads the request, and the first attempt already consumed it, so
 * a body has to survive the round trip.
 */
test("a request with a body is retried with that body intact", async () => {
  const { session, state } = lapsedSession({ recovers: true })
  const seen: unknown[] = []
  const withOrders = {
    ...(session as unknown as Record<string, unknown>),
    require() {
      state.calls += 1
      if (state.calls === 1) throw new ProtocolError("unauthenticated", "The server has no provider session")
      return {
        orders: {
          cancelPendingOrders: async (body: unknown) => {
            seen.push(body)
            return { cancelled: [], failures: [] }
          },
        },
      } as unknown as ProviderSources
    },
  } as unknown as ProviderSession

  await serve(withOrders).post(ROUTES.cancelOrders, { body: { orderUids: ["order-1", "order-2"] } })

  expect(seen).toEqual([{ orderUids: ["order-1", "order-2"] }])
})

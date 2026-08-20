import { afterEach, expect, test } from "bun:test"
import type { Server } from "bun"
import { HttpClient } from "@trbot/client/http.ts"
import { ProtocolError } from "@trbot/protocol/error.ts"
import { ROUTES } from "@trbot/protocol/routes.ts"
import type { ProviderSessionAccess, ProviderSources } from "../session.ts"
import { providerSources, TestProviderSession } from "../provider.test-fixture.ts"
import type { SocketData } from "../stream-hub.ts"
import { startServer } from "./server.ts"
import { serverDeps } from "./server.test-fixture.ts"
import { z } from "zod"

const TOKEN = "recovery-token"

const INSTRUMENTS = [{
  uid: "future-1",
  symbol: "F_XU0300826",
  displayName: "BIST 30 Index Future",
  underlyingSymbol: "XU030",
  lastPrice: 12_500,
  changePercent: 0.5,
  volume: 1_000,
  currency: "TRY",
}]

/**
 * A session that refuses until it is recovered, which is what an expired
 * provider session looks like from a route.
 */
function lapsedSession(options: { recovers: boolean; sources?: ProviderSources }) {
  const state = { recoveries: 0, calls: 0, live: false }
  const sources = options.sources ?? providerSources({
    instruments: { listInstruments: async () => INSTRUMENTS },
  })
  class LapsedSession extends TestProviderSession {
    override require(): ProviderSources {
      state.calls += 1
      return super.require()
    }
  }
  const session = new LapsedSession(null, async () => {
    state.recoveries += 1
    state.live = options.recovers
    return options.recovers ? sources : null
  })
  return { session, state }
}

const servers: Server<SocketData>[] = []

afterEach(() => {
  for (const server of servers.splice(0)) void server.stop(true)
})

function serve(session: ProviderSessionAccess): HttpClient {
  const server = startServer(
    { host: "127.0.0.1", port: 0, token: TOKEN, tls: null },
    serverDeps({
      session,
      backlog: () => [],
      onDecision: () => {},
    }),
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

  expect(await serve(session).get(ROUTES.instruments, z.array(z.unknown()))).toEqual(INSTRUMENTS)
  expect(state.recoveries).toBe(1)
  // Refused once, then run again on the session that replaced it.
  expect(state.calls).toBe(2)
})

test("a recovery that fails still reports the expiry, so the trader is asked to sign in", async () => {
  const { session, state } = lapsedSession({ recovers: false })

  const failure = await serve(session)
    .get(ROUTES.instruments, z.unknown())
    .then(() => null, (cause: unknown) => cause instanceof ProtocolError ? cause : null)

  expect(failure?.code).toBe("unauthenticated")
  expect(state.recoveries).toBe(1)
})

/**
 * The retry re-reads the request, and the first attempt already consumed it, so
 * a body has to survive the round trip.
 */
test("a request with a body is retried with that body intact", async () => {
  const seen: unknown[] = []
  const sources = providerSources({
    orders: {
      prepareOrder: async () => { throw new Error("unexpected prepare") },
      placeOrder: async () => { throw new Error("unexpected place") },
      listPendingOrders: async () => [],
      cancelPendingOrders: async (body) => {
        seen.push(body)
        return { cancelledOrderUids: [], failures: [] }
      },
      exitAllPositions: async () => ({ submitted: [], failures: [] }),
      exitPosition: async () => { throw new Error("unexpected exit") },
    },
  })
  const { session } = lapsedSession({ recovers: true, sources })

  await serve(session).post(ROUTES.cancelOrders, z.unknown(), {
    body: { orderUids: ["order-1", "order-2"] },
  })

  expect(seen).toEqual([{ orderUids: ["order-1", "order-2"] }])
})

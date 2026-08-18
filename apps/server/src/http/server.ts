import type { Server, ServerWebSocket } from "bun"
import type { ServerConfig } from "@trbot/config"
import { ProtocolError } from "@trbot/protocol/error.ts"
import { ROUTES, type StreamTicket } from "@trbot/protocol/routes.ts"
import { parseClientFrame } from "@trbot/protocol/stream.ts"
import { toProtocolError } from "../errors.ts"
import { bearerToken, errorResponse, json, secretsMatch } from "./request.ts"
import { HANDLERS, PARAMETERIZED, type RouteContext } from "./routes.ts"
import { newSocketData, type SocketData, type StreamHub } from "../stream-hub.ts"

const TICKET_TTL_MS = 30_000

/**
 * How long a connection may go quiet before it is closed, in seconds.
 *
 * Bun defaults this to ten seconds, which is shorter than several provider calls
 * legitimately take — a wide brokerage or settlement range among them. A request
 * cut off this way reaches the client as a closed socket, indistinguishable from
 * the server being down, so the limit is set here to something a slow upstream
 * fits inside. Streamed responses do not rely on it: they send heartbeats.
 */
const IDLE_TIMEOUT_SECONDS = 120

export interface ServerDeps extends RouteContext {
  hub: StreamHub
  /** Frames replayed to a socket as soon as it connects. */
  backlog: () => unknown[]
  onDecision: (frame: ReturnType<typeof parseClientFrame>) => void
}

/**
 * Single-use tickets let a browser open the stream, since a WebSocket upgrade
 * from a browser cannot carry an Authorization header.
 */
class TicketStore {
  private readonly tickets = new Map<string, number>()

  issue(): StreamTicket {
    const ticket = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")
    const expiresAt = Date.now() + TICKET_TTL_MS
    this.tickets.set(ticket, expiresAt)
    return { ticket, expiresAt }
  }

  redeem(ticket: string): boolean {
    const expiresAt = this.tickets.get(ticket)
    this.tickets.delete(ticket)
    return expiresAt !== undefined && expiresAt > Date.now()
  }
}

export function startServer(config: ServerConfig, deps: ServerDeps): Server<SocketData> {
  const tickets = new TicketStore()

  const authorized = (request: Request): boolean => {
    const token = bearerToken(request)
    return token !== null && secretsMatch(token, config.token)
  }

  return Bun.serve<SocketData>({
    hostname: config.host,
    port: config.port,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    tls: config.tls
      ? { cert: Bun.file(config.tls.certPath), key: Bun.file(config.tls.keyPath) }
      : undefined,

    async fetch(request, server) {
      const url = new URL(request.url)

      if (url.pathname === ROUTES.health) return json({ ok: true })

      if (url.pathname === ROUTES.stream) {
        const ticket = url.searchParams.get("ticket")
        const allowed = authorized(request) || (ticket !== null && tickets.redeem(ticket))
        if (!allowed) return errorResponse(new ProtocolError("unauthorized", "A valid token is required"))
        return server.upgrade(request, { data: newSocketData() })
          ? undefined
          : errorResponse(new ProtocolError("invalid_request", "Expected a WebSocket upgrade"))
      }

      if (!authorized(request)) {
        return errorResponse(new ProtocolError("unauthorized", "A valid token is required"))
      }

      if (url.pathname === ROUTES.streamTicket && request.method === "POST") return json(tickets.issue())

      // Kept back so a recovered session can answer the request that found the
      // old one dead: the first attempt consumes the body.
      const retryable = request.clone()
      try {
        return await dispatch(request, url, deps)
      } catch (error) {
        // A route the provider refused is the first sign the session died, so
        // this is where an unattended re-login starts. Waiting for it and
        // answering properly matters: reporting the expiry instead would put a
        // trader on the login screen for a session the server just rebuilt.
        if (toProtocolError(error).code !== "unauthenticated") return errorResponse(error)
        if (!(await deps.session.recover())) return errorResponse(error)
        try {
          return await dispatch(retryable, url, deps)
        } catch (afterRecovery) {
          return errorResponse(afterRecovery)
        }
      }
    },

    websocket: {
      open(socket: ServerWebSocket<SocketData>) {
        deps.hub.add(socket)
        for (const frame of deps.backlog()) socket.send(JSON.stringify(frame))
      },
      message(socket: ServerWebSocket<SocketData>, message) {
        const frame = parseClientFrame(typeof message === "string" ? message : message.toString())
        if (!frame) return
        if (frame.type === "alertDecision") {
          deps.onDecision(frame)
          return
        }
        deps.hub.handle(socket, frame)
      },
      close(socket: ServerWebSocket<SocketData>) {
        deps.hub.remove(socket)
      },
    },
  })
}

/** Runs the route matching `url`, exactly once. Callers decide about retrying. */
async function dispatch(request: Request, url: URL, deps: ServerDeps): Promise<Response> {
  const exact = HANDLERS[url.pathname]?.[request.method]
  if (exact) return await exact(request, deps)

  for (const route of PARAMETERIZED) {
    if (route.method !== request.method) continue
    const match = url.pathname.match(route.pattern)
    if (match) return await route.handle(match, request, deps)
  }

  return errorResponse(new ProtocolError("not_found", `No route for ${request.method} ${url.pathname}`))
}

import type { ChatPermissionAuthorizer } from "@trbot/ai/permission.ts"
import {
  type ChatPermissionMode,
  type ChatPermissionModeState,
  type ChatPermissionReply,
  type ChatPermissionRequest,
  type ChatPermissionResolution,
  type ChatPermissionStore,
} from "@trbot/chat/permission.ts"
import { ProtocolError } from "@trbot/protocol/error.ts"
import type { ChatFrame } from "@trbot/protocol/stream.ts"

interface PendingPermission {
  request: ChatPermissionRequest
  resolve?: (resolution: ChatPermissionResolution) => void
  reject?: (error: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

export interface ChatPermissionControllerOptions {
  store: ChatPermissionStore
  broadcast: (frame: ChatFrame) => void
  onDetachedDecision?: (request: ChatPermissionRequest, resolution: ChatPermissionResolution) => Promise<void>
  now?: () => number
}

export interface ChatPermissionDetachOptions {
  /** Keeps grants through a short transport reconnect by the same client process. */
  reconnectGraceMs?: number
}

/** Gates sensitive agent tools and keeps grants while their approving client remains connected. */
export class ChatPermissionController implements ChatPermissionAuthorizer {
  private readonly pending = new Map<string, PendingPermission>()
  private readonly grants = new Map<string, Set<string>>()
  private readonly grantSessions = new Map<string, string>()
  private readonly clientGrants = new Map<string, Set<string>>()
  private readonly attachedClients = new Map<string, number>()
  private readonly pendingRevocations = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly now: () => number
  private destroyed = false

  constructor(private readonly options: ChatPermissionControllerOptions) {
    this.now = options.now ?? Date.now
  }

  async load(): Promise<void> {
    this.pending.clear()
    for (const request of await this.options.store.listRequests()) {
      this.pending.set(request.id, { request })
    }
  }

  /** Clears a crash-window prompt after the chat queue is ready to receive its continuation. */
  async reconcileModes(): Promise<void> {
    const autoRoots = new Set<string>()
    for (const pending of this.pending.values()) {
      const state = await this.options.store.getMode(pending.request.sessionId)
      if (state?.mode === "AUTO") autoRoots.add(state.sessionId)
    }
    for (const sessionId of autoRoots) await this.allowPending(sessionId)
  }

  /** Reconciles database cascades after a chat is deleted. */
  async sync(): Promise<void> {
    const stored = new Set((await this.options.store.listRequests()).map((request) => request.id))
    for (const [id, pending] of this.pending) {
      if (stored.has(id)) continue
      this.pending.delete(id)
      this.removeAbortListener(pending)
      this.options.broadcast({ type: "chatPermissionResolved", requestId: id, sessionId: pending.request.sessionId })
      pending.reject?.(new Error("The permission request's chat was deleted"))
    }
  }

  async authorize(input: Parameters<ChatPermissionAuthorizer["authorize"]>[0]): Promise<ChatPermissionResolution> {
    if (this.destroyed) throw new Error("Permission service is shutting down")
    if (input.signal?.aborted) throw abortError()
    const mode = await this.requireMode(input.sessionId)
    if (mode.mode === "AUTO") return { decision: "ALLOW", reason: null }
    if (input.scope === "SESSION" && this.hasGrant(mode.sessionId, input.toolName)) {
      return { decision: "ALLOW", reason: null }
    }

    const request: ChatPermissionRequest = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      toolName: input.toolName,
      action: input.action,
      reason: input.reason?.trim() || null,
      scope: input.scope,
      createdAt: this.now(),
    }
    await this.options.store.putRequest(request)
    if (input.signal?.aborted) {
      await this.options.store.removeRequest(request.id)
      throw abortError()
    }
    // The mode may have changed while the durable request was being written.
    // Rechecking closes the only gap where Auto could still leave a prompt behind.
    if ((await this.requireMode(input.sessionId)).mode === "AUTO") {
      await this.options.store.removeRequest(request.id)
      return { decision: "ALLOW", reason: null }
    }

    return await new Promise<ChatPermissionResolution>((resolve, reject) => {
      const pending: PendingPermission = { request, resolve, reject, signal: input.signal }
      if (input.signal) {
        pending.onAbort = () => void this.abort(request.id)
        input.signal.addEventListener("abort", pending.onAbort, { once: true })
      }
      this.pending.set(request.id, pending)
      this.options.broadcast({ type: "chatPermissionRequested", request })
    })
  }

  list(): ChatPermissionRequest[] {
    return [...this.pending.values()].map((entry) => entry.request)
  }

  async mode(sessionId: string): Promise<ChatPermissionModeState> {
    return await this.requireMode(sessionId)
  }

  /** A policy switch clears temporary grants; Auto also releases requests already waiting. */
  async setMode(sessionId: string, mode: ChatPermissionMode): Promise<ChatPermissionModeState> {
    const current = await this.requireMode(sessionId)
    if (current.mode === mode) return current
    const next = await this.options.store.setMode(current.sessionId, mode)
    if (!next) throw new ProtocolError("not_found", "No such chat session")

    this.revokeSession(next.sessionId)
    this.options.broadcast({ type: "chatPermissionModeChanged", state: next })
    if (mode === "AUTO") await this.allowPending(next.sessionId)
    return next
  }

  async reply(requestId: string, reply: ChatPermissionReply, clientId: string | null = null): Promise<void> {
    const pending = this.require(requestId)
    if (reply.decision === "ALLOW" && reply.scope === "SESSION" && pending.request.scope !== "SESSION") {
      throw new ProtocolError("invalid_request", "This permission request only allows one-time approval")
    }
    const resolution: ChatPermissionResolution = {
      decision: reply.decision,
      reason: reply.decision === "DENY" ? reply.reason?.trim() || null : null,
    }
    if (reply.decision === "ALLOW" && reply.scope === "SESSION") {
      if (!clientId || !this.attachedClients.has(clientId)) {
        throw new ProtocolError("invalid_request", "Session approval requires a connected client")
      }
      const mode = await this.requireMode(pending.request.sessionId)
      this.grant(mode.sessionId, pending.request.toolName, clientId)
    }
    if (!pending.resolve) await this.options.onDetachedDecision?.(pending.request, resolution)
    await this.finish(pending, resolution)
  }

  backlog(): ChatFrame[] {
    return this.list().map((request) => ({ type: "chatPermissionRequested", request }))
  }

  attachClient(clientId: string | null): void {
    if (!clientId) return
    const revocation = this.pendingRevocations.get(clientId)
    if (revocation) clearTimeout(revocation)
    this.pendingRevocations.delete(clientId)
    this.attachedClients.set(clientId, (this.attachedClients.get(clientId) ?? 0) + 1)
  }

  detachClient(clientId: string | null, options: ChatPermissionDetachOptions = {}): void {
    if (!clientId) return
    const connections = this.attachedClients.get(clientId)
    if (!connections) return
    if (connections > 1) {
      this.attachedClients.set(clientId, connections - 1)
      return
    }
    this.attachedClients.delete(clientId)
    const reconnectGraceMs = options.reconnectGraceMs ?? 0
    if (reconnectGraceMs <= 0) {
      this.revokeClient(clientId)
      return
    }
    const revocation = setTimeout(() => {
      this.pendingRevocations.delete(clientId)
      if (!this.attachedClients.has(clientId)) this.revokeClient(clientId)
    }, reconnectGraceMs)
    this.pendingRevocations.set(clientId, revocation)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const pending of this.pending.values()) {
      this.removeAbortListener(pending)
      pending.reject?.(new Error("Permission service is shutting down"))
    }
    this.pending.clear()
    this.grants.clear()
    this.grantSessions.clear()
    this.clientGrants.clear()
    this.attachedClients.clear()
    for (const revocation of this.pendingRevocations.values()) clearTimeout(revocation)
    this.pendingRevocations.clear()
  }

  private hasGrant(sessionId: string, toolName: string): boolean {
    return (this.grants.get(grantKey(sessionId, toolName))?.size ?? 0) > 0
  }

  private grant(sessionId: string, toolName: string, clientId: string): void {
    const key = grantKey(sessionId, toolName)
    const clients = this.grants.get(key) ?? new Set<string>()
    clients.add(clientId)
    this.grants.set(key, clients)
    this.grantSessions.set(key, sessionId)

    const keys = this.clientGrants.get(clientId) ?? new Set<string>()
    keys.add(key)
    this.clientGrants.set(clientId, keys)
  }

  private revokeClient(clientId: string): void {
    for (const key of this.clientGrants.get(clientId) ?? []) {
      const clients = this.grants.get(key)
      clients?.delete(clientId)
      if (clients?.size === 0) {
        this.grants.delete(key)
        this.grantSessions.delete(key)
      }
    }
    this.clientGrants.delete(clientId)
  }

  private revokeSession(sessionId: string): void {
    for (const [key, grantSessionId] of this.grantSessions) {
      if (grantSessionId !== sessionId) continue
      const clients = this.grants.get(key) ?? []
      this.grants.delete(key)
      this.grantSessions.delete(key)
      for (const clientId of clients) {
        const keys = this.clientGrants.get(clientId)
        keys?.delete(key)
        if (keys?.size === 0) this.clientGrants.delete(clientId)
      }
    }
  }

  private async allowPending(rootSessionId: string): Promise<void> {
    for (const pending of this.pending.values()) {
      const mode = await this.options.store.getMode(pending.request.sessionId)
      if (mode?.sessionId !== rootSessionId || !this.pending.has(pending.request.id)) continue
      const resolution: ChatPermissionResolution = { decision: "ALLOW", reason: null }
      if (!pending.resolve) await this.options.onDetachedDecision?.(pending.request, resolution)
      await this.finish(pending, resolution)
    }
  }

  private async requireMode(sessionId: string): Promise<ChatPermissionModeState> {
    const mode = await this.options.store.getMode(sessionId)
    if (!mode) throw new ProtocolError("not_found", "No such chat session")
    return mode
  }

  private require(requestId: string): PendingPermission {
    const pending = this.pending.get(requestId)
    if (!pending) throw new ProtocolError("not_found", "No such pending permission request")
    return pending
  }

  private async abort(requestId: string): Promise<void> {
    const pending = this.pending.get(requestId)
    if (!pending) return
    await this.options.store.removeRequest(requestId)
    this.pending.delete(requestId)
    this.removeAbortListener(pending)
    this.options.broadcast({
      type: "chatPermissionResolved",
      requestId,
      sessionId: pending.request.sessionId,
    })
    pending.reject?.(abortError())
  }

  private async finish(pending: PendingPermission, resolution: ChatPermissionResolution): Promise<void> {
    await this.options.store.removeRequest(pending.request.id)
    this.pending.delete(pending.request.id)
    this.removeAbortListener(pending)
    this.options.broadcast({
      type: "chatPermissionResolved",
      requestId: pending.request.id,
      sessionId: pending.request.sessionId,
    })
    pending.resolve?.(resolution)
  }

  private removeAbortListener(pending: PendingPermission): void {
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort)
  }
}

function abortError(): Error {
  return new DOMException("The permission request was cancelled", "AbortError")
}

function grantKey(sessionId: string, toolName: string): string {
  return JSON.stringify([sessionId, toolName])
}

import { expect, test } from "bun:test"
import type {
  ChatPermissionRequest,
  ChatPermissionStore,
} from "@trbot/chat/permission.ts"
import type { ChatFrame } from "@trbot/protocol/stream.ts"
import { ChatPermissionController } from "./chat-permission.ts"

function store(initial: ChatPermissionRequest[] = []) {
  const requests = [...initial]
  const value: ChatPermissionStore = {
    listRequests: async () => [...requests],
    putRequest: async (request) => { requests.push(request) },
    removeRequest: async (id) => {
      const index = requests.findIndex((request) => request.id === id)
      if (index >= 0) requests.splice(index, 1)
    },
  }
  return { value, requests }
}

test("remembers an allowed tool only while the approving client is attached", async () => {
  const persistence = store()
  const frames: ChatFrame[] = []
  const permissions = new ChatPermissionController({
    store: persistence.value,
    broadcast: (frame) => { frames.push(frame) },
    now: () => 1_000,
  })
  permissions.attachClient("client-1")

  const waiting = permissions.authorize({
    sessionId: "chat-1",
    toolName: "place_viop_order",
    action: "BUY 1 F_ASELS0826 at 100",
    reason: "Open the planned position",
    scope: "SESSION",
  })
  await Bun.sleep(0)
  const request = permissions.list()[0]!
  expect(request).toMatchObject({
    sessionId: "chat-1",
    toolName: "place_viop_order",
    reason: "Open the planned position",
  })
  expect(frames.at(-1)).toEqual({ type: "chatPermissionRequested", request })

  await permissions.reply(request.id, { decision: "ALLOW", scope: "SESSION" }, "client-1")
  expect(await waiting).toEqual({ decision: "ALLOW", reason: null })
  expect(await permissions.authorize({
    sessionId: "chat-1",
    toolName: "place_viop_order",
    action: "BUY 2 F_ASELS0826 at 101",
    scope: "SESSION",
  })).toEqual({ decision: "ALLOW", reason: null })
  expect(permissions.list()).toEqual([])

  permissions.detachClient("client-1")
  const afterClose = permissions.authorize({
    sessionId: "chat-1",
    toolName: "place_viop_order",
    action: "BUY 3 F_ASELS0826 at 102",
    scope: "SESSION",
  })
  await Bun.sleep(0)
  expect(permissions.list()).toHaveLength(1)
  await permissions.reply(permissions.list()[0]!.id, { decision: "DENY" })
  expect(await afterClose).toEqual({ decision: "DENY", reason: null })
})

test("denial reason reaches the current request without creating a lasting denial", async () => {
  const persistence = store()
  const permissions = new ChatPermissionController({ store: persistence.value, broadcast: () => {} })
  const waiting = permissions.authorize({
    sessionId: "chat-1",
    toolName: "exit_viop_position",
    action: "Exit 1 F_ASELS0826",
    scope: "SESSION",
  })
  await Bun.sleep(0)
  await permissions.reply(permissions.list()[0]!.id, { decision: "DENY", reason: "The entry is too late" })

  expect(await waiting).toEqual({ decision: "DENY", reason: "The entry is too late" })

  const retried = permissions.authorize({
    sessionId: "chat-1",
    toolName: "exit_viop_position",
    action: "Exit 1 F_ASELS0826",
    scope: "SESSION",
  })
  await Bun.sleep(0)
  expect(permissions.list()).toHaveLength(1)
  await permissions.reply(permissions.list()[0]!.id, { decision: "DENY" })
  expect(await retried).toEqual({ decision: "DENY", reason: null })
})

test("loads a durable request and resumes its chat instead of replaying the mutation", async () => {
  const request: ChatPermissionRequest = {
    id: "permission-1",
    sessionId: "chat-1",
    toolName: "place_viop_order",
    action: "BUY 1 F_ASELS0826 at 100",
    reason: null,
    scope: "SESSION",
    createdAt: 1_000,
  }
  const persistence = store([request])
  const decisions: string[] = []
  const permissions = new ChatPermissionController({
    store: persistence.value,
    broadcast: () => {},
    onDetachedDecision: async (pending, resolution) => {
      decisions.push(`${pending.id}:${resolution.decision}:${resolution.reason}`)
    },
  })
  await permissions.load()
  permissions.attachClient("client-1")

  await permissions.reply(request.id, { decision: "ALLOW", scope: "SESSION" }, "client-1")

  expect(decisions).toEqual(["permission-1:ALLOW:null"])
  expect(persistence.requests).toEqual([])
})

test("one-time approval cannot be widened into a session grant", async () => {
  const persistence = store()
  const permissions = new ChatPermissionController({ store: persistence.value, broadcast: () => {} })
  const waiting = permissions.authorize({
    sessionId: "chat-1",
    toolName: "place_viop_order",
    action: "BUY 1 F_ASELS0826 at 100",
    scope: "ONCE",
  })
  await Bun.sleep(0)
  const request = permissions.list()[0]!

  await expect(permissions.reply(request.id, { decision: "ALLOW", scope: "SESSION" })).rejects.toThrow(
    "only allows one-time approval",
  )
  expect(permissions.list()).toEqual([request])
  await permissions.reply(request.id, { decision: "ALLOW", scope: "ONCE" })

  expect(await waiting).toEqual({ decision: "ALLOW", reason: null })
})

test("passes a detached denial reason into the resumed chat event", async () => {
  const request: ChatPermissionRequest = {
    id: "permission-1",
    sessionId: "chat-1",
    toolName: "create_stop_rule",
    action: "Create a stop at 95",
    reason: null,
    scope: "SESSION",
    createdAt: 1_000,
  }
  const persistence = store([request])
  const resolutions: string[] = []
  const permissions = new ChatPermissionController({
    store: persistence.value,
    broadcast: () => {},
    onDetachedDecision: async (_pending, resolution) => {
      resolutions.push(`${resolution.decision}:${resolution.reason}`)
    },
  })
  await permissions.load()

  await permissions.reply(request.id, { decision: "DENY", reason: "Use a wider stop" })

  expect(resolutions).toEqual(["DENY:Use a wider stop"])
})

test("rejects a session grant that is not owned by a connected client", async () => {
  const persistence = store()
  const permissions = new ChatPermissionController({ store: persistence.value, broadcast: () => {} })
  const waiting = permissions.authorize({
    sessionId: "chat-1",
    toolName: "place_viop_order",
    action: "BUY 1 F_ASELS0826 at 100",
    scope: "SESSION",
  })
  await Bun.sleep(0)

  await expect(
    permissions.reply(permissions.list()[0]!.id, { decision: "ALLOW", scope: "SESSION" }, "closed-client"),
  ).rejects.toThrow("requires a connected client")

  await permissions.reply(permissions.list()[0]!.id, { decision: "DENY" })
  expect(await waiting).toEqual({ decision: "DENY", reason: null })
})

test("keeps a pending permission durable while the server shuts down", async () => {
  const persistence = store()
  const permissions = new ChatPermissionController({ store: persistence.value, broadcast: () => {} })
  const waiting = permissions.authorize({
    sessionId: "chat-1",
    toolName: "place_viop_order",
    action: "BUY 1 F_ASELS0826 at 100",
    scope: "SESSION",
  })
  await Bun.sleep(0)

  permissions.destroy()

  await expect(waiting).rejects.toThrow("shutting down")
  expect(persistence.requests).toHaveLength(1)
})

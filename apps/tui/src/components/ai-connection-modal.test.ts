import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { PasteEvent, type KeyEvent } from "@opentui/core"
import { keyEvent } from "../key-event.test-fixture.ts"
import type { AiAccount, AiAuthType, AiLoginOptions, AiProviderSummary } from "@trbot/protocol/ai.ts"
import { AiConnectionModal } from "./ai-connection-modal.ts"

/**
 * One modal for every provider the harness offers.
 *
 * What these pin down is that it renders whatever a flow asks for rather than knowing
 * any provider: a secret, a choice, an address, a device code. A provider added by a
 * harness upgrade has to work here with no change.
 */
function key(name: string, sequence?: string): KeyEvent {
  return keyEvent(name, { sequence: sequence ?? name })
}

function typeText(modal: AiConnectionModal, text: string): void {
  for (const character of text) modal.handleKey(key(character, character))
}

function provider(overrides: Partial<AiProviderSummary> = {}): AiProviderSummary {
  return {
    providerId: "groq",
    name: "Groq",
    authTypes: ["api_key"],
    isSubscription: false,
    connected: false,
    source: null,
    accountId: null,
    connectedAt: null,
    updatedAt: null,
    ...overrides,
  }
}

/** An account whose connect() drives whichever callbacks a test wants exercised. */
function account(options: {
  providers: AiProviderSummary[]
  onConnect?: (providerId: string, authType: AiAuthType, login: AiLoginOptions) => Promise<void>
  disconnected?: string[]
}): AiAccount {
  return {
    async providers() {
      return options.providers
    },
    async models() {
      return []
    },
    async connect(providerId, authType, login = {}) {
      await options.onConnect?.(providerId, authType, login)
      return provider({ providerId, connected: true, name: providerId === "groq" ? "Groq" : providerId })
    },
    async disconnect(providerId) {
      options.disconnected?.push(providerId)
    },
    async preferences() {
      return { chat: null }
    },
    async setPreferences(preferences) {
      return preferences
    },
  }
}

async function mountModal(options: Parameters<typeof account>[0]) {
  const harness = await createTestRenderer({ width: 90, height: 26 })
  let closed = 0
  const modal = new AiConnectionModal(harness.renderer, {
    account: account(options),
    onClose: () => {
      closed++
    },
  })
  harness.renderer.root.add(modal.root)
  modal.mount()
  return { ...harness, modal, closed: () => closed }
}

test("lists providers with wrapped connection details", async () => {
  const { modal, renderOnce, captureCharFrame, renderer } = await mountModal({
    providers: [
      provider({
        providerId: "openai-codex",
        name: "OpenAI Codex",
        authTypes: ["oauth"],
        isSubscription: true,
        connected: true,
        source: "stored credential",
        accountId: "18056cf1-53f7-42db-a8c-54fb3",
      }),
      provider(),
    ],
  })
  await Bun.sleep(5)
  await renderOnce()

  const frame = captureCharFrame()
  const searchRow = frame.split("\n").find((line) => line.includes("Search")) ?? ""
  expect(frame).toContain("Model providers")
  expect(frame).toContain("1 connected of 2")
  expect(searchRow.trimEnd()).toEndWith("│")
  expect(frame).toContain("OpenAI Codex")
  expect(frame).toContain("subscription")
  // The account suffix would be beyond the row's right edge without wrapping.
  expect(frame).toContain("a8c-54fb3")
  // An unconnected provider says how it would be connected, so a trader knows
  // whether to reach for a browser or an API key.
  expect(frame).toContain("Groq")
  expect(frame).toContain("API key")

  modal.destroy()
  renderer.destroy()
})

test("filters providers as text is typed and connects the visible match", async () => {
  const attempted: string[] = []
  const { modal, renderOnce, captureCharFrame, renderer } = await mountModal({
    providers: [
      provider({ providerId: "openai-codex", name: "OpenAI Codex", authTypes: ["oauth"] }),
      provider({ providerId: "amazon-bedrock", name: "Amazon Bedrock" }),
      provider(),
    ],
    onConnect: async (providerId) => {
      attempted.push(providerId)
    },
  })
  await Bun.sleep(5)
  await renderOnce()

  typeText(modal, "gro")
  await renderOnce()
  const filtered = captureCharFrame()
  expect(filtered).toContain("1 matching · 0 connected of 3")
  expect(filtered).toContain("Groq")
  expect(filtered).not.toContain("OpenAI Codex")
  expect(filtered).not.toContain("Amazon Bedrock")

  modal.handleKey(key("return"))
  await Bun.sleep(5)
  expect(attempted).toEqual(["groq"])

  modal.destroy()
  renderer.destroy()
})

test("accepts a pasted API key without echoing it", async () => {
  // The key is a credential on screen in a shared terminal, so it is masked — unlike
  // an authorization code, which a trader needs to see to check the paste landed.
  const answered: string[] = []
  const { modal, renderOnce, captureCharFrame, renderer } = await mountModal({
    providers: [provider()],
    onConnect: async (_providerId, _authType, login) => {
      answered.push((await login.onSecret?.("Enter Groq API key")) ?? "")
    },
  })
  await Bun.sleep(5)
  await renderOnce()

  modal.handleKey(key("return"))
  await Bun.sleep(5)
  await renderOnce()
  expect(captureCharFrame()).toContain("Enter Groq API key")

  renderer.keyInput.emit("paste", new PasteEvent(new TextEncoder().encode("gsk-secret\n")))
  await renderOnce()
  const typing = captureCharFrame()
  expect(typing).not.toContain("gsk-secret")
  expect(typing).toContain("••••••••••")

  modal.handleKey(key("return"))
  await Bun.sleep(5)
  expect(answered).toEqual(["gsk-secret"])

  modal.destroy()
  renderer.destroy()
})

test("shows the address a browser login needs, and takes a code pasted back", async () => {
  const pasted: string[] = []
  const { modal, renderOnce, captureCharFrame, renderer } = await mountModal({
    providers: [provider({ providerId: "openai-codex", name: "OpenAI Codex", authTypes: ["oauth"], isSubscription: true })],
    onConnect: async (_providerId, _authType, login) => {
      login.onAuthorizationUrl?.("https://auth.openai.test/authorize?state=1")
      pasted.push((await login.onManualCode?.("Paste the authorization code")) ?? "")
    },
  })
  await Bun.sleep(5)
  await renderOnce()

  modal.handleKey(key("return"))
  await Bun.sleep(5)
  await renderOnce()
  expect(captureCharFrame()).toContain("auth.openai.test")

  typeText(modal, "code-1")
  await renderOnce()
  // Not masked: this one is a step in a flow, not a credential the trader holds.
  expect(captureCharFrame()).toContain("code-1")
  modal.handleKey(key("return"))
  await Bun.sleep(5)
  expect(pasted).toEqual(["code-1"])

  modal.destroy()
  renderer.destroy()
})

test("shows a device code for a machine with no browser of its own", async () => {
  // The flow is held open while the frame is read: a device code is something the
  // trader acts on *during* the login, and the modal clears it once one finishes.
  const finish: (() => void)[] = []
  const { modal, renderOnce, captureCharFrame, renderer } = await mountModal({
    providers: [provider({ providerId: "openai-codex", name: "OpenAI Codex", authTypes: ["oauth"] })],
    onConnect: async (_providerId, _authType, login) => {
      login.onDeviceCode?.({ userCode: "ABCD-1234", verificationUri: "https://auth.openai.test/device" })
      await new Promise<void>((resolve) => {
        finish.push(resolve)
      })
    },
  })
  await Bun.sleep(5)
  await renderOnce()

  modal.handleKey(key("return"))
  await Bun.sleep(5)
  await renderOnce()

  const frame = captureCharFrame()
  expect(frame).toContain("ABCD-1234")
  expect(frame).toContain("auth.openai.test/device")

  finish[0]?.()
  await Bun.sleep(5)
  modal.destroy()
  renderer.destroy()
})

test("asks which way to connect a provider offering both", async () => {
  // Signing in and paying per token are different things, so which one is used is
  // not a decision to make on a trader's behalf.
  const types: AiAuthType[] = []
  const { modal, renderOnce, captureCharFrame, renderer } = await mountModal({
    providers: [provider({ providerId: "openrouter", name: "OpenRouter", authTypes: ["oauth", "api_key"] })],
    onConnect: async (_providerId, authType) => {
      types.push(authType)
    },
  })
  await Bun.sleep(5)
  await renderOnce()

  modal.handleKey(key("return"))
  await Bun.sleep(5)
  await renderOnce()
  expect(captureCharFrame()).toContain("How do you want to connect OpenRouter?")

  modal.handleKey(key("down"))
  modal.handleKey(key("return"))
  await Bun.sleep(10)
  expect(types).toEqual(["api_key"])

  modal.destroy()
  renderer.destroy()
})

test("disconnects the highlighted provider on Ctrl+D", async () => {
  const disconnected: string[] = []
  const { modal, renderOnce, renderer } = await mountModal({
    providers: [provider({ connected: true })],
    disconnected,
  })
  await Bun.sleep(5)
  await renderOnce()

  modal.handleKey(keyEvent("d", { sequence: "d", ctrl: true }))
  await Bun.sleep(5)

  expect(disconnected).toEqual(["groq"])

  modal.destroy()
  renderer.destroy()
})

test("connects the highlighted provider, not the one the list opened on", async () => {
  // The modal repaints its rows on every selection change. If that repaint reset the
  // cursor, ↑↓ would scroll the list while Enter still connected the first provider.
  const attempted: string[] = []
  const { modal, renderOnce, captureCharFrame, renderer } = await mountModal({
    providers: [
      provider(),
      provider({ providerId: "openai-codex", name: "OpenAI Codex", authTypes: ["oauth"], isSubscription: true }),
    ],
    onConnect: async (providerId) => {
      attempted.push(providerId)
    },
  })
  await Bun.sleep(5)
  await renderOnce()

  modal.handleKey(key("down"))
  await renderOnce()
  const frame = captureCharFrame()
  const indicated = frame.split("\n").find((line) => line.includes("▶"))
  expect(indicated).toContain("OpenAI Codex")

  modal.handleKey(key("return"))
  await Bun.sleep(5)
  expect(attempted).toEqual(["openai-codex"])

  modal.destroy()
  renderer.destroy()
})

import { expect, test } from "bun:test"
import type {
  TelegramBotApiAccess,
  TelegramBotCommand,
  TelegramInlineKeyboard,
  TelegramMenuButtonCommands,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "@trbot/api/telegram.ts"
import type { VoiceTranscriber } from "@trbot/ai/voice-transcription.ts"
import type {
  ChatMobileBinding,
  ChatMobileChannel,
  ChatMobileStore,
  ChatMobileTurn,
  ChatMobileTurnMessage,
} from "@trbot/chat/mobile.ts"
import type { ChatPermissionReply, ChatPermissionRequest } from "@trbot/chat/permission.ts"
import type { ChatQuestionAnswer, ChatQuestionRequest } from "@trbot/chat/question.ts"
import {
  chatBlockText,
  type ChatMessage,
  type ChatSessionDetail,
  type ChatUndoEffect,
} from "@trbot/chat/session.ts"
import { ChatMobileController } from "./chat-mobile.ts"

const USER: TelegramUser = { id: 42, is_bot: false, first_name: "Ada", username: "ada" }
const PERMISSION_ID = "11111111-1111-4111-8111-111111111111"
const QUESTION_ID = "22222222-2222-4222-8222-222222222222"
const PROMPT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

interface SentTelegramMessage {
  chatId: string
  text: string
  replyMarkup?: TelegramInlineKeyboard
}

interface AnsweredTelegramCallback {
  id: string
  text?: string
  showAlert?: boolean
}

interface TelegramDraftUpdate {
  chatId: string
  draftId: number
  text: string
}

interface TelegramChatActionUpdate {
  chatId: string
  action: "typing"
}

class MemoryMobileStore implements ChatMobileStore {
  bindings: ChatMobileBinding[] = []
  turns: ChatMobileTurn[] = []

  async list(): Promise<ChatMobileBinding[]> {
    return [...this.bindings]
  }

  async findBySession(sessionId: string): Promise<ChatMobileBinding | null> {
    return this.bindings.find((binding) => binding.sessionId === sessionId) ?? null
  }

  async findByExternalUser(
    channel: ChatMobileChannel,
    externalUserId: string,
  ): Promise<ChatMobileBinding | null> {
    return this.bindings.find((binding) => (
      binding.channel === channel && binding.externalUserId === externalUserId
    )) ?? null
  }

  async connect(binding: ChatMobileBinding): Promise<void> {
    this.bindings = this.bindings.filter((candidate) => (
      candidate.sessionId !== binding.sessionId
      && !(candidate.channel === binding.channel && candidate.externalUserId === binding.externalUserId)
    ))
    this.bindings.push(binding)
  }

  async removeSession(sessionId: string): Promise<void> {
    this.bindings = this.bindings.filter((binding) => binding.sessionId !== sessionId)
  }

  async recordTurnMessage(message: ChatMobileTurnMessage): Promise<void> {
    const existing = this.turns.find((turn) => (
      turn.promptMessageId === message.promptMessageId
      && turn.channel === message.channel
      && turn.externalChatId === message.externalChatId
    ))
    if (existing) {
      if (!existing.externalMessageIds.includes(message.externalMessageId)) {
        existing.externalMessageIds.push(message.externalMessageId)
      }
      return
    }
    this.turns.push({
      sessionId: message.sessionId,
      promptMessageId: message.promptMessageId,
      channel: message.channel,
      externalChatId: message.externalChatId,
      externalMessageIds: [message.externalMessageId],
      createdAt: message.createdAt,
    })
  }

  async findTurn(
    promptMessageId: string,
    channel: ChatMobileChannel,
    externalChatId: string,
  ): Promise<ChatMobileTurn | null> {
    return this.turns.find((turn) => (
      turn.promptMessageId === promptMessageId
      && turn.channel === channel
      && turn.externalChatId === externalChatId
    )) ?? null
  }

  async takeTurns(promptMessageId: string): Promise<ChatMobileTurn[]> {
    const turns = this.turns.filter((turn) => turn.promptMessageId === promptMessageId)
    this.turns = this.turns.filter((turn) => turn.promptMessageId !== promptMessageId)
    return turns
  }
}

class FakeTelegram implements TelegramBotApiAccess {
  readonly commandRegistrations: TelegramBotCommand[][] = []
  readonly menuButtons: TelegramMenuButtonCommands[] = []
  readonly sent: SentTelegramMessage[] = []
  readonly drafts: TelegramDraftUpdate[] = []
  readonly actions: TelegramChatActionUpdate[] = []
  readonly edits: Array<{ chatId: string; messageId: number; text: string }> = []
  readonly deleted: Array<{ chatId: string; messageId: number }> = []
  readonly deletedBatches: Array<{ chatId: string; messageIds: number[] }> = []
  readonly callbacks: AnsweredTelegramCallback[] = []
  readonly cleared: Array<{ chatId: string; messageId: number }> = []
  readonly markups: Array<{ chatId: string; messageId: number; replyMarkup: TelegramInlineKeyboard }> = []
  readonly downloadedFileIds: string[] = []
  fileData = new Uint8Array([79, 103, 103, 83])
  failNativeDraft = false
  nextMessageGate: Promise<void> | null = null
  private readonly queued: TelegramUpdate[] = []
  private waiter: ((updates: TelegramUpdate[]) => void) | null = null

  async getMe(): Promise<TelegramUser> {
    return { id: 1, is_bot: true, first_name: "trbot", username: "trbot_test_bot" }
  }

  async setMyCommands(commands: TelegramBotCommand[]): Promise<void> {
    this.commandRegistrations.push(commands)
  }

  async setChatMenuButton(menuButton: TelegramMenuButtonCommands): Promise<void> {
    this.menuButtons.push(menuButton)
  }

  getUpdates(_offset: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    if (this.queued.length > 0) return Promise.resolve(this.queued.splice(0))
    return new Promise((resolve, reject) => {
      this.waiter = resolve
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
    })
  }

  async downloadFile(fileId: string): Promise<Uint8Array> {
    this.downloadedFileIds.push(fileId)
    return this.fileData
  }

  push(update: TelegramUpdate): void {
    if (this.waiter) {
      const resolve = this.waiter
      this.waiter = null
      resolve([update])
      return
    }
    this.queued.push(update)
  }

  async sendMessageDraft(chatId: string, draftId: number, text: string): Promise<void> {
    if (this.failNativeDraft) throw new Error("Native Telegram drafts unavailable")
    this.drafts.push({ chatId, draftId, text })
  }

  async sendChatAction(chatId: string, action: "typing"): Promise<void> {
    this.actions.push({ chatId, action })
  }

  async sendMessage(
    chatId: string,
    text: string,
    options: { replyMarkup?: TelegramInlineKeyboard } = {},
  ): Promise<TelegramMessage> {
    const sent: SentTelegramMessage = { chatId, text }
    if (options.replyMarkup) sent.replyMarkup = options.replyMarkup
    this.sent.push(sent)
    const gate = this.nextMessageGate
    this.nextMessageGate = null
    if (gate) await gate
    return {
      message_id: this.sent.length,
      chat: { id: Number(chatId), type: "private" },
      text,
    }
  }

  async editMessageText(chatId: string, messageId: number, text: string): Promise<void> {
    this.edits.push({ chatId, messageId, text })
  }

  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    this.deleted.push({ chatId, messageId })
  }

  async deleteMessages(chatId: string, messageIds: number[]): Promise<void> {
    this.deletedBatches.push({ chatId, messageIds })
  }

  async editMessageReplyMarkup(
    chatId: string,
    messageId: number,
    replyMarkup?: TelegramInlineKeyboard,
  ): Promise<void> {
    if (replyMarkup && replyMarkup.inline_keyboard.length > 0) {
      this.markups.push({ chatId, messageId, replyMarkup })
    } else {
      this.cleared.push({ chatId, messageId })
    }
  }

  async answerCallbackQuery(id: string, text?: string, showAlert?: boolean): Promise<void> {
    const callback: AnsweredTelegramCallback = { id }
    if (text) callback.text = text
    if (showAlert !== undefined) callback.showAlert = showAlert
    this.callbacks.push(callback)
  }
}

class FakeVoiceTranscriber implements VoiceTranscriber {
  readonly inputs: Uint8Array[] = []
  result = "Transcribed voice prompt"
  failure: Error | null = null

  async transcribeOggOpus(audio: Uint8Array): Promise<string> {
    this.inputs.push(audio)
    if (this.failure) throw this.failure
    return this.result
  }
}

class FakeChat {
  readonly sent: string[] = []
  readonly previews: Array<{ sessionId: string; messageId: string }> = []
  readonly undos: Array<{ sessionId: string; messageId: string; revertEffects: boolean }> = []
  previewEffects: ChatUndoEffect[] = []
  onMessage: ((message: ChatMessage) => void) | null = null
  readonly detail: ChatSessionDetail = {
    session: {
      id: "chat-1",
      title: "Index analysis",
      parentSessionId: null,
      agent: null,
      model: "model",
      provider: "provider",
      reasoning: null,
      createdAt: 1_000,
      updatedAt: 1_000,
      messageCount: 1,
      queued: 0,
      running: false,
    },
    messages: [message("Earlier prompt", "USER")],
    partial: null,
  }

  async getDetail(sessionId: string): Promise<ChatSessionDetail> {
    if (sessionId === this.detail.session.id) return this.detail
    if (sessionId === "chat-2") {
      return {
        ...this.detail,
        session: { ...this.detail.session, id: sessionId, title: "Second chat" },
      }
    }
    throw new Error("No such chat")
  }

  async send(sessionId: string, text: string): Promise<ChatMessage> {
    if (sessionId !== this.detail.session.id) throw new Error("No such chat")
    this.sent.push(text)
    const queued = message(text, "USER")
    this.onMessage?.(queued)
    return queued
  }

  async previewUndo(sessionId: string, messageId: string) {
    this.previews.push({ sessionId, messageId })
    return { prompt: "Prompt", effects: this.previewEffects }
  }

  async undo(sessionId: string, messageId: string, revertEffects = false) {
    this.undos.push({ sessionId, messageId, revertEffects })
    const revertedEffects = revertEffects
      ? this.previewEffects.filter((effect) => effect.reversible).map((effect) => effect.description)
      : []
    const preservedEffects = this.previewEffects
      .filter((effect) => !revertEffects || !effect.reversible)
      .map((effect) => effect.description)
    return {
      prompt: "Prompt",
      removedMessageIds: [messageId],
      revertedEffects,
      preservedEffects,
    }
  }
}

class FakePermissions {
  pending: ChatPermissionRequest[] = []
  readonly replies: Array<{ requestId: string; reply: ChatPermissionReply; clientId: string | null }> = []
  readonly attached = new Set<string>()
  readonly detached: string[] = []

  list(): ChatPermissionRequest[] {
    return [...this.pending]
  }

  async reply(requestId: string, reply: ChatPermissionReply, clientId: string | null = null): Promise<void> {
    this.replies.push({ requestId, reply, clientId })
    this.pending = this.pending.filter((request) => request.id !== requestId)
  }

  attachClient(clientId: string | null): void {
    if (clientId) this.attached.add(clientId)
  }

  detachClient(clientId: string | null): void {
    if (!clientId) return
    this.attached.delete(clientId)
    this.detached.push(clientId)
  }
}

class FakeQuestions {
  pending: ChatQuestionRequest[] = []
  readonly replies: Array<{ requestId: string; answers: ChatQuestionAnswer[] }> = []
  readonly rejected: string[] = []

  list(): ChatQuestionRequest[] {
    return [...this.pending]
  }

  async reply(requestId: string, answers: ChatQuestionAnswer[]): Promise<void> {
    this.replies.push({ requestId, answers })
    this.pending = this.pending.filter((request) => request.id !== requestId)
  }

  async reject(requestId: string): Promise<void> {
    this.rejected.push(requestId)
    this.pending = this.pending.filter((request) => request.id !== requestId)
  }
}

function harness(now = 2_000) {
  const store = new MemoryMobileStore()
  const telegram = new FakeTelegram()
  const chat = new FakeChat()
  const permissions = new FakePermissions()
  const questions = new FakeQuestions()
  const voiceTranscriber = new FakeVoiceTranscriber()
  const errors: unknown[] = []
  const mobile = new ChatMobileController({
    store,
    telegram,
    chat: {
      detail: (sessionId) => chat.getDetail(sessionId),
      send: (sessionId, text) => chat.send(sessionId, text),
      previewUndo: (sessionId, messageId) => chat.previewUndo(sessionId, messageId),
      undo: (sessionId, messageId, revertEffects) => chat.undo(sessionId, messageId, revertEffects),
    },
    permissions,
    questions,
    voiceTranscriber,
    onError: (cause) => errors.push(cause),
    now: () => now,
    draftIntervalMs: 5,
  })
  chat.onMessage = (queued) => mobile.accept({ type: "chatMessage", sessionId: "chat-1", message: queued })
  return { mobile, store, telegram, chat, permissions, questions, voiceTranscriber, errors }
}

test("publishes Telegram chat commands in the native commands menu", async () => {
  const { mobile, telegram } = harness()

  await mobile.start()

  expect(telegram.commandRegistrations).toHaveLength(1)
  expect(telegram.commandRegistrations[0]?.map((command) => command.command)).toEqual([
    "balance",
    "positions",
    "orders",
    "monitors",
    "loops",
    "cancelall",
    "exitall",
    "disconnect",
  ])
  expect(telegram.menuButtons).toEqual([{ type: "commands" }])
  mobile.destroy()
})

test("routes Telegram commands through the connected chat", async () => {
  const { mobile, telegram, chat } = harness()
  await mobile.start()
  await pair(mobile, telegram)

  const commands = [
    "/balance@trbot_test_bot",
    "/positions",
    "/orders",
    "/monitors",
    "/loops",
    "/cancelall",
    "/exitall",
  ]
  for (const [index, command] of commands.entries()) {
    telegram.push(update(index + 2, telegramMessage(command, index + 2)))
  }
  await until(() => chat.sent.length === commands.length)

  expect(chat.sent).toEqual([
    "Use get_account to report my current account balance and available collateral.",
    "Use get_account to list my current open VIOP positions.",
    "Use list_pending_orders to show all of my current pending VIOP orders.",
    "Use list_market_monitors to list the active market monitors for this chat.",
    "Use list_loops to list the scheduled loops for this chat.",
    "Cancel all pending VIOP orders. First use list_pending_orders, then use cancel_pending_viop_orders for every pending order.",
    "Use exit_all_viop_positions to exit every current open VIOP position.",
  ])

  telegram.push(update(9, telegramMessage("/balance@another_bot", 9)))
  await Bun.sleep(5)
  expect(chat.sent).toHaveLength(commands.length)
  mobile.destroy()
})

test("pairs a private Telegram account and continues the same chat", async () => {
  const { mobile, store, telegram, chat, permissions, errors } = harness()
  await mobile.start()
  const pairing = await mobile.pair("chat-1")
  const token = new URL(pairing.url).searchParams.get("start")!

  telegram.push(update(1, telegramMessage(`/start ${token}`)))
  await until(() => store.bindings.length === 1)

  expect(await mobile.state("chat-1")).toEqual({
    available: true,
    connection: { sessionId: "chat-1", channel: "telegram", displayName: "@ada", connectedAt: 2_000 },
  })
  expect(telegram.sent[0]?.text).toContain("Connected to “Index analysis”")
  expect(permissions.attached).toEqual(new Set(["mobile:telegram:42"]))

  telegram.push(update(2, telegramMessage("Continue on mobile")))
  await until(() => chat.sent.length === 1)
  expect(chat.sent).toEqual(["Continue on mobile"])
  expect(telegram.sent.some((sent) => sent.text === "🖥️ Continue on mobile")).toBe(false)

  mobile.accept({ type: "chatMessage", sessionId: "chat-1", message: message("Continue from TUI", "USER") })
  await until(() => telegram.sent.some((sent) => sent.text === "🖥️ Continue from TUI"))

  mobile.accept({ type: "chatMessage", sessionId: "chat-1", message: message("Mobile answer", "ASSISTANT") })
  await until(() => telegram.sent.some((sent) => sent.text === "Mobile answer"))
  expect(errors).toEqual([])
  mobile.destroy()
})

test("transcribes a connected Telegram voice note", async () => {
  const { mobile, telegram, chat, voiceTranscriber } = harness()
  await mobile.start()
  await pair(mobile, telegram)

  telegram.push(update(2, telegramVoiceMessage("voice-file")))
  await until(() => chat.sent.length === 1)

  expect(telegram.downloadedFileIds).toEqual(["voice-file"])
  expect(voiceTranscriber.inputs).toEqual([telegram.fileData])
  expect(chat.sent).toEqual(["Transcribed voice prompt"])
  expect(telegram.sent.some((sent) => sent.text === "🖥️ Transcribed voice prompt")).toBe(false)
  mobile.destroy()
})

test("reports a voice transcription failure without sending an empty prompt", async () => {
  const { mobile, telegram, chat, voiceTranscriber } = harness()
  voiceTranscriber.failure = new Error("Audio is corrupt")
  await mobile.start()
  await pair(mobile, telegram)

  telegram.push(update(2, telegramVoiceMessage("bad-voice")))
  await until(() => telegram.sent.some((sent) => sent.text.includes("Could not transcribe")))

  expect(chat.sent).toEqual([])
  expect(telegram.sent.at(-1)?.text).toContain("Audio is corrupt")
  mobile.destroy()
})

test("silently ignores messages and voice notes from a disconnected Telegram account", async () => {
  const { mobile, store, telegram, chat } = harness()
  await mobile.start()
  await pair(mobile, telegram)

  telegram.push(update(2, telegramMessage("/disconnect")))
  await until(() => store.bindings.length === 0)
  const sentBeforeUnboundMessages = telegram.sent.length

  telegram.push(update(3, telegramMessage("Are you still there?")))
  telegram.push(update(4, telegramMessage("/start")))
  telegram.push(update(5, telegramMessage("/disconnect")))
  telegram.push(update(6, telegramVoiceMessage("ignored-voice")))
  telegram.push(update(7, telegramMessage("/start invalid-token")))
  await until(() => telegram.sent.some((sent) => sent.text.includes("invalid or expired")))

  expect(telegram.sent.slice(sentBeforeUnboundMessages).map((sent) => sent.text)).toEqual([
    "That pairing link is invalid or expired. Run /connect again.",
  ])
  expect(chat.sent).toEqual([])
  expect(telegram.downloadedFileIds).toEqual([])
  mobile.destroy()
})

test("resolves a session tool approval only for the paired Telegram user", async () => {
  const { mobile, telegram, permissions } = harness()
  await mobile.start()
  await pair(mobile, telegram)
  const request: ChatPermissionRequest = {
    id: PERMISSION_ID,
    sessionId: "chat-1",
    toolName: "place_viop_order",
    action: "BUY 1 F_XU0300826 at 100",
    reason: "Open the planned position",
    scope: "SESSION",
    createdAt: 2_000,
  }
  permissions.pending.push(request)

  mobile.accept({ type: "chatPermissionRequested", request })
  await until(() => telegram.sent.some((sent) => sent.text.startsWith("⚠️ Tool approval required")))
  const approval = telegram.sent.find((sent) => sent.replyMarkup)!
  expect(approval.replyMarkup?.inline_keyboard.flat().map((button) => button.text)).toEqual([
    "Allow once",
    "Allow for connection",
    "Deny",
  ])

  telegram.push(update(3, undefined, {
    id: "callback-1",
    from: USER,
    message: telegramMessage("⚠️ Tool approval required", approvalMessageId(telegram)),
    data: `permission:s:${PERMISSION_ID}`,
  }))
  await until(() => permissions.replies.length === 1)

  expect(permissions.replies).toEqual([{
    requestId: PERMISSION_ID,
    reply: { decision: "ALLOW", scope: "SESSION" },
    clientId: "mobile:telegram:42",
  }])
  expect(telegram.callbacks.at(-1)?.text).toBe("Allowed for this connection")
  expect(telegram.cleared).toHaveLength(1)
  mobile.destroy()
})

test("shows an agent question in Telegram and submits a single choice", async () => {
  const { mobile, telegram, questions } = harness()
  await mobile.start()
  await pair(mobile, telegram)
  const request = questionRequest([{
    header: "Strategy",
    question: "Which setup should I watch?",
    options: [
      { label: "Breakout", description: "Wait for resistance to break" },
      { label: "Pullback", description: "Wait for a retracement" },
    ],
  }])
  questions.pending.push(request)

  mobile.accept({ type: "chatQuestionAsked", request })
  await until(() => telegram.sent.some((sent) => sent.text.startsWith("❓ Agent asks")))
  const messageId = telegram.sent.findIndex((sent) => sent.text.startsWith("❓ Agent asks")) + 1
  const sent = telegram.sent[messageId - 1]!
  expect(sent.text).toContain("Which setup should I watch?")
  expect(sent.text).toContain("Breakout — Wait for resistance to break")
  expect(sent.replyMarkup?.inline_keyboard.flat().map((button) => button.text)).toEqual([
    "Breakout",
    "Pullback",
    "Other…",
    "Dismiss",
  ])

  telegram.push(update(3, undefined, {
    id: "question-callback-1",
    from: USER,
    message: telegramMessage(sent.text, messageId),
    data: "question:o:1",
  }))
  await until(() => questions.replies.length === 1)

  expect(questions.replies).toEqual([{
    requestId: QUESTION_ID,
    answers: [["Pullback"]],
  }])
  expect(telegram.edits.at(-1)?.text).toContain("Answered: Pullback")
  expect(telegram.callbacks.at(-1)?.text).toBe("Pullback")
  expect(telegram.cleared).toContainEqual({ chatId: USER.id.toString(), messageId })
  mobile.destroy()
})

test("dismisses a pending question from Telegram", async () => {
  const { mobile, telegram, questions } = harness()
  await mobile.start()
  await pair(mobile, telegram)
  const request = questionRequest([{
    header: "Choice",
    question: "Should I continue?",
    options: [{ label: "Continue", description: "Keep working" }],
  }])
  questions.pending.push(request)
  mobile.accept({ type: "chatQuestionAsked", request })
  await until(() => telegram.sent.some((sent) => sent.text.includes("Should I continue?")))
  const messageId = telegram.sent.findIndex((sent) => sent.text.includes("Should I continue?")) + 1

  telegram.push(update(3, undefined, {
    id: "dismiss-question-callback",
    from: USER,
    message: telegramMessage("Should I continue?", messageId),
    data: "question:x",
  }))
  await until(() => questions.rejected.length === 1)

  expect(questions.rejected).toEqual([QUESTION_ID])
  expect(telegram.edits.at(-1)?.text).toContain("Dismissed")
  expect(telegram.callbacks.at(-1)?.text).toBe("Dismissed")
  mobile.destroy()
})

test("collects multiple choices and a custom answer across Telegram questions", async () => {
  const { mobile, telegram, chat, questions } = harness()
  await mobile.start()
  await pair(mobile, telegram)
  const request = questionRequest([
    {
      header: "Delivery",
      question: "Where should I notify you?",
      options: [
        { label: "Terminal", description: "Show it in trbot" },
        { label: "Sound", description: "Play an alert sound" },
      ],
      multiple: true,
    },
    {
      header: "Timing",
      question: "When should I send it?",
      options: [],
    },
  ])
  questions.pending.push(request)
  mobile.accept({ type: "chatQuestionAsked", request })
  await until(() => telegram.sent.some((sent) => sent.text.includes("1/2")))
  const firstMessageId = telegram.sent.findIndex((sent) => sent.text.includes("1/2")) + 1
  const firstMessage = telegram.sent[firstMessageId - 1]!

  telegram.push(update(3, undefined, {
    id: "question-callback-1",
    from: USER,
    message: telegramMessage(firstMessage.text, firstMessageId),
    data: "question:o:0",
  }))
  await until(() => telegram.markups.some((markup) => (
    markup.messageId === firstMessageId
    && markup.replyMarkup.inline_keyboard.flat().some((button) => button.text === "✓ Terminal")
  )))

  telegram.push(update(4, undefined, {
    id: "question-callback-2",
    from: USER,
    message: telegramMessage(firstMessage.text, firstMessageId),
    data: "question:d",
  }))
  await until(() => telegram.sent.some((sent) => sent.text.includes("2/2")))
  const secondMessageId = telegram.sent.findLastIndex((sent) => sent.text.includes("2/2")) + 1
  const secondMessage = telegram.sent[secondMessageId - 1]!

  telegram.push(update(5, undefined, {
    id: "question-callback-3",
    from: USER,
    message: telegramMessage(secondMessage.text, secondMessageId),
    data: "question:c",
  }))
  await until(() => telegram.callbacks.some((callback) => callback.id === "question-callback-3"))
  telegram.push(update(6, telegramMessage("At the close", 6)))
  await until(() => questions.replies.length === 1)

  expect(questions.replies).toEqual([{
    requestId: QUESTION_ID,
    answers: [["Terminal"], ["At the close"]],
  }])
  expect(chat.sent).toEqual([])
  expect(telegram.edits.at(-1)?.text).toContain("Answered: At the close")
  mobile.destroy()
})

test("replays pending questions when Telegram connects and clears resolved prompts", async () => {
  const { mobile, telegram, questions } = harness()
  const request = questionRequest([{
    header: "Choice",
    question: "Continue?",
    options: [{ label: "Continue", description: "Resume the task" }],
  }])
  questions.pending.push(request)
  await mobile.start()
  await pair(mobile, telegram)
  await until(() => telegram.sent.some((sent) => sent.text.includes("Continue?")))
  const messageId = telegram.sent.findIndex((sent) => sent.text.includes("Continue?")) + 1

  mobile.accept({ type: "chatQuestionResolved", requestId: request.id, sessionId: request.sessionId })
  await until(() => telegram.cleared.some((entry) => entry.messageId === messageId))

  telegram.push(update(3, undefined, {
    id: "stale-question-callback",
    from: USER,
    message: telegramMessage("Continue?", messageId),
    data: "question:o:0",
  }))
  await until(() => telegram.callbacks.some((callback) => callback.id === "stale-question-callback"))

  expect(telegram.sent.filter((sent) => sent.text.includes("Continue?"))).toHaveLength(1)
  expect(telegram.callbacks.at(-1)).toMatchObject({
    text: "This question is no longer pending.",
    showAlert: true,
  })
  mobile.destroy()
})

test("rejects an expired pairing token without creating a connection", async () => {
  let now = 2_000
  const store = new MemoryMobileStore()
  const telegram = new FakeTelegram()
  const chat = new FakeChat()
  const permissions = new FakePermissions()
  const questions = new FakeQuestions()
  const mobile = new ChatMobileController({
    store,
    telegram,
    chat: {
      detail: (sessionId) => chat.getDetail(sessionId),
      send: (sessionId, text) => chat.send(sessionId, text),
      previewUndo: (sessionId, messageId) => chat.previewUndo(sessionId, messageId),
      undo: (sessionId, messageId, revertEffects) => chat.undo(sessionId, messageId, revertEffects),
    },
    permissions,
    questions,
    onError: () => {},
    now: () => now,
  })
  await mobile.start()
  const pairing = await mobile.pair("chat-1")
  now = pairing.expiresAt + 1

  telegram.push(update(1, telegramMessage(`/start ${new URL(pairing.url).searchParams.get("start")}`)))
  await until(() => telegram.sent.length > 0)

  expect(store.bindings).toEqual([])
  expect(telegram.sent[0]?.text).toContain("invalid or expired")
  mobile.destroy()
})

test("revokes connection-scoped grants before moving a Telegram account to another chat", async () => {
  const { mobile, store, telegram, permissions } = harness()
  await mobile.start()
  await pair(mobile, telegram)

  const pairing = await mobile.pair("chat-2")
  telegram.push(update(2, telegramMessage(`/start ${new URL(pairing.url).searchParams.get("start")}`)))
  await until(() => store.bindings[0]?.sessionId === "chat-2")

  expect(permissions.detached).toEqual(["mobile:telegram:42"])
  expect(permissions.attached).toEqual(new Set(["mobile:telegram:42"]))
  mobile.destroy()
})

test("does not expose read-only worker transcripts through Telegram", async () => {
  const { mobile, chat } = harness()
  await mobile.start()
  chat.detail.session.parentSessionId = "parent-chat"

  expect(mobile.pair("chat-1")).rejects.toMatchObject({
    code: "invalid_request",
    message: "Subagent sessions cannot be connected to Telegram",
  })
  mobile.destroy()
})

test("shows native typing until assistant text can stream as a draft", async () => {
  const { mobile, telegram } = harness()
  await mobile.start()
  await pair(mobile, telegram)
  const runId = "22222222-2222-4222-8222-222222222222"

  await mobile.accept({
    type: "chatRun",
    sessionId: "chat-1",
    runId,
    status: "running",
    promptMessageId: PROMPT_ID,
  })
  expect(telegram.actions).toEqual([{ chatId: "42", action: "typing" }])
  expect(telegram.drafts).toHaveLength(0)

  mobile.accept({ type: "chatDelta", sessionId: "chat-1", runId, seq: 1, text: "Streaming " })
  mobile.accept({ type: "chatDelta", sessionId: "chat-1", runId, seq: 2, reasoning: "hidden" })
  mobile.accept({ type: "chatDelta", sessionId: "chat-1", runId, seq: 3, text: "answer" })
  await until(() => telegram.drafts.some((draft) => draft.text === "Streaming answer"))

  mobile.accept({
    type: "chatMessage",
    sessionId: "chat-1",
    message: message("Streaming answer", "ASSISTANT"),
  })
  mobile.accept({ type: "chatRun", sessionId: "chat-1", runId, status: "done" })
  await until(() => telegram.sent.some((sent) => sent.text === "Streaming answer"))

  expect(telegram.drafts).toHaveLength(1)
  expect(telegram.drafts.some((draft) => draft.text.includes("hidden"))).toBe(false)
  expect(telegram.sent.filter((sent) => sent.text === "Streaming answer")).toHaveLength(1)
  expect(telegram.markups.at(-1)?.replyMarkup).toEqual({
    inline_keyboard: [[{ text: "↩ Undo", callback_data: `undo:${PROMPT_ID}` }]],
  })
  mobile.destroy()
})

test("offers conversation-only undo from Telegram and removes the turn messages", async () => {
  const { mobile, store, telegram, chat } = harness()
  await mobile.start()
  await pair(mobile, telegram)

  const prompt = message("Undo this turn", "USER")
  prompt.id = PROMPT_ID
  mobile.accept({ type: "chatMessage", sessionId: "chat-1", message: prompt })
  await until(() => store.turns.some((turn) => turn.promptMessageId === PROMPT_ID))

  const runId = "88888888-8888-4888-8888-888888888888"
  await mobile.accept({
    type: "chatRun",
    sessionId: "chat-1",
    runId,
    status: "running",
    promptMessageId: PROMPT_ID,
  })
  mobile.accept({
    type: "chatMessage",
    sessionId: "chat-1",
    message: message("Answer to remove", "ASSISTANT"),
  })
  await until(() => telegram.markups.length === 1)
  const answerMessageId = telegram.markups[0]!.messageId

  telegram.push(update(2, undefined, {
    id: "undo-1",
    from: USER,
    message: telegramMessage("Answer to remove", answerMessageId),
    data: `undo:${PROMPT_ID}`,
  }))
  await until(() => telegram.markups.length === 2)

  expect(chat.previews).toEqual([{ sessionId: "chat-1", messageId: PROMPT_ID }])
  expect(chat.undos).toEqual([])
  expect(telegram.callbacks.at(-1)).toEqual({
    id: "undo-1",
    text: "No recorded actions to restore.",
    showAlert: false,
  })
  expect(telegram.markups.at(-1)?.replyMarkup).toEqual({
    inline_keyboard: [
      [{ text: "Conversation only", callback_data: `undo:c:${PROMPT_ID}` }],
      [{ text: "Conversation + reversible actions", callback_data: `undo:r:${PROMPT_ID}` }],
      [{ text: "Cancel", callback_data: `undo:x:${PROMPT_ID}` }],
    ],
  })

  telegram.push(update(3, undefined, {
    id: "undo-2",
    from: USER,
    message: telegramMessage("Answer to remove", answerMessageId),
    data: `undo:c:${PROMPT_ID}`,
  }))
  await until(() => chat.undos.length === 1)
  await until(() => telegram.deletedBatches.length === 1)

  expect(chat.undos).toEqual([{
    sessionId: "chat-1",
    messageId: PROMPT_ID,
    revertEffects: false,
  }])
  expect(telegram.callbacks.at(-1)?.text).toBe("Conversation undone.")
  expect(telegram.deletedBatches).toEqual([{ chatId: "42", messageIds: [2, answerMessageId] }])
  expect(store.turns).toEqual([])
  mobile.destroy()
})

test("restores reversible actions when that Telegram undo choice is selected", async () => {
  const { mobile, store, telegram, chat } = harness()
  chat.previewEffects = [
    { description: "Market monitor was created", reversible: true },
    { description: "Broker order was submitted", reversible: false },
  ]
  await mobile.start()
  await pair(mobile, telegram)
  await store.recordTurnMessage({
    sessionId: "chat-1",
    promptMessageId: PROMPT_ID,
    channel: "telegram",
    externalChatId: "42",
    externalMessageId: 21,
    createdAt: 2_000,
  })

  telegram.push(update(2, undefined, {
    id: "undo-preview",
    from: USER,
    message: telegramMessage("Answer to remove", 21),
    data: `undo:${PROMPT_ID}`,
  }))
  await until(() => telegram.markups.length === 1)
  expect(telegram.callbacks.at(-1)?.text).toBe("1 reversible action; 1 action will be kept.")

  telegram.push(update(3, undefined, {
    id: "undo-effects",
    from: USER,
    message: telegramMessage("Answer to remove", 21),
    data: `undo:r:${PROMPT_ID}`,
  }))
  await until(() => chat.undos.length === 1)
  await until(() => telegram.deletedBatches.length === 1)

  expect(chat.undos).toEqual([{
    sessionId: "chat-1",
    messageId: PROMPT_ID,
    revertEffects: true,
  }])
  expect(telegram.callbacks.at(-1)?.text).toBe("Conversation undone; restored 1 action; kept 1.")
  expect(telegram.deletedBatches).toEqual([{ chatId: "42", messageIds: [21] }])
  mobile.destroy()
})

test("can cancel a Telegram undo after previewing it", async () => {
  const { mobile, store, telegram, chat } = harness()
  await mobile.start()
  await pair(mobile, telegram)
  await store.recordTurnMessage({
    sessionId: "chat-1",
    promptMessageId: PROMPT_ID,
    channel: "telegram",
    externalChatId: "42",
    externalMessageId: 21,
    createdAt: 2_000,
  })

  telegram.push(update(2, undefined, {
    id: "undo-preview",
    from: USER,
    message: telegramMessage("Answer to keep", 21),
    data: `undo:${PROMPT_ID}`,
  }))
  await until(() => telegram.markups.length === 1)
  telegram.push(update(3, undefined, {
    id: "undo-cancel",
    from: USER,
    message: telegramMessage("Answer to keep", 21),
    data: `undo:x:${PROMPT_ID}`,
  }))
  await until(() => telegram.markups.length === 2)

  expect(chat.undos).toEqual([])
  expect(store.turns).toHaveLength(1)
  expect(telegram.deletedBatches).toEqual([])
  expect(telegram.markups.at(-1)?.replyMarkup).toEqual({
    inline_keyboard: [[{ text: "↩ Undo", callback_data: `undo:${PROMPT_ID}` }]],
  })
  expect(telegram.callbacks.at(-1)?.text).toBe("Undo cancelled.")
  mobile.destroy()
})

test("removes Telegram turns when the conversation is undone elsewhere", async () => {
  const { mobile, store, telegram } = harness()
  await mobile.start()
  await pair(mobile, telegram)
  await store.recordTurnMessage({
    sessionId: "chat-1",
    promptMessageId: PROMPT_ID,
    channel: "telegram",
    externalChatId: "42",
    externalMessageId: 21,
    createdAt: 2_000,
  })
  await store.recordTurnMessage({
    sessionId: "chat-1",
    promptMessageId: PROMPT_ID,
    channel: "telegram",
    externalChatId: "42",
    externalMessageId: 22,
    createdAt: 2_000,
  })

  mobile.accept({ type: "chatMessageRemoved", sessionId: "chat-1", messageId: PROMPT_ID })
  await until(() => telegram.deletedBatches.length === 1)

  expect(telegram.deletedBatches).toEqual([{ chatId: "42", messageIds: [21, 22] }])
  expect(store.turns).toEqual([])
  mobile.destroy()
})

test("shows exact tool names with a cog and removes successful tools", async () => {
  const { mobile, telegram } = harness()
  await mobile.start()
  await pair(mobile, telegram)
  const runId = "55555555-5555-4555-8555-555555555555"

  await mobile.accept({
    type: "chatRun",
    sessionId: "chat-1",
    runId,
    status: "running",
    promptMessageId: PROMPT_ID,
  })
  const searchStarted = mobile.accept({
    type: "chatDelta",
    sessionId: "chat-1",
    runId,
    seq: 1,
    toolName: "search_web",
  })
  if (!searchStarted) throw new Error("Tool-start delivery was not awaitable")
  await searchStarted
  const searchMessageId = telegram.sent.findIndex((sent) => sent.text === "⚙️ search_web") + 1
  expect(searchMessageId).toBeGreaterThan(0)
  expect(telegram.drafts.some((draft) => draft.text.includes("search_web"))).toBe(false)

  const searchResult = message("private search result payload", "TOOL_RESULT")
  searchResult.toolName = "search_web"
  await mobile.accept({ type: "chatMessage", sessionId: "chat-1", message: searchResult })
  expect(telegram.deleted).toContainEqual({ chatId: "42", messageId: searchMessageId })
  expect(telegram.actions.at(-1)).toEqual({ chatId: "42", action: "typing" })

  const quoteStarted = mobile.accept({
    type: "chatDelta",
    sessionId: "chat-1",
    runId,
    seq: 2,
    toolName: "load_quote",
  })
  if (!quoteStarted) throw new Error("Tool-start delivery was not awaitable")
  await quoteStarted
  const quoteMessageId = telegram.sent.findIndex((sent) => sent.text === "⚙️ load_quote") + 1
  expect(quoteMessageId).toBeGreaterThan(0)

  const quoteResult = message("private quote result payload", "TOOL_RESULT")
  quoteResult.toolName = "load_quote"
  quoteResult.isError = true
  await mobile.accept({ type: "chatMessage", sessionId: "chat-1", message: quoteResult })
  expect(telegram.edits).toContainEqual({ chatId: "42", messageId: quoteMessageId, text: "✕ load_quote" })
  expect(telegram.actions.at(-1)).toEqual({ chatId: "42", action: "typing" })

  mobile.accept({ type: "chatDelta", sessionId: "chat-1", runId, seq: 3, text: "Here is what I found." })
  await until(() => telegram.drafts.some((draft) => draft.text.includes("Here is what I found.")))
  const preview = telegram.drafts.at(-1)?.text ?? ""
  expect(preview).not.toContain("search_web")
  expect(preview).not.toContain("load_quote")
  expect(preview).not.toContain("private search result payload")
  expect(preview).not.toContain("private quote result payload")

  mobile.accept({
    type: "chatMessage",
    sessionId: "chat-1",
    message: message("Here is what I found.", "ASSISTANT"),
  })
  await until(() => telegram.sent.some((sent) => sent.text === "Here is what I found."))
  mobile.destroy()
})

test("exposes a promise that settles after a complete tool-start message reaches Telegram", async () => {
  const { mobile, telegram } = harness()
  await mobile.start()
  await pair(mobile, telegram)
  const runId = "66666666-6666-4666-8666-666666666666"

  await mobile.accept({
    type: "chatRun",
    sessionId: "chat-1",
    runId,
    status: "running",
    promptMessageId: PROMPT_ID,
  })

  const gate = Promise.withResolvers<void>()
  telegram.nextMessageGate = gate.promise
  const delivered = mobile.accept({
    type: "chatDelta",
    sessionId: "chat-1",
    runId,
    seq: 1,
    toolName: "search_web",
  })
  if (!delivered) throw new Error("Tool-start delivery was not awaitable")

  await until(() => telegram.sent.some((sent) => sent.text === "⚙️ search_web"))
  let settled = false
  void delivered.then(() => { settled = true })
  await Bun.sleep(0)
  expect(settled).toBe(false)

  gate.resolve()
  await delivered
  expect(settled).toBe(true)
  mobile.destroy()
})

test("falls back to editing one message when native drafts fail", async () => {
  const { mobile, telegram, errors } = harness()
  await mobile.start()
  await pair(mobile, telegram)
  telegram.failNativeDraft = true
  const runId = "33333333-3333-4333-8333-333333333333"

  await mobile.accept({
    type: "chatRun",
    sessionId: "chat-1",
    runId,
    status: "running",
    promptMessageId: PROMPT_ID,
  })
  expect(telegram.actions).toEqual([{ chatId: "42", action: "typing" }])
  expect(errors).toHaveLength(0)
  expect(telegram.sent.some((sent) => sent.text === "Thinking...")).toBe(false)
  mobile.accept({ type: "chatDelta", sessionId: "chat-1", runId, seq: 1, text: "Partial" })
  await until(() => telegram.sent.some((sent) => sent.text === "Partial"))
  mobile.accept({ type: "chatDelta", sessionId: "chat-1", runId, seq: 2, text: " response" })
  await until(() => telegram.edits.some((edit) => edit.text === "Partial response"))

  mobile.accept({
    type: "chatMessage",
    sessionId: "chat-1",
    message: message("Partial response complete", "ASSISTANT"),
  })
  await until(() => telegram.edits.some((edit) => edit.text === "Partial response complete"))

  expect(telegram.sent.some((sent) => sent.text === "Thinking...")).toBe(false)
  expect(errors[0]).toEqual(new Error("Native Telegram drafts unavailable"))
  mobile.destroy()
})

test("streams the tail of a long reply and persists complete Unicode-safe chunks", async () => {
  const { mobile, telegram } = harness()
  await mobile.start()
  await pair(mobile, telegram)
  const runId = "44444444-4444-4444-8444-444444444444"
  const answer = "😀".repeat(2_500)

  mobile.accept({
    type: "chatRun",
    sessionId: "chat-1",
    runId,
    status: "running",
    promptMessageId: PROMPT_ID,
  })
  await until(() => telegram.actions.length === 1)
  mobile.accept({ type: "chatDelta", sessionId: "chat-1", runId, seq: 1, text: answer })
  await until(() => telegram.drafts.length === 1)

  const preview = telegram.drafts.at(-1)?.text ?? ""
  expect(preview.startsWith("…")).toBe(true)
  expect(preview.length).toBeLessThanOrEqual(4_000)

  mobile.accept({ type: "chatMessage", sessionId: "chat-1", message: message(answer, "ASSISTANT") })
  await until(() => telegram.sent.length === 3)
  const persisted = telegram.sent.slice(1)
  expect(persisted.map((sent) => sent.text.length)).toEqual([4_000, 1_000])
  expect(persisted.map((sent) => sent.text).join("")).toBe(answer)
  mobile.destroy()
})

async function pair(mobile: ChatMobileController, telegram: FakeTelegram): Promise<void> {
  const pairing = await mobile.pair("chat-1")
  telegram.push(update(1, telegramMessage(`/start ${new URL(pairing.url).searchParams.get("start")}`)))
  await until(() => telegram.sent.length > 0)
}

function telegramMessage(text: string, messageId = 1): TelegramMessage {
  return { message_id: messageId, from: USER, chat: { id: USER.id, type: "private" }, text }
}

function telegramVoiceMessage(fileId: string, messageId = 1): TelegramMessage {
  return {
    message_id: messageId,
    from: USER,
    chat: { id: USER.id, type: "private" },
    voice: {
      file_id: fileId,
      file_unique_id: `${fileId}-unique`,
      duration: 12,
      mime_type: "audio/ogg",
      file_size: 1_024,
    },
  }
}

function update(
  updateId: number,
  message_: TelegramMessage | undefined,
  callbackQuery?: TelegramUpdate["callback_query"],
): TelegramUpdate {
  const value: TelegramUpdate = { update_id: updateId }
  if (message_) value.message = message_
  if (callbackQuery) value.callback_query = callbackQuery
  return value
}

function approvalMessageId(telegram: FakeTelegram): number {
  return telegram.sent.findIndex((sent) => sent.replyMarkup) + 1
}

function questionRequest(questions: ChatQuestionRequest["questions"]): ChatQuestionRequest {
  return { id: QUESTION_ID, sessionId: "chat-1", questions }
}

function message(text: string, role: ChatMessage["role"]): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    status: role === "USER" ? "QUEUED" : "COMPLETE",
    text,
    blocks: [chatBlockText(text)],
    toolName: null,
    toolCallId: null,
    isError: false,
    errorMessage: null,
    usage: null,
    model: role === "ASSISTANT" ? "model" : null,
    reasoning: null,
    elapsedMs: null,
    thinkingMs: null,
    createdAt: 1_000,
  }
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return
    await Bun.sleep(1)
  }
  throw new Error("Timed out waiting for mobile chat")
}

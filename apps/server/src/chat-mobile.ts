import type {
  TelegramBotApiAccess,
  TelegramCallbackQuery,
  TelegramInlineKeyboard,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "@trbot/api/telegram.ts"
import type { VoiceTranscriber } from "@trbot/ai/voice-transcription.ts"
import type { ChatPermissionReply, ChatPermissionRequest } from "@trbot/chat/permission.ts"
import type {
  ChatMobileBinding,
  ChatMobileConnection,
  ChatMobilePairing,
  ChatMobileState,
  ChatMobileStore,
} from "@trbot/chat/mobile.ts"
import type { ChatMessage, ChatSessionDetail } from "@trbot/chat/session.ts"
import { ProtocolError } from "@trbot/protocol/error.ts"
import type { ChatFrame } from "@trbot/protocol/stream.ts"

const PAIRING_TTL_MS = 5 * 60_000
const TELEGRAM_MESSAGE_LIMIT = 4_096
const TELEGRAM_CHUNK_SIZE = 4_000
const TELEGRAM_DRAFT_INTERVAL_MS = 1_000
const TELEGRAM_TYPING_INTERVAL_MS = 4_000
const TELEGRAM_TOOL_RUNNING_ICON = "⚙️"
const MAX_VOICE_DURATION_SECONDS = 10 * 60
const POLL_RETRY_MS = 1_000

interface MobileChatAccess {
  detail(sessionId: string): Promise<ChatSessionDetail>
  send(sessionId: string, text: string): Promise<ChatMessage>
}

interface MobilePermissionAccess {
  list(): ChatPermissionRequest[]
  reply(requestId: string, reply: ChatPermissionReply, clientId?: string | null): Promise<void>
  attachClient(clientId: string | null): void
  detachClient(clientId: string | null): void
}

interface PairingRecord {
  sessionId: string
  expiresAt: number
}

interface ApprovalMessage {
  sessionId: string
  chatId: string
  messageId: number
}

interface StreamingMessage {
  sessionId: string
  runId: string
  draftId: number
  chatId: string | null
  text: string
  tools: Array<{ name: string; messageId: number | null }>
  lastPreview: string | null
  fallbackMessageId: number | null
  nativeDraft: boolean
  finalizing: boolean
  cancelled: boolean
  timer: ReturnType<typeof setTimeout> | null
  typingTimer: ReturnType<typeof setTimeout> | null
  inFlight: Promise<void>
}

export interface ChatMobileControllerOptions {
  store: ChatMobileStore
  chat: MobileChatAccess
  permissions: MobilePermissionAccess
  telegram: TelegramBotApiAccess | null
  voiceTranscriber?: VoiceTranscriber | null
  onError: (cause: unknown) => void
  now?: () => number
  draftIntervalMs?: number
}

/** Attaches one server-owned chat to a private Telegram conversation. */
export class ChatMobileController {
  private readonly pairings = new Map<string, PairingRecord>()
  private readonly attachedClients = new Set<string>()
  private readonly approvalMessages = new Map<string, ApprovalMessage>()
  private readonly suppressedUserMessages = new Map<string, string[]>()
  private readonly streamingMessages = new Map<string, StreamingMessage>()
  private pendingVoiceMessages: Promise<void> = Promise.resolve()
  private readonly now: () => number
  private readonly draftIntervalMs: number
  private botUsername: string | null = null
  private pollController: AbortController | null = null
  private destroyed = false

  constructor(private readonly options: ChatMobileControllerOptions) {
    this.now = options.now ?? Date.now
    this.draftIntervalMs = options.draftIntervalMs ?? TELEGRAM_DRAFT_INTERVAL_MS
  }

  /** Validates the bot token, restores virtual permission clients, then polls outbound. */
  async start(): Promise<void> {
    if (!this.options.telegram || this.destroyed) return
    try {
      const bot = await this.options.telegram.getMe(AbortSignal.timeout(10_000))
      if (!bot.username) throw new Error("The configured Telegram bot has no username")
      this.botUsername = bot.username
      await this.reconcileClients()
      for (const request of this.options.permissions.list()) this.runInBackground(this.sendPermission(request))

      const controller = new AbortController()
      this.pollController = controller
      void this.poll(controller.signal).catch((cause: unknown) => {
        if (!controller.signal.aborted) this.options.onError(cause)
      })
    } catch (cause) {
      this.options.onError(cause)
    }
  }

  async state(sessionId: string): Promise<ChatMobileState> {
    await this.options.chat.detail(sessionId)
    const binding = await this.options.store.findBySession(sessionId)
    return {
      available: this.options.telegram !== null && this.botUsername !== null,
      connection: binding ? publicConnection(binding) : null,
    }
  }

  async pair(sessionId: string): Promise<ChatMobilePairing> {
    const detail = await this.options.chat.detail(sessionId)
    if (detail.session.parentSessionId) {
      throw new ProtocolError("invalid_request", "Subagent sessions cannot be connected to Telegram")
    }
    if (!this.options.telegram) {
      throw new ProtocolError("invalid_request", "Telegram is not configured on the server")
    }
    if (!this.botUsername) {
      throw new ProtocolError("upstream_unavailable", "Telegram is unavailable; check the server log and bot token")
    }

    this.sweepPairings()
    for (const [token, pairing] of this.pairings) {
      if (pairing.sessionId === sessionId) this.pairings.delete(token)
    }
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")
    const expiresAt = this.now() + PAIRING_TTL_MS
    this.pairings.set(token, { sessionId, expiresAt })
    return {
      channel: "telegram",
      url: `https://t.me/${encodeURIComponent(this.botUsername)}?start=${token}`,
      expiresAt,
    }
  }

  async disconnect(sessionId: string): Promise<void> {
    await this.options.chat.detail(sessionId)
    this.cancelStream(sessionId)
    await this.options.store.removeSession(sessionId)
    for (const [token, pairing] of this.pairings) {
      if (pairing.sessionId === sessionId) this.pairings.delete(token)
    }
    this.forgetApprovals(sessionId)
    await this.reconcileClients()
  }

  /** Reconciles database cascades after a chat is deleted. */
  async sync(): Promise<void> {
    await this.reconcileClients()
  }

  /** Receives the same application-owned frames as every other chat client. */
  accept(frame: ChatFrame): Promise<void> | void {
    if (this.destroyed || !this.options.telegram) return
    switch (frame.type) {
      case "chatMessage":
        if (frame.message.role === "USER" && this.consumeSuppressed(frame.sessionId, frame.message.text)) return
        if (frame.message.role === "USER") {
          this.runInBackground(this.deliver(frame.sessionId, `🖥️ ${frame.message.text}`))
        } else if (frame.message.role === "ASSISTANT" && frame.message.text.trim()) {
          if (!this.finalizeStream(frame.sessionId, frame.message.text)) {
            this.runInBackground(this.deliver(frame.sessionId, frame.message.text))
          }
        } else if (frame.message.role === "APP_EVENT" && frame.message.text.trim()) {
          this.runInBackground(this.deliver(frame.sessionId, `Update\n${frame.message.text}`))
        } else if (frame.message.role === "TOOL_RESULT" && frame.message.toolName) {
          return this.completeStreamTool(frame.sessionId, frame.message.toolName, frame.message.isError)
        }
        return
      case "chatDelta": {
        const stream = this.streamingMessages.get(frame.sessionId)
        if (!stream || stream.runId !== frame.runId) return
        let textChanged = false
        if (frame.text) {
          stream.text += frame.text
          textChanged = true
        }
        if (frame.toolName) {
          return this.startStreamTool(stream, frame.toolName)
        }
        if (textChanged) this.scheduleStream(stream)
        return
      }
      case "chatPermissionRequested":
        this.runInBackground(this.sendPermission(frame.request))
        return
      case "chatPermissionResolved":
        this.runInBackground(this.clearPermission(frame.requestId))
        return
      case "chatRun":
        if (frame.status === "running") {
          return this.beginStream(frame.sessionId, frame.runId)
        } else if (frame.status === "failed" && frame.error) {
          const message = `Chat failed\n${frame.error}`
          if (!this.finalizeStream(frame.sessionId, message, frame.runId)) {
            this.runInBackground(this.deliver(frame.sessionId, message))
          }
        } else {
          this.cancelStream(frame.sessionId, frame.runId)
        }
        return
      default:
        return
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.pollController?.abort()
    this.pollController = null
    for (const clientId of this.attachedClients) this.options.permissions.detachClient(clientId)
    this.attachedClients.clear()
    this.pairings.clear()
    this.approvalMessages.clear()
    this.suppressedUserMessages.clear()
    for (const stream of this.streamingMessages.values()) this.stopStream(stream)
    this.streamingMessages.clear()
  }

  private async poll(signal: AbortSignal): Promise<void> {
    const telegram = this.options.telegram
    if (!telegram) return
    let offset = 0
    while (!signal.aborted) {
      try {
        const updates = await telegram.getUpdates(offset, signal)
        for (const update of updates) {
          try {
            await this.handleUpdate(update)
          } catch (cause) {
            this.options.onError(cause)
          } finally {
            offset = Math.max(offset, update.update_id + 1)
          }
        }
      } catch (cause) {
        if (isAbortError(cause) || signal.aborted) return
        this.options.onError(cause)
        await waitForRetry(signal)
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query)
      return
    }
    if (update.message) await this.handleMessage(update.message)
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    const telegram = this.options.telegram
    const sender = message.from
    const text = message.text?.trim()
    if (!telegram || !sender || sender.is_bot || message.chat.type !== "private" || (!text && !message.voice)) return

    if (text) {
      const start = text.match(/^\/start(?:\s+([A-Za-z0-9_-]+))?$/u)
      if (start) {
        const token = start[1]
        if (!token) {
          const binding = await this.bindingFor(sender, message)
          if (binding) {
            await this.sendLong(message.chat.id.toString(), "This phone is already connected. Send a message to continue the chat.")
          }
          return
        }
        await this.consumePairing(token, sender, message)
        return
      }

      if (text === "/disconnect") {
        const binding = await this.bindingFor(sender, message)
        if (!binding) return
        await this.sendLong(message.chat.id.toString(), "Disconnected from trbot.")
        await this.disconnect(binding.sessionId)
        return
      }
    }

    const binding = await this.bindingFor(sender, message)
    if (!binding) return

    if (message.voice) {
      this.pendingVoiceMessages = this.pendingVoiceMessages
        .then(() => this.handleVoice(binding, message))
        .catch((cause: unknown) => this.options.onError(cause))
      return
    }
    if (!text) return
    await this.sendChatText(binding, text)
  }

  private async handleVoice(
    binding: ChatMobileBinding,
    message: TelegramMessage,
  ): Promise<void> {
    if (this.destroyed) return
    const telegram = this.options.telegram
    const transcriber = this.options.voiceTranscriber
    const voice = message.voice
    if (!telegram || !voice) return
    if (!transcriber) {
      await this.sendLong(binding.externalChatId, "Voice transcription is unavailable on this server.")
      return
    }
    if (voice.duration > MAX_VOICE_DURATION_SECONDS) {
      await this.sendLong(binding.externalChatId, "Voice messages can be up to 10 minutes long.")
      return
    }

    let text: string
    try {
      const audio = await telegram.downloadFile(voice.file_id)
      text = (await transcriber.transcribeOggOpus(audio)).trim()
      if (!text) throw new Error("No speech was detected")
    } catch (cause) {
      await this.sendLong(binding.externalChatId, `Could not transcribe that voice message\n${errorMessage(cause)}`)
      return
    }

    const current = await this.options.store.findBySession(binding.sessionId)
    if (!current || current.externalUserId !== binding.externalUserId || current.externalChatId !== binding.externalChatId) {
      return
    }
    await this.sendChatText(current, text)
  }

  private async sendChatText(binding: ChatMobileBinding, text: string): Promise<boolean> {
    this.suppress(binding.sessionId, text)
    try {
      await this.options.chat.send(binding.sessionId, text)
      return true
    } catch (cause) {
      this.removeSuppression(binding.sessionId, text)
      await this.sendLong(binding.externalChatId, `Could not send that message\n${errorMessage(cause)}`)
      return false
    }
  }

  private async consumePairing(token: string, sender: TelegramUser, message: TelegramMessage): Promise<void> {
    const pairing = this.pairings.get(token)
    this.pairings.delete(token)
    if (!pairing || pairing.expiresAt <= this.now()) {
      await this.sendLong(message.chat.id.toString(), "That pairing link is invalid or expired. Run /connect again.")
      return
    }

    const detail = await this.options.chat.detail(pairing.sessionId)
    const binding: ChatMobileBinding = {
      sessionId: pairing.sessionId,
      channel: "telegram",
      externalUserId: sender.id.toString(),
      externalChatId: message.chat.id.toString(),
      displayName: telegramDisplayName(sender),
      connectedAt: this.now(),
    }
    const displaced = await Promise.all([
      this.options.store.findByExternalUser(binding.channel, binding.externalUserId),
      this.options.store.findBySession(binding.sessionId),
    ])
    for (const previous of uniqueBindings(displaced)) this.revokeBinding(previous)
    await this.options.store.connect(binding)
    await this.reconcileClients()
    await this.sendWelcome(binding, detail)
    for (const request of this.options.permissions.list()) {
      if (request.sessionId === binding.sessionId) await this.sendPermission(request)
    }
  }

  private async sendWelcome(binding: ChatMobileBinding, detail: ChatSessionDetail): Promise<void> {
    const recent = detail.messages
      .filter((message) => message.text.trim() && ["USER", "ASSISTANT", "APP_EVENT"].includes(message.role))
      .slice(-8)
      .map((message) => `${mobileRole(message)}: ${shorten(message.text, 600)}`)
    const transcript = recent.length > 0 ? `\n\nRecent conversation\n${recent.join("\n\n")}` : ""
    await this.sendLong(
      binding.externalChatId,
      `Connected to “${detail.session.title}”. Send a message here to continue.${transcript}`,
    )
  }

  private async handleCallback(callback: TelegramCallbackQuery): Promise<void> {
    const telegram = this.options.telegram
    const message = callback.message
    if (!telegram || !message || message.chat.type !== "private" || !callback.data) return

    const binding = await this.bindingFor(callback.from, message)
    if (!binding) {
      await this.answerCallback(callback.id, "This phone is not connected to that chat.", true)
      return
    }

    const parsed = parsePermissionCallback(callback.data)
    const request = parsed
      ? this.options.permissions.list().find((candidate) => candidate.id === parsed.requestId)
      : undefined
    if (!parsed || !request || request.sessionId !== binding.sessionId) {
      await this.answerCallback(callback.id, "This approval is no longer pending.", true)
      await this.removeKeyboard(message.chat.id.toString(), message.message_id)
      return
    }
    if (parsed.action === "session" && request.scope !== "SESSION") {
      await this.answerCallback(callback.id, "This tool only permits one-time approval.", true)
      return
    }

    const reply: ChatPermissionReply = parsed.action === "deny"
      ? { decision: "DENY" }
      : { decision: "ALLOW", scope: parsed.action === "session" ? "SESSION" : "ONCE" }
    try {
      await this.options.permissions.reply(request.id, reply, mobileClientId(binding))
      const label = parsed.action === "deny"
        ? "Denied"
        : parsed.action === "session" ? "Allowed for this connection" : "Allowed once"
      await this.answerCallback(callback.id, label)
      await this.removeKeyboard(message.chat.id.toString(), message.message_id)
    } catch (cause) {
      this.options.onError(cause)
      await this.answerCallback(callback.id, "Could not apply this decision.", true)
    }
  }

  private async sendPermission(request: ChatPermissionRequest): Promise<void> {
    const telegram = this.options.telegram
    if (!telegram || this.approvalMessages.has(request.id)) return
    const binding = await this.options.store.findBySession(request.sessionId)
    if (!binding) return

    const reason = request.reason ? `\nReason: ${request.reason}` : ""
    const sent = await telegram.sendMessage(
      binding.externalChatId,
      `Tool approval required\n\n${request.action}\nTool: ${request.toolName}${reason}`,
      { replyMarkup: permissionKeyboard(request), protectContent: true },
    )
    this.approvalMessages.set(request.id, {
      sessionId: request.sessionId,
      chatId: binding.externalChatId,
      messageId: sent.message_id,
    })
  }

  private async clearPermission(requestId: string): Promise<void> {
    const sent = this.approvalMessages.get(requestId)
    this.approvalMessages.delete(requestId)
    if (sent) await this.removeKeyboard(sent.chatId, sent.messageId)
  }

  private async removeKeyboard(chatId: string, messageId: number): Promise<void> {
    try {
      await this.options.telegram?.editMessageReplyMarkup(chatId, messageId)
    } catch (cause) {
      this.options.onError(cause)
    }
  }

  private async answerCallback(id: string, text: string, showAlert = false): Promise<void> {
    try {
      await this.options.telegram?.answerCallbackQuery(id, text, showAlert)
    } catch (cause) {
      this.options.onError(cause)
    }
  }

  private async deliver(sessionId: string, text: string): Promise<void> {
    const binding = await this.options.store.findBySession(sessionId)
    if (binding) await this.sendLong(binding.externalChatId, text)
  }

  private beginStream(sessionId: string, runId: string): Promise<void> {
    this.cancelStream(sessionId)
    const stream: StreamingMessage = {
      sessionId,
      runId,
      draftId: telegramDraftId(runId),
      chatId: null,
      text: "",
      tools: [],
      lastPreview: null,
      fallbackMessageId: null,
      nativeDraft: true,
      finalizing: false,
      cancelled: false,
      timer: null,
      typingTimer: null,
      inFlight: Promise.resolve(),
    }
    this.streamingMessages.set(sessionId, stream)
    return this.enqueueStream(stream, async () => {
      const binding = await this.options.store.findBySession(sessionId)
      if (stream.cancelled) return
      if (!binding) {
        this.streamingMessages.delete(sessionId)
        stream.cancelled = true
        return
      }
      stream.chatId = binding.externalChatId
      if (!stream.finalizing) await this.updateStream(stream)
    })
  }

  private scheduleStream(stream: StreamingMessage): void {
    if (stream.cancelled || stream.finalizing || stream.timer) return
    this.stopTypingTimer(stream)
    stream.timer = setTimeout(() => {
      stream.timer = null
      this.enqueueStream(stream, () => this.updateStream(stream))
    }, this.draftIntervalMs)
  }

  private async updateStream(stream: StreamingMessage): Promise<void> {
    if (stream.cancelled || stream.finalizing) return
    if (!stream.text.trim()) {
      await this.sendTyping(stream)
      return
    }
    this.stopTypingTimer(stream)
    const preview = telegramDraftPreview(stream.text)
    await this.sendStreamPreview(stream, preview)
  }

  private async sendTyping(stream: StreamingMessage): Promise<void> {
    const telegram = this.options.telegram
    const chatId = stream.chatId
    if (!telegram || !chatId || stream.cancelled || stream.finalizing || stream.text.trim()) return

    this.stopTypingTimer(stream)
    try {
      await telegram.sendChatAction(chatId, "typing")
    } finally {
      if (!stream.cancelled && !stream.finalizing && !stream.text.trim()) {
        stream.typingTimer = setTimeout(() => {
          stream.typingTimer = null
          this.enqueueStream(stream, () => this.updateStream(stream))
        }, TELEGRAM_TYPING_INTERVAL_MS)
      }
    }
  }

  private stopTypingTimer(stream: StreamingMessage): void {
    if (stream.typingTimer) clearTimeout(stream.typingTimer)
    stream.typingTimer = null
  }

  private async sendStreamPreview(stream: StreamingMessage, preview: string): Promise<void> {
    const telegram = this.options.telegram
    const chatId = stream.chatId
    if (!telegram || !chatId || stream.cancelled) return
    if (preview === stream.lastPreview) return

    if (stream.nativeDraft) {
      try {
        await telegram.sendMessageDraft(chatId, stream.draftId, preview)
        stream.lastPreview = preview
        return
      } catch (cause) {
        stream.nativeDraft = false
        this.options.onError(cause)
      }
    }

    // Without native drafts, one durable placeholder is edited in place until the
    // final response replaces it.
    if (!preview) return
    if (stream.fallbackMessageId === null) {
      const sent = await telegram.sendMessage(chatId, preview, { protectContent: true })
      stream.fallbackMessageId = sent.message_id
    } else {
      await telegram.editMessageText(chatId, stream.fallbackMessageId, preview)
    }
    stream.lastPreview = preview
  }

  private finalizeStream(sessionId: string, text: string, runId?: string): boolean {
    const stream = this.streamingMessages.get(sessionId)
    if (!stream || (runId !== undefined && stream.runId !== runId)) return false
    this.streamingMessages.delete(sessionId)
    stream.finalizing = true
    if (stream.timer) clearTimeout(stream.timer)
    stream.timer = null
    this.stopTypingTimer(stream)
    this.enqueueStream(stream, () => this.persistStream(stream, text))
    return true
  }

  private startStreamTool(stream: StreamingMessage, toolName: string): Promise<void> {
    stream.text = ""
    stream.lastPreview = null
    if (stream.timer) clearTimeout(stream.timer)
    stream.timer = null
    const activity: StreamingMessage["tools"][number] = { name: toolName, messageId: null }
    stream.tools.push(activity)
    return this.enqueueStream(stream, async () => {
      const telegram = this.options.telegram
      const chatId = stream.chatId
      if (!telegram || !chatId || stream.cancelled) return
      const sent = await telegram.sendMessage(chatId, `${TELEGRAM_TOOL_RUNNING_ICON} ${toolName}`, {
        protectContent: true,
      })
      activity.messageId = sent.message_id
      await this.updateStream(stream)
    })
  }

  private completeStreamTool(sessionId: string, toolName: string, failed: boolean): Promise<void> | void {
    const stream = this.streamingMessages.get(sessionId)
    if (!stream) return
    return this.enqueueStream(stream, async () => {
      const telegram = this.options.telegram
      const chatId = stream.chatId
      const activityIndex = stream.tools.findLastIndex((tool) => tool.name === toolName)
      const activity = activityIndex >= 0 ? stream.tools[activityIndex]! : null
      if (activityIndex >= 0) stream.tools.splice(activityIndex, 1)

      if (telegram && chatId && activity?.messageId != null) {
        try {
          if (failed) await telegram.editMessageText(chatId, activity.messageId, `✕ ${toolName}`)
          else await telegram.deleteMessage(chatId, activity.messageId)
        } catch (cause) {
          this.options.onError(cause)
        }
      } else if (failed && telegram && chatId) {
        try {
          await telegram.sendMessage(chatId, `✕ ${toolName}`, { protectContent: true })
        } catch (cause) {
          this.options.onError(cause)
        }
      }

      if (stream.cancelled || stream.finalizing) return
      stream.text = ""
      stream.lastPreview = null
      await this.updateStream(stream)
    })
  }

  private async persistStream(stream: StreamingMessage, text: string): Promise<void> {
    if (stream.cancelled) return
    const telegram = this.options.telegram
    const chatId = stream.chatId
    if (!telegram || !chatId) {
      await this.deliver(stream.sessionId, text)
      return
    }
    const chunks = telegramChunks(text)
    if (chunks.length === 0) return

    if (stream.fallbackMessageId !== null) {
      if (chunks[0] === stream.lastPreview) {
        for (const chunk of chunks.slice(1)) {
          await telegram.sendMessage(chatId, chunk, { protectContent: true })
        }
        return
      }
      try {
        await telegram.editMessageText(chatId, stream.fallbackMessageId, chunks[0]!)
        for (const chunk of chunks.slice(1)) {
          await telegram.sendMessage(chatId, chunk, { protectContent: true })
        }
        return
      } catch (cause) {
        this.options.onError(cause)
      }
    }

    for (const chunk of chunks) await telegram.sendMessage(chatId, chunk, { protectContent: true })
  }

  private cancelStream(sessionId: string, runId?: string): void {
    const stream = this.streamingMessages.get(sessionId)
    if (!stream || (runId !== undefined && stream.runId !== runId)) return
    this.streamingMessages.delete(sessionId)
    this.stopStream(stream)
  }

  private stopStream(stream: StreamingMessage): void {
    stream.cancelled = true
    if (stream.timer) clearTimeout(stream.timer)
    stream.timer = null
    this.stopTypingTimer(stream)
    const telegram = this.options.telegram
    if (telegram && stream.chatId) {
      for (const activity of stream.tools) {
        if (activity.messageId === null) continue
        this.runInBackground(telegram.deleteMessage(stream.chatId, activity.messageId))
      }
    }
    stream.tools.length = 0
  }

  private enqueueStream(stream: StreamingMessage, task: () => Promise<void>): Promise<void> {
    stream.inFlight = stream.inFlight.then(task).catch((cause: unknown) => {
      this.options.onError(cause)
    })
    return stream.inFlight
  }

  private async sendLong(chatId: string, text: string): Promise<void> {
    const telegram = this.options.telegram
    if (!telegram) return
    for (const chunk of telegramChunks(text)) await telegram.sendMessage(chatId, chunk, { protectContent: true })
  }

  private async bindingFor(sender: TelegramUser, message: TelegramMessage): Promise<ChatMobileBinding | null> {
    const binding = await this.options.store.findByExternalUser("telegram", sender.id.toString())
    return binding?.externalChatId === message.chat.id.toString() ? binding : null
  }

  private async reconcileClients(): Promise<void> {
    const bindings = await this.options.store.list()
    const connectedSessions = new Set(bindings.map((binding) => binding.sessionId))
    for (const sessionId of this.streamingMessages.keys()) {
      if (!connectedSessions.has(sessionId)) this.cancelStream(sessionId)
    }
    const next = new Set(bindings.map(mobileClientId))
    for (const clientId of this.attachedClients) {
      if (!next.has(clientId)) this.options.permissions.detachClient(clientId)
    }
    for (const clientId of next) {
      if (!this.attachedClients.has(clientId)) this.options.permissions.attachClient(clientId)
    }
    this.attachedClients.clear()
    for (const clientId of next) this.attachedClients.add(clientId)
  }

  private forgetApprovals(sessionId: string): void {
    for (const [requestId, sent] of this.approvalMessages) {
      if (sent.sessionId !== sessionId) continue
      this.approvalMessages.delete(requestId)
      this.runInBackground(this.removeKeyboard(sent.chatId, sent.messageId))
    }
  }

  private revokeBinding(binding: ChatMobileBinding): void {
    this.cancelStream(binding.sessionId)
    const clientId = mobileClientId(binding)
    if (this.attachedClients.delete(clientId)) this.options.permissions.detachClient(clientId)
    this.forgetApprovals(binding.sessionId)
  }

  private runInBackground(task: Promise<void>): void {
    void task.catch((cause: unknown) => this.options.onError(cause))
  }

  private sweepPairings(): void {
    const now = this.now()
    for (const [token, pairing] of this.pairings) {
      if (pairing.expiresAt <= now) this.pairings.delete(token)
    }
  }

  private suppress(sessionId: string, text: string): void {
    const pending = this.suppressedUserMessages.get(sessionId) ?? []
    pending.push(text)
    this.suppressedUserMessages.set(sessionId, pending)
  }

  private consumeSuppressed(sessionId: string, text: string): boolean {
    const pending = this.suppressedUserMessages.get(sessionId)
    const index = pending?.indexOf(text) ?? -1
    if (!pending || index < 0) return false
    pending.splice(index, 1)
    if (pending.length === 0) this.suppressedUserMessages.delete(sessionId)
    return true
  }

  private removeSuppression(sessionId: string, text: string): void {
    this.consumeSuppressed(sessionId, text)
  }
}

function publicConnection(binding: ChatMobileBinding): ChatMobileConnection {
  const { sessionId, channel, displayName, connectedAt } = binding
  return { sessionId, channel, displayName, connectedAt }
}

function mobileClientId(binding: ChatMobileBinding): string {
  return `mobile:${binding.channel}:${binding.externalUserId}`
}

function uniqueBindings(bindings: Array<ChatMobileBinding | null>): ChatMobileBinding[] {
  const unique = new Map<string, ChatMobileBinding>()
  for (const binding of bindings) {
    if (binding) unique.set(`${binding.channel}:${binding.externalUserId}`, binding)
  }
  return [...unique.values()]
}

function telegramDisplayName(user: TelegramUser): string {
  if (user.username) return `@${user.username}`
  return [user.first_name, user.last_name].filter(Boolean).join(" ")
}

function telegramDraftId(runId: string): number {
  let hash = 2_166_136_261
  for (const character of runId) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0) & 0x7fff_ffff || 1
}

function mobileRole(message: ChatMessage): string {
  if (message.role === "USER") return "You"
  if (message.role === "ASSISTANT") return "Assistant"
  return "Update"
}

function shorten(text: string, limit: number): string {
  const characters = [...text.trim()]
  return characters.length <= limit ? characters.join("") : `${characters.slice(0, limit - 1).join("")}…`
}

function telegramChunks(text: string): string[] {
  const characters = [...text.trim()]
  if (characters.length === 0) return []
  const chunks: string[] = []
  let chunk = ""
  for (const character of characters) {
    if (chunk.length + character.length > TELEGRAM_CHUNK_SIZE) {
      chunks.push(chunk)
      chunk = ""
    }
    chunk += character
  }
  if (chunk) chunks.push(chunk)
  return chunks
}

function telegramDraftPreview(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= TELEGRAM_CHUNK_SIZE) return trimmed
  const characters = [...trimmed]
  let tail = ""
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!
    if (tail.length + character.length >= TELEGRAM_CHUNK_SIZE) break
    tail = character + tail
  }
  return `…${tail}`.slice(0, TELEGRAM_MESSAGE_LIMIT)
}

function permissionKeyboard(request: ChatPermissionRequest): TelegramInlineKeyboard {
  const allow = [{ text: "Allow once", callback_data: `permission:o:${request.id}` }]
  if (request.scope === "SESSION") {
    allow.push({ text: "Allow for connection", callback_data: `permission:s:${request.id}` })
  }
  return {
    inline_keyboard: [
      allow,
      [{ text: "Deny", callback_data: `permission:d:${request.id}` }],
    ],
  }
}

function parsePermissionCallback(data: string): {
  action: "once" | "session" | "deny"
  requestId: string
} | null {
  const match = data.match(/^permission:([osd]):([0-9a-f-]{36})$/iu)
  if (!match) return null
  const action = match[1] === "o" ? "once" : match[1] === "s" ? "session" : "deny"
  return { action, requestId: match[2] ?? "" }
}

async function waitForRetry(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, POLL_RETRY_MS)
    signal.addEventListener("abort", done, { once: true })
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
  })
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError"
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

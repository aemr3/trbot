import { z, type ZodType } from "zod"

const TELEGRAM_API_URL = "https://api.telegram.org"

export const TelegramUserSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
})
export type TelegramUser = z.infer<typeof TelegramUserSchema>

export const TelegramChatSchema = z.object({
  id: z.number().int(),
  type: z.string(),
})
export type TelegramChat = z.infer<typeof TelegramChatSchema>

export const TelegramVoiceSchema = z.object({
  file_id: z.string(),
  file_unique_id: z.string(),
  duration: z.number().int().nonnegative(),
  mime_type: z.string().optional(),
  file_size: z.number().int().nonnegative().optional(),
})
export type TelegramVoice = z.infer<typeof TelegramVoiceSchema>

export const TelegramMessageSchema = z.object({
  message_id: z.number().int(),
  from: TelegramUserSchema.optional(),
  chat: TelegramChatSchema,
  text: z.string().optional(),
  voice: TelegramVoiceSchema.optional(),
})
export type TelegramMessage = z.infer<typeof TelegramMessageSchema>

export const TelegramCallbackQuerySchema = z.object({
  id: z.string(),
  from: TelegramUserSchema,
  message: TelegramMessageSchema.optional(),
  data: z.string().optional(),
})
export type TelegramCallbackQuery = z.infer<typeof TelegramCallbackQuerySchema>

export const TelegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: TelegramMessageSchema.optional(),
  callback_query: TelegramCallbackQuerySchema.optional(),
})
export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>

export interface TelegramInlineButton {
  text: string
  callback_data: string
}

export interface TelegramInlineKeyboard {
  inline_keyboard: TelegramInlineButton[][]
}

type TelegramRequestValue = string | number | boolean | undefined | string[] | TelegramInlineKeyboard
type TelegramRequestBody = Readonly<Record<string, TelegramRequestValue>>
type TelegramFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface TelegramBotApiAccess {
  getMe(signal?: AbortSignal): Promise<TelegramUser>
  getUpdates(offset: number, signal?: AbortSignal): Promise<TelegramUpdate[]>
  downloadFile(fileId: string, signal?: AbortSignal): Promise<Uint8Array>
  sendChatAction(chatId: string, action: "typing"): Promise<void>
  sendMessageDraft(chatId: string, draftId: number, text: string): Promise<void>
  sendMessage(
    chatId: string,
    text: string,
    options?: { replyMarkup?: TelegramInlineKeyboard; protectContent?: boolean },
  ): Promise<TelegramMessage>
  editMessageText(chatId: string, messageId: number, text: string): Promise<void>
  deleteMessage(chatId: string, messageId: number): Promise<void>
  editMessageReplyMarkup(chatId: string, messageId: number, replyMarkup?: TelegramInlineKeyboard): Promise<void>
  answerCallbackQuery(callbackQueryId: string, text?: string, showAlert?: boolean): Promise<void>
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly errorCode: number | null,
    readonly retryAfterMs: number | null,
  ) {
    super(message)
    this.name = "TelegramApiError"
  }
}

/** Small, strictly decoded transport for the Telegram Bot API methods trbot uses. */
export class TelegramBotApi implements TelegramBotApiAccess {
  private readonly fetch: TelegramFetch

  constructor(
    private readonly token: string,
    options: { fetch?: TelegramFetch } = {},
  ) {
    if (!token.trim()) throw new Error("Telegram bot token is required")
    this.fetch = options.fetch ?? fetch
  }

  getMe(signal?: AbortSignal): Promise<TelegramUser> {
    return this.call("getMe", {}, TelegramUserSchema, signal)
  }

  getUpdates(offset: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call("getUpdates", {
      offset,
      timeout: 30,
      allowed_updates: ["message", "callback_query"],
    }, z.array(TelegramUpdateSchema), signal)
  }

  async downloadFile(fileId: string, signal?: AbortSignal): Promise<Uint8Array> {
    const file = await this.call("getFile", { file_id: fileId }, TelegramFileSchema, signal)
    if (!file.file_path) throw new TelegramApiError("Telegram did not return a downloadable file path", null, null)

    let response: Response
    try {
      response = await this.fetch(`${TELEGRAM_API_URL}/file/bot${this.token}/${file.file_path}`, { signal })
    } catch (cause) {
      if (isAbortError(cause)) throw cause
      throw new TelegramApiError("Cannot reach Telegram while downloading a file", null, null)
    }
    if (!response.ok) {
      throw new TelegramApiError("Telegram file download failed", response.status, null)
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  async sendMessageDraft(chatId: string, draftId: number, text: string): Promise<void> {
    await this.call("sendMessageDraft", {
      // Live drafts accept only numeric private-chat ids, unlike sendMessage which
      // also accepts channel usernames.
      chat_id: Number(chatId),
      draft_id: draftId,
      text,
    }, z.literal(true))
  }

  async sendChatAction(chatId: string, action: "typing"): Promise<void> {
    await this.call("sendChatAction", {
      chat_id: chatId,
      action,
    }, z.literal(true))
  }

  sendMessage(
    chatId: string,
    text: string,
    options: { replyMarkup?: TelegramInlineKeyboard; protectContent?: boolean } = {},
  ): Promise<TelegramMessage> {
    const payload = {
      chat_id: chatId,
      text,
      protect_content: options.protectContent ?? true,
      reply_markup: options.replyMarkup,
    }
    return this.call("sendMessage", payload, TelegramMessageSchema)
  }

  async editMessageText(chatId: string, messageId: number, text: string): Promise<void> {
    await this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
    }, z.union([TelegramMessageSchema, z.literal(true)]))
  }

  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    await this.call("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    }, z.literal(true))
  }

  async editMessageReplyMarkup(
    chatId: string,
    messageId: number,
    replyMarkup?: TelegramInlineKeyboard,
  ): Promise<void> {
    await this.call("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup ?? { inline_keyboard: [] },
    }, z.union([TelegramMessageSchema, z.literal(true)]))
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false): Promise<void> {
    const payload = {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
    }
    await this.call("answerCallbackQuery", payload, z.literal(true))
  }

  private async call<T>(
    method: string,
    payload: TelegramRequestBody,
    schema: ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response
    try {
      response = await this.fetch(`${TELEGRAM_API_URL}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      })
    } catch (cause) {
      if (isAbortError(cause)) throw cause
      throw new TelegramApiError(`Cannot reach Telegram while calling ${method}`, null, null)
    }

    const body: unknown = await response.json().catch(() => null)
    const envelope = TelegramEnvelopeSchema.safeParse(body)
    if (!envelope.success) {
      throw new TelegramApiError(`Telegram returned an invalid response for ${method}`, null, null)
    }
    if (!response.ok || !envelope.data.ok) {
      const retryAfter = envelope.data.parameters?.retry_after
      throw new TelegramApiError(
        envelope.data.description || `Telegram rejected ${method}`,
        envelope.data.error_code ?? response.status,
        retryAfter === undefined ? null : retryAfter * 1_000,
      )
    }

    const parsed = schema.safeParse(envelope.data.result)
    if (!parsed.success) {
      throw new TelegramApiError(`Telegram returned an invalid result for ${method}`, null, null)
    }
    return parsed.data
  }
}

const TelegramEnvelopeSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
  error_code: z.number().int().optional(),
  parameters: z.object({ retry_after: z.number().int().nonnegative().optional() }).optional(),
})

const TelegramFileSchema = z.object({
  file_id: z.string(),
  file_unique_id: z.string(),
  file_size: z.number().int().nonnegative().optional(),
  file_path: z.string().optional(),
})

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError"
}

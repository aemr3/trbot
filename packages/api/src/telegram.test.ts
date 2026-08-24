import { expect, test } from "bun:test"
import { TelegramApiError, TelegramBotApi } from "./telegram.ts"

test("long polls only private messages and callback queries from the next offset", async () => {
  let request: Request | null = null
  const api = new TelegramBotApi("123:secret", {
    fetch: async (input, init) => {
      request = new Request(input, init)
      return Response.json({
        ok: true,
        result: [{
          update_id: 42,
          message: {
            message_id: 7,
            from: { id: 9, is_bot: false, first_name: "Ada" },
            chat: { id: 9, type: "private" },
            text: "hello",
            ignored_new_field: true,
          },
        }],
      })
    },
  })

  const updates = await api.getUpdates(42)

  expect(new URL(request!.url).pathname).toEndWith("/bot123:secret/getUpdates")
  expect(await request!.json()).toEqual({
    offset: 42,
    timeout: 30,
    allowed_updates: ["message", "callback_query"],
  })
  expect(updates[0]?.message?.text).toBe("hello")
})

test("publishes bot commands and selects Telegram's commands menu", async () => {
  const requests: Request[] = []
  const api = new TelegramBotApi("123:secret", {
    fetch: async (input, init) => {
      requests.push(new Request(input, init))
      return Response.json({ ok: true, result: true })
    },
  })

  await api.setMyCommands([
    { command: "balance", description: "Show account balance" },
    { command: "exitall", description: "Exit all open positions" },
  ])
  await api.setChatMenuButton({ type: "commands" })

  expect(new URL(requests[0]!.url).pathname).toEndWith("/setMyCommands")
  expect(await requests[0]!.json()).toEqual({
    commands: [
      { command: "balance", description: "Show account balance" },
      { command: "exitall", description: "Exit all open positions" },
    ],
  })
  expect(new URL(requests[1]!.url).pathname).toEndWith("/setChatMenuButton")
  expect(await requests[1]!.json()).toEqual({ menu_button: { type: "commands" } })
})

test("rejects invalid Telegram command definitions before sending them", async () => {
  let called = false
  const api = new TelegramBotApi("123:secret", {
    fetch: async () => {
      called = true
      return Response.json({ ok: true, result: true })
    },
  })

  await expect(api.setMyCommands([{ command: "Not-Valid", description: "Invalid" }])).rejects.toThrow()
  expect(called).toBe(false)
})

test("downloads a Telegram voice file after resolving its server path", async () => {
  const requests: Request[] = []
  const api = new TelegramBotApi("123:secret", {
    fetch: async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.url.endsWith("/getFile")) {
        return Response.json({
          ok: true,
          result: {
            file_id: "voice-file",
            file_unique_id: "voice-unique",
            file_path: "voice/file_1.oga",
          },
        })
      }
      return new Response(new Uint8Array([79, 103, 103, 83]))
    },
  })

  const audio = await api.downloadFile("voice-file")

  expect(await requests[0]!.json()).toEqual({ file_id: "voice-file" })
  expect(requests[1]!.method).toBe("GET")
  expect(new URL(requests[1]!.url).pathname).toBe("/file/bot123:secret/voice/file_1.oga")
  expect(audio).toEqual(new Uint8Array([79, 103, 103, 83]))
})

test("sends protected messages with configurable Telegram notifications", async () => {
  let requestBody = ""
  const api = new TelegramBotApi("123:secret", {
    fetch: async (_input, init) => {
      requestBody = String(init?.body)
      return Response.json({
        ok: true,
        result: { message_id: 11, chat: { id: 9, type: "private" }, text: "Approve" },
      })
    },
  })

  const sent = await api.sendMessage("9", "Approve", {
    replyMarkup: { inline_keyboard: [[{ text: "Allow", callback_data: "allow" }]] },
    disableNotification: true,
  })

  expect(sent.message_id).toBe(11)
  expect(JSON.parse(requestBody)).toEqual({
    chat_id: "9",
    text: "Approve",
    disable_notification: true,
    protect_content: true,
    reply_markup: { inline_keyboard: [[{ text: "Allow", callback_data: "allow" }]] },
  })

  await api.sendMessage("9", "Alert")
  expect(JSON.parse(requestBody).disable_notification).toBe(false)
})

test("streams native drafts with a stable draft id", async () => {
  let requestedMethod = ""
  let requestBody = ""
  const api = new TelegramBotApi("123:secret", {
    fetch: async (input, init) => {
      requestedMethod = new URL(String(input)).pathname.split("/").at(-1) ?? ""
      requestBody = String(init?.body)
      return Response.json({ ok: true, result: true })
    },
  })

  await api.sendMessageDraft("9", 42, "Partial answer")

  expect(requestedMethod).toBe("sendMessageDraft")
  expect(JSON.parse(requestBody)).toEqual({
    chat_id: 9,
    draft_id: 42,
    text: "Partial answer",
  })
})

test("shows Telegram's native typing indicator", async () => {
  let requestedMethod = ""
  let requestBody = ""
  const api = new TelegramBotApi("123:secret", {
    fetch: async (input, init) => {
      requestedMethod = new URL(String(input)).pathname.split("/").at(-1) ?? ""
      requestBody = String(init?.body)
      return Response.json({ ok: true, result: true })
    },
  })

  await api.sendChatAction("9", "typing")

  expect(requestedMethod).toBe("sendChatAction")
  expect(JSON.parse(requestBody)).toEqual({ chat_id: "9", action: "typing" })
})

test("edits a fallback streaming message", async () => {
  let requestBody = ""
  const api = new TelegramBotApi("123:secret", {
    fetch: async (_input, init) => {
      requestBody = String(init?.body)
      return Response.json({ ok: true, result: true })
    },
  })

  await api.editMessageText("9", 11, "Longer partial answer")

  expect(JSON.parse(requestBody)).toEqual({
    chat_id: "9",
    message_id: 11,
    text: "Longer partial answer",
  })
})

test("deletes a transient tool activity message", async () => {
  let requestedMethod = ""
  let requestBody = ""
  const api = new TelegramBotApi("123:secret", {
    fetch: async (input, init) => {
      requestedMethod = new URL(String(input)).pathname.split("/").at(-1) ?? ""
      requestBody = String(init?.body)
      return Response.json({ ok: true, result: true })
    },
  })

  await api.deleteMessage("9", 11)

  expect(requestedMethod).toBe("deleteMessage")
  expect(JSON.parse(requestBody)).toEqual({ chat_id: "9", message_id: 11 })
})

test("deletes a complete Telegram turn in one batch", async () => {
  let requestedMethod = ""
  let requestBody = ""
  const api = new TelegramBotApi("123:secret", {
    fetch: async (input, init) => {
      requestedMethod = new URL(String(input)).pathname.split("/").at(-1) ?? ""
      requestBody = String(init?.body)
      return Response.json({ ok: true, result: true })
    },
  })

  await api.deleteMessages("9", [10, 11])

  expect(requestedMethod).toBe("deleteMessages")
  expect(JSON.parse(requestBody)).toEqual({ chat_id: "9", message_ids: [10, 11] })
})

test("surfaces Telegram rate limits without leaking the bot token", async () => {
  const api = new TelegramBotApi("123:top-secret", {
    fetch: async () => Response.json({
      ok: false,
      error_code: 429,
      description: "Too Many Requests",
      parameters: { retry_after: 3 },
    }, { status: 429 }),
  })

  const error = await api.getMe().catch((cause: unknown) => cause)

  expect(error).toBeInstanceOf(TelegramApiError)
  expect(error).toMatchObject({ errorCode: 429, retryAfterMs: 3_000 })
  expect(String(error)).not.toContain("top-secret")
})

test("rejects a malformed successful result", async () => {
  const api = new TelegramBotApi("123:secret", {
    fetch: async () => Response.json({ ok: true, result: { id: "not-a-number" } }),
  })

  await expect(api.getMe()).rejects.toThrow("invalid result")
})

import { BrokerageDistributionRequestSchema } from "@trbot/market/brokerage.ts"
import { SettlementRequestSchema } from "@trbot/market/settlement.ts"
import { PriceAlertStatusRequestSchema } from "@trbot/market/alert.ts"
import {
  ChatMessageInputSchema,
  ChatTimelineQuerySchema,
  ChatUndoInputSchema,
  ChatUndoPreviewInputSchema,
} from "@trbot/chat/session.ts"
import { ChatQuestionReplySchema } from "@trbot/chat/question.ts"
import { ChatPermissionReplySchema } from "@trbot/chat/permission.ts"
import { CreateChatGoalSchema, CreateChatLoopSchema, UpdateChatGoalSchema } from "@trbot/chat/automation.ts"
import type { AppPreferences } from "@trbot/preferences/app.ts"
import { AiCredentialsSchema } from "@trbot/protocol/ai.ts"
import { ProtocolError } from "@trbot/protocol/error.ts"
import {
  CLIENT_INSTANCE_HEADER,
  ClientInstanceIdSchema,
  IDEMPOTENCY_HEADER,
  LoginRequestSchema,
  OtpRequestSchema,
  ROUTES,
  type SessionState,
} from "@trbot/protocol/routes.ts"
import {
  CancelPendingViopOrdersRequestSchema,
  ExitViopPositionRequestSchema,
  PlaceViopOrderRequestSchema,
  PrepareViopOrderRequestSchema,
} from "@trbot/trading/order.ts"
import { StopDecisionRequestSchema, StopRuleStatusRequestSchema } from "@trbot/trading/stop.ts"
import type { AiService } from "../ai.ts"
import type { ChatController } from "../chat.ts"
import type { ChatQuestionController } from "../chat-question.ts"
import type { ChatNotificationController } from "../chat-notification.ts"
import type { ChatAutomationController } from "../chat-automation.ts"
import type { ChatPermissionController } from "../chat-permission.ts"
import type { ChatMobileController } from "../chat-mobile.ts"
import type { AlertController } from "../monitors/alert.ts"
import type { MarketMonitorController } from "../monitors/market-monitor.ts"
import type { StopController } from "../monitors/stop.ts"
import { hashRequest, type IdempotencyStore, type IdempotentInput } from "./idempotency.ts"
import { AttemptLimiter, json, readJsonObject, readJsonObjectOrEmpty } from "./request.ts"
import type { ProviderSessionAccess } from "../session.ts"
import * as check from "./validate.ts"

interface AppPreferencesStore {
  get(): AppPreferences
  put(preferences: AppPreferences): void
}

export interface RouteContext {
  session: ProviderSessionAccess
  idempotency: IdempotencyStore
  preferences: AppPreferencesStore
  /** The controllers, not their stores: see the alert and stop routes below. */
  alerts: AlertController
  marketMonitors: MarketMonitorController
  stops: StopController
  ai: AiService
  chat: ChatController
  questions: ChatQuestionController
  permissions: ChatPermissionController
  mobile: ChatMobileController
  notifications: ChatNotificationController
  automations: ChatAutomationController
}

type Handler = (request: Request, context: RouteContext) => Promise<Response>

const loginLimiter = new AttemptLimiter()
// A verification code is short and numeric, so guessing it is far cheaper than
// guessing a password. It gets a tighter budget than the sign-in route.
const otpLimiter = new AttemptLimiter(5, 60_000)

/**
 * Runs a mutation at most once per idempotency key. The key is optional so a
 * caller can opt out, but every client sends one for order routes.
 */
async function once(
  request: Request,
  context: RouteContext,
  route: string,
  body: IdempotentInput,
  run: () => Promise<IdempotentInput>,
): Promise<Response> {
  const key = request.headers.get(IDEMPOTENCY_HEADER)
  if (!key) return json(await run())

  return json(await context.idempotency.run(key, route, hashRequest(body), run))
}

interface HandlerRegistry {
  [path: string]: Partial<Record<string, Handler>>
}

export const HANDLERS: HandlerRegistry = {
  [ROUTES.health]: {
    GET: async () => json({ ok: true }),
  },

  [ROUTES.session]: {
    GET: async (_request, { session }) => json<SessionState>({ authenticated: session.authenticated }),
  },

  [ROUTES.login]: {
    POST: async (request, { session }) => {
      const body = check.payload(await readJsonObject(request), LoginRequestSchema, "credentials")
      const { username, password } = body
      loginLimiter.check(username)
      try {
        await session.login(username, password)
        loginLimiter.clear(username)
      } catch (error) {
        loginLimiter.record(username)
        throw error
      }
      return json<SessionState>({ authenticated: true })
    },
  },

  [ROUTES.otp]: {
    POST: async (request, { session }) => {
      const body = check.payload(await readJsonObject(request), OtpRequestSchema, "verification")
      // One challenge is outstanding at a time, so the budget is the server's
      // rather than per caller: this counts guesses at the code itself.
      const key = "otp"
      otpLimiter.check(key)
      try {
        await session.completeOtp(body.code)
        otpLimiter.clear(key)
      } catch (error) {
        otpLimiter.record(key)
        throw error
      }
      return json<SessionState>({ authenticated: true })
    },
  },

  [ROUTES.instruments]: {
    GET: async (request, { session }) =>
      json(await session.require().instruments.listInstruments({ signal: request.signal })),
  },

  [ROUTES.news]: {
    GET: async (request, { session }) => {
      const instrumentUid = new URL(request.url).searchParams.get("instrumentUid") ?? undefined
      return json(await session.require().news.listNews({ instrumentUid, signal: request.signal }))
    },
  },

  [ROUTES.account]: {
    GET: async (request, { session }) => {
      const range = check.portfolioRange(new URL(request.url).searchParams.get("portfolioRange"))
      return json(await session.require().account.loadAccount({ portfolioRange: range, signal: request.signal }))
    },
  },

  [ROUTES.memberFeatures]: {
    // Sent as the enabled list: a feature set answers through a closure, which
    // does not survive JSON. The client rebuilds the set from this.
    GET: async (request, { session }) => {
      const features = await session.require().memberFeatures.loadFeatures({ signal: request.signal })
      return json(features.list())
    },
  },

  [ROUTES.pendingOrders]: {
    GET: async (request, { session }) =>
      json(await session.require().orders.listPendingOrders({ signal: request.signal })),
  },

  [ROUTES.brokerageDistribution]: {
    POST: async (request, { session }) => {
      const body = check.payload(
        await readJsonObject(request),
        BrokerageDistributionRequestSchema,
        "brokerage request",
      )
      return json(
        await session.require().brokerage.loadDistribution({
          ...body,
          signal: request.signal,
        }),
      )
    },
  },

  [ROUTES.settlement]: {
    POST: async (request, { session }) => {
      const body = check.payload(await readJsonObject(request), SettlementRequestSchema, "settlement request")
      return json(
        await session.require().settlement.loadSettlement({
          ...body,
          signal: request.signal,
        }),
      )
    },
  },

  [ROUTES.prepareOrder]: {
    POST: async (request, { session }) => {
      const body = check.payload(await readJsonObject(request), PrepareViopOrderRequestSchema, "order preparation")
      return json(
        await session.require().orders.prepareOrder({
          ...body,
          signal: request.signal,
        }),
      )
    },
  },

  [ROUTES.placeOrder]: {
    POST: async (request, context) => {
      const order = check.payload(await readJsonObject(request), PlaceViopOrderRequestSchema, "order")
      return once(request, context, ROUTES.placeOrder, order, () =>
        context.session.require().orders.placeOrder(order),
      )
    },
  },

  [ROUTES.cancelOrders]: {
    POST: async (request, context) => {
      const cancellation = check.payload(
        await readJsonObject(request),
        CancelPendingViopOrdersRequestSchema,
        "cancellation",
      )
      return once(request, context, ROUTES.cancelOrders, cancellation, () =>
        context.session.require().orders.cancelPendingOrders(cancellation),
      )
    },
  },

  [ROUTES.exitPositions]: {
    POST: async (request, context) =>
      once(request, context, ROUTES.exitPositions, {}, () =>
        context.session.require().orders.exitAllPositions({}),
      ),
  },

  [ROUTES.appPreferences]: {
    GET: async (_request, { preferences }) => json(preferences.get()),
    PUT: async (request, { preferences }) => {
      preferences.put(check.appPreferences(await readJsonObject(request)))
      return json(preferences.get())
    },
  },

  // Writes go through the controller, never straight to the store: the monitor
  // watches what it holds in memory, so a rule saved behind its back is a rule
  // that never fires and never reaches a client.
  [ROUTES.alerts]: {
    GET: async (_request, { alerts }) => json(alerts.list()),
    PUT: async (request, { alerts }) => json(await alerts.save(check.priceAlertDraft(await readJsonObject(request)))),
  },

  [ROUTES.marketMonitors]: {
    GET: async (request, { marketMonitors }) => {
      const chatSessionId = new URL(request.url).searchParams.get("chatSessionId")
      const monitors = marketMonitors.list()
      return json(chatSessionId ? monitors.filter((monitor) => monitor.chatSessionId === chatSessionId) : monitors)
    },
  },

  [ROUTES.aiProviders]: {
    GET: async (_request, { ai }) => json(await ai.providers()),
  },

  [ROUTES.aiModels]: {
    GET: async (_request, { ai }) => json(await ai.models()),
  },

  [ROUTES.aiPreferences]: {
    GET: async (_request, { ai }) => json(await ai.preferences()),
    PUT: async (request, { ai }) => json(await ai.setPreferences(check.aiPreferences(await readJsonObject(request)))),
  },

  [ROUTES.chatSessions]: {
    GET: async (_request, { chat }) => json(await chat.list()),
    /** A session can be started on a chosen model, or on the current default. */
    POST: async (request, { chat }) => {
      const body = await readJsonObjectOrEmpty(request)
      return json(await chat.create(body ? check.aiModelChoice(body) : undefined))
    },
  },

  [ROUTES.chatQuestions]: {
    GET: async (_request, { questions }) => json(questions.list()),
  },

  [ROUTES.chatPermissions]: {
    GET: async (_request, { permissions }) => json(permissions.list()),
  },

  [ROUTES.chatNotifications]: {
    GET: async (_request, { notifications }) => json(notifications.list()),
  },

  [ROUTES.stops]: {
    GET: async (_request, { stops }) => json(stops.list()),
    PUT: async (request, { stops }) => json(await stops.save(check.stopRuleDraft(await readJsonObject(request)))),
  },
}

/** Routes carrying a path parameter, matched after the exact table above. */
export const PARAMETERIZED: {
  pattern: RegExp
  method: string
  handle: (match: RegExpMatchArray, request: Request, context: RouteContext) => Promise<Response>
}[] = [
  {
    pattern: /^\/v1\/ai\/chat\/sessions\/([^/]+)\/mobile$/,
    method: "GET",
    handle: async (match, _request, { mobile }) =>
      json(await mobile.state(decodeURIComponent(match[1] ?? ""))),
  },
  {
    pattern: /^\/v1\/ai\/chat\/sessions\/([^/]+)\/mobile$/,
    method: "POST",
    handle: async (match, _request, { mobile }) =>
      json(await mobile.pair(decodeURIComponent(match[1] ?? ""))),
  },
  {
    pattern: /^\/v1\/ai\/chat\/sessions\/([^/]+)\/mobile$/,
    method: "DELETE",
    handle: async (match, _request, { mobile }) => {
      await mobile.disconnect(decodeURIComponent(match[1] ?? ""))
      return json({ ok: true })
    },
  },
  {
    pattern: /^\/v1\/ai\/chat\/sessions\/([^/]+)\/undo\/preview$/,
    method: "POST",
    handle: async (match, request, { chat }) => {
      const body = check.payload(await readJsonObject(request), ChatUndoPreviewInputSchema, "chat undo preview")
      return json(await chat.previewUndo(decodeURIComponent(match[1] ?? ""), body.messageId))
    },
  },
  {
    pattern: /^\/v1\/ai\/chat\/sessions\/([^/]+)\/undo$/,
    method: "POST",
    handle: async (match, request, { chat }) => {
      const body = check.payload(await readJsonObject(request), ChatUndoInputSchema, "chat undo")
      return json(await chat.undo(
        decodeURIComponent(match[1] ?? ""),
        body.messageId,
        body.revertEffects,
      ))
    },
  },
  {
    pattern: /^\/v1\/ai\/chat\/sessions\/([^/]+)\/compact$/,
    method: "POST",
    handle: async (match, _request, { chat }) =>
      json(await chat.compact(decodeURIComponent(match[1] ?? ""))),
  },
  {
    pattern: /^\/v1\/ai\/chat\/sessions\/([^/]+)\/automations$/,
    method: "GET",
    handle: async (match, _request, { automations }) =>
      json(await automations.state(decodeURIComponent(match[1] ?? ""))),
  },
  {
    pattern: /^\/v1\/ai\/chat\/sessions\/([^/]+)\/goal$/,
    method: "PUT",
    handle: async (match, request, { automations }) => {
      const body = check.payload(await readJsonObject(request), CreateChatGoalSchema, "goal")
      return json(await automations.createGoal(decodeURIComponent(match[1] ?? ""), body))
    },
  },
  {
    pattern: /^\/v1\/ai\/chat\/sessions\/([^/]+)\/goal$/,
    method: "PATCH",
    handle: async (match, request, { automations }) => {
      const body = check.payload(await readJsonObject(request), UpdateChatGoalSchema, "goal action")
      return json(await automations.updateGoal(decodeURIComponent(match[1] ?? ""), body))
    },
  },
  {
    pattern: /^\/v1\/ai\/chat\/sessions\/([^/]+)\/loops$/,
    method: "POST",
    handle: async (match, request, { automations }) => {
      const body = check.payload(await readJsonObject(request), CreateChatLoopSchema, "loop")
      return json(await automations.createLoop(decodeURIComponent(match[1] ?? ""), body))
    },
  },
  {
    pattern: /^\/v1\/ai\/chat\/sessions\/([^/]+)\/loops\/([^/]+)$/,
    method: "DELETE",
    handle: async (match, _request, { automations }) => {
      await automations.cancelLoop(
        decodeURIComponent(match[1] ?? ""),
        decodeURIComponent(match[2] ?? ""),
      )
      return json({ ok: true })
    },
  },
  {
    pattern: /^\/v1\/ai\/chat\/notifications\/([^/]+)$/,
    method: "DELETE",
    handle: async (match, _request, { notifications }) => {
      await notifications.dismiss(decodeURIComponent(match[1] ?? ""))
      return json({ ok: true })
    },
  },
  {
    pattern: /^\/v1\/ai\/chat\/permissions\/([^/]+)\/reply$/,
    method: "POST",
    handle: async (match, request, { permissions }) => {
      const body = check.payload(await readJsonObject(request), ChatPermissionReplySchema, "permission decision")
      const clientId = ClientInstanceIdSchema.safeParse(request.headers.get(CLIENT_INSTANCE_HEADER))
      await permissions.reply(decodeURIComponent(match[1] ?? ""), body, clientId.success ? clientId.data : null)
      return json({ ok: true })
    },
  },
  {
    pattern: /^\/v1\/ai\/chat\/questions\/([^/]+)\/reply$/,
    method: "POST",
    handle: async (match, request, { questions }) => {
      const body = check.payload(await readJsonObject(request), ChatQuestionReplySchema, "answers")
      await questions.reply(decodeURIComponent(match[1] ?? ""), body.answers)
      return json({ ok: true })
    },
  },
  {
    pattern: /^\/v1\/ai\/chat\/questions\/([^/]+)$/,
    method: "DELETE",
    handle: async (match, _request, { questions }) => {
      await questions.reject(decodeURIComponent(match[1] ?? ""))
      return json({ ok: true })
    },
  },
  {
    pattern: /^\/v1\/instruments\/([^/]+)\/contract$/,
    method: "GET",
    handle: async (match, request, { session }) => {
      const source = session.require().instruments
      if (!source.loadContractDetails) throw new ProtocolError("not_found", "Contract details are unavailable")
      return json(await source.loadContractDetails(decodeURIComponent(match[1] ?? ""), { signal: request.signal }))
    },
  },
  {
    pattern: /^\/v1\/instruments\/([^/]+)\/candles$/,
    method: "GET",
    handle: async (match, request, { session }) => {
      const params = new URL(request.url).searchParams
      const { range, interval } = check.candleSelection(params.get("range"), params.get("interval"))
      return json(
        await session.require().candles.loadCandles(decodeURIComponent(match[1] ?? ""), range, interval, {
          target: check.chartTarget(params.get("target")),
          signal: request.signal,
        }),
      )
    },
  },
  {
    pattern: /^\/v1\/news\/([^/]+)$/,
    method: "GET",
    handle: async (match, request, { session }) => {
      const article = await session
        .require()
        .news.getArticle(decodeURIComponent(match[1] ?? ""), { signal: request.signal })
      if (!article) throw new ProtocolError("not_found", "No such article")
      return json(article)
    },
  },
  {
    pattern: /^\/v1\/positions\/([^/]+)\/exit$/,
    method: "POST",
    handle: async (match, request, context) => {
      const instrumentUid = decodeURIComponent(match[1] ?? "")
      const body = check.payload(
        (await readJsonObjectOrEmpty(request)) ?? {},
        ExitViopPositionRequestSchema,
        "position exit",
      )
      const exit = { instrumentUid, ...body }
      return once(request, context, "positions.exit", exit, () =>
        context.session.require().orders.exitPosition(exit),
      )
    },
  },
  {
    pattern: /^\/v1\/alerts\/([^/]+)$/,
    method: "DELETE",
    handle: async (match, _request, { alerts }) => {
      await alerts.remove(decodeURIComponent(match[1] ?? ""))
      return json(alerts.list())
    },
  },
  {
    pattern: /^\/v1\/alerts\/([^/]+)\/status$/,
    method: "PUT",
    handle: async (match, request, { alerts }) => {
      const body = check.payload(await readJsonObject(request), PriceAlertStatusRequestSchema, "alert status")
      await alerts.setStatus(decodeURIComponent(match[1] ?? ""), body.status)
      return json(alerts.list())
    },
  },
  {
    pattern: /^\/v1\/ai\/market-monitors\/([^/]+)$/,
    method: "DELETE",
    handle: async (match, _request, { marketMonitors }) => {
      await marketMonitors.remove(decodeURIComponent(match[1] ?? ""))
      return json({ ok: true })
    },
  },
  {
    pattern: /^\/v1\/stops\/([^/]+)$/,
    method: "DELETE",
    handle: async (match, _request, { stops }) => {
      await stops.remove(decodeURIComponent(match[1] ?? ""))
      return json(stops.list())
    },
  },
  {
    pattern: /^\/v1\/stops\/([^/]+)\/status$/,
    method: "PUT",
    handle: async (match, request, { stops }) => {
      const body = check.payload(await readJsonObject(request), StopRuleStatusRequestSchema, "stop status")
      await stops.setStatus(decodeURIComponent(match[1] ?? ""), body.status)
      return json(stops.list())
    },
  },
  /**
   * One provider's connection.
   *
   * A login runs on the trader's machine — a provider only redirects an
   * authorization to a loopback address, and an API key is typed by hand — so its
   * result arrives here. This is the only route that accepts a secret, and it only
   * ever travels this way.
   */
  {
    pattern: /^\/v1\/ai\/providers\/([^/]+)$/,
    method: "POST",
    handle: async (match, request, { ai }) => {
      const providerId = decodeURIComponent(match[1] ?? "")
      const body = check.payload(await readJsonObject(request), AiCredentialsSchema, "credentials")
      if (body.providerId !== providerId) {
        throw new ProtocolError("invalid_request", '"providerId" must match the requested provider')
      }
      return json(
        await ai.connect({
          providerId,
          credential: body.credential,
        }),
      )
    },
  },
  {
    pattern: /^\/v1\/ai\/providers\/([^/]+)$/,
    method: "DELETE",
    handle: async (match, _request, { ai }) => {
      await ai.disconnect(decodeURIComponent(match[1] ?? ""))
      return json({ ok: true })
    },
  },
  {
    pattern: /^\/v1\/ai\/chat\/sessions\/([^/]+)\/children$/,
    method: "GET",
    handle: async (match, _request, { chat }) => json(await chat.children(decodeURIComponent(match[1] ?? ""))),
  },
  {
    pattern: /^\/v1\/ai\/chat\/sessions\/([^/]+)$/,
    method: "GET",
    handle: async (match, request, { chat }) => {
      const params = new URL(request.url).searchParams
      const query = check.payload(
        { limit: params.get("limit") ?? undefined },
        ChatTimelineQuerySchema,
        "chat timeline query",
      )
      return json(await chat.detail(decodeURIComponent(match[1] ?? ""), query.limit))
    },
  },
  /** Points a session at a different model, from its next turn onwards. */
  {
    pattern: /^\/v1\/ai\/chat\/sessions\/([^/]+)$/,
    method: "PATCH",
    handle: async (match, request, { chat }) => {
      const body = await readJsonObject(request)
      return json(await chat.configure(decodeURIComponent(match[1] ?? ""), check.aiModelChoice(body)))
    },
  },
  {
    pattern: /^\/v1\/ai\/chat\/sessions\/([^/]+)$/,
    method: "DELETE",
    handle: async (match, _request, { chat, questions, permissions, notifications, mobile }) => {
      await chat.remove(decodeURIComponent(match[1] ?? ""))
      await Promise.all([questions.sync(), permissions.sync(), notifications.sync(), mobile.sync()])
      return json({ ok: true })
    },
  },
  /**
   * Asking the model something.
   *
   * This never refuses for being busy: the message is queued and the server works
   * through the queue, so what comes back is the queued message rather than a reply.
   * The reply arrives on the socket, because the run belongs to the server and
   * outlives this request.
   */
  {
    pattern: /^\/v1\/ai\/chat\/sessions\/([^/]+)\/messages$/,
    method: "POST",
    handle: async (match, request, { chat }) => {
      const body = check.payload(await readJsonObject(request), ChatMessageInputSchema, "message")
      return json(await chat.send(decodeURIComponent(match[1] ?? ""), body.text))
    },
  },
  {
    pattern: /^\/v1\/ai\/chat\/sessions\/([^/]+)\/messages\/([^/]+)$/,
    method: "DELETE",
    handle: async (match, _request, { chat }) => {
      await chat.cancel(decodeURIComponent(match[1] ?? ""), decodeURIComponent(match[2] ?? ""))
      return json({ ok: true })
    },
  },
  {
    pattern: /^\/v1\/ai\/chat\/sessions\/([^/]+)\/abort$/,
    method: "POST",
    handle: async (match, _request, { chat }) => {
      await chat.abort(decodeURIComponent(match[1] ?? ""))
      return json({ ok: true })
    },
  },
  /**
   * Answering a fired stop, over HTTP rather than the socket.
   *
   * A decision needs an acknowledgement. Standing a stop down on a socket that
   * turns out to be disconnected tells the trader nothing was sent while the
   * server, still perfectly reachable, sends the exit when the countdown runs
   * out. The reply is what lets the terminal say what actually happened.
   */
  {
    pattern: /^\/v1\/stops\/([^/]+)\/decision$/,
    method: "POST",
    handle: async (match, request, { stops }) => {
      const body = check.payload(await readJsonObject(request), StopDecisionRequestSchema, "stop decision")
      stops.decide(decodeURIComponent(match[1] ?? ""), body.decision)
      return json({ ok: true })
    },
  },
]

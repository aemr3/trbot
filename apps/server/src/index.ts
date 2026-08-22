import { loadConfig, loadServerConfig } from "@trbot/config"
import { MarketFeed, type FeedEntitlements } from "@trbot/feed"
import type { CandleSource } from "@trbot/market/candle.ts"
import { requiresAuthentication } from "@trbot/protocol/error.ts"
import { openAuthSession } from "@trbot/db/auth-store.ts"
import { openDatabase } from "@trbot/db/client.ts"
import { DrizzlePriceAlertStore } from "@trbot/db/price-alert-store.ts"
import { DrizzleMarketMonitorStore } from "@trbot/db/market-monitor-store.ts"
import { DrizzleAiCredentialStore } from "@trbot/db/ai-credential-store.ts"
import { DrizzleAiPreferencesStore } from "@trbot/db/ai-preferences-store.ts"
import { DrizzleStopRuleStore } from "@trbot/db/stop-rule-store.ts"
import { DrizzleAppPreferencesStore } from "@trbot/db/app-preferences-store.ts"
import { createAgentTools } from "@trbot/ai/agent-tools.ts"
import { ChatAgent } from "@trbot/ai/chat.ts"
import { ChatCompactor } from "@trbot/ai/compaction.ts"
import { ChatTitleGenerator } from "@trbot/ai/title.ts"
import { ChatGoalEvaluator } from "@trbot/ai/goal-evaluator.ts"
import { HARNESS_VERSION, closeHarness, createHarness, harnessModel } from "@trbot/ai/harness.ts"
import { DrizzleChatSessionStore } from "@trbot/db/chat-store.ts"
import { DrizzleChatNotificationStore } from "@trbot/db/chat-notification-store.ts"
import { DrizzleChatAutomationStore } from "@trbot/db/chat-automation-store.ts"
import { DrizzleChatQuestionStore } from "@trbot/db/chat-question-store.ts"
import { DrizzleChatPermissionStore } from "@trbot/db/chat-permission-store.ts"
import { AiService } from "./ai.ts"
import { ChatController } from "./chat.ts"
import { ChatQuestionController } from "./chat-question.ts"
import { ChatNotificationController } from "./chat-notification.ts"
import { ChatAutomationController } from "./chat-automation.ts"
import { ChatPermissionController } from "./chat-permission.ts"
import { loadDefaultLoopPrompt } from "./chat-loop-prompt.ts"
import { marketMonitorApplicationEvent } from "./chat-market-monitor-event.ts"
import { certificateExpiry } from "./tls.ts"
import { AlertController } from "./monitors/alert.ts"
import { MarketMonitorController } from "./monitors/market-monitor.ts"
import { isDefiniteRefusal, toProtocolError } from "./errors.ts"
import { IdempotencyStore } from "./http/idempotency.ts"
import { startServer } from "./http/server.ts"
import { ProviderSession, providerConnector } from "./session.ts"
import { StopController } from "./monitors/stop.ts"
import { StreamHub } from "./stream-hub.ts"

/** How often positions are refreshed so the stop monitor sees what it protects. */
const POSITION_REFRESH_MS = 30_000

/** How long a burst of account frames is left to settle before the account is re-read. */
const POSITION_SETTLE_MS = 750

/** How often close-based rules re-read their candles, matching what the terminal did. */
const CANDLE_REFRESH_MS = 30_000

async function startTrbotServer(): Promise<void> {
  const config = loadConfig()
  const serverConfig = loadServerConfig()
  const connection = await openDatabase(config.databaseUrl)

  const log = (label: string, cause: unknown): void => {
    console.error(`[${label}]`, cause instanceof Error ? cause.message : cause)
  }

  const info = (label: string, message: string): void => {
    console.info(`[${label}]`, message)
  }

  // A stream that stops being accepted is the other way a dead session shows up,
  // and the one that matters with no client attached.
  const reportProviderError = (label: string, cause: unknown): void => {
    log(label, cause)
    if (requiresAuthentication(toProtocolError(cause))) void session.recover()
  }

  // The market data feed is a separate account from the brokerage and outlives
  // any brokerage sign-in, so it is built once here. It is also the only source
  // of prices, candles, books and broker readings, so a server without it could
  // not answer a chart — better to say so at startup than to fail one panel at a
  // time later.
  if (!config.feedCredentials) {
    throw new Error(
      "Market data requires FINTABLES_USERNAME and FINTABLES_PASSWORD; see .env.example",
    )
  }
  const feed = new MarketFeed({
    credentials: config.feedCredentials,
    onError: log,
    // The exchange licence is valid on one device at a time. Losing it is not an
    // error to retry: something else now holds it, and live prices have stopped
    // until it comes back.
    onLicenseTaken: () => {
      log("Market data feed", new Error("realtime licence claimed by another device; live prices have stopped"))
    },
  })

  // Stops, alerts and monitors decide on price, and this server acts on those
  // decisions unattended. Exchange prices arrive a quarter of an hour late without
  // the realtime licence, which would make every one of those decisions wrong
  // about the present, so the account has to say it holds one before any of it
  // runs. A login that cannot be reached at all is left to the feed's own retry:
  // the check refuses a definite "no", not an unanswered question.
  let entitlements: FeedEntitlements | null = null
  try {
    entitlements = await feed.session.loadEntitlements()
  } catch (cause) {
    // An unanswered question, not a "no". The feed retries on first use.
    log("Market data feed", cause)
  }
  if (entitlements && !entitlements.realtimePrices) {
    throw new Error(
      "The market data account has no realtime price entitlement (prices.realtime). Exchange prices "
      + "would arrive 15 minutes late and drive stops and alerts on stale prices. Check the subscription.",
    )
  }

  const session = new ProviderSession({
    openAuthSession: () => openAuthSession(config.databaseUrl),
    credentials: config.credentials,
    onError: reportProviderError,
    onInfo: info,
    connector: providerConnector(feed),
  })

  // Close-based rules and ATR levels are read from candles. The source is
  // resolved per call because a re-login replaces it.
  const candles: CandleSource = {
    loadCandles: (instrumentUid, range, interval, options) =>
      session.require().candles.loadCandles(instrumentUid, range, interval, options),
  }

  const preferences = new DrizzleAppPreferencesStore(connection.db)
  const alertStore = new DrizzlePriceAlertStore(connection.db)
  const marketMonitorStore = new DrizzleMarketMonitorStore(connection.db)
  const chatNotificationStore = new DrizzleChatNotificationStore(connection.db)
  const chatAutomationStore = new DrizzleChatAutomationStore(connection.db)
  const chatQuestionStore = new DrizzleChatQuestionStore(connection.db)
  const chatPermissionStore = new DrizzleChatPermissionStore(connection.db)
  const stopStore = new DrizzleStopRuleStore(connection.db)
  const idempotency = new IdempotencyStore(connection.db)
  await idempotency.sweep()

  // Model-provider credentials live here for the same reason the provider session
  // does: they are credentials, and a client must never hold one. One harness serves
  // the process, holding the catalogue of every provider it ships with and resolving
  // each credential against the store below, refreshing when a request needs it.
  const credentials = new DrizzleAiCredentialStore(connection.db)
  const aiPreferences = new DrizzleAiPreferencesStore(connection.db)
  const models = createHarness(credentials)
  const titles = new ChatTitleGenerator(models)
  const goalEvaluator = new ChatGoalEvaluator(models)

  const ai = new AiService({ models, credentials, preferences: aiPreferences })
  let hub: StreamHub | null = null
  let chat!: ChatController
  const questions = new ChatQuestionController({
    store: chatQuestionStore,
    broadcast: (frame) => hub?.broadcast(frame),
    onDetachedAnswer: async (request, answers) => {
      const formatted = request.questions.map((question, index) => (
        `"${question.question}"="${answers[index]?.join(", ") || "Unanswered"}"`
      )).join(", ")
      await chat.enqueueEvent(request.sessionId, {
        key: `question:${request.id}:answered`,
        text: `The user answered: ${formatted}.`,
        prompt: `The user answered the pending questions: ${formatted}. Continue from those answers.`,
        label: "ask_question",
        referenceId: request.id,
      })
    },
    onDetachedReject: async (request) => {
      await chat.enqueueEvent(request.sessionId, {
        key: `question:${request.id}:rejected`,
        text: "The user dismissed the pending questions.",
        prompt: "The user dismissed the pending questions. Continue without those answers.",
        label: "ask_question",
        referenceId: request.id,
      })
    },
  })
  const permissions = new ChatPermissionController({
    store: chatPermissionStore,
    broadcast: (frame) => hub?.broadcast(frame),
    onDetachedDecision: async (request, resolution) => {
      const allowed = resolution.decision === "ALLOW"
      const denialReason = resolution.reason ? ` Reason: ${resolution.reason}` : ""
      await chat.enqueueEvent(request.sessionId, {
        key: `permission:${request.id}:${resolution.decision.toLowerCase()}`,
        text: `${request.toolName} permission ${allowed ? "granted" : "denied"}.`,
        prompt: allowed
          ? [
            `The user granted permission for ${request.toolName}: ${request.action}.`,
            "The interrupted action was not executed. Refresh any data it depends on before deciding whether to call the tool again.",
          ].join(" ")
          : `The user denied permission for ${request.toolName}: ${request.action}.${denialReason} Continue without executing it.`,
        label: "tool_permission",
        referenceId: request.id,
      })
    },
  })
  const notifications = new ChatNotificationController({
    store: chatNotificationStore,
    broadcast: (frame) => hub?.broadcast(frame),
  })

  const stops = new StopController({
    store: stopStore,
    candles,
    exits: () => (session.authenticated ? session.require().orders : null),
    isDefiniteRefusal,
    onError: (error) => log("Stop monitor", error),
    broadcast: (event) => {
      if (event.type === "triggered") {
        hub?.broadcast({ type: "stopTriggered", event: event.event, remainingMs: event.remainingMs, held: event.held })
      } else if (event.type === "resolved") {
        hub?.broadcast({ type: "stopResolved", ruleId: event.ruleId, outcome: event.outcome })
      } else {
        hub?.broadcast({ type: "stops", views: stops.rules.views() })
        hub?.refresh()
      }
    },
  })

  const alerts = new AlertController({
    store: alertStore,
    candles,
    onError: (error) => log("Price alerts", error),
    broadcast: (event) => {
      if (event.type === "triggered") hub?.broadcast({ type: "alertTriggered", event: event.event })
      else {
        hub?.broadcast({ type: "alerts", views: alerts.alerts.views() })
        hub?.refresh()
      }
    },
  })

  const marketMonitors = new MarketMonitorController({
    store: marketMonitorStore,
    candles,
    // A newly watched contract must reach the upstream stream even with no TUI attached.
    onChange: () => hub?.refresh(),
    onError: (error) => log("Market monitors", error),
    onTrigger: async (event) => {
      const queued = marketMonitorApplicationEvent(event)
      if (queued) await chat.enqueueEvent(queued.sessionId, queued.event)
    },
  })

  // Chat runs belong to the server for the same reason the monitors do: a reply
  // has to survive the terminal that asked for it closing its tab or quitting.
  let automations!: ChatAutomationController
  const chatTools = createAgentTools({
    models,
    marketData: {
      sources: () => session.require(),
      stops: { list: async () => stops.list() },
    },
    marketMonitors: {
      instruments: {
        listInstruments: (options) => session.require().instruments.listInstruments(options),
      },
      candles,
      monitors: {
        list: async () => marketMonitors.list(),
        save: (draft) => marketMonitors.save(draft),
        setStatus: (id, status) => marketMonitors.setStatus(id, status),
        remove: (id) => marketMonitors.remove(id),
      },
    },
    questions,
    notifications,
    trading: {
      sources: () => session.require(),
      permissions,
    },
    stopRules: {
      sources: () => session.require(),
      rules: {
        list: async () => stops.list(),
        save: (draft) => stops.save(draft),
        setStatus: (id, status) => stops.setStatus(id, status),
        remove: (id) => stops.remove(id),
      },
      permissions,
    },
    automations: {
      state: (sessionId) => automations.state(sessionId),
      createGoal: (sessionId, input) => automations.createGoal(sessionId, input),
      finishGoal: (sessionId, status, reason) => automations.finishGoal(sessionId, status, reason),
      createLoop: (sessionId, input) => automations.createLoop(sessionId, input),
      rescheduleLoop: (sessionId, loopId, intervalMs) => automations.rescheduleLoop(sessionId, loopId, intervalMs),
      cancelLoop: (sessionId, loopId) => automations.cancelLoop(sessionId, loopId),
    },
    subagentSessions: {
      start: (input) => chat.subagentSessions.start(input),
    },
  })
  chat = new ChatController({
    store: new DrizzleChatSessionStore(connection.db, { harnessVersion: HARNESS_VERSION }),
    agent: new ChatAgent({ models, tools: chatTools }),
    compaction: new ChatCompactor({ models, tools: chatTools.list() }),
    // A session runs on the model it records, so these read the stored choice per
    // turn rather than closing over one from startup.
    defaultChoice: () => ai.chatDefault(),
    resolveModel: async (choice) => ({
      model: harnessModel(models, choice.providerId, choice.modelId),
      reasoningEffort: choice.reasoning,
    }),
    generateTitle: ({ message, model, signal }) => titles.generate({
      message,
      model: model.model,
      signal,
    }),
    requireModel: (choice) => ai.requireModel(choice?.providerId, choice?.modelId),
    onTurnSettled: (sessionId, event) => automations.onTurnSettled(sessionId, event),
    broadcast: (frame) => hub?.broadcast(frame),
    onError: (error) => log("Chat", error),
  })
  automations = new ChatAutomationController({
    store: chatAutomationStore,
    detail: (sessionId) => chat.detail(sessionId),
    enqueueEvent: async (sessionId, event) => {
      await chat.enqueueEvent(sessionId, event)
    },
    cancelQueuedEvents: async (sessionId, label, referenceId) => {
      const detail = await chat.detail(sessionId)
      for (const message of detail.messages) {
        if (
          message.role === "APP_EVENT" &&
          message.status === "QUEUED" &&
          message.toolName === label &&
          message.toolCallId === referenceId
        ) {
          try {
            await chat.cancel(sessionId, message.id)
          } catch (error) {
            // The queue may have started this event after the snapshot. Its turn may
            // finish, but the updated automation state prevents another one.
            log("Chat automation", error)
          }
        }
      }
    },
    resolveModel: async (detail) => {
      const { provider, model, reasoning } = detail.session
      if (!provider || !model) throw new Error("The goal's chat has no model")
      await ai.requireModel(provider, model)
      return { model: harnessModel(models, provider, model), reasoningEffort: reasoning }
    },
    evaluator: goalEvaluator,
    defaultLoopPrompt: loadDefaultLoopPrompt,
    notify: async (input) => {
      await notifications.notify({ ...input, urgency: "IMPORTANT" })
    },
    onError: (error) => log("Chat automation", error),
  })

  hub = new StreamHub(session, {
    onClientAttach: (clientId) => permissions.attachClient(clientId),
    onClientDetach: (clientId) => permissions.detachClient(clientId),
    extraQuoteSymbols: () => [...new Set([...stops.symbols(), ...alerts.symbols(), ...marketMonitors.symbols()])],
    onQuote: (update) => {
      stops.applyQuote(update)
      alerts.applyQuote(update)
      marketMonitors.applyQuote(update)
    },
    // A stop reads what is held to decide whether to fire and how much to exit,
    // so a position that closes elsewhere has to reach it now, not on the next
    // poll. The frame says a position moved but not to what, so this re-reads
    // the account rather than keeping a second copy of it in step.
    onAccount: (update) => {
      if (update.type === "position") schedulePositionRefresh()
    },
    // Which is only any use if the stream is running: it must not stop with the
    // last client, because that is when an unattended stop matters most.
    wantsAccount: () => stops.symbols().length > 0,
  })

  await stops.rules.load()
  await notifications.load()
  await questions.load()
  await permissions.load()
  await chat.start()
  await alerts.load()
  await marketMonitors.load()

  const resumed = await session.resume()
  await automations.start()
  console.log(resumed ? "Provider session resumed" : "No provider session; waiting for a client to sign in")

  // The stop monitor needs to know what is held. The timer is the floor, so an
  // unattended server still sees positions opened elsewhere; the account stream
  // closes the gap between its ticks.
  const refreshPositions = async (): Promise<void> => {
    if (!session.authenticated) return
    try {
      const snapshot = await session.require().account.loadAccount()
      stops.setPositions(snapshot.positions)
    } catch (error) {
      log("Position refresh", error)
    }
  }
  await refreshPositions()
  const positionTimer = setInterval(() => void refreshPositions(), POSITION_REFRESH_MS)

  // A fill arrives as a burst of frames, so the re-read is coalesced rather than
  // run per frame.
  let positionRefreshTimer: ReturnType<typeof setTimeout> | null = null
  function schedulePositionRefresh(): void {
    if (positionRefreshTimer) return
    positionRefreshTimer = setTimeout(() => {
      positionRefreshTimer = null
      void refreshPositions()
    }, POSITION_SETTLE_MS)
  }

  // A close-based rule has no ticks to fall back on, so its level only moves
  // when the candles are re-read. The terminal used to run this poll; with the
  // monitors here, the server must.
  const refreshCandles = (): void => {
    if (!session.authenticated) return
    void stops.rules.refreshCandleRules().catch((cause: unknown) => log("Stop candles", cause))
    void alerts.alerts.refreshCandleAlerts().catch((cause: unknown) => log("Alert candles", cause))
    void marketMonitors.refreshCandles().catch((cause: unknown) => log("Market monitor candles", cause))
  }
  refreshCandles()
  const candleTimer = setInterval(refreshCandles, CANDLE_REFRESH_MS)

  hub.refresh()

  const server = startServer(serverConfig, {
    session,
    idempotency,
    preferences,
    alerts,
    marketMonitors,
    stops,
    ai,
    chat,
    questions,
    permissions,
    notifications,
    automations,
    hub,
    backlog: () => [
      ...chat.backlog(),
      ...questions.backlog(),
      ...permissions.backlog(),
      ...notifications.backlog(),
      ...stops.outstanding().map((event) =>
        event.type === "triggered"
          ? { type: "stopTriggered", event: event.event, remainingMs: event.remainingMs, held: event.held }
          : event,
      ),
      ...alerts.outstanding().flatMap((event) =>
        event.type === "triggered" ? [{ type: "alertTriggered" as const, event: event.event }] : []),
      { type: "stops", views: stops.rules.views() },
      { type: "alerts", views: alerts.alerts.views() },
    ],
    onDecision: (frame) => {
      if (frame?.type === "alertDecision") alerts.decide(frame.alertId, frame.decision)
    },
  })

  const scheme = serverConfig.tls ? "https" : "http"
  console.log(`trbot server listening on ${scheme}://${serverConfig.host}:${server.port}`)
  await warnAboutCertificateExpiry(serverConfig.tls?.certPath)

  const shutdown = (): void => {
    clearInterval(positionTimer)
    clearInterval(candleTimer)
    if (positionRefreshTimer) clearTimeout(positionRefreshTimer)
    questions.destroy()
    permissions.destroy()
    chat.destroy()
    automations.destroy()
    closeHarness()
    feed?.close()
    stops.destroy()
    alerts.destroy()
    marketMonitors.destroy()
    session.close()
    void server.stop(true)
    connection.close()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

/**
 * A certificate that runs out takes the server down at connection time, in a
 * process nobody is watching. Startup is the one moment there is an operator
 * nearby, so it is where the notice belongs.
 */
async function warnAboutCertificateExpiry(certPath: string | undefined): Promise<void> {
  if (!certPath) return
  const expiry = await certificateExpiry(certPath)
  if (!expiry?.renewSoon) return
  const when = expiry.expired
    ? `expired ${-expiry.daysRemaining} day(s) ago`
    : `expires in ${expiry.daysRemaining} day(s)`
  console.warn(`[TLS] The server certificate ${when} (${expiry.notAfter.toISOString()}).`)
  console.warn("[TLS] Reissue it with `bun run server:cert <host>` and restart.")
}

if (import.meta.main) await startTrbotServer()

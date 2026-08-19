import { loadConfig, loadServerConfig } from "@trbot/config"
import type { CandleSource } from "@trbot/market/candle.ts"
import { requiresAuthentication } from "@trbot/protocol/error.ts"
import { openAuthSession } from "@trbot/db/auth-store.ts"
import { openDatabase } from "@trbot/db/client.ts"
import { DrizzleOverviewSnapshotStore } from "@trbot/db/overview-snapshot-store.ts"
import { DrizzlePriceAlertStore } from "@trbot/db/price-alert-store.ts"
import { DrizzleAiCredentialStore } from "@trbot/db/ai-credential-store.ts"
import { DrizzleAiPreferencesStore } from "@trbot/db/ai-preferences-store.ts"
import { DrizzleStopRuleStore } from "@trbot/db/stop-rule-store.ts"
import { DrizzleAppPreferencesStore } from "@trbot/db/app-preferences-store.ts"
import { ChatAgent } from "@trbot/ai/chat.ts"
import { HARNESS_VERSION, closeHarness, createHarness, harnessModel } from "@trbot/ai/harness.ts"
import { noTools } from "@trbot/ai/tool.ts"
import { DrizzleChatSessionStore } from "@trbot/db/chat-store.ts"
import { AiService } from "./ai.ts"
import { ChatController } from "./chat.ts"
import { certificateExpiry } from "./tls.ts"
import { AlertController } from "./monitors/alert.ts"
import { isDefiniteRefusal, toProtocolError } from "./errors.ts"
import { IdempotencyStore } from "./http/idempotency.ts"
import { startServer } from "./http/server.ts"
import { ProviderSession } from "./session.ts"
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

  const log = (label: string, error: unknown): void => {
    console.error(`[${label}]`, error instanceof Error ? error.message : error)
  }

  // A stream that stops being accepted is the other way a dead session shows up,
  // and the one that matters with no client attached.
  const reportProviderError = (label: string, error: unknown): void => {
    log(label, error)
    if (requiresAuthentication(toProtocolError(error))) void session.recover()
  }

  const session = new ProviderSession({
    openAuthSession: () => openAuthSession(config.databaseUrl),
    credentials: config.credentials,
    onError: reportProviderError,
  })

  // Close-based rules and ATR levels are read from candles. The source is
  // resolved per call because a re-login replaces it.
  const candles: CandleSource = {
    loadCandles: (instrumentUid, range, interval, options) =>
      session.require().candles.loadCandles(instrumentUid, range, interval, options),
  }

  const preferences = new DrizzleAppPreferencesStore(connection.db)
  const alertStore = new DrizzlePriceAlertStore(connection.db)
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

  const ai = new AiService({ models, credentials, preferences: aiPreferences })

  // Chat runs belong to the server for the same reason the monitors do: a reply
  // has to survive the terminal that asked for it closing its tab or quitting.
  const chat = new ChatController({
    store: new DrizzleChatSessionStore(connection.db, { harnessVersion: HARNESS_VERSION }),
    agent: new ChatAgent({ models, tools: noTools() }),
    // A session runs on the model it records, so these read the stored choice per
    // turn rather than closing over one from startup.
    defaultChoice: () => ai.chatDefault(),
    resolveModel: async (choice) => ({
      model: harnessModel(models, choice.providerId, choice.modelId),
      reasoningEffort: choice.reasoning,
    }),
    requireModel: (choice) => ai.requireModel("chat", choice?.providerId, choice?.modelId),
    broadcast: (frame) => hub?.broadcast(frame),
    onError: (error) => log("Chat", error),
  })

  let hub: StreamHub | null = null

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

  hub = new StreamHub(session, {
    extraQuoteSymbols: () => [...new Set([...stops.symbols(), ...alerts.symbols()])],
    onQuote: (update) => {
      stops.applyQuote(update)
      alerts.applyQuote(update)
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
  await alerts.alerts.load()
  await chat.start()

  const resumed = await session.resume()
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
    void stops.rules.refreshCandleRules().catch((error: unknown) => log("Stop candles", error))
    void alerts.alerts.refreshCandleAlerts().catch((error: unknown) => log("Alert candles", error))
  }
  refreshCandles()
  const candleTimer = setInterval(refreshCandles, CANDLE_REFRESH_MS)

  hub.refresh()

  const server = startServer(serverConfig, {
    session,
    idempotency,
    preferences,
    alerts,
    stops,
    overviewSnapshots: new DrizzleOverviewSnapshotStore(connection.db),
    ai,
    chat,
    hub,
    backlog: () => [
      ...chat.backlog(),
      ...stops.outstanding().map((event) =>
        event.type === "triggered"
          ? { type: "stopTriggered", event: event.event, remainingMs: event.remainingMs, held: event.held }
          : event,
      ),
      ...alerts.outstanding().map((event) => ({ type: "alertTriggered", event: (event as { event: unknown }).event })),
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
    chat.destroy()
    closeHarness()
    stops.destroy()
    alerts.destroy()
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

import {
  BoxRenderable,
  ScrollBoxRenderable,
  StyledText,
  TextRenderable,
  bold,
  fg,
  type KeyEvent,
  type RenderContext,
  type TextChunk,
} from "@opentui/core"
import type {
  ReinforcementBacktestProgress,
  ReinforcementBacktestResult,
  ReinforcementBacktestSource,
} from "../automation/reinforcement/backtest-runner.ts"
import type {
  AggregateEvaluation,
  ReinforcementExperimentArtifact,
  ReinforcementExperimentStore,
} from "../automation/reinforcement/experiment-store.ts"
import { WORKSPACE_CHROME_BACKGROUND } from "../components/workspace-chrome.ts"
import type { ViopInstrument } from "../market/instrument.ts"

const BACKGROUND = "#101010"
const MUTED_COLOR = "#888888"
const VALUE_COLOR = "#dddddd"
const EMPHASIS_COLOR = "#7c83ff"
const SUCCESS_COLOR = "#70d7a1"
const ERROR_COLOR = "#ff6b6b"
const WARNING_COLOR = "#e5c07b"

type BacktestPhase = "idle" | "running" | "completed" | "cancelled" | "error"

interface ReinforcementBacktestScreenOptions {
  source: ReinforcementBacktestSource
  experiments?: Pick<ReinforcementExperimentStore, "list" | "delete">
  instruments: ViopInstrument[] | (() => ViopInstrument[])
  onClose: () => void
  onOpenLogs?: () => void
  onError?: (error: unknown) => void
}

export class ReinforcementBacktestScreen {
  readonly root: BoxRenderable
  private readonly status: TextRenderable
  private readonly scroll: ScrollBoxRenderable
  private readonly content: TextRenderable
  private readonly footer: TextRenderable
  private request: AbortController | null = null
  private phase: BacktestPhase = "idle"
  private progress: ReinforcementBacktestProgress | null = null
  private result: ReinforcementBacktestResult | null = null
  private error: string | null = null
  private savedExperiments: ReinforcementExperimentArtifact[] = []
  private experimentsLoading = false
  private storeRequest = 0
  private deleteMode = false
  private deleteConfirmation = false
  private deleteSelection = 0
  private deleteBusy = false
  private dataNotice: string | null = null
  private destroyed = false

  constructor(private readonly renderer: RenderContext, private readonly options: ReinforcementBacktestScreenOptions) {
    this.root = new BoxRenderable(renderer, { width: "100%", height: "100%", backgroundColor: BACKGROUND, flexDirection: "column" })
    const body = new BoxRenderable(renderer, {
      width: "100%", flexGrow: 1, paddingLeft: 1, paddingRight: 1, backgroundColor: BACKGROUND, flexDirection: "column",
    })
    this.status = new TextRenderable(renderer, { content: "", width: "100%", marginBottom: 1 })
    this.scroll = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      width: "100%",
      scrollX: false,
      backgroundColor: BACKGROUND,
      contentOptions: { flexDirection: "column", paddingRight: 1, backgroundColor: BACKGROUND },
    })
    this.content = new TextRenderable(renderer, { content: "", width: "100%", wrapMode: "word" })
    this.footer = new TextRenderable(renderer, { content: "", fg: MUTED_COLOR, width: "100%" })
    const footer = new BoxRenderable(renderer, { width: "100%", height: 1, flexShrink: 0, backgroundColor: WORKSPACE_CHROME_BACKGROUND })
    this.scroll.add(this.content)
    footer.add(this.footer)
    body.add(this.status)
    body.add(this.scroll)
    this.root.add(body)
    this.root.add(footer)
    this.render()
  }

  mount(): void { void this.refreshExperiments() }

  handleKey(key: KeyEvent): boolean {
    if (this.deleteConfirmation) {
      if (isEscape(key)) this.deleteConfirmation = false
      else if (isEnter(key)) void this.deleteSelectedExperiment()
      this.render()
      return true
    }
    if (this.deleteMode) {
      if (isEscape(key)) this.deleteMode = false
      else if (key.name === "up" || key.name === "k") this.deleteSelection = Math.max(0, this.deleteSelection - 1)
      else if (key.name === "down" || key.name === "j") this.deleteSelection = Math.min(Math.max(0, this.savedExperiments.length - 1), this.deleteSelection + 1)
      else if (isEnter(key) && this.savedExperiments[this.deleteSelection]) this.deleteConfirmation = true
      this.render()
      return true
    }
    if (isEscape(key)) {
      if (this.request) {
        this.request.abort()
        this.request = null
        this.phase = "cancelled"
        this.render()
      }
      return true
    }
    if (this.phase !== "running" && !this.deleteBusy && this.options.experiments && isPlainKey(key, "x")) {
      if (this.savedExperiments.length > 0) this.deleteMode = true
      this.render()
      return true
    }
    if (isCapitalShortcut(key, "w")) { this.options.onClose(); return true }
    if (isCapitalShortcut(key, "g")) { this.options.onOpenLogs?.(); return true }
    if ((isEnter(key) || isPlainKey(key, "r")) && this.phase !== "running") { void this.run(); return true }
    this.scroll.handleKeyPress(key)
    return true
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.request?.abort()
    this.request = null
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private async run(): Promise<void> {
    if (this.request || this.destroyed) return
    const request = new AbortController()
    this.request = request
    this.phase = "running"
    this.progress = null
    this.result = null
    this.error = null
    this.dataNotice = null
    this.render()
    try {
      const instruments = typeof this.options.instruments === "function" ? this.options.instruments() : this.options.instruments
      if (instruments.length === 0) throw new Error("No VIOP instruments are available yet. Try again after the watchlist loads.")
      const result = await this.options.source.run(instruments, {
        signal: request.signal,
        onProgress: (progress) => {
          if (this.destroyed || request.signal.aborted || this.request !== request) return
          this.progress = progress
          this.render()
        },
      })
      if (this.destroyed || request.signal.aborted || this.request !== request) return
      this.result = result
      this.phase = "completed"
      this.scroll.stickyStart = "top"
      this.scroll.stickyScroll = true
      await this.refreshExperiments()
    } catch (error) {
      if (this.destroyed || request.signal.aborted || this.request !== request || isAbortError(error)) return
      this.phase = "error"
      this.error = errorMessage(error)
      this.options.onError?.(error)
    } finally {
      if (this.request === request) this.request = null
      this.render()
    }
  }

  private async refreshExperiments(): Promise<void> {
    if (!this.options.experiments || this.destroyed) return
    const request = ++this.storeRequest
    this.experimentsLoading = true
    this.render()
    try {
      const experiments = await this.options.experiments.list()
      if (this.destroyed || request !== this.storeRequest) return
      this.savedExperiments = experiments
      this.deleteSelection = Math.min(this.deleteSelection, Math.max(0, experiments.length - 1))
    } catch (error) {
      if (request !== this.storeRequest) return
      this.dataNotice = `Could not load saved experiments: ${errorMessage(error)}`
      this.options.onError?.(error)
    } finally {
      if (request === this.storeRequest) { this.experimentsLoading = false; this.render() }
    }
  }

  private async deleteSelectedExperiment(): Promise<void> {
    if (!this.options.experiments || this.deleteBusy) return
    const experiment = this.savedExperiments[this.deleteSelection]
    if (!experiment) return
    this.deleteConfirmation = false
    this.deleteBusy = true
    this.dataNotice = "Deleting experiment…"
    this.render()
    try {
      const deleted = await this.options.experiments.delete(experiment.id)
      this.deleteMode = false
      this.dataNotice = deleted
        ? experiment.policyId ? "Deleted experiment and its policy." : "Deleted experiment."
        : "The experiment no longer exists."
      if (this.result?.experiment.id === experiment.id) this.result = null
      await this.refreshExperiments()
    } catch (error) {
      this.dataNotice = `Delete failed: ${errorMessage(error)}`
      this.options.onError?.(error)
    } finally {
      this.deleteBusy = false
      this.render()
    }
  }

  private render(): void {
    this.status.height = statusHeight(this.phase, this.result)
    this.status.content = statusContent(this.phase, this.progress, this.result, this.error)
    this.content.content = bodyContent(this.phase, this.result?.experiment ?? this.savedExperiments[0] ?? null,
      this.savedExperiments, this.experimentsLoading, this.deleteMode, this.deleteConfirmation, this.deleteSelection, this.dataNotice)
    this.footer.content = footerText(this.phase, Boolean(this.options.experiments), this.savedExperiments.length > 0, this.deleteMode, this.deleteConfirmation)
    this.renderer.requestRender()
  }
}

function statusHeight(phase: BacktestPhase, result: ReinforcementBacktestResult | null): number {
  if (phase === "completed" && result) return result.experiment.test ? 11 : 7
  return phase === "running" || phase === "error" ? 3 : 2
}

function statusContent(phase: BacktestPhase, progress: ReinforcementBacktestProgress | null, result: ReinforcementBacktestResult | null, error: string | null): StyledText {
  const chunks: TextChunk[] = []
  if (phase === "idle") {
    chunks.push(bold(fg(VALUE_COLOR)("Ready to run")), fg(MUTED_COLOR)("\nPress Enter. Dates, walk-forward windows, configurations, and seeds are selected automatically."))
  } else if (phase === "running") {
    const completed = progress?.completed ?? 0
    const total = progress?.total ?? 0
    const filled = total > 0 ? Math.round(completed / total * 24) : 0
    chunks.push(fg(EMPHASIS_COLOR)(progressLabel(progress)), fg(VALUE_COLOR)("\n"), fg(EMPHASIS_COLOR)("█".repeat(filled)), fg("#333333")("░".repeat(24 - filled)), fg(VALUE_COLOR)(`  ${completed}/${total || "—"}`))
    if (progress && (progress.sessionDates > 0 || progress.instruments > 0)) chunks.push(fg(MUTED_COLOR)(`\nDataset  ${progress.sessionDates} dates · ${progress.instruments} contracts · ${progress.skippedInstruments} skipped`))
  } else if (phase === "completed" && result) {
    const experiment = result.experiment
    const verdictColor = experiment.verdict === "ACCEPTED" ? SUCCESS_COLOR : ERROR_COLOR
    const heading = result.cached
      ? `Saved experiment loaded · ${experiment.verdict.toLowerCase()}`
      : `Experiment ${experiment.verdict.toLowerCase()}`
    chunks.push(fg(verdictColor)(heading), fg(MUTED_COLOR)(`  ${experiment.manifest.version}`), fg(VALUE_COLOR)("\n"),
      ...metric("Eligible data", `${dateSpan(experiment.eligibleDates)} · ${experiment.eligibleDates.length} sessions`),
      ...metric("Walk-forward", `${experiment.windows.length} windows · ${experiment.manifest.seeds.length} seeds · ${experiment.candidates.length} configs`),
      ...metric("Selected", experiment.selectedCandidate),
      ...metric("Validation", aggregateLine(experiment.validation), experiment.validation.meanNetPnl >= 0 ? SUCCESS_COLOR : ERROR_COLOR),
      ...holdoutStatusMetrics(experiment),
    )
  } else if (phase === "cancelled") {
    chunks.push(fg(WARNING_COLOR)("Experiment stopped"), fg(MUTED_COLOR)("\nThe active run was cancelled."))
  } else {
    chunks.push(fg(ERROR_COLOR)("Experiment failed"), fg(VALUE_COLOR)(`\n${error ?? "Unknown error"}`), fg(MUTED_COLOR)("\nPress G for full error details."))
  }
  return new StyledText(chunks)
}

function bodyContent(
  phase: BacktestPhase,
  displayed: ReinforcementExperimentArtifact | null,
  saved: ReinforcementExperimentArtifact[],
  loading: boolean,
  deleteMode: boolean,
  deleteConfirmation: boolean,
  deleteSelection: number,
  notice: string | null,
): StyledText {
  const chunks: TextChunk[] = []
  if (notice) chunks.push(fg(notice.startsWith("Delete failed") || notice.startsWith("Could not") ? ERROR_COLOR : MUTED_COLOR)(`${notice}\n\n`))
  if (phase === "idle" && !displayed) {
    chunks.push(fg(MUTED_COLOR)("EXPERIMENT PROTOCOL\n"),
      ...metric("Universe", "All available VIOP equity futures"),
      ...metric("Sessions", "Automatic history ending at the latest completed market day"),
      ...metric("Selection", "Expanding walk-forward validation only"),
      ...metric("Final test", "Newest sessions held out until configuration selection is complete"),
      ...metric("Robustness", "Multiple fixed seeds · aggregate performance · deterministic manifest"),
      ...metric("Baselines", "Always flat/long/short · momentum · mean reversion"),
      ...metric("Learning", "Linear Q · low/medium/high execution-cost gates · 3 fixed seeds"),
      ...metric("Execution", "Next-open fills · 2 bps adverse slippage per side · collateral constrained"))
  } else if (displayed) {
    const selectedCandidate = displayed.manifest.candidates.find((candidate) => candidate.id === displayed.selectedCandidate)
    const selectedDiagnostics = displayed.candidates.find((candidate) => candidate.id === displayed.selectedCandidate)?.diagnostics
    chunks.push(fg(MUTED_COLOR)("EXPERIMENT DETAILS\n"),
      ...metric("Manifest", displayed.id.slice(0, 16)),
      ...metric("Created", formatTimestamp(displayed.createdAt)),
      ...metric("Universe", `${displayed.instruments} contracts · ${displayed.episodes} contract-days`),
      ...metric("Inertia", candidateSettings(selectedCandidate)),
      ...metric("Validation runs", `${displayed.validation.runs} · ${displayed.validation.profitableRuns} profitable`),
      ...(selectedDiagnostics ? metric("Validation churn", `${formatCount(selectedDiagnostics.meanTurnover)} changes · ${formatCount(selectedDiagnostics.meanTrades)} trades`) : []),
      ...metric("Test seeds", displayed.testRuns.length > 0 ? displayed.testRuns.map((run) => `${run.seed}: ${formatMoney(run.evaluation.netPnl)}`).join(" · ") : "Not run"),
      ...metric("Policy", policyStatus(displayed), displayed.policyId ? SUCCESS_COLOR : ERROR_COLOR))
    if (displayed.rejectionReasons.length > 0) {
      chunks.push(fg(MUTED_COLOR)("\nREJECTION REASONS\n"))
      for (const reason of displayed.rejectionReasons) chunks.push(fg(ERROR_COLOR)(`• ${reason}\n`))
    }
    if (displayed.validationBaselines.length > 0) {
      chunks.push(fg(MUTED_COLOR)("\nVALIDATION BASELINES\n"))
      for (const baseline of displayed.validationBaselines) chunks.push(...metric(baseline.label, aggregateLine(baseline.evaluation), baseline.evaluation.meanNetPnl >= 0 ? SUCCESS_COLOR : ERROR_COLOR))
    }
    if (displayed.candidates.some((candidate) => candidate.diagnostics)) {
      chunks.push(fg(MUTED_COLOR)("\nVALIDATION CANDIDATES\n"))
      for (const candidate of displayed.candidates) {
        const diagnostics = candidate.diagnostics
        if (!diagnostics) continue
        const selected = candidate.id === displayed.selectedCandidate ? "› " : "  "
        chunks.push(...metric(
          `${selected}${candidate.id}`,
          `${formatMoney(candidate.validation.meanNetPnl)} · gross ${formatMoney(diagnostics.meanGrossPnl)} · costs ${formatMoney(diagnostics.meanCosts)} · ${formatCount(diagnostics.meanTurnover)} changes`,
          candidate.validation.meanNetPnl >= 0 ? SUCCESS_COLOR : ERROR_COLOR,
        ))
      }
    }
    if (displayed.diagnostics) {
      const diagnostics = displayed.diagnostics
      const worst = diagnostics.byTicker.slice(0, 3)
      const best = diagnostics.byTicker.slice(-3).reverse()
      chunks.push(fg(MUTED_COLOR)("\nTEST DIAGNOSTICS · MEAN ACROSS SEEDS\n"),
        ...metric("Actions", `FLAT ${formatCount(diagnostics.meanActions.flat)} · LONG ${formatCount(diagnostics.meanActions.long)} · SHORT ${formatCount(diagnostics.meanActions.short)}`),
        ...metric("Turnover", `${formatCount(diagnostics.meanTurnover)} position changes · ${formatCount(diagnostics.meanTrades)} trades`),
        ...metric("Holding time", `${formatCount(diagnostics.meanHoldingMinutes)} minutes`),
        ...metric("Gross P&L", formatMoney(diagnostics.meanGrossPnl), diagnostics.meanGrossPnl >= 0 ? SUCCESS_COLOR : ERROR_COLOR),
        ...metric("Execution costs", formatMoney(diagnostics.meanCosts), diagnostics.meanCosts <= 0 ? SUCCESS_COLOR : WARNING_COLOR),
        ...metric("Net P&L", formatMoney(diagnostics.meanNetPnl), diagnostics.meanNetPnl >= 0 ? SUCCESS_COLOR : ERROR_COLOR),
        ...metric("Long / Short", `${formatMoney(diagnostics.meanLongPnl)} / ${formatMoney(diagnostics.meanShortPnl)}`),
        ...metric("Worst tickers", tickerLine(worst)),
        ...metric("Best tickers", tickerLine(best)))
    }
    if (displayed.baselines.length > 0) {
      chunks.push(fg(MUTED_COLOR)("\nHOLDOUT BASELINES\n"))
      for (const baseline of displayed.baselines) chunks.push(...metric(baseline.label, `${formatMoney(baseline.evaluation.netPnl)} · ${baseline.evaluation.trades} trades`, baseline.evaluation.netPnl >= 0 ? SUCCESS_COLOR : ERROR_COLOR))
    }
  }
  chunks.push(fg(VALUE_COLOR)("\n"), fg(MUTED_COLOR)("SAVED EXPERIMENTS\n"))
  if (loading) chunks.push(fg(MUTED_COLOR)("Loading saved experiments…"))
  else if (saved.length === 0) chunks.push(fg(MUTED_COLOR)("No experiments saved yet."))
  else saved.forEach((experiment, index) => {
    const selected = deleteMode && index === deleteSelection
    const verdict = experiment.verdict ?? "REJECTED"
    const testValue = experiment.test ? formatMoney(experiment.test.meanNetPnl) : "not tested"
    const testColor = experiment.test && experiment.test.meanNetPnl >= 0 ? SUCCESS_COLOR : experiment.test ? ERROR_COLOR : MUTED_COLOR
    chunks.push(fg(selected ? EMPHASIS_COLOR : MUTED_COLOR)(selected ? "› " : "  "), fg(selected ? VALUE_COLOR : MUTED_COLOR)(formatTimestamp(experiment.createdAt).padEnd(22)), fg(verdict === "ACCEPTED" ? SUCCESS_COLOR : ERROR_COLOR)(verdict.padEnd(10)), fg(MUTED_COLOR)(dateSpan(experiment.holdoutDates).padEnd(29)), fg(testColor)(testValue), fg(VALUE_COLOR)("\n"))
  })
  if (deleteConfirmation) {
    const selected = saved[deleteSelection]
    chunks.push(fg(ERROR_COLOR)(`\nDelete this experiment${selected?.policyId ? " and policy" : ""}? `), fg(VALUE_COLOR)("Enter confirm"), fg(MUTED_COLOR)(" · Esc cancel"))
  }
  else if (deleteMode) chunks.push(fg(MUTED_COLOR)("\n↑/↓ select · Enter delete · Esc cancel"))
  else if (saved.length > 0) chunks.push(fg(MUTED_COLOR)("X manage saved experiments"))
  return new StyledText(chunks)
}

function footerText(phase: BacktestPhase, hasStore: boolean, hasSaved: boolean, deleteMode: boolean, confirmation: boolean): string {
  if (confirmation) return "Enter delete · Esc cancel"
  if (deleteMode) return "↑/↓ select · Enter delete · Esc cancel"
  if (phase === "running") return "Esc stop · W watchlist · G logs · continues in background"
  return `${phase === "idle" ? "Enter run experiment" : "Enter or r run experiment"}${hasStore && hasSaved ? " · X saved experiments" : ""} · W watchlist · G logs · ↑/↓ scroll`
}

function progressLabel(progress: ReinforcementBacktestProgress | null): string {
  if (!progress) return "Preparing experiment…"
  if (progress.phase === "LOADING_HISTORY") return progress.currentSymbol ? `Loading history · ${progress.currentSymbol}` : "Loading historical candles…"
  if (progress.phase === "PREPARING_DATASET") return progress.currentSymbol ? `Building episodes · ${progress.currentSymbol}` : "Building point-in-time episodes…"
  const labels = {
    VALIDATING: "Running walk-forward validation…",
    TESTING: "Evaluating untouched holdout…",
    PERSISTING: "Saving reproducible experiment…",
  }
  return labels[progress.phase]
}

function metric(label: string, value: string, color = VALUE_COLOR): TextChunk[] { return [fg(MUTED_COLOR)(`${label.padEnd(18)} `), fg(color)(value), fg(VALUE_COLOR)("\n")] }
function aggregateLine(value: AggregateEvaluation): string { return `${formatMoney(value.meanNetPnl)} mean · ${formatMoney(value.medianNetPnl)} median · ${value.profitableRuns}/${value.runs} profitable` }
function holdoutStatusMetrics(experiment: ReinforcementExperimentArtifact): TextChunk[] {
  if (experiment.test) {
    const totalBalance = 20_000 + experiment.test.meanNetPnl
    return [
      ...metric("Holdout sessions", sessionDateList(experiment.holdoutDates)),
      ...metric("Test", aggregateLine(experiment.test), experiment.test.meanNetPnl >= 0 ? SUCCESS_COLOR : ERROR_COLOR),
      ...metric("Start balance", formatMoney(20_000)),
      ...metric("Mean end balance", formatMoney(totalBalance), totalBalance >= 20_000 ? SUCCESS_COLOR : ERROR_COLOR),
      ...metric("Worst drawdown", formatMoney(experiment.test.worstDrawdown)),
    ]
  }
  if (experiment.holdoutStatus === "AWAITING_UNSEEN_SESSIONS") {
    return [
      ...metric("Holdout", `${experiment.holdoutDates.length}/${experiment.manifest.protocol.holdoutSessions} unseen sessions reserved`),
      ...metric("Test", "Not run · waiting for unseen sessions", WARNING_COLOR),
    ]
  }
  return [
    ...metric("Holdout", "No new test data exposed"),
    ...metric("Test", "Not run · validation rejected", MUTED_COLOR),
  ]
}
function policyStatus(experiment: ReinforcementExperimentArtifact): string {
  if (experiment.policyId) return experiment.policyId.slice(0, 16)
  return experiment.holdoutStatus === "AWAITING_UNSEEN_SESSIONS"
    ? "Not saved · awaiting unseen test"
    : "Not saved · validation rejected"
}
function dateSpan(dates: string[]): string { const first = dates[0]; const last = dates.at(-1); if (!first || !last) return "None"; return first === last ? formatDate(first) : `${formatDate(first)} → ${formatDate(last)}` }
function sessionDateList(dates: string[]): string {
  if (dates.length === 0) return "None"
  const parsed = dates.map((value) => new Date(`${value}T12:00:00Z`))
  const monthYears = new Set(parsed.map((date) => `${date.getUTCFullYear()}-${date.getUTCMonth()}`))
  if (monthYears.size !== 1) return dates.map(formatDate).join(" · ")
  const suffix = parsed[0]!.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" })
  return `${parsed.map((date) => String(date.getUTCDate()).padStart(2, "0")).join(", ")} ${suffix}`
}
function formatDate(value: string): string { return new Date(`${value}T12:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }) }
function formatTimestamp(value: number): string { return new Date(value).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) }
function formatMoney(value: number): string { return value.toLocaleString("tr-TR", { style: "currency", currency: "TRY", minimumFractionDigits: 2 }) }
function formatCount(value: number): string { return value.toLocaleString("tr-TR", { maximumFractionDigits: 1 }) }
function candidateSettings(candidate: ReinforcementExperimentArtifact["manifest"]["candidates"][number] | undefined): string {
  if (!candidate) return "Legacy experiment"
  const margin = candidate.configuration.actionMargin ?? 0
  const costGate = candidate.configuration.executionCostMarginMultiplier ?? 0
  const costPenalty = candidate.trainingCostPenaltyMultiplier ?? 0
  const legacyPenalty = candidate.trainingTurnoverPenaltyBps ?? 0
  if (costGate > 0 || costPenalty > 0) {
    return `${formatCount(costGate)}× execution-cost gate · ${formatCount(costPenalty)}× training cost penalty`
  }
  return `Q margin ${margin.toFixed(5)} · training turnover ${formatCount(legacyPenalty)} bps`
}
function tickerLine(tickers: Array<{ symbol: string; meanNetPnl: number }>): string { return tickers.map((ticker) => `${ticker.symbol} ${formatMoney(ticker.meanNetPnl)}`).join(" · ") || "None" }
function isPlainKey(key: KeyEvent, name: string): boolean { return !key.ctrl && !key.meta && !key.option && key.name === name }
function isCapitalShortcut(key: KeyEvent, name: string): boolean { return !key.ctrl && !key.meta && !key.option && (key.sequence === name.toUpperCase() || (key.shift && key.name === name)) }
function isEnter(key: KeyEvent): boolean { return key.name === "return" || key.name === "enter" }
function isEscape(key: KeyEvent): boolean { return key.name === "escape" || key.name === "esc" }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function isAbortError(error: unknown): boolean { return error instanceof DOMException && error.name === "AbortError" }

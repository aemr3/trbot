import {
  BoxRenderable,
  ScrollBoxRenderable,
  StyledText,
  TextRenderable,
  fg,
  type KeyEvent,
  type RenderContext,
  type TextChunk,
} from "@opentui/core"
import { OVERVIEW_MODES, type OverviewMode, type OverviewSnapshot } from "../market/overview.ts"
import { RenderCoalescer } from "./render-coalescer.ts"

const PANEL_BG = "#161616"
const SELECTED_TAB_BG = "#282828"
const MUTED_COLOR = "#888888"
const VALUE_COLOR = "#dddddd"
const WARNING_COLOR = "#e5c07b"
const ERROR_COLOR = "#ff6b6b"
const FOCUSED_HEADER = "#ffffff"
const UNFOCUSED_HEADER = "#666666"

const MODE_LABELS: Record<OverviewMode, string> = { INTRADAY: "Intraday", DAILY: "Daily" }

type PanelState = "locked" | "disconnected" | "idle" | "collecting" | "streaming" | "ready" | "error"

export interface OverviewPanelOptions {
  onGenerate?: () => void
  onModeChange?: (mode: OverviewMode) => void
  onFocusRequest?: () => void
}

// The AI reading of the selected instrument. The panel shows only the model's
// commentary: every number behind it is already on the depth and broker panels,
// so the digest feeds the prompt without being painted twice.
export class OverviewPanel {
  readonly root: BoxRenderable

  private readonly header: TextRenderable
  private readonly progress: TextRenderable
  private readonly modeButtons = new Map<OverviewMode, BoxRenderable>()
  private readonly modeLabels = new Map<OverviewMode, TextRenderable>()
  private readonly scroll: ScrollBoxRenderable
  private readonly commentaryText: TextRenderable

  private mode: OverviewMode = "INTRADAY"
  private state: PanelState = "idle"
  private entitled: boolean | null = null
  private connected: boolean | null = null
  private commentary = ""
  // Replacement commentary while a review is already on screen; null when the
  // stream is going straight to `commentary` because there is nothing to keep.
  private pendingCommentary: string | null = null
  private message: string | null = null
  private focused = false
  // Token deltas arrive far faster than the terminal should repaint.
  private readonly liveRender = new RenderCoalescer(() => {
    if (!this.root.isDestroyed) this.render()
  })

  constructor(
    renderer: RenderContext,
    private readonly options: OverviewPanelOptions = {},
  ) {
    this.root = new BoxRenderable(renderer, {
      flexDirection: "column",
      border: ["top"],
      borderColor: "#303030",
      backgroundColor: PANEL_BG,
      onMouseDown: (event) => {
        if (event.button === 0) this.options.onFocusRequest?.()
      },
    })
    // One row carries the title and the two horizon tabs, so the commentary
    // keeps every remaining line.
    const headerRow = new BoxRenderable(renderer, {
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      gap: 1,
      marginBottom: 1,
    })
    this.header = new TextRenderable(renderer, {
      content: "AI Overview",
      fg: UNFOCUSED_HEADER,
      marginRight: 1,
      wrapMode: "none",
    })
    headerRow.add(this.header)
    for (const mode of OVERVIEW_MODES) {
      const button = new BoxRenderable(renderer, {
        height: 1,
        paddingLeft: 1,
        paddingRight: 1,
        onMouseDown: (event) => {
          if (event.button !== 0) return
          this.options.onFocusRequest?.()
          this.selectMode(mode)
        },
      })
      const label = new TextRenderable(renderer, { content: MODE_LABELS[mode], wrapMode: "none" })
      button.add(label)
      headerRow.add(button)
      this.modeButtons.set(mode, button)
      this.modeLabels.set(mode, label)
    }
    // Pushed to the far end of the row so a run in progress never crowds the tabs.
    headerRow.add(new BoxRenderable(renderer, { flexGrow: 1, height: 1 }))
    this.progress = new TextRenderable(renderer, {
      content: "",
      fg: MUTED_COLOR,
      wrapMode: "none",
      flexShrink: 0,
    })
    headerRow.add(this.progress)
    this.scroll = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      width: "100%",
      scrollX: false,
      // Streamed commentary should follow its tail unless the reader scrolls.
      stickyScroll: true,
      stickyStart: "bottom",
      // The horizontal bar would reserve a row even with scrollX off, leaving
      // the content permanently one row taller than the viewport.
      horizontalScrollbarOptions: { visible: false },
      backgroundColor: PANEL_BG,
      contentOptions: { flexDirection: "column", gap: 1, paddingRight: 2, backgroundColor: PANEL_BG },
    })
    this.commentaryText = new TextRenderable(renderer, {
      content: "",
      fg: VALUE_COLOR,
      width: "100%",
      wrapMode: "word",
    })
    this.scroll.add(this.commentaryText)
    this.root.add(headerRow)
    this.root.add(this.scroll)
    this.paintModeTabs()
    this.render()
  }

  get activeMode(): OverviewMode {
    return this.mode
  }

  // Null while the feature check is in flight; false locks the panel.
  setEntitled(entitled: boolean | null): void {
    if (this.entitled === entitled) return
    this.entitled = entitled
    this.render()
  }

  // Whether a ChatGPT account is connected; unknown states render as idle.
  setConnected(connected: boolean | null): void {
    if (this.connected === connected) return
    this.connected = connected
    if (this.state === "disconnected" && connected) this.state = "idle"
    if (connected === false && (this.state === "idle" || this.state === "collecting")) {
      this.state = "disconnected"
    }
    this.render()
  }

  reset(): void {
    this.state = this.connected === false ? "disconnected" : "idle"
    this.commentary = ""
    this.pendingCommentary = null
    this.message = null
    this.render()
  }

  setCollecting(): void {
    this.state = "collecting"
    this.message = null
    this.render()
  }

  // A fresh digest reached the model; its commentary streams in from here.
  startStreaming(): void {
    this.state = "streaming"
    // A review already on screen stays readable while its replacement streams
    // into the buffer, so regenerating never blanks the panel. The header
    // carries the progress instead.
    this.pendingCommentary = this.commentary ? "" : null
    if (this.pendingCommentary === null) this.commentary = ""
    this.message = null
    this.render()
  }

  appendCommentary(text: string): void {
    if (this.pendingCommentary !== null) {
      this.pendingCommentary += text
      return
    }
    this.commentary += text
    this.liveRender.schedule()
  }

  finishCommentary(): void {
    if (this.pendingCommentary !== null) {
      this.commentary = this.pendingCommentary
      this.pendingCommentary = null
    }
    this.state = "ready"
    this.render()
  }

  // A cached run for a revisited instrument, rendered in one shot.
  showSnapshot(snapshot: OverviewSnapshot): void {
    this.state = "ready"
    this.commentary = snapshot.commentary
    this.pendingCommentary = null
    this.message = null
    this.render()
  }

  showError(message: string): void {
    // A failed run keeps the last review; the notice goes above it.
    this.pendingCommentary = null
    if (isNotConnectedError(message)) {
      this.state = "disconnected"
    } else {
      this.state = "error"
      this.message = message
    }
    this.render()
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return
    this.focused = focused
    this.renderHeader()
    this.paintModeTabs()
  }

  handleKey(key: KeyEvent): boolean {
    if (key.name === "left" || key.name === "right" || key.name === "h" || key.name === "l") {
      this.selectMode(this.mode === "INTRADAY" ? "DAILY" : "INTRADAY")
      return true
    }
    if (key.name === "r" || key.name === "return") {
      this.options.onGenerate?.()
      return true
    }
    if (key.name === "up" || key.name === "k") {
      this.scroll.scrollBy({ x: 0, y: -1 })
      return true
    }
    if (key.name === "down" || key.name === "j") {
      this.scroll.scrollBy({ x: 0, y: 1 })
      return true
    }
    return false
  }

  destroy(): void {
    this.liveRender.cancel()
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private selectMode(mode: OverviewMode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.paintModeTabs()
    this.options.onModeChange?.(mode)
  }

  private paintModeTabs(): void {
    for (const mode of OVERVIEW_MODES) {
      const selected = this.mode === mode
      const button = this.modeButtons.get(mode)
      const label = this.modeLabels.get(mode)
      if (!button || !label) continue
      button.backgroundColor = selected ? SELECTED_TAB_BG : undefined
      label.fg = selected ? "#ffffff" : this.focused ? "#aaaaaa" : "#666666"
    }
  }

  private render(): void {
    this.renderHeader()
    this.commentaryText.content = new StyledText(this.commentaryChunks())
  }

  // While a run is in flight the header row carries its progress, because the
  // body is busy holding the previous review.
  private renderHeader(): void {
    this.header.fg = this.focused ? FOCUSED_HEADER : UNFOCUSED_HEADER
    this.progress.content = this.state === "collecting"
      ? "gathering…"
      : this.state === "streaming" && this.pendingCommentary !== null
        ? "writing…"
        : ""
  }

  private commentaryChunks(): TextChunk[] {
    if (this.entitled === null) return [fg(MUTED_COLOR)("Checking access…")]
    if (this.entitled === false) return [fg(WARNING_COLOR)("Broker data requires a subscription.")]
    switch (this.state) {
      case "locked":
        return []
      case "disconnected":
        return this.overCachedReview(fg(WARNING_COLOR)("Connect ChatGPT with A to generate overviews."))
      case "idle":
        return [fg(MUTED_COLOR)("Waiting for market data…")]
      case "collecting":
        return this.commentary ? [fg(VALUE_COLOR)(this.commentary)] : [fg(MUTED_COLOR)("Gathering broker data…")]
      case "error":
        return this.overCachedReview(fg(ERROR_COLOR)(this.message ?? "Overview failed."))
      default: {
        if (!this.commentary) return [fg(MUTED_COLOR)("Writing…")]
        // The cursor belongs to text still growing, not to a review being held.
        const streamingLive = this.state === "streaming" && this.pendingCommentary === null
        return [fg(VALUE_COLOR)(this.commentary), ...(streamingLive ? [fg(MUTED_COLOR)("▍")] : [])]
      }
    }
  }

  /** Puts a notice above the last review, so a failed run still shows it. */
  private overCachedReview(notice: TextChunk): TextChunk[] {
    return this.commentary ? [notice, fg(MUTED_COLOR)("\n\n"), fg(VALUE_COLOR)(this.commentary)] : [notice]
  }
}

function isNotConnectedError(message: string): boolean {
  return message.toLowerCase().includes("not connected")
}

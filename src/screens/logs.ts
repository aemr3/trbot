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
import { WORKSPACE_CHROME_BACKGROUND } from "../components/workspace-chrome.ts"
import type { ApplicationLog, LogEntry, LogLevel } from "../logging/application-log.ts"

const BACKGROUND = "#101010"
const TEXT_COLOR = "#dddddd"
const MUTED_COLOR = "#888888"
const LEVEL_COLORS: Record<LogLevel, string> = {
  INFO: "#70d7a1",
  WARN: "#e5c07b",
  ERROR: "#ff6b6b",
}

interface LogsScreenOptions {
  logs: ApplicationLog
  onClose: () => void
}

export class LogsScreen {
  readonly root: BoxRenderable

  private readonly title: TextRenderable
  private readonly content: TextRenderable
  private readonly scroll: ScrollBoxRenderable
  private readonly unsubscribe: () => void
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: LogsScreenOptions,
  ) {
    this.root = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      backgroundColor: BACKGROUND,
      flexDirection: "column",
    })
    const body = new BoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: BACKGROUND,
      flexDirection: "column",
    })
    this.title = new TextRenderable(renderer, { content: "", marginBottom: 1 })
    this.scroll = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      width: "100%",
      scrollX: false,
      backgroundColor: BACKGROUND,
      contentOptions: { flexDirection: "column", paddingRight: 1, backgroundColor: BACKGROUND },
    })
    this.content = new TextRenderable(renderer, { content: "", width: "100%", wrapMode: "word" })
    this.scroll.add(this.content)
    body.add(this.title)
    body.add(this.scroll)
    this.root.add(body)
    const footer = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexShrink: 0,
      backgroundColor: WORKSPACE_CHROME_BACKGROUND,
    })
    footer.add(new TextRenderable(renderer, {
      content: "W / Esc watchlist · ↑/↓ scroll · PgUp/PgDn · Home/End jump · c clear",
      fg: MUTED_COLOR,
      width: "100%",
    }))
    this.root.add(footer)
    this.unsubscribe = options.logs.subscribe(() => this.render())
    this.render()
  }

  handleKey(key: KeyEvent): boolean {
    if (this.destroyed) return true
    if (isCapitalShortcut(key, "g") || key.name === "escape" || key.name === "esc") {
      this.options.onClose()
      return true
    }
    if (!key.ctrl && !key.meta && !key.option && !key.shift && key.name === "c") {
      this.options.logs.clear()
      return true
    }
    this.scroll.handleKeyPress(key)
    return true
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.unsubscribe()
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private render(): void {
    if (this.destroyed) return
    const entries = this.options.logs.list()
    this.title.content = logTitle(entries.length)
    this.content.content = logContent(entries)
    this.renderer.requestRender()
  }
}

function logTitle(entryCount: number): StyledText {
  return new StyledText([
    bold(fg("#7c83ff")("APPLICATION LOGS")),
    fg(MUTED_COLOR)(`  ·  ${entryCount} entr${entryCount === 1 ? "y" : "ies"}`),
  ])
}

function logContent(entries: LogEntry[]): StyledText {
  if (entries.length === 0) return new StyledText([fg(MUTED_COLOR)("No logs yet.")])
  const chunks: TextChunk[] = []
  entries.forEach((entry, index) => {
    if (index > 0) chunks.push(fg(TEXT_COLOR)("\n\n"))
    const timestamp = new Date(entry.timestamp).toLocaleTimeString("tr-TR", { hour12: false })
    chunks.push(
      fg(MUTED_COLOR)(`${timestamp}  `),
      fg(LEVEL_COLORS[entry.level])(entry.level.padEnd(5)),
      fg("#7c83ff")(`  ${entry.scope}`),
      fg(TEXT_COLOR)(`\n${entry.message}`),
    )
    if (entry.details) chunks.push(fg(MUTED_COLOR)(`\n${entry.details}`))
  })
  return new StyledText(chunks)
}

function isCapitalShortcut(key: KeyEvent, name: string): boolean {
  return !key.ctrl && !key.meta && !key.option && (key.sequence === name.toUpperCase() || (key.shift && key.name === name))
}

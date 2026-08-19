import { BoxRenderable, TextRenderable, type KeyEvent, type RenderContext } from "@opentui/core"
import {
  WORKSPACE_ACTIVE_BACKGROUND,
  WORKSPACE_CHROME_BACKGROUND,
  WORKSPACE_CHROME_MUTED,
  WORKSPACE_CHROME_TEXT,
} from "../components/workspace-chrome.ts"

export type TradingWorkspaceTab = "trade" | "chat" | "logs"

interface WorkspacePanel {
  readonly root: BoxRenderable
  mount?(): void
  /** Restores any panel-local focus after its root is put back on screen. */
  activate?(): void
  /** Releases focused controls before the panel root is removed. */
  deactivate?(): void
  handleKey(key: KeyEvent): unknown
  /**
   * Whether this panel is taking typed text right now — a composer, a search, a
   * modal with a field in it.
   *
   * The workspace reads the tab shortcuts before the panel sees a key, so without
   * this a trader typing "Tomorrow" into the chat composer, or "L" into the ticker
   * search, would find the tab changing under them.
   */
  capturesInput?(): boolean
  destroy(): void
}

interface TradingWorkspaceScreenOptions {
  trade: WorkspacePanel
  chat: WorkspacePanel
  logs: WorkspacePanel
}

// Each tab answers to its own initial, so the shortcut is the label.
const TABS: { id: TradingWorkspaceTab; label: string; key: string }[] = [
  { id: "trade", label: "TRADE", key: "t" },
  { id: "chat", label: "CHAT", key: "c" },
  { id: "logs", label: "LOGS", key: "l" },
]

const BACKGROUND = "#101010"
const ACTIVE_COLOR = WORKSPACE_CHROME_TEXT
const INACTIVE_COLOR = WORKSPACE_CHROME_MUTED

export class TradingWorkspaceScreen {
  readonly root: BoxRenderable

  private readonly content: BoxRenderable
  private readonly status: TextRenderable
  private readonly tabBoxes = new Map<TradingWorkspaceTab, BoxRenderable>()
  private readonly tabLabels = new Map<TradingWorkspaceTab, TextRenderable>()
  private activeTab: TradingWorkspaceTab = "trade"
  private mounted = false
  private destroyed = false

  private readonly handleKeypress = (key: KeyEvent): void => {
    const panel = this.options[this.activeTab]
    // A panel that is taking text owns every letter: switching tabs mid-word is worse
    // than making the trader leave the field first. A control key is nobody's letter,
    // so the cycle holds whatever the panel is doing.
    const tab = cycleTab(key, this.activeTab) ?? (panel.capturesInput?.() ? null : tabShortcut(key))
    if (tab) {
      key.preventDefault()
      key.stopPropagation()
      this.selectTab(tab)
      return
    }
    panel.handleKey(key)
  }

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: TradingWorkspaceScreenOptions,
  ) {
    this.root = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: BACKGROUND,
    })
    const tabs = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      paddingLeft: 1,
      backgroundColor: WORKSPACE_CHROME_BACKGROUND,
    })
    for (const tab of TABS) {
      const box = new BoxRenderable(renderer, {
        height: 1,
        paddingLeft: 1,
        paddingRight: 1,
        marginRight: 1,
        onMouseDown: (event) => {
          if (event.button === 0) this.selectTab(tab.id)
        },
      })
      const label = new TextRenderable(renderer, { content: tab.label })
      box.add(label)
      tabs.add(box)
      this.tabBoxes.set(tab.id, box)
      this.tabLabels.set(tab.id, label)
    }
    tabs.add(new BoxRenderable(renderer, { flexGrow: 1, height: 1 }))
    this.status = new TextRenderable(renderer, {
      content: "",
      fg: INACTIVE_COLOR,
      marginRight: 1,
    })
    tabs.add(this.status)
    this.content = new BoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      flexDirection: "column",
      backgroundColor: BACKGROUND,
    })
    this.content.add(options.trade.root)
    this.root.add(tabs)
    this.root.add(this.content)
    this.renderTabs()
  }

  mount(): void {
    if (this.mounted || this.destroyed) return
    this.mounted = true
    this.renderer.keyInput.on("keypress", this.handleKeypress)
    // Every panel is mounted, not only the one on screen: a chat reply keeps
    // arriving while the trader is watching the market, and a log keeps filling.
    for (const tab of TABS) this.options[tab.id].mount?.()
    this.options[this.activeTab].activate?.()
  }

  selectTab(tab: TradingWorkspaceTab): void {
    if (this.destroyed || tab === this.activeTab) return
    const current = this.options[this.activeTab]
    current.deactivate?.()
    if (!this.content.isDestroyed && !current.root.isDestroyed) this.content.remove(current.root)
    this.activeTab = tab
    const next = this.options[tab]
    if (!this.content.isDestroyed && !next.root.isDestroyed) this.content.add(next.root)
    next.activate?.()
    this.renderTabs()
    this.renderer.requestRender()
  }

  setStatus(content: string, color = INACTIVE_COLOR): void {
    if (this.destroyed) return
    this.status.content = content
    this.status.fg = color
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.mounted) this.renderer.keyInput.off("keypress", this.handleKeypress)
    for (const tab of TABS) this.options[tab.id].destroy()
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private renderTabs(): void {
    for (const tab of TABS) {
      const active = tab.id === this.activeTab
      const box = this.tabBoxes.get(tab.id)
      const label = this.tabLabels.get(tab.id)
      if (box) box.backgroundColor = active ? WORKSPACE_ACTIVE_BACKGROUND : WORKSPACE_CHROME_BACKGROUND
      if (label) label.fg = active ? ACTIVE_COLOR : INACTIVE_COLOR
    }
  }
}

function tabShortcut(key: KeyEvent): TradingWorkspaceTab | null {
  if (key.ctrl || key.meta || key.option) return null
  const value = key.sequence || (key.shift ? key.name.toUpperCase() : key.name)
  const tab = TABS.find((candidate) => value === candidate.key.toUpperCase())
  return tab?.id ?? null
}

/**
 * Along the tabs on ^A, and back on ^⇧A.
 *
 * A control key rather than a letter, because a letter belongs to whatever is taking
 * text — and a letter rather than a digit, because Ctrl with a digit is a key only a
 * terminal speaking the kitty keyboard protocol reports at all. Reverse needs that same
 * protocol to be seen: without it Ctrl+Shift+A is the same byte as ^A and cycles
 * forward, which is the harmless way for it to fail. Taking ^A also takes it from the
 * chat composer, where it moved to the start of the line; Home still does that.
 */
function cycleTab(key: KeyEvent, active: TradingWorkspaceTab): TradingWorkspaceTab | null {
  if (!key.ctrl || key.meta || key.option || key.name !== "a") return null
  const position = TABS.findIndex((candidate) => candidate.id === active)
  const step = key.shift ? -1 : 1
  return TABS[(position + step + TABS.length) % TABS.length]!.id
}

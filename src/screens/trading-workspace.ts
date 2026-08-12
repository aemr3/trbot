import { BoxRenderable, TextRenderable, type KeyEvent, type RenderContext } from "@opentui/core"
import { WORKSPACE_ACTIVE_BACKGROUND, WORKSPACE_CHROME_BACKGROUND } from "../components/workspace-chrome.ts"

export type TradingWorkspaceTab = "watchlist" | "logs"

interface WorkspacePanel {
  readonly root: BoxRenderable
  mount?(): void
  handleKey(key: KeyEvent): unknown
  destroy(): void
}

interface TradingWorkspaceScreenOptions {
  watchlist: WorkspacePanel
  logs: WorkspacePanel
}

const TABS: { id: TradingWorkspaceTab; label: string }[] = [
  { id: "watchlist", label: "WATCHLIST" },
  { id: "logs", label: "LOGS" },
]

const BACKGROUND = "#101010"
const ACTIVE_COLOR = "#ffffff"
const INACTIVE_COLOR = "#777777"

export class TradingWorkspaceScreen {
  readonly root: BoxRenderable

  private readonly content: BoxRenderable
  private readonly status: TextRenderable
  private readonly tabBoxes = new Map<TradingWorkspaceTab, BoxRenderable>()
  private readonly tabLabels = new Map<TradingWorkspaceTab, TextRenderable>()
  private activeTab: TradingWorkspaceTab = "watchlist"
  private mounted = false
  private destroyed = false

  private readonly handleKeypress = (key: KeyEvent): void => {
    const tab = this.activeTab === "watchlist" ? null : tabShortcut(key)
    if (tab) {
      key.preventDefault()
      key.stopPropagation()
      this.selectTab(tab)
      return
    }
    this.options[this.activeTab].handleKey(key)
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
    this.content.add(options.watchlist.root)
    this.root.add(tabs)
    this.root.add(this.content)
    this.renderTabs()
  }

  mount(): void {
    if (this.mounted || this.destroyed) return
    this.mounted = true
    this.renderer.keyInput.on("keypress", this.handleKeypress)
    this.options.watchlist.mount?.()
    this.options.logs.mount?.()
  }

  selectTab(tab: TradingWorkspaceTab): void {
    if (this.destroyed || tab === this.activeTab) return
    const current = this.options[this.activeTab]
    if (!this.content.isDestroyed && !current.root.isDestroyed) this.content.remove(current.root)
    this.activeTab = tab
    const next = this.options[tab]
    if (!this.content.isDestroyed && !next.root.isDestroyed) this.content.add(next.root)
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
    this.options.watchlist.destroy()
    this.options.logs.destroy()
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
  if (value === "W") return "watchlist"
  if (value === "G") return "logs"
  return null
}

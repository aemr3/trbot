import { TUI_THEME } from "../theme.ts"
import { BoxRenderable, TextRenderable, type KeyEvent, type RenderContext } from "@opentui/core"
import type { ChatQuestionRequest } from "@trbot/chat/question.ts"
import type { ChatNotification } from "@trbot/chat/notification.ts"
import { NotificationCenter } from "../components/notification-center.ts"
import type { SoundPlayer } from "../components/sound.ts"
import {
  WORKSPACE_CHROME_MUTED,
  WORKSPACE_CHROME_TEXT,
  workspaceActiveBackground,
  workspaceChromeBackground,
} from "../components/workspace-chrome.ts"

export type TradingWorkspaceTab = "trade" | "chat" | "logs"

interface WorkspacePanel {
  readonly root: BoxRenderable
  mount?(): void
  /** Restores any panel-local focus after its root is put back on screen. */
  activate?(): void
  /** Releases focused controls before the panel root is removed. */
  deactivate?(): void
  handleKey(key: KeyEvent): boolean | void
  /**
   * Whether this panel is taking typed text right now — a composer, a search, a
   * modal with a field in it.
   *
   * The workspace reads the tab shortcuts before the panel sees a key, so without
   * this a trader typing "Tomorrow" into the chat composer, or "L" into the ticker
   * search, would find the tab changing under them.
   */
  capturesInput?(): boolean
  openQuestion?(sessionId: string): void
  openSession?(sessionId: string): void
  dismissNotification?(notificationId: string): void
  isShowingSession?(sessionId: string): boolean
  setMarketOpen?(open: boolean | null): void
  destroy(): void
}

interface TradingWorkspaceScreenOptions {
  trade: WorkspacePanel
  chat: WorkspacePanel
  logs: WorkspacePanel
  sound?: SoundPlayer
}

// Each tab answers to its own initial, so the shortcut is the label.
const TABS: { id: TradingWorkspaceTab; label: string; key: string }[] = [
  { id: "trade", label: "TRADE", key: "t" },
  { id: "chat", label: "CHAT", key: "c" },
  { id: "logs", label: "LOGS", key: "l" },
]

const BACKGROUND = TUI_THEME.appBackground
const ACTIVE_COLOR = WORKSPACE_CHROME_TEXT
const INACTIVE_COLOR = WORKSPACE_CHROME_MUTED

export class TradingWorkspaceScreen {
  readonly root: BoxRenderable

  private readonly content: BoxRenderable
  private readonly tabs: BoxRenderable
  private readonly status: TextRenderable
  private readonly tabBoxes = new Map<TradingWorkspaceTab, BoxRenderable>()
  private readonly tabLabels = new Map<TradingWorkspaceTab, TextRenderable>()
  private readonly notifications: NotificationCenter
  private readonly knownQuestionIds = new Set<string>()
  private readonly questions = new Map<string, ChatQuestionRequest>()
  private readonly dismissedQuestionIds = new Set<string>()
  private readonly agentNotifications = new Map<string, ChatNotification>()
  private activeTab: TradingWorkspaceTab = "trade"
  private marketOpen: boolean | null = null
  private mounted = false
  private destroyed = false

  private readonly handleKeypress = (key: KeyEvent): void => {
    if (this.notifications.count > 0) {
      key.preventDefault()
      key.stopPropagation()
      this.notifications.handleKey(key)
      return
    }
    const panel = this.options[this.activeTab]
    // Direct control shortcuts remain available while a field has focus. Plain tab
    // initials are only shortcuts when the active panel is not taking text.
    const tab = controlTabShortcut(key) ?? (panel.capturesInput?.() ? null : tabShortcut(key))
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
    this.tabs = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      paddingLeft: 1,
      backgroundColor: workspaceChromeBackground(this.marketOpen),
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
      this.tabs.add(box)
      this.tabBoxes.set(tab.id, box)
      this.tabLabels.set(tab.id, label)
    }
    this.tabs.add(new BoxRenderable(renderer, { flexGrow: 1, height: 1 }))
    this.status = new TextRenderable(renderer, {
      content: "",
      fg: INACTIVE_COLOR,
      marginRight: 1,
    })
    this.tabs.add(this.status)
    this.content = new BoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      flexDirection: "column",
      backgroundColor: BACKGROUND,
    })
    this.content.add(options.trade.root)
    this.root.add(this.tabs)
    this.root.add(this.content)
    this.notifications = new NotificationCenter(renderer)
    this.root.add(this.notifications.root)
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
    this.syncQuestionNotifications()
    this.renderer.requestRender()
  }

  setStatus(content: string, color = INACTIVE_COLOR): void {
    if (this.destroyed) return
    this.status.content = content
    this.status.fg = color
  }

  setMarketOpen(open: boolean | null): void {
    if (this.destroyed || this.marketOpen === open) return
    this.marketOpen = open
    this.tabs.backgroundColor = workspaceChromeBackground(open)
    for (const tab of TABS) this.options[tab.id].setMarketOpen?.(open)
    this.renderTabs()
    this.renderer.requestRender()
  }

  /** Announces a durable question without resolving or rejecting it. */
  notifyQuestion(request: ChatQuestionRequest): void {
    if (this.destroyed || this.knownQuestionIds.has(request.id)) return
    this.knownQuestionIds.add(request.id)
    this.questions.set(request.id, request)
    this.options.sound?.play("QUESTION")
    if (this.options[this.activeTab].isShowingSession?.(request.sessionId) === true) return

    this.showQuestionNotification(request)
  }

  syncQuestionNotifications(): void {
    if (this.destroyed) return
    for (const request of this.questions.values()) {
      const visible = this.options[this.activeTab].isShowingSession?.(request.sessionId) === true
      if (visible) this.notifications.remove(request.id)
      else if (!this.dismissedQuestionIds.has(request.id)) this.showQuestionNotification(request)
    }
  }

  private showQuestionNotification(request: ChatQuestionRequest): void {
    const first = request.questions[0]
    if (!first) return
    const more = request.questions.length > 1 ? `\n+${request.questions.length - 1} more question${request.questions.length === 2 ? "" : "s"}` : ""
    this.notifications.add({
      id: request.id,
      title: "Agent needs your answer",
      body: `${first.header}\n${first.question}${more}`,
      actions: [
        {
          label: "Open chat",
          onSelect: () => {
            this.selectTab("chat")
            this.options.chat.openQuestion?.(request.sessionId)
            this.syncQuestionNotifications()
          },
        },
        {
          label: "Stay here",
          onSelect: () => this.dismissedQuestionIds.add(request.id),
        },
      ],
      onDismiss: () => this.dismissedQuestionIds.add(request.id),
    })
  }

  resolveQuestion(requestId: string): void {
    this.knownQuestionIds.delete(requestId)
    this.questions.delete(requestId)
    this.dismissedQuestionIds.delete(requestId)
    this.notifications.remove(requestId)
  }

  notifyAgent(notification: ChatNotification): void {
    if (this.destroyed || this.agentNotifications.has(notification.id)) return
    this.agentNotifications.set(notification.id, notification)
    this.options.sound?.play("NOTIFICATION")
    this.notifications.add({
      id: notification.id,
      title: notification.urgency === "INFO"
        ? notification.title
        : `${notification.urgency} · ${notification.title}`,
      body: notification.message,
      actions: [
        {
          label: "Open chat",
          onSelect: () => {
            this.selectTab("chat")
            this.options.chat.openSession?.(notification.sessionId)
            this.dismissAgentNotification(notification.id)
          },
        },
        {
          label: "Dismiss",
          onSelect: () => this.dismissAgentNotification(notification.id),
        },
      ],
      onDismiss: () => this.dismissAgentNotification(notification.id),
    })
  }

  resolveAgentNotification(notificationId: string): void {
    this.agentNotifications.delete(notificationId)
    this.notifications.remove(notificationId)
  }

  private dismissAgentNotification(notificationId: string): void {
    if (!this.agentNotifications.delete(notificationId)) return
    this.notifications.remove(notificationId)
    this.options.chat.dismissNotification?.(notificationId)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.mounted) this.renderer.keyInput.off("keypress", this.handleKeypress)
    this.notifications.destroy()
    for (const tab of TABS) this.options[tab.id].destroy()
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private renderTabs(): void {
    for (const tab of TABS) {
      const active = tab.id === this.activeTab
      const box = this.tabBoxes.get(tab.id)
      const label = this.tabLabels.get(tab.id)
      if (box) {
        box.backgroundColor = active
          ? workspaceActiveBackground(this.marketOpen)
          : workspaceChromeBackground(this.marketOpen)
      }
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

/** Direct tab selection does not depend on terminals distinguishing Ctrl from Ctrl+Shift. */
function controlTabShortcut(key: KeyEvent): TradingWorkspaceTab | null {
  if (!key.ctrl || key.meta || key.option) return null
  if (key.name === "a") return "chat"
  if (key.name === "t") return "trade"
  if (key.name === "g") return "logs"
  return null
}

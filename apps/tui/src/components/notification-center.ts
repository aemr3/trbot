import { TUI_THEME } from "../theme.ts"
import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  fg,
  type KeyEvent,
  type RenderContext,
} from "@opentui/core"

const PANEL_BG = TUI_THEME.notificationBackground
const BORDER_COLOR = TUI_THEME.notificationBorder
const ACTIVE_BORDER_COLOR = TUI_THEME.activeBorder
const TEXT_COLOR = TUI_THEME.textPrimary
const MUTED_COLOR = TUI_THEME.textMuted
const ACTION_BG = TUI_THEME.notificationAction
const SELECTED_BG = TUI_THEME.notificationSelection
const CARD_HEIGHT = 8

export interface NotificationAction {
  label: string
  onSelect?: () => void
}

export interface AppNotification {
  id: string
  title: string
  body: string
  actions?: readonly NotificationAction[]
  onDismiss?: () => void
}

interface NotificationCard {
  notification: AppNotification
  root: BoxRenderable
  actionBoxes: BoxRenderable[]
  selectedAction: number
}

/** Stacks actionable notices over the workspace without owning their underlying state. */
export class NotificationCenter {
  readonly root: BoxRenderable

  private readonly stack: BoxRenderable
  private cards: NotificationCard[] = []
  private selected = 0
  private destroyed = false

  constructor(private readonly renderer: RenderContext) {
    this.root = new BoxRenderable(renderer, {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      alignItems: "flex-end",
      paddingTop: 1,
      paddingRight: 1,
      onSizeChange: () => this.resize(),
    })
    this.stack = new BoxRenderable(renderer, {
      width: 60,
      flexDirection: "column",
    })
    this.root.add(this.stack)
    this.root.visible = false
  }

  get count(): number {
    return this.cards.length
  }

  add(notification: AppNotification): boolean {
    if (this.destroyed || this.cards.some((card) => card.notification.id === notification.id)) return false
    const card = this.createCard(notification)
    this.cards.push(card)
    this.stack.add(card.root)
    this.selected = this.cards.length - 1
    this.root.visible = true
    this.paint()
    this.renderer.requestRender()
    return true
  }

  remove(id: string): void {
    const index = this.cards.findIndex((card) => card.notification.id === id)
    if (index < 0) return
    const [card] = this.cards.splice(index, 1)
    if (card && !this.stack.isDestroyed && !card.root.isDestroyed) this.stack.remove(card.root)
    card?.root.destroyRecursively()
    this.selected = Math.min(this.selected, Math.max(0, this.cards.length - 1))
    this.root.visible = this.cards.length > 0
    this.paint()
    this.renderer.requestRender()
  }

  handleKey(key: KeyEvent): boolean {
    if (this.destroyed || this.cards.length === 0) return false
    if (key.name === "escape" || key.name === "esc") {
      this.dismissSelected()
      return true
    }
    if (key.name === "up") {
      this.moveCard(-1)
      return true
    }
    if (key.name === "down") {
      this.moveCard(1)
      return true
    }
    if (key.name === "left") {
      this.moveAction(-1)
      return true
    }
    if (key.name === "right" || key.name === "tab") {
      this.moveAction(1)
      return true
    }
    if (key.name === "return" || key.name === "enter") {
      this.activateSelected()
      return true
    }
    return true
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.cards = []
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private createCard(notification: AppNotification): NotificationCard {
    const root = new BoxRenderable(this.renderer, {
      width: "100%",
      height: CARD_HEIGHT,
      flexShrink: 0,
      paddingLeft: 1,
      paddingRight: 1,
      marginBottom: 1,
      backgroundColor: PANEL_BG,
      border: true,
      borderStyle: "rounded",
      borderColor: BORDER_COLOR,
      flexDirection: "column",
      onMouseDown: (event) => {
        if (event.button !== 0) return
        event.stopPropagation()
        const index = this.cards.findIndex((card) => card.notification.id === notification.id)
        if (index >= 0) {
          this.selected = index
          this.paint()
          this.renderer.requestRender()
        }
      },
    })
    root.add(new TextRenderable(this.renderer, {
      content: new StyledText([
        fg(ACTIVE_BORDER_COLOR)(notification.title),
        fg(TEXT_COLOR)(`\n${notification.body}`),
      ]),
      width: "100%",
      flexGrow: 1,
      wrapMode: "word",
    }))

    const actionRow = new BoxRenderable(this.renderer, {
      width: "100%",
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
    })
    const actionBoxes: BoxRenderable[] = []
    for (const [index, action] of (notification.actions ?? []).entries()) {
      const box = new BoxRenderable(this.renderer, {
        height: 1,
        paddingLeft: 1,
        paddingRight: 1,
        marginRight: 1,
        backgroundColor: ACTION_BG,
        onMouseDown: (event) => {
          if (event.button !== 0) return
          event.stopPropagation()
          this.selected = this.cards.findIndex((card) => card.notification.id === notification.id)
          const card = this.cards[this.selected]
          if (card) card.selectedAction = index
          this.activateSelected()
        },
      })
      box.add(new TextRenderable(this.renderer, { content: action.label, fg: TEXT_COLOR, selectable: false }))
      actionRow.add(box)
      actionBoxes.push(box)
    }
    actionRow.add(new BoxRenderable(this.renderer, { flexGrow: 1, height: 1 }))
    actionRow.add(new TextRenderable(this.renderer, {
      content: notification.actions?.length ? "↑↓ notice · ←→ action · Esc dismiss" : "Esc dismiss",
      fg: MUTED_COLOR,
    }))
    root.add(actionRow)
    return { notification, root, actionBoxes, selectedAction: 0 }
  }

  private dismissSelected(): void {
    const card = this.cards[this.selected]
    if (!card) return
    this.remove(card.notification.id)
    card.notification.onDismiss?.()
  }

  private activateSelected(): void {
    const card = this.cards[this.selected]
    if (!card) return
    const action = card.notification.actions?.[card.selectedAction]
    if (!action) {
      this.dismissSelected()
      return
    }
    this.remove(card.notification.id)
    action.onSelect?.()
  }

  private moveCard(direction: -1 | 1): void {
    this.selected = (this.selected + direction + this.cards.length) % this.cards.length
    this.paint()
    this.renderer.requestRender()
  }

  private moveAction(direction: -1 | 1): void {
    const card = this.cards[this.selected]
    const count = card?.actionBoxes.length ?? 0
    if (!card || count < 2) return
    card.selectedAction = (card.selectedAction + direction + count) % count
    this.paint()
    this.renderer.requestRender()
  }

  private paint(): void {
    this.cards.forEach((card, cardIndex) => {
      const active = cardIndex === this.selected
      card.root.borderColor = active ? ACTIVE_BORDER_COLOR : BORDER_COLOR
      card.actionBoxes.forEach((box, actionIndex) => {
        box.backgroundColor = active && actionIndex === card.selectedAction ? SELECTED_BG : ACTION_BG
      })
    })
  }

  private resize(): void {
    this.stack.width = Math.max(38, Math.min(60, this.root.width - 2))
  }
}

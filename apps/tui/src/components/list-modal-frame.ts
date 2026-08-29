import { TUI_THEME } from "../theme.ts"
import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  TextRenderable,
  type KeyEvent,
  type RenderContext,
  type Renderable,
} from "@opentui/core"
import { SelectableList } from "./selectable-list.ts"

interface ListModalFrameOptions {
  maxWidth: number
  maxHeight: number
  minWidth: number
  minHeight: number
  search?: {
    placeholder: string
    onInput: () => void
  }
  wrapContent?: boolean
  onSelect: (index: number) => void
  onActivate: () => void
}

/** Shared OpenTUI frame for keyboard-navigable modal lists, with optional search. */
export class ListModalFrame {
  readonly root: BoxRenderable
  readonly header: TextRenderable
  readonly list: SelectableList
  readonly footer: TextRenderable

  private previousFocus: Renderable | null = null
  private readonly modal: BoxRenderable
  private readonly search: InputRenderable | null
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: ListModalFrameOptions,
  ) {
    this.root = new BoxRenderable(renderer, {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
      onSizeChange: () => this.resize(),
    })
    this.modal = new BoxRenderable(renderer, {
      width: options.maxWidth,
      height: options.maxHeight,
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      paddingRight: 2,
      backgroundColor: TUI_THEME.appBackground,
      border: true,
      borderStyle: "rounded",
      borderColor: TUI_THEME.textFaint,
      flexDirection: "column",
    })
    this.header = new TextRenderable(renderer, { content: "", width: "100%", wrapMode: "word" })
    const search = options.search
    if (search) {
      this.search = new InputRenderable(renderer, {
        width: "100%",
        flexShrink: 0,
        marginBottom: 1,
        maxLength: 100,
        placeholder: search.placeholder,
        backgroundColor: TUI_THEME.fieldBackground,
        focusedBackgroundColor: TUI_THEME.fieldBackground,
        textColor: TUI_THEME.textPrimary,
        focusedTextColor: TUI_THEME.textPrimary,
        cursorColor: TUI_THEME.accent,
      })
      this.search.on(InputRenderableEvents.INPUT, search.onInput)
    } else {
      this.search = null
    }
    this.list = new SelectableList(renderer, {
      backgroundColor: TUI_THEME.appBackground,
      selectedBackgroundColor: TUI_THEME.overlaySelection,
      wrapContent: options.wrapContent,
      onSelect: options.onSelect,
      onActivate: options.onActivate,
    })
    this.footer = new TextRenderable(renderer, { content: "", width: "100%", wrapMode: "word" })
    this.modal.add(this.header)
    if (this.search) this.modal.add(this.search)
    this.modal.add(this.list.root)
    this.modal.add(this.footer)
    this.root.add(this.modal)
  }

  get searchValue(): string {
    return this.search?.value ?? ""
  }

  mount(): void {
    this.previousFocus = this.renderer.currentFocusedRenderable
    this.search?.focus()
  }

  focusSearch(): void {
    this.search?.focus()
  }

  blurSearch(): void {
    this.search?.blur()
  }

  setSearchVisible(visible: boolean): void {
    if (this.search) this.search.visible = visible
  }

  handleKey(key: KeyEvent): boolean {
    if (key.name === "return" || key.name === "enter") {
      this.options.onActivate()
      return true
    }
    if (key.name === "up" || key.name === "down") {
      this.list.handleKey(key)
      return true
    }
    if (this.search?.handleKeyPress(key)) return true
    this.list.handleKey(key)
    return true
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.list.destroy()
    if (!this.root.isDestroyed) this.root.destroyRecursively()
    const previousFocus = this.previousFocus
    this.previousFocus = null
    if (previousFocus && !previousFocus.isDestroyed) previousFocus.focus()
  }

  private resize(): void {
    this.modal.width = Math.max(this.options.minWidth, Math.min(this.options.maxWidth, this.root.width - 4))
    this.modal.height = Math.max(this.options.minHeight, Math.min(this.options.maxHeight, this.root.height - 2))
  }
}

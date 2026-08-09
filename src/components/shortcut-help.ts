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

const PANEL_BG = "#101010"
const BORDER_COLOR = "#666666"
const TITLE_COLOR = "#ffffff"
const KEY_COLOR = "#7c83ff"
const TEXT_COLOR = "#dddddd"
const MUTED_COLOR = "#888888"

export interface ShortcutHelpSection {
  title: string
  bindings: Array<{ keys: string; description: string }>
}

export interface ShortcutHelpOptions {
  sections: ShortcutHelpSection[]
  onClose: () => void
}

export class ShortcutHelp {
  readonly root: BoxRenderable

  private readonly modal: BoxRenderable
  private readonly scroll: ScrollBoxRenderable
  private destroyed = false

  constructor(
    renderer: RenderContext,
    private readonly options: ShortcutHelpOptions,
  ) {
    this.root = new BoxRenderable(renderer, {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
      onSizeChange: () => this.resizeModal(),
    })
    this.modal = new BoxRenderable(renderer, {
      width: 76,
      height: 32,
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      paddingRight: 2,
      backgroundColor: PANEL_BG,
      border: true,
      borderStyle: "rounded",
      borderColor: BORDER_COLOR,
      flexDirection: "column",
    })
    this.modal.add(new TextRenderable(renderer, {
      content: "Keyboard shortcuts",
      fg: TITLE_COLOR,
      marginBottom: 1,
    }))
    this.scroll = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      width: "100%",
      scrollX: false,
      backgroundColor: PANEL_BG,
      contentOptions: {
        flexDirection: "column",
        paddingRight: 2,
        backgroundColor: PANEL_BG,
      },
    })
    this.scroll.add(new TextRenderable(renderer, {
      content: shortcutContent(options.sections),
      width: "100%",
      wrapMode: "word",
    }))
    this.modal.add(this.scroll)
    this.modal.add(new TextRenderable(renderer, {
      content: "? / Esc close · ↑/↓ scroll · PgUp/PgDn · Home/End jump",
      fg: MUTED_COLOR,
      marginTop: 1,
    }))
    this.root.add(this.modal)
  }

  handleKey(key: KeyEvent): boolean {
    if (this.destroyed) return true
    if (isShortcutHelpKey(key) || key.name === "escape" || key.name === "esc") {
      this.options.onClose()
      return true
    }
    this.scroll.handleKeyPress(key)
    return true
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private resizeModal(): void {
    if (this.root.width <= 0 || this.root.height <= 0) return
    this.modal.width = Math.max(1, Math.min(76, this.root.width - 2))
    this.modal.height = Math.max(1, Math.min(32, this.root.height - 2))
  }
}

export function isShortcutHelpKey(key: KeyEvent): boolean {
  if (key.ctrl || key.meta || key.option) return false
  return key.name === "?" || key.sequence === "?" || (key.shift && key.name === "/")
}

function shortcutContent(sections: ShortcutHelpSection[]): StyledText {
  const chunks: TextChunk[] = []
  sections.forEach((section, sectionIndex) => {
    if (sectionIndex > 0) chunks.push(fg(TEXT_COLOR)("\n\n"))
    chunks.push(fg(TITLE_COLOR)(section.title), fg(TEXT_COLOR)("\n"))
    section.bindings.forEach((binding, bindingIndex) => {
      if (bindingIndex > 0) chunks.push(fg(TEXT_COLOR)("\n"))
      chunks.push(
        fg(KEY_COLOR)(binding.keys.padEnd(24)),
        fg(TEXT_COLOR)(binding.description),
      )
    })
  })
  return new StyledText(chunks)
}

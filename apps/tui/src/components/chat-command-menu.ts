import { TUI_THEME } from "../theme.ts"
import { BoxRenderable, TextRenderable, type KeyEvent, type RenderContext } from "@opentui/core"

const PANEL_BG = TUI_THEME.appBackground
const COMMAND_COLOR = TUI_THEME.command
const COMMAND_MUTED_COLOR = TUI_THEME.commandMuted
const DESCRIPTION_COLOR = TUI_THEME.commandDescription
const SELECTED_DESCRIPTION_COLOR = TUI_THEME.selectedDescription

export interface ChatCommand {
  name: `/${string}`
  description: string
}

/**
 * A filtered command list displayed directly below the composer.
 *
 * It deliberately never takes focus. The composer retains the cursor and typed query,
 * while the chat screen routes only navigation and activation keys into this list.
 */
export class ChatCommandMenu {
  readonly root: BoxRenderable

  private matches: ChatCommand[] = []
  private rows: Array<{ box: BoxRenderable; command: TextRenderable; description: TextRenderable }> = []
  private selected = 0

  constructor(
    private readonly renderer: RenderContext,
    private readonly commands: readonly ChatCommand[],
  ) {
    this.root = new BoxRenderable(renderer, {
      width: "100%",
      height: "auto",
      flexShrink: 0,
      flexDirection: "column",
      paddingLeft: 3,
      paddingRight: 2,
      backgroundColor: PANEL_BG,
      visible: false,
    })
  }

  get visible(): boolean {
    return this.root.visible
  }

  /** Refilters from the exact composer text and returns selection to the first row. */
  setQuery(text: string): void {
    const query = text.toLowerCase()
    const isCommand = query.startsWith("/") && !query.includes("\n") && !query.includes(" ")
    this.matches = isCommand
      ? this.commands.filter((command) => command.name.startsWith(query))
      : []
    this.selected = 0
    this.rebuild()
  }

  close(): void {
    this.matches = []
    this.selected = 0
    this.rebuild()
  }

  selectedCommand(): ChatCommand | null {
    return this.matches[this.selected] ?? null
  }

  handleKey(key: KeyEvent): boolean {
    if (!this.visible) return false
    if (key.name === "up") {
      this.select((this.selected - 1 + this.matches.length) % this.matches.length)
      return true
    }
    if (key.name === "down") {
      this.select((this.selected + 1) % this.matches.length)
      return true
    }
    return false
  }

  private rebuild(): void {
    for (const row of this.rows) {
      this.root.remove(row.box)
      if (!row.box.isDestroyed) row.box.destroyRecursively()
    }
    this.rows = []

    for (const entry of this.matches) {
      const box = new BoxRenderable(this.renderer, {
        width: "100%",
        height: "auto",
        flexDirection: "row",
        alignItems: "flex-start",
        backgroundColor: PANEL_BG,
      })
      const command = new TextRenderable(this.renderer, {
        content: entry.name,
        width: 15,
        flexShrink: 0,
        fg: COMMAND_MUTED_COLOR,
        wrapMode: "none",
      })
      box.add(command)
      const description = new TextRenderable(this.renderer, {
        content: entry.description,
        flexGrow: 1,
        fg: DESCRIPTION_COLOR,
        wrapMode: "word",
      })
      box.add(description)
      this.root.add(box)
      this.rows.push({ box, command, description })
    }

    this.root.visible = this.matches.length > 0
    this.paint()
    this.renderer.requestRender()
  }

  private select(index: number): void {
    if (index === this.selected) return
    this.selected = index
    this.paint()
    this.renderer.requestRender()
  }

  private paint(): void {
    this.rows.forEach((row, index) => {
      const selected = index === this.selected
      row.box.backgroundColor = PANEL_BG
      row.command.fg = selected ? COMMAND_COLOR : COMMAND_MUTED_COLOR
      row.description.fg = selected ? SELECTED_DESCRIPTION_COLOR : DESCRIPTION_COLOR
    })
  }
}

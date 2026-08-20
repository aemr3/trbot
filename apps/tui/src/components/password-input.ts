import { TUI_THEME } from "../theme.ts"
import { TextRenderable, type KeyEvent, type PasteEvent, type RenderContext } from "@opentui/core"

export type PasswordInputAction = "previous" | "submit" | null

export class PasswordInput {
  readonly renderable: TextRenderable
  private password = ""
  private focused = false

  constructor(renderer: RenderContext) {
    this.renderable = new TextRenderable(renderer, {
      content: "",
      fg: TUI_THEME.textSubdued,
      bg: TUI_THEME.controlBackground,
      width: 32,
    })
  }

  get value(): string {
    return this.password
  }

  focus(): void {
    this.focused = true
    this.render()
  }

  blur(): void {
    this.focused = false
    this.render()
  }

  clear(): void {
    this.password = ""
    if (!this.renderable.isDestroyed) this.render()
  }

  handleKey(key: KeyEvent): PasswordInputAction {
    switch (key.name) {
      case "tab":
        return "previous"
      case "return":
        return "submit"
      case "backspace":
        this.password = Array.from(this.password).slice(0, -1).join("")
        this.render()
        return null
    }

    if (key.ctrl || key.meta || key.super || !isPrintable(key.sequence)) return null
    this.password = `${this.password}${key.sequence}`.slice(0, 256)
    this.render()
    return null
  }

  handlePaste(event: PasteEvent): void {
    const pasted = new TextDecoder().decode(event.bytes).replace(/[\r\n]/g, "")
    this.password = `${this.password}${pasted}`.slice(0, 256)
    this.render()
  }

  private render(): void {
    const cursor = this.focused ? "▌" : ""
    const masked = "•".repeat(Array.from(this.password).length)
    this.renderable.content = masked ? `${masked}${cursor}` : cursor
    this.renderable.fg = masked ? TUI_THEME.textStrong : TUI_THEME.textSubdued
    this.renderable.bg = this.focused ? TUI_THEME.border : TUI_THEME.controlBackground
  }
}

function isPrintable(value: string): boolean {
  return value.length > 0 && Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && codePoint >= 0x20 && codePoint !== 0x7f
  })
}

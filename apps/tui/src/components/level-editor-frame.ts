import { TUI_THEME } from "../theme.ts"
import {
  BoxRenderable,
  TextRenderable,
  type KeyEvent,
  type RenderContext,
} from "@opentui/core"
import { isDigitKey } from "./level-editor-fields.ts"

interface LevelEditorFrameOptions<Field extends string> {
  fields: () => readonly Field[]
  initialField: Field
  valueField: Field
  actionField: Field
  borderColor: string
  onClose: () => void
  onFieldChange: () => void
  onCycle: (field: Field, direction: number) => void
  onEdit: (field: Field, edit: (text: string) => string) => void
  onSave: () => void
}

/** Shared panel and keyboard interaction for the alert and protective-level editors. */
export class LevelEditorFrame<Field extends string> {
  readonly root: BoxRenderable
  readonly content: TextRenderable

  private activeField: Field
  private readonly modal: BoxRenderable
  private destroyed = false

  constructor(
    renderer: RenderContext,
    private readonly options: LevelEditorFrameOptions<Field>,
  ) {
    this.activeField = options.initialField
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
      width: 76,
      height: 24,
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      paddingRight: 2,
      backgroundColor: TUI_THEME.appBackground,
      border: true,
      borderStyle: "rounded",
      borderColor: options.borderColor,
      flexDirection: "column",
    })
    this.content = new TextRenderable(renderer, { content: "", width: "100%", flexGrow: 1, wrapMode: "word" })
    this.modal.add(this.content)
    this.root.add(this.modal)
  }

  set borderColor(color: string) {
    this.modal.borderColor = color
  }

  get field(): Field {
    return this.activeField
  }

  handleKey(key: KeyEvent): boolean {
    if (this.destroyed) return true
    if (key.name === "escape" || key.name === "esc") {
      this.options.onClose()
      return true
    }
    if (key.name === "tab") {
      this.move(key.shift ? -1 : 1)
      return true
    }
    if (key.name === "up" || key.name === "down") {
      this.move(key.name === "up" ? -1 : 1)
      return true
    }
    if (key.name === "left" || key.name === "right" || key.name === "space") {
      this.options.onCycle(this.activeField, key.name === "left" ? -1 : 1)
      return true
    }
    if (key.name === "return" || key.name === "enter") {
      if (this.activeField === this.options.actionField) this.options.onSave()
      else this.move(1)
      return true
    }
    if (key.name === "backspace") {
      this.options.onEdit(this.activeField, (text) => text.slice(0, -1))
      return true
    }
    if (isDigitKey(key)) {
      this.options.onEdit(this.activeField, (text) => text + (key.sequence || key.name))
      return true
    }
    if (this.activeField === this.options.valueField && isDecimalKey(key)) {
      this.options.onEdit(this.activeField, (text) => (text.includes(".") ? text : `${text}.`))
    }
    return true
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private move(direction: number): void {
    const fields = this.options.fields()
    const index = fields.indexOf(this.activeField)
    this.activeField = fields[(Math.max(0, index) + direction + fields.length) % fields.length] ?? this.options.initialField
    this.options.onFieldChange()
  }

  private resize(): void {
    this.modal.width = Math.min(76, Math.max(40, this.root.width - 2))
    this.modal.height = Math.min(24, Math.max(12, this.root.height - 2))
  }
}

function isDecimalKey(key: KeyEvent): boolean {
  return key.sequence === "." || key.sequence === "," || key.name === "." || key.name === ","
}

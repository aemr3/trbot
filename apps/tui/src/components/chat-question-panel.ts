import { TUI_THEME } from "../theme.ts"
import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  fg,
  type KeyEvent,
  type RenderContext,
} from "@opentui/core"
import type { ChatQuestionAnswer, ChatQuestionRequest } from "@trbot/chat/question.ts"
import { SelectableList } from "./selectable-list.ts"

const PANEL_BG = TUI_THEME.questionBackground
const BORDER_COLOR = TUI_THEME.questionBorder
const ACTIVE_BORDER_COLOR = TUI_THEME.activeBorder
const TEXT_COLOR = TUI_THEME.textPrimary
const MUTED_COLOR = TUI_THEME.textMuted
const ACCENT_COLOR = TUI_THEME.modelAccent
const ERROR_COLOR = TUI_THEME.negative
const SELECTED_BG = TUI_THEME.questionSelection
const CUSTOM_ID = "__custom__"

export interface ChatQuestionPanelOptions {
  request: ChatQuestionRequest
  onAnswer: (answers: ChatQuestionAnswer[]) => Promise<void>
  onFocus: () => void
  onLeave: () => void
}

/** Keeps an agent's pending question beside the composer until it is answered. */
export class ChatQuestionPanel {
  readonly root: BoxRenderable
  readonly requestId: string

  private readonly header: TextRenderable
  private readonly list: SelectableList
  private readonly customInput: TextRenderable
  private readonly footer: TextRenderable
  private readonly answers: ChatQuestionAnswer[]
  private questionIndex = 0
  private custom = false
  private typed = ""
  private busy = false
  private error: string | null = null
  private renderedQuestion = -1
  private active = true
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: ChatQuestionPanelOptions,
  ) {
    this.requestId = options.request.id
    this.answers = options.request.questions.map(() => [])
    this.root = new BoxRenderable(renderer, {
      width: "auto",
      height: 11,
      flexShrink: 0,
      marginLeft: 1,
      marginRight: 1,
      marginTop: 1,
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: PANEL_BG,
      border: true,
      borderStyle: "rounded",
      borderColor: ACTIVE_BORDER_COLOR,
      flexDirection: "column",
      onMouseDown: (event) => {
        if (event.button !== 0) return
        event.stopPropagation()
        this.options.onFocus()
      },
    })
    this.header = new TextRenderable(renderer, {
      content: "",
      width: "100%",
      height: 2,
      flexShrink: 0,
      wrapMode: "word",
    })
    this.list = new SelectableList(renderer, {
      backgroundColor: PANEL_BG,
      selectedBackgroundColor: SELECTED_BG,
      wrapContent: true,
      onFocusRequest: options.onFocus,
      onActivate: (index) => this.activate(index),
    })
    this.customInput = new TextRenderable(renderer, {
      content: "",
      width: "100%",
      flexGrow: 1,
      wrapMode: "word",
    })
    this.footer = new TextRenderable(renderer, { content: "", width: "100%", flexShrink: 0, wrapMode: "word" })
    this.root.add(this.header)
    this.root.add(this.list.root)
    this.root.add(this.customInput)
    this.root.add(this.footer)
    this.render()
  }

  setActive(active: boolean): void {
    if (this.active === active) return
    this.active = active
    this.root.borderColor = active ? ACTIVE_BORDER_COLOR : BORDER_COLOR
    this.render()
  }

  handleKey(key: KeyEvent): boolean {
    if (this.destroyed || this.busy) return true
    if (this.custom) return this.handleCustomKey(key)
    if (key.name === "escape" || key.name === "esc" || key.name === "tab") {
      this.options.onLeave()
      return true
    }

    const question = this.question()
    if (question?.multiple && isSpace(key)) {
      this.toggleSelected()
      return true
    }
    if (key.name === "return" || key.name === "enter") {
      if (this.list.selectedIndex === question?.options.length) this.openCustom()
      else if (question?.multiple) this.confirmMultiple()
      else this.activate(this.list.selectedIndex)
      return true
    }
    this.list.handleKey(key)
    return true
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.list.destroy()
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private handleCustomKey(key: KeyEvent): boolean {
    if (key.name === "escape" || key.name === "esc") {
      this.custom = false
      this.typed = ""
      this.render()
      return true
    }
    if (key.name === "return" || key.name === "enter") {
      const answer = this.typed.trim()
      if (!answer) return true
      const selected = this.answers[this.questionIndex] ?? []
      this.answers[this.questionIndex] = this.question()?.multiple
        ? [...selected.filter((value) => value !== answer), answer]
        : [answer]
      this.custom = false
      this.typed = ""
      const question = this.question()
      if (question?.multiple && question.options.length > 0) {
        this.render()
        this.list.selectIndex(0)
      } else {
        this.advance()
      }
      return true
    }
    if (key.name === "backspace") {
      this.typed = [...this.typed].slice(0, -1).join("")
      this.render()
      return true
    }
    if (key.ctrl || key.meta || key.option || !isPrintable(key.sequence)) return true
    this.typed += key.sequence
    this.render()
    return true
  }

  private activate(index: number): void {
    const question = this.question()
    if (!question) return
    if (index === question.options.length) {
      this.openCustom()
      return
    }
    const option = question.options[index]
    if (!option) return
    if (question.multiple) {
      this.toggle(option.label)
      return
    }
    this.answers[this.questionIndex] = [option.label]
    this.advance()
  }

  private toggleSelected(): void {
    const question = this.question()
    if (!question) return
    const option = question.options[this.list.selectedIndex]
    if (option) this.toggle(option.label)
    else this.openCustom()
  }

  private toggle(label: string): void {
    const selected = this.answers[this.questionIndex] ?? []
    this.answers[this.questionIndex] = selected.includes(label)
      ? selected.filter((answer) => answer !== label)
      : [...selected, label]
    this.render()
  }

  private confirmMultiple(): void {
    if ((this.answers[this.questionIndex]?.length ?? 0) === 0) return
    this.advance()
  }

  private openCustom(): void {
    this.custom = true
    this.typed = ""
    this.render()
  }

  private advance(): void {
    if (this.questionIndex + 1 < this.options.request.questions.length) {
      this.questionIndex += 1
      this.render()
      return
    }
    void this.submit()
  }

  private async submit(): Promise<void> {
    this.busy = true
    this.error = null
    this.render()
    try {
      await this.options.onAnswer(this.answers)
    } catch (error) {
      if (this.destroyed) return
      this.busy = false
      this.error = errorMessage(error)
      this.render()
    }
  }

  private question() {
    return this.options.request.questions[this.questionIndex]
  }

  private render(): void {
    if (this.destroyed) return
    const question = this.question()
    if (!question) return
    const total = this.options.request.questions.length
    this.header.content = new StyledText([
      fg(ACCENT_COLOR)(`Agent asks · ${question.header}`),
      fg(MUTED_COLOR)(total > 1 ? `  ${this.questionIndex + 1}/${total}` : ""),
      fg(TEXT_COLOR)(`\n${question.question}`),
    ])
    this.list.root.visible = !this.custom
    this.customInput.visible = this.custom
    this.customInput.content = new StyledText([
      fg(ACCENT_COLOR)("> "),
      fg(this.typed ? TEXT_COLOR : MUTED_COLOR)(this.typed || "Type your answer…"),
    ])

    const selected = this.answers[this.questionIndex] ?? []
    this.list.setRows([
      ...question.options.map((option) => ({
        id: option.label,
        content: new StyledText([
          fg(question.multiple && selected.includes(option.label) ? ACCENT_COLOR : MUTED_COLOR)(
            question.multiple ? (selected.includes(option.label) ? "[x] " : "[ ] ") : "",
          ),
          fg(TEXT_COLOR)(option.label),
          fg(MUTED_COLOR)(`  ${option.description}`),
        ]),
      })),
      {
        id: CUSTOM_ID,
        content: new StyledText([
          fg(MUTED_COLOR)(question.multiple && customAnswers(question, selected).length > 0 ? "[x] " : question.multiple ? "[ ] " : ""),
          fg(TEXT_COLOR)(customAnswers(question, selected).length > 0
            ? `Custom: ${customAnswers(question, selected).join(", ")}`
            : "Type your own answer"),
        ]),
      },
    ])
    if (this.renderedQuestion !== this.questionIndex) {
      this.renderedQuestion = this.questionIndex
      this.list.selectIndex(0)
    }

    const hint = this.busy
      ? "Sending answer…"
      : !this.active
        ? "Tab to answer"
        : this.custom
          ? "Enter use answer · Esc choices"
          : question.multiple
            ? "Space toggle · Enter continue · Tab answer later"
            : "Enter choose · Tab answer later"
    this.footer.content = new StyledText([
      fg(this.error ? ERROR_COLOR : MUTED_COLOR)(this.error ?? hint),
    ])
    this.renderer.requestRender()
  }
}

function isSpace(key: KeyEvent): boolean {
  return key.name === "space" || key.sequence === " "
}

function isPrintable(sequence: string): boolean {
  return [...sequence].length === 1 && sequence >= " " && sequence !== "\x7f"
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function customAnswers(
  question: ChatQuestionRequest["questions"][number],
  answers: ChatQuestionAnswer,
): string[] {
  const labels = new Set(question.options.map((option) => option.label))
  return answers.filter((answer) => !labels.has(answer))
}

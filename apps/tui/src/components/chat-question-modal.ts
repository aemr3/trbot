import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  fg,
  type KeyEvent,
  type RenderContext,
} from "@opentui/core"
import type {
  ChatQuestionAnswer,
  ChatQuestionRequest,
} from "@trbot/chat/question.ts"
import { SelectableList } from "./selectable-list.ts"

const PANEL_BG = "#101010"
const BORDER_COLOR = "#666666"
const TEXT_COLOR = "#dddddd"
const MUTED_COLOR = "#888888"
const ACCENT_COLOR = "#7c83ff"
const ERROR_COLOR = "#ff6b6b"
const SELECTED_BG = "#22252d"
const CUSTOM_ID = "__custom__"

export interface ChatQuestionModalOptions {
  request: ChatQuestionRequest
  onAnswer: (answers: ChatQuestionAnswer[]) => Promise<void>
  onReject: () => Promise<void>
}

/** Collects one or more answers while the calling agent remains paused. */
export class ChatQuestionModal {
  readonly root: BoxRenderable
  readonly requestId: string

  private readonly modal: BoxRenderable
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
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: ChatQuestionModalOptions,
  ) {
    this.requestId = options.request.id
    this.answers = options.request.questions.map(() => [])
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
      width: 78,
      height: 22,
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
    this.header = new TextRenderable(renderer, { content: "", width: "100%", wrapMode: "word" })
    this.list = new SelectableList(renderer, {
      backgroundColor: PANEL_BG,
      selectedBackgroundColor: SELECTED_BG,
      wrapContent: true,
      rowGap: 1,
      onActivate: (index) => this.activate(index),
    })
    this.customInput = new TextRenderable(renderer, {
      content: "",
      width: "100%",
      height: 3,
      wrapMode: "word",
    })
    this.footer = new TextRenderable(renderer, { content: "", width: "100%", wrapMode: "word" })
    this.modal.add(this.header)
    this.modal.add(this.list.root)
    this.modal.add(this.customInput)
    this.modal.add(this.footer)
    this.root.add(this.modal)
    this.render()
  }

  handleKey(key: KeyEvent): boolean {
    if (this.destroyed || this.busy) return true
    if (this.custom) return this.handleCustomKey(key)
    if (key.name === "escape" || key.name === "esc") {
      void this.reject()
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

  private async reject(): Promise<void> {
    this.busy = true
    this.error = null
    this.render()
    try {
      await this.options.onReject()
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
      fg(ACCENT_COLOR)(question.header),
      fg(MUTED_COLOR)(total > 1 ? `  ${this.questionIndex + 1}/${total}` : ""),
      fg(TEXT_COLOR)(`\n${question.question}\n`),
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
      : this.custom
        ? "Enter use answer · Esc choices"
        : question.multiple
          ? "Space toggle · Enter continue · Esc dismiss"
          : "Enter choose · Esc dismiss"
    this.footer.content = new StyledText([
      fg(this.error ? ERROR_COLOR : MUTED_COLOR)(`\n${this.error ?? hint}`),
    ])
    this.renderer.requestRender()
  }

  private resizeModal(): void {
    this.modal.width = Math.max(40, Math.min(78, this.root.width - 4))
    this.modal.height = Math.max(12, Math.min(22, this.root.height - 2))
  }
}

function isSpace(key: KeyEvent): boolean {
  return key.name === "space" || key.sequence === " "
}

function isPrintable(sequence: string): boolean {
  return [...sequence].length === 1 && sequence >= " " && sequence !== "\x7f"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function customAnswers(
  question: ChatQuestionRequest["questions"][number],
  answers: ChatQuestionAnswer,
): string[] {
  const labels = new Set(question.options.map((option) => option.label))
  return answers.filter((answer) => !labels.has(answer))
}

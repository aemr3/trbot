import { TUI_THEME } from "../theme.ts"
import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  fg,
  type KeyEvent,
  type RenderContext,
} from "@opentui/core"
import type { AiModelChoice, AiModelSummary } from "@trbot/protocol/ai.ts"
import { SelectableList } from "./selectable-list.ts"

const PANEL_BG = TUI_THEME.appBackground
const BORDER_COLOR = TUI_THEME.textFaint
const MUTED_COLOR = TUI_THEME.textMuted
const VALUE_COLOR = TUI_THEME.textPrimary
const EMPHASIS_COLOR = TUI_THEME.accent
const ERROR_COLOR = TUI_THEME.negative
const SELECTED_BG = TUI_THEME.overlaySelection

export interface AiModelModalOptions {
  /** Every model usable right now. Only connected providers are represented. */
  load: () => Promise<AiModelSummary[]>
  /** What is chosen now, so the list opens on it. */
  current: AiModelChoice | null
  title: string
  /**
   * Which step to open on. "reasoning" jumps straight to the levels of what is
   * already chosen, which is what a trader who only wants to think harder asks for.
   */
  initial?: "model" | "reasoning"
  onChoose: (choice: AiModelChoice) => Promise<void>
  onClose: () => void
}

/**
 * Picking the model, and then how hard it thinks.
 *
 * Two steps in one modal because the second depends on the first: a model's reasoning
 * levels are its own, and offering a level a model does not have would be offering a
 * request the provider will refuse.
 */
export class AiModelModal {
  readonly root: BoxRenderable

  private readonly modal: BoxRenderable
  private readonly header: TextRenderable
  private readonly list: SelectableList
  private readonly footer: TextRenderable

  private models: AiModelSummary[] = []
  /**
   * The highlighted model, as `providerId/modelId`.
   *
   * Held here rather than read back from the list so a repaint — and the return from
   * the level step, which rebuilds the rows — leaves the cursor where the trader put it.
   */
  private selectedModel: string | null = null
  private message: string | null = null
  private failed = false
  private busy = false
  /** Null while choosing a model; set once one is chosen and levels are on offer. */
  private levels: { model: AiModelSummary; index: number } | null = null
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: AiModelModalOptions,
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
      width: 78,
      height: 24,
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
      onSelect: (index) => {
        const model = this.models[index]
        if (model) this.selectedModel = modelKey(model)
        this.render()
      },
      onActivate: () => this.activate(),
    })
    this.footer = new TextRenderable(renderer, { content: "", width: "100%", wrapMode: "word" })
    this.modal.add(this.header)
    this.modal.add(this.list.root)
    this.modal.add(this.footer)
    this.root.add(this.modal)
    this.render()
  }

  mount(): void {
    void this.load()
  }

  handleKey(key: KeyEvent): boolean {
    if (key.name === "escape" || key.name === "esc") {
      // Backs out of the level step first, so a wrong model is one keypress to fix.
      if (this.levels) {
        this.levels = null
        this.render()
        return true
      }
      this.options.onClose()
      return true
    }
    if (this.busy) return true
    if (key.name === "return" || key.name === "enter") {
      this.activate()
      return true
    }
    // The level step keeps its own cursor, so moving through it must move that one
    // and not the model list underneath.
    const levels = this.levels
    if (levels) {
      if (key.name === "up") levels.index = Math.max(0, levels.index - 1)
      else if (key.name === "down") levels.index = Math.min(levels.model.thinkingLevels.length - 1, levels.index + 1)
      else return true
      this.render()
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

  private async load(): Promise<void> {
    try {
      this.models = await this.options.load()
      if (this.destroyed) return
      if (this.models.length === 0) {
        this.message = "No models available. Connect a provider first."
      }
      // Opens on what is chosen now, falling back to the top when that model is no
      // longer on offer — its provider may have been disconnected since.
      const current = this.options.current
      const currentKey = current ? `${current.providerId}/${current.modelId}` : null
      this.selectedModel = this.models.some((model) => modelKey(model) === currentKey)
        ? currentKey
        : (this.models[0] ? modelKey(this.models[0]) : null)
      if (this.options.initial === "reasoning") this.openLevelsForCurrent()
      this.render()
    } catch (error) {
      if (this.destroyed) return
      this.failed = true
      this.message = errorMessage(error)
      this.render()
    }
  }

  /**
   * Opens the level list for what is chosen now.
   *
   * Falls back to the model list when nothing is chosen, or when the chosen model has
   * only one level: there is no level question to answer in either case.
   */
  private openLevelsForCurrent(): void {
    const current = this.options.current
    if (!current) return
    const model = this.models.find(
      (candidate) => candidate.providerId === current.providerId && candidate.modelId === current.modelId,
    )
    if (!model || model.thinkingLevels.length <= 1) return
    this.levels = { model, index: Math.max(0, model.thinkingLevels.indexOf(current.reasoning ?? "")) }
  }

  private activate(): void {
    if (this.levels) {
      const level = this.levels.model.thinkingLevels[this.levels.index]
      void this.choose(this.levels.model, level ?? null)
      return
    }
    const model = this.models[this.list.selectedIndex]
    if (!model) return
    // A model with one level, or none, has nothing to ask about.
    if (model.thinkingLevels.length <= 1) {
      void this.choose(model, model.thinkingLevels[0] ?? null)
      return
    }
    const current = this.options.current
    const index = current && current.providerId === model.providerId && current.modelId === model.modelId
      ? Math.max(0, model.thinkingLevels.indexOf(current.reasoning ?? ""))
      : 0
    this.levels = { model, index }
    this.render()
  }

  private async choose(model: AiModelSummary, reasoning: string | null): Promise<void> {
    this.busy = true
    this.message = "Saving…"
    this.render()
    try {
      await this.options.onChoose({ providerId: model.providerId, modelId: model.modelId, reasoning })
      if (this.destroyed) return
      this.options.onClose()
    } catch (error) {
      if (this.destroyed) return
      this.failed = true
      this.message = errorMessage(error)
      this.busy = false
      this.render()
    }
  }

  private render(): void {
    const levels = this.levels
    this.header.content = new StyledText([
      fg(VALUE_COLOR)(`${levels ? `${levels.model.name} — reasoning` : this.options.title}\n`),
      ...(levels ? [] : [fg(MUTED_COLOR)(`${this.models.length} available\n`)]),
    ])

    if (levels) {
      this.list.setRows(
        levels.model.thinkingLevels.map((level, index) => ({
          id: level,
          content: new StyledText([
            fg(index === levels.index ? EMPHASIS_COLOR : VALUE_COLOR)(level),
          ]),
        })),
        levels.model.thinkingLevels[levels.index],
      )
    } else {
      this.list.setRows(
        this.models.map((model) => ({
          id: modelKey(model),
          content: new StyledText([
            fg(MUTED_COLOR)(`${model.providerName}  `),
            fg(VALUE_COLOR)(model.name),
            fg(MUTED_COLOR)(model.reasoning ? "  reasoning" : ""),
          ]),
        })),
        this.selectedModel ?? undefined,
      )
    }

    this.footer.content = new StyledText([
      ...(this.message ? [fg(this.failed ? ERROR_COLOR : MUTED_COLOR)(`\n${this.message}\n`)] : []),
      fg(MUTED_COLOR)(levels ? "\n↑↓ level · Enter choose · Esc back" : "\n↑↓ model · Enter choose · Esc close"),
    ])
    this.renderer.requestRender()
  }

  private resizeModal(): void {
    const width = Math.max(40, Math.min(78, this.root.width - 4))
    const height = Math.max(12, Math.min(24, this.root.height - 2))
    this.modal.width = width
    this.modal.height = height
  }
}

/** Row id for a model: the same id from two providers is two different rows. */
function modelKey(model: AiModelSummary): string {
  return `${model.providerId}/${model.modelId}`
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

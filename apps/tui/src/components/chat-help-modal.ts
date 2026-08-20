import { BoxRenderable, StyledText, TextRenderable, fg, type KeyEvent, type RenderContext, type TextChunk } from "@opentui/core"

const PANEL_BG = "#101010"
const BORDER_COLOR = "#666666"
const MUTED_COLOR = "#888888"
const VALUE_COLOR = "#dddddd"
const KEY_COLOR = "#7c83ff"

/** One key and what it does. A blank key is a heading, and a blank pair is a gap. */
type Entry = [key: string, meaning: string]

const ENTRIES: Entry[] = [
  ["Enter", "send"],
  ["⇧Enter", "new line"],
  ["", ""],
  ["^O", "which model answers this chat"],
  ["^R", "how hard it thinks"],
  ["/thoughts", "show or hide what it thought"],
  ["/monitors", "view or cancel this chat's market monitors"],
  ["⌥←/→", "previous or next worker transcript"],
  ["⌥↑", "return to the parent chat"],
  ["/subagents", "open this chat's worker sessions"],
  ["/parent", "return from a worker transcript"],
  ["", ""],
  ["^S", "chats"],
  ["^N", "new chat"],
  ["^X", "take back the last queued message"],
  ["Esc", "stop the reply that is running"],
  ["", ""],
  ["^P", "model providers"],
  ["Tab", "move between the conversation and the field"],
  ["PgUp/PgDn", "read back through the conversation"],
  ["^A", "chat"],
  ["^T", "trade"],
  ["^G", "logs"],
  ["/help", "open this list"],
]

const KEY_WIDTH = Math.max(...ENTRIES.map(([key]) => key.length)) + 2

export interface ChatHelpModalOptions {
  onClose: () => void
}

/**
 * Every key the chat screen answers to, in one place.
 *
 * The screen's own footer names this modal and nothing else. A line of shortcuts along
 * the bottom is read once and then becomes furniture, and it can only ever fit the
 * handful that happen to be short — so the room goes to what the conversation has spent
 * instead, and the keys live here where all of them fit.
 */
export class ChatHelpModal {
  readonly root: BoxRenderable

  private readonly modal: BoxRenderable
  private destroyed = false

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: ChatHelpModalOptions,
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
      width: 60,
      height: ENTRIES.length + 6,
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
      content: new StyledText([fg(VALUE_COLOR)("Keys\n")]),
      width: "100%",
      wrapMode: "none",
    }))
    this.modal.add(new TextRenderable(renderer, {
      content: new StyledText(ENTRIES.flatMap(entryChunks)),
      width: "100%",
      wrapMode: "none",
    }))
    this.modal.add(new TextRenderable(renderer, {
      content: new StyledText([fg(MUTED_COLOR)("\nEsc close")]),
      width: "100%",
      wrapMode: "none",
    }))
    this.root.add(this.modal)
    this.renderer.requestRender()
  }

  /** Any key closes it: this is a thing to read, not a thing to operate. */
  handleKey(_key: KeyEvent): boolean {
    this.options.onClose()
    return true
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private resizeModal(): void {
    this.modal.width = Math.max(40, Math.min(60, this.root.width - 4))
    this.modal.height = Math.max(10, Math.min(ENTRIES.length + 6, this.root.height - 2))
  }
}

function entryChunks([key, meaning]: Entry): TextChunk[] {
  if (!key) return [fg(MUTED_COLOR)("\n")]
  return [fg(KEY_COLOR)(key.padEnd(KEY_WIDTH)), fg(MUTED_COLOR)(`${meaning}\n`)]
}

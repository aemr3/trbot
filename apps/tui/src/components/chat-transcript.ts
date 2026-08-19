import {
  BoxRenderable,
  ScrollBoxRenderable,
  StyledText,
  TextRenderable,
  type KeyEvent,
  type RenderContext,
} from "@opentui/core"

/**
 * One turn as the transcript shows it.
 *
 * The rail is what makes a long conversation readable: every line of a message sits
 * against a colour that says who is speaking, so a reply that wraps over ten lines is
 * still visibly one reply.
 */
export interface ChatTranscriptBlock {
  id: string
  /** Who is speaking. Left out for a note that belongs to nobody, such as an empty state. */
  name?: string | StyledText
  /** Applies to a plain name; a styled one carries its own colours. */
  nameColor?: string
  railColor: string
  content: StyledText
}

export interface ChatTranscriptOptions {
  backgroundColor: string
}

/**
 * The conversation, scrolling.
 *
 * Sticks to the bottom while a reply streams in, and stops sticking the moment the
 * trader scrolls up: reading something further back is not something a new delta
 * should interrupt.
 */
export class ChatTranscript {
  readonly root: ScrollBoxRenderable

  private rows: { box: BoxRenderable; name: TextRenderable; body: TextRenderable }[] = []

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: ChatTranscriptOptions,
  ) {
    this.root = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      width: "100%",
      scrollX: false,
      stickyScroll: true,
      stickyStart: "bottom",
      backgroundColor: options.backgroundColor,
      contentOptions: {
        flexDirection: "column",
        paddingRight: 1,
        backgroundColor: options.backgroundColor,
      },
    })
    // Nothing here scrolls sideways, and a horizontal bar would take a line off the
    // window while the content still measures the full height — which is enough
    // overflow for the sticky bottom to hide the first line of the conversation.
    this.root.horizontalScrollBar.visible = false
  }

  /**
   * Replaces what is shown.
   *
   * Rebuilds only when the number of turns changes, so the deltas of a streaming reply
   * repaint one block rather than the whole conversation.
   */
  setBlocks(blocks: ChatTranscriptBlock[]): void {
    if (blocks.length !== this.rows.length) this.rebuild(blocks.length)
    blocks.forEach((block, index) => {
      const row = this.rows[index]
      if (!row) return
      row.box.borderColor = block.railColor
      row.name.visible = block.name !== undefined
      if (block.name !== undefined) {
        row.name.content = block.name
        if (typeof block.name === "string") row.name.fg = block.nameColor ?? block.railColor
      }
      row.body.content = block.content
    })
  }

  handleKey(key: KeyEvent): boolean {
    return this.root.handleKeyPress(key)
  }

  destroy(): void {
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private rebuild(count: number): void {
    for (const child of this.root.getChildren()) {
      this.root.remove(child)
      if (!child.isDestroyed) child.destroyRecursively()
    }
    this.rows = []
    for (let index = 0; index < count; index++) {
      const box = new BoxRenderable(this.renderer, {
        id: `turn-${index}`,
        width: "100%",
        flexDirection: "column",
        flexShrink: 0,
        border: ["left"],
        paddingLeft: 1,
        marginBottom: 1,
        backgroundColor: this.options.backgroundColor,
      })
      const name = new TextRenderable(this.renderer, { content: "", width: "100%", wrapMode: "none" })
      const body = new TextRenderable(this.renderer, { content: "", width: "100%", wrapMode: "word" })
      box.add(name)
      box.add(body)
      this.root.add(box)
      this.rows.push({ box, name, body })
    }
  }
}

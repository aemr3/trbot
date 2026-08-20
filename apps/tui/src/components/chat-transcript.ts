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
 * A turn is three lines of information at most: what led to it, what it says, and who
 * said it. Prompts are quiet filled blocks; replies sit directly on the transcript.
 * A small marker distinguishes the two without adding a full-height rail beside every
 * wrapped line.
 */
export interface ChatTranscriptBlock {
  id: string
  /** The compact role or state marker at the start of the turn. */
  marker?: StyledText
  /** Optional background for turns that need a stronger block treatment. */
  fill?: string
  /** Optional left rail used instead of a filled block. */
  rail?: string
  /** Whether the turn gets a blank line above and below its content. */
  padded?: boolean
  /** Above the content: what the model thought, or which tool answered. */
  header?: StyledText
  /** False for a tool-call turn that has reasoning and provenance but no spoken text. */
  bodyVisible?: boolean
  content: StyledText
  /** Below the content: which model wrote it, how long it took, what it cost. */
  footer?: StyledText
}

export interface ChatTranscriptOptions {
  backgroundColor: string
}

const LEFT_RAIL: ["left"] = ["left"]

/**
 * The conversation, scrolling.
 *
 * Sticks to the bottom while a reply streams in, and stops sticking the moment the
 * trader scrolls up: reading something further back is not something a new delta
 * should interrupt.
 */
export class ChatTranscript {
  readonly root: ScrollBoxRenderable

  private rows: {
    box: BoxRenderable
    marker: TextRenderable
    header: TextRenderable
    body: TextRenderable
    footer: TextRenderable
  }[] = []

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
      const fill = block.fill ?? this.options.backgroundColor
      row.box.backgroundColor = fill
      if (block.rail === undefined) {
        row.box.border = false
      } else {
        row.box.border = LEFT_RAIL
        row.box.borderColor = block.rail
        row.box.borderStyle = "heavy"
      }
      if (block.marker !== undefined) row.box.paddingLeft = 2
      else row.box.paddingLeft = block.rail === undefined ? 0 : 1
      row.marker.visible = block.marker !== undefined
      if (block.marker !== undefined) row.marker.content = block.marker
      row.marker.top = block.padded ? 1 : 0
      row.box.paddingTop = block.padded ? 1 : 0
      row.box.paddingBottom = block.padded ? 1 : 0
      row.header.visible = block.header !== undefined
      if (block.header !== undefined) row.header.content = block.header
      const bodyVisible = block.bodyVisible !== false
      // A thought or tool label introduces the body; it is not the first line of it.
      // Likewise, provenance belongs to the reply without running into its last line.
      row.body.visible = bodyVisible
      row.body.marginTop = bodyVisible && block.header !== undefined ? 1 : 0
      row.body.content = block.content
      row.footer.visible = block.footer !== undefined
      if (block.footer !== undefined) row.footer.content = block.footer
      row.footer.marginTop = block.footer !== undefined && bodyVisible ? 1 : 0
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
        paddingRight: 1,
        marginBottom: 1,
        backgroundColor: this.options.backgroundColor,
      })
      const marker = new TextRenderable(this.renderer, {
        content: "",
        position: "absolute",
        left: 0,
        top: 0,
        width: 1,
        wrapMode: "none",
      })
      // Reasoning can be paragraph-long; clipping its first line makes the rest
      // impossible to reach even when thoughts are expanded.
      const header = new TextRenderable(this.renderer, { content: "", width: "100%", wrapMode: "word" })
      const body = new TextRenderable(this.renderer, { content: "", width: "100%", wrapMode: "word" })
      const footer = new TextRenderable(this.renderer, { content: "", width: "100%", wrapMode: "none" })
      box.add(marker)
      box.add(header)
      box.add(body)
      box.add(footer)
      this.root.add(box)
      this.rows.push({ box, marker, header, body, footer })
    }
  }
}

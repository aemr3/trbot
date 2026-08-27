import { TUI_THEME } from "../theme.ts"
import { DOUBLE_CLICK_MS } from "./selectable-list.ts"
import {
  BoxRenderable,
  ScrollBoxRenderable,
  StyledText,
  TextAttributes,
  TextRenderable,
  fg,
  type KeyEvent,
  type RenderContext,
  type TextChunk,
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
  /** Additional cells before the marker and content for nested activity. */
  indent?: number
  /** Whether the turn gets a blank line above and below its content. */
  padded?: boolean
  /** Above the content: what the model thought, or which tool answered. */
  header?: StyledText
  /** Whether the header acts as a screen-owned disclosure control. */
  headerSelectable?: boolean
  /** Expanded detail directly below the header, before the spoken answer. */
  detail?: StyledText
  /** False for a tool-call turn that has reasoning and provenance but no spoken text. */
  bodyVisible?: boolean
  /** Whether clicking this turn's body may open a screen-owned action. */
  selectable?: boolean
  content: StyledText
  /** Below the content: which model wrote it, how long it took, what it cost. */
  footer?: StyledText
}

export interface ChatTranscriptOptions {
  backgroundColor: string
  resolveContractSymbol?: (mention: string) => string | null
  onContractSelect?: (symbol: string) => void
  onBlockSelect?: (id: string) => void
  onHeaderSelect?: (id: string) => void
  canDoubleClick?: () => boolean
  onDoubleClick?: () => void
  onBottomChange?: (atBottom: boolean) => void
}

const LEFT_RAIL: ["left"] = ["left"]
const CONTRACT_MENTION_PATTERN = /\b(?:F_[A-Z0-9]+[0-9]{4}|[A-Z][A-Z0-9]{1,9})\b/gu

interface ContractLink {
  symbol: string
  start: number
  end: number
}

interface ContractLinkedText {
  content: StyledText
  contracts: ContractLink[]
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

  private rows: {
    box: BoxRenderable
    marker: TextRenderable
    header: TextRenderable
    detail: TextRenderable
    body: TextRenderable
    footer: TextRenderable
    contracts: ContractLink[]
    selectable: boolean
    headerSelectable: boolean
    blockId: string
  }[] = []
  private lastClickAt = 0
  private lastClickTarget: string | null = null
  private pendingClick: { action: () => void; timer: ReturnType<typeof setTimeout> } | null = null
  private atBottom = true
  private bottomCheckScheduled = false
  private readonly scrollChangeListener = () => this.scheduleBottomCheck()

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
      onMouseDown: (event) => {
        if (event.button !== 0 || !this.options.canDoubleClick?.() || !this.registerClick(`root:${event.y}`)) return
        this.cancelPendingClick()
        event.preventDefault()
        event.stopPropagation()
        this.options.onDoubleClick?.()
      },
    })
    this.root.verticalScrollBar.on("change", this.scrollChangeListener)
    // Nothing here scrolls sideways, and a horizontal bar would take a line off the
    // window while the content still measures the full height — which is enough
    // overflow for the sticky bottom to hide the first line of the conversation.
    this.root.horizontalScrollBar.visible = false
  }

  /**
   * Replaces what is shown.
   *
   * Existing rows survive both streaming updates and appended turns. Recreating every
   * row when one turn arrives briefly duplicates a long transcript's native text
   * buffers, which can exhaust OpenTUI's handle pool.
   */
  setBlocks(blocks: ChatTranscriptBlock[]): void {
    this.resize(blocks.length)
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
      const indent = block.indent ?? 0
      if (block.marker !== undefined) row.box.paddingLeft = indent + 2
      else row.box.paddingLeft = indent + (block.rail === undefined ? 0 : 1)
      row.marker.visible = block.marker !== undefined
      if (block.marker !== undefined) row.marker.content = block.marker
      row.marker.left = indent
      row.marker.top = block.padded ? 1 : 0
      row.box.paddingTop = block.padded ? 1 : 0
      row.box.paddingBottom = block.padded ? 1 : 0
      row.header.visible = block.header !== undefined
      if (block.header !== undefined) row.header.content = block.header
      row.headerSelectable = block.headerSelectable ?? false
      row.detail.visible = block.detail !== undefined
      if (block.detail !== undefined) row.detail.content = block.detail
      const bodyVisible = block.bodyVisible !== false
      // A thought or tool label introduces the body; it is not the first line of it.
      // Likewise, provenance belongs to the reply without running into its last line.
      row.body.visible = bodyVisible
      row.body.marginTop = bodyVisible && (block.header !== undefined || block.detail !== undefined) ? 1 : 0
      const linked = contractLinks(block.content, this.options.resolveContractSymbol)
      row.body.content = linked.content
      row.contracts = linked.contracts
      row.selectable = block.selectable ?? false
      row.blockId = block.id
      row.footer.visible = block.footer !== undefined
      if (block.footer !== undefined) row.footer.content = block.footer
      row.footer.marginTop = block.footer !== undefined && bodyVisible ? 1 : 0
    })
    this.scheduleBottomCheck()
  }

  handleKey(key: KeyEvent): boolean {
    const handled = this.root.handleKeyPress(key)
    this.scheduleBottomCheck()
    return handled
  }

  scrollToBottom(): void {
    this.root.scrollTo({ x: this.root.scrollLeft, y: this.root.scrollHeight })
    this.updateBottomState()
  }

  destroy(): void {
    this.cancelPendingClick()
    this.root.verticalScrollBar.off("change", this.scrollChangeListener)
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private registerClick(target: string): boolean {
    const now = Date.now()
    const isDoubleClick = this.lastClickTarget === target && now - this.lastClickAt < DOUBLE_CLICK_MS
    this.lastClickAt = isDoubleClick ? 0 : now
    this.lastClickTarget = isDoubleClick ? null : target
    return isDoubleClick
  }

  private cancelPendingClick(): void {
    if (this.pendingClick) clearTimeout(this.pendingClick.timer)
    this.pendingClick = null
  }

  private flushPendingClick(): void {
    const pending = this.pendingClick
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingClick = null
    pending.action()
  }

  private scheduleBottomCheck(): void {
    if (this.bottomCheckScheduled) return
    this.bottomCheckScheduled = true
    queueMicrotask(() => {
      this.bottomCheckScheduled = false
      if (!this.root.isDestroyed) this.updateBottomState()
    })
  }

  private updateBottomState(): void {
    const maxScrollTop = Math.max(0, this.root.scrollHeight - this.root.viewport.height)
    const atBottom = this.root.scrollTop >= maxScrollTop
    if (atBottom === this.atBottom) return
    this.atBottom = atBottom
    this.options.onBottomChange?.(atBottom)
  }

  private resize(count: number): void {
    while (this.rows.length > count) {
      const row = this.rows.pop()
      if (!row) break
      this.root.remove(row.box)
      if (!row.box.isDestroyed) row.box.destroyRecursively()
    }
    while (this.rows.length < count) {
      this.rows.push(this.createRow(this.rows.length))
    }
  }

  private createRow(index: number): (typeof this.rows)[number] {
    const box = new BoxRenderable(this.renderer, {
      id: `turn-${index}`,
      width: "100%",
      flexDirection: "column",
      flexShrink: 0,
      paddingRight: 1,
      marginBottom: 1,
      backgroundColor: this.options.backgroundColor,
      onMouseDown: (event) => {
        if (event.button !== 0 || !this.options.canDoubleClick?.()) return
        event.stopPropagation()
        if (!this.registerClick(`row:${this.rows[index]?.blockId}`)) return
        this.cancelPendingClick()
        event.preventDefault()
        this.options.onDoubleClick?.()
      },
    })
    try {
      const marker = new TextRenderable(this.renderer, {
        content: "",
        position: "absolute",
        left: 0,
        top: 0,
        width: 1,
        wrapMode: "none",
      })
      box.add(marker)
      // Thought labels act as disclosure buttons; expanded reasoning is rendered
      // separately below so clicking its body does not collapse it.
      const header = new TextRenderable(this.renderer, {
        content: "",
        width: "100%",
        wrapMode: "word",
        onMouseDown: (event) => {
          const row = this.rows[index]
          if (event.button !== 0 || !row?.headerSelectable) return
          event.preventDefault()
          event.stopPropagation()
          this.options.onHeaderSelect?.(row.blockId)
        },
      })
      box.add(header)
      const detail = new TextRenderable(this.renderer, { content: "", width: "100%", wrapMode: "word" })
      box.add(detail)
      const body = new TextRenderable(this.renderer, {
        content: "",
        width: "100%",
        wrapMode: "word",
        onMouseDown: (event) => {
          if (event.button !== 0) return
          const row = this.rows[index]
          const symbol = contractAtPoint(body, row?.contracts ?? [], event.x, event.y)
          if (this.options.canDoubleClick?.()) {
            event.stopPropagation()
            const clickTarget = symbol ? `contract:${row?.blockId}:${symbol}` : `block:${row?.blockId}`
            if (this.registerClick(clickTarget)) {
              this.cancelPendingClick()
              event.preventDefault()
              this.options.onDoubleClick?.()
              return
            }
            const action = symbol
              ? () => this.options.onContractSelect?.(symbol)
              : row?.selectable
                ? () => this.options.onBlockSelect?.(row.blockId)
                : null
            if (action) {
              event.preventDefault()
              this.flushPendingClick()
              const timer = setTimeout(() => {
                this.pendingClick = null
                action()
              }, DOUBLE_CLICK_MS)
              this.pendingClick = { action, timer }
            }
            return
          }
          if (symbol) {
            event.preventDefault()
            event.stopPropagation()
            this.options.onContractSelect?.(symbol)
            return
          }
          if (!row?.selectable) return
          event.preventDefault()
          event.stopPropagation()
          this.options.onBlockSelect?.(row.blockId)
        },
      })
      box.add(body)
      const footer = new TextRenderable(this.renderer, { content: "", width: "100%", wrapMode: "none" })
      box.add(footer)
      this.root.add(box)
      return {
        box,
        marker,
        header,
        detail,
        body,
        footer,
        contracts: [],
        selectable: false,
        headerSelectable: false,
        blockId: "",
      }
    } catch (error) {
      if (!box.isDestroyed) box.destroyRecursively()
      throw error
    }
  }
}

function contractLinks(
  content: StyledText,
  resolveContractSymbol: ((mention: string) => string | null) | undefined,
): ContractLinkedText {
  if (!resolveContractSymbol) return { content, contracts: [] }

  const contracts: ContractLink[] = []
  const chunks: TextChunk[] = []
  let contentOffset = 0
  for (const chunk of content.chunks) {
    CONTRACT_MENTION_PATTERN.lastIndex = 0
    const matches: { match: RegExpExecArray; contractSymbol: string }[] = []
    for (const match of chunk.text.matchAll(CONTRACT_MENTION_PATTERN)) {
      const contractSymbol = resolveContractSymbol(match[0])
      if (contractSymbol !== null) matches.push({ match, contractSymbol })
    }
    if (matches.length === 0) {
      chunks.push(chunk)
      contentOffset += textBufferWidth(chunk.text)
      continue
    }

    let cursor = 0
    for (const { match, contractSymbol } of matches) {
      const start = match.index
      const mention = match[0]
      if (start > cursor) chunks.push(copyTextChunk(chunk, chunk.text.slice(cursor, start)))
      const accent = fg(TUI_THEME.link)(mention)
      chunks.push({
        ...chunk,
        ...accent,
        attributes: (chunk.attributes ?? 0) | TextAttributes.UNDERLINE,
      })
      const displayStart = contentOffset + textBufferWidth(chunk.text.slice(0, start))
      contracts.push({
        symbol: contractSymbol,
        start: displayStart,
        end: displayStart + Bun.stringWidth(mention),
      })
      cursor = start + mention.length
    }
    if (cursor < chunk.text.length) chunks.push(copyTextChunk(chunk, chunk.text.slice(cursor)))
    contentOffset += textBufferWidth(chunk.text)
  }
  return { content: new StyledText(chunks), contracts }
}

function copyTextChunk(chunk: TextChunk, text: string): TextChunk {
  return { ...chunk, text }
}

// OpenTUI's visual-line offsets count a logical newline as one position even
// though it occupies no terminal cell. Keep link ranges in that same space.
function textBufferWidth(text: string): number {
  let width = 0
  for (const character of text) width += character === "\n" ? 1 : Bun.stringWidth(character)
  return width
}

function contractAtPoint(
  body: TextRenderable,
  contracts: ContractLink[],
  screenX: number,
  screenY: number,
): string | null {
  const row = screenY - body.screenY + body.scrollY
  const column = screenX - body.screenX + body.scrollX
  if (row < 0 || column < 0) return null
  const lineStart = body.lineInfo.lineStartCols[row]
  if (lineStart === undefined) return null
  const offset = lineStart + column
  return contracts.find((contract) => offset >= contract.start && offset < contract.end)?.symbol ?? null
}

import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  fg,
  link,
  t,
  type KeyEvent,
  type Renderable,
  type RenderContext,
} from "@opentui/core"
import { CredentialsRequiredError } from "../api/index.ts"
import { DOUBLE_CLICK_MS, SelectableList } from "../components/selectable-list.ts"
import type { ViopInstrument, ViopInstrumentSource } from "../market/instrument.ts"
import type { NewsArticle, NewsSource } from "../market/news.ts"

const UP_COLOR = "#70d7a1"
const DOWN_COLOR = "#ff6b6b"
const NEUTRAL_COLOR = "#999999"
const SIDE_PANEL_BG = "#161616"
const SELECTED_ROW_BG = "#282828"
const HEADER_COLOR = "#dddddd"
const FOCUSED_HEADER = "#ffffff"
const UNFOCUSED_HEADER = "#666666"
const LINK_COLOR = "#6cb6ff"
const NEWS_TIME_COLOR = "#8a8a8a"
const NEWS_HEADLINE_COLOR = "#e0e0e0"

export interface WatchlistScreenOptions {
  instruments: ViopInstrumentSource
  news: NewsSource
  onSessionExpired?: () => void
}

type Focus = "instruments" | "news"

export class WatchlistScreen {
  readonly root: BoxRenderable

  private readonly instrumentList: SelectableList
  private readonly chartBody: TextRenderable
  private readonly rightPanel: BoxRenderable
  private readonly viopHeader: TextRenderable
  private readonly newsHeader: TextRenderable
  private readonly newsList: SelectableList
  private readonly newsReader: ScrollBoxRenderable
  private readonly newsMessage: TextRenderable

  private newsContent: Renderable | null = null
  private instruments: ViopInstrument[] = []
  private newsArticles: NewsArticle[] = []
  private focus: Focus = "instruments"
  private articleOpen = false
  private destroyed = false
  private sessionExpiredNotified = false
  private newsRequestUid: string | null = null
  private articleRequestUid: string | null = null
  private readerLastClickAt = 0

  private readonly handleKeypress = (key: KeyEvent): void => {
    if (this.articleOpen) {
      if (key.name === "escape" || key.name === "esc" || key.name === "backspace") this.closeArticle()
      else if (key.name === "up" || key.name === "k") this.newsReader.scrollBy({ x: 0, y: -2 })
      else if (key.name === "down" || key.name === "j") this.newsReader.scrollBy({ x: 0, y: 2 })
      return
    }
    if (key.name === "tab") {
      this.toggleFocus()
      return
    }
    if (this.focus === "news") this.newsList.handleKey(key)
    else this.instrumentList.handleKey(key)
  }

  constructor(
    private readonly renderer: RenderContext,
    private readonly options: WatchlistScreenOptions,
  ) {
    this.root = new BoxRenderable(renderer, {
      flexDirection: "column",
      width: "100%",
      height: "100%",
    })

    const columns = new BoxRenderable(renderer, {
      flexDirection: "row",
      flexGrow: 1,
      width: "100%",
    })

    const leftPanel = new BoxRenderable(renderer, {
      width: 36,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: SIDE_PANEL_BG,
    })
    this.viopHeader = panelHeader(renderer, "VIOP")
    leftPanel.add(this.viopHeader)
    this.instrumentList = new SelectableList(renderer, {
      selectedBackgroundColor: SELECTED_ROW_BG,
      backgroundColor: SIDE_PANEL_BG,
      indicatorColor: HEADER_COLOR,
      onSelect: (index) => this.onInstrumentSelected(index),
      onFocusRequest: () => this.setFocus("instruments"),
    })
    leftPanel.add(this.instrumentList.root)

    const centerPanel = new BoxRenderable(renderer, {
      flexGrow: 1,
      flexDirection: "column",
      paddingLeft: 2,
      paddingRight: 2,
    })
    centerPanel.add(panelHeader(renderer, "Chart"))
    this.chartBody = new TextRenderable(renderer, {
      content: "Select an instrument to view its chart.",
      fg: "#777777",
    })
    centerPanel.add(this.chartBody)

    this.rightPanel = new BoxRenderable(renderer, {
      width: 46,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: SIDE_PANEL_BG,
    })
    this.newsHeader = panelHeader(renderer, "News")
    this.rightPanel.add(this.newsHeader)
    this.newsList = new SelectableList(renderer, {
      selectedBackgroundColor: SELECTED_ROW_BG,
      backgroundColor: SIDE_PANEL_BG,
      indicatorColor: HEADER_COLOR,
      wrapContent: true,
      rowGap: 1,
      onActivate: (index) => void this.openArticle(index),
      onFocusRequest: () => this.setFocus("news"),
    })
    this.newsReader = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      width: "100%",
      backgroundColor: SIDE_PANEL_BG,
      contentOptions: { flexDirection: "column", gap: 1, paddingRight: 1, backgroundColor: SIDE_PANEL_BG },
      onMouseDown: (event) => {
        if (event.button !== 0 || !this.articleOpen) return
        const now = Date.now()
        if (now - this.readerLastClickAt < DOUBLE_CLICK_MS) {
          this.readerLastClickAt = 0
          this.closeArticle()
        } else {
          this.readerLastClickAt = now
        }
      },
    })
    this.newsMessage = new TextRenderable(renderer, { content: "Loading news…", fg: "#777777" })
    this.setNewsContent(this.newsMessage)

    columns.add(leftPanel)
    columns.add(centerPanel)
    columns.add(this.rightPanel)

    const hint = new TextRenderable(renderer, {
      content: "↑/↓ move · Tab switch · Enter/double-click read · Esc/⌫/double-click back · Ctrl+C exit",
      fg: "#777777",
    })

    this.root.add(columns)
    this.root.add(hint)
  }

  mount(): void {
    this.renderer.keyInput.on("keypress", this.handleKeypress)
    this.updateFocusIndicator()
    void this.load()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.renderer.keyInput.off("keypress", this.handleKeypress)
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private async load(): Promise<void> {
    try {
      const instruments = await this.options.instruments.listInstruments()
      if (this.destroyed) return
      this.instruments = instruments
      this.instrumentList.setRows(
        instruments.map((instrument) => ({
          id: instrument.uid,
          content: formatInstrumentRow(instrument),
          color: changeColor(instrument.changePercent),
        })),
      )
      if (instruments.length > 0) this.onInstrumentSelected(0)
      else this.chartBody.content = "No VIOP instruments available."
    } catch (error) {
      if (this.destroyed) return
      if (this.notifyIfSessionExpired(error)) return
      this.chartBody.content = `Failed to load instruments: ${errorMessage(error)}`
      this.chartBody.fg = "#ff6b6b"
    }
  }

  private onInstrumentSelected(index: number): void {
    const instrument = this.instruments[index]
    if (!instrument) return
    this.chartBody.content = `${instrument.symbol} — ${instrument.displayName}\n\nChart coming soon.`
    this.chartBody.fg = "#aaaaaa"
    void this.loadNews(instrument)
  }

  private async loadNews(instrument: ViopInstrument): Promise<void> {
    this.newsRequestUid = instrument.uid
    this.articleOpen = false
    this.setMessage("Loading news…", "#777777")
    try {
      const articles = await this.options.news.listNews({ instrumentUid: instrument.uid })
      if (this.destroyed || this.newsRequestUid !== instrument.uid) return
      this.renderNews(articles, instrument.displayName)
    } catch (error) {
      if (this.destroyed || this.newsRequestUid !== instrument.uid) return
      if (this.notifyIfSessionExpired(error)) return
      this.setMessage(`Failed to load news: ${errorMessage(error)}`, "#ff6b6b")
    }
  }

  private renderNews(articles: NewsArticle[], label: string): void {
    this.newsArticles = articles
    if (articles.length === 0) {
      this.setMessage(`No recent news for ${label}.`, "#777777")
      return
    }
    this.newsList.setRows(articles.map((article) => ({ id: article.uid, content: newsRowContent(article) })))
    this.setNewsContent(this.newsList.root)
  }

  private async openArticle(index: number): Promise<void> {
    const article = this.newsArticles[index]
    if (!article) return
    this.articleOpen = true
    this.articleRequestUid = article.uid
    this.renderReaderMessage("Loading article…", "#777777")
    this.setNewsContent(this.newsReader)
    try {
      const full = await this.options.news.getArticle(article.uid)
      if (this.destroyed || this.articleRequestUid !== article.uid) return
      this.renderReader(full ?? article)
    } catch (error) {
      if (this.destroyed || this.articleRequestUid !== article.uid) return
      if (this.notifyIfSessionExpired(error)) return
      this.renderReaderMessage(`Failed to load article: ${errorMessage(error)}`, "#ff6b6b")
    }
  }

  private notifyIfSessionExpired(error: unknown): boolean {
    if (!(error instanceof CredentialsRequiredError)) return false
    if (!this.sessionExpiredNotified) {
      this.sessionExpiredNotified = true
      this.options.onSessionExpired?.()
    }
    return true
  }

  private closeArticle(): void {
    this.articleOpen = false
    this.articleRequestUid = null
    this.setNewsContent(this.newsList.root)
  }

  private renderReader(article: NewsArticle): void {
    for (const child of this.newsReader.getChildren()) this.newsReader.remove(child)
    this.newsReader.add(new TextRenderable(this.renderer, { content: article.headline, fg: "#ffffff", wrapMode: "word", width: "100%" }))
    if (article.tag) this.newsReader.add(new TextRenderable(this.renderer, { content: article.tag, fg: "#888888" }))
    this.newsReader.add(new TextRenderable(this.renderer, { content: article.body || "(No content)", fg: "#cccccc", wrapMode: "word", width: "100%" }))

    const links = [article.url, ...article.attachments].filter((url): url is string => Boolean(url))
    if (links.length > 0) {
      this.newsReader.add(new TextRenderable(this.renderer, { content: "Bağlantı:", fg: "#888888" }))
      for (const url of links) {
        this.newsReader.add(
          new TextRenderable(this.renderer, { content: t`${fg(LINK_COLOR)(link(url)(url))}`, wrapMode: "word", width: "100%" }),
        )
      }
    }
    this.newsReader.scrollTo({ x: 0, y: 0 })
  }

  private renderReaderMessage(content: string, fg: string): void {
    for (const child of this.newsReader.getChildren()) this.newsReader.remove(child)
    this.newsReader.add(new TextRenderable(this.renderer, { content, fg }))
  }

  private setMessage(content: string, fg: string): void {
    this.newsMessage.content = content
    this.newsMessage.fg = fg
    this.setNewsContent(this.newsMessage)
  }

  private setNewsContent(node: Renderable): void {
    if (this.newsContent === node) return
    if (this.newsContent && !this.newsContent.isDestroyed) this.rightPanel.remove(this.newsContent)
    this.newsContent = node
    this.rightPanel.add(node)
  }

  private toggleFocus(): void {
    this.setFocus(this.focus === "instruments" ? "news" : "instruments")
  }

  private setFocus(focus: Focus): void {
    if (this.focus === focus) return
    this.focus = focus
    this.updateFocusIndicator()
  }

  private updateFocusIndicator(): void {
    this.viopHeader.fg = this.focus === "instruments" ? FOCUSED_HEADER : UNFOCUSED_HEADER
    this.newsHeader.fg = this.focus === "news" ? FOCUSED_HEADER : UNFOCUSED_HEADER
  }
}

function newsRowContent(article: NewsArticle) {
  if (!article.tag) return t`${fg(NEWS_HEADLINE_COLOR)(article.headline)}`
  return t`${fg(NEWS_TIME_COLOR)(article.tag)}\n${fg(NEWS_HEADLINE_COLOR)(article.headline)}`
}

function panelHeader(renderer: RenderContext, title: string): TextRenderable {
  return new TextRenderable(renderer, {
    content: title,
    fg: HEADER_COLOR,
    marginBottom: 1,
  })
}

function changeColor(changePercent: number | null): string {
  if (changePercent === null) return NEUTRAL_COLOR
  return changePercent >= 0 ? UP_COLOR : DOWN_COLOR
}

function formatInstrumentRow(instrument: ViopInstrument): string {
  const name = instrument.displayName.padEnd(6)
  const price =
    instrument.lastPrice !== null
      ? instrument.lastPrice.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : ""
  const change =
    instrument.changePercent !== null
      ? `${instrument.changePercent >= 0 ? "+" : ""}${instrument.changePercent.toFixed(2)}%`
      : ""
  return `${name}  ${price.padStart(10)}  ${change.padStart(7)}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

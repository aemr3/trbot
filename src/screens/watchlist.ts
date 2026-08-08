import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  type KeyEvent,
  type RenderContext,
} from "@opentui/core"
import { SelectableList } from "../components/selectable-list.ts"
import type { ViopInstrument, ViopInstrumentSource } from "../market/instrument.ts"
import type { NewsArticle, NewsSource } from "../market/news.ts"

const UP_COLOR = "#70d7a1"
const DOWN_COLOR = "#ff6b6b"
const NEUTRAL_COLOR = "#999999"
const SIDE_PANEL_BG = "#161616"
const SELECTED_ROW_BG = "#282828"
const HEADER_COLOR = "#dddddd"

export interface WatchlistScreenOptions {
  instruments: ViopInstrumentSource
  news: NewsSource
}

export class WatchlistScreen {
  readonly root: BoxRenderable

  private readonly instrumentList: SelectableList
  private readonly chartBody: TextRenderable
  private readonly newsList: ScrollBoxRenderable
  private readonly newsEmpty: TextRenderable
  private instruments: ViopInstrument[] = []
  private destroyed = false

  private readonly handleKeypress = (key: KeyEvent): void => {
    this.instrumentList.handleKey(key)
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
    leftPanel.add(panelHeader(renderer, "VIOP"))
    this.instrumentList = new SelectableList(renderer, {
      selectedBackgroundColor: SELECTED_ROW_BG,
      backgroundColor: SIDE_PANEL_BG,
      indicatorColor: HEADER_COLOR,
      onSelect: (index) => this.onInstrumentSelected(index),
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

    const rightPanel = new BoxRenderable(renderer, {
      width: 46,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: SIDE_PANEL_BG,
    })
    rightPanel.add(panelHeader(renderer, "News"))
    this.newsList = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      width: "100%",
      backgroundColor: SIDE_PANEL_BG,
      contentOptions: { flexDirection: "column", gap: 1, backgroundColor: SIDE_PANEL_BG },
    })
    this.newsEmpty = new TextRenderable(renderer, {
      content: "Loading news…",
      fg: "#777777",
    })
    this.newsList.add(this.newsEmpty)
    rightPanel.add(this.newsList)

    columns.add(leftPanel)
    columns.add(centerPanel)
    columns.add(rightPanel)

    const hint = new TextRenderable(renderer, {
      content: "↑/↓ to browse · Ctrl+C to exit",
      fg: "#777777",
    })

    this.root.add(columns)
    this.root.add(hint)
  }

  mount(): void {
    this.renderer.keyInput.on("keypress", this.handleKeypress)
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
    const symbol = instrument.underlyingSymbol ?? instrument.symbol
    try {
      const articles = await this.options.news.listNews({ instrumentSymbol: symbol })
      if (this.destroyed) return
      this.renderNews(articles, symbol)
    } catch (error) {
      if (this.destroyed) return
      this.renderNewsMessage(`Failed to load news: ${errorMessage(error)}`, "#ff6b6b")
    }
  }

  private renderNews(articles: NewsArticle[], symbol: string): void {
    for (const child of this.newsList.getChildren()) this.newsList.remove(child)
    if (articles.length === 0) {
      this.renderNewsMessage(`No recent news for ${symbol}.`, "#777777")
      return
    }
    for (const article of articles) {
      this.newsList.add(this.buildNewsItem(article))
    }
  }

  private renderNewsMessage(content: string, fg: string): void {
    for (const child of this.newsList.getChildren()) this.newsList.remove(child)
    this.newsList.add(new TextRenderable(this.renderer, { content, fg }))
  }

  private buildNewsItem(article: NewsArticle): BoxRenderable {
    const item = new BoxRenderable(this.renderer, {
      flexDirection: "column",
      width: "100%",
    })
    if (article.tag) {
      item.add(new TextRenderable(this.renderer, { content: article.tag, fg: "#70d7a1" }))
    }
    item.add(new TextRenderable(this.renderer, { content: article.headline, fg: "#ffffff" }))
    if (article.body) {
      item.add(new TextRenderable(this.renderer, { content: article.body, fg: "#999999" }))
    }
    return item
  }
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

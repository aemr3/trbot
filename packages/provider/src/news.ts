import type { ApiClient } from "@trbot/api"
import { marketOperations } from "@trbot/api/market.ts"
import { newsOperations, type ArticleDetail, type ArticlePreview } from "@trbot/api/news.ts"
import type { NewsArticle, NewsSource } from "@trbot/market/news.ts"

type NewsApiClient = Pick<ApiClient, "call">

const ASSET_VERTICAL = "TR"
const INVESTMENT_TYPE = "MARKET_INSTRUMENTS"
const PAGE_SIZE = 20

export class ApiNewsSource implements NewsSource {
  // News is tagged to the underlying stock, not the VIOP future; cache the
  // resolved underlying uid per instrument to avoid repeat lookups.
  private readonly underlyingUidCache = new Map<string, string | null>()

  constructor(private readonly client: NewsApiClient) {}

  async listNews(options: { instrumentUid?: string; signal?: AbortSignal } = {}): Promise<NewsArticle[]> {
    const { instrumentUid, signal } = options
    const stockUid = instrumentUid ? await this.resolveUnderlyingUid(instrumentUid, signal) : null

    const data = await this.client.call(
      newsOperations.articlesV2,
      {
        instrumentId: stockUid,
        isFeatured: null,
        assetVertical: ASSET_VERTICAL,
        investmentType: INVESTMENT_TYPE,
        page: 0,
        pageSize: PAGE_SIZE,
        type: "ALL",
        cryptoCurrencySymbol: null,
      },
      { signal },
    )
    return (data.articlesV2?.articles ?? []).map(toArticle)
  }

  async getArticle(uid: string, options: { signal?: AbortSignal } = {}): Promise<NewsArticle | null> {
    const data = await this.client.call(newsOperations.article, { newsId: uid, cryptoCurrencySymbol: null }, { signal: options.signal })
    return data.article ? toDetailArticle(data.article) : null
  }

  private async resolveUnderlyingUid(instrumentUid: string, signal?: AbortSignal): Promise<string> {
    const cached = this.underlyingUidCache.get(instrumentUid)
    if (cached !== undefined) return cached ?? instrumentUid

    const data = await this.client.call(marketOperations.getInstrument, { instrumentId: instrumentUid }, { signal })
    const underlyingUid = data.instrument?.underlyingInstrumentUid ?? null
    this.underlyingUidCache.set(instrumentUid, underlyingUid)
    return underlyingUid ?? instrumentUid
  }
}

function toArticle(article: ArticlePreview): NewsArticle {
  return {
    uid: article.uid,
    tag: formatPublishedAt(article.publishedAt),
    headline: article.title,
    body: article.description ?? "",
    publishedAt: parsePublishedAt(article.publishedAt),
    url: null,
    attachments: [],
  }
}

function toDetailArticle(article: ArticleDetail): NewsArticle {
  return {
    uid: article.uid,
    tag: formatPublishedAt(article.publishedAt),
    headline: article.title,
    body: article.body ? htmlToText(article.body) : "",
    publishedAt: parsePublishedAt(article.publishedAt),
    url: article.url,
    attachments: article.attachmentUrls ?? [],
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  uuml: "ü",
  Uuml: "Ü",
  ouml: "ö",
  Ouml: "Ö",
  ccedil: "ç",
  Ccedil: "Ç",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  ndash: "–",
  mdash: "—",
  hellip: "…",
}

// Article bodies arrive as HTML; render them as plain text for the terminal.
function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
  return decodeEntities(withBreaks)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => safeFromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeFromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&([a-zA-Z]+);/g, (match, name) => NAMED_ENTITIES[name] ?? match)
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ""
  try {
    return String.fromCodePoint(code)
  } catch {
    return ""
  }
}

function parsePublishedAt(iso: string | null): number | null {
  if (!iso) return null
  const value = Date.parse(iso)
  return Number.isNaN(value) ? null : value
}

function formatPublishedAt(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString("tr-TR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
}

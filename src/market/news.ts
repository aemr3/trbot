export interface NewsArticle {
  uid: string
  instrumentSymbol: string | null
  tag: string | null
  headline: string
  body: string
  publishedAt: number | null
}

export interface NewsSource {
  listNews(options?: { instrumentSymbol?: string; signal?: AbortSignal }): Promise<NewsArticle[]>
}

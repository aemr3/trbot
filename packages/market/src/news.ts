export interface NewsArticle {
  uid: string
  tag: string | null
  headline: string
  body: string
  publishedAt: number | null
  url: string | null
  attachments: string[]
}

export interface NewsSource {
  listNews(options?: { instrumentUid?: string; signal?: AbortSignal }): Promise<NewsArticle[]>
  getArticle(uid: string, options?: { signal?: AbortSignal }): Promise<NewsArticle | null>
}

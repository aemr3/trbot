import { z } from "zod"

export interface NewsArticle {
  uid: string
  tag: string | null
  headline: string
  body: string
  publishedAt: number | null
  url: string | null
  attachments: string[]
}

export const NewsArticleSchema: z.ZodType<NewsArticle> = z.object({
  uid: z.string(),
  tag: z.string().nullable(),
  headline: z.string(),
  body: z.string(),
  publishedAt: z.number().nullable(),
  url: z.string().nullable(),
  attachments: z.array(z.string()),
})

export interface NewsSource {
  listNews(options?: { instrumentUid?: string; signal?: AbortSignal }): Promise<NewsArticle[]>
  getArticle(uid: string, options?: { signal?: AbortSignal }): Promise<NewsArticle | null>
}

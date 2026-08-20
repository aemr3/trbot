import { expect, test } from "bun:test"
import { marketOperations } from "@trbot/api/market.ts"
import type { ArticlePreview, ArticleVariables } from "@trbot/api/news.ts"
import { providerApiClient, type ProviderTestRequest } from "@trbot/api/provider-client.test-fixture.ts"
import { ApiNewsSource } from "./news.ts"

function fakeClient(articles: ArticlePreview[], underlyingUid: string | null = "stock-1") {
  const calls = { getInstrument: 0, articlesV2: 0 }
  let lastArticlesVars: ProviderTestRequest["variables"] | undefined
  const client = providerApiClient((request) => {
      if (request.operationName === marketOperations.getInstrument.name) {
        calls.getInstrument++
        return { instrument: { __typename: "Future", underlyingInstrumentUid: underlyingUid } }
      }
      calls.articlesV2++
      lastArticlesVars = request.variables
      return { articlesV2: { articles, page: 0, hasMore: false } }
  })
  return { client, calls, lastArticlesVars: () => lastArticlesVars }
}

test("resolves the underlying uid and maps articles", async () => {
  const { client, lastArticlesVars } = fakeClient([
    { uid: "a1", type: "MIDAS_NEWS", title: "Headline 1", description: null, publishedAt: "2026-08-08T18:22:45Z" },
    { uid: "a2", type: "MIDAS_NEWS", title: "Headline 2", description: "Body 2", publishedAt: null },
  ])
  const source = new ApiNewsSource(client)

  const news = await source.listNews({ instrumentUid: "fut-1" })

  expect(lastArticlesVars()?.instrumentId).toBe("stock-1")
  expect(news.map((n) => n.headline)).toEqual(["Headline 1", "Headline 2"])
  expect(news[0]?.body).toBe("")
  expect(news[0]?.publishedAt).toBe(Date.parse("2026-08-08T18:22:45Z"))
  expect(news[0]?.tag).toBeTruthy()
  expect(news[1]?.body).toBe("Body 2")
  expect(news[1]?.publishedAt).toBeNull()
})

test("caches the underlying uid across calls for the same instrument", async () => {
  const { client, calls } = fakeClient([])
  const source = new ApiNewsSource(client)

  await source.listNews({ instrumentUid: "fut-1" })
  await source.listNews({ instrumentUid: "fut-1" })

  expect(calls.getInstrument).toBe(1)
  expect(calls.articlesV2).toBe(2)
})

test("fetches a full article body via getArticle and converts HTML to text", async () => {
  const html = "<html><body><p>BIST 100 y&uuml;zde 0,14 d&#252;&#351;t&#252;.</p><p>&#304;kinci paragraf.</p></body></html>"
  const client = providerApiClient((request) => {
      expect(request.operationName).toBe("article")
      expect(request.variables).toMatchObject({ newsId: "a1" } satisfies Partial<ArticleVariables>)
      return {
        article: {
          uid: "a1",
          title: "Full headline",
          body: html,
          publishedAt: "2026-08-08T18:22:45Z",
          url: "https://www.kap.org.tr/tr/api/BildirimPdf/1643171",
          attachmentUrls: ["https://example.com/ek.pdf"],
        },
      }
  })
  const source = new ApiNewsSource(client)

  const article = await source.getArticle("a1")

  expect(article?.headline).toBe("Full headline")
  expect(article?.body).toBe("BIST 100 yüzde 0,14 düştü.\nİkinci paragraf.")
  expect(article?.body).not.toContain("<p>")
  expect(article?.publishedAt).toBe(Date.parse("2026-08-08T18:22:45Z"))
  expect(article?.url).toBe("https://www.kap.org.tr/tr/api/BildirimPdf/1643171")
  expect(article?.attachments).toEqual(["https://example.com/ek.pdf"])
})

test("fetches general news with no instrument (no underlying lookup)", async () => {
  const { client, calls, lastArticlesVars } = fakeClient([])
  const source = new ApiNewsSource(client)

  await source.listNews({})

  expect(calls.getInstrument).toBe(0)
  expect(lastArticlesVars()?.instrumentId).toBeNull()
})

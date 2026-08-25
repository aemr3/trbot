import { expect, test } from "bun:test"
import { ChatTools } from "./tool.ts"
import { webTools, type WebToolsOptions } from "./web.ts"
import { z } from "zod"

const publicResolver = async (): Promise<string[]> => ["93.184.216.34"]

function registry(options: WebToolsOptions): ChatTools {
  return new ChatTools(webTools({ resolve: publicResolver, ...options }))
}

test("gives every limited web tool the continuation parameter", () => {
  const parameters = z.object({
    properties: z.object({
      limit: z.unknown().optional(),
      offset: z.unknown().optional(),
    }).passthrough(),
  })
  const limited = webTools({ resolve: publicResolver }).flatMap((tool) => {
    const { properties } = parameters.parse(tool.definition.parameters)
    if (properties.limit === undefined) return []
    expect(properties.offset).toBeDefined()
    return [tool.definition.name]
  })
  expect(limited).toEqual(["web_search"])
})

test("rejects a web-search offset beyond the supported result window", async () => {
  let searches = 0
  const tools = registry({ search: async () => {
    searches += 1
    return ""
  } })

  const outcome = await tools.call({
    type: "toolCall",
    id: "search-invalid-page",
    name: "web_search",
    arguments: { query: "market", offset: 25, limit: 5 },
  }, {})

  expect(outcome.isError).toBe(true)
  expect(outcome.blocks[0]?.text).toContain("offset")
  expect(searches).toBe(0)
})

test("searches the web while keeping the result payload out of the visible tool row", async () => {
  const requested: Array<{ query: string; limit: number }> = []
  const tools = registry({ search: async (query, limit) => {
    requested.push({ query, limit })
    return `Title: Market news
URL: https://example.com/news
Published: N/A
Author: N/A
Highlights:
The latest market report.

---

Title: Company filing
URL: https://example.org/filing
Published: N/A
Author: N/A
Highlights:
The official filing.`
  } })

  const outcome = await tools.call({
    type: "toolCall",
    id: "search-1",
    name: "web_search",
    arguments: { query: "ASELS latest", limit: 2 },
  }, {})

  expect(outcome.isError).toBe(false)
  expect(outcome.blocks[0]?.text).toBe("Returned 2 web results for “ASELS latest”.")
  expect(outcome.blocks[0]?.text).not.toContain("example.com")
  expect(outcome.modelBlocks?.[0]?.text).toContain("https://example.com/news")
  expect(outcome.modelBlocks?.[0]?.text).toContain("The official filing.")
  expect(outcome.details).toMatchObject({
    page: { offset: 0, limit: 2, returned: 2, total: 2, hasMore: false, nextOffset: null },
  })
  expect(requested).toEqual([{ query: "ASELS latest", limit: 3 }])
})

test("continues web search results from the returned offset", async () => {
  const requested: number[] = []
  const tools = registry({ search: async (_query, limit) => {
    requested.push(limit)
    return Array.from({ length: 4 }, (_, index) => `Title: Result ${index + 1}
URL: https://example.com/${index + 1}
Highlights:
Summary ${index + 1}.`).join("\n\n---\n\n")
  } })

  const outcome = await tools.call({
    type: "toolCall",
    id: "search-page-2",
    name: "web_search",
    arguments: { query: "market", offset: 1, limit: 2 },
  }, {})

  expect(outcome.isError).toBe(false)
  expect(outcome.blocks[0]?.text).toContain("continue with offset 3")
  expect(outcome.modelBlocks?.[0]?.text).toContain("[2] Result 2")
  expect(outcome.modelBlocks?.[0]?.text).toContain("[3] Result 3")
  expect(outcome.details).toMatchObject({
    page: { offset: 1, limit: 2, returned: 2, total: null, hasMore: true, nextOffset: 3 },
  })
  expect(requested).toEqual([4])
})

test("fetches a public page and extracts readable text for the model", async () => {
  const tools = registry({ fetch: async () => new Response(`
    <!doctype html>
    <html>
      <head><title>Exchange bulletin</title></head>
      <body>
        <nav>Unrelated navigation</nav>
        <article>
          <h1>Exchange bulletin</h1>
          <p>Trading will continue through the afternoon session with the published schedule.</p>
        </article>
      </body>
    </html>
  `, { headers: { "content-type": "text/html; charset=utf-8" } }) })

  const outcome = await tools.call({
    type: "toolCall",
    id: "fetch-1",
    name: "fetch_content",
    arguments: { url: "https://example.com/bulletin" },
  }, {})

  expect(outcome.isError).toBe(false)
  expect(outcome.blocks[0]?.text).toBe("Fetched Exchange bulletin (https://example.com/bulletin).")
  expect(outcome.blocks[0]?.text).not.toContain("afternoon session")
  expect(outcome.modelBlocks?.[0]?.text).toContain("Trading will continue through the afternoon session")
})

test("refuses private targets before making a request", async () => {
  let requests = 0
  const tools = registry({ fetch: async () => {
    requests++
    return new Response("secret")
  } })

  const outcome = await tools.call({
    type: "toolCall",
    id: "fetch-private",
    name: "fetch_content",
    arguments: { url: "http://127.0.0.1:3000/admin" },
  }, {})

  expect(outcome.isError).toBe(true)
  expect(outcome.blocks[0]?.text).toContain("private network")
  expect(requests).toBe(0)
})

test("validates every redirect before following it", async () => {
  let requests = 0
  const tools = registry({ fetch: async () => {
    requests++
    return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } })
  } })

  const outcome = await tools.call({
    type: "toolCall",
    id: "fetch-redirect",
    name: "fetch_content",
    arguments: { url: "https://example.com/redirect" },
  }, {})

  expect(outcome.isError).toBe(true)
  expect(outcome.blocks[0]?.text).toContain("private network")
  expect(requests).toBe(1)
})

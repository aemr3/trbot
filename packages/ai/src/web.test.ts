import { expect, test } from "bun:test"
import { ChatTools } from "./tool.ts"
import { webTools, type WebToolsOptions } from "./web.ts"

const publicResolver = async (): Promise<string[]> => ["93.184.216.34"]

function registry(options: WebToolsOptions): ChatTools {
  return new ChatTools(webTools({ resolve: publicResolver, ...options }))
}

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
  expect(outcome.blocks[0]?.text).toBe("Found 2 web results for “ASELS latest”.")
  expect(outcome.blocks[0]?.text).not.toContain("example.com")
  expect(outcome.modelBlocks?.[0]?.text).toContain("https://example.com/news")
  expect(outcome.modelBlocks?.[0]?.text).toContain("The official filing.")
  expect(requested).toEqual([{ query: "ASELS latest", limit: 2 }])
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

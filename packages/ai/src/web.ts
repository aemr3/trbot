import { lookup } from "node:dns/promises"
import { BlockList, isIP } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Readability } from "@mozilla/readability"
import { Type } from "@earendil-works/pi-ai"
import { parseHTML } from "linkedom"
import { toolText, type ChatTool } from "./tool.ts"

const SEARCH_ENDPOINT = "https://mcp.exa.ai/mcp?tools=web_search_exa"
const REQUEST_TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 5
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_PAGE_CHARS = 20_000
const MAX_SEARCH_CHARS = 24_000
const USER_AGENT = "trbot/1.0 (+https://github.com/aemr3/trbot)"

const SearchParameters = Type.Object({
  query: Type.String({ description: "What to search the public web for", minLength: 1, maxLength: 500 }),
  limit: Type.Optional(Type.Integer({ description: "Number of results, from 1 to 10", minimum: 1, maximum: 10 })),
})

const FetchParameters = Type.Object({
  url: Type.String({ description: "Public HTTP or HTTPS page to read", minLength: 1, maxLength: 2_000 }),
})

export interface WebToolsOptions {
  fetch?: WebFetch
  resolve?: (hostname: string) => Promise<string[]>
  search?: WebSearch
}

type WebFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type WebSearch = (query: string, limit: number, signal?: AbortSignal) => Promise<string>

interface WebResult {
  title: string
  url: string
  snippet: string
}

/** Search and readable-page tools for the chat agent; neither can reach private networks. */
export function webTools(options: WebToolsOptions = {}): ChatTool[] {
  const client = new PublicWebClient(options)
  const search: ChatTool<typeof SearchParameters> = {
    definition: {
      name: "web_search",
      description: "Search the current public web. Use source URLs from the results when answering.",
      parameters: SearchParameters,
    },
    run: async ({ query, limit }, runOptions) => {
      const results = await client.search(query, limit ?? 5, runOptions.signal)
      const modelText = results.length === 0
        ? `No web results found for: ${query}`
        : results.map((result, index) => [
          `[${index + 1}] ${result.title}`,
          result.url,
          result.snippet,
        ].filter(Boolean).join("\n")).join("\n\n")
      return {
        blocks: [toolText(`Found ${results.length} web result${results.length === 1 ? "" : "s"} for “${query}”.`)],
        modelBlocks: [toolText(modelText)],
        details: { query, results },
        isError: false,
      }
    },
  }
  const fetchContent: ChatTool<typeof FetchParameters> = {
    definition: {
      name: "fetch_content",
      description: "Read a public HTTP(S) page as plain text. Use it to inspect a useful web-search result.",
      parameters: FetchParameters,
    },
    run: async ({ url }, runOptions) => {
      const page = await client.read(url, runOptions.signal)
      return {
        blocks: [toolText(`Fetched ${page.title || page.url} (${page.url}).`)],
        modelBlocks: [toolText([
          `Source: ${page.url}`,
          ...(page.title ? [`Title: ${page.title}`] : []),
          "",
          page.text,
          ...(page.truncated ? ["", "[Content truncated]"] : []),
        ].join("\n"))],
        details: { url: page.url, title: page.title, truncated: page.truncated },
        isError: false,
      }
    },
  }
  return [search, fetchContent]
}

class PublicWebClient {
  private readonly fetch: WebFetch
  private readonly resolve: (hostname: string) => Promise<string[]>
  private readonly searchWeb: WebSearch

  constructor(options: WebToolsOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.resolve = options.resolve ?? resolveHost
    this.searchWeb = options.search ?? searchExa
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
    return parseSearchResults(await this.searchWeb(query.trim(), limit, signal), limit)
  }

  async read(rawUrl: string, signal?: AbortSignal): Promise<{
    url: string
    title: string
    text: string
    truncated: boolean
  }> {
    const { response, finalUrl } = await this.request(new URL(rawUrl), signal)
    requireSuccess(response, finalUrl)
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
    if (contentType && !isReadableContentType(contentType)) {
      throw new Error(`Cannot read ${contentType.split(";", 1)[0] || "this content type"}`)
    }
    const source = await readText(response, MAX_RESPONSE_BYTES)
    const extracted = contentType.includes("html") || looksLikeHtml(source)
      ? readableHtml(source)
      : { title: "", text: source.trim() }
    if (!extracted.text) throw new Error("The page had no readable text")
    const truncated = extracted.text.length > MAX_PAGE_CHARS
    return {
      url: finalUrl.href,
      title: extracted.title,
      text: extracted.text.slice(0, MAX_PAGE_CHARS),
      truncated,
    }
  }

  private async request(initialUrl: URL, signal?: AbortSignal): Promise<{ response: Response; finalUrl: URL }> {
    let url = initialUrl
    for (let redirects = 0; ; redirects++) {
      await assertPublicUrl(url, this.resolve)
      const response = await fetchWithTimeout(this.fetch, url, signal)
      if (!isRedirect(response.status)) return { response, finalUrl: url }
      if (redirects >= MAX_REDIRECTS) throw new Error("Too many redirects")
      const location = response.headers.get("location")
      if (!location) throw new Error(`Redirect from ${url.href} had no location`)
      await response.body?.cancel()
      url = new URL(location, url)
    }
  }
}

async function searchExa(query: string, limit: number, signal?: AbortSignal): Promise<string> {
  const transport = new StreamableHTTPClientTransport(new URL(SEARCH_ENDPOINT), {
    requestInit: { headers: { "user-agent": USER_AGENT } },
  })
  const client = new Client({ name: "trbot", version: "1.0.0" })
  try {
    await client.connect(transport, { signal, timeout: REQUEST_TIMEOUT_MS })
    const result = await client.callTool({
      name: "web_search_exa",
      arguments: { query, numResults: limit },
    }, undefined, { signal, timeout: REQUEST_TIMEOUT_MS })
    const text = mcpText(result)
    if (isRecord(result) && result.isError === true) throw new Error(text || "Web search failed")
    if (!text) throw new Error("Web search returned no content")
    return text
  } finally {
    await client.close().catch(() => {})
  }
}

function mcpText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return ""
  return result.content
    .filter((block): block is { type: "text"; text: string } =>
      isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n")
    .trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseSearchResults(text: string, limit: number): WebResult[] {
  const perResultLimit = Math.max(500, Math.floor(MAX_SEARCH_CHARS / limit))
  return text
    .split(/\n\s*---\s*\n/)
    .map((section) => {
      const title = section.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? ""
      const url = section.match(/^URL:\s*(\S+)$/m)?.[1]?.trim() ?? ""
      const highlights = section.match(/^Highlights:\s*\n([\s\S]*)$/m)?.[1] ?? ""
      return { title, url, snippet: cleanText(highlights).slice(0, perResultLimit) }
    })
    .filter((result) => result.title && publicResultUrl(result.url))
    .slice(0, limit)
}

const deniedAddresses = new BlockList()
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) deniedAddresses.addSubnet(network, prefix, "ipv4")
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10],
  ["ff00::", 8], ["2001:db8::", 32],
] as const) deniedAddresses.addSubnet(network, prefix, "ipv6")

async function assertPublicUrl(url: URL, resolve: (hostname: string) => Promise<string[]>): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP and HTTPS URLs can be fetched")
  if (url.username || url.password) throw new Error("URLs containing credentials cannot be fetched")
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Local and private network URLs cannot be fetched")
  }
  const addresses = isIP(hostname) ? [hostname] : await resolve(hostname)
  if (addresses.length === 0 || addresses.some(isDeniedAddress)) {
    throw new Error("Local and private network URLs cannot be fetched")
  }
}

async function resolveHost(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((result) => result.address)
}

function isDeniedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return deniedAddresses.check(address, "ipv4")
  if (family === 6) return deniedAddresses.check(address, "ipv6")
  return true
}

async function fetchWithTimeout(
  fetcher: WebFetch,
  url: URL,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted) forwardAbort()
  else signal?.addEventListener("abort", forwardAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error("Web request timed out")), REQUEST_TIMEOUT_MS)
  try {
    return await fetcher(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.2",
        "user-agent": USER_AGENT,
      },
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", forwardAbort)
  }
}

async function readText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > limit) throw new Error("Web response was too large")
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > limit) {
      await reader.cancel()
      throw new Error("Web response was too large")
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const charset = response.headers.get("content-type")?.match(/charset=([^;\s]+)/i)?.[1]?.replace(/["']/g, "")
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes)
  } catch {
    return new TextDecoder().decode(bytes)
  }
}

function readableHtml(html: string): { title: string; text: string } {
  const { document } = parseHTML(html)
  const article = new Readability(document as unknown as Document, { charThreshold: 20 }).parse()
  const title = oneLine(article?.title || document.title || "")
  const text = cleanText(article?.textContent || document.body?.textContent || "")
  return { title, text }
}

function cleanText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function publicResultUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function looksLikeHtml(text: string): boolean {
  return /^\s*<!doctype html|^\s*<html[\s>]/i.test(text)
}

function isReadableContentType(contentType: string): boolean {
  return contentType.includes("text/") || contentType.includes("application/xhtml+xml") || contentType.includes("application/json")
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function requireSuccess(response: Response, url: URL): void {
  if (!response.ok) throw new Error(`${url.hostname} returned HTTP ${response.status}`)
}

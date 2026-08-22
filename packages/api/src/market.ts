import { defineOperation } from "./graphql.ts"
import { z } from "zod"

interface ScreenerInstrumentValue {
  key: string
  value: string | null
  situation: string | null
}

export interface ScreenerInstrument {
  uid: string
  symbol: string
  values: ScreenerInstrumentValue[]
}

export interface ScreenerResult {
  pitId: string | null
  searchAfter: string | null
  totalSize: number
  sortBy: string | null
  sortDirection: string | null
  instruments: ScreenerInstrument[]
}

export interface ScreenerRetrieveV2Data {
  screenerRetrieveV2?: {
    uid: string
    result: ScreenerResult
  }
}

export interface ScreenerRetrieveV2Variables {
  id: string | null
  assetVertical: string
  sectorId: string | null
  investmentType: string
}

export interface ScreenerColumnInput {
  id: string
  field: string
}

export interface ScreenerResultV2Data {
  screenerRetrieveResultV2?: ScreenerResult
}

export interface ScreenerResultV2Variables {
  pitId: string | null
  searchAfter: string | null
  sortBy: string | null
  sortDirection: string | null
  assetVertical: string
  investmentType: string
  filters: unknown[]
  columns: ScreenerColumnInput[]
}

export interface InstrumentData {
  instrument?: {
    __typename: string
    underlyingInstrumentUid?: string | null
  } | null
}

export interface InstrumentVariables {
  instrumentId: string
}

interface AdvancedToolSearchResult {
  __typename: string
  uid: string
  type: string | null
  symbol?: string | null
}

export interface AdvancedToolSearchData {
  searchByAdvancedTools?: {
    results: AdvancedToolSearchResult[]
    page: number
    hasNext: boolean
  } | null
}

export interface AdvancedToolSearchVariables {
  query: string
  tool: string
  page: number
  size: number
}

interface FutureDetailItem {
  key: string
  text: string
  value: string | null
  info: { title: string; url: string } | null
}

interface FutureDetailSection {
  title: string
  description: string | null
  items: FutureDetailItem[]
}

export interface FutureDetailData {
  futureDetail?: {
    contractDetails: FutureDetailSection
    stats: FutureDetailSection
  } | null
}

export interface FutureDetailVariables {
  instrumentUid: string
}

// The provider's own name for each reading of the settlement register: the
// standing positions, and the houses that grew or shrank theirs.
// VIOP futures live prices arrive over SSE on the streaming host. The event is
// named `PriceUpdate` and the payload keys are single letters.
export const VIOP_PRICE_STREAM_PATH = "/reactive-viop-api/v1/viop/futures/price-quote"
export const VIOP_PRICE_STREAM_EVENT = "PriceUpdate"

export interface FuturePriceUpdate {
  symbol: string
  lastPrice: number | null
  ask: number | null
  bid: number | null
  sessionStatus: string | null
  timestamp: number
}

const OptionalFiniteNumberSchema = z.number().finite().nullable().catch(null).optional()
const OptionalStringSchema = z.string().nullable().catch(null).optional()
const OptionalBooleanSchema = z.boolean().nullable().catch(null).optional()

const FuturePriceFrameSchema = z.object({
  s: z.string().min(1),
  p: OptionalFiniteNumberSchema,
  a: OptionalFiniteNumberSchema,
  b: OptionalFiniteNumberSchema,
  ss: OptionalStringSchema,
  ts: OptionalFiniteNumberSchema,
})

export function parseFuturePriceUpdate(data: string): FuturePriceUpdate | null {
  let decoded: z.input<typeof FuturePriceFrameSchema>
  try {
    decoded = JSON.parse(data)
  } catch {
    return null
  }
  const parsed = FuturePriceFrameSchema.safeParse(decoded)
  if (!parsed.success) return null
  const raw = parsed.data
  return {
    symbol: raw.s,
    lastPrice: raw.p ?? null,
    ask: raw.a ?? null,
    bid: raw.b ?? null,
    sessionStatus: raw.ss ?? null,
    timestamp: raw.ts ?? 0,
  }
}

// Order book depth arrives over SSE on the streaming host, unnamed events with
// single-letter keys. Only cash-equity symbols have a book; VIOP contract
// symbols answer 404. `DETAIL` carries the ladder and the trade tape, where
// `SUMMARY` would carry only the side totals.
export const DEPTH_STREAM_PATH = "/reactive-market-depth-api/v2/depth/stream"
export const DEPTH_STREAM_TYPE = "DETAIL"

interface DepthUpdateLevel {
  index: number
  level: { price: number; lots: number; orderCount: number }
}

interface DepthUpdateTrade {
  id: string
  price: number
  lots: number
  side: "BUY" | "SELL"
  buyer: string | null
  seller: string | null
}

export interface DepthUpdate {
  symbol: string
  // Absent when the frame carries only trades. Levels are partial: each one
  // names the ladder slot it replaces.
  depth: {
    buyLots: number | null
    sellLots: number | null
    bids: DepthUpdateLevel[]
    asks: DepthUpdateLevel[]
  } | null
  // `replace` marks a full tape; otherwise the items are new prints to merge.
  trades: { replace: boolean; maxLength: number | null; items: DepthUpdateTrade[] } | null
  marketClosed: boolean | null
  maintenance: boolean | null
  infoMessage: string | null
}

const DepthLevelFrameSchema = z.object({
  i: OptionalFiniteNumberSchema,
  p: OptionalFiniteNumberSchema,
  l: OptionalFiniteNumberSchema,
  o: OptionalFiniteNumberSchema,
})

const DepthLadderFrameSchema = z.object({
  bc: OptionalFiniteNumberSchema,
  sc: OptionalFiniteNumberSchema,
  b: z.array(DepthLevelFrameSchema).catch([]).optional(),
  s: z.array(DepthLevelFrameSchema).catch([]).optional(),
})

const DepthTradeFrameSchema = z.object({
  id: z.string(),
  p: OptionalFiniteNumberSchema,
  l: OptionalFiniteNumberSchema,
  d: OptionalStringSchema,
  b: OptionalStringSchema,
  s: OptionalStringSchema,
})

const DepthTradesFrameSchema = z.object({
  mt: OptionalStringSchema,
  l: OptionalFiniteNumberSchema,
  t: z.array(DepthTradeFrameSchema),
})

const DepthFrameSchema = z.object({
  s: z.string().min(1),
  dpt: DepthLadderFrameSchema.nullable().catch(null).optional(),
  trd: DepthTradesFrameSchema.nullable().catch(null).optional(),
  c: OptionalBooleanSchema,
  m: OptionalBooleanSchema,
  t: OptionalStringSchema,
})

export function parseDepthUpdate(data: string): DepthUpdate | null {
  let decoded: z.input<typeof DepthFrameSchema>
  try {
    decoded = JSON.parse(data)
  } catch {
    return null
  }
  const parsed = DepthFrameSchema.safeParse(decoded)
  if (!parsed.success) return null
  const raw = parsed.data
  return {
    symbol: raw.s,
    depth: parseDepthLadder(raw.dpt),
    trades: parseDepthTrades(raw.trd),
    marketClosed: raw.c ?? null,
    maintenance: raw.m ?? null,
    infoMessage: raw.t ?? null,
  }
}

function parseDepthLadder(raw: z.output<typeof DepthLadderFrameSchema> | null | undefined): DepthUpdate["depth"] {
  if (!raw) return null
  return {
    buyLots: raw.bc ?? null,
    sellLots: raw.sc ?? null,
    bids: parseDepthLevels(raw.b),
    asks: parseDepthLevels(raw.s),
  }
}

function parseDepthLevels(value: z.output<typeof DepthLevelFrameSchema>[] | undefined): DepthUpdateLevel[] {
  return (value ?? []).flatMap((raw): DepthUpdateLevel[] => {
    const index = raw.i ?? null
    const price = raw.p ?? null
    if (index === null || index < 0 || price === null) return []
    return [{
      index,
      level: { price, lots: raw.l ?? 0, orderCount: raw.o ?? 0 },
    }]
  })
}

function parseDepthTrades(raw: z.output<typeof DepthTradesFrameSchema> | null | undefined): DepthUpdate["trades"] {
  if (!raw) return null
  const items = raw.t.flatMap((trade): DepthUpdateTrade[] => {
    const price = trade.p ?? null
    if (price === null) return []
    return [{
      id: trade.id,
      price,
      lots: trade.l ?? 0,
      side: trade.d === "s" ? "SELL" : "BUY",
      buyer: trade.b ?? null,
      seller: trade.s ?? null,
    }]
  })
  return { replace: raw.mt === "f", maxLength: raw.l ?? null, items }
}

export const marketOperations = {
  screenerRetrieveV2: defineOperation<ScreenerRetrieveV2Data, ScreenerRetrieveV2Variables>(
    "screenerRetrieveV2",
    "query",
    "query screenerRetrieveV2($id: String, $assetVertical: AssetVertical, $sectorId: String, $investmentType: InvestmentType) { screenerRetrieveV2(uid: $id, assetVertical: $assetVertical, sector: $sectorId, investmentType: $investmentType) { uid result { pitId searchAfter totalSize sortBy sortDirection } } }",
  ),
  screenerRetrieveResultV2: defineOperation<ScreenerResultV2Data, ScreenerResultV2Variables>(
    "screenerRetrieveResultV2",
    "query",
    "query screenerRetrieveResultV2($pitId: String, $searchAfter: String, $sortBy: String, $sortDirection: String, $assetVertical: AssetVertical, $investmentType: InvestmentType, $filters: [ScreenerResultInputItem!], $columns: [ScreenerColumnInput!]) { screenerRetrieveResultV2(request: { pitId: $pitId searchAfter: $searchAfter sortBy: $sortBy sortDirection: $sortDirection assetVertical: $assetVertical investmentType: $investmentType selectedFilterItems: $filters selectedColumns: $columns } ) { pitId searchAfter totalSize sortBy sortDirection instruments { uid symbol values { key value situation } } } }",
  ),
  getInstrument: defineOperation<InstrumentData, InstrumentVariables>(
    "getInstrument",
    "query",
    "query getInstrument($instrumentId: String!) { instrument(uid: $instrumentId) { __typename ... on Future { underlyingInstrumentUid } } }",
  ),
  searchByAdvancedTools: defineOperation<AdvancedToolSearchData, AdvancedToolSearchVariables>(
    "searchByAdvancedTools",
    "query",
    "query searchByAdvancedTools($query: String!, $tool: DiscoveryAdvancedTool!, $page: Int!, $size: Int!) { searchByAdvancedTools(query: $query, tool: $tool, page: $page, size: $size) { results { __typename uid type ... on InstrumentSearchResultItem { symbol } } page hasNext } }",
  ),
  // The provider checksums the document it registered, so the selection set is
  // sent as published even where the app maps only part of it.
  futureDetail: defineOperation<FutureDetailData, FutureDetailVariables>(
    "futureDetail",
    "query",
    "query futureDetail($instrumentUid: String!) { futureDetail(futureUid: $instrumentUid) { contractDetails { title description items { key text value info { title url } } } stats { title description items { key text value info { title url } } } } }",
  ),
} as const

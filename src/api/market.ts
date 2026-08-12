import { defineOperation } from "./graphql.ts"

export interface ScreenerInstrumentValue {
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
  [key: string]: unknown
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
  [key: string]: unknown
}

export interface InstrumentData {
  instrument?: {
    __typename: string
    underlyingInstrumentUid?: string | null
  } | null
}

export interface InstrumentVariables {
  instrumentId: string
  [key: string]: unknown
}

export interface AdvancedToolSearchResult {
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
  [key: string]: unknown
}

export interface FutureDetailItem {
  key: string
  text: string
  value: string | null
  info: { title: string; url: string } | null
}

export interface FutureDetailSection {
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
  [key: string]: unknown
}

export interface AdvancedChartEntry {
  o: number
  h: number
  l: number
  c: number
  d: number | null
  v2: number | null
  ed: number | null
  m: boolean | null
}

export interface AdvancedChartData {
  advancedChart?: {
    data: AdvancedChartEntry[]
    timeRange: string | null
    selectedInterval: { id: string; displayName: string } | null
    availableIntervalsByTimeRange: {
      timeRange: string
      intervals: { id: string; displayName: string }[]
    }[]
    currency: string | null
    intervalMs: number | null
    missingTimestampLabel: string | null
    marketDataProviderInMaintenance: boolean | null
  } | null
}

export interface AdvancedChartVariables {
  instrumentUid: string
  selectedIndicatorIds: string[]
  timeRange: string
  intervalId: string
  [key: string]: unknown
}

export interface CandlestickChartEntry {
  o: number
  h: number
  l: number
  c: number
  d: number | null
  v: number | null
  ed: number | null
  ts: string | null
}

export interface CandlestickChartData {
  candlestickChartV2?: {
    data: CandlestickChartEntry[]
    timeRange: string
    availableTimeRanges: string[]
    currency: string
    maxCount: number
    intervalMs: number
    missingTimestampLabel: string | null
    rangeStartPrice: number
    marketDataProviderInMaintenance: boolean | null
    sessionInfoFeatureEnabled: boolean | null
  } | null
}

export interface CandlestickChartVariables {
  instrumentId: string
  timeRange: string
  currency: string
  [key: string]: unknown
}

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

export function parseFuturePriceUpdate(data: string): FuturePriceUpdate | null {
  let raw: { s?: unknown; p?: unknown; a?: unknown; b?: unknown; ss?: unknown; ts?: unknown }
  try {
    raw = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof raw.s !== "string" || raw.s.length === 0) return null
  return {
    symbol: raw.s,
    lastPrice: numberOrNull(raw.p),
    ask: numberOrNull(raw.a),
    bid: numberOrNull(raw.b),
    sessionStatus: typeof raw.ss === "string" ? raw.ss : null,
    timestamp: numberOrNull(raw.ts) ?? 0,
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
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
  futureDetail: defineOperation<FutureDetailData, FutureDetailVariables>(
    "futureDetail",
    "query",
    "query futureDetail($instrumentUid: String!) { futureDetail(futureUid: $instrumentUid) { contractDetails { title description items { key text value info { title url } } } stats { title description items { key text value info { title url } } } } }",
  ),
  advancedChart: defineOperation<AdvancedChartData, AdvancedChartVariables>(
    "advancedChart",
    "query",
    "query advancedChart($instrumentUid: String!, $selectedIndicatorIds: [String!], $timeRange: TimeRange, $intervalId: String) { advancedChart(instrumentUid: $instrumentUid, selectedIndicatorIds: $selectedIndicatorIds, timeRange: $timeRange, intervalId: $intervalId, availableIndicatorPackVersion: \"1\") { data { o h l c v2 d ed m } currency availableIntervalsByTimeRange { timeRange intervals { id displayName } } timeRange selectedInterval { id displayName } intervalMs missingTimestampLabel marketDataProviderInMaintenance } }",
  ),
  candlestickChartV2: defineOperation<CandlestickChartData, CandlestickChartVariables>(
    "candlestickChartV2",
    "query",
    "query candlestickChartV2($instrumentId: String!, $timeRange: TimeRange, $currency: CurrencyCode) { candlestickChartV2(instrumentUid: $instrumentId, timeRange: $timeRange, currency: $currency) { data { o h l c d v ed ts } timeRange availableTimeRanges currency maxCount intervalMs missingTimestampLabel rangeStartPrice marketDataProviderInMaintenance sessionInfoFeatureEnabled } }",
  ),
} as const

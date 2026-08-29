import { defineOperation } from "./graphql.ts"

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

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
} as const

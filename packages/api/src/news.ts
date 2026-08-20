import { defineOperation } from "./graphql.ts"

export interface ArticlePreview {
  uid: string
  type: string | null
  title: string
  description: string | null
  publishedAt: string | null
}

export interface ArticlesV2Data {
  articlesV2?: {
    articles: ArticlePreview[]
    page: number
    hasMore: boolean
  }
}

export interface ArticlesV2Variables {
  instrumentId: string | null
  isFeatured: boolean | null
  assetVertical: string
  investmentType: string
  page: number
  pageSize: number
  type: string
  cryptoCurrencySymbol: string | null
}

export interface ArticleDetail {
  uid: string
  title: string
  body: string | null
  publishedAt: string | null
  url: string | null
  attachmentUrls: string[] | null
}

export interface ArticleData {
  article?: ArticleDetail | null
}

export interface ArticleVariables {
  newsId: string
  cryptoCurrencySymbol: string | null
}

export const newsOperations = {
  articlesV2: defineOperation<ArticlesV2Data, ArticlesV2Variables>(
    "articlesV2",
    "query",
    "query articlesV2($instrumentId: String, $isFeatured: Boolean, $assetVertical: AssetVertical, $investmentType: InvestmentType, $page: Int!, $pageSize: Int!, $type: ArticleTypeFilter!, $cryptoCurrencySymbol: String) { articlesV2(stockUid: $instrumentId, featured: $isFeatured, assetVertical: $assetVertical, investmentType: $investmentType, type: $type, page: $page, size: $pageSize, cryptoCurrencySymbol: $cryptoCurrencySymbol) { articles { uid type title description publishedAt } page hasMore pageSize } }",
  ),
  article: defineOperation<ArticleData, ArticleVariables>(
    "article",
    "query",
    "query article($newsId: String!, $cryptoCurrencySymbol: String) { article(uid: $newsId, cryptoCurrencySymbol: $cryptoCurrencySymbol) { uid title body publishedAt url attachmentUrls } }",
  ),
} as const

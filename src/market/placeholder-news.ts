import type { NewsArticle, NewsSource } from "./news.ts"

// Placeholder news used until the provider news operations are wired through
// src/api. Values are illustrative, not live.

const SAMPLE_NEWS: NewsArticle[] = [
  { uid: "n1", instrumentSymbol: "XU030", tag: "Endeks", headline: "BIST 30 güne yükselişle başladı", body: "Endeks vadeli kontratlarında işlem hacmi arttı.", publishedAt: null },
  { uid: "n2", instrumentSymbol: "THYAO", tag: "Şirket", headline: "THY yolcu trafiği verilerini açıkladı", body: "Aylık yolcu sayısı beklentileri aştı.", publishedAt: null },
  { uid: "n3", instrumentSymbol: "XAUTRY", tag: "Emtia", headline: "Altın vadeli kontratlar rekor tazeledi", body: "Ons altındaki yükseliş vadeli fiyatlara yansıdı.", publishedAt: null },
  { uid: "n4", instrumentSymbol: "GARAN", tag: "Banka", headline: "Bankacılık endeksi baskı altında", body: "Vadeli banka kontratlarında satış görüldü.", publishedAt: null },
]

export class PlaceholderNewsSource implements NewsSource {
  async listNews(options: { instrumentSymbol?: string } = {}): Promise<NewsArticle[]> {
    if (!options.instrumentSymbol) return SAMPLE_NEWS
    return SAMPLE_NEWS.filter((article) => article.instrumentSymbol === options.instrumentSymbol)
  }
}

const HISTORY_URL = "https://markets.fintables.com/barbar/udf/history"
const FIVE_MINUTE_RESOLUTION = "5"

export interface HistoricalBar {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

export interface HistoricalBarSource {
  loadFiveMinuteBars(
    symbol: string,
    from: number,
    to: number,
    options?: { signal?: AbortSignal },
  ): Promise<HistoricalBar[]>
}

export type HistoricalBarRequest = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

interface UdfHistoryResponse {
  s?: unknown
  t?: unknown
  o?: unknown
  h?: unknown
  l?: unknown
  c?: unknown
  v?: unknown
}

export class HttpHistoricalBarSource implements HistoricalBarSource {
  constructor(
    private readonly request: HistoricalBarRequest = fetch,
    private readonly endpoint = HISTORY_URL,
  ) {}

  async loadFiveMinuteBars(
    symbol: string,
    from: number,
    to: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<HistoricalBar[]> {
    const url = new URL(this.endpoint)
    url.searchParams.set("symbol", symbol)
    url.searchParams.set("resolution", FIVE_MINUTE_RESOLUTION)
    url.searchParams.set("from", String(Math.floor(from / 1_000)))
    url.searchParams.set("to", String(Math.floor(to / 1_000)))
    url.searchParams.set("currencyCode", "TRY")

    const response = await this.request(url, {
      headers: { accept: "application/json" },
      signal: options.signal,
    })
    if (!response.ok) {
      const body = (await response.text()).slice(0, 240)
      throw new Error(`Historical candle API returned HTTP ${response.status}: ${body}`)
    }

    const payload = await response.json() as UdfHistoryResponse
    if (payload.s === "no_data") return []
    if (payload.s !== "ok") throw new Error("Historical candle API returned an unsuccessful response")

    const timestamps = numericArray(payload.t, "timestamps")
    const opens = nullableNumericArray(payload.o, "opens")
    const highs = nullableNumericArray(payload.h, "highs")
    const lows = nullableNumericArray(payload.l, "lows")
    const closes = nullableNumericArray(payload.c, "closes")
    const volumes = nullableNumericArray(payload.v, "volumes")
    const lengths = [opens.length, highs.length, lows.length, closes.length, volumes.length]
    if (lengths.some((length) => length !== timestamps.length)) {
      throw new Error("Historical candle API returned misaligned OHLCV arrays")
    }

    return timestamps.flatMap((timestampSeconds, index) => {
      const open = opens[index]!
      const high = highs[index]!
      const low = lows[index]!
      const close = closes[index]!
      if (open === null || high === null || low === null || close === null) return []
      if (high < low) return []
      return [{
        timestamp: timestampSeconds * 1_000,
        open,
        high,
        low,
        close,
        volume: volumes[index]!,
      }]
    }).sort((left, right) => left.timestamp - right.timestamp)
  }
}

function numericArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error(`Historical candle API returned invalid ${label}`)
  }
  return value as number[]
}

function nullableNumericArray(value: unknown, label: string): Array<number | null> {
  if (!Array.isArray(value) || value.some((item) => item !== null && (typeof item !== "number" || !Number.isFinite(item)))) {
    throw new Error(`Historical candle API returned invalid ${label}`)
  }
  return value as Array<number | null>
}

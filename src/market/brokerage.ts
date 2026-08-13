// Which brokerage houses accumulated or distributed a stock over a date range.
// The provider reports the two sides separately: a house can appear on both.
export type BrokerageSide = "BUYER" | "SELLER"

export interface BrokerageShare {
  brokerage: string
  netLots: number
  // Volume-weighted average price this house traded at over the range.
  averagePrice: number
  percentage: number
}

// `null` start means the provider's own default (the current session); a null
// end with a set start asks for that single day.
export interface BrokerageDateRange {
  start: string | null
  end: string | null
}

// The provider names its presets in its own language; the range itself carries
// everything needed to label them, so only the dates are kept.
export interface BrokerageDatePreset {
  range: BrokerageDateRange
  isDefault: boolean
}

export interface BrokerageDistribution {
  side: BrokerageSide
  // Ranked by net lots, largest first.
  shares: BrokerageShare[]
  // How many leading houses the provider groups into its headline share.
  topCount: number
  topPercentage: number
  topLots: number
  otherLots: number
  lastUpdate: string | null
  // True while the range includes the open session, so the figures still move.
  live: boolean
  presets: BrokerageDatePreset[]
  // Every trading day the provider will report on, newest first.
  availableDates: string[]
}

export interface BrokerageDistributionRequest {
  // The VIOP contract's own uid; the source resolves the underlying stock behind it.
  instrumentUid: string
  side: BrokerageSide
  range: BrokerageDateRange
  signal?: AbortSignal
}

export interface BrokerageDistributionSource {
  loadDistribution(request: BrokerageDistributionRequest): Promise<BrokerageDistribution>
}

export const DEFAULT_BROKERAGE_RANGE: BrokerageDateRange = { start: null, end: null }

export function isSameRange(left: BrokerageDateRange, right: BrokerageDateRange): boolean {
  return left.start === right.start && left.end === right.end
}

// Names the active range for the panel header, matching what the popup listed.
export function describeRange(range: BrokerageDateRange, presets: BrokerageDatePreset[]): string {
  const preset = presets.find((entry) => isSameRange(entry.range, range))
  return preset ? describePreset(preset) : describeDates(range) || "Today"
}

// Presets always run back from the current session, so their span reads as
// "Last N days". A range picked by hand is named by its dates instead.
export function describePreset(preset: BrokerageDatePreset): string {
  if (!preset.range.start) return "Today"
  const days = spanDays(preset.range)
  return days > 1 ? `Last ${days} days` : formatDay(preset.range.start)
}

// "12 – 13 Aug" for a span, "13 Aug" for a single day, empty for the session.
export function describeDates(range: BrokerageDateRange): string {
  if (!range.start) return ""
  if (!range.end || range.end === range.start) return formatDay(range.start)
  const [startYear, startMonth, startDay] = range.start.split("-")
  const sameMonth = startYear && startMonth && range.end.startsWith(`${startYear}-${startMonth}`)
  return sameMonth
    ? `${Number(startDay)} – ${formatDay(range.end)}`
    : `${formatDay(range.start)} – ${formatDay(range.end)}`
}

// "2026-08-13" reads as "13 Aug"; the provider's own dates are ISO days.
export function formatDay(date: string): string {
  const [, month, day] = date.split("-")
  if (!month || !day) return date
  const name = MONTHS[Number(month) - 1]
  return name ? `${Number(day)} ${name}` : date
}

// Inclusive day count across a range, so 12th to 13th is two days.
function spanDays(range: BrokerageDateRange): number {
  if (!range.start || !range.end) return 1
  const start = Date.parse(`${range.start}T00:00:00Z`)
  const end = Date.parse(`${range.end}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 1
  return Math.round((end - start) / 86_400_000) + 1
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

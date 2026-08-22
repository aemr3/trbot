/**
 * The headline share above a broker table.
 *
 * The feeds rank every house and group nothing, so the leading-houses figure the
 * panel prints is computed here. Five is the group the vendor's own screens use,
 * and the panel names the count it was given, so the number is a choice rather
 * than an assumption baked into the layout.
 */

export const HEADLINE_COUNT = 5

export interface BrokerHeadline {
  topCount: number
  topPercentage: number
  topLots: number
  otherLots: number
}

export interface HeadlineRow {
  /** A magnitude: the direction belongs to the side or the mode, not the row. */
  lots: number
  percentage: number
}

/** Summarizes rows that are already ranked largest first. */
export function headlineShare(rows: HeadlineRow[], topCount = HEADLINE_COUNT): BrokerHeadline {
  const leading = rows.slice(0, topCount)
  const rest = rows.slice(topCount)
  const sum = (values: HeadlineRow[], pick: (row: HeadlineRow) => number): number =>
    values.reduce((total, row) => total + pick(row), 0)
  return {
    topCount: leading.length,
    topPercentage: sum(leading, (row) => row.percentage),
    topLots: sum(leading, (row) => row.lots),
    otherLots: sum(rest, (row) => row.lots),
  }
}

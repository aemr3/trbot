import { Type } from "@earendil-works/pi-ai"

export interface ResultPage {
  offset: number
  limit: number
  returned: number
  /** Null only when an upstream service does not reveal the complete result count. */
  total: number | null
  hasMore: boolean
  nextOffset: number | null
}

export interface PaginatedValues<T> {
  values: T[]
  page: ResultPage
}

export function paginationOffset(maximum = 100_000) {
  return Type.Optional(Type.Integer({
    description: "Zero-based results to skip. To continue, pass page.nextOffset with the same filters and sorting.",
    minimum: 0,
    maximum,
    default: 0,
  }))
}

/** Pages a stable, already-filtered and sorted result set from its beginning. */
export function paginate<T>(values: T[], offset: number | undefined, limit: number): PaginatedValues<T> {
  const start = offset ?? 0
  const returned = values.slice(start, start + limit)
  return {
    values: returned,
    page: resultPage(start, limit, returned.length, values.length, start + returned.length < values.length),
  }
}

/** Keeps the newest-first paging behavior while returning each candle page chronologically. */
export function paginateNewest<T>(
  values: T[],
  offset: number | undefined,
  limit: number,
): PaginatedValues<T> {
  const skipped = offset ?? 0
  const end = Math.max(0, values.length - skipped)
  const start = Math.max(0, end - limit)
  const returned = values.slice(start, end)
  return {
    values: returned,
    page: resultPage(skipped, limit, returned.length, values.length, start > 0),
  }
}

export function paginationHint(page: ResultPage): string {
  return page.nextOffset === null
    ? ""
    : ` More results are available; continue with offset ${page.nextOffset}.`
}

export function resultPage(
  offset: number,
  limit: number,
  returned: number,
  total: number | null,
  hasMore: boolean,
): ResultPage {
  return {
    offset,
    limit,
    returned,
    total,
    hasMore,
    nextOffset: hasMore ? offset + returned : null,
  }
}

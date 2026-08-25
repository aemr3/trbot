import { expect, test } from "bun:test"
import { paginate, paginateNewest } from "./pagination.ts"

test("pages a stable result set and identifies its continuation", () => {
  expect(paginate([1, 2, 3, 4, 5], 2, 2)).toEqual({
    values: [3, 4],
    page: {
      offset: 2,
      limit: 2,
      returned: 2,
      total: 5,
      hasMore: true,
      nextOffset: 4,
    },
  })
})

test("pages candles from newest to older while keeping each page chronological", () => {
  expect(paginateNewest([1, 2, 3, 4], 0, 2)).toEqual({
    values: [3, 4],
    page: {
      offset: 0,
      limit: 2,
      returned: 2,
      total: 4,
      hasMore: true,
      nextOffset: 2,
    },
  })
  expect(paginateNewest([1, 2, 3, 4], 2, 2)).toEqual({
    values: [1, 2],
    page: {
      offset: 2,
      limit: 2,
      returned: 2,
      total: 4,
      hasMore: false,
      nextOffset: null,
    },
  })
})

test("an offset beyond the result set returns a completed empty page", () => {
  expect(paginate([1, 2], 5, 2)).toEqual({
    values: [],
    page: {
      offset: 5,
      limit: 2,
      returned: 0,
      total: 2,
      hasMore: false,
      nextOffset: null,
    },
  })
})

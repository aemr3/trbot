import { describe, expect, test } from "bun:test"
import { parseErrorBody } from "./error.ts"

describe("protocol error payloads", () => {
  test("parses a known error and keeps its message", () => {
    const error = parseErrorBody({ error: { code: "not_found", message: "No such instrument" } })

    expect(error?.code).toBe("not_found")
    expect(error?.message).toBe("No such instrument")
  })

  test("uses the code when an older response has no message", () => {
    const error = parseErrorBody({ error: { code: "upstream_unavailable" } })

    expect(error?.code).toBe("upstream_unavailable")
    expect(error?.message).toBe("upstream_unavailable")
  })

  test("rejects unknown codes and malformed envelopes", () => {
    expect(parseErrorBody({ error: { code: "mystery", message: "No" } })).toBeNull()
    expect(parseErrorBody({ code: "not_found" })).toBeNull()
  })
})

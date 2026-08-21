import { expect, test } from "bun:test"
import { ChatPermissionReplySchema } from "./permission.ts"

test("permission denial accepts a bounded optional user reason", () => {
  expect(ChatPermissionReplySchema.parse({
    decision: "DENY",
    reason: "  The entry is too late  ",
  })).toEqual({ decision: "DENY", reason: "The entry is too late" })

  expect(ChatPermissionReplySchema.safeParse({ decision: "DENY", reason: "" }).success).toBe(false)
  expect(ChatPermissionReplySchema.safeParse({ decision: "DENY", reason: "x".repeat(1_001) }).success).toBe(false)
})

test("permission approval requires an explicit scope", () => {
  expect(ChatPermissionReplySchema.parse({ decision: "ALLOW", scope: "ONCE" })).toEqual({
    decision: "ALLOW",
    scope: "ONCE",
  })
  expect(ChatPermissionReplySchema.parse({ decision: "ALLOW", scope: "SESSION" })).toEqual({
    decision: "ALLOW",
    scope: "SESSION",
  })
  expect(ChatPermissionReplySchema.safeParse({ decision: "ALLOW" }).success).toBe(false)
})

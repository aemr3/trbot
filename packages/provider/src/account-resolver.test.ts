import { expect, test } from "bun:test"
import { providerApiClient } from "@trbot/api/provider-client.test-fixture.ts"
import { ApiAccountResolver } from "./account-resolver.ts"

test("resolves the active TRY account once per provider session", async () => {
  let overviewCalls = 0
  const client = providerApiClient(() => {
    overviewCalls += 1
    return {
      overviewV7: {
        accounts: [
          { accountUid: "usd", status: "ACTIVE", currency: "USD" },
          { accountUid: "try", status: "ACTIVE", currency: "TRY" },
        ],
      },
    }
  })
  const resolver = new ApiAccountResolver(client)

  expect(await Promise.all([
    resolver.getActiveTryAccountUid("member"),
    resolver.getActiveTryAccountUid("member"),
  ])).toEqual(["try", "try"])
  expect(await resolver.getActiveTryAccountUid("member")).toBe("try")
  expect(overviewCalls).toBe(1)
})

test("retries account resolution after a failed lookup", async () => {
  let overviewCalls = 0
  const client = providerApiClient(() => {
    overviewCalls += 1
    return overviewCalls === 1
      ? { overviewV7: { accounts: [] } }
      : { overviewV7: { accounts: [{ accountUid: "try", status: "ACTIVE", currency: "TRY" }] } }
  })
  const resolver = new ApiAccountResolver(client)

  await expect(resolver.getActiveTryAccountUid("member")).rejects.toThrow("No active TRY investment account")
  expect(await resolver.getActiveTryAccountUid("member")).toBe("try")
  expect(overviewCalls).toBe(2)
})

import { expect, test } from "bun:test"
import { ApiMemberFeatureSource } from "./features.ts"
import { providerApiClient } from "@trbot/api/provider-client.test-fixture.ts"

function client(flags: { featureName: string; enabled: boolean }[]) {
  return providerApiClient(() => ({ memberFeatures: flags }), { memberUid: "member-1" })
}

test("maps the provider's flags onto the entitlements the app cares about", async () => {
  const source = new ApiMemberFeatureSource(client([
    { featureName: "TR_DEPTH", enabled: true },
    { featureName: "MIDAS_PRO", enabled: true },
    { featureName: "CANDLESTICK_CHART", enabled: true },
  ]))

  const features = await source.loadFeatures()

  expect(features.has("MARKET_DEPTH")).toBeTrue()
  expect(features.has("SUBSCRIPTION")).toBeTrue()
})

test("treats a disabled or missing flag as no entitlement", async () => {
  const disabled = new ApiMemberFeatureSource(client([
    { featureName: "TR_DEPTH", enabled: false },
    { featureName: "MIDAS_PRO", enabled: true },
  ]))
  const absent = new ApiMemberFeatureSource(client([]))

  expect((await disabled.loadFeatures()).has("MARKET_DEPTH")).toBeFalse()
  expect((await absent.loadFeatures()).has("MARKET_DEPTH")).toBeFalse()
  expect((await absent.loadFeatures()).has("SUBSCRIPTION")).toBeFalse()
})

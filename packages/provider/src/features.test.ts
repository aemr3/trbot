import { expect, test } from "bun:test"
import { ApiMemberFeatureSource } from "./features.ts"

function client(flags: { featureName: string; enabled: boolean }[]) {
  return {
    authenticate: async () => ({ accessToken: "token", refreshToken: null, memberUid: "member-1" }),
    call: async () => ({ memberFeatures: flags }),
  }
}

test("maps the provider's flags onto the entitlements the app cares about", async () => {
  const source = new ApiMemberFeatureSource(client([
    { featureName: "TR_DEPTH", enabled: true },
    { featureName: "MIDAS_PRO", enabled: true },
    { featureName: "CANDLESTICK_CHART", enabled: true },
  ]) as never)

  const features = await source.loadFeatures()

  expect(features.has("MARKET_DEPTH")).toBeTrue()
  expect(features.has("SUBSCRIPTION")).toBeTrue()
})

test("treats a disabled or missing flag as no entitlement", async () => {
  const disabled = new ApiMemberFeatureSource(client([
    { featureName: "TR_DEPTH", enabled: false },
    { featureName: "MIDAS_PRO", enabled: true },
  ]) as never)
  const absent = new ApiMemberFeatureSource(client([]) as never)

  expect((await disabled.loadFeatures()).has("MARKET_DEPTH")).toBeFalse()
  expect((await absent.loadFeatures()).has("MARKET_DEPTH")).toBeFalse()
  expect((await absent.loadFeatures()).has("SUBSCRIPTION")).toBeFalse()
})

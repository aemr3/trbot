import { fauxProvider, type Api, type Model } from "@earendil-works/pi-ai"

/** A complete harness model for server tests that do not call the model itself. */
export function testModel(id: string): Model<Api> {
  return fauxProvider({ models: [{ id, reasoning: true }] }).getModel()
}

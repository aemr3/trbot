import type { AuthState } from "@trbot/auth/state.ts"
import type { AuthStore } from "@trbot/auth/store.ts"
import { z } from "zod"
import { ApiClient } from "./client.ts"
import type { HttpRequest, HttpResponse, Transport } from "./transport.ts"

const GraphqlRequestSchema = z.object({
  operationName: z.string(),
  variables: z.record(z.string(), z.json()),
})

export type ProviderTestRequest = z.output<typeof GraphqlRequestSchema>

class StaticAuthStore implements AuthStore {
  constructor(private readonly state: AuthState) {}

  async get(): Promise<AuthState> {
    return this.state
  }

  async latest(): Promise<AuthState> {
    return this.state
  }

  async put(): Promise<void> {}
}

class HandlerTransport<TResponse> implements Transport {
  constructor(private readonly handler: (request: ProviderTestRequest) => TResponse | Promise<TResponse>) {}

  async request(request: HttpRequest): Promise<HttpResponse> {
    const body = GraphqlRequestSchema.parse(JSON.parse(request.body))
    return { status: 200, body: JSON.stringify({ data: await this.handler(body) }) }
  }
}

/** A real authenticated API client whose transport is controlled by the test. */
export function providerApiClient<TResponse>(
  handler: (request: ProviderTestRequest) => TResponse | Promise<TResponse>,
  options: { memberUid?: string } = {},
): ApiClient {
  const expiry = 4_102_444_800_000
  const tokenPayload = Buffer.from(JSON.stringify({ exp: Math.floor(expiry / 1_000) })).toString("base64url")
  const state: AuthState = {
    accountKey: "provider-test",
    memberUid: options.memberUid ?? "member-test",
    accessToken: `header.${tokenPayload}.signature`,
    refreshToken: "refresh-test",
    accessTokenExpiresAt: expiry,
    deviceId: "device-test",
    userAgentUid: "agent-test",
    privateKeyPem: "unused",
    publicKeyBase64: "unused",
    loginReferenceCode: null,
    createdAt: 0,
    updatedAt: 0,
  }
  return new ApiClient({ accountKey: state.accountKey, store: new StaticAuthStore(state), transport: new HandlerTransport(handler) })
}

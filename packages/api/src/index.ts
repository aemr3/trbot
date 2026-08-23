import type { OpenAuthSession } from "@trbot/auth/session.ts"
import { ApiClient } from "./client.ts"
import { FetchTransport } from "./transport.ts"

export interface ApiCredentials {
  username: string
  password: string
}

export interface ApiClientHandle {
  client: ApiClient
  close(): void
}

export async function createApiClient(
  openAuthSession: OpenAuthSession,
  credentials: ApiCredentials,
): Promise<ApiClientHandle> {
  const session = await openAuthSession()
  const transport = new FetchTransport()
  const client = new ApiClient({
    ...credentials,
    store: session.store,
    transport,
  })

  return {
    client,
    close: () => {
      transport.close()
      session.close()
    },
  }
}

// Rebuilds a client from the most recently stored session. The optional
// credentials let the client re-login unattended when its tokens have lapsed.
export async function resumeApiClient(
  openAuthSession: OpenAuthSession,
  credentials: ApiCredentials | null,
): Promise<ApiClientHandle | null> {
  const session = await openAuthSession()
  try {
    const state = await session.store.latest()
    if (!state) {
      session.close()
      return null
    }

    const transport = new FetchTransport()
    return {
      client: new ApiClient({
        accountKey: state.accountKey,
        username: credentials?.username,
        password: credentials?.password,
        store: session.store,
        transport,
      }),
      close: () => {
        transport.close()
        session.close()
      },
    }
  } catch (error) {
    session.close()
    throw error
  }
}

export * from "./client.ts"
export * from "./graphql.ts"

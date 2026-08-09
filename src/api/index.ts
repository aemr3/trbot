import type { AppConfig } from "../config.ts"
import { openDatabase } from "../db/client.ts"
import { DrizzleAuthStore } from "../db/auth-store.ts"
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

export async function createApiClient(config: AppConfig, credentials: ApiCredentials): Promise<ApiClientHandle> {
  const connection = await openDatabase(config.databaseUrl)
  const client = new ApiClient({
    ...credentials,
    store: new DrizzleAuthStore(connection.db),
    transport: new FetchTransport(),
  })

  return {
    client,
    close: connection.close,
  }
}

export async function resumeApiClient(config: AppConfig): Promise<ApiClientHandle | null> {
  const connection = await openDatabase(config.databaseUrl)
  try {
    const store = new DrizzleAuthStore(connection.db)
    const state = await store.latest()
    if (!state) {
      connection.close()
      return null
    }

    return {
      client: new ApiClient({
        accountKey: state.accountKey,
        username: config.credentials?.username,
        password: config.credentials?.password,
        store,
        transport: new FetchTransport(),
      }),
      close: connection.close,
    }
  } catch (error) {
    connection.close()
    throw error
  }
}

export * from "./client.ts"
export * from "./graphql.ts"

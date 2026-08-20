import { z } from "zod"
import { ProtocolErrorBodySchema, type ProtocolErrorBody } from "./error.ts"

/**
 * A model provider as a client sees it.
 *
 * Every provider the harness ships with is reported, connected or not, so the
 * terminal can offer the whole list without knowing what that list is. Credentials
 * live on the server: a client learns that a provider is connected and which account
 * it belongs to, never how to act as it.
 */
export interface AiProviderSummary {
  providerId: string
  name: string
  /** How this provider is authenticated. Both are possible for one provider. */
  authTypes: AiAuthType[]
  /** True when access comes from a subscription rather than metered billing. */
  isSubscription: boolean
  connected: boolean
  /** Where the harness resolved its credential from, for a status line. */
  source: string | null
  accountId: string | null
  connectedAt: number | null
  updatedAt: number | null
}

export const AiProviderSummarySchema: z.ZodType<AiProviderSummary> = z.object({
  providerId: z.string(),
  name: z.string(),
  authTypes: z.array(z.enum(["oauth", "api_key"])),
  isSubscription: z.boolean(),
  connected: z.boolean(),
  source: z.string().nullable(),
  accountId: z.string().nullable(),
  connectedAt: z.number().nullable(),
  updatedAt: z.number().nullable(),
})

export type AiAuthType = "oauth" | "api_key"

/**
 * A model a trader can pick right now.
 *
 * Only models whose provider is authenticated are reported, so a picker cannot offer
 * something that would fail on send. `thinkingLevels` is resolved by the server from
 * the model's own metadata, so no client works out what a model supports.
 */
export interface AiModelSummary {
  providerId: string
  providerName: string
  modelId: string
  name: string
  reasoning: boolean
  thinkingLevels: string[]
  contextWindow: number
}

export const AiModelSummarySchema: z.ZodType<AiModelSummary> = z.object({
  providerId: z.string(),
  providerName: z.string(),
  modelId: z.string(),
  name: z.string(),
  reasoning: z.boolean(),
  thinkingLevels: z.array(z.string()),
  contextWindow: z.number(),
})

/** Which model answers, and how hard it thinks. */
export interface AiModelChoice {
  providerId: string
  modelId: string
  /** Null leaves the model's own default effort alone. */
  reasoning: string | null
}

const RequiredTextSchema = z.string().refine((value) => value.trim().length > 0)

export const AiModelChoiceSchema: z.ZodType<AiModelChoice> = z.object({
  providerId: RequiredTextSchema,
  modelId: RequiredTextSchema,
  reasoning: RequiredTextSchema.nullable(),
})

/**
 * The chosen models: one for the market overview, one for a new chat session.
 *
 * Null means nothing has been chosen. There is no environment variable behind these,
 * so an unset choice is reported as unset and the terminal says which key sets it.
 */
export interface AiPreferences {
  overview: AiModelChoice | null
  chat: AiModelChoice | null
}

export const AiPreferencesSchema: z.ZodType<AiPreferences> = z.object({
  overview: AiModelChoiceSchema.nullable(),
  chat: AiModelChoiceSchema.nullable(),
})

/**
 * What a finished login hands to the server.
 *
 * A provider only redirects an authorization to a loopback address, and an API key is
 * typed by the trader, so a login runs where the trader is sitting and its result
 * travels inward — the same direction as the provider password on the sign-in route.
 * This is the only message in the protocol that carries a secret, and it only ever
 * travels this way.
 *
 * The credential itself is the harness's own record, passed through as it came: it is
 * a union whose fields differ per provider, and re-describing it here would mean
 * editing the protocol every time the harness learns a field. The server checks its
 * kind before storing it.
 */
export interface AiCredentials {
  providerId: string
  credential: z.output<typeof AiCredentialSchema>
}

export const AiCredentialSchema = z.object({
  type: z.enum(["oauth", "api_key"]),
}).catchall(z.unknown())

export const AiCredentialsSchema: z.ZodType<AiCredentials> = z.object({
  providerId: RequiredTextSchema,
  credential: AiCredentialSchema,
})

/** A choice the authorization flow asks the trader to make. */
export interface AiSelectOption {
  id: string
  label: string
  description?: string
}

/** A device-code login, for a machine with no browser of its own. */
export interface AiDeviceCode {
  userCode: string
  verificationUri: string
  expiresInSeconds?: number
}

/**
 * The terminal's side of an authorization.
 *
 * These mirror what a flow can ask for rather than what any one provider needs: the
 * harness speaks one neutral protocol for all of its providers, so an API key and a
 * subscription login differ only in which of these is called. Resolving a prompt with
 * an empty string cancels the login.
 */
export interface AiLoginOptions {
  signal?: AbortSignal
  /** Reported so a trader whose browser did not open can follow the link. */
  onAuthorizationUrl?: (url: string) => void
  onBrowserError?: (cause: unknown) => void
  /** A secret to type: an API key, or a token pasted from a provider's console. */
  onSecret?: (message: string) => Promise<string>
  /** A choice to make, such as browser or device-code login. */
  onSelect?: (message: string, options: AiSelectOption[]) => Promise<string>
  onDeviceCode?: (code: AiDeviceCode) => void
  /** Progress and instructions a flow reports as it goes. */
  onInfo?: (message: string) => void
  /**
   * Asked for the authorization code when the redirect could not be caught —
   * a machine with no browser, or one where the callback port is already taken.
   */
  onManualCode?: (message: string) => Promise<string>
}

/** The model providers, as a client drives them. */
export interface AiAccount {
  providers(): Promise<AiProviderSummary[]>
  /** Models usable now, across every connected provider. */
  models(): Promise<AiModelSummary[]>
  connect(providerId: string, authType: AiAuthType, options?: AiLoginOptions): Promise<AiProviderSummary>
  disconnect(providerId: string): Promise<void>
  preferences(): Promise<AiPreferences>
  setPreferences(preferences: AiPreferences): Promise<AiPreferences>
}

export type OverviewStreamFrame = { delta: string } | { heartbeat: true } | ProtocolErrorBody

export const OverviewStreamFrameSchema: z.ZodType<OverviewStreamFrame> = z.union([
  z.object({ delta: z.string() }),
  z.object({ heartbeat: z.literal(true) }),
  ProtocolErrorBodySchema,
])

import {
  InMemoryCredentialStore,
  createModels,
  type AuthInteraction,
  type Credential,
} from "@earendil-works/pi-ai"
import { builtinProviders } from "@earendil-works/pi-ai/providers/all"
import type {
  AiAccount,
  AiAuthType,
  AiCredentials,
  AiLoginOptions,
  AiModelSummary,
  AiPreferences,
  AiProviderSummary,
} from "@trbot/protocol/ai.ts"
import {
  AiPreferencesSchema,
  AiCredentialSchema,
  AiProviderSummarySchema,
  AiModelSummarySchema,
} from "@trbot/protocol/ai.ts"
import { OkResponseSchema, ROUTES } from "@trbot/protocol/routes.ts"
import { openExternalUrl } from "./browser.ts"
import type { HttpClient } from "./http.ts"
import { z } from "zod"

/**
 * Running a provider's authorization flow on this machine.
 *
 * Named as a seam because it reaches well outside the process — it binds a loopback
 * listener, opens a browser, exchanges a single-use code — so a test can drive the
 * mapping around it without performing a real authorization.
 */
export type HarnessLogin = (
  providerId: string,
  authType: AiAuthType,
  interaction: AuthInteraction,
) => Promise<Credential>

/**
 * The harness's own login, run through a credential store that forgets.
 *
 * The harness persists what a login produced, which is exactly what this side must
 * not do — so the store it writes to is in memory and dies with the process. What
 * survives is the credential it returns, which goes straight to the server.
 *
 * Every provider it ships with is registered, because which one a trader is
 * connecting is their choice, not a build-time decision.
 */
function harnessLogin(): HarnessLogin {
  const models = createModels({ credentials: new InMemoryCredentialStore() })
  for (const provider of builtinProviders()) models.setProvider(provider)
  return (providerId, authType, interaction) => models.login(providerId, authType, interaction)
}

export interface HttpAiAccountOptions {
  login?: HarnessLogin
  /**
   * Opening the authorization page. Injectable because it reaches outside the
   * process: a test that drove a login would otherwise open a real browser.
   */
  openUrl?: (url: string) => Promise<void>
}

/**
 * The model providers: connected here, owned by the server.
 *
 * A login runs on this machine because that is where it has to: a provider will only
 * redirect an authorization to `localhost`, it is the trader's browser that has to be
 * opened, and an API key is theirs to type. What crosses the wire afterwards is the
 * result — travelling inward, the same direction as the provider password on the
 * sign-in route — and the server stores it, refreshes it, and never hands it back.
 * Nothing is kept here.
 */
export class HttpAiAccount implements AiAccount {
  private readonly login: HarnessLogin
  private readonly openUrl: (url: string) => Promise<void>

  constructor(
    private readonly http: HttpClient,
    options: HttpAiAccountOptions = {},
  ) {
    this.login = options.login ?? harnessLogin()
    this.openUrl = options.openUrl ?? openExternalUrl
  }

  providers(): Promise<AiProviderSummary[]> {
    return this.http.get(ROUTES.aiProviders, z.array(AiProviderSummarySchema))
  }

  models(): Promise<AiModelSummary[]> {
    return this.http.get(ROUTES.aiModels, z.array(AiModelSummarySchema))
  }

  preferences(): Promise<AiPreferences> {
    return this.http.get(ROUTES.aiPreferences, AiPreferencesSchema)
  }

  setPreferences(preferences: AiPreferences): Promise<AiPreferences> {
    return this.http.put(ROUTES.aiPreferences, AiPreferencesSchema, { body: preferences })
  }

  /**
   * Connects one provider, answering whatever its flow asks for.
   *
   * The branches below are the harness's whole vocabulary, not one provider's: a
   * secret to type, a choice to make, an address to open, a code to paste. That is
   * why an API key and a subscription login are the same code path here.
   */
  async connect(
    providerId: string,
    authType: AiAuthType,
    options: AiLoginOptions = {},
  ): Promise<AiProviderSummary> {
    const credential = await this.login(providerId, authType, {
      // Required by the harness, which cancels the whole flow through it. Without one
      // from the caller there is nothing to cancel, so an unused signal stands in
      // rather than the flow becoming uncancellable.
      signal: options.signal ?? new AbortController().signal,
      notify: (event) => {
        if (event.type === "auth_url") {
          options.onAuthorizationUrl?.(event.url)
          // The harness only reports the address; opening it is this side's job. A
          // machine with no browser is not a failure: the modal shows the link, and
          // the prompt below takes a code pasted back by hand.
          void this.openUrl(event.url).catch((cause: unknown) => options.onBrowserError?.(cause))
          if (event.instructions) options.onInfo?.(event.instructions)
          return
        }
        if (event.type === "device_code") {
          const deviceCode = event.expiresInSeconds === undefined
            ? { userCode: event.userCode, verificationUri: event.verificationUri }
            : {
                userCode: event.userCode,
                verificationUri: event.verificationUri,
                expiresInSeconds: event.expiresInSeconds,
              }
          options.onDeviceCode?.(deviceCode)
          return
        }
        options.onInfo?.(event.message)
      },
      prompt: async (prompt) => {
        if (prompt.type === "select") {
          if (!options.onSelect) throw abortError()
          const chosen = await options.onSelect(prompt.message, [...prompt.options])
          if (!chosen) throw abortError()
          return chosen
        }
        // A secret and a pasted code are typed the same way but mean different
        // things, so they are offered as different callbacks: one is a credential
        // the trader holds, the other is a step in a flow already underway.
        const ask = prompt.type === "manual_code" ? options.onManualCode : options.onSecret
        if (!ask) throw abortError()
        const answer = await ask(prompt.message)
        if (!answer) throw abortError()
        return answer
      },
    })

    const credentials: AiCredentials = {
      providerId,
      credential: AiCredentialSchema.parse(credential),
    }
    const request = options.signal
      ? { body: credentials, signal: options.signal }
      : { body: credentials }
    return await this.http.post(ROUTES.aiProvider(providerId), AiProviderSummarySchema, request)
  }

  async disconnect(providerId: string): Promise<void> {
    await this.http.delete(ROUTES.aiProvider(providerId), OkResponseSchema)
  }
}

function abortError(): DOMException {
  return new DOMException("ChatGPT login cancelled", "AbortError")
}

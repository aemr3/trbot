import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai"
import type { AiCredentialRecord, AiCredentialStore } from "./credential-store.ts"
import { z } from "zod"

const CredentialTagSchema = z.object({ type: z.enum(["oauth", "api_key"]) }).loose()
export const CredentialInputSchema = z.preprocess((value) => value, CredentialTagSchema)

interface StoredCredentialsOptions {
  now?: () => number
}

/**
 * The harness's credential store, over this application's own table.
 *
 * The harness resolves and refreshes credentials itself, but it does not own where
 * they live — so this is the adapter, and it is the only part of credential handling
 * that stays ours. Everything it used to sit alongside (an expiry margin, a
 * single-flight refresh, a refresh call) belongs to the harness now.
 *
 * Rows are keyed by the harness's own provider id, so nothing here translates a name
 * and any of its providers can be connected at once.
 */
export class StoredCredentials implements CredentialStore {
  private readonly now: () => number

  /** One write at a time per provider, which is what `modify` promises. */
  private writes = new Map<string, Promise<unknown>>()

  constructor(
    private readonly store: AiCredentialStore,
    options: StoredCredentialsOptions = {},
  ) {
    this.now = options.now ?? Date.now
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const record = await this.store.get(providerId)
    return record ? asCredential(record.credential) : undefined
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const records = await this.store.list()
    const infos: CredentialInfo[] = []
    for (const record of records) {
      const credential = asCredential(record.credential)
      // A row nothing can read is a provider to reconnect, not a load failure.
      if (credential) infos.push({ providerId: record.providerId, type: credential.type })
    }
    return infos
  }

  /**
   * The only write path, serialized per provider so a refresh and a login cannot
   * interleave and lose a rotated token. One process holds this store — the same
   * invariant the monitors rely on — so a promise chain is the whole mechanism.
   */
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    const queued = this.writes.get(providerId) ?? Promise.resolve()
    const write = queued.then(async () => {
      const previous = await this.store.get(providerId)
      const current = previous ? asCredential(previous.credential) : undefined
      const next = await fn(current)
      if (!next) return current
      await this.store.put(this.toRecord(providerId, next, previous))
      return next
    })
    // Kept so the next writer waits for this one, whether or not it succeeded.
    this.writes.set(
      providerId,
      write.catch(() => undefined),
    )
    return write
  }

  async delete(providerId: string): Promise<void> {
    const queued = this.writes.get(providerId) ?? Promise.resolve()
    const write = queued.then(() => this.store.delete(providerId))
    this.writes.set(
      providerId,
      write.catch(() => undefined),
    )
    await write
  }

  private toRecord(
    providerId: string,
    credential: Credential,
    previous: AiCredentialRecord | null,
  ): AiCredentialRecord {
    const now = this.now()
    return {
      providerId,
      credential,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
  }
}

/**
 * A stored value read back as a credential.
 *
 * Only the discriminator is checked. Everything else in there is the harness's, and
 * a build that has learnt a new field must not have it validated away by an older
 * idea of the shape.
 */
export function asCredential(value: z.input<typeof CredentialInputSchema>): Credential | undefined {
  const parsed = CredentialInputSchema.safeParse(value)
  if (!parsed.success) return undefined
  // SAFETY: The harness explicitly owns credential fields beyond the validated
  // discriminator and accepts forward-compatible provider-specific additions.
  return parsed.data as Credential
}

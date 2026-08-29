import type { ApiClient } from "@trbot/api"
import { accountOperations } from "@trbot/api/account.ts"

type AccountResolverApiClient = Pick<ApiClient, "call">

/** Resolves the brokerage account selected for TRY trading once per provider session. */
export class ApiAccountResolver {
  private accountUid: Promise<string> | null = null

  constructor(private readonly client: AccountResolverApiClient) {}

  getActiveTryAccountUid(memberUid: string): Promise<string> {
    if (this.accountUid) return this.accountUid
    this.accountUid = this.loadActiveTryAccountUid(memberUid)
    return this.accountUid
  }

  private async loadActiveTryAccountUid(memberUid: string): Promise<string> {
    try {
      const overview = await this.client.call(
        accountOperations.overview,
        { memberId: memberUid, currencyCode: "TRY", period: "DAY" },
      )
      const account = overview.overviewV7?.accounts?.find(
        (candidate) => candidate.status === "ACTIVE" && candidate.currency === "TRY" && candidate.accountUid,
      )
      if (!account?.accountUid) throw new Error("No active TRY investment account was found")
      return account.accountUid
    } catch (error) {
      this.accountUid = null
      throw error
    }
  }
}

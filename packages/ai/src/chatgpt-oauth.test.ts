import { describe, expect, test } from "bun:test"
import { ChatGptOAuthClient, chatGptIdentity, chatGptRedirectUri } from "./chatgpt-oauth.ts"

describe("ChatGPT OAuth", () => {
  test("builds a PKCE authorization and exchanges the code it produces", async () => {
    let tokenBody = ""
    const client = new ChatGptOAuthClient({
      fetch: async (_input, init) => {
        tokenBody = String(init?.body)
        return Response.json({
          id_token: jwt({ email: "trader@example.com", chatgpt_account_id: "account-1" }),
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 900,
        })
      },
    })

    const redirectUri = chatGptRedirectUri()
    const authorization = await client.authorize(redirectUri)
    const authorize = new URL(authorization.authorizationUrl)
    expect(authorize.origin).toBe("https://auth.openai.com")
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256")
    expect(authorize.searchParams.get("redirect_uri")).toBe(redirectUri)
    expect(authorize.searchParams.get("state")).toBe(authorization.state)
    // The verifier stays here; only its hash is published.
    expect(authorize.searchParams.get("code_challenge")).not.toBe(authorization.verifier)

    const tokens = await client.exchange("authorization-code", redirectUri, authorization.verifier)
    expect(tokens).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 900 })
    expect(tokenBody).toContain("grant_type=authorization_code")
    expect(tokenBody).toContain("code=authorization-code")
    expect(tokenBody).toContain(`code_verifier=${authorization.verifier}`)
    expect(chatGptIdentity(tokens)).toEqual({ accountId: "account-1", email: "trader@example.com" })
  })

  test("gives each authorization its own verifier and state", async () => {
    const client = new ChatGptOAuthClient()
    const [first, second] = await Promise.all([
      client.authorize(chatGptRedirectUri()),
      client.authorize(chatGptRedirectUri()),
    ])
    expect(first.verifier).not.toBe(second.verifier)
    expect(first.state).not.toBe(second.state)
  })

  test("keeps the existing refresh token when rotation is omitted", async () => {
    const client = new ChatGptOAuthClient({
      fetch: async () => Response.json({ access_token: "access-new", expires_in: 600 }),
    })

    expect(await client.refresh("refresh-old")).toMatchObject({
      accessToken: "access-new",
      refreshToken: "refresh-old",
      expiresIn: 600,
    })
  })

  test("extracts account identity from the access token fallback", () => {
    expect(chatGptIdentity({
      idToken: null,
      accessToken: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-2" } }),
      refreshToken: "refresh",
      expiresIn: 3_600,
    })).toEqual({ accountId: "account-2", email: null })
  })
})

function jwt(payload: object): string {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`
}

import { describe, expect, test } from "bun:test"
import { ChatGptOAuthClient, chatGptIdentity } from "./chatgpt-oauth.ts"

describe("ChatGPT OAuth", () => {
  test("completes the browser PKCE callback and exchanges its code", async () => {
    const port = availablePort()
    let tokenBody = ""
    const client = new ChatGptOAuthClient({
      callbackPort: port,
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

    const tokens = await client.login({
      openUrl: async (authorizationUrl) => {
        const authorize = new URL(authorizationUrl)
        expect(authorize.origin).toBe("https://auth.openai.com")
        expect(authorize.searchParams.get("code_challenge_method")).toBe("S256")
        expect(authorize.searchParams.get("redirect_uri")).toBe(`http://localhost:${port}/auth/callback`)
        const callback = new URL(`http://127.0.0.1:${port}/auth/callback`)
        callback.searchParams.set("code", "authorization-code")
        callback.searchParams.set("state", authorize.searchParams.get("state") ?? "")
        const response = await fetch(callback)
        expect(response.ok).toBe(true)
      },
    })

    expect(tokens).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 900 })
    expect(tokenBody).toContain("grant_type=authorization_code")
    expect(tokenBody).toContain("code=authorization-code")
    expect(tokenBody).toContain("code_verifier=")
    expect(chatGptIdentity(tokens)).toEqual({ accountId: "account-1", email: "trader@example.com" })
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

function availablePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = server.port
  server.stop(true)
  if (port === undefined) throw new Error("Test server did not bind a port")
  return port
}

function jwt(payload: object): string {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`
}

import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import {
  EXAMPLE_SERVER_TOKEN,
  loadClientConfig,
  loadConfig,
  loadCredentials,
  loadDatabaseUrl,
  loadServerConfig,
  parseEnvFile,
  workspaceRoot,
} from "./index.ts"

describe("workspaceRoot", () => {
  test("finds the manifest that declares the workspaces", () => {
    const root = workspaceRoot()
    expect(Bun.file(resolve(root, "package.json")).size).toBeGreaterThan(0)
    expect(Bun.file(resolve(root, "packages/config/package.json")).size).toBeGreaterThan(0)
  })
})

describe("loadDatabaseUrl", () => {
  test("anchors a relative path to the workspace root, not the working directory", () => {
    expect(loadDatabaseUrl({ DATABASE_URL: "./data/db.sqlite" })).toBe(resolve(workspaceRoot(), "data/db.sqlite"))
  })

  test("defaults to the same location when unset", () => {
    expect(loadDatabaseUrl({})).toBe(resolve(workspaceRoot(), "data/db.sqlite"))
  })

  test("keeps an absolute path untouched", () => {
    expect(loadDatabaseUrl({ DATABASE_URL: "/var/lib/trbot.sqlite" })).toBe("/var/lib/trbot.sqlite")
  })

  test("keeps the in-memory database untouched", () => {
    expect(loadDatabaseUrl({ DATABASE_URL: ":memory:" })).toBe(":memory:")
  })

  test("resolves a file: url", () => {
    expect(loadDatabaseUrl({ DATABASE_URL: "file:data/db.sqlite" })).toBe(resolve(workspaceRoot(), "data/db.sqlite"))
  })
})

describe("loadCredentials", () => {
  test("requires both a username and a password", () => {
    expect(loadCredentials({ TRBOT_USERNAME: "+900000000000" })).toBeNull()
    expect(loadCredentials({ TRBOT_PASSWORD: "secret" })).toBeNull()
    expect(loadCredentials({ TRBOT_USERNAME: "  ", TRBOT_PASSWORD: "secret" })).toBeNull()
  })

  test("reads both when present", () => {
    expect(loadCredentials({ TRBOT_USERNAME: " +900000000000 ", TRBOT_PASSWORD: "secret" })).toEqual({
      username: "+900000000000",
      password: "secret",
    })
  })
})

describe("parseEnvFile", () => {
  test("reads values, skipping blank lines and comments", () => {
    const parsed = parseEnvFile(["# a comment", "", "DATABASE_URL=./data/db.sqlite", "TRBOT_USERNAME=+90"].join("\n"))
    expect(parsed).toEqual({ DATABASE_URL: "./data/db.sqlite", TRBOT_USERNAME: "+90" })
  })

  test("strips one layer of matching quotes", () => {
    expect(parseEnvFile(`A="quoted"\nB='single'\nC=bare`)).toEqual({ A: "quoted", B: "single", C: "bare" })
  })

  test("keeps separators inside a value", () => {
    expect(parseEnvFile("TRBOT_PASSWORD=a=b=c")).toEqual({ TRBOT_PASSWORD: "a=b=c" })
  })

  test("ignores lines without a key", () => {
    expect(parseEnvFile("=novalue\nnoseparator")).toEqual({})
  })
})

describe("loadConfig", () => {
  test("falls back to defaults for an empty environment", () => {
    expect(loadConfig({})).toEqual({
      databaseUrl: resolve(workspaceRoot(), "data/db.sqlite"),
      credentials: null,
      aiModel: "gpt-5.6-sol",
      aiReasoningEffort: "high",
    })
  })
})

describe("loadServerConfig", () => {
  const token = { TRBOT_SERVER_TOKEN: "a-real-token" }

  test("defaults to loopback without TLS", () => {
    expect(loadServerConfig(token)).toEqual({ host: "127.0.0.1", port: 7717, token: "a-real-token", tls: null })
  })

  test("refuses to serve a non-loopback interface without TLS", () => {
    expect(() => loadServerConfig({ ...token, TRBOT_SERVER_HOST: "0.0.0.0" })).toThrow(/without TLS/)
    expect(() => loadServerConfig({ ...token, TRBOT_SERVER_HOST: "192.168.1.10" })).toThrow(/without TLS/)
  })

  test("serves a non-loopback interface once TLS is configured", () => {
    const config = loadServerConfig({
      ...token,
      TRBOT_SERVER_HOST: "0.0.0.0",
      TRBOT_SERVER_TLS_CERT: "/tls/server.crt",
      TRBOT_SERVER_TLS_KEY: "/tls/server.key",
    })
    expect(config.tls).toEqual({ certPath: "/tls/server.crt", keyPath: "/tls/server.key" })
  })

  test("rejects a half-configured certificate", () => {
    expect(() => loadServerConfig({ ...token, TRBOT_SERVER_TLS_CERT: "/tls/server.crt" })).toThrow(/together/)
  })

  test("rejects a missing or placeholder token", () => {
    expect(() => loadServerConfig({})).toThrow(/required/)
    expect(() => loadServerConfig({ TRBOT_SERVER_TOKEN: EXAMPLE_SERVER_TOKEN })).toThrow(/example value/)
  })

  test("rejects a port that is not a port", () => {
    expect(() => loadServerConfig({ ...token, TRBOT_SERVER_PORT: "abc" })).toThrow(/port number/)
    expect(() => loadServerConfig({ ...token, TRBOT_SERVER_PORT: "99999" })).toThrow(/port number/)
  })
})

describe("loadClientConfig", () => {
  test("defaults to the local server and trims a trailing slash", () => {
    expect(loadClientConfig({ TRBOT_SERVER_TOKEN: "t", TRBOT_SERVER_URL: "https://host:8443/" })).toEqual({
      url: "https://host:8443",
      token: "t",
      caPath: null,
    })
    expect(loadClientConfig({ TRBOT_SERVER_TOKEN: "t" }).url).toBe("http://127.0.0.1:7717")
  })

  // The terminal is started from wherever the trader happens to be, so a
  // relative authority has to mean the same file regardless.
  test("anchors a relative certificate authority to the workspace root", () => {
    const relative = loadClientConfig({ TRBOT_SERVER_TOKEN: "t", TRBOT_SERVER_CA: "data/tls/ca.crt" })
    expect(relative.caPath).toBe(resolve(workspaceRoot(), "data/tls/ca.crt"))

    const absolute = loadClientConfig({ TRBOT_SERVER_TOKEN: "t", TRBOT_SERVER_CA: "/etc/trbot/ca.crt" })
    expect(absolute.caPath).toBe("/etc/trbot/ca.crt")
  })
})

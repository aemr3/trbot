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
      feedCredentials: null,
      telegramBotToken: null,
    })
  })

  test("reads and trims the optional Telegram bot token", () => {
    expect(loadConfig({ TRBOT_TELEGRAM_BOT_TOKEN: " 123:token " }).telegramBotToken).toBe("123:token")
  })
})

describe("loadServerConfig", () => {
  const token = { TRBOT_SERVER_TOKEN: "a-real-token" }

  test("defaults to loopback without TLS", () => {
    expect(loadServerConfig(token)).toEqual({ host: "127.0.0.1", port: 7717, token: "a-real-token", tls: null })
  })

  test("defaults a non-loopback server to the conventional mTLS bundle", () => {
    const config = loadServerConfig({ ...token, TRBOT_SERVER_HOST: "0.0.0.0" })
    expect(config.tls).toEqual({
      certPath: resolve(workspaceRoot(), "data/tls/server.crt"),
      keyPath: resolve(workspaceRoot(), "data/tls/server.key"),
      clientCaPath: resolve(workspaceRoot(), "data/tls/ca.crt"),
    })
  })

  test("serves a non-loopback interface once TLS is configured", () => {
    const config = loadServerConfig({
      ...token,
      TRBOT_SERVER_HOST: "0.0.0.0",
      TRBOT_SERVER_TLS_CERT: "/tls/server.crt",
      TRBOT_SERVER_TLS_KEY: "/tls/server.key",
    })
    expect(config.tls).toEqual({
      certPath: "/tls/server.crt",
      keyPath: "/tls/server.key",
      clientCaPath: "/tls/ca.crt",
    })
  })

  test("allows a separate authority for client certificates", () => {
    const config = loadServerConfig({
      ...token,
      TRBOT_SERVER_TLS_CERT: "/tls/server.crt",
      TRBOT_SERVER_TLS_KEY: "/tls/server.key",
      TRBOT_SERVER_TLS_CLIENT_CA: "/clients/ca.crt",
    })
    expect(config.tls?.clientCaPath).toBe("/clients/ca.crt")
  })

  test("a client authority alone enables the default server identity", () => {
    const config = loadServerConfig({ ...token, TRBOT_SERVER_TLS_CLIENT_CA: "/clients/ca.crt" })
    expect(config.tls).toEqual({
      certPath: resolve(workspaceRoot(), "data/tls/server.crt"),
      keyPath: resolve(workspaceRoot(), "data/tls/server.key"),
      clientCaPath: "/clients/ca.crt",
    })
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
    expect(loadClientConfig({ TRBOT_SERVER_TOKEN: "t", TRBOT_SERVER_URL: "http://host:8080/" })).toEqual({
      url: "http://host:8080",
      token: "t",
      tls: null,
    })
    expect(loadClientConfig({ TRBOT_SERVER_TOKEN: "t" }).url).toBe("http://127.0.0.1:7717")
  })

  test("defaults an HTTPS client to the conventional mTLS bundle", () => {
    expect(loadClientConfig({ TRBOT_SERVER_TOKEN: "t", TRBOT_SERVER_URL: "https://host:8443" }).tls).toEqual({
      caPath: resolve(workspaceRoot(), "data/tls/ca.crt"),
      certPath: resolve(workspaceRoot(), "data/tls/client.crt"),
      keyPath: resolve(workspaceRoot(), "data/tls/client.key"),
    })
  })

  // The terminal is started from wherever the trader happens to be, so a
  // relative certificate bundle has to mean the same files regardless.
  test("anchors a relative mTLS bundle to the workspace root", () => {
    const relative = loadClientConfig({ TRBOT_SERVER_TOKEN: "t", TRBOT_CLIENT_TLS_SERVER_CA: "data/tls/ca.crt" })
    expect(relative.tls).toEqual({
      caPath: resolve(workspaceRoot(), "data/tls/ca.crt"),
      certPath: resolve(workspaceRoot(), "data/tls/client.crt"),
      keyPath: resolve(workspaceRoot(), "data/tls/client.key"),
    })

    const absolute = loadClientConfig({ TRBOT_SERVER_TOKEN: "t", TRBOT_CLIENT_TLS_SERVER_CA: "/etc/trbot/ca.crt" })
    expect(absolute.tls).toEqual({
      caPath: "/etc/trbot/ca.crt",
      certPath: "/etc/trbot/client.crt",
      keyPath: "/etc/trbot/client.key",
    })
  })

  test("supports a client identity with the system trust store", () => {
    const config = loadClientConfig({
      TRBOT_SERVER_TOKEN: "t",
      TRBOT_CLIENT_TLS_CERT: "/tls/workstation.crt",
      TRBOT_CLIENT_TLS_KEY: "/tls/workstation.key",
    })
    expect(config.tls).toEqual({
      caPath: null,
      certPath: "/tls/workstation.crt",
      keyPath: "/tls/workstation.key",
    })
  })

  test("rejects a half-configured client identity", () => {
    expect(() => loadClientConfig({ TRBOT_SERVER_TOKEN: "t", TRBOT_CLIENT_TLS_CERT: "/tls/client.crt" })).toThrow(
      /must be set together/,
    )
  })
})

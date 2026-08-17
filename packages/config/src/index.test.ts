import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { loadConfig, loadCredentials, loadDatabaseUrl, parseEnvFile, workspaceRoot } from "./index.ts"

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

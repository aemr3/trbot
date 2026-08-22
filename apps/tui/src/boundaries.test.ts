import { describe, expect, test } from "bun:test"
import { Glob } from "bun"
import { resolve } from "node:path"
import { workspaceRoot } from "@trbot/config"

const PROVIDER_PACKAGES = ["@trbot/api", "@trbot/provider"]

// Packages that hold a credential of their own. `@trbot/ai` owns the ChatGPT
// tokens, so it belongs on the server beside the provider session even though
// it never touches the market provider.
//
// `@trbot/client` is deliberately absent: it runs the ChatGPT login on the
// trader's machine and hands the result inward, so it holds a token in flight and
// stores none. Anything that starts *keeping* one belongs on this list instead.
// `@trbot/feed` joins them: it holds the market data account's password and the
// realtime licence minted from it.
const SERVER_ONLY_PACKAGES = [...PROVIDER_PACKAGES, "@trbot/ai", "@trbot/auth", "@trbot/db", "@trbot/feed"]

interface WorkspacePackage {
  name: string
  dependencies: string[]
}

async function readWorkspace(): Promise<Map<string, WorkspacePackage>> {
  const root = workspaceRoot()
  const packages = new Map<string, WorkspacePackage>()

  for (const relative of new Glob("{apps,packages}/*/package.json").scanSync(root)) {
    const manifest = await Bun.file(resolve(root, relative)).json()
    const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    packages.set(manifest.name, { name: manifest.name, dependencies: dependencies.filter(isWorkspaceName) })
  }

  return packages
}

function isWorkspaceName(name: string): boolean {
  return name.startsWith("@trbot/")
}

/** Every workspace package reachable from `name`, following declared dependencies. */
function dependencyClosure(packages: Map<string, WorkspacePackage>, name: string): Set<string> {
  const seen = new Set<string>()
  const pending = [name]

  while (pending.length > 0) {
    const current = pending.pop()
    if (!current || seen.has(current)) continue
    seen.add(current)
    pending.push(...(packages.get(current)?.dependencies ?? []))
  }

  seen.delete(name)
  return seen
}

describe("workspace boundaries", () => {
  // Domain packages describe contracts and logic. Keeping the provider out of
  // them is what lets a client depend on a contract without gaining a path to
  // the provider, and what would let a browser client use them at all.
  test.each(["@trbot/market", "@trbot/trading", "@trbot/member", "@trbot/preferences"])(
    "%s does not reach the provider",
    async (name) => {
      const packages = await readWorkspace()
      const closure = dependencyClosure(packages, name)
      expect([...closure].filter((dependency) => PROVIDER_PACKAGES.includes(dependency))).toEqual([])
    },
  )

  test("the workspace graph is acyclic", async () => {
    const packages = await readWorkspace()
    for (const name of packages.keys()) {
      expect(dependencyClosure(packages, name).has(name)).toBe(false)
    }
  })

  // The rule this whole architecture exists to hold: the terminal reaches market
  // data and places orders only through the server.
  test("the terminal application does not reach the provider", async () => {
    const packages = await readWorkspace()
    const closure = dependencyClosure(packages, "@trbot/tui")
    expect([...closure].filter((dependency) => PROVIDER_PACKAGES.includes(dependency))).toEqual([])
  })

  // Nor does it hold any other credential: no provider password, no ChatGPT
  // token, and no direct reach into the database that stores them.
  test("the terminal application holds no credentials of its own", async () => {
    const packages = await readWorkspace()
    const closure = dependencyClosure(packages, "@trbot/tui")
    expect([...closure].filter((dependency) => SERVER_ONLY_PACKAGES.includes(dependency))).toEqual([])
  })
})

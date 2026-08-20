import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

const WorkspaceManifestSchema = z.object({ workspaces: z.unknown() })

/**
 * Locates the workspace root by walking up from this module until it finds the
 * manifest that declares the workspaces. Anchoring to the root rather than the
 * working directory keeps every process — whichever app it belongs to and
 * wherever it was started — pointed at the same files.
 */
function findWorkspaceRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url))

  for (;;) {
    const manifest = resolve(directory, "package.json")
    if (existsSync(manifest) && declaresWorkspaces(manifest)) return directory

    const parent = dirname(directory)
    if (parent === directory) {
      throw new Error("Unable to locate the workspace root: no package.json declaring workspaces was found")
    }
    directory = parent
  }
}

function declaresWorkspaces(manifestPath: string): boolean {
  try {
    return WorkspaceManifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, "utf8"))).success
  } catch {
    return false
  }
}

let cachedRoot: string | null = null

/** The absolute path of the workspace root. Resolved once per process. */
export function workspaceRoot(): string {
  cachedRoot ??= findWorkspaceRoot()
  return cachedRoot
}

/**
 * Parses `.env` contents into plain values. Blank lines and `#` comments are
 * skipped, and a single layer of matching quotes is stripped from values.
 */
export function parseEnvFile(contents: string) {
  const values: Record<string, string> = {}

  for (const line of contents.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue

    const separator = trimmed.indexOf("=")
    if (separator <= 0) continue

    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim()
    values[key] = unquote(value)
  }

  return values
}

function unquote(value: string): string {
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  return quoted ? value.slice(1, -1) : value
}

let cachedFileValues: Record<string, string> | null = null

function workspaceEnvFile(): Record<string, string> {
  if (cachedFileValues) return cachedFileValues

  const path = resolve(workspaceRoot(), ".env")
  cachedFileValues = existsSync(path) ? parseEnvFile(readFileSync(path, "utf8")) : {}
  return cachedFileValues
}

/**
 * The environment configuration is read from: the workspace `.env` file
 * overlaid with real environment variables, which always win. Bun only
 * auto-loads `.env` from the working directory, so reading it here is what lets
 * a process start from anywhere and still see the same settings.
 */
export function environment() {
  return { ...workspaceEnvFile(), ...process.env }
}

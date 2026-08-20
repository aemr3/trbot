import type { ServerDeps } from "./server.ts"

/**
 * Supplies the server dependencies a focused route test names. Touching any
 * omitted dependency fails immediately with its property name.
 */
export function serverDeps(overrides: Partial<ServerDeps>): ServerDeps {
  const dependencies = new Proxy(overrides, {
    get(target, property) {
      const configured = Object.getOwnPropertyDescriptor(target, property)
      if (configured) return configured.value
      throw new Error(`Server dependency ${String(property)} is not configured for this test`)
    },
  })
  // SAFETY: ServerDeps is enforced lazily; every missing property throws before use.
  return dependencies as ServerDeps
}

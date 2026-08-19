import { expect, test } from "bun:test"
import type { HttpClient } from "./http.ts"
import { DEFAULT_APP_PREFERENCES, type AppPreferences } from "@trbot/preferences/app.ts"
import { HttpAppPreferences } from "./sources.ts"

/**
 * Preference changes arrive as fast as a trader can press a key, and each one is
 * the whole settings object. Sent independently they can finish out of order and
 * leave an older layout as the stored one — a setting that silently reverts.
 */

interface Write {
  body: AppPreferences
  settle: () => void
}

/** An HTTP client whose writes finish only when the test says so. */
function controllable(writes: Write[]): HttpClient {
  return {
    put(_path: string, options: { body?: unknown }) {
      return new Promise<void>((resolve) => {
        writes.push({ body: options.body as AppPreferences, settle: resolve })
      })
    },
  } as unknown as HttpClient
}

function preferences(sort: AppPreferences["instrumentSort"]): AppPreferences {
  return { ...DEFAULT_APP_PREFERENCES, instrumentSort: sort }
}

test("a save waits for the one in flight rather than racing it", async () => {
  const writes: Write[] = []
  const store = new HttpAppPreferences(controllable(writes))

  store.save(preferences("name"))
  expect(writes).toHaveLength(1)

  // Two more while the first is still going.
  store.save(preferences("volume"))
  store.save(preferences("change"))
  expect(writes).toHaveLength(1)

  writes[0]?.settle()
  await Bun.sleep(1)

  // One follow-up carrying the latest, not two carrying a stale one after it.
  expect(writes).toHaveLength(2)
  expect(writes[1]?.body.instrumentSort).toBe("change")

  writes[1]?.settle()
  await Bun.sleep(1)
  expect(writes).toHaveLength(2)
})

test("a failed save does not wedge the ones after it", async () => {
  const attempts: AppPreferences[] = []
  const failing = {
    put(_path: string, options: { body?: unknown }) {
      attempts.push(options.body as AppPreferences)
      return Promise.reject(new Error("the server refused"))
    },
  } as unknown as HttpClient
  const store = new HttpAppPreferences(failing)

  store.save(preferences("name"))
  await Bun.sleep(1)
  store.save(preferences("volume"))
  await Bun.sleep(1)

  expect(attempts.map((entry) => entry.instrumentSort)).toEqual(["name", "volume"])
})

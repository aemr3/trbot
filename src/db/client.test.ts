import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openDatabase } from "./client.ts"

test("waits for a transient startup lock to clear", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trbot-sqlite-lock-"))
  const databasePath = join(directory, "app.db")
  const markerPath = join(directory, "locked")
  const initial = await openDatabase(databasePath)
  initial.close()

  const blocker = Bun.spawn({
    cmd: [process.execPath, "--eval", `
      import { Database } from "bun:sqlite"
      const database = new Database(process.env.TRBOT_LOCK_TEST_DATABASE)
      database.run("BEGIN EXCLUSIVE")
      await Bun.write(process.env.TRBOT_LOCK_TEST_MARKER, "locked")
      setTimeout(() => {
        database.run("COMMIT")
        database.close()
      }, 200)
    `],
    env: {
      ...process.env,
      TRBOT_LOCK_TEST_DATABASE: databasePath,
      TRBOT_LOCK_TEST_MARKER: markerPath,
    },
    stdout: "ignore",
    stderr: "pipe",
  })

  try {
    await waitForFile(markerPath)

    const connection = await openDatabase(databasePath)
    connection.close()
    expect(await blocker.exited).toBe(0)
  } finally {
    blocker.kill()
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!(await Bun.file(path).exists())) {
    if (Date.now() >= deadline) throw new Error("Lock process did not start")
    await Bun.sleep(10)
  }
}

import { chmod, rename, rm } from "node:fs/promises"
import { Database } from "bun:sqlite"

const [source, destination] = process.argv.slice(2)
if (!source || !destination) {
  throw new Error("usage: bun backup.ts SOURCE DESTINATION")
}

const temporaryDestination = `${destination}.tmp`
const database = new Database(source, { readonly: true, strict: true })

try {
  await Bun.write(temporaryDestination, database.serialize())
  await chmod(temporaryDestination, 0o600)
  await rename(temporaryDestination, destination)
} finally {
  database.close()
  await rm(temporaryDestination, { force: true })
}

import { loadDatabaseUrl } from "@trbot/config"
import { openDatabase } from "./client.ts"

const connection = await openDatabase(loadDatabaseUrl())
connection.close()

console.log("Database migrations applied")

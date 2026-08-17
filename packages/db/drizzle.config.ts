import { loadDatabaseUrl } from "@trbot/config"
import { defineConfig } from "drizzle-kit"

// drizzle-kit resolves `schema` and `out` against its working directory, so it
// runs from this package. The database location comes from the shared config,
// which is anchored to the workspace root and independent of that directory.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: loadDatabaseUrl(),
  },
})

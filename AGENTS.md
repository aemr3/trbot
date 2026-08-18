# AGENTS.md

## Runtime and Tooling

- Use Bun for running, testing, package management, and scripts.
- Use TypeScript for application code.
- Do not introduce Python scripts or Python-based tooling.

## Project Structure

This is a Bun workspace. Shared code lives in `packages/*`, runnable programs in `apps/*`.

- Organize domain contracts by feature package, such as `packages/auth`, `packages/chat`, `packages/market`, and `packages/trading`.
- Keep external API transport, GraphQL operations, and client behavior in `packages/api`.
- Keep database connections, schemas, migrations, and store implementations in `packages/db`.
- Keep full-screen views in `apps/tui/src/screens` and reusable TUI controls in `apps/tui/src/components`.
- Keep the model harness behind `packages/ai`. Only the ChatGPT login reaches it from a client, through `packages/client`.
- Keep request handling in `apps/server/src/http`, background rule evaluation in `apps/server/src/monitors`, and the provider session and stream fan-out beside them.
- Keep `apps/tui/src/index.ts` and `apps/server/src/index.ts` limited to application bootstrap.
- Do not create a generic `models` or `utils` dumping ground. Put types and helpers with the feature that owns them.

## Workspace Boundaries

- Import across packages by name and file, as in `@trbot/market/candle.ts`. Use relative paths only within a package.
- Keep the package graph acyclic. A new import that closes a cycle is a sign the contract belongs in a lower package.
- Keep domain contract packages free of transport, storage, and terminal concerns so a server and a client can both depend on them.
- Client applications never reach the provider. Only the server may depend on `@trbot/api` or `@trbot/provider`, including transitively. See [docs/server-architecture.md](docs/server-architecture.md).
- Client applications hold no credentials. `@trbot/ai` (ChatGPT tokens), `@trbot/auth`, and `@trbot/db` are server-only for the same reason. Both rules are enforced by `apps/tui/src/boundaries.test.ts`.
- Declare every package a package imports in its own `package.json`.
- Extend `@trbot/tsconfig/base.json` from every workspace member rather than repeating compiler settings. Add a named config to that package when a member genuinely needs a different shape.
- Define runnable scripts on the root `package.json`. Never launch the terminal application through `bun run --filter`: it pipes the child's output, which breaks terminal rendering. Filtering is fine for tools that need their own working directory, such as drizzle-kit.

## Naming

- Use provider-neutral names for application-owned files, symbols, types, errors, tables, and columns.
- Use provider-specific names only when an external protocol requires an exact URL, header, operation, or schema name.

## Persistence and Configuration

- Use Drizzle for schema definitions, queries, and migrations.
- Keep persistence interfaces independent of SQLite so PostgreSQL can be introduced later.
- Keep runtime state under `data/` and do not commit database files.
- Give migration files descriptive names.
- Read settings through `@trbot/config` rather than `process.env` directly. It overlays the workspace `.env` with real environment variables and anchors relative paths such as `DATABASE_URL` to the workspace root, so every process resolves the same files no matter which directory it started from.

## TUI Lifecycle

- Keep screen-specific input and rendering behavior inside its screen or component.
- Keep screen transitions, active API handles, database ownership, and shutdown behavior in the application lifecycle.
- Always destroy the OpenTUI renderer and close database resources during shutdown.

## Tests

- Colocate test files with the implementation they cover.
- Test meaningful behavior and failure paths; do not add tests for trivial configuration mapping or simple type declarations.
- Run `bun run lint`, `bun run typecheck`, and `bun test` after relevant changes.
- Before committing, require all three checks to pass unless the user explicitly approves a known failure.

# AGENTS.md

## Runtime and Tooling

- Use Bun for running, testing, package management, and scripts.
- Use TypeScript for application code.
- Do not introduce Python scripts or Python-based tooling.

## Project Structure

- Organize domain contracts by feature, such as `src/auth`, `src/market`, and `src/trading`.
- Keep external API transport, GraphQL operations, and client behavior in `src/api`.
- Keep database connections, schemas, migrations, and store implementations in `src/db`.
- Keep full-screen views in `src/screens` and reusable TUI controls in `src/components`.
- Keep `src/index.ts` limited to application bootstrap.
- Do not create a generic `models` or `utils` dumping ground. Put types and helpers with the feature that owns them.

## Naming

- Use provider-neutral names for application-owned files, symbols, types, errors, tables, and columns.
- Use provider-specific names only when an external protocol requires an exact URL, header, operation, or schema name.

## Persistence and Configuration

- Use Drizzle for schema definitions, queries, and migrations.
- Keep persistence interfaces independent of SQLite so PostgreSQL can be introduced later.
- Keep runtime state under `data/` and do not commit database files.
- Give migration files descriptive names.

## TUI Lifecycle

- Keep screen-specific input and rendering behavior inside its screen or component.
- Keep screen transitions, active API handles, database ownership, and shutdown behavior in the application lifecycle.
- Always destroy the OpenTUI renderer and close database resources during shutdown.

## Tests

- Colocate test files with the implementation they cover.
- Test meaningful behavior and failure paths; do not add tests for trivial configuration mapping or simple type declarations.
- Run `bun run lint`, `bun run typecheck`, and `bun test` after relevant changes.
- Before committing, require all three checks to pass unless the user explicitly approves a known failure.

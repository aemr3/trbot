# Configuration

The application reads configuration from environment variables through Bun. A local `.env` file is automatically available during normal Bun execution and is ignored by Git.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `DATABASE_URL` | no | `./data/db.sqlite` | SQLite database path used for application state |
| `TRBOT_USERNAME` | no | none | Provider phone number/username for unattended session recovery |
| `TRBOT_PASSWORD` | no | none | Provider password for unattended session recovery |

## `DATABASE_URL`

Despite the name, the current database implementation accepts SQLite locations, not PostgreSQL connection URLs.

- A relative path is resolved from the process working directory.
- An absolute path is used as given.
- A `file:` prefix is removed and the remaining path is resolved from the working directory.
- `:memory:` creates an in-memory SQLite database.
- An unset, empty, or whitespace-only value uses `./data/db.sqlite`.

For file-backed databases, the parent directory is created with mode `0700`, the database is set to mode `0600`, foreign keys are enabled, WAL mode is enabled, and Drizzle migrations run during startup. Runtime database files belong under `data/` and must not be committed.

Example:

```dotenv
DATABASE_URL=./data/db.sqlite
TRBOT_USERNAME=
TRBOT_PASSWORD=
```

## Credentials

`TRBOT_USERNAME` and `TRBOT_PASSWORD` are considered configured only when both are non-empty. They enable unattended token refresh and bound-device password login. If either is absent, the application retains the stored session but returns to interactive login when credentials are required.

The password remains environment-only. Authentication state such as device keys and rotated tokens is stored in the application database. Protect both the `.env` file and database as sensitive local state.

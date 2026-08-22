# Configuration

The application reads configuration through `@trbot/config`, which overlays the repository-root `.env` file with real environment variables. Environment variables win where both define a value. Because the file is located from the repository root rather than the working directory, settings resolve the same way regardless of where a program is started. The `.env` file is ignored by Git.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `DATABASE_URL` | no | `./data/db.sqlite` | SQLite database path used for application state |
| `TRBOT_USERNAME` | no | none | Provider phone number/username for unattended session recovery |
| `TRBOT_PASSWORD` | no | none | Provider password for unattended session recovery |
| `TRBOT_SERVER_HOST` | no | `127.0.0.1` | Interface the server binds |
| `TRBOT_SERVER_PORT` | no | `7717` | Port the server binds |
| `TRBOT_SERVER_TOKEN` | yes | none | Bearer token every client presents |
| `TRBOT_SERVER_TLS_CERT` | no | none | Certificate path; required for a non-loopback host |
| `TRBOT_SERVER_TLS_KEY` | no | none | Private key path; required for a non-loopback host |
| `TRBOT_SERVER_URL` | no | `http://127.0.0.1:7717` | Server address clients use |
| `TRBOT_SERVER_CA` | no | none | Certificate authority a client trusts |

## `DATABASE_URL`

Despite the name, the current database implementation accepts SQLite locations, not PostgreSQL connection URLs.

- A relative path is resolved from the repository root, not the process working directory, so every program in the workspace opens the same database wherever it is started from.
- An absolute path is used as given.
- A `file:` prefix is removed and the remaining path is resolved the same way.
- `:memory:` creates an in-memory SQLite database.
- An unset, empty, or whitespace-only value uses `./data/db.sqlite`.

For file-backed databases, the parent directory is created with mode `0700`, the database is set to mode `0600`, foreign keys are enabled, WAL mode is enabled, and Drizzle migrations run during startup. Runtime database files belong under `data/` and must not be committed.

Example:

```dotenv
DATABASE_URL=./data/db.sqlite
TRBOT_USERNAME=
TRBOT_PASSWORD=
TRBOT_SERVER_TOKEN=
```

## Server access

`TRBOT_SERVER_TOKEN` is required, on loopback as well as over a network: any
process on the machine can reach a loopback port, and this one places orders.
Generate one with `bun run server:token`. The server refuses to start while the
value is still the example from `.env.example`.

`TRBOT_SERVER_HOST` defaults to loopback. Binding anything else requires
`TRBOT_SERVER_TLS_CERT` and `TRBOT_SERVER_TLS_KEY`, and is refused at startup
without them. `bun run server:cert <host>` issues both and prints the authority
path for `TRBOT_SERVER_CA` on each client.

## Credentials

`TRBOT_USERNAME` and `TRBOT_PASSWORD` are read by the server only; the terminal
never holds provider credentials and never reaches the provider. They are
considered configured only when both are non-empty, and they enable unattended
token refresh and bound-device password login. If either is absent, the server retains the stored session but asks a client to
sign in when credentials are required. With both set, the server signs itself
back in unattended, which is what keeps stop rules running overnight.

The password remains environment-only. Authentication state such as device keys and rotated tokens is stored in the application database. Protect both the `.env` file and database as sensitive local state.

## Models and providers

**Nothing about models is configured here.** There is no environment variable
naming a provider, a model, or a reasoning effort: those are chosen in the
terminal and recorded by the server, so what answered a question is always the
thing that was picked rather than whatever a file said at startup.

Connect providers with `p` in the `CHAT` tab. Every provider the model harness
offers is listed — a few behind a subscription sign-in, most behind an API key —
and the same screen runs whichever flow the chosen one uses: it opens a browser and
catches the redirect, shows a device code, or takes a key you type. The server
stores the credential and refreshes it from then on; the terminal keeps nothing.

Then pick what answers: `m` in the `CHAT` tab sets the model for that chat
session, and `r` its reasoning effort. Each session records its own, so two
sessions can run on two providers at once. Until something is picked, the
composer says so and names the key that fixes it.

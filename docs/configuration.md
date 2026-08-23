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
| `TRBOT_TELEGRAM_BOT_TOKEN` | no | none | BotFather token enabling Telegram chat pairing |

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

Connect providers with `Ctrl+P` or `/providers` in the `CHAT` tab. Every provider the model harness
offers is listed — a few behind a subscription sign-in, most behind an API key —
and the same screen runs whichever flow the chosen one uses: it opens a browser and
catches the redirect, shows a device code, or takes a key you type. The server
stores the credential and refreshes it from then on; the terminal keeps nothing.

Then pick what answers: `m` in the `CHAT` tab sets the model for that chat
session, and `r` its reasoning effort. Each session records its own, so two
sessions can run on two providers at once. Until something is picked, the
composer says so and names the key that fixes it.

## Telegram mobile chat

Create a private bot with Telegram's `@BotFather`, then put its token in
`TRBOT_TELEGRAM_BOT_TOKEN` and restart the server. The token is server-only and
must be protected like the other credentials in `.env`.

Run `/connect` in a saved root chat to display a five-minute QR code. Scanning it
and pressing **Start** attaches that Telegram account to the selected chat. A
Telegram account points at one active chat at a time; pairing it again moves the
connection. Send `/disconnect` to the bot, or press `d` in the `/connect` modal,
to revoke it. Once disconnected, the bot silently ignores messages from that
Telegram account until it opens a new pairing link.

The server uses outbound long polling, so it does not need a public webhook or a
non-loopback HTTP listener. Assistant messages and tool approval prompts are sent
to the paired private chat. While an assistant is answering, the server uses
Telegram's native live drafts at a throttled rate and persists the completed reply
as a normal message. It falls back to editing a single message when live drafts are
unavailable. Telegram's native typing indicator is shown before model work starts,
while tools run, and while the model resumes after each tool. Tool starts are separate
messages so their exact function names appear immediately rather than through
Telegram's animated draft rendering; successful tools are removed and failed tools
remain visible. Arguments, results, and model reasoning are never included. Approval
buttons offer one-time approval, connection-scoped approval when the tool permits it,
and denial. Connection-scoped grants are revoked when the phone disconnects, is paired
elsewhere, or the server stops.

Telegram bot chats are cloud chats rather than end-to-end encrypted Secret Chats.
Pair only a Telegram account and phone you trust; brokerage and model credentials
are never sent through Telegram.

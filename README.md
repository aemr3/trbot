# trbot

`trbot` is a Bun and TypeScript terminal workspace for accessing financial markets, account data, trading workflows, news, and AI-assisted tools. It brings live data and account actions into a fast OpenTUI interface designed to grow across asset classes, workflows, and service providers.

## Features

- Live market quotes, sorting, and ticker search
- Stock, index, and futures candlestick charts with selectable ranges and intervals
- Portfolio, order, position, collateral, and contract-detail views
- Market news feeds and full article reading
- Current VIOP limit and simulated-market order workflows
- Bulk VIOP order cancellation and position exits with confirmation
- Persistent authentication, preferences, and provider state in SQLite
- Optional ChatGPT OAuth account connection, exchanged and stored by the server

## Requirements

- [Bun](https://bun.sh/)
- An account with a supported market-data or trading provider; the current integration uses Midas
- A terminal with Unicode and true-color support

## Setup

Install dependencies:

```sh
bun install
```

Create a local environment file:

```sh
cp .env.example .env
```

The default configuration works without editing `.env`. Leaving the credentials empty uses the interactive login screen. Supplying both credentials enables unattended session recovery:

```dotenv
DATABASE_URL=./data/db.sqlite
TRBOT_USERNAME=
TRBOT_PASSWORD=
```

`DATABASE_URL` currently accepts a SQLite path. An unset or blank value defaults to `./data/db.sqlite`. A relative path is resolved against the repository root rather than the working directory, so every program in the workspace opens the same database wherever it is started from. Parent directories, database permissions, WAL mode, and Drizzle migrations are handled during startup. See [configuration.md](docs/configuration.md) for the complete behavior.

## Run

The terminal is a client of the server, and reaches market data and trading only
through it. Start the server first:

```sh
bun run server:token   # once, into TRBOT_SERVER_TOKEN in .env
bun run server
```

Then the terminal, in another shell:

```sh
bun run start
```

For development, one command runs both with automatic restart:

```sh
bun run all
```

The terminal needs the terminal to itself — anything else writing to the same
output lands mid-frame and corrupts the display — so the server's output goes to
`data/server.log`. Follow it with `tail -f data/server.log`. Closing the terminal
stops the server too. To run them separately, use `bun run server:dev` and
`bun run dev` in two shells.

The server keeps running without a terminal attached, which is what lets stop
rules and price alerts protect a position when nothing is watching.

To reach the server from another machine, issue a certificate and set
`TRBOT_SERVER_HOST`; a non-loopback address without TLS is refused at startup:

```sh
bun run server:cert 192.168.1.50
```

The current Midas login may require SMS verification and device binding. Provider authentication state is stored in the configured local database so later sessions can resume or refresh automatically.

## Keyboard controls

Press `?` inside the application for the complete shortcut reference. Common controls are:

| Keys | Action |
| --- | --- |
| `Tab` | Move focus between panels |
| `/` | Search and switch ticker |
| `B` / `S` | Open a buy or sell ticket |
| `C` / `V` | Sort contracts by change or volume |
| `c c` | Cancel all pending VIOP orders |
| `x x` | Exit all open VIOP positions |
| `G` | Open application logs |
| `A` | Manage the ChatGPT account connection (the server holds its tokens) |
| `Ctrl+C` | Shut down cleanly |

Trading actions affect the connected provider account. “Simulated market” is a limit-order pricing strategy based on exchange bounds; it is not paper trading. Review every order before submission.

## Project layout

`trbot` is a Bun workspace. Shared code lives in `packages/*` and runnable programs in `apps/*`, so a future headless service can reuse the domain, API, and persistence layers without the terminal UI.

| Package | Contents |
| --- | --- |
| `@trbot/config` | Application configuration, workspace-root discovery, and `.env` loading |
| `@trbot/auth` | Authentication state, store, and session contracts |
| `@trbot/api` | Provider transport, GraphQL operations, and client behavior |
| `@trbot/market` | Instruments, candles, quotes, depth, news, and alerts |
| `@trbot/trading` | Accounts, orders, positions, and stop rules |
| `@trbot/member` | Member entitlements and features |
| `@trbot/provider` | Provider adapters implementing the domain contracts |
| `@trbot/protocol` | Wire contract shared by the server and its clients |
| `@trbot/client` | HTTP and WebSocket adapters implementing the domain contracts |
| `@trbot/ai` | ChatGPT account, provider, and market overview generation (server only) |
| `@trbot/preferences` | Persisted watchlist and chart preferences |
| `@trbot/db` | Drizzle schema, migrations, and store implementations |
| `@trbot/tsconfig` | Shared TypeScript compiler settings |
| `@trbot/server` (`apps/server`) | The server: REST, WebSocket streams, provider session, stop and alert monitors |
| `@trbot/tui` (`apps/tui`) | The terminal client, its screens, and its components |

Packages import each other by name and file, as in `@trbot/market/candle.ts`. The dependency graph is acyclic, and the domain packages stay free of transport, storage, and terminal concerns — `@trbot/market`, `@trbot/trading`, and `@trbot/member` describe contracts and logic only, with every provider implementation living in `@trbot/provider`. See [docs/server-architecture.md](docs/server-architecture.md) for the decisions behind the split.

## Development

All commands run from the repository root.

```sh
bun run lint
bun run typecheck
bun test
```

Additional scripts:

| Command | Purpose |
| --- | --- |
| `bun run lint:fix` | Apply available Oxlint fixes |
| `bun run db:generate` | Generate a Drizzle migration from schema changes |
| `bun run db:migrate` | Apply database migrations manually |
| `bun run server` | Start the server |
| `bun run server:token` | Generate a value for `TRBOT_SERVER_TOKEN` |
| `bun run server:cert` | Issue a TLS certificate for a non-loopback host |
| `bun run all` | Run the server and the terminal together, both watching for changes |

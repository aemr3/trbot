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
- Optional ChatGPT OAuth account connection

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

`DATABASE_URL` currently accepts a SQLite path. An unset or blank value defaults to `./data/db.sqlite`. Parent directories, database permissions, WAL mode, and Drizzle migrations are handled during startup. See [configuration.md](docs/configuration.md) for the complete behavior.

## Run

```sh
bun run start
```

For development with automatic restart:

```sh
bun run dev
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
| `A` | Manage the ChatGPT account connection |
| `Ctrl+C` | Shut down cleanly |

Trading actions affect the connected provider account. “Simulated market” is a limit-order pricing strategy based on exchange bounds; it is not paper trading. Review every order before submission.

## Development

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

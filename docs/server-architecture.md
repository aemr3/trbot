# Server Architecture

Why the application is split into a server that owns all provider access and a
terminal that is one of its clients, and which decisions in that split are load
bearing.

This is deliberately not a description of the code. Routes live in
`packages/protocol/src/routes.ts`, stream frames in `stream.ts`, the package
graph in the `package.json` files, and settings in
[docs/configuration.md](configuration.md) — each of those is authoritative, and
restating them here only produces something that disagrees with them later.

## Hard rule

**The terminal application never talks to the provider.** Not through a fallback,
not through a development flag, not transitively through a domain package. Every
request and every stream reaches the provider through the server.

Provider adapters live in `@trbot/provider` rather than beside the domain types
they serve, leaving `market`, `trading`, and `member` as contracts and logic only.
An adapter sitting in a domain package makes the provider reachable from anything
that imports a type from it — including the terminal. Keeping them apart is also
what would let a browser client use those packages.

The rule is checked, not trusted:

- A test in `apps/tui` walks its own dependency closure and fails if `@trbot/api`
  or `@trbot/provider` appears.
- A second test widens that to every package holding a credential — `@trbot/ai`
  for the ChatGPT tokens, `@trbot/auth`, and `@trbot/db`, which stores both.
- Both run in CI, so a regression fails a pull request rather than reaching
  `main`.

## Persistence and monitors

The server owns the database; the terminal reaches persisted state over REST.

`StopMonitor` and `AlertMonitor` run in the server, not in the screen that
displays them. A monitor owned by a screen stops when that screen closes, and
stops and alerts have to survive a closed terminal — the reason the split exists
at all.

### What a monitor knows, it must be told

A monitor watches what it holds in memory, so every write has to reach it rather
than only the database — a rule saved behind its back is a rule that never fires,
and a rule deleted behind its back is one that can still send an exit. Editing
therefore goes through the controllers, never through a store, and a client sends
a *draft* so the server creates the rule and hands it to the monitor in one step.

The draft is checked against the domain's own rule validator, the one the editor
runs, rather than only against its types. A fractional quantity, a close-based
rule with no timeframe, an ATR rule with no ATR: each is well formed and still
unusable, and each persists as armed and then either never fires or fails at the
moment it tries to exit. The editor cannot be where that is enforced, because
the editor is not the only thing that can reach the route.

The same applies to what a stop reads before firing. It decides both *whether* to
fire and *how much* to exit from its own idea of what is held, so a position
closed elsewhere has to reach it promptly: the account stream drives a re-read of
the account, with a poll underneath as a floor. That stream stays open while any
rule is armed, not only while a client is watching — with no terminal attached is
exactly when an unattended stop is the only thing protecting the position.

### The provider session and the monitors live in exactly one process

This is a constraint, not a preference. Two processes holding provider sessions
would race on refresh token rotation through the shared authentication store, and
two sets of monitors could place **duplicate live orders**. Any future change that
would run either in a second process has to answer this first.

### How the terminal sees a fired stop

`RemoteStopRules` and `RemoteAlerts` keep the shape of the monitor interfaces, so
the watchlist screen reads the same way — but they decide nothing. Levels are
watched, countdowns run, and exits are sent by the server. The terminal displays
what the server reports and forwards the trader's decision.

The confirmation modal therefore shows the server's remaining countdown rather
than one of its own, and pressing Enter asks the server to send the exit
immediately. A trader who closes the terminal mid-countdown still gets the exit.

Those answers travel over HTTP, not the stream, and the terminal says nothing
about them until the server replies. A socket frame goes into a queue: on a
connection that has dropped, the terminal would report the stop stood down while
the server, perfectly healthy, sends the exit when the countdown runs out. That
combination is the worst available, because the trader stops watching. There is
deliberately no second, unacknowledged path.

A fired stop also has more than two endings. `SUBMITTED` and `CANCELLED` are
definite; `FAILED` means the exit was refused and never left; **`UNKNOWN` means
nobody can say**. A dropped response looks identical to an order that never
arrived, and reporting that as failed tells a trader their position is still
open when it may not be. All three endings stand the rule down rather than
re-arming it — firing again over an exit that may already exist is the one
outcome worth avoiding at any cost.

A stop that fires while the session is being rebuilt waits for it instead of
giving up. Recovery takes seconds; abandoning the countdown would leave the rule
triggered with nothing behind it, which reads as protected and is not.

A fired alert works the same way in reverse: the server holds it as outstanding
and replays it to whoever attaches, so it survives a terminal that was not open
when the level was reached. That makes answering it a decision the client has to
send — dismissing one only on screen leaves it outstanding, and it rings again on
the next reconnect.

## Losing and regaining the provider session

A provider session can lapse while the server runs — overnight, or when the
provider rotates something. It surfaces two ways, and both start a recovery: a
request the provider refuses, and a stream that stops being accepted. The second
matters most, because it is the one that happens with no terminal attached.

Recovery resumes from the stored session first — a refresh token that is still
good needs nothing else — and falls back to the configured credentials only when
that has run out. Concurrent failures share one attempt, so a burst of refused
requests cannot become a login storm. When neither works, the session expires and
every client is told to sign in.

### What the terminal shows while it does not know

The terminal has three states, and only the server moves it between them: a
session means the workspace, no session means the sign-in screen, and **no
answer means neither**. An unreachable server gets a connecting screen naming
the address and the last failure.

This matters because the two look identical from the outside and are not the
same thing at all. A sign-in screen is an instruction to do something, and a
server that is merely restarting — or an address that is wrong — is not
something a trader can fix by typing their password. The server signs itself in
unattended, so "cannot reach it" is usually a state that resolves in seconds.

The stored settings follow the same rule: they are read when the server answers,
not defaulted when it does not, and nothing is written back until a read has
succeeded. Opening the workspace on defaults would replace a trader's layout the
first time they adjusted anything — a restart quietly erasing their setup.

The terminal keeps asking while either non-workspace screen is up and moves on
by itself when the answer arrives. A sign-in screen the server *did* ask for
stays put once it is up, since a password may already be half typed.

A recovery that succeeds replaces every stream the old session handed out, so the
new session announces itself and the fan-out subscribes again. Nothing else
would: a recovery happens on its own, and a client that stayed attached
throughout has no reason to ask for anything a second time. Without that, the
recovery looks like a success and leaves a live socket that has simply gone
quiet — which is the worst of the three outcomes, because it is the one nobody
is told about.

Taking on a session also ends the one before it. A sign-in over a session that
still works would otherwise leave its quote, account, and per-symbol streams
connected: a second set of subscriptions against the provider, and depth streams
nothing is tracking any more.

The request that discovered the lapse waits for the recovery and is then run
again, rather than being answered with the expiry. A caller cannot tell a session
that has been rebuilt from one that is gone, so reporting the expiry would send a
trader to the sign-in screen for a session the server repaired a moment later.
Only the retry is new work — the provider refused the first attempt, so it did
nothing.

## Stream fan-out

Upstream streams are server-sent events. The server holds one upstream
subscription per channel regardless of how many clients are attached. For
`quotes`, whose contract takes a symbol list, it subscribes to the union of every
client's symbols **plus whatever the stop and alert monitors watch**, so closing
the last terminal never stops the prices a stop rule depends on.

An incoming frame is checked in full, not just by its `type`: its fields are read
without a further guard once it is dispatched, so a truncated or version-skewed
frame that got through on the discriminator alone would throw in the socket
handler rather than be ignored. Ignoring it is the behaviour that lets a client
send a frame this server has never heard of.

Frames are routed by symbol, so a client only receives what it asked for. A client
whose socket has fallen behind — more than a megabyte buffered — has market data
dropped rather than queued: a stale tick is worthless once the next one exists,
and a slow reader must not make the server buffer without bound. Frames a trader
cannot afford to miss, such as a fired stop or an expired session, are always
sent.

Depth and equity quotes carry a single symbol per upstream connection, so the
server opens one per watched symbol and reference-counts it: two clients on the
same symbol share a connection, two on different symbols each get their own, and a
symbol nobody watches any more is dropped.

## Idle connections

`Bun.serve` closes a connection that has been quiet for `idleTimeout` seconds, and
its default of ten seconds is shorter than several provider calls legitimately
take — a wide brokerage or settlement range among them. A request cut off that way
is indistinguishable from a dead server at the client, so the limit is set
explicitly to 120 seconds.

Streamed responses do not rely on that limit; they heartbeat. `POST /v1/ai/overview`
answers with newline-delimited JSON, and alongside `{"delta":"…"}` it sends
`{"heartbeat":true}` while there is nothing else to say. A reasoning model can
think for far longer than a connection may stay quiet, and a silent socket is a
closed socket — without heartbeats the server drops its own response and the
client can only report that the server became unreachable. One goes out
immediately, which also flushes the headers so the client learns the request was
accepted rather than waiting on the first token to find out.

A response that has already begun cannot change its status, so a failure part way
through arrives as an `{"error":{…}}` frame and the client rethrows it as the
protocol error it is. Clients ignore frames they do not recognise, so only an
error frame ends a stream early — which is what lets a frame be added later
without breaking an older client.

WebSocket connections need none of this: Bun keeps them alive itself, so a quiet
market never costs a client its stream.

A client that does lose its socket reconnects on its own and never gives up, so
the first failure of an outage is reported and the rest are not — a reconnect
arms it again. Something has to be said, or an unreachable server is
indistinguishable from a market with no ticks; and saying it every few seconds
would bury the log in one fact repeated.

## Idempotency

Mutating order routes accept an `Idempotency-Key`. The server records
`key -> (route, request hash, response, created at)` and replays the stored
response for a repeat of the same key. A repeat with a *different* request body is
rejected with `409`, which surfaces a client bug rather than silently acting on
it. Records expire after 24 hours and are swept at startup.

A record can only be written once its order has an outcome, so between the
lookup and the write there is nothing stored to replay — and that gap is exactly
where a retry lands, because a client retries when it cannot tell whether its
request arrived. Mutations in flight are therefore tracked in memory too, and a
repeat waits on the one already running rather than starting a second. Memory is
enough for the same reason the monitors are: one process.

### Failing is not the same as not happening

A mutation the provider **definitely refused** frees its key, so the trader can
simply try again. A refusal counts as definite only when the provider answered:
the request never left, or it came back with a client error. A dropped
connection, a timeout, a `5xx` — those say nothing about whether the order
landed, and an order that landed without telling us is exactly the one a retry
would place twice.

So the key is recorded as being **in doubt** instead, and a repeat is refused
with `outcome_unknown` rather than run. That is not a nice answer, but it is the
true one: the trader is asked to look at the order book, which settles it in
seconds. Rerunning would hand them a position they never asked for, and no
amount of retrying makes an unknown outcome known.

The mechanism is only worth anything if a retry reuses the key, so the key names
the **order** rather than the call. The order ticket mints one when it first
submits and holds it while the terms stay the same: a resubmit after a failure
whose outcome is unknown carries the same key and is deduplicated. Change the size
or the price and it is a different order, so it gets a new key; open a fresh
ticket and press again, and that is a second order, which is what the trader
asked for.

The client contract therefore takes the key from its caller. A caller that
supplies none still sends one, but a fresh one each time, which deduplicates
nothing — the honest default for a call whose retry semantics nobody has decided.

Exiting every position is named the same way, by the attempt rather than the
keypress. It holds its key while its outcome is unknown, so pressing again
retries that exit instead of sending a second set of orders, and drops it once
the server has answered — because pressing again after that means the positions
open now.

## The AI overview and the ChatGPT login

A ChatGPT token is a credential, so it belongs where the provider credentials are.
`packages/ai` is a server-only package: the model runs there, the tokens are
stored there, and `apps/tui` does not depend on it at all.

The terminal still builds the digest, because every figure in it comes from data
already on its screen. It posts that digest to `POST /v1/ai/overview` and renders
the words as they stream back. The prompt, the model, and the effort setting are
the server's.

### Why the login is split

The provider will only redirect an authorization to `http://localhost:1455`, which
is the trader's machine, not necessarily the server's. So the login is split at
exactly that seam:

1. The server builds the authorization URL and keeps the PKCE verifier and state,
   answering with a `loginId`, the URL, and the address to listen on.
2. The terminal opens the URL in the local browser and listens on that address. A
   machine with no browser is not a failure: the modal shows the link to open by
   hand.
3. The terminal posts back the `loginId`, the authorization code, and the state.
   The server matches the state, exchanges the code, and stores the tokens.

What travels towards the terminal is an authorization URL and, later, an account
summary — an email address and an account id. What travels back is a single-use
code. **No token crosses the wire in either direction**, and `GET /v1/ai/account`
answers with the summary rather than the stored state.

A pending login is consumed whether or not the exchange succeeds, since an
authorization code is single-use, and expires after five minutes.

## Security

Exposure follows the interface the server binds, so local use costs nothing to set
up while anything reachable from another machine is encrypted.

- **Loopback runs plain HTTP.** No certificate is needed for development or
  single-machine use, and the server starts with no TLS configuration at all.
- **A non-loopback bind without TLS is refused at startup**, with no override. To
  terminate TLS at a reverse proxy instead, bind loopback and let the proxy hold
  the certificate.
- **Bearer token on every request**, on loopback as well as over a network, and
  compared with a timing-safe equality check. Any process on the machine can reach
  a loopback port, and this one can place orders.
- **Sign-in attempts are throttled.** `/v1/auth/login` allows ten failures a
  minute per username; `/v1/auth/otp` allows five, because a short numeric
  verification code is far cheaper to guess than a password.
- **WebSocket authentication** uses the `Authorization` header on the upgrade
  request. Browsers cannot set that header, so `POST /v1/stream/ticket` issues a
  single-use, short-lived ticket a browser client passes as a query parameter.

The server refuses to start while `TRBOT_SERVER_TOKEN` still holds the example
value from `.env.example`, so an unconfigured deployment fails loudly instead of
running with a published secret.

Provider credentials live only on the server, and so do the ChatGPT tokens.
Clients authenticate to the server, never to the provider.

## Certificates

`bun run server:cert` generates certificates itself rather than delegating to
`openssl` or `mkcert`, so provisioning behaves identically on every machine, needs
no external binary, and can be tested like any other code. Keys are ECDSA P-256
through WebCrypto; certificates are assembled with `@peculiar/x509`, which
contains no native code.

The first run creates an authority under `data/tls/` and reuses it afterwards, so
clients that already trust it keep working. Private keys are written owner-only.
The command prints the authority path, which clients trust through
`TRBOT_SERVER_CA`, so no system trust store has to be modified.

A client trusts it in both places it connects: the requests and the WebSocket
each carry their own TLS settings, and trusting the authority for one only is
worse than not trusting it at all — the terminal appears to connect and then
never receives a quote.

The authority is valid for ten years and a server certificate for 397 days.
Expiry is the awkward part: a certificate that has run out fails at connection
time, in a process nobody is watching. So the server checks its own certificate at
startup — the one moment there is an operator nearby — and warns when fewer than
30 days remain, or when it has already lapsed, naming the command that reissues
it. Renewal stays a deliberate act: reissuing rotates the key, and doing that
silently under a running server would be worse than the warning.

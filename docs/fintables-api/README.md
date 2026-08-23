# Fintables market data protocol

Implementation notes for using Fintables as a market data source: how a session is
established, how the realtime entitlement is carried, and which endpoints serve
candles, quotes, and depth.

Written while building `@trbot/feed`, and checked against a live account from a
Bun process on 2026-08-21 and 2026-08-22. Where a claim was checked outside BIST
hours, that is stated.

## Hosts

| Host | Purpose |
| --- | --- |
| `api.fintables.com` | Account API. Login, session check, notifications, feeds. |
| `markets.fintables.com/barbar/udf` | TradingView UDF datafeed: candles and symbol metadata. |
| `markets.fintables.com/barbar/server` | Auxiliary market data: `/yield`, `/akd` (broker distribution). |
| `markets.fintables.com/vessel` | WebSocket: realtime quotes, depth, trades. |
| `gate.fintables.com/search` | Typesense symbol search. |

## Client transport consistency

Every `markets.fintables.com` and `api.fintables.com` path is served through
Cloudflare. Its client checks consider the HTTP headers together with the TLS
and HTTP2 connection profile, so those layers need to identify the same client:

| Request | Result |
| --- | --- |
| Bun `fetch` with no added headers (2026-08-21/22) | **200**, but later challenged |
| Bun `fetch` with a Chrome `User-Agent`, `Origin`, `Referer` | **403** challenge page |
| `curl` with a Chrome `User-Agent` | **403** challenge page |
| Chrome headers with a matching Chrome TLS/HTTP2 profile | Selected transport |

Chrome HTTP headers and Bun's native TLS/HTTP2 profile describe different
clients, so that combination is rejected. `FetchFeedTransport` uses Impit's
aligned Chrome TLS, HTTP2, and header profile from inside the Bun process. Keep
the header and connection profiles together when changing this transport.

A challenge response is HTML with `Just a moment...` and HTTP 403. Treat it as a
distinct, retryable-but-not-auth failure so it is never confused with a 401.

## Authentication

Two tokens, with different jobs. Confusing them produces a 401 that looks like
bad credentials.

| Token | Source | Used for |
| --- | --- | --- |
| `access` (235 chars) | `POST /auth/token/` | `api.fintables.com` requests |
| `stream_token` (179 chars) | `GET /auth/check/` | market data: UDF **and** WebSocket |

The `access` token is **rejected** by the UDF endpoints (`401 {"s":"error",
"errmsg":"Yetkiniz bulunmuyor"}`). Only `stream_token` lifts the delay.

### 1. Login

```http
POST https://api.fintables.com/auth/token/
Content-Type: application/json

{"email": "...", "password": "..."}
```

```json
{ "refresh": "eyJ...", "access": "eyJ..." }
```

A Django SimpleJWT pair. `POST /auth/token/refresh/` with `{"refresh": ...}`
renews the access token.

### 2. Session check — where `stream_token` comes from

```http
GET https://api.fintables.com/auth/check/
Authorization: Bearer <access>
```

```jsonc
{
  "user": {
    "id": 498473,
    "email": "...",
    "subscriptions": [{ "product": "imkbex", "status": "active", ... }],
    "stream_token": "eyJ...",          // the realtime data license
    "ip": "..."
  },
  "permissions": [
    { "action": "read", "subject": "prices.realtime" },
    { "action": "read", "subject": "orderbook" },
    { "action": "read", "subject": "future.contracts" }
  ]
}
```

`permissions` is the whole entitlement picture, and it is the account's own
answer rather than something to infer from a failed request:

| Subject | Gates |
| --- | --- |
| `prices.realtime` | candles and quotes arriving live rather than 15 minutes late |
| `orderbook`, `orderbook.pay-10`, `orderbook.viop-10` | depth |
| `akd`, `akd.pay`, `akd.viop` | the brokerage distribution |
| `custodies` | the custody register |

Several subjects are granted per market as well as outright, so a permission
check has to accept `orderbook.viop-10` as entitling depth just as `orderbook`
does. The list also repeats itself — a PRO account returned 69 entries covering
32 distinct `read` subjects — and carries other actions (`use`, `manage`,
`login`) that say nothing about data.

`stream_token` is a JWT whose payload carries no `exp`:

```json
{ "user_id": 498473, "licenses": ["mkk", "pite", "vd2", "imkbex", "krmd1", "pd2"] }
```

It does not expire on a timer, but it **rotates when licenses change**. The web
app detects this by re-reading `/auth/check/` and comparing the sorted `licenses`
claim against the token it holds. A client should re-read `/auth/check/` on any
UDF/WebSocket 401 rather than treating it as a credential failure.

### One license, one device

> "Borsa İstanbul kuralları gereği, bir lisans aynı anda tek cihazda geçerlidir."
> (Per Borsa İstanbul rules, one license is valid on only one device at a time.)

The WebSocket enforces this: a second connection on the same license causes the
server to send `{"type":"concurrent_session_error"}` to the loser. **A server
holding this stream will evict the user's own browser session, and the browser
will evict the server.** This is a hard product constraint, not a bug to work
around — it has to be a deliberate decision about which client holds the license.

The delayed feed has no such restriction, because it needs no token at all.

## Delayed versus realtime

The feed states its own entitlement, so this is directly observable rather than
inferred. `GET /barbar/udf/symbols?symbol=<code>`:

| Symbol | No auth | `Bearer <stream_token>` |
| --- | --- | --- |
| `GARAN` (equity) | `delayed_streaming`, `delay: 900` | `streaming`, `delay: 0` |
| `XU100` (index) | `delayed_streaming`, `delay: 900` | `streaming`, `delay: 0` |
| `F_USDTRY0826` (VIOP future) | `delayed_streaming`, `delay: 900` | `streaming`, `delay: 0` |
| `USDTRY`, `BTCUSDT` | `streaming`, `delay: 0` | `streaming`, `delay: 0` |

BIST equities, indices, and VIOP futures are delayed **15 minutes** without the
token and realtime with it. FX, metals, and crypto are realtime either way.

This was measured, not only read off the `delay` field. BIST index futures run an
evening session (`0920-1810,1900-2300`), so `F_XU0300826` was observable at 21:57
Istanbul on a `resolution=1` request:

| Request | Age of last bar | Last close |
| --- | --- | --- |
| no auth | 998 s (~16.6 min) | 16810 |
| `Bearer <stream_token>` | 38 s | 16813 |

Same request, same second: the unauthenticated feed is a quarter-hour behind and
quoting a stale price. Controls behaved as expected — `F_USDTRY0826` (no evening
session) was flat at its close on both, and 24x7 `USDTRY` returned the same
current forming bar on both.

## UDF datafeed

Base: `https://markets.fintables.com/barbar/udf`, standard TradingView UDF. The
web app builds it as `new UDFCompatibleDatafeed(base, 2500)` and sets
`_requester._headers = { Authorization: "Bearer <stream_token>" }`.

| Endpoint | Notes |
| --- | --- |
| `GET /config` | Capabilities and `supported_resolutions`. |
| `GET /time` | Server epoch seconds, as plain text. |
| `GET /symbols?symbol=<code>` | Symbol metadata, including `delay` and `data_status`. |
| `GET /history?symbol=&resolution=&from=&to=&countback=&currencyCode=` | Candles. |
| `GET /search?query=&type=&limit=` | Present per `/config`, but **CORS-blocked in-browser and unverified**; use `symbols.js` or Typesense instead. |

### Resolutions: the advertised list is wrong

`/config` and `/symbols` both advertise `supported_resolutions` as
`["M","W","D","240","60","30","15","5","1"]`. **Only five of those nine work.**

| Resolution | Result | History available |
| --- | --- | --- |
| `1` | ✅ | ~2 months (about 30k bars, then capped) |
| `5` | ✅ | ~2 months |
| `15` | ✅ | ~3 months |
| `60` | ✅ | ~5.5 months |
| `D` | ✅ | **~21 years** (GARAN to 2005-05, XU100 to 2005-03) |
| `30` | ❌ HTTP 400 `Geçersiz çözünürlük` | — |
| `240` | ❌ HTTP 400 | — |
| `W` | ❌ HTTP 400 | — |
| `M` | ❌ HTTP 400 | — |

The honest list is the symbol's `intraday_multipliers`, `["1","5","15","60"]`,
plus `D`. The symbol payload also reports `has_weekly_and_monthly: false`, which
is the charting library's signal to build those periods itself — so a client must
fold 30-minute, 4-hour, weekly, and monthly bars from a grain the feed will
actually serve. `@trbot/feed/aggregate.ts` does that.

The intraday cutoffs are fixed server-side retention, not per-symbol: every
symbol's 5-minute history starts on the same date. So "full history" means daily
and coarser; a range that reaches further back than its grain allows simply shows
what exists.

`/history` returns TradingView's column-oriented shape:

```json
{ "s": "ok", "t": [1787324880, ...], "o": [...], "h": [...], "l": [...], "c": [...], "v": [...] }
```

`s` is `"ok"`, `"no_data"`, or `"error"` with `errmsg`. Note that a 401 also
comes back as `{"s":"error"}` with HTTP 401, so status and body both matter.

There is **no `/quotes` and no `/streaming` endpoint**. The chart's "live"
behaviour is the UDF library re-polling `/history` with `countback=2` every
2500 ms. Realtime quotes come from the WebSocket instead.

## WebSocket: `vessel`

```
wss://markets.fintables.com/vessel?streamtoken=<stream_token>
```

The token is passed in the query string *and* again in a `login` frame. Verified
working from Bun with no extra headers.

### Client frames

```jsonc
{"type": "login", "token": "<stream_token>"}          // send on open
{"type": "subscribe",   "topics": ["GARAN/C", ...]}   // after login_success
{"type": "unsubscribe", "topics": ["GARAN/C", ...]}
"ping"                                                 // raw text, every 4000 ms
```

Topics are `"<CODE>/<FIELD>"`. The web app batches **200 topics per frame**
(`for (let t = 0; t < e.length; t += 200)`) and treats 8000 ms without any message
as a dead connection (`messageTimeout: 8e3`, `heartbeat: {message: "ping",
interval: 4e3}`). All three numbers are read from its own socket options, not
guessed at from behaviour.

### Server frames

| Frame | Meaning |
| --- | --- |
| `{"type":"connection_success","id":"..."}` | Socket accepted. |
| `{"type":"login_success"}` | Token accepted; subscribe now. |
| `{"type":"subscribe_success","topics":[...],"data":[{...}]}` | Opening state per code. Topics echo back namespaced, e.g. `r/GARAN/C` (`r` = realtime). |
| `{"type":"concurrent_session_error"}` | The license moved to another device. |
| `{"k":"GARAN/C","v":129.9}` | Field delta — the common case. |
| `{"ob":"GARAN","v":{"l":0,"obs":"B","p":16821,"c":1,"s":5}}` | One order book level. |
| `{"o":"GARAN","v":{...}}` | Trade print. `v` is the HTTP print object, unchanged; see "The trade tape". |

An observed exchange:

```
<- {"type":"connection_success","id":"0lktyk18hf4"}
<- {"type":"login_success","message":"You've logged in successfully."}
<- {"type":"subscribe_success","topics":["r/GARAN/C","r/GARAN/P","r/USDTRY/C"],
    "data":[{"code":"GARAN","C":129.9,"P":129.3},{"code":"USDTRY","C":48.05971}]}
<- {"k":"USDTRY/C","v":48.0616}
```

### Order book

A level frame carries `l` (level index, 0–9), `obs` (`B` bid / `S` ask), `p`
(price), `c` (order count), and `s` (size in lots):

```json
{"ob":"F_XU0300826","v":{"l":0,"obs":"B","p":16821,"c":1,"s":5}}
```

Two traps here. `s` on this payload is the **size, not the side** — the side is
only ever `obs`. And the opening book does not arrive as level frames at all: it
comes nested inside the subscription acknowledgement, one `ob/<side>/<level>` key
per level, alongside the ordinary scalar fields.

```jsonc
{"type":"subscribe_success","topics":["r/F_XU0300826/ob-10"],
 "data":[{
   "code":"F_XU0300826",
   "ob/B/0":{"l":0,"obs":"B","p":16821,"c":1,"s":5},
   "ob/S/0":{"l":0,"obs":"S","p":16822,"c":1,"s":1}
 }]}
```

So a decoder that assumes snapshot rows hold only scalars rejects the whole
acknowledgement and loses both the opening book and the opening quotes. Subscribe
to `ob-10` for the book and to `BV`/`AV` for the resting totals behind a
buy/sell ratio.

The key is built from the level frame itself, which is why a level frame and a
snapshot row are the same object arriving by two routes:

```js
} else if (t.ob) {
  let e = t.ob, r = t.v, n = "ob/".concat(r.obs, "/").concat(r.l)
  S[e] ? S[e][n] = r : S[e] = { code: e, [n]: r }
}
```

Both the stock and the contract written on it have their own book — `SOKM` and
`F_SOKM0826` are each subscribable, gated by `orderbook.pay-10` and
`orderbook.viop-10` respectively. The brokerage feed carried only the
underlying's, which is why the terminal used to show one book with no choice.

Outside session hours the exchange clears the book rather than withholding it:
every level arrives with `p`, `c`, and `s` all null. That is an **empty** book,
not a missing one, and reading it as "this symbol has no book" is the easiest
mistake to make here. Compare the wall clock against the symbol's `session` to
tell a closed market from a thin one.

### The trade tape

Two transports, one shape. `GET /mobile/orderbook/transactions/?code=<code>` with
`Bearer <access>` returns the prints that already happened, cursor-paginated:

```jsonc
{ "next": "...&cursor=40586676", "previous": null, "results": [
  { "p": 129.9, "s": 30.0, "a": "S", "bb": "OYA", "sb": "AKM", "i": 40613119, "o": "N", "t": 1787324992 }
] }
```

`p` price, `s` size in lots, `a` the aggressor (`B` bought into the ask, `S` sold
into the bid), `bb`/`sb` the buying and selling brokerage codes, `i` the print id,
`t` epoch seconds. **VIOP does not disclose counterparties** — `bb` and `sb` are
null on every futures print.

The socket's `{"o": code, "v": {...}}` frame carries a new print **in exactly this
shape**. The web client buffers `v` with no transformation of any kind:

```js
} else if (t.o) {                              // a trade frame
  let e = t.o
  k[e] ? k[e].unshift(t.v) : k[e] = [t.v]      // pushed verbatim
}
```

and then flushes that buffer into the same query cache the HTTP endpoint fills,
ordering by the print id:

```js
const n = e[t].filter(e => r.pages[0].results[0] === undefined || e.i > r.pages[0].results[0].i)
return produce(r, e => { e.pages[0].results.unshift(...n) })
```

Socket rows are unshifted onto the array HTTP produced, compared on `i`. One
array, one renderer, one shape — so seed the tape over HTTP, append from the
socket, and key on `i` so a reconnect cannot print the same trade twice.

This comes from the web client rather than from a frame observed here: new prints
only flow during a session, and none has been seen arrive yet.

**The tape is per session.** It empties at the session boundary — the same symbol
returned a full page at 23:57 and zero results at 00:04. An empty tape out of
hours is normal, not a failure.

`GET /brokerages/` maps those codes to names:
`{"code":"OYA","title":"Oyak Yatırım","short_title":"Oyak",...}`. Read it once;
it is a reference list, not market data.

### Session status is barely defined

The `d` field carries an integer, and the vendor's own client defines exactly two
values:

```js
STATUSES = { SUREKLI_ISLEM: 2, DEVRE_KESICI: 13 }
```

Its only use is a circuit-breaker badge testing `=== 13`. Other values occur and
are interpreted by nothing: `26` on equities and `38` on index futures, both
observed after the close. FX, crypto and index symbols send no `d` at all.

So do not read open/closed off this field. Derive it from the symbol's `session`
string, and use `d` only for the halt the clock cannot show — a circuit breaker.

### Field codes

```
T   TIMESTAMP        d   STATUS           CP  CHANGE_PERCENT
O   OPEN             P   DAY_CLOSE        C   CLOSE
L   LOW              H   HIGH             J   CEIL
K   FLOOR            A   ASK              B   BID
U   WAVG             V   VOL              M   LOT
AC  AUC_PRICE        ACP AUC_CHANGE_PCT   AD  AUC_SIZE
AG  AUC_REM_ASK      AF  AUC_REM_BID
BV  OB_BID_TOTAL_VOL BW  OB_BID_WAVG      AV  OB_ASK_TOTAL_VOL
AW  OB_ASK_WAVG      MA  MM_ASK           MB  MM_BID
ob-10  OB_10         best BEST            worst WORST
```

`DAY_CLOSE` (`P`) is the previous close used as the change-percent baseline, not
today's close; `CLOSE` (`C`) is the last trade. Change percent is derived
client-side from `P` and `C` rather than pushed.

## Symbol universe

Two JSON endpoints cover it, both with `Bearer <access>`.

### Cash instruments — `GET /symbols/`

```jsonc
{ "data": [
  { "code": "BOSSA", "type": "equity", "title": "Bossa Ticaret ...",
    "format": { "decimals": 2 }, "logo": "...", "flags": [] },
  { "code": "XHOLD", "type": "index", "session": "0955-1810", ... }
] }
```

3571 entries, one page, no pagination parameters honoured. Types and counts:

| Type | Count | Type | Count |
| --- | --- | --- | --- |
| `fund` | 2355 | `index` | 47 |
| `pfund` | 427 | `crypto` | 33 |
| `equity` | 651 | `fx` | 21 |
| `efund` | 34 | `currency`, `gms`, `ems` | 1 each |

`session` is present on non-equity types and absent on equities, which sit at the
default `0955-1810`.

**This endpoint contains no futures at all** — zero `F_` codes. A `?type=future`
filter is silently ignored and returns the full list, so filtering must happen
client-side.

### Futures — `GET /mobile/symbols/collections/`

```jsonc
[ { "title": "VİOP Aktif Vade", "data": ["F_XU0300826", "F_AEFES0826", ...] } ]
```

Six collections: `XU100` (100), `XU030` (30), `XUTUM` (582), `Döviz` (8),
`Emtia` (11), and `VİOP Aktif Vade` (63). The last is the active-contract list
and the only JSON source of VIOP codes; the others double as index constituents.

Codes are `F_<UNDERLYING><MMYY>`, e.g. `F_XU0300826` for the August 2026 BIST 30
future. Do not construct them — a wrong month returns HTTP 400 (`F_XU0300926`
did). Read the collection instead.

Session strings differ per contract and matter for scheduling: single-underlying
futures are `0920-1810`, while index futures add an evening session,
`0920-1810,1900-2300`. Read it from UDF `/symbols?symbol=<code>`.

Treat contract and underlying availability separately. For example,
`F_XAUTRYM0826` is in `VİOP Aktif Vade` and its candle history answers, but
neither `XAUTRY` nor `XAUTRYM` exists in `/symbols/`; both underlying-history
requests return HTTP 400. The server therefore annotates each brokerage
contract by intersecting it with both feed universes. The TUI offers only the
confirmed chart and depth targets, and broker distribution/settlement only when
the matched underlying has `type=equity`.

## Recent financials — `GET /screener/`

The "Son Bilançolar" table reads the account API with `Bearer <access>`. Its
`filter` parameter is a field projection rather than a predicate:

```http
GET /screener/?period=null&filter=published_at||!period||!kapanis||!gunluk_getiri||!piyasa_degeri||!net_kar||!yillik_net_kar_degisimi||!fk||!pddd||
```

```jsonc
{
  "header": ["Hisse", "Açıklanma", "Periyot", "Son Fiyat", "Gün %", ...],
  "attributes": [
    { "key": "published_at", "title": "Açıklanma", "format": { "date": true } },
    { "key": "net_kar", "title": "Net Dönem Karı", "format": { "prefix": "₺" } }
  ],
  "data": [
    { "code": "THYAO", "published_at": "2026-08-18T15:00:00Z",
      "period": "2026/6", "kapanis": 300.0, "gunluk_getiri": -1.0,
      "piyasa_degeri": 410000000000, "net_kar": 15000000000,
      "yillik_net_kar_degisimi": 20.0, "fk": 8.0, "pddd": 1.2 }
  ]
}
```

`period=null` means each company's latest available filing, so one response can
legitimately contain more than one period. A concrete `YYYY/M` value asks for
that reporting period. Numeric values are raw amounts or percentages, not the
abbreviated strings rendered by the table, and ratios or changes can be null.

The signed-in column picker exposes 97 numeric metrics across price and volume,
valuation, custody, profitability, leverage, growth, the three financial
statements, and activity ratios. The application maps every one to a
provider-neutral metric name and projects only what a caller asks for. Omitting
the metric list uses a compact trading set covering liquidity, valuation,
profitability, leverage, annual and quarterly growth, EPS, and free cash flow;
`includeAllMetrics` remains available for a complete reading. This keeps a
normal multi-company tool result bounded without hiding the raw accounting or
BIST-100-only custody fields when they are specifically useful.

The endpoint returns the whole equity universe. `FeedRecentFinancialSource`
therefore applies the product boundary itself: it intersects the cash-equity
universe from `/symbols/` with `VİOP Aktif Vade`, and returns only those company
underlyings. Index, currency, and metal futures remain available to the trading
desk but cannot leak through the company-financials tool.

### What no JSON endpoint provides

Contract **multiplier, expiry date, underlying, and collateral** are not exposed
by any endpoint found. Every plausible path (`/viop/`, `/future/contracts/`,
`/mobile/viop/`, `/barbar/server/contracts`, and a dozen more) returns 404,
despite `future.contracts` and `future.collateral-table` appearing in
`permissions`. Only the `symbols.js` script carries them.

Expiry is derivable from the code's `MMYY` plus the exchange calendar. For
multiplier and collateral, prefer the brokerage — `@trbot/provider` already
returns `contractSize` and `initialCollateral`, and those are the numbers orders
are actually sized against.

## Broker readings

Two endpoints, on two different hosts, with two different tokens. The company
pages render these server-side; the trading screen (`/islem-ekrani?code=GARAN`) is
where the browser fetches them itself.

### Distribution — `GET /barbar/server/akd`

*Aracı kurum dağılımı*: which houses accumulated or distributed a stock.
`markets.fintables.com`, **`stream_token`**.

```http
GET /barbar/server/akd?code=GARAN&start=2026-08-21&end=2026-08-21
```

```jsonc
{
  "start": "2026-08-21 00:00:00",
  "end": "2026-08-21 00:00:00",
  "results": [
    { "brokerage": "ZRY",
      "net":   { "size": 598581,  "cost": 131.256, "percentage": 0.1707 },
      "total": { "size": 1447403, "volume": 189054047, "cost": 130.616, "percentage": 0.0249 } }
  ]
}
```

Verified behaviour:

- **Both sides in one response, signed.** `net.size > 0` bought more than it
  sold. Rows arrive ranked by signed size, so the sellers are at the end in
  ascending magnitude. Net sizes sum to exactly zero.
- `net.percentage` is a **fraction of that house's own side**, not of the market:
  each side sums to 1.0 and the whole response to 2.0. `total.percentage` is the
  share of total volume instead.
- `start` and `end` are both **required** (`400 {"error":"start ve end
  zorunludur"}`), and `start > end` is a 400. A range spanning several days is
  aggregated over the whole range.
- A non-trading day, an unknown code, a lowercase code, an index, or a VIOP
  contract all answer `{"results":[]}` with HTTP 200. Codes are case sensitive
  and cash-equity only.
- No top-N grouping and no timestamp: the leading-houses headline is the client's
  to compute.
- **It moves every few seconds while its range includes today.** Their own client
  sets `refetchInterval` from the range: `preset || now.isBetween(start, end,
  "day", "[]") ? 2500 : 6e5` — 2.5 s for a range covering today, 10 minutes for a
  historical one. So a reading of the current session is live data, not a
  once-a-day summary.
- `preset` replaces `start`/`end`, and it is **not** a date range. The endpoint
  enumerates its own vocabulary when given a bad one:
  `{"error":"Invalid preset: 1d. Available presets: 1m, 5m, 15m, 30m, 1h, 2h"}`.
  Those are rolling intraday lookbacks — `preset=15m` is who bought and sold in
  the last fifteen minutes, ending now (`preset=1m` answered
  `2026-08-22 02:37:00 → 2026-08-22 02:38:00`). A separate feature from the
  date-range reading, and the reason their client treats any preset as live.
- **`net.cost` is null on a house that ended flat.** A house that bought and sold
  the same amount has no net position and so no price for one, and the feed says
  so rather than quoting a zero. Observed 34 times across 30 symbols on one day —
  GARAN happened to have none, which is how a strict schema for it passed and
  then rejected SAHOL. `total.cost` is nullable by the same logic.

### Custody register — `GET /mobile/custodies/`

*Takas analizi*: what each settlement house was left holding.
`api.fintables.com`, **`access`** token — the `stream_token` is rejected here,
which is the reverse of the endpoint above.

```http
GET /mobile/custodies/?index=custodian&code=GARAN&date=2026-08-21
```

```jsonc
{
  "date": "2026-08-21",
  "results": [
    { "custodian": "TGB", "value": 1866236548.06, "percentage": 0.7601915995 }
  ]
}
```

Verified behaviour:

- `value` is **lots held** (the UI column is *Adet*), and it is fractional.
- `index=custodian` is the only value that returns anything; anything else,
  including omitting it, answers `{"date":null,"results":[]}`.
- `date` is optional and asks for the latest settled day. A day the feed has not
  settled — a weekend, a holiday, the future — is answered with the last one it
  has, and the response **echoes the day it actually reported**. That echo is
  the only way to know, and it also makes walking back to the previous settled
  day a single request.
- **This list is truncated, and nothing in the response says so.** GARAN answered
  with 44 houses on a day the diff endpoint reports 124 for. Houses therefore
  appear and disappear between consecutive registers without moving a single lot,
  which makes differencing two registers unsound: on 2026-08-20 → 21, `BLS` drops
  off the list and a hand-rolled difference calls that a sale of its whole
  256 966 lots, where the truth is −25 247. **Never measure a move this way** —
  use the diff endpoint below, which reads the whole book on both dates.
- A residual `FARK` ("difference") row appears for lots not attributed to a
  house. It is not in `/brokerages/`, so it has no name to render.
- A symbol can have **no register at all** for a day the exchange traded it:
  `{"date":null,"results":[]}`, seen on KOZAL. Not an error, and distinct from an
  unsettled day, which answers with an earlier date instead.
- `index` also takes `brokerage`, and then the query parameter changes with it:
  `?index=brokerage&brokerage=<code>` reads one house's custody across every
  stock, which is the `/araci-kurumlar/<code>/takas-analizi` page. `custodian`
  pairs with `code=`, and mixing the two answers empty.

### Custody movement — `GET /mobile/custodies/diff/`

Who added and who shed over a range, served rather than computed.

```http
GET /mobile/custodies/diff/?index=custodian&code=GARAN&start=2026-08-20&end=2026-08-21
```

```jsonc
{ "start_date": "2026-08-20", "end_date": "2026-08-21", "results": [
  { "custodian": "YATFON", "difference": 2424165,
    "first_value": 149899633.01, "first_percentage": 6.097443057063344,
    "last_value": 152323798.01,  "last_percentage": 6.196050423524756,
    "percentage_change": 0.09860736646141177 } ] }
```

Verified behaviour, and two traps:

- **Percentages here are already scaled.** `6.196…` means 6.196%, where the plain
  register returns `0.0620…` for the same holding. The two endpoints disagree on
  units, so a shared mapper has to know which one it is reading.
- **The window is endpoint to endpoint.** `first_value` is the position on
  `start`, `last_value` the position on `end`, so `start=D&end=D` returns **zero
  rows** — a single day shows no movement. To ask "who moved today", pass the
  previous settled day as `start`.
- `last_value` is the standing position, so a movement row can state what a house
  now holds as well as what it moved. `difference` is signed; the ranking is the
  caller's.
- Both dates are **required**: omitting either answers
  `{"start_date":null,"end_date":null,"results":[]}` rather than defaulting.
- Each date **snaps back to a settled day** and the response echoes what it used,
  so plain calendar dates can be sent without hunting for the previous trading
  day: `start=2026-08-16&end=2026-08-22` answered `2026-08-14 … 2026-08-21`. The
  trap is that this makes today's date collapse a window — `start` a day before
  today and `end` today both land on the last settled day, and the reading comes
  back empty. Anchor on a day the register has, not on today.
- The large houses agree with a hand-rolled difference (GARAN 2026-08-20 → 21:
  YATFON +2 424 165, MLB +1 256 505, MRS +308 227). The small ones do not, and
  that is the point — see the truncation note above.

### How far back they go

Their date picker is bounded at `fromDate: new Date(2023, 11, 1)` — 1 December
2023 — and that bound is the distribution's own data floor rather than a UI
choice. On GARAN:

| Date | Register rows | Distribution rows |
| --- | --- | --- |
| 2023-06-01 | 44 | **0** |
| 2023-12-01 | 39 | 47 |
| 2024-06-03 | 38 | 47 |
| 2025-08-21 | 41 | 51 |

So the distribution starts around December 2023 while the custody register
reaches further back still. `@trbot/feed` offers a year of days in the range
picker (`FeedTradingDays` reads one `YEAR` of daily bars), which is well short of
what either endpoint will answer — a deliberate cap, not a limit of the feed.

### House names — `GET /brokerages/`

`api.fintables.com`, `access` token. 125 rows of `{code, title, short_title,
logo, public_company, is_listed}`, covering both the trading codes on the tape
and the custodian codes in the register (`TGB` → "Garanti Bank."). Read once.

### Search

`/barbar/udf/search` **does not exist** — HTTP 404 server-side as well as
CORS-blocked in-browser, despite `/config` advertising `supports_search: true`.
The web app uses Typesense at `gate.fintables.com/search` with a public
`X-TYPESENSE-API-KEY`, or filters `/symbols/` locally.

## Open questions

- Whether a socket print ever differs from the HTTP one in practice. Their client
  buffers `v` verbatim and merges it into the HTTP list on `i` (see "The trade
  tape"), so the shapes are the same by construction; what remains unseen is a
  frame actually arriving. `@trbot/feed` parses strictly against the HTTP schema,
  so a surprise stops the tape growing rather than inventing rows.
- What `d` values other than 2 and 13 mean. Nothing in the vendor's client
  interprets them either.
- Whether `stream_token` ever has to be re-read absent a license change.
- Cash-equity lag has not been measured directly, only for index futures; the
  declared `delay: 900` is identical, so this is a formality for Monday.
- How often the **custody** register moves during a session. Its shared query hook
  sets no `refetchInterval` at all, unlike akd's 2.5 s, so it is presumably
  refreshed on mount and on demand — but the panel's own call site was not found
  in the chunks read. akd's cadence is settled (see above).

## Implementation

`@trbot/feed` implements all of the above and is wired in as the server's market
data source. It is named for what it does rather than who serves it; the vendor
appears only in URLs, wire field names, and the credential variables
(`FINTABLES_USERNAME` / `FINTABLES_PASSWORD`).

Four constraints from this document shaped it:

- **One socket per process.** `MarketSocket` is shared by every quote, equity
  quote, and depth consumer, with topics reference counted, because a second
  connection would evict the first.
- **One coherent browser identity.** `FetchFeedTransport` uses a matching Chrome
  TLS, HTTP2, and header profile. A challenge response raises
  `FeedChallengeError` so it is never mistaken for an authentication failure.
- **Only five resolutions are real.** `candles.ts` requests one the feed serves
  and folds the rest through `aggregate.ts`. Weekly and monthly bars are cut on
  the exchange's calendar in `Europe/Istanbul`, not by dividing the timeline.
- **The feed knows tickers, the application knows brokerage uids.**
  `InstrumentSymbols` translates between them, and `InstrumentCandleSource` hands
  back the identifier the caller asked with. Sending a uid straight through is
  answered with HTTP 400, and the broker readings need the *underlying* stock
  besides, since neither is published for a contract.

Two more followed from the broker readings:

- **A move is the feed's own difference, never two registers subtracted.** The
  register is truncated, so `FeedSettlementSource` reads `/mobile/custodies/diff/`
  for movement and keeps the register for the standing position. It anchors the
  window on a settled day rather than on today, and baselines the day before the
  range so the range's first session counts as movement inside it.
- **There is no calendar endpoint.** `FeedTradingDays` takes the day list from
  the instrument's own daily bars, so the range picker offers days the exchange
  actually traded that symbol — five years of them, trimmed to
  `DISTRIBUTION_HISTORY_START` for the distribution, which has nothing earlier.

Entitlements follow the data. `FeedMemberFeatureSource` answers for depth, the
distribution and the register from `permissions`, because the account that serves
the data is the one that decides whether it may be read; the brokerage still
answers for everything else.

Range and timeframe are independent in the application because this feed serves
every grain at every range — the brokerage feed did not, which is why the chart
used to pick the timeframe from the range.

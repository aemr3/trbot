# Protocol conventions and examples

This file collects rules shared across GraphQL, SSE, and multipart calls. Endpoint-specific variables and response paths are defined in the other files in this directory.

## GraphQL request construction

For an operation document `document`:

```text
operationId = lowercaseHex(SHA256(UTF8(document)))
timestamp   = current Unix time in whole seconds, as decimal text
checksum    = lowercaseHex(SHA256(UTF8(operationId + ":" + timestamp + ":MGCh5U5KVD")))
```

Runtime variables do not affect `operationId`. Whitespace, aliases, arguments, fragment order, and selected fields do because they are part of the document bytes.

Exact example using `retrieveLoginNonce` at timestamp `1700000000`:

```text
document:    query retrieveLoginNonce { retrieveLoginNonce { serverTimestamp } }
operationId: a9266910827343924ce3d55ab67fb8957820e48e81c5a9b80b7cc658a688b23e
checksum:    62b1e62019359df4db0fc281ca5b20e16d5eefafe647be9d267971b38080b4f2
```

```http
POST /router-graphql HTTP/1.1
Host: api.getmidas.com
Accept: multipart/mixed;deferSpec=20220824, application/graphql-response+json, application/json
Content-Type: application/json
Accept-Language: tr
Apollographql-Client-Name: Midas
Apollographql-Client-Version: v3.2.1
X-Midas-App-Id: main
X-Version: 2
X-User-Agent-UID: ABEiM0RVZneImaq7zN3u_w
X-Apollo-Operation-Name: retrieveLoginNonce
X-Apollo-Operation-Id: a9266910827343924ce3d55ab67fb8957820e48e81c5a9b80b7cc658a688b23e
X-Timestamp: 1700000000
X-Api-Checksum: 62b1e62019359df4db0fc281ca5b20e16d5eefafe647be9d267971b38080b4f2

{"operationName":"retrieveLoginNonce","query":"query retrieveLoginNonce { retrieveLoginNonce { serverTimestamp } }","variables":{}}
```

Add `Authorization: Bearer <accessToken>` when an operation requires an authenticated member. The exact document and ID must remain paired.

## GraphQL responses and errors

The top-level `data` member may be absent when GraphQL reports errors. Field nullability in the [complete operation catalog](graphql-operations.md#complete-contract-archive) is relative to a present parent object.

```ts
interface GraphqlResponse<T> {
  data?: T
  errors?: Array<{
    message?: string
    path?: Array<string | number>
    extensions?: { code?: string | number; [key: string]: unknown }
    [key: string]: unknown
  }>
}
```

Do not treat HTTP `200` as application success until the `errors` array has been checked. Preserve unknown error extensions for diagnostics, but redact authentication material.

## Scalars, dates, and identifiers

| Value | Wire rule |
| --- | --- |
| GraphQL `Int` | Signed 32-bit JSON integer |
| GraphQL `Long` | Signed 64-bit JSON integer; JavaScript consumers must guard values outside the safe-integer range |
| GraphQL `Float` | JSON number |
| GraphQL `Date` | `YYYY-MM-DD` calendar-date string |
| GraphQL `DateTime` | ISO 8601 date-time string |
| SSE `Decimal` | JSON number or numeric string; retain decimal precision rather than assuming binary floating point is exact |
| SSE timestamp | Preserve the raw number until the endpoint-specific unit is known; feeds use both seconds and milliseconds |
| UID/ID | Opaque string; do not parse, case-fold, or infer UUID semantics unless its contract explicitly says UUID |
| Enum | Exact case-sensitive wire value from [wire-types.md](wire-types.md) |

Missing, explicit `null`, zero, and an empty string are distinct values. Do not invent defaults for Midas fields.

## Pagination families

The operation catalog exposes several independent pagination shapes. Follow the fields selected by the specific operation:

| Family | Request | Continue while | Safety rule |
| --- | --- | --- | --- |
| Page index | `page`, `size` or `pageSize` | `hasMore` or `hasNext` is true | Existing callers use zero-based pages; stop if a continued page is empty |
| Screener cursor | `pitId`, `searchAfter` | `searchAfter` is non-empty and collected rows are below `totalSize` | Pass the returned `pitId` and `searchAfter` unchanged |
| Offset/limit | operation-specific offset and limit variables | returned count indicates another page | Do not translate into page indexes unless the operation contract does so |

Deduplicate accumulated entities by their Midas UID because pages may overlap when market data changes during traversal. Never assume a universal maximum page size; use the operation's existing client value or a bounded value accepted by that operation.

## SSE request and frame example

```http
GET /reactive-viop-api/v1/viop/futures/price-quote?symbol=F_TUPRS0826 HTTP/1.1
Host: stream.getmidas.com
Accept: text/event-stream
Accept-Language: tr
Cache-Control: no-cache
Authorization: Bearer <accessToken>
X-Midas-App-Id: main
X-User-Agent-Uid: ABEiM0RVZneImaq7zN3u_w
```

```text
event: PriceUpdate
data: {"s":"F_TUPRS0826","p":231.4,"a":231.5,"b":231.3,"ss":"OPEN","ts":1700000000000}

```

A blank line terminates a frame. Join multiple `data:` lines with `\n`. Ignore comment/keep-alive lines beginning with `:` and fields other than `event` and `data`. A missing `event:` produces a default event with a null event name; the route's payload contract still applies.

On clean EOF or a transient connection failure, reconnect with bounded backoff and reauthenticate so an expired token can be refreshed. Reset the backoff only after a valid payload is received. Do not retry non-transient authorization or request errors in a tight loop.

## Multipart patterns

Use `multipart/form-data` and let the HTTP implementation generate the boundary. Do not manually set a `Content-Type` header without its boundary.

Single-file example:

```text
Content-Disposition: form-data; name="multipartFile"; filename="identity.jpg"
Content-Type: image/jpeg

<binary bytes>
```

Indexed identity-document example:

```text
Content-Disposition: form-data; name="documentList[0].fileType"

IDENTITY_FRONT
--boundary
Content-Disposition: form-data; name="documentList[0].multipartFile"; filename="front.jpg"
Content-Type: image/jpeg

<binary bytes>
```

When a back image is included, use `documentList[1].fileType=IDENTITY_BACK` and `documentList[1].multipartFile`. Exact part names for all recovered uploads are in [http-endpoints.md](http-endpoints.md).

## Sensitive-data handling

Treat bearer and refresh tokens, passwords, OTP values, private keys, signatures, member/account identifiers, uploaded identity documents, and complete authentication bodies as sensitive. Keep durable credentials out of logs and source control. Redact request headers and payload fields before recording diagnostics.

# Midas API reference

This directory is the standalone protocol reference for the Midas API used by this project. It contains no credentials, tokens, private keys, member identifiers, or account data.

## Contents

| File | Purpose |
| --- | --- |
| [authentication.md](authentication.md) | Initial login, device binding, token refresh, unrestricted signatures, and restricted-device-key registration/login |
| [protocol-conventions.md](protocol-conventions.md) | Canonical requests, checksum construction, scalar rules, pagination, SSE reconnection, and multipart examples |
| [graphql-operations.md](graphql-operations.md) | Searchable index of all 574 executable GraphQL operations, their variables, response roots, and operation-ID construction |
| [graphql-operations.json.gz](graphql-operations.json.gz) | Compressed machine-readable catalog containing every exact document, operation ID, variable, and typed output field |
| [graphql-types.md](graphql-types.md) | Every named GraphQL variable type and response fragment type referenced by the documents |
| [wire-types.md](wire-types.md) | Complete GraphQL input-object and enum definitions, shared GraphQL envelopes, and HTTP upload response types |
| [sse-streams.md](sse-streams.md) | Resolved server-sent-event routes, parameters, event names, and payload shapes |
| [sse-streams.json](sse-streams.json) | Machine-readable resolved SSE endpoint catalog |
| [http-endpoints.md](http-endpoints.md) | GraphQL transport and non-GraphQL upload endpoints |
| [http-endpoints.json](http-endpoints.json) | Machine-readable resolved HTTP endpoint catalog |
| [../configuration.md](../configuration.md) | Project environment variables, defaults, and database-path behavior |

## Scope and guarantees

The GraphQL catalog contains 574 unique executable operations: 355 queries and 219 mutations. For names that previously had multiple response selections, the catalog retains the document with the complete selection. A narrower document can be produced by removing fields and calculating its operation ID as documented in `graphql-operations.md`. Each retained operation has a generated request serializer and response adapter; document-only definitions without those executable contracts are excluded. The type reference defines all 48 input objects, all 440 enums, and all scalar encodings in the Midas GraphQL contract.

GraphQL nullability is exact for operation variables because it is encoded in each variable declaration. A variable is required when its outer type ends in `!` and has no default. Every named input object and every enum used by those variables is defined in `wire-types.md`. Each operation entry also resolves every selected output path to its JSON type, field nullability, list-item nullability, alias, and fragment type condition.

The SSE reference contains fully composed network routes, parameters, subscription names, and payload contracts. Compact JSON keys are listed alongside their semantic field names.

The HTTP upload reference records all path/query arguments, multipart parts, and known response bodies.

## Finding a contract

Search the Markdown catalog by its exact operation heading:

```sh
rg -n '^### [0-9]+\. retrieveLoginNonce$' docs/midas-api/graphql-operations.md
```

For programmatic lookup, query the JSON catalog by operation name:

```sh
gzip -dc docs/midas-api/graphql-operations.json.gz \
  | jq ".operations[] | select(.name == \"retrieveLoginNonce\")"
```

The returned object contains `type`, `operationId`, the exact `document`, variable declarations, response roots, and every typed response field. The SSE and HTTP JSON catalogs use an `endpoints` array and can be queried in the same way:

```sh
jq '.endpoints[] | select(.name == "CryptoOverview")' \
  docs/midas-api/sse-streams.json
```

Use [graphql-types.md](graphql-types.md) to find which operations consume a named type. Use [wire-types.md](wire-types.md) for the complete fields of input objects and the legal values of enums.

## GraphQL transport

All cataloged GraphQL operations use:

```text
POST https://api.getmidas.com/router-graphql
Content-Type: application/json
```

Request body:

```ts
interface GraphqlRequest {
  operationName: string
  query: string
  variables: Record<string, unknown>
}
```

Response body:

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

Required protocol headers:

| Header | Value or construction |
| --- | --- |
| `accept` | `multipart/mixed;deferSpec=20220824, application/graphql-response+json, application/json` |
| `content-type` | `application/json` |
| `accept-language` | `tr` in the current client |
| `apollographql-client-name` | `Midas` |
| `apollographql-client-version` | Client release identifier; current implementation uses `v3.2.1` |
| `user-agent` | Client user-agent string |
| `x-midas-app-id` | `main` |
| `x-version` | `2` |
| `x-user-agent-uid` | Stable per-installation identifier encoded exactly as described below |
| `x-apollo-operation-name` | Exact operation name |
| `x-apollo-operation-id` | SHA-256 operation identifier from the catalog |
| `x-timestamp` | Current Unix time in whole seconds, encoded as a decimal string |
| `x-api-checksum` | Lowercase SHA-256 hex of `<operationId>:<timestamp>:MGCh5U5KVD` |
| `authorization` | `Bearer <accessToken>` for authenticated operations; omitted for initial authentication calls |

The body must carry the exact document corresponding to the operation ID. Do not derive an ID from a reformatted document; use the cataloged pair.

### `X-User-Agent-UID` encoding

This header is not a UUID string and is separate from `deviceId`. Generate one UUID v4, remove its hyphens, decode the remaining 32 hexadecimal characters into 16 bytes, then encode those bytes with the URL-safe Base64 alphabet and omit `=` padding. Persist the resulting 22-character string and reuse it for every GraphQL and SSE request from that installation.

```ts
function encodeUserAgentUid(uuid: string): string {
  const hex = uuid.replaceAll("-", "")
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error("Expected a UUID")
  return Buffer.from(hex, "hex").toString("base64url")
}
```

Exact example:

```text
UUID bytes:       00112233-4455-6677-8899-aabbccddeeff
X-User-Agent-UID: ABEiM0RVZneImaq7zN3u_w
```

Do not Base64-encode the 36-character UUID text. Standard Base64 is also incorrect here because this value uses `-` and `_` in place of `+` and `/` and has no padding.

## Authentication lifecycle

The protocol supports initial SMS device binding, refresh-token rotation, bound-device password login, and restricted-device-key login. The complete flow—including exact signed byte sequences, RSA encodings, biometric key policy, token recovery order, failure codes, and request/output shapes—is in [authentication.md](authentication.md).

The unrestricted and restricted keys are RSA-2048, and signatures use SHA-256 with RSA PKCS#1 v1.5 padding. Public keys and signatures use standard Base64; only `X-User-Agent-UID` uses unpadded Base64url.

## SSE transport

SSE calls use authenticated `GET` requests against `https://stream.getmidas.com`. The common headers are:

```text
Accept: text/event-stream
Accept-Language: tr
Cache-Control: no-cache
Authorization: Bearer <accessToken>
X-Midas-App-Id: main
X-User-Agent-Uid: <stable device identifier>
User-Agent: <client user agent>
```

A frame is separated by a blank line. Multiple `data:` lines are joined with `\n`; `event:` is optional and comment lines beginning with `:` are ignored.

```ts
interface SseFrame {
  event: string | null
  data: string // usually JSON; endpoint-specific types are in sse-streams.md
}
```

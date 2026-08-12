# Documentation

| Reference | Contents |
| --- | --- |
| [Midas API](midas-api/README.md) | Authentication, GraphQL operations and types, SSE routes and payloads, multipart endpoints, and protocol construction rules |
| [Configuration](configuration.md) | Environment variables, defaults, SQLite path behavior, credentials, permissions, and startup behavior |

The Markdown files are the human-readable reference. The complete GraphQL catalog is stored once as compressed JSON, while the smaller SSE and HTTP catalogs remain uncompressed JSON for tooling and code generation.

## Recommended starting points

- To make a GraphQL request, start with [protocol-conventions.md](midas-api/protocol-conventions.md), then find the operation in [graphql-operations.md](midas-api/graphql-operations.md).
- To implement login or session recovery, use [authentication.md](midas-api/authentication.md).
- To open a live feed, use [sse-streams.md](midas-api/sse-streams.md), including its exact event-to-payload dispatch table.
- To upload a document, use [http-endpoints.md](midas-api/http-endpoints.md) for the exact multipart part names.
- To configure a local run, use [configuration.md](configuration.md).

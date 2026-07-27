# Changelog

All notable changes to the `app-ingress` contract and its packages.

This repo distributes by **immutable git tag** (ADR-0004 + Amendment 1). A published
tag is never moved or deleted — a mistake in `v1.0.0` is fixed by `v1.0.1`, because
downstream lockfiles resolve a tag to a commit SHA and a moved tag is a silent
supply-chain change.

## v1.0.0 — the contract freezes

**`app-ingress` v1 is frozen. From this tag on, this contract is additive only.**
A breaking change is a NEW contract (`app-ingress v2`, a new `$id` namespace, a new
directory) — never an edit to this one.

### The surface

Eight routes, five core and three capability-gated:

| Method | Path | Success | Gate |
|---|---|---|---|
| GET | `/app/v1/manifest` | 200 | core |
| POST | `/app/v1/messages` | 202 | core |
| GET | `/app/v1/events` | 200 (SSE) | core |
| GET | `/app/v1/outbox` | 200 | core |
| GET | `/app/v1/health` | 200 | core |
| POST | `/app/v1/uploads` | 201 | `files` |
| GET | `/app/v1/files/<id>` | 200 | `files` |
| POST | `/app/v1/mcp` | 200 | `mcp-tools` \| `mcp-apps-ui` |

Eight schemas under `schemas/v1/`, each with at least one validated example, each
generating a committed TypeScript type that CI fails on drift against.

### What is frozen

The seven invariants in `contracts/app-ingress.md`: bearer auth on every route with
401 preceding 404; one monotonic id serving as both the SSE `id:` and the outbox
cursor; the extensible `ack`/`reply`/`notice` type set; `personId` as vestigial but
required; 202 + idempotent message acceptance; the single `error` shape on every
non-2xx; and tolerant readers everywhere.

### What is deliberately NOT specified

Recorded in the spec rather than guessed, and each settleable additively later: the
MCP protocol version, the `error.code` vocabulary, an error correlation id, the SSE
keep-alive cadence, the outbox page-size cap, and how a client learns the owner id.

### Conformance

`npx agent-app-conformance <url> --token <t>` runs 23 checks. Exit `0` conforming,
`1` non-conforming, `2` unreachable — frozen by `contracts/conformance-report.md`.

Skips are not failures: an agent declaring only `chat` and passing every core check
is conforming (ADR-0006). Declaring a capability, however, is **binding** — a
declared capability is never reported as `skip`.

### Notable during the build

- The reference implementation and the spec disagreed on the error shape while CI
  stayed green, because no check validated an error body. Both fixed; `error.shape`
  now guards it.
- `npm i github:...#tag` did not work at all for this monorepo — npm installs a git
  repo's root package, not its workspaces. The root is now the consumed package
  (ADR-0004 Amendment 1), gated by `npm run verify:consume`.
- `files.roundtrip` reported `skip` when its upload leg failed, hiding a real failure
  behind a status meaning "legitimately opted out". Caught by the loop, not review.

### Consuming

```bash
npm install github:seanerama/agent-app-contract#v1.0.0
```

```ts
import type { Manifest, EventEnvelope } from 'agent-app-contract/types';
```

The internal `@agent-app/*` workspace names are **not** consumable. Always pin a tag;
never depend on `#main`.

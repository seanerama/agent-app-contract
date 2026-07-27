# agent-app-contract

Frozen, additive-only app-ingress v1 contract — schemas, examples, and the conformance harness that certifies any agent as a first-class citizen of the mobile shell.

> Scaffolded by [Verity](https://github.com/seanerama/verity-framework) — prompt to production, proven.

## Using it

This repo is not published to npm and is never deployed. Consume it by **pinned git
tag** — always a tag, never `#main`, because a lockfile resolves a tag to a commit
SHA and a moved tag is a silent supply-chain change.

```bash
npm install github:seanerama/agent-app-contract#v1.0.0
```

```ts
// Types generated from the schemas — drift is a compile error, not a review comment.
import type { Health } from 'agent-app-contract/types';

// The raw schemas, if you validate at runtime.
import healthSchema from 'agent-app-contract/schemas/v1/health.json' with { type: 'json' };
```

Certify an agent against the contract — exit `0` conforming, `1` non-conforming,
`2` unreachable:

```bash
npx agent-app-conformance http://your-agent:8787 --token "$TOKEN" --person-id "$OWNER_ID"
```

Run the reference implementation to develop against:

```bash
npx mock-agent --port 8787 --token dev --capabilities files,mcp-tools,mcp-apps-ui
```

> Install pulls the **root** package and builds on your machine (Node >= 22 required).
> The internal `@agent-app/*` workspace names are not consumable — see
> [ADR-0004 Amendment 1](docs/adr/0004-distribute-by-pinned-git-tag-no-deployment-target.md).

## What the contract covers

Eight routes. Five are **core** — every conforming agent serves them. Three are
**gated** by a capability the agent declares in its manifest:

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

`contracts/app-ingress.md` is normative prose; `schemas/v1/*.json` is normative for
machines. **Where they disagree, the schema wins and the prose is a bug.**

## The compatibility promise

`v1` is frozen. Within `v1.x` this contract is **additive only** — if your agent
passes the harness at `v1.0.0`, it will not be failed by a later `v1.x` for something
it was never told about.

**Additive** (may appear in any `v1.x`): a new optional field · a new event `type` ·
a new route · a new enum member on an outbound shape · a new MCP tool · a new
conformance check id.

**Breaking** (requires `app-ingress v2` — a new contract, a new `$id` namespace,
never an edit to this one): adding a required field · removing or renaming a field ·
narrowing a type · removing an event type or route · changing a status code ·
changing the meaning of `id`, the cursor, or the auth rule.

Two mechanical consequences, both enforced in CI rather than by review attention:

- **No schema closes `additionalProperties`.** Unknown fields are ignored, never
  rejected — that is what makes an additive change safe for an older reader.
- **Every `$id` carries the frozen prefix, exactly.** An `$id` typo is unrecoverable
  after `v1.0.0`.

Every additive change ships as: a spec PR → new harness checks → mock-agent behaviour,
in that order, with a `CHANGELOG.md` entry. A conforming agent never regresses to
failing without a documented change it could read about first.

## Status

See [`STATUS.md`](STATUS.md) for live runtime state (deployed version, environments).

## Project identity

- **slug:** `agent-app-contract`
- **images:** `ghcr.io/seanerama/agent-app-contract`

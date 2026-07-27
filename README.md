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
npx agent-app-conformance http://your-agent:8787 --token "$TOKEN"
```

Run the reference implementation to develop against:

```bash
npx mock-agent --port 8787 --token dev
```

> Install pulls the **root** package and builds on your machine (Node >= 22 required).
> The internal `@agent-app/*` workspace names are not consumable — see
> [ADR-0004 Amendment 1](docs/adr/0004-distribute-by-pinned-git-tag-no-deployment-target.md).

## Status

See [`STATUS.md`](STATUS.md) for live runtime state (deployed version, environments).

## Project identity

- **slug:** `agent-app-contract`
- **images:** `ghcr.io/seanerama/agent-app-contract`

# 0006. Conformance is capability-gated, with a mandatory core

- **Status:** Accepted
- **Date:** 2026-07-27
- **Amends:** `contracts/app-ingress.md` (Exposes), `contracts/conformance-report.md`
  (skip semantics). Both are pre-`v1.0.0`, so this is a legitimate change under their
  own freeze boundary — not a break.

## Context

The Architect froze `app-ingress` from `plan.md` §2, which lists a flat v1 surface of
eight routes, and wrote: *"An agent that claims app-ingress v1 conformance exposes
exactly these routes."*

The Planner's verify-against-live-source step then obtained
`nightshift-client/idea.md` — the product-level source `plan.md` defers to — which was
not available when that sentence was written. It shows the manifest carrying a
capability list:

```json
"capabilities": ["chat", "files", "mcp-tools", "mcp-apps-ui"]
```

with the stated intent that *"the app adapts to capabilities rather than assuming
them"* (§3.1), and a feature stage for *"conformance-driven capability gating — an
agent without `mcp-apps-ui` simply shows no Apps tab"* (§6).

These cannot both be true. If every conforming agent must serve all eight routes, the
capability list is decoration and the app has nothing to adapt to. If capabilities are
real, "conforming" needs a definition that survives an agent choosing not to implement
file upload.

This matters beyond tidiness because the repo's stated purpose is multi-agent: *"any
agent implementing it is a first-class citizen"* (idea.md §1). A definition of
conformance that only `nightshift-assistant` can satisfy defeats that.

## Decision

Conformance is **a mandatory core plus capability-gated extensions.**

**Core — always required, never gated.** An agent that fails any of these is
non-conforming, full stop:

| Route | Why it is core |
|---|---|
| `GET /app/v1/manifest` | Capability negotiation itself depends on it |
| `POST /app/v1/messages` | The agent is a conversational agent or it is nothing |
| `GET /app/v1/events` | Replies must be able to arrive |
| `GET /app/v1/outbox` | Durability: "state can't lie" (idea.md §3) |
| `GET /app/v1/health` | The harness needs a liveness probe to test anything |

Bearer auth and fail-closed behavior are core on **every** route, including gated
ones that the agent chooses to implement.

**Gated extensions:**

| Capability | Gates | Required behavior when declared |
|---|---|---|
| `files` | `POST /app/v1/uploads`, `GET /app/v1/files/<id>` | Both routes, and the upload→fetch round-trip |
| `mcp-tools` | `POST /app/v1/mcp` | MCP initialize, `tools/list`, one successful `tools/call` |
| `mcp-apps-ui` | `POST /app/v1/mcp` | MCP initialize, `resources/list`, one `ui://` resource fetch |

`chat` is declared for descriptive symmetry but gates nothing — the chat triad is
core. An agent MUST declare `chat`.

**Harness behavior.** `agent-app-conformance` fetches the manifest first, then runs
the core groups plus the groups the manifest's `capabilities` entitle. Checks for
undeclared capabilities are reported with `result: "skip"` — the value already frozen
in `contracts/conformance-report.md`, which turns out to have been reserved for
exactly this.

Two rules keep gating from becoming an escape hatch:

1. **Declaring a capability is binding.** A declared capability whose checks fail is
   a `fail`, never a `skip`. Skipping is a consequence of *not claiming*, never of
   claiming and missing.
2. **Silence is not a skip.** If a capability is undeclared but the route answers
   anyway, that is a `fail` — the manifest is then lying about the agent, and a client
   adapting to capabilities would wrongly hide working functionality. A route that is
   not declared must return 404 (still behind auth).

**Manifest capability values are an open, additive vocabulary.** Unknown capability
strings are ignored by v1 clients and by the harness, so a future capability is an
additive change (ADR-0003).

## Alternatives considered

- **All eight routes always required** (the Architect's original freeze). Simplest
  harness — no manifest-dependent branching, no `skip` state, one bar for everyone.
  Rejected because it contradicts `idea.md` §3.1/§6 and makes the multi-agent promise
  unreachable: a third-party agent with no file storage could never be certified even
  though it would work perfectly in the app's Chat screen. It also leaves `skip` in
  the report contract with no meaning.
- **Capabilities gate everything, including chat.** Maximum flexibility. Rejected: an
  agent declaring `capabilities: []` would pass a conformance run trivially, and a
  green check that can be earned by implementing nothing is worse than no check. The
  word "conforming" has to denote something.
- **Separate conformance *levels*** (`core` / `standard` / `full`) instead of
  per-capability gating. Rejected as a worse fit for the same information: levels
  impose a total order on capabilities that does not exist — an agent with files but
  no MCP is not "less conforming" than one with MCP and no files.
- **Harness flags** (`--skip-files`) instead of reading the manifest. Rejected
  outright: it moves the declaration from the agent into the CI invocation, so the
  thing being certified no longer states its own surface, and a downstream repo could
  silence a real failure by editing a workflow file.

## Consequences

- The harness is now manifest-dependent: it must fetch and validate the manifest
  before it can decide what else to run. A malformed manifest therefore fails early
  and loudly, and the check ordering is no longer free — `manifest.*` runs first.
- `checks[].result: "skip"` becomes load-bearing output. A CI reader that treats
  skips as passes is fine; one that treats them as failures will misreport. The
  README must say which.
- The 404-when-undeclared rule adds a check per gated route and gives the mock-agent a
  new job: it must be runnable in a **reduced-capability mode** so the skip path is
  itself tested. Without that, the gating logic is the one part of the harness the
  self-proving loop never exercises. This is a real addition to the mock's scope and
  is written into the stage spec rather than left implicit.
- Adding a future capability is additive, but *moving a route from gated to core* is
  breaking and requires a new contract.
- `nightshift-assistant` declares all four capabilities, so in practice its
  conformance run is identical to the all-routes-required world. The gating exists for
  the second agent, and is cheaper to define now than to retrofit after v1 freezes.

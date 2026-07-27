# Assessment: initial backlog decomposition (Mode A)

- **Date:** 2026-07-27
- **Input:** `docs/walking-skeleton.md`, ADRs 0001–0005, `contracts/*`, `plan.md`
- **Outcome:** ACCEPT as stages 1–3; two ADR changes; two contract amendments;
  the rest of `plan.md` explicitly deferred to a second planning pass.

## Verification against live source (mandatory step)

The design docs were written from `plan.md` alone. Verification against the actual
repo and the two sibling repos — both public on GitHub — changed four things.

| Claim | Reality | Action |
|---|---|---|
| Repo has no workspace/schemas/packages | Confirmed absent (`git ls-files`) | none |
| ADR-0001: Node **24**, "matching the agent" | `nightshift-assistant`: `engines >=22`, CI `node-version: 22`, `@types/node@22.20.0`; dev workstation `v22.22.0` | **ADR-0001 Amendment 1 → Node 22** |
| ADR-0001 silent on linting | Assistant uses Biome 2.5.2 + `biome.json` | **Biome adopted** (same amendment) |
| Wire shapes unavailable; defer to Stage 0 | `nightshift-client/idea.md` §3 is public and specifies the whole surface | **Contract's deferred section replaced with sourced shapes** |
| "Conforming agent exposes exactly these routes" (all 8) | idea.md ships `capabilities[]` and plans capability-gated conformance | **ADR-0006 + contract amendment** |
| `POST /uploads` → 201 | No source specifies a code — the Architect invented it | Confirmed with the owner; **201 kept**, and the contract now says the invention is deliberate |

The Node pin is the clearest case for this step existing: ADR-0001 pinned 24 *and
wrote down the condition under which it would be wrong*. The condition held. Had the
step been skipped, the wrong pin would have shipped inside `v1.0.0`.

## Decisions taken (owner-confirmed)

### 1. Node 22, and Biome adopted — ADR-0001 Amendment 1

`plan.md` says "matching the agent," and the agent is on 22. Node 22 is Maintenance
LTS through **April 2027**, which covers v1.x; that date is now recorded in the ADR's
consequences as a scheduled bump rather than a future surprise.

`node:test` was **kept** despite the assistant using Vitest. ADR-0001's reasoning is
about packages other repos install from a git tag, and it holds regardless of what the
sibling repo does internally. Biome, by contrast, is a devDependency that never
reaches a consumer, and adopting it gives CI an honest lint job and keeps two
one-person repos in one style.

### 2. Capability-gated conformance — ADR-0006

The sharpest finding. The Architect's "all eight routes, always" and idea.md's
`capabilities[]` cannot both be true, and the difference decides the harness's
architecture.

Resolved as **mandatory core + gated extensions**: manifest/messages/events/outbox/
health always required; `files` gates uploads+files; `mcp-tools`/`mcp-apps-ui` gate
`/mcp`. Undeclared checks report `skip` — the value already frozen in
`conformance-report.md`, which turns out to have been reserved for exactly this.

Two rules stop gating from becoming an escape hatch: declaring a capability is
binding (declared-and-failing is a `fail`, never a `skip`), and answering an
undeclared route is itself a failure (404 required, still behind auth).

The real cost is a new obligation on the mock: it must run in **reduced-capability
mode**, or the gating logic becomes the one part of the harness the self-proving loop
never exercises. That is written into Stage 2 rather than left to discovery.

### 3. `POST /uploads` → 201 Created, deliberately

No source specified it. Since `nightshift-assistant` has not built the route yet, the
contract sets the standard instead of discovering it. The contract now states plainly
that no prior source specified a code — so a future reader knows this was chosen, not
transcribed.

## Backlog

| Stage | Type | Depends | Rationale |
|---|---|---|---|
| 1 — Workspace, toolchain, schema→types pipeline | chore | — | Skeleton half (a). One schema through the pipeline before six more ride on it. |
| 2 — Close the self-proving loop on one endpoint | feature | 1 | Skeleton half (b). Completes the skeleton; the repo's core invariant proven green *and* red. |
| 3 — Full v1 specification, schemas, examples | feature | 1 | `plan.md` Stage 0, resequenced to land after the gate that validates it. Parallelizable with 2. |

Stage 3 depends on **1, not 2** — writing schemas needs the validation pipeline, not
the HTTP loop. It can run concurrently with Stage 2 if the builder wants throughput,
though serial is fine for one developer.

## Deferred to a second planning pass — deliberately not specified now

`plan.md` Stage 1's remaining scope (mock-agent's full v1 surface, the full harness
check set) and Stage 2 (tag `v1.0.0`, README rewrite, compatibility promise) are
**not** written as stages yet.

This is the "thin initial backlog, not a giant upfront plan" rule applied honestly:
the right decomposition of the full surface — split by channel? by route? — depends on
what Stage 2 teaches about SSE timing and mock startup, which ADR-0005 already names
as the likely flake sources. Specifying it now would be guessing at the shape of work
whose main risk is not yet measured.

Nothing in `plan.md` is dropped. Everything lands, in `plan.md`'s own order, into a
pipeline proven first.

## Risk raised, owned elsewhere

`idea.md` §3 states the agent binds **loopback + tailnet only, no public exposure**,
while `plan.md` §3 Stage 2 promises a downstream agent adds the harness to its CI in
"three lines of workflow YAML." A GitHub-hosted runner cannot reach a tailnet-only
host — so `nightshift-assistant` will need either a self-hosted runner, a Tailscale
action, or to boot its own agent inside the CI job.

That is `nightshift-assistant`'s problem to solve, but it is **this repo's promise**,
and it gates the last unticked box in `plan.md` §5. It belongs in the README's CI
integration section (deferred Stage 2 work) as a documented choice rather than a
surprise discovered by the first consumer.

## Feature catalog

`helper-bot` — **declined** at the Architect stage (requires a chat/LLM loop and a web
UI surface; this repo has neither). Not revisited; no catalog stages injected.

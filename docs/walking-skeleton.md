# Walking skeleton — Stage 0

> Owner: Architect (this document). Decomposed into work items by `/verity:plan`.
> **Blocks every other stage.** No feature stage starts until this is green.

## The slice

The thinnest end-to-end path through *every link* of the self-proving loop
(ADR-0005), carrying the smallest possible amount of contract:

```
schemas/v1/health.json  ─validate─►  examples/health.json          ①
        │
        └─generate─►  packages/types  ─drift-check in CI─►         ②
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
     packages/mock-agent  ◄──real HTTP──  packages/conformance      ③
      GET /app/v1/health                  2 checks, exit 0
                            │
                            ▼
                   CI runs the loop, green                          ④
```

**One endpoint. Two checks. Every link exercised once.**

`GET /app/v1/health` is the right carrier: it is the only route whose response shape
is not blocked on `nightshift-client/idea.md` §3 (see the *Deferred to Stage 0*
section of `contracts/app-ingress.md`), and it still exercises the frozen bearer-auth
invariant. The skeleton can therefore land without guessing at a single field of the
real wire surface.

## Definition of done

Compiles, runs, passes a real test, green in CI. There is nothing to deploy
(ADR-0004), so the deploy leg of the usual skeleton is replaced by a **dry-run
release check**: `npm pack` on each package produces a tarball containing built JS
and `.d.ts`, proving the `prepare`-on-install path a git-tag consumer depends on.

- [ ] npm workspace exists; `package-lock.json` committed; `.nvmrc` pins the Node
      major from ADR-0001; `engines.node` set on every package.
- [ ] `schemas/v1/health.json` exists, is valid JSON Schema 2020-12, and carries the
      frozen `$id` prefix from ADR-0003.
- [ ] `examples/health.json` validates against it via a repo script (`npm run
      validate:examples`) — a script that **fails** when the example is broken, proven
      by breaking it once locally.
- [ ] `packages/types` generates from `schemas/v1/`, output committed, and
      `npm run gen && git diff --exit-code` fails on drift.
- [ ] `packages/mock-agent` serves `GET /app/v1/health` and **only** that route,
      with bearer auth: 200 with a valid token, 401 + the `error` shape without one.
      Starts via `npx mock-agent --port 8787 --token dev`.
- [ ] `packages/conformance` implements exactly two checks —
      `health.ok` and `health.auth.401` — plus `--json` output matching
      `contracts/conformance-report.md`, and the three frozen exit codes. Exit `2` is
      proven by pointing it at a closed port.
- [ ] CI runs, in order: install → typecheck → validate examples → types drift →
      unit tests → **boot mock-agent, poll `/app/v1/health` until ready, run the
      harness against it, require exit 0** → `npm pack` dry run.
- [ ] The loop job is proven able to fail: deliberately break the mock's auth check
      on a scratch branch, watch CI go red, revert. Record it in the PR.

That last box is the one that matters. A CI job nobody has ever seen fail is not a
gate — it is decoration.

## Deliberate deviation from `plan.md` stage order

`plan.md` §3 sequences **Stage 0 = the entire specification** (7 schemas, all
examples, full prose) and **Stage 1 = the entire self-proving loop** (types +
mock-agent implementing all 8 routes + harness implementing ~9 check groups + CI).

This skeleton inverts the first slice: **one schema all the way through the loop,
before six more schemas go in.**

Guide said: *wire the real test environment first — this kills the "9 stages done
before CI ever ran green" failure at the root.* Applied here, the concern with the
original order is that `plan.md` Stage 1 is a single PR containing three new
packages, a codegen pipeline, an HTTP server, an SSE client, an MCP client, and a new
CI topology — with the first end-to-end proof arriving at the very end of it. If the
loop turns out to be flaky (SSE timing and mock startup are the obvious candidates,
per ADR-0005), that discovery lands on top of a large, hard-to-bisect PR.

**What does not change:** the content and ordering of `plan.md` survive intact.
Nothing here is dropped or resequenced —

- `plan.md` Stage 0 (full spec: 7 schemas, examples, prose) becomes the next stage
  after the skeleton, landing into a *proven* validation pipeline.
- `plan.md` Stage 1 (full v1 surface in mock-agent, full harness) then lands as
  feature work into a *proven* loop, and can be split by route group if the Planner
  wants smaller PRs — an option the original order does not offer.
- `plan.md` Stage 2 (tag, README, compatibility promise) is unchanged.

The cost is one extra PR and a small amount of rework: `health.json`'s prose section
gets written twice, once thin and once in full. That is the whole price.

## Explicitly out of the skeleton

Not because they don't matter — because they are not needed to prove the spine, and
including them is how a walking skeleton becomes a first draft of the product:

`messages` · `events` (SSE) · `outbox` · `uploads` · `files` · `mcp` · `manifest` ·
dedup · cursor resume · the remaining six schemas · README rewrite · tagging.

## Handoff

`/verity:plan` decomposes this into work items. Suggested split, if it wants two PRs
rather than one: **(a)** workspace + schema + example + types + drift check;
**(b)** mock-agent + conformance + the loop job. Splitting further is not worth it —
(b) is not meaningful without both halves, since a harness with nothing to test and a
mock with nothing testing it are each half a proof.

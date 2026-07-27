# Stage 2: Close the self-proving loop on one endpoint

- **Type:** feature
- **Depends on:** 1
- **Part of:** the walking skeleton (`docs/walking-skeleton.md`), half (b).
  **Completes the skeleton — blocks every feature stage.**

## Objectives

Close the final and most important link of the self-proving loop (ADR-0005): CI boots
the reference agent and the harness certifies it over real HTTP.

Scope is deliberately one route and four checks. The value delivered is not coverage —
it is a **proven loop**, so that Stage 3's six schemas and the full v1 surface land
into a pipeline already known to work and known to be able to fail.

## What to build

**`packages/mock-agent`** — reference implementation, `npx mock-agent --port 8787
--token dev`.

- Serves `GET /app/v1/health` → `200 { ok, version, uptimeSec }`, validated against
  `schemas/v1/health.json` before it goes out.
- Bearer auth on every route: missing/malformed/wrong token → **401** + the `error`
  shape, evaluated **before** routing (`contracts/app-ingress.md` §1).
- Serves `GET /app/v1/manifest` → the manifest shape with
  `capabilities: ["chat"]`. Required because ADR-0006 makes the harness
  manifest-driven; it must have a manifest to read.
- Every other v1 route → **404** behind auth (undeclared capability, ADR-0006).
- `--capabilities <csv>` flag so the mock can run in reduced-capability mode. Without
  it, the skip path is the one part of the harness the loop never exercises
  (ADR-0006, *Consequences*).

**`packages/conformance`** — `agent-app-conformance <url> --token <t> [--json]`.

- Fetches the manifest **first**, derives the run from `capabilities`
  (`contracts/conformance-report.md`).
- Four checks: `manifest.ok`, `health.ok`, `health.auth.401`, and one gated check
  (e.g. `files.upload.roundtrip`) that must report **`skip`** when `files` is
  undeclared — proving the skip path end-to-end.
- Exit codes **0 / 1 / 2** exactly as frozen. `2` (unreachable) must be reachable:
  point it at a closed port.
- `--json` emits the frozen report shape on **stdout only**; diagnostics to stderr.
- Failure `detail` states expected vs. actually received. "Assertion failed" alone is
  a bug (ADR-0005).

**Independence rule (ADR-0002, ADR-0005 rule 1).** `mock-agent` and `conformance`
import each other **never**, and share no request/response helper. Both may depend on
`packages/types` and read `schemas/`. Add a comment in each package pointing at
ADR-0005 so the duplication is not "cleaned up" by a later PR.

**CI** — add to the progressive gate, after Stage 1's jobs:

- `loop` — build → start mock-agent → **poll `GET /app/v1/health` until ready**
  (never `sleep`; ADR-0005 *Consequences*) → run the harness → require exit 0 →
  run it again with `--capabilities chat` and assert the gated check reports `skip`.
- `pack` — `npm pack` each publishable package; assert the tarball contains built JS
  and `.d.ts`. This is the skeleton's deploy-leg substitute (ADR-0004): it proves the
  `prepare`-on-install path a git-tag consumer depends on.

## Interface contracts

- **Exposes:** the mock-agent CLI, the harness CLI, and the CI loop job — the
  execution surface every later stage extends by adding routes and checks.
- **Consumes:** `contracts/app-ingress.md` (auth, health, manifest, capability gating,
  404 rule); `contracts/conformance-report.md` (flags, exit codes, report shape, skip
  semantics); ADR-0002, ADR-0005, ADR-0006; Stage 1's schema/types pipeline.

**Neither frozen contract may be edited by this stage.** If implementation reveals a
contract defect, stop and return to the Planner — do not adjust the contract inside a
build PR.

## Testing requirements

- Unit tests for the auth middleware (401 before routing) and the exit-code mapping.
- The loop job **is** the integration test.
- **Prove the loop can fail** — the acceptance evidence: on a scratch branch, remove
  the mock's auth check so `health.auth.401` fails; confirm CI goes red with a useful
  `detail`; revert. Record it in the PR.
- Prove exit `2`: run the harness against a closed port in a unit test.

No UI-smoke asset: no user-facing surface, and nothing deploys (ADR-0004).

## Acceptance conditions

- [ ] Kill-switch: N/A and **recorded as such** — nothing is deployed or
      user-reachable (ADR-0004), so there is no runtime surface to dark-launch. The
      equivalent safety property is that the mock ships with `capabilities: ["chat"]`
      and 404s everything else, so no unbuilt route ever appears implemented.
- [ ] UI-smoke: N/A — no user-facing surface (ADR-0004)
- [ ] Additive only — no edits to `contracts/` or to Stage 1's `$id`s
- [ ] CI `loop` job green: mock booted via health-poll, harness exits 0
- [ ] Gated check reports `skip` under `--capabilities chat`, and the run still exits 0
- [ ] Exit codes 0, 1, and 2 each demonstrated
- [ ] Breaking the mock's auth turns the loop red with an informative `detail`
      (evidenced in the PR)
- [ ] `npm pack` tarballs contain built JS + `.d.ts`
- [ ] `mock-agent` and `conformance` share no import; comment in each cites ADR-0005
- [ ] Existing suite stays green; CI all-green

## Pipeline test: YES

This stage *is* the pipeline test. The loop job is the repo's core invariant, and this
is the PR where it must be demonstrated both green and red.

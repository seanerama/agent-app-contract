# 0005. Self-proving CI loop as the repo invariant

- **Status:** Accepted
- **Date:** 2026-07-27

## Context

A specification repo has a characteristic failure mode: the prose, the schemas, the
reference implementation, and the test suite drift apart, and nothing notices,
because each artifact is only ever checked against a human's reading of the others.
The first sign of trouble is a downstream integration that fails for reasons nobody
can localize.

ADR-0004 removes the usual safety net — there is no deployed instance, so there is no
runtime feedback. CI is the *only* mechanism that can catch a wrong spec before a
consumer does.

`plan.md` §3 Stage 1 item 5 already names the mechanism ("start mock-agent, run the
harness against it… the repo's core invariant"). This ADR states why it is
load-bearing and what must be true for it to keep working.

## Decision

CI closes a loop over all four artifacts on every push:

```
schemas/  ──validate──►  examples/            (spec job)
schemas/  ──generate──►  packages/types       (drift job: regenerate, fail on diff)
                              │
             ┌────────────────┴────────────────┐
             ▼                                 ▼
    packages/mock-agent  ◄──HTTP over the wire──  packages/conformance
             (produces v1)                    (asserts v1)
```

The final edge is the invariant: CI starts `mock-agent` on a port, runs
`agent-app-conformance` against it, and requires exit 0.

Three rules keep the loop honest, and the Reviewer enforces them:

1. **No shared implementation code between `mock-agent` and `conformance`.** They may
   both depend on `packages/types` and both read `schemas/`, and nothing else. If
   they shared a request builder or a response parser, a shared misreading of the
   spec would cancel out and CI would go green on a bug — the loop would prove only
   that the code agrees with itself.
2. **The harness asserts against the spec, not against the mock.** Any check that
   passes only because of an implementation detail of `mock-agent` (a specific echo
   string, a particular delay, seeded job ids) is a bug in the harness. The mock is
   the harness's first *subject*, never its oracle.
3. **The gate is progressive and never faked.** The scaffold's CI currently runs
   structure + secret-scan only, which is honestly green. Each job is added when the
   thing it checks exists: the `spec` job lands with Stage 0, the typecheck/drift and
   loop jobs land with Stage 1. No job is ever added in a form that cannot fail.

A red loop means the schema, the reference implementation, and the harness disagree.
That is always a real defect in one of the three, and is never resolved by relaxing
the harness.

## Alternatives considered

The **stack-and-topology guide** requires a walking skeleton that is green in CI
before feature work; this decision is what makes the skeleton meaningful for a repo
with no UI and no deploy. The **contracts-first guide** requires the Reviewer to
verify every PR against the frozen contracts; the loop mechanizes most of that check.

- **Unit-test the mock-agent and the harness separately.** Cheaper and more
  conventional. Rejected as *sufficient*: unit tests assert each component against
  its author's reading of the spec, which is precisely the thing that drifts. Unit
  tests remain welcome, but they are not the gate.
- **Contract tests generated from the schemas** (property-based fuzzing of every
  shape). Strictly stronger for shape validation, and worth adding later. Rejected as
  the v1 gate because the interesting parts of this contract are *sequences* —
  `ack`-then-`reply`, `Last-Event-ID` resume, outbox cursor catch-up, upload/fetch
  round-trip — which shape fuzzing does not exercise at all.
- **Prove the contract against `nightshift-assistant` instead of a mock.** This is
  the real proof, and `plan.md` §5 correctly refuses to call the contract done
  without it. Rejected as the *gate* because it makes this repo's CI depend on
  another repo's runtime and credentials, so a red build would routinely mean
  "the other repo is broken." The mock keeps the gate fast, hermetic, and
  self-contained; the real agent is the acceptance test one layer out.
- **Two independent implementations of the agent** (e.g. a second mock in another
  language) to catch Node-specific readings of the spec. Genuinely valuable, and out
  of proportion to a v1 with one known agent. Noted as a future option.

## Consequences

- Some duplication between `mock-agent` and `conformance` is mandatory, and will look
  like an obvious refactor to anyone reading the code cold. This ADR is the answer to
  that PR comment; a comment in both packages should point here.
- The loop needs the mock's port and token to be deterministic in CI, and needs
  reliable startup detection. Polling `GET /app/v1/health` until ready — rather than
  sleeping — is the only acceptable form, or the loop becomes the flakiest job in the
  repo and pressure to disable it starts immediately.
- SSE and timing-dependent checks (`ack` then `reply` after a delay) are the likely
  source of flakes. Timeouts must be generous and failures must report *what* was
  received, not just that a wait expired.
- Because the harness is also a *published product* consumed by downstream CI, a
  change to it is a change to other repos' build outcomes. That is why the
  compatibility promise in `plan.md` §3 Stage 2 exists: within v1.x, the harness only
  adds checks for additive spec changes, each documented in `CHANGELOG.md`.

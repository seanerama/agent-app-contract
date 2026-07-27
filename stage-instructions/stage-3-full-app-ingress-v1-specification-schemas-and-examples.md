# Stage 3: Full app-ingress v1 specification, schemas, and examples

- **Type:** feature
- **Depends on:** 1 (needs the schema pipeline; does **not** need the loop, so it may
  run in parallel with Stage 2)

## Objectives

Write the complete `app-ingress` v1 surface as normative prose plus machine-readable
schemas — the seven remaining wire shapes — so that implementation stages have
something exact to build against and the harness has something exact to assert.

This is `plan.md` Stage 0, resequenced to land *after* the pipeline that validates it
(`docs/walking-skeleton.md`, *Deliberate deviation*).

## What to build

**`contracts/app-ingress.md`** — expand the frozen skeleton into the full spec.
The *Invariants* section is frozen and must survive **verbatim in meaning**; this
stage fills in per-route detail beneath it and replaces the *Field-level shapes*
section with the finished specification.

**`schemas/v1/`** — the seven shapes named in `plan.md` §3, alongside Stage 1's
`health.json`:

| Shape | Source |
|---|---|
| `manifest` | idea.md §3.1 + `ui.home` (plan.md §2 decision 2) + `capabilities` (ADR-0006) |
| `inbound-message` | idea.md §3.2 — `schema`, `messageId`, `personId`, `text`, `attachments`, `receivedAt` |
| `assistant-reply` | **read off `nightshift-assistant`'s existing implementation** — idea.md names the shape but does not enumerate it |
| `event-envelope` | plan.md §2 decision 1 — `{schema, id, type, at, payload}` |
| `outbox-page` | `after` cursor frozen; envelope fields still open |
| `upload-response` | idea.md §3.3 — `201 { ok, uploadId, path }` |
| `error` | **not yet sourced** — see *Open items* |

Every schema: 2020-12, `$id` under the frozen prefix + `/v1/`,
`additionalProperties` left open, cross-refs by absolute `$id`.

**`examples/`** — one valid payload per schema, validated by Stage 1's `spec` job.

**Open items — settle or record, never guess.** `contracts/app-ingress.md` requires
that anything unresolved is written into the spec as *explicitly unspecified*:

1. `assistant-reply` field list — source from `nightshift-assistant` (it has a
   `files` array; enumerate the rest from the code).
2. `error` body — code vocabulary, message, correlation id. Check the sibling repo's
   existing contracts (`contracts/control-api.md`) before inventing one; reuse beats
   novelty here.
3. `outbox-page` envelope beyond the `after` cursor.
4. Exact MCP protocol version required of a conforming agent.

If any cannot be resolved from a real source, mark it unspecified in the spec and
raise it to the Planner rather than settling it inside a build PR.

## Interface contracts

- **Exposes:** the complete normative v1 surface. Every later stage — mock-agent's
  full implementation, the full harness, and both downstream repos — reads this.
- **Consumes:** `contracts/app-ingress.md` (frozen invariants);
  `nightshift-client/idea.md` §3 (the product source); ADR-0003, ADR-0006;
  Stage 1's `spec` job and `$id` convention.

**Contract-safety.** This stage *writes* the frozen contract's deferred detail, which
its own freeze boundary explicitly permits **before `v1.0.0`**. It must not alter any
*Invariants* clause. Changing auth, the single-cursor rule, `personId`, the 202/dedup
rule, channel separation, or the core/gated split is out of scope and requires a new
ADR + Planner decision.

## Testing requirements

- Every example validates against its schema in the `spec` job (Stage 1's gate — this
  stage adds seven times the material to an already-proven gate).
- `types-drift` stays green with the regenerated types committed.
- Add a test asserting each schema's `$id` matches the frozen prefix exactly — a typo
  in an `$id` is unrecoverable after `v1.0.0` and must not depend on review attention.
- Add a test asserting no schema sets `additionalProperties: false`.

## Acceptance conditions

- [ ] Kill-switch: N/A — specification only, no runtime surface
- [ ] UI-smoke: N/A — no user-facing surface
- [ ] Additive only: no *Invariants* clause altered; no Stage 1 `$id` changed
- [ ] All 8 schemas present, valid 2020-12, correct `$id`s (test-enforced)
- [ ] One validated example per schema
- [ ] Spec prose and schemas agree; where prose is ambiguous, the schema is normative
- [ ] Every open item either resolved **from a named real source** or recorded in the
      spec as explicitly unspecified — none silently invented
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO

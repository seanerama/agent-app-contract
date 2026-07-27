# Stage 1: Workspace, toolchain, and the schema-to-types pipeline

- **Type:** chore
- **Depends on:** none
- **Part of:** the walking skeleton (`docs/walking-skeleton.md`), half (a).
  **Blocks everything.**

## Objectives

Stand up the repo's spine — workspace, toolchain, and the `schemas/ → types/` leg of
the self-proving loop (ADR-0005) — carrying exactly **one** schema so the pipeline is
proven before six more shapes ride on it.

This stage deliberately ships no HTTP and no harness. It ends when a schema change
mechanically forces a types change, and CI notices when it doesn't.

## What to build

**Workspace root**

- `package.json` — private, `"type": "module"`, npm workspaces over `packages/*`,
  `engines.node: ">=22"`.
- `package-lock.json` — **committed** (ADR-0001).
- `.nvmrc` → `22` (ADR-0001 Amendment 1 — matches `nightshift-assistant`'s
  `engines >=22` / CI `node-version: 22`, and the dev workstation).
- `tsconfig.json` — `strict: true`, ESM output, no bundler. A `tsconfig.build.json`
  split is fine if it matches the sibling repo's pattern.
- `biome.json` — align with `nightshift-assistant`'s config rather than inventing one.
- Root scripts: `typecheck`, `lint`, `test`, `gen`, `validate:examples`.

**The one schema**

- `schemas/v1/health.json` — JSON Schema 2020-12 for `200 { ok, version, uptimeSec }`
  (`nightshift-client/idea.md` §3.5).
  - `$id`: `https://seanerama.github.io/agent-app-contract/schemas/v1/health.json`
    — the frozen prefix (ADR-0003). Exact, including the `/v1/` segment.
  - `additionalProperties` **unset** (open). Tolerant readers are the mechanical form
    of additive-only; do not "tighten" this.
- `examples/health.json` — one valid payload.

**Validation + codegen**

- `npm run validate:examples` — validates every file in `examples/` against its
  schema using **ajv** in 2020-12 mode.
- `packages/types` — `npm run gen` generates from `schemas/v1/` via
  `json-schema-to-typescript`; **output committed**; package builds to JS + `.d.ts`
  with a `prepare` script (git-tag consumers depend on `prepare` — ADR-0004).

**CI** (`.github/workflows/ci.yml`) — add jobs to the existing progressive gate.
Keep `structure` and `secret-scan`; do not weaken them.

- `lint` — `biome check .`
- `typecheck` — `tsc --noEmit`
- `spec` — `npm run validate:examples`
- `types-drift` — `npm run gen && git diff --exit-code`

## Interface contracts

- **Exposes:** the workspace layout, the `schemas/v1/` + `examples/` convention, the
  frozen `$id` prefix in real use, and `packages/types` as the generated-types home.
  Stages 2 and 3 build directly on all four.
- **Consumes:** `contracts/app-ingress.md` (health shape, §*Field-level shapes*);
  ADR-0001 (toolchain), ADR-0003 (dialect, `$id`, open objects), ADR-0004 (`prepare`).

**No frozen contract is modified by this stage.** A PR here that edits
`contracts/` is out of scope and should be rejected by review.

## Testing requirements

- At least one real unit test so `npm test` is not vacuous.
- **Prove each new gate can fail** — this is the acceptance evidence, not a formality:
  1. Break `examples/health.json`; confirm `spec` goes red; revert.
  2. Hand-edit generated types; confirm `types-drift` goes red; revert.
  Record both in the PR description.

No UI-smoke asset: nothing user-facing, and nothing deploys (ADR-0004).

## Acceptance conditions

- [ ] `npm ci && npm run lint && npm run typecheck && npm test && npm run validate:examples`
      passes from a clean clone on Node 22
- [ ] `npm run gen` is a no-op on a clean tree (drift check green)
- [ ] `schemas/v1/health.json` carries the exact frozen `$id` prefix
- [ ] `examples/health.json` validates; breaking it turns CI red (evidenced in the PR)
- [ ] Hand-editing generated types turns CI red (evidenced in the PR)
- [ ] `package-lock.json` and generated types are committed
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO

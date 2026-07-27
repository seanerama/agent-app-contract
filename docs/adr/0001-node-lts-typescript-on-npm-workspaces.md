# 0001. Node LTS + TypeScript on npm workspaces

- **Status:** Accepted (amended 2026-07-27, same day — see *Amendment 1*)
- **Date:** 2026-07-27

## Context

This repo owns the `app-ingress` v1 seam and ships three artifacts that must run on
someone else's machine: generated types (`packages/types`), a reference agent
(`packages/mock-agent`), and a conformance CLI (`packages/conformance`). The CLI is
executed in *other repos' CI* — first `nightshift-assistant`. The types are vendored
by `nightshift-client` (Expo/React Native, therefore a TypeScript consumer).

The runtime is forced more than chosen: the harness must be trivially invocable from
a GitHub Actions step in a repo whose own stack we do not control, and the types must
be consumable by a TypeScript app. `plan.md` §3 Stage 1 states "Node LTS +
TypeScript, matching the agent."

## Decision

- **Runtime:** Node.js 22, pinned in `.nvmrc` and in every `package.json`
  `engines.node` field as `>=22`. CI runs the same major. *(Amended — see below.)*
- **Language:** TypeScript, `strict: true`, compiled with `tsc` to ESM. No bundler.
- **Workspace:** npm workspaces (`packages/*`) with a committed `package-lock.json`.
  No pnpm/yarn/turbo.
- **Test runner:** the built-in `node:test` + `node:assert`, run via `node --test`.
- **Linter/formatter:** Biome. *(Amended — see below.)*
- **Module format:** ESM throughout (`"type": "module"`).

## Amendment 1 — 2026-07-27 (Planner)

The original text pinned **Node 24** (then Active LTS) and flagged an open item: *"If
`nightshift-assistant` pins Node 22, change this to 22 before Stage 1 lands."*

The Planner's mandatory verify-against-live-source step resolved it. Evidence from
`seanerama/nightshift-assistant@HEAD`:

- `package.json` → `"engines": { "node": ">=22" }`, `"@types/node": "22.20.0"`
- `.github/workflows/ci.yml` → `node-version: 22`
- the developer's own workstation runs `v22.22.0`

`plan.md` §3 says "Node LTS + TypeScript, **matching the agent**." Node 22 is
Maintenance LTS through April 2027, which comfortably covers v1.x. **Pin changed to
22.** Nothing else in this ADR is affected.

Second amendment, same review: **Biome is adopted** as linter/formatter, matching
`nightshift-assistant` (`@biomejs/biome` 2.5.2, `biome.json`). The original ADR was
silent on linting, which would have left CI without an honest lint job and let style
drift between two repos maintained by one person. Biome is a devDependency only and
never reaches a consumer's runtime, so it does not weaken the low-surface argument
below.

`node:test` was **kept** despite the assistant using Vitest: the reasoning below is
about packages other repos install from a git tag, and it stands independently of
what the sibling repo does for its own internal tests.

## Alternatives considered

The **stack-and-topology guide** recommends "boring, well-supported stacks" and
"pin dependencies and commit the lockfile from day one." Both are followed as-is;
its server-rendered-over-SPA lean does not apply (there is no UI in this repo).

- **pnpm instead of npm workspaces.** Faster, stricter hoisting. Rejected: this repo
  is consumed as a *git dependency*, and `npm install github:owner/repo#tag` runs the
  package's `prepare` script under npm regardless of what we prefer locally. Keeping
  the authoring toolchain identical to the installing toolchain removes an entire
  class of "works here, not on install" bugs. Three small packages do not need pnpm's
  speed.
- **Vitest instead of `node:test`.** Better watch mode and assertions. Rejected: it
  adds a dependency tree to a package whose whole purpose is to be a trustworthy,
  low-surface thing other repos install. `node:test` is zero-dependency and ships
  with the pinned runtime.
- **Node type-stripping (run `.ts` directly, no build).** Tempting for the mock-agent.
  Rejected for published packages because consumers install from a git tag and must
  get JS + `.d.ts`; kept available for local dev scripts only.
- **Deno / Bun.** Rejected: the harness must run as a one-line step in a downstream
  repo's existing Node-based CI. Requiring a second runtime installation is a tax on
  every consumer to save nothing here.

## Consequences

- Because packages are installed from a git tag rather than a registry, each
  published package needs a `prepare` script that builds. npm *does* install
  devDependencies for git dependencies specifically so `prepare` can run — so the
  build works on install, at the cost of a slower `npm install` downstream and a hard
  requirement that `prepare` never depend on anything outside the repo.
- `node:test` gives us no snapshot testing and weaker failure diffs. Acceptable: the
  real assertions in this repo are schema validation (ajv, see ADR-0003) and the
  conformance harness itself, not unit-test ergonomics.
- Pinning a Node major means a yearly bump PR. That bump is a *behavioral* change for
  consumers running the harness, so it belongs in `CHANGELOG.md` even though it is
  not a spec change. Node 22 leaves Maintenance LTS in **April 2027** — that is the
  deadline for the bump, and it must be scheduled rather than discovered.
- ESM-only will bite any downstream consumer still on CJS. `nightshift-client` (Expo)
  and a modern Node agent are both fine; this is recorded so the failure is
  recognized instantly if a third consumer appears.

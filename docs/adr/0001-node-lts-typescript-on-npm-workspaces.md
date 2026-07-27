# 0001. Node LTS + TypeScript on npm workspaces

- **Status:** Accepted
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

- **Runtime:** Node.js 24 (Active LTS as of this date), pinned in `.nvmrc` and in
  every `package.json` `engines.node` field as `>=24`. CI runs the same major.
- **Language:** TypeScript, `strict: true`, compiled with `tsc` to ESM. No bundler.
- **Workspace:** npm workspaces (`packages/*`) with a committed `package-lock.json`.
  No pnpm/yarn/turbo.
- **Test runner:** the built-in `node:test` + `node:assert`, run via `node --test`.
- **Module format:** ESM throughout (`"type": "module"`).

> **Open item for the Planner:** Node 24 is the current Active LTS, but `plan.md`
> says "matching the agent." If `nightshift-assistant` pins Node 22, change this to
> 22 *before* Stage 1 lands — after that the pin is in a published tag. This is a
> one-line change now and a coordinated one later.

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
  not a spec change.
- ESM-only will bite any downstream consumer still on CJS. `nightshift-client` (Expo)
  and a modern Node agent are both fine; this is recorded so the failure is
  recognized instantly if a third consumer appears.

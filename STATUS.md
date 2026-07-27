# agent-app-contract — Status & Handoff

> Runtime/ops truth (framework-spec §4.6). Owned by the **Release/Deploy Operator**,
> updated on every deploy. Records secret **locations** only — never values.

**As of:** never deployed — by design

## TL;DR

This repo has **no deployment target** (ADR-0004). It ships as an immutable git tag
consumed via `github:seanerama/agent-app-contract#v1.x.y`. "Released" means "tag
pushed"; there is no `deploy.sh`, no environment, and no runtime to be on call for.

## Live deployment

- (none, permanently — see `docs/adr/0004-distribute-by-pinned-git-tag-no-deployment-target.md`)

## Images

- prefix: `ghcr.io/seanerama/agent-app-contract` — **reserved but unused.** Nothing
  here is containerized. Do not treat the empty registry as a missing release.
- (no releases yet)

## Secrets

- (none configured) — when set, list NAMES + on-disk LOCATIONS only, never values.

## Coordination notes

- Downstream consumers pin a **tag**, never `#main`. Tags are immutable: a bad
  `v1.0.0` is fixed by `v1.0.1`, never by moving the tag.
- The last box in `plan.md` §5 is ticked by *another repo* — it stays open until
  `nightshift-assistant`'s CI runs the harness green against its real transport.

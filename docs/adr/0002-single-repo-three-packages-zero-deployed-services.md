# 0002. Single repo, three packages, zero deployed services

- **Status:** Accepted
- **Date:** 2026-07-27

## Context

The system this repo serves spans three repos: `agent-app-contract` (this one, the
seam), `nightshift-client` (the app shell), and `nightshift-assistant` (the first
agent). The question here is only the topology *inside* this repo.

`plan.md` §1 names six artifacts: the spec, schemas, examples, generated types, a
reference agent, and a conformance harness. Two of those artifacts are *programs*
(`mock-agent` is an HTTP server; `conformance` is a CLI), which raises the obvious
question of whether either should become a deployed service.

## Decision

One repository, one npm workspace, three published packages and three data
directories:

```
contracts/            app-ingress.md — the normative prose
schemas/              JSON Schema 2020-12, one file per wire shape
examples/             one valid payload per schema
packages/types        generated from schemas; committed; drift-checked
packages/mock-agent   reference implementation of the full v1 surface
packages/conformance  the certifying CLI
```

**Zero deployed services.** `mock-agent` is a program that consumers *run locally*
and that CI *starts in-process*; it is not hosted anywhere. Consequently the
`ghcr.io/seanerama/agent-app-contract` image prefix from the project identity stays
unused, and the per-service slug extension (`<image_prefix>-<service>`) is never
exercised.

Dependency direction is strictly one-way and enforced by review:

```
schemas/  →  packages/types  →  packages/mock-agent
                            →  packages/conformance
```

`mock-agent` and `conformance` never import each other. That independence is the
whole point: if the harness and the reference implementation shared code, a shared
misreading of the spec would cancel out and CI would go green on a bug (see ADR-0005).

## Alternatives considered

The **stack-and-topology guide** says start as a modular monolith and split a service
out only for independent scaling, a team boundary, or a different runtime. None of
those apply, so we do not split. The guide's warning that "every service you add
multiplies the CI build matrix, the image set, and the deploy surface" is the direct
reason the mock-agent stays un-hosted.

- **Split the harness into its own repo.** Argument: consumers install only the CLI
  and shouldn't pull the mock agent. Rejected: the harness's correctness is defined
  *relative to the schemas*, and separating them guarantees version skew between a
  spec tag and a harness tag — exactly the failure this repo exists to prevent.
- **Publish to npm instead of workspace + git tags.** Deferred, not rejected. See
  ADR-0004; the packaging boundaries chosen here make that a later, non-breaking move.
- **Host mock-agent as a shared dev endpoint** (NSAF dev server over Tailscale, or a
  Cloudflare Worker). Considered and declined by the project owner. The Cloudflare
  variant would have forced the reference implementation onto the Workers runtime,
  making the *reference* diverge from the Node runtime real agents use — the reference
  would then stop being a reference. The Tailscale variant adds an uptime obligation
  to a specification repo for the sole benefit of not typing `npx mock-agent`.
- **Single flat package.** Rejected: `nightshift-client` needs `types` without
  pulling in an HTTP server, and `nightshift-assistant`'s CI needs `conformance`
  without pulling in either.

## Consequences

- Nothing in this repo has a runtime, an environment, secrets, or an on-call surface.
  `STATUS.md` will correctly read "not deployed" indefinitely, and `/verity:ship` cuts
  tags and `CHANGELOG.md` entries rather than running a `deploy.sh`.
- The one-way dependency rule is a review-time invariant with no build-time
  enforcement out of the box. The Reviewer must check it on every PR touching
  `packages/`; a `depcruise`-style check can be added later if it is ever violated.
- Three packages in one workspace means one version number moves them all. That is
  intentional — the spec tag *is* the version of everything — but it means a
  typo-fix in the harness ships a new version of `types` too.
- If a fourth consumer ever needs a hosted mock, this ADR is superseded rather than
  amended, and the deploy surface arrives all at once (image, CI matrix, access file).

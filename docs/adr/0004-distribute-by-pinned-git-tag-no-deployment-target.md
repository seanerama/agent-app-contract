# 0004. Distribute by pinned git tag; no deployment target

- **Status:** Accepted
- **Date:** 2026-07-27

## Context

The Architect role requires choosing a deployment target from the operator's global
catalog, and requires never assuming one. The available configured methods are
Cloudflare Pages, the NSAF dev server over SSH/Tailscale, Coolify, and an AWS EC2
web server.

`plan.md` §4 places deployment out of scope for this repo and notes the `ghcr.io`
image identity is unused. That is a claim to test rather than accept, because two
artifacts here *are* runnable programs (see ADR-0002). It was tested: the owner was
offered a hosted mock-agent on the NSAF dev server and on Cloudflare, and declined
both.

`plan.md` §1 also fixes the consumption mechanism —
`github:seanerama/agent-app-contract#v1.x.y`, no npm publishing.

## Decision

**No deployment target. This repo deploys nothing, to nowhere.**

Distribution is by immutable git tag:

```jsonc
// downstream package.json
"dependencies": {
  "@agent-app/types": "github:seanerama/agent-app-contract#v1.0.0"
},
"devDependencies": {
  "@agent-app/conformance": "github:seanerama/agent-app-contract#v1.0.0"
}
```

Consequences for the Verity roles:

- **`/verity:ship`** cuts a tag and a `CHANGELOG.md` entry. It does **not** generate
  or run a `deploy.sh`. "Released" means "tag pushed and immutable."
- **`STATUS.md`** stays at "not deployed" permanently. Its Images section records
  that `ghcr.io/seanerama/agent-app-contract` is reserved and unused.
- **`.verity/deploy-access.md` is not created.** There is no host to reach, so there
  are no credential locations to record. Anyone can consume this repo with nothing
  but read access to GitHub.
- **`/verity:sre`** has no steady-state runtime to own here. Its concerns reduce to
  tag hygiene and the CI gate.

Tags are immutable: a published tag is never moved or deleted. A mistake in `v1.0.0`
is fixed by `v1.0.1`, because downstream lockfiles resolve a git tag to a commit SHA
and a moved tag is a silent supply-chain change.

## Alternatives considered

- **Publish to the npm registry** (`@seanerama/agent-app-contract-*`). Better install
  ergonomics, real semver ranges, no `prepare`-on-install build. Rejected for now:
  it adds an npm org, a publish token in CI, and a provenance surface to a project
  with two known consumers, both under the same owner. Deliberately left as a
  non-breaking future move — the package boundaries in ADR-0002 are already
  registry-shaped. Revisit when a consumer outside this owner appears.
- **Host mock-agent on the NSAF dev server (Tailscale).** Would let
  `nightshift-client` develop against a shared always-on agent. Declined by the
  owner. It converts a specification repo into an operated service, and the benefit
  over `npx mock-agent` is small for a single-developer project.
- **Host mock-agent on Cloudflare Workers.** Cheapest always-on option, and the
  Cloudflare MCP tooling is already available in this environment. Rejected on
  principle: *availability of tooling is not a reason to deploy.* It would also force
  the reference implementation onto the Workers runtime, so the "reference" would stop
  matching the Node runtime that real agents use.
- **Publish schemas to GitHub Pages so `$id`s resolve.** Not chosen now, but
  explicitly preserved as an option by the `$id` prefix in ADR-0003. If it ever
  happens it is a docs-publishing step, not an application deploy, and does not
  reopen this ADR.
- **Vendoring (downstream copies the schemas in).** Rejected: it is exactly the
  version-skew failure this repo exists to eliminate.

## Consequences

- Consumers must pin a tag. A downstream `#main` dependency would silently drift and
  must be rejected in review of the README and of any consumer repo we control.
- Git-dependency installs run `prepare` and therefore build on the consumer's
  machine, which is slower and requires the consumer's Node to satisfy our `engines`
  (ADR-0001). If that friction becomes real, it is the trigger to revisit npm
  publishing — not a reason to commit `dist/`.
- No deploy means no staging environment, so `/verity:verify`'s "test on the LIVE
  app" reduces to "run the harness against a real agent." The first real proof is
  `nightshift-assistant`'s CI going green, which is why `plan.md` §5 refuses to tick
  its last box until that happens.
- The one genuine risk of this ADR is that a spec repo with no deploy surface also
  has no runtime feedback loop. CI (ADR-0005) is the only thing standing between a
  wrong spec and a downstream outage, which raises the bar on that gate considerably.

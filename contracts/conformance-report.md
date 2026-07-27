# Contract: conformance-report

- **Status:** frozen v1 (frozen at tag `v1.0.0`)
- **Owner:** `packages/conformance`. Consumed by every downstream repo's CI —
  first `nightshift-assistant`.

> This is the *second* seam this repo owns, and it is easy to overlook. The
> `app-ingress` contract binds agents to a wire shape; **this** contract binds
> `agent-app-contract` to the CI systems that run the harness. A careless change to
> the CLI's flags, exit codes, or JSON output turns another repo's build red for
> reasons that have nothing to do with that repo. It is therefore frozen on the same
> terms as the wire contract.

## Exposes

### CLI invocation

```
agent-app-conformance <url> --token <token> [--json]
```

- `<url>` — base URL of the agent under test. The harness appends `/app/v1/…`.
- `--token <token>` — bearer token presented on authenticated checks.
- `--json` — emit the machine-readable report on stdout instead of human output.

Positional `<url>` first, token as a required flag. Additional flags may be added
(additively, with defaults that preserve current behavior); these three never change
meaning.

### Exit codes

| Code | Meaning | CI reading |
|---|---|---|
| `0` | Conforming — every check passed | green |
| `1` | Non-conforming — the agent was reached, one or more checks failed | red, the agent's fault |
| `2` | Unreachable — could not test (connection refused, DNS, TLS, timeout on every attempt) | red, but an infrastructure fault |

The `1` / `2` split exists so a downstream repo can distinguish "my agent violates
the contract" from "my agent wasn't up yet." Collapsing them would destroy the only
signal CI has for that difference. Any future code is `>= 3`; `0`, `1`, and `2` are
frozen.

### Report shape (`--json`)

Emitted on stdout, a single JSON object, nothing else on stdout:

```json
{
  "schema": 1,
  "contract": "app-ingress",
  "contractVersion": "1.0.0",
  "harnessVersion": "1.0.0",
  "target": "https://agent.example/",
  "result": "pass",
  "counts": { "passed": 23, "failed": 0, "skipped": 0 },
  "checks": [
    {
      "id": "messages.dedup",
      "title": "Repeated message UUID is deduplicated",
      "result": "pass",
      "detail": null
    }
  ]
}
```

Frozen guarantees:

- `schema` is the integer `1`.
- `result` is `"pass"` | `"fail"` | `"unreachable"`, consistent with the exit code.
- `checks[].id` is a **stable, dotted, machine-readable identifier**. A check id is
  never renamed or reused for a different assertion — downstream CI may allowlist or
  annotate by id.
- `checks[].result` is `"pass"` | `"fail"` | `"skip"`.
- `checks[].detail` carries the human explanation on failure, including what was
  expected and what was actually received. A failure detail that says only "assertion
  failed" is a bug in the harness (ADR-0005).
- Diagnostics, progress, and warnings go to **stderr**. Under `--json`, stdout is
  parseable JSON or nothing.

## Consumes

- A running agent reachable at `<url>` implementing `app-ingress` (see
  `contracts/app-ingress.md`).
- A bearer token valid for that agent.
- Node satisfying this repo's `engines` (ADR-0001), on the machine running CI.

Nothing else. The harness reads no config file, requires no environment variables,
writes nothing to disk, and needs no network access other than to `<url>` — so that
adding it to a downstream pipeline is genuinely the three lines of YAML promised in
`plan.md` §3 Stage 2.

## Schema / wire

The report is described by `schemas/v1/conformance-report.json`, carrying an `$id`
under the same frozen prefix as the wire schemas (ADR-0003). It is a schema *about
this repo's tooling*, not part of the agent wire surface, and is namespaced
accordingly.

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.

**Additive:** a new optional flag with a behavior-preserving default; a new field in
the report; a new check id; a new exit code `>= 3`.

**Breaking (new contract):** changing what `0`/`1`/`2` mean; renaming or repurposing
a check id; removing a report field; changing `--json` output to be non-JSON or
multi-document; moving diagnostics from stderr to stdout.

### The compatibility promise

This is the promise `plan.md` §3 Stage 2 makes to downstream repos, stated
normatively:

> Within `v1.x`, the harness only **adds** checks, and only for **additive** spec
> changes that are documented in `CHANGELOG.md`. An agent that passes at `v1.n` never
> starts failing at `v1.n+1` without a spec addition it could have read about first.

A new check that fails an agent which was previously green — with no corresponding
documented spec addition — is a **regression in this repo**, not a finding about the
agent. It is reverted, not defended.

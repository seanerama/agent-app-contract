# Contract: app-ingress

- **Status:** frozen v1 (see *Freeze boundary* below)
- **Owner:** this repo (`agent-app-contract`). Implemented by every agent;
  consumed by every app shell.

> This document is normative prose. `schemas/v1/*.json` is normative for machines.
> Where they disagree, the schemas win and the prose is a bug.

## Freeze boundary

Everything under **Invariants** is frozen *now*, by the Architect, and may not be
reopened during the build. Everything under **Deferred to Stage 0** is field-level
detail that must be settled from `nightshift-client/idea.md` §3 while writing
`schemas/v1/`, and is frozen at tag **`v1.0.0`**.

After `v1.0.0`, this contract is **additive only**. A breaking change is a NEW
contract (`app-ingress v2`, a new `$id` namespace, a new directory) — never an edit
to this one.

## Exposes

All paths are relative to an agent-chosen base URL. Routes are either **core**
(every conforming agent serves them) or **gated** by a capability the agent declares
in its manifest — see *Capabilities* below and ADR-0006.

| Method | Path | Success | Gate | Purpose |
|---|---|---|---|---|
| GET | `/app/v1/manifest` | 200 | core | Agent identity, capabilities, optional home UI |
| POST | `/app/v1/messages` | 202 | core | Accept an InboundMessage for processing |
| GET | `/app/v1/events` | 200 (SSE) | core | Live outbox stream: `ack` \| `reply` \| `notice` |
| GET | `/app/v1/outbox` | 200 | core | Cursor-paged catch-up over the same events |
| GET | `/app/v1/health` | 200 | core | Liveness |
| POST | `/app/v1/uploads` | 201 | `files` | Store a file, return an upload id |
| GET | `/app/v1/files/<id>` | 200 | `files` | Retrieve a previously uploaded file |
| POST | `/app/v1/mcp` | 200 | `mcp-tools` or `mcp-apps-ui` | MCP endpoint: tools + MCP Apps `ui://` resources |

`POST /app/v1/uploads` returns **201 Created**, not 200. No prior source specified a
code; this contract sets it, and the harness asserts it exactly.

### Capabilities

The manifest declares `capabilities: string[]`. Declaring one is **binding**: the
agent MUST serve the routes it gates, and MUST pass their checks.

- `chat` — MUST be declared by every agent. Gates nothing; the chat triad is core.
- `files` — gates `POST /uploads` and `GET /files/<id>`, including the round-trip.
- `mcp-tools` — gates `POST /mcp`: initialize, `tools/list`, one `tools/call`.
- `mcp-apps-ui` — gates `POST /mcp`: initialize, `resources/list`, one `ui://` fetch.

A route whose capability is **not** declared MUST return **404** (still behind
bearer auth — an unauthenticated request to it is still 401). Answering a route the
manifest does not claim is non-conforming: the manifest would then be lying, and a
capability-adaptive client would hide functionality that actually works.

The capability vocabulary is **open**. Unknown strings MUST be ignored, never
rejected, so new capabilities are additive (ADR-0003).

### Channel separation

**Chat never rides MCP; tools and UI never ride the chat endpoints.** The
`messages`/`events`/`outbox` triad is the conversational channel. `/app/v1/mcp` is
the capability channel. An agent that tunnels replies through an MCP tool result, or
that exposes tool invocation through `POST /app/v1/messages`, is non-conforming even
if both channels individually validate.

## Consumes

From the app shell (client), the agent requires:

- A **bearer token** it issued or was configured with.
- A configured **owner id**, against which every inbound `personId` is checked.

From the operator, the agent requires nothing this contract specifies — storage,
model access, and process supervision are the agent's own business. This contract
describes a wire surface, not a runtime.

## Invariants — frozen now

### 1. Authentication: bearer, on every route, fail closed

Every route listed above requires `Authorization: Bearer <token>` — core and gated
alike, and including routes the agent answers with 404. A request with a missing,
malformed, or unrecognized token is rejected with **401** and the `error` shape,
before any other processing and regardless of what else is wrong with the request.
**401 precedes 404:** an unauthenticated request to an undeclared route returns 401,
never 404, so the surface is not enumerable without a token.

The token is per-connection, generated at agent deploy — the `NIGHTSHIFT_API_TOKEN`
pattern (`nightshift-client/idea.md` §3).

There is no anonymous route. `/app/v1/health` is authenticated like everything else:
liveness is not public information, and a uniform rule is one the harness can check
mechanically. Fail closed means an agent that cannot evaluate a token rejects the
request; it never falls back to permitting it.

### 2. One id, one cursor

Every event the agent emits — over SSE or over the outbox — uses the envelope:

```json
{ "schema": 1, "id": 42, "type": "reply", "at": "2026-07-27T19:58:21.980Z", "payload": {} }
```

- `id` is a **monotonically increasing integer, scoped to the agent**. It never
  repeats, never decreases, and is assigned at emit time.
- The same `id` is the SSE `id:` field (and therefore what a client sends back as
  `Last-Event-ID`) **and** the `after=<id>` cursor for `GET /app/v1/outbox`.
- Gaps are permitted; ordering is not optional.

There is exactly one cursor concept in this contract. No route may introduce a
second one (no opaque page tokens, no timestamp cursors, no per-type sequences).

Resuming with `Last-Event-ID: 42` and calling `GET /app/v1/outbox?after=42` MUST
yield the same events in the same order. That equivalence is what lets a client
switch between live and catch-up mode without reconciliation logic.

### 3. Event types

`type` is one of `ack` | `reply` | `notice`. This set is extensible additively:
a v1.x agent may emit a new type, and a v1.0 client MUST ignore event types it does
not recognize rather than erroring. Clients that switch exhaustively on `type` are
non-conforming consumers.

### 4. `personId` is vestigial but required

`personId` is present and required on the InboundMessage shape. **It is not
identity** — the bearer token is identity, and always was.

The field survives for byte-compatibility with the pre-existing InboundMessage shape.
Agents MUST validate that it equals their configured owner id and reject mismatches;
they MUST NOT use it to select an identity, a tenant, or a permission set.

This is documented here, in the normative contract, specifically so that a future
reader does not "clean it up." Removing it is a breaking change and therefore a new
contract.

### 5. Message acceptance is asynchronous and idempotent

`POST /app/v1/messages` returns **202 Accepted**. It does not return the reply.
The reply arrives later as a `reply` event on the outbox.

Each inbound message carries a client-generated UUID. Re-POSTing the same UUID is a
no-op that returns 202 again and emits no additional events. Delivery is therefore
at-least-once from the client and effectively-once at the agent — a client that
retries on a timeout cannot duplicate a conversation turn.

### 6. Errors

Every non-2xx response body uses the single `error` shape. An agent never returns a
bare string, an HTML error page, or a framework default on a route in this contract.

### 7. Tolerant readers

No object in this contract is closed. Unknown fields MUST be ignored, never
rejected. This is the mechanical form of additive-only compatibility (ADR-0003).

## Schema / wire

Normative schemas live at `schemas/v1/`, with `$id`s under the frozen prefix
`https://seanerama.github.io/agent-app-contract/schemas/v1/` (ADR-0003).

| Shape | File | Used by |
|---|---|---|
| `manifest` | `schemas/v1/manifest.json` | `GET /manifest` response |
| `inbound-message` | `schemas/v1/inbound-message.json` | `POST /messages` request |
| `assistant-reply` | `schemas/v1/assistant-reply.json` | `payload` of a `reply` event |
| `event-envelope` | `schemas/v1/event-envelope.json` | every SSE and outbox event |
| `outbox-page` | `schemas/v1/outbox-page.json` | `GET /outbox` response |
| `upload-response` | `schemas/v1/upload-response.json` | `POST /uploads` response |
| `error` | `schemas/v1/error.json` | every non-2xx body |

### Manifest: optional home UI

The manifest MAY pin a default UI surface:

```json
{ "ui": { "home": "ui://example/home@v1" } }
```

`ui` and `ui.home` are both optional. When `home` is present it MUST name a
`ui://` resource the agent serves from its MCP endpoint, and clients treat it as the
default Apps screen for that agent. When absent, the client chooses its own default.

## Field-level shapes — sourced, frozen at `v1.0.0`

The Architect deferred these rather than invent them. The Planner obtained the
source — `nightshift-client/idea.md` §3, the product-level plan `plan.md` defers to.
The shapes below are **transcribed from it, not designed here**, and are written into
`schemas/v1/` by the spec stage. They freeze the moment `v1.0.0` is tagged.

**Manifest** (§3.1) — plus the optional `ui` object decided in `plan.md` §2:

```json
{
  "schema": 1,
  "agent": { "name": "nightshift-assistant", "version": "…" },
  "contract": { "name": "app-ingress", "version": 1 },
  "capabilities": ["chat", "files", "mcp-tools", "mcp-apps-ui"],
  "ui": { "home": "ui://nightshift/jobs@v1" }
}
```

**InboundMessage** (§3.2) — the pre-existing shape reused verbatim: `schema: 1`,
`messageId` (client-generated UUID, also the dedup key), `personId` (pinned to owner),
`text`, `attachments` (upload ids), `receivedAt`.
Response: `202 { ok, messageId }`.

**Uploads** (§3.3) — `multipart/form-data` → `201 { ok, uploadId, path }`. The agent
writes into its `uploads/<ts>-<name>` layout so `InboundMessage.attachments` keeps
its meaning. **No size caps** — the Webex chunker retires with this contract.

**Health** (§3.5) — `200 { ok, version, uptimeSec }`.

**MCP** (§3.4) — MCP **streamable HTTP**. UI resources follow MCP Apps (SEP-1865),
`text/html`, named `ui://<agent>/<name>@v<N>`.

**Events** — `reply` carries the AssistantReply shape; `notice` carries proactive
`send()` traffic; `ack` signals a message accepted into a session.

Still genuinely unspecified, to be settled while writing `schemas/v1/` and recorded
in the spec as explicitly open if they cannot be:

- `assistant-reply` field list (idea.md names the shape and its `files` array but does
  not enumerate it — read it off `nightshift-assistant`'s existing implementation).
- `error` body: code vocabulary, message, correlation id.
- `outbox-page` envelope fields beyond the `after` cursor frozen above.
- Exact MCP protocol version required of a conforming agent.

Anything still unsettled when `v1.0.0` is cut must be recorded in the spec as
explicitly unspecified — never guessed and never left silent.

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.

**Additive** (allowed within v1.x): a new optional field; a new event `type`; a new
route; a new enum member on an outbound shape; a new MCP tool.

**Breaking** (requires a new contract): adding a required field; removing or renaming
any field; narrowing a type; removing an event type or route; changing a status code;
changing the meaning of `id`, the cursor, or the auth rule.

Every additive change ships as: a spec PR → new harness checks → mock-agent behavior,
in that order, with a `CHANGELOG.md` entry. A conforming agent never regresses to
failing without a documented additive change it can read about first.

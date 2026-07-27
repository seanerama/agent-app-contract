# Contract: app-ingress

- **Status:** frozen v1 (see *Freeze boundary* below)
- **Owner:** this repo (`agent-app-contract`). Implemented by every agent;
  consumed by every app shell.

> This document is normative prose. `schemas/v1/*.json` is normative for machines.
> Where they disagree, the schemas win and the prose is a bug.

## Freeze boundary

Everything under **Invariants** is frozen *now*, by the Architect, and may not be
reopened during the build. Everything under **Routes — normative detail** and
**Field-level shapes** was field-level detail settled from
`nightshift-client/idea.md` §3 and the reference implementation while writing
`schemas/v1/`; it freezes at tag **`v1.0.0`**.

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

## Routes — normative detail

Every route requires bearer auth (invariant 1). Every non-2xx body is the `error`
shape (invariant 6). Only the route-specific detail is given below.

### `GET /app/v1/manifest` — core

`200` with the `manifest` shape. The first call a client makes; the first call the
harness makes, because it decides which checks apply.

`contract.name` MUST be `"app-ingress"` and `contract.version` MUST be `1`. An agent
serving a different contract at these paths is not a v1 agent and the harness stops.

`capabilities` MUST contain `chat`. The vocabulary is open: unknown strings are
ignored, never rejected.

### `POST /app/v1/messages` — core

Request: the `inbound-message` shape. Response: **`202`** with
`{ "ok": true, "messageId": "<the id from the request>" }`.

- `202`, never `200`: the reply is not in this response and never will be
  (invariant 5). It arrives later as a `reply` event.
- Re-POSTing a `messageId` already seen returns `202` again and emits **no**
  additional events. The agent does not re-run the turn.
- `personId` that does not equal the agent's configured owner id → `403`.
- A body that fails schema validation → `400`.
- An agent MUST emit an `ack` event for a message it accepts for the first time.

### `GET /app/v1/events` — core

`200`, `Content-Type: text/event-stream`, one SSE event per emitted envelope:

```
id: 42
data: {"schema":1,"id":42,"type":"reply","at":"…","payload":{…}}

```

- The SSE `id:` field MUST equal the envelope's `id` (invariant 2).
- `Last-Event-ID: <n>` on the request MUST resume strictly after `n`, yielding the
  same events `GET /outbox?after=<n>` would yield, in the same order.
- The SSE `event:` field is not used. Clients read `type` from the payload, so an
  unknown type arrives as data rather than as an unhandled event name.
- Agents MAY send comment-only keep-alive lines (`: ping`). Interval is unspecified.

### `GET /app/v1/outbox` — core

`200` with the `outbox-page` shape. Query: `after=<id>` (optional; absent means from
the beginning). Events are strictly after the cursor, ascending by `id`.

Page size may be capped by the agent. There is no page token — the next cursor is the
`id` of the last event returned (invariant 2 permits exactly one cursor concept).
An empty `events` array means caught up.

### `GET /app/v1/health` — core

`200` with the `health` shape. Authenticated like everything else: liveness is not
public information. A `200` with `ok: false` is valid and meaningful — reachable but
degraded.

### `POST /app/v1/uploads` — gated by `files`

`multipart/form-data` in, **`201`** with the `upload-response` shape out. No size
caps. The returned `uploadId` is what a client puts in
`inbound-message.attachments`.

### `GET /app/v1/files/<id>` — gated by `files`

`200` with the file bytes and a `Content-Type`. `404` with the `error` shape for an
unknown id. An agent that declares `files` MUST serve every id it emitted in an
`assistant-reply.files` array.

### `POST /app/v1/mcp` — gated by `mcp-tools` or `mcp-apps-ui`

MCP over **streamable HTTP**. `mcp-tools` requires `initialize`, `tools/list`, and at
least one working `tools/call`. `mcp-apps-ui` requires `initialize`,
`resources/list`, and at least one readable `ui://` resource returning `text/html`,
per MCP Apps (SEP-1865), named `ui://<agent>/<name>@v<N>`.

Chat MUST NOT ride this endpoint, and tools MUST NOT ride `POST /messages`
(*Channel separation*, above).

## Field-level shapes — sourced, frozen at `v1.0.0`

Normative machine-readable definitions are `schemas/v1/*.json`; this table records
**where each shape came from**, because a contract that cannot say where its shapes
originated is a contract someone invented.

| Shape | Source | Kind |
|---|---|---|
| `health` | `idea.md` §3.5 | transcribed |
| `manifest` | `idea.md` §3.1 + `ui.home` (`plan.md` §2) + ADR-0006 | transcribed |
| `inbound-message` | `nightshift-assistant/src/types.ts` `InboundMessage` | transcribed |
| `assistant-reply` | `nightshift-assistant/src/types.ts` `AssistantReply` | transcribed, 2 fields relaxed |
| `event-envelope` | invariant 2, frozen by the Architect | transcribed |
| `upload-response` | `idea.md` §3.3 | transcribed |
| `error` | `nightshift-assistant/contracts/control-api.md` | reused from sibling contract |
| `outbox-page` | — | **decided here** |

Two entries are not pure transcription and say so:

- **`assistant-reply`** — `sessionId` and `rotated` are **required** on the reference
  implementation's internal interface and **optional** here. app-ingress is
  agent-agnostic by construction; requiring every conforming agent to produce a
  Claude Code session id would make one implementation's internals a condition of
  conformance. `text` and `files` stay required.
- **`outbox-page`** — no source specified a page envelope, so this contract sets the
  minimum: `{ schema, events }`, and deliberately **no** `nextCursor`/`hasMore`,
  since invariant 2 allows exactly one cursor concept and the next cursor is already
  the last event's `id`.

Additionally, `attachments` (inbound) and `files` (reply) carry **ids** here where the
source interfaces carried local filesystem paths. A client has no access to the
agent's disk. Field names and cardinality are unchanged so the session manager sees
what it always saw.

## Explicitly unspecified in v1.0.0

Recorded rather than guessed. Each may be settled additively in a later v1.x; none
may be assumed by a client or asserted by the harness.

1. **MCP protocol version.** No version is pinned. The reference implementation had
   no MCP server to read a version off, and inventing a date-stamped protocol version
   this contract does not control would create a conformance rule with no source. A
   conforming agent MUST complete `initialize` and return whatever `protocolVersion`
   it negotiates; the harness asserts the handshake succeeds, not its value.
2. **`error.code` vocabulary.** The `code` field is optional and its values are open.
   No existing implementation had a code set to transcribe.
3. **Error correlation id.** No field is defined. Nothing in the sources carried one.
4. **SSE keep-alive interval.** Agents may send comment-only pings; no cadence is
   required and clients MUST NOT infer liveness from their absence.
5. **Outbox page size cap.** Agent's choice. Clients page by cursor regardless.

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

# Nightshift Client — Dev Plan (MVP)

*Draft v0.1 — a generic mobile front door for agents built on the nightshift-assistant
architecture. Replaces the Webex transport going forward. Written in the house style:
frozen additive-only contracts, walking-skeleton Stage 0, dark feature flags.*

---

## 1. Product definition

A cross-platform mobile app (Android first, iOS-ready via Expo/EAS) that is a **thin
native shell** over agent-served UI:

- **Native shell owns:** agent connections (URL + token), the chat transcript,
  attachments, a sandboxed WebView renderer for MCP Apps `ui://` resources, settings.
- **Agents own:** everything else. All dashboards, forms, and custom views are
  server-delivered UI resources. The app ships rarely; agents iterate freely.
- **Agent-agnostic by construction.** The app speaks one contract, `app-ingress`.
  Any agent implementing it (nightshift-assistant first, future agents after) is a
  first-class citizen. The app holds N connections and switches between them.

Explicitly **out of MVP scope**: push notifications, token streaming, generative
("describe your UI") resources, voice, iOS builds, Webex retirement (dual-run
continues until parity is proven). All are additive later stages by design.

---

## 2. Repository layout — three artifacts

| Repo | Contents | Owner of |
|---|---|---|
| `agent-app-contract` | `app-ingress.md` (v1, frozen, additive-only), JSON Schemas for every wire shape, example payloads, **conformance harness** | The seam |
| `nightshift-client` | Expo app (TypeScript) | The shell |
| `nightshift-assistant` (and future agents) | `src/transport/app/` module implementing the contract, dark behind `APP_TRANSPORT_ENABLED` | The brains |

The contract repo is neutral ground — neither the app nor any single agent owns it.
The **conformance harness** is the piece that makes "connect to other agents" real: a
script (`npx agent-app-conformance <url> --token <t>`) that exercises every endpoint
and event shape against a live agent and emits pass/fail. Both agent CI and app CI run
it (agents against themselves; the app against a mock agent generated from the same
schemas). A new agent is "supported" when the harness passes — no app changes needed.

---

## 3. Contract: `app-ingress` v1 (MVP surface)

Design rules carried over from the existing contracts: fail closed, ack fast and work
off the request path, state can't lie (outbox is durable), frozen v1 / additive only —
a breaking change is a new contract.

**Assumptions:** agent reachable over a private network (tailnet); daemon binds
loopback + tailnet interface; no public exposure. Auth on every route: bearer token
(per-connection, generated at agent deploy — the `NIGHTSHIFT_API_TOKEN` pattern).

### 3.1 Discovery / handshake

- `GET /app/v1/manifest` →
  ```json
  {
    "schema": 1,
    "agent": { "name": "nightshift-assistant", "version": "…" },
    "contract": { "name": "app-ingress", "version": 1 },
    "capabilities": ["chat", "files", "mcp-tools", "mcp-apps-ui"]
  }
  ```
  The app adapts to capabilities rather than assuming them. This is the multi-agent
  hook: adding a connection = enter URL + token → app fetches manifest → done.

### 3.2 Messaging (async, never request/response)

- `POST /app/v1/messages` — body is the existing **InboundMessage shape reused
  verbatim** (`schema: 1`, client-generated UUID as `messageId`/dedup key, `personId`
  pinned to owner, `text`, `attachments` as upload ids, `receivedAt`). Returns
  `202 { ok, messageId }` immediately; the session manager's `relay()` runs off-path.
- `GET /app/v1/events` — SSE stream, server → client. Event types (v1):
  `reply` (AssistantReply shape), `notice` (proactive `send()` traffic),
  `ack` (message accepted into a session). Supports `Last-Event-ID` resume.
- `GET /app/v1/outbox?after=<cursor>` — catch-up fetch of undelivered events for
  app-open sync. With no push in MVP, delivery = "while connected, plus catch-up on
  open." Outbox rows live in the agent's SQLite with delivery state; nothing is lost
  while the phone is away.

### 3.3 Files

- `POST /app/v1/uploads` (multipart) → `{ ok, uploadId, path }`; agent writes into its
  existing `uploads/<ts>-<name>` layout so InboundMessage.attachments keeps meaning.
- `GET /app/v1/files/<id>` — authenticated download for `AssistantReply.files`
  (replaces Webex's file hosting). The Webex `chunker` retires; no size caps.

### 3.4 MCP endpoint (tools + UI)

- `POST /app/v1/mcp` — MCP streamable HTTP. Two things live here:
  1. **Tools** — a third 1:1 face of the control surface beside the `nightshift` CLI
     and control-api: `status`, `jobs_list`, `jobs_submit`, `jobs_kill`,
     `session_rotate`. Thin doors to `App.jobs` / `App.sessions`; no business logic.
  2. **UI resources** — MCP Apps (SEP-1865) `ui://` resources, `text/html`, rendered
     by the app in a sandboxed WebView; postMessage JSON-RPC routes user actions back
     to the tools above. Naming convention: `ui://<agent>/<name>@v<N>`.

Chat stays on §3.2, not MCP — conversation through tool-call semantics is awkward;
tools and UI through MCP is exactly what the extension is for.

### 3.5 Health

- `GET /app/v1/health` → `{ ok, version, uptimeSec }` (mirrors existing `/health`).

---

## 4. App architecture (`nightshift-client`)

- **Stack:** Expo (managed) + TypeScript. Dev in WSL2; physical Android device over
  Wi-Fi (Win11 mirrored networking + `adb pair`); EAS cloud builds for release
  artifacts and, later, iOS — no Mac required at any point.
- **Screens (MVP):**
  1. **Connections** — list of agents (name from manifest, health dot); add/edit
     (URL, token → SecureStore); switch active agent.
  2. **Chat** — native transcript (FlashList + markdown renderer), composer,
     attachment picker, connection-state banner, offline queue for unsent messages
     (client-side dedup UUIDs make retry safe).
  3. **Apps** — the agent's published `ui://` resources; opens the WebView renderer.
  4. **Settings** — minimal.
- **UI renderer:** sandboxed WebView per resource; JS injection disabled except the
  postMessage bridge; **no token in the WebView** — all agent calls go through the
  mediated bridge to the native MCP client. Any resource failure degrades to a
  plain-text/markdown rendering of the underlying tool result (fallback is mandatory).
- **Local state:** expo-sqlite mirror of transcript + outbox cursor per connection,
  so history renders instantly offline and catch-up is a cursor fetch.
- **Codegen:** TypeScript types generated from the contract repo's JSON Schemas in CI;
  drift is a compile error.

---

## 5. Agent-side work (nightshift-assistant)

New module `src/transport/app/`, sibling of the Webex transport, dark behind
`APP_TRANSPORT_ENABLED` (house pattern):

1. Migration: `outbox` table (event id, type, payload, createdAt, deliveredAt).
2. New `send()` implementation writing to outbox + emitting on live SSE connections;
   registered alongside the Webex `send()` during dual-run (both fire).
3. Routes per §3; bearer auth middleware; tailnet bind (loopback + tailscale iface).
4. MCP server (official TS SDK) exposing the five tools as wrappers over existing
   internals.
5. First prebuilt UI resource: **`ui://nightshift/jobs@v1`** — jobs dashboard
   (list, status filters, kill button, submit form). Chosen because control-api makes
   its backend already finished and frozen.
6. Conformance harness green in CI.

Watchdog, rotation, job runner, session manager: **untouched**.

---

## 6. Stages

### Stage 0 — Walking skeleton (blocks everything)

1. Contract repo exists: `app-ingress.md` v1 + JSON Schemas + mock agent + harness.
2. Agent: `/app/v1/` routes live behind the flag on the dev server; harness passes
   against it over the tailnet. Smoke-tested with curl + an SSE client and MCP
   Inspector **before any mobile code exists**.
3. App: Expo shell on the physical Android device; add connection → manifest fetch →
   send "ping" → `202` → reply arrives over SSE → renders in transcript.
4. App: fetch `ui://nightshift/jobs@v1`, render sandboxed, one round-trip
   (tap Kill → bridge → MCP tool → job killed → UI refreshes).
5. CI green in all three repos (harness in both implementations; typecheck + unit
   tests in the app).

Exit criterion: the phone can converse with the live assistant and kill a real job,
with Webex still running untouched beside it.

### Feature stages (dependency order)

1. **Transcript durability** — local SQLite history, outbox cursor catch-up on
   open/foreground, offline compose queue, reconnect/backoff for SSE.
2. **Attachments both directions** — uploads into InboundMessage; file downloads
   from AssistantReply; image/inline preview.
3. **Control surface** — Apps screen listing published resources; jobs dashboard
   polished; status panel resource (`ui://nightshift/status@v1`).
4. **Multi-agent** — N connections, per-connection state isolation, quick switcher;
   conformance-driven capability gating (an agent without `mcp-apps-ui` simply shows
   no Apps tab).
5. **Parity dual-run & checklist** — written checklist mirroring the NSAF-cutover
   philosophy: text round-trip, notices, attachments, job flows, a week of real daily
   use. Only after this does Webex retirement get scheduled (separate plan: remove
   transport + cloudflared, swap watchdog channel, archive `webex-ingress.md`).

### Deferred (post-MVP, all additive to v1)

Push notifications (the Expo-push vs ntfy decision) · token streaming (new SSE event
type) · generative UI (describe → generate → persist → iterate as versioned
resources) · native bridge capabilities (voice, share-sheet, haptics) · iOS via EAS +
TestFlight (needs the paid Apple account — don't buy it before this stage).

---

## 7. Risks / open questions

- **SSE through the mobile network stack** — background suspension will drop streams;
  Stage-1 reconnect + cursor catch-up is the mitigation, and the reason outbox
  durability is in Stage 0, not later.
- **`relay()` latency with no typing indicator** — v1 UX target is Webex parity
  (indicator, then a complete reply). Acceptable; streaming is deferred deliberately.
- **WebView sandbox rigor** — even single-user, agent-generated HTML downstream of
  web content is an injection path; the no-token-in-WebView rule and per-resource
  bridge allowlist are day-one requirements, not hardening.
- **Open question:** does the `Apps` capability list come from MCP resource listing
  alone, or does the manifest also pin a "home" resource per agent (an agent-chosen
  default screen)? Cheap to add additively; decide during Stage 0 contract drafting.

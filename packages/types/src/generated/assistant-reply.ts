/* eslint-disable */
/**
 * GENERATED — DO NOT EDIT.
 * Source: schemas/v1/. Regenerate with `npm run gen` at the repo root.
 * CI fails on drift between this file and a fresh generation (ADR-0003).
 */
/**
 * The `payload` of a `reply` event. SOURCE: read off nightshift-assistant/src/types.ts `AssistantReply` (the relay() return shape), which idea.md names but does not enumerate. Two fields of that interface are OPTIONAL here rather than required — see their descriptions. That is a decision made in this contract, not a transcription error: app-ingress is agent-agnostic by construction, and requiring every conforming agent to have a Claude Code session id would make the reference implementation's internals a condition of conformance.
 */
export interface AssistantReply {
  /**
   * Envelope version of the reply document itself.
   */
  schema: 1;
  /**
   * Markdown reply body. MAY be empty when the reply is carried entirely by `files`. Clients render markdown; no HTML is implied. Historically the transport chunked this — app-ingress imposes no size cap and the Webex chunker retires with it.
   */
  text: string;
  /**
   * File ids retrievable via GET /app/v1/files/<id>, gated by the `files` capability. MAY be empty, and is empty for most replies. NOTE the deliberate difference from the source interface, where this array held local filesystem paths: a client has no access to the agent's disk, so app-ingress carries ids. An agent that declares `files` MUST serve every id it emits here.
   */
  files: string[];
  /**
   * OPTIONAL. Opaque id of the agent-side session that produced the reply. Required in the reference implementation's internal interface; optional on the wire, because a conforming agent need not have a session concept at all. Clients MUST treat it as opaque and MUST NOT require it.
   */
  sessionId?: string;
  /**
   * OPTIONAL. True when this turn triggered a session rotation. Reference-implementation detail, surfaced because a client may wish to mark a transcript boundary. Absent means 'unknown or not applicable', NOT false.
   */
  rotated?: boolean;
  [k: string]: unknown;
}

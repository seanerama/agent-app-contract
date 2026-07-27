/* eslint-disable */
/**
 * GENERATED — DO NOT EDIT.
 * Source: schemas/v1/. Regenerate with `npm run gen` at the repo root.
 * CI fails on drift between this file and a fresh generation (ADR-0003).
 */
/**
 * Every event the agent emits, over SSE (GET /app/v1/events) and over catch-up (GET /app/v1/outbox) alike. Frozen by contracts/app-ingress.md invariant 2: the same envelope, the same id, one cursor concept for both routes. Resuming with Last-Event-ID: 42 and calling GET /outbox?after=42 MUST yield the same events in the same order.
 */
export interface EventEnvelope {
  /**
   * Envelope version.
   */
  schema: 1;
  /**
   * Monotonically increasing integer, scoped to the agent. Never repeats, never decreases, assigned at emit time. Gaps are permitted; ordering is not optional. This single value is BOTH the SSE `id:` field (what a client returns as Last-Event-ID) AND the `after=<id>` cursor for the outbox. No route may introduce a second cursor concept.
   */
  id: number;
  /**
   * One of `ack` | `reply` | `notice` in v1.0.0. DELIBERATELY NOT AN ENUM: invariant 3 makes this set extensible additively, so a v1.x agent may emit a type a v1.0 client has never heard of, and that client MUST ignore it rather than error. Enumerating here would turn an additive change into a validation failure. Clients that switch exhaustively on this field are non-conforming consumers.
   */
  type: string;
  /**
   * ISO 8601 emit time. Display and diagnostics only — ordering is `id`, never this field.
   */
  at: string;
  /**
   * Type-dependent body. For `reply` it is an AssistantReply (schemas/v1/assistant-reply.json) and the harness validates it as one. For `ack` it carries at least the accepted `messageId`. For `notice` it carries proactive send() traffic, shaped like a reply. Left as a generic object here rather than a closed union, so an unrecognised `type` carries an unconstrained payload instead of failing validation.
   */
  payload: {
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

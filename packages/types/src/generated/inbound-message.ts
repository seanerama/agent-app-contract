/* eslint-disable */
/**
 * GENERATED — DO NOT EDIT.
 * Source: schemas/v1/. Regenerate with `npm run gen` at the repo root.
 * CI fails on drift between this file and a fresh generation (ADR-0003).
 */
/**
 * Request body of POST /app/v1/messages. SOURCE: transcribed from nightshift-assistant/src/types.ts `InboundMessage`, the pre-existing shape this contract reuses byte-for-byte so the agent's session manager needs no translation layer. The response is 202 { ok, messageId } — acceptance is asynchronous and idempotent (contracts/app-ingress.md invariant 5); the reply arrives later as a `reply` event.
 */
export interface InboundMessage {
  /**
   * Envelope version of the message document itself.
   */
  schema: 1;
  /**
   * Client-generated UUID, and the dedup key. Re-POSTing the same id is a no-op that returns 202 again and emits no additional events, so a client that retries on a timeout cannot duplicate a conversation turn. In the Webex-era shape this was the Webex message id; over app-ingress the client generates it, which is what makes at-least-once delivery safe.
   */
  messageId: string;
  /**
   * VESTIGIAL BUT REQUIRED (contracts/app-ingress.md invariant 4). This is NOT identity — the bearer token is identity. Agents MUST check it equals their configured owner id and reject mismatches, and MUST NOT use it to select an identity, tenant, or permission set. It survives for byte-compatibility with the pre-existing shape. Do not 'clean it up': removing it is a breaking change and therefore a new contract.
   */
  personId: string;
  /**
   * Plain text of the message. MAY be empty — a message carrying only attachments is valid.
   */
  text: string;
  /**
   * Upload ids previously returned by POST /app/v1/uploads. MAY be empty. NOTE the deliberate difference from the Webex-era shape, where this array held absolute local paths: over the wire a client has no filesystem, so app-ingress carries upload ids and the agent resolves them to its own uploads/<ts>-<name> layout. The field name and cardinality are unchanged so the session manager sees what it always saw.
   */
  attachments: string[];
  /**
   * ISO 8601 timestamp from the client. Advisory only — the agent's own ordering is the `id` sequence on the event envelope, never this field.
   */
  receivedAt: string;
  [k: string]: unknown;
}

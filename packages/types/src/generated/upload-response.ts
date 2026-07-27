/* eslint-disable */
/**
 * GENERATED — DO NOT EDIT.
 * Source: schemas/v1/. Regenerate with `npm run gen` at the repo root.
 * CI fails on drift between this file and a fresh generation (ADR-0003).
 */
/**
 * Body of a 201 response to POST /app/v1/uploads (multipart/form-data), gated by the `files` capability. SOURCE: nightshift-client/idea.md 3.3. The status is 201 Created, not 200 — no prior source specified a code, this contract sets it, and the harness asserts it exactly. No size caps: the Webex chunker retires with this contract.
 */
export interface UploadResponse {
  /**
   * Always true on a 201. Failures use the error shape (schemas/v1/error.json) with a non-2xx status.
   */
  ok: true;
  /**
   * Opaque id for the stored file. This is the value a client puts in InboundMessage.attachments, and it is what makes attachments transportable to a client with no filesystem access.
   */
  uploadId: string;
  /**
   * Agent-side path the file was written to, in the agent's existing uploads/<ts>-<name> layout, so InboundMessage.attachments keeps its original meaning for the session manager. INFORMATIONAL ONLY — a client cannot read it and MUST NOT try; address the file by uploadId.
   */
  path: string;
  [k: string]: unknown;
}

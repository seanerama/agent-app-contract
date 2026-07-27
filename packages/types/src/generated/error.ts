/* eslint-disable */
/**
 * GENERATED — DO NOT EDIT.
 * Source: schemas/v1/. Regenerate with `npm run gen` at the repo root.
 * CI fails on drift between this file and a fresh generation (ADR-0003).
 */
/**
 * Body of EVERY non-2xx response on every route in this contract (contracts/app-ingress.md invariant 6). An agent never returns a bare string, an HTML error page, or a framework default. SOURCE: this shape is not invented here — it is reused verbatim from the sibling contract nightshift-assistant/contracts/control-api.md, which already standardises `{ ok: false, error: string }` across the control surface. Reuse beats novelty: an agent implementing both contracts emits one error shape, not two.
 */
export interface ErrorResponse {
  /**
   * Always false. Present so a client can branch on the body alone, without consulting the status code, exactly as control-api does.
   */
  ok: false;
  /**
   * Human-readable message. Intended for logs and developer display; not a stable identifier and not safe to switch on. Agents SHOULD NOT put secrets or tokens here.
   */
  error: string;
  /**
   * OPTIONAL machine-readable code. The vocabulary is OPEN and deliberately unfrozen — no code set is normative in v1.0.0, because no existing implementation had one to transcribe. Clients MUST NOT require this field and MUST tolerate any value. Codes may be standardised additively in a later v1.x.
   */
  code?: string;
  [k: string]: unknown;
}

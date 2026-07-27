/* eslint-disable */
/**
 * GENERATED — DO NOT EDIT.
 * Source: schemas/v1/. Regenerate with `npm run gen` at the repo root.
 * CI fails on drift between this file and a fresh generation (ADR-0003).
 */
/**
 * Body of a 200 response to GET /app/v1/health. Mirrors the agent's existing /health surface (nightshift-client/idea.md 3.5). Liveness is authenticated like every other route — see contracts/app-ingress.md invariant 1.
 */
export interface HealthResponse {
  /**
   * True when the agent considers itself healthy. A 200 with ok:false is a valid, meaningful response — the agent is reachable but degraded.
   */
  ok: boolean;
  /**
   * Agent version string. Opaque to the client; no format is imposed.
   */
  version: string;
  /**
   * Seconds since the agent process started.
   */
  uptimeSec: number;
  [k: string]: unknown;
}

export type HandEditedByAHuman = true;

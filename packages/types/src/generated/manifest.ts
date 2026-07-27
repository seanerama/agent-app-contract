/* eslint-disable */
/**
 * GENERATED — DO NOT EDIT.
 * Source: schemas/v1/. Regenerate with `npm run gen` at the repo root.
 * CI fails on drift between this file and a fresh generation (ADR-0003).
 */
/**
 * Body of a 200 response to GET /app/v1/manifest. Source: nightshift-client/idea.md 3.1, plus the optional ui object decided in plan.md section 2 and the capability vocabulary from ADR-0006. This is what the client fetches when adding a connection, and what the conformance harness reads first to decide which checks apply.
 */
export interface Manifest {
  /**
   * Envelope version of the manifest document itself.
   */
  schema: 1;
  /**
   * Identity of the agent. Display-only; the bearer token is identity for auth purposes.
   */
  agent: {
    name: string;
    version: string;
    [k: string]: unknown;
  };
  /**
   * Which contract, at which major version, this agent claims to implement.
   */
  contract: {
    name: 'app-ingress';
    version: 1;
    [k: string]: unknown;
  };
  /**
   * Declared capabilities (ADR-0006). Declaring one is binding: the agent MUST serve the routes it gates. Routes for undeclared capabilities MUST 404. The vocabulary is open — unknown strings are ignored, never rejected, so new capabilities are additive. The 'contains' clause enforces the contract rule that every agent MUST declare 'chat'; the chat triad is core and gates nothing.
   */
  capabilities: string[];
  /**
   * Optional. When present, home names a ui:// resource the agent serves from its MCP endpoint, and clients treat it as the default Apps screen (plan.md section 2, decision 2).
   */
  ui?: {
    /**
     * Naming convention: ui://<agent>/<name>@v<N>.
     */
    home?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

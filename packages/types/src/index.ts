/**
 * @agent-app/types — TypeScript types for the app-ingress v1 wire surface.
 *
 * Everything exported here is generated from `schemas/v1/` (ADR-0003). The schemas
 * are normative; these types are a build artifact of them. If a type and a schema
 * disagree, the schema is right and the generator or the commit is stale.
 */
export type * from './generated/index.js';

/**
 * Frozen `$id` prefix for every v1 schema (ADR-0003).
 *
 * Exported so consumers and the conformance harness can assert schema identity
 * without hard-coding the string in several places. It is an identifier, not a
 * promise that the URL resolves.
 */
export const SCHEMA_ID_PREFIX = 'https://seanerama.github.io/agent-app-contract/schemas/v1/';

/** The contract version these types describe. */
export const CONTRACT_VERSION = 1 as const;

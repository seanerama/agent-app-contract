/**
 * Reference implementation of the app-ingress v1 surface — in memory, no storage.
 *
 * Scope at this stage: the core routes the walking skeleton needs (`/health`,
 * `/manifest`). Everything else answers with a status that says *why* it is absent,
 * which matters because the two reasons are not interchangeable:
 *
 *   404 — the capability gating this route is undeclared. Under ADR-0006 this is
 *         the CORRECT conforming behavior, not a stub.
 *   501 — a core route, or a route whose capability IS declared, that this mock has
 *         not built yet. Honestly non-conforming.
 *
 * Collapsing 501 into 404 would make "legitimately opted out" indistinguishable from
 * "declared it and then failed to serve it", and the harness could not tell a
 * conforming chat-only agent from a lying one.
 *
 * IMPORTANT (ADR-0005): this package must not share implementation code with
 * packages/conformance. They speak to each other only over HTTP. If they shared a
 * request builder or a response shaper, a common misreading of the spec would cancel
 * out and CI would go green on a bug — which would defeat the entire point of the
 * self-proving loop. Duplication here is deliberate; do not "clean it up".
 */

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

/** Routes that every conforming agent serves, whatever it declares (ADR-0006). */
const CORE_ROUTES = [
  '/app/v1/manifest',
  '/app/v1/messages',
  '/app/v1/events',
  '/app/v1/outbox',
  '/app/v1/health',
] as const;

/** Which capability gates which route (ADR-0006). */
const GATED_ROUTES: ReadonlyArray<{ path: string; capabilities: readonly string[] }> = [
  { path: '/app/v1/uploads', capabilities: ['files'] },
  { path: '/app/v1/files', capabilities: ['files'] },
  { path: '/app/v1/mcp', capabilities: ['mcp-tools', 'mcp-apps-ui'] },
];

export interface MockAgentOptions {
  /** Bearer token this agent accepts. Every route requires it. */
  token: string;
  /** Capabilities to declare in the manifest. `chat` is always included. */
  capabilities?: readonly string[];
  /** Agent name reported in the manifest. */
  name?: string;
  /** Agent version reported in the manifest and by /health. */
  version?: string;
}

const SCHEMA_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'schemas', 'v1');

const loadValidators = (): { health: ValidateFunction; manifest: ValidateFunction } => {
  const ajv = new Ajv2020({ strict: true });
  const read = (name: string) => JSON.parse(readFileSync(join(SCHEMA_DIR, name), 'utf8'));
  return {
    health: ajv.compile(read('health.json')),
    manifest: ajv.compile(read('manifest.json')),
  };
};

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

/** The single error shape every non-2xx response uses (contract invariant 6). */
const sendError = (res: ServerResponse, status: number, code: string, message: string): void => {
  sendJson(res, status, { schema: 1, error: { code, message } });
};

const bearerToken = (req: IncomingMessage): string | null => {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1] ?? null;
};

export const createMockAgent = (options: MockAgentOptions): Server => {
  const version = options.version ?? '0.1.0';
  const name = options.name ?? 'mock-agent';
  // `chat` is mandatory for every conforming agent and gates nothing.
  const capabilities = Array.from(new Set(['chat', ...(options.capabilities ?? [])]));
  const declares = (needed: readonly string[]) => needed.some((c) => capabilities.includes(c));

  const validators = loadValidators();
  const startedAt = Date.now();

  const manifest = {
    schema: 1,
    agent: { name, version },
    contract: { name: 'app-ingress', version: 1 },
    capabilities,
  };

  // Fail fast at construction rather than serving a body that violates the contract.
  if (!validators.manifest(manifest)) {
    throw new Error(
      `mock-agent manifest violates its own schema: ${JSON.stringify(validators.manifest.errors)}`,
    );
  }

  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // Invariant 1: auth is evaluated BEFORE routing, and 401 precedes 404, so the
    // route surface is not enumerable without a token.
    if (bearerToken(req) !== options.token) {
      sendError(res, 401, 'unauthorized', 'A valid bearer token is required on every route.');
      return;
    }

    const gate = GATED_ROUTES.find((g) => path === g.path || path.startsWith(`${g.path}/`));
    if (gate && !declares(gate.capabilities)) {
      // Undeclared capability: the route must 404, not answer (ADR-0006).
      sendError(
        res,
        404,
        'not_found',
        `This agent does not declare ${gate.capabilities.join(' or ')}, so ${gate.path} is not served.`,
      );
      return;
    }

    if (path === '/app/v1/health' && req.method === 'GET') {
      const body = {
        ok: true,
        version,
        uptimeSec: (Date.now() - startedAt) / 1000,
      };
      if (!validators.health(body)) {
        sendError(res, 500, 'internal', 'health response failed its own schema');
        return;
      }
      sendJson(res, 200, body);
      return;
    }

    if (path === '/app/v1/manifest' && req.method === 'GET') {
      sendJson(res, 200, manifest);
      return;
    }

    const isKnownRoute =
      CORE_ROUTES.includes(path as (typeof CORE_ROUTES)[number]) ||
      GATED_ROUTES.some((g) => path === g.path || path.startsWith(`${g.path}/`));

    if (isKnownRoute) {
      // A v1 route this mock has not built yet. 501, never 404 — 404 is reserved for
      // "the capability is undeclared", and using it here would make the response
      // indistinguishable from correct gating. The harness must be able to tell an
      // agent that legitimately opted out from one that declared a capability and
      // then failed to serve it (ADR-0006: declaring is binding).
      sendError(res, 501, 'not_implemented', `${path} is not implemented by this mock yet.`);
      return;
    }

    sendError(res, 404, 'not_found', `No such route: ${path}`);
  });
};

/**
 * Reference implementation of the app-ingress v1 surface — in memory, no storage.
 *
 * Scope at this stage: the core routes — `/health`, `/manifest`, and the chat triad
 * `/messages` + `/events` + `/outbox`. The capability-gated routes (`/uploads`,
 * `/files`, `/mcp`) answer with a status that says *why* they are absent, which
 * matters because the two reasons are not interchangeable:
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
import formatsPlugin from 'ajv-formats';

/**
 * ajv-formats is CommonJS with `module.exports = plugin` AND `exports.default`.
 * Under NodeNext resolution TypeScript types the default import as the module
 * namespace rather than the callable, so calling it directly is a compile error even
 * though it works at runtime. Normalising once here keeps the cast in one place
 * instead of at every call site.
 */
const addFormats = ((formatsPlugin as unknown as { default?: unknown }).default ??
  formatsPlugin) as (ajv: unknown) => void;

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

/** Refuse absurd bodies rather than buffering them. Not a contract rule. */
const MAX_BODY_BYTES = 1_000_000;

export interface MockAgentOptions {
  /** Bearer token this agent accepts. Every route requires it. */
  token: string;
  /** Capabilities to declare in the manifest. `chat` is always included. */
  capabilities?: readonly string[];
  /** Agent name reported in the manifest. */
  name?: string;
  /** Agent version reported in the manifest and by /health. */
  version?: string;
  /**
   * Owner id every inbound `personId` is checked against (contract invariant 4).
   * Configured out of band, exactly like the token — the contract deliberately
   * defines no way to discover it over the wire.
   */
  ownerId?: string;
}

interface EventEnvelope {
  schema: 1;
  id: number;
  type: string;
  at: string;
  payload: Record<string, unknown>;
}

const SCHEMA_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'schemas', 'v1');

interface Validators {
  health: ValidateFunction;
  manifest: ValidateFunction;
  inboundMessage: ValidateFunction;
  outboxPage: ValidateFunction;
  eventEnvelope: ValidateFunction;
}

const loadValidators = (): Validators => {
  const ajv = new Ajv2020({ strict: true });
  // The schemas use format: uuid and format: date-time. Without this, ajv throws on
  // compile rather than silently skipping them — which is the right default, and the
  // reason ajv-formats is a real dependency of this package, not a dev one.
  addFormats(ajv);
  const read = (name: string) => JSON.parse(readFileSync(join(SCHEMA_DIR, name), 'utf8'));

  // Registered before compiling, so outbox-page's $ref to event-envelope resolves
  // against the local file rather than being fetched from the (unpublished) $id URL.
  for (const name of ['event-envelope.json', 'assistant-reply.json']) {
    ajv.addSchema(read(name));
  }

  return {
    health: ajv.compile(read('health.json')),
    manifest: ajv.compile(read('manifest.json')),
    inboundMessage: ajv.compile(read('inbound-message.json')),
    outboxPage: ajv.compile(read('outbox-page.json')),
    eventEnvelope: ajv.getSchema(
      'https://seanerama.github.io/agent-app-contract/schemas/v1/event-envelope.json',
    ) as ValidateFunction,
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

/**
 * The single error shape every non-2xx response uses (contract invariant 6).
 *
 * `{ ok: false, error }` is reused from the sibling control-api contract, not
 * invented here — see schemas/v1/error.json. `code` is optional and its vocabulary
 * is open, so nothing downstream may switch on it exhaustively.
 */
const sendError = (res: ServerResponse, status: number, error: string, code?: string): void => {
  sendJson(res, status, code === undefined ? { ok: false, error } : { ok: false, error, code });
};

const bearerToken = (req: IncomingMessage): string | null => {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1] ?? null;
};

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
};

export const createMockAgent = (options: MockAgentOptions): Server => {
  const version = options.version ?? '0.1.0';
  const name = options.name ?? 'mock-agent';
  const ownerId = options.ownerId ?? 'owner-mock';
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

  // ---------------------------------------------------------------------------
  // Outbox state. One monotonic id sequence serves BOTH the SSE `id:` field and the
  // `?after=` cursor — invariant 2 permits exactly one cursor concept, so there is
  // deliberately only one counter here to get it wrong with.
  // ---------------------------------------------------------------------------
  const events: EventEnvelope[] = [];
  let nextId = 1;
  const seenMessageIds = new Set<string>();
  const streams = new Set<ServerResponse>();

  const emit = (type: string, payload: Record<string, unknown>): EventEnvelope => {
    const event: EventEnvelope = {
      schema: 1,
      id: nextId,
      type,
      at: new Date().toISOString(),
      payload,
    };
    nextId += 1;

    // Self-check: an agent that emits an envelope violating its own schema would send
    // the harness chasing a phantom. Fail loudly at the source instead.
    if (!validators.eventEnvelope(event)) {
      throw new Error(
        `mock-agent emitted an invalid envelope: ${JSON.stringify(validators.eventEnvelope.errors)}`,
      );
    }

    events.push(event);
    const frame = `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const stream of streams) stream.write(frame);
    return event;
  };

  const eventsAfter = (after: number): EventEnvelope[] => events.filter((e) => e.id > after);

  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // Invariant 1: auth is evaluated BEFORE routing, and 401 precedes 404, so the
    // route surface is not enumerable without a token.
    if (bearerToken(req) !== options.token) {
      sendError(res, 401, 'A valid bearer token is required on every route.', 'unauthorized');
      return;
    }

    const gate = GATED_ROUTES.find((g) => path === g.path || path.startsWith(`${g.path}/`));
    if (gate && !declares(gate.capabilities)) {
      // Undeclared capability: the route must 404, not answer (ADR-0006).
      sendError(
        res,
        404,
        `This agent does not declare ${gate.capabilities.join(' or ')}, so ${gate.path} is not served.`,
        'not_found',
      );
      return;
    }

    if (path === '/app/v1/health' && req.method === 'GET') {
      const body = { ok: true, version, uptimeSec: (Date.now() - startedAt) / 1000 };
      if (!validators.health(body)) {
        sendError(res, 500, 'health response failed its own schema', 'internal');
        return;
      }
      sendJson(res, 200, body);
      return;
    }

    if (path === '/app/v1/manifest' && req.method === 'GET') {
      sendJson(res, 200, manifest);
      return;
    }

    // -------------------------------------------------------------------------
    // POST /messages — 202, idempotent, asynchronous (invariant 5).
    // -------------------------------------------------------------------------
    if (path === '/app/v1/messages' && req.method === 'POST') {
      void (async () => {
        let raw: string;
        try {
          raw = await readBody(req);
        } catch {
          sendError(res, 413, 'Request body is too large.', 'body_too_large');
          return;
        }

        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          sendError(res, 400, 'Request body is not valid JSON.', 'invalid_body');
          return;
        }

        if (!validators.inboundMessage(body)) {
          sendError(
            res,
            400,
            `Body does not match inbound-message.json: ${JSON.stringify(validators.inboundMessage.errors)}`,
            'invalid_body',
          );
          return;
        }

        const message = body as {
          messageId: string;
          personId: string;
          text: string;
          attachments: string[];
        };

        // Invariant 4: personId is checked against the configured owner and is NOT
        // used to select an identity. A mismatch is refused, not silently accepted.
        if (message.personId !== ownerId) {
          sendError(
            res,
            403,
            'personId does not match this agent’s configured owner id.',
            'not_owner',
          );
          return;
        }

        // Invariant 5: re-POSTing a known id is a no-op that returns 202 again and
        // emits NO additional events. The turn is not re-run.
        const isNew = !seenMessageIds.has(message.messageId);
        if (isNew) {
          seenMessageIds.add(message.messageId);
          emit('ack', { messageId: message.messageId });

          // The reply arrives LATER, off the request path — that is the whole point
          // of 202. setImmediate keeps that ordering real rather than pretending.
          setImmediate(() => {
            emit('reply', {
              schema: 1,
              text: `mock-agent received: ${message.text}`,
              files: [],
            });
          });
        }

        sendJson(res, 202, { ok: true, messageId: message.messageId });
      })();
      return;
    }

    // -------------------------------------------------------------------------
    // GET /events — SSE. The `id:` field IS the cursor (invariant 2).
    // -------------------------------------------------------------------------
    if (path === '/app/v1/events' && req.method === 'GET') {
      const lastEventId = Number.parseInt(String(req.headers['last-event-id'] ?? ''), 10);
      const after = Number.isInteger(lastEventId) && lastEventId >= 0 ? lastEventId : 0;

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      // Resume: everything strictly after Last-Event-ID, in order. This MUST match
      // what GET /outbox?after=<same id> returns — the harness asserts exactly that.
      for (const event of eventsAfter(after)) {
        res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
      }

      streams.add(res);
      req.on('close', () => {
        streams.delete(res);
      });
      return;
    }

    // -------------------------------------------------------------------------
    // GET /outbox — catch-up over the same events, same cursor.
    // -------------------------------------------------------------------------
    if (path === '/app/v1/outbox' && req.method === 'GET') {
      const afterParam = url.searchParams.get('after');
      if (afterParam !== null && !/^\d+$/.test(afterParam)) {
        sendError(res, 400, 'after must be a non-negative integer event id.', 'invalid_cursor');
        return;
      }
      const after = afterParam === null ? 0 : Number.parseInt(afterParam, 10);

      const page = { schema: 1, events: eventsAfter(after) };
      if (!validators.outboxPage(page)) {
        sendError(res, 500, 'outbox page failed its own schema', 'internal');
        return;
      }
      sendJson(res, 200, page);
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
      sendError(res, 501, `${path} is not implemented by this mock yet.`, 'not_implemented');
      return;
    }

    sendError(res, 404, `No such route: ${path}`, 'not_found');
  });
};

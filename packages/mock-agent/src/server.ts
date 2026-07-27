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

/**
 * Returned from `initialize` only when the client names no version of its own.
 *
 * The contract pins NO MCP protocol version — see "Explicitly unspecified" in
 * contracts/app-ingress.md. This constant is this mock's own answer, not a
 * conformance requirement, and the harness must never assert on its value.
 */
const MCP_FALLBACK_PROTOCOL_VERSION = '2025-06-18';

/** The one UI resource this mock publishes. Naming: ui://<agent>/<name>@v<N>. */
const UI_RESOURCE = 'ui://mock-agent/home@v1';

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
  uploadResponse: ValidateFunction;
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
    uploadResponse: ajv.compile(read('upload-response.json')),
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

/**
 * Minimal multipart/form-data reader — enough to pull the first file part out.
 *
 * Deliberately not a dependency: the contract says `multipart/form-data` in and an
 * upload id out, and a reference implementation that reached for a parser library
 * would hide how little the contract actually requires.
 */
const firstFilePart = (
  body: Buffer,
  contentType: string,
): { filename: string; contentType: string; bytes: Buffer } | null => {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (boundaryMatch?.[1] ?? boundaryMatch?.[2])?.trim();
  if (boundary === undefined) return null;

  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let index = body.indexOf(delimiter);
  while (index !== -1) {
    const start = index + delimiter.length;
    const next = body.indexOf(delimiter, start);
    if (next === -1) break;
    // Trim the CRLF that opens the part and the CRLF that closes it.
    parts.push(body.subarray(start + 2, next - 2));
    index = next;
  }

  for (const part of parts) {
    const split = part.indexOf('\r\n\r\n');
    if (split === -1) continue;
    const headers = part.subarray(0, split).toString('utf8');
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
    if (filename === undefined || filename === '') continue;
    const partType = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim();
    return {
      filename,
      contentType: partType ?? 'application/octet-stream',
      bytes: part.subarray(split + 4),
    };
  }
  return null;
};

const readRawBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
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
  const version = options.version ?? '1.0.0';
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
  const files = new Map<string, { filename: string; contentType: string; bytes: Buffer }>();

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
            // Echo the attachments back as reply files. Under the contract these are
            // ids retrievable from GET /files/<id> — which is exactly what the upload
            // ids are — so this closes the round trip a client actually performs:
            // upload -> reference in a message -> receive back -> download.
            const echoed = declares(['files'])
              ? message.attachments.filter((id) => files.has(id))
              : [];
            emit('reply', {
              schema: 1,
              text: `mock-agent received: ${message.text}`,
              files: echoed,
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

    // -------------------------------------------------------------------------
    // POST /uploads — gated by `files`. 201, not 200 (the contract sets this).
    // -------------------------------------------------------------------------
    if (path === '/app/v1/uploads' && req.method === 'POST') {
      void (async () => {
        let raw: Buffer;
        try {
          raw = await readRawBody(req);
        } catch {
          sendError(res, 413, 'Request body is too large.', 'body_too_large');
          return;
        }

        const part = firstFilePart(raw, req.headers['content-type'] ?? '');
        if (part === null) {
          sendError(res, 400, 'Expected multipart/form-data with a file part.', 'invalid_body');
          return;
        }

        // The agent's existing uploads/<ts>-<name> layout, so that an attachment id
        // keeps its original meaning for a session manager reading the same disk.
        const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', 'T');
        const safeName = part.filename.replace(/[^\w.-]/g, '_');
        const uploadId = `up_${stamp}-${safeName}`;
        files.set(uploadId, part);

        const body = { ok: true, uploadId, path: `uploads/${stamp}-${safeName}` };
        if (!validators.uploadResponse(body)) {
          sendError(res, 500, 'upload response failed its own schema', 'internal');
          return;
        }
        sendJson(res, 201, body);
      })();
      return;
    }

    // -------------------------------------------------------------------------
    // GET /files/<id> — gated by `files`. Bytes, not JSON.
    // -------------------------------------------------------------------------
    if (path.startsWith('/app/v1/files/') && req.method === 'GET') {
      const id = decodeURIComponent(path.slice('/app/v1/files/'.length));
      const stored = files.get(id);
      if (stored === undefined) {
        sendError(res, 404, `No such file: ${id}`, 'not_found');
        return;
      }
      res.writeHead(200, {
        'content-type': stored.contentType,
        'content-length': stored.bytes.length,
      });
      res.end(stored.bytes);
      return;
    }

    // -------------------------------------------------------------------------
    // POST /mcp — MCP streamable HTTP. Tools and UI resources are gated SEPARATELY:
    // an agent declaring only mcp-tools must not answer resources/*, and vice versa,
    // or the manifest would again be describing a surface that is not there.
    // -------------------------------------------------------------------------
    if (path === '/app/v1/mcp' && req.method === 'POST') {
      void (async () => {
        let raw: string;
        try {
          raw = await readBody(req);
        } catch {
          sendError(res, 413, 'Request body is too large.', 'body_too_large');
          return;
        }

        let rpc: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
        try {
          rpc = JSON.parse(raw);
        } catch {
          sendJson(res, 400, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          });
          return;
        }

        const id = rpc.id ?? null;
        const ok = (result: unknown) => sendJson(res, 200, { jsonrpc: '2.0', id, result });
        const rpcError = (code: number, message: string) =>
          sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });

        // A notification (no id) gets no body — the client is not waiting on one.
        if (rpc.id === undefined && rpc.method?.startsWith('notifications/')) {
          res.writeHead(202).end();
          return;
        }

        switch (rpc.method) {
          case 'initialize': {
            const requested = (rpc.params as { protocolVersion?: string } | undefined)
              ?.protocolVersion;
            ok({
              // Echo the client's version when it names one. The contract pins NO
              // protocol version (see "Explicitly unspecified"), so asserting a
              // particular string here would invent a conformance rule.
              protocolVersion: requested ?? MCP_FALLBACK_PROTOCOL_VERSION,
              capabilities: {
                ...(declares(['mcp-tools']) ? { tools: {} } : {}),
                ...(declares(['mcp-apps-ui']) ? { resources: {} } : {}),
              },
              serverInfo: { name, version },
            });
            return;
          }
          case 'tools/list': {
            if (!declares(['mcp-tools'])) {
              rpcError(-32601, 'This agent does not declare mcp-tools.');
              return;
            }
            ok({
              tools: [
                {
                  name: 'status',
                  description: 'Return the agent status. A thin door, no business logic.',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            });
            return;
          }
          case 'tools/call': {
            if (!declares(['mcp-tools'])) {
              rpcError(-32601, 'This agent does not declare mcp-tools.');
              return;
            }
            const toolName = (rpc.params as { name?: string } | undefined)?.name;
            if (toolName !== 'status') {
              rpcError(-32602, `Unknown tool: ${String(toolName)}`);
              return;
            }
            ok({
              content: [
                { type: 'text', text: JSON.stringify({ ok: true, version, uptimeSec: 1 }) },
              ],
              isError: false,
            });
            return;
          }
          case 'resources/list': {
            if (!declares(['mcp-apps-ui'])) {
              rpcError(-32601, 'This agent does not declare mcp-apps-ui.');
              return;
            }
            ok({ resources: [{ uri: UI_RESOURCE, name: 'home', mimeType: 'text/html' }] });
            return;
          }
          case 'resources/read': {
            if (!declares(['mcp-apps-ui'])) {
              rpcError(-32601, 'This agent does not declare mcp-apps-ui.');
              return;
            }
            const uri = (rpc.params as { uri?: string } | undefined)?.uri;
            if (uri !== UI_RESOURCE) {
              rpcError(-32602, `Unknown resource: ${String(uri)}`);
              return;
            }
            ok({
              contents: [
                {
                  uri: UI_RESOURCE,
                  mimeType: 'text/html',
                  text: '<!doctype html><title>mock</title><p>mock-agent home</p>',
                },
              ],
            });
            return;
          }
          default:
            rpcError(-32601, `Method not found: ${String(rpc.method)}`);
        }
      })();
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

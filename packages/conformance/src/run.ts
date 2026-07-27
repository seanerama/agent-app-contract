/**
 * The conformance run.
 *
 * Checks assert against contracts/app-ingress.md — NEVER against an implementation
 * detail of packages/mock-agent. The mock is the harness's first subject, never its
 * oracle (ADR-0005 rule 2). If a check would pass only because of how the mock
 * happens to behave, that check is a bug.
 *
 * IMPORTANT (ADR-0005 rule 1): this package shares no implementation code with
 * packages/mock-agent. It talks to agents over HTTP only. Duplication between the
 * two is deliberate — if they shared a request builder or response parser, a common
 * misreading of the spec would cancel out and the loop would go green on a bug.
 */
import { readFileSync } from 'node:fs';
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
import { buildReport, type Check, type Report } from './report.js';

const addFormats = ((formatsPlugin as unknown as { default?: unknown }).default ??
  formatsPlugin) as (ajv: unknown) => void;

const SCHEMA_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'schemas', 'v1');

const readSchema = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(SCHEMA_DIR, `${name}.json`), 'utf8'));

const compile = (ajv: Ajv2020, name: string): ValidateFunction => ajv.compile(readSchema(name));

export interface RunOptions {
  baseUrl: string;
  token: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  harnessVersion?: string;
  /**
   * Owner id to send as `personId` (contract invariant 4).
   *
   * The contract deliberately defines no way to LEARN this over the wire — like the
   * bearer token, it is configured out of band. Without it the harness cannot post a
   * message that will be accepted, so the chat-triad checks report `skip` rather than
   * failing an agent for a fact the harness was never given.
   */
  personId?: string;
}

interface Fetched {
  status: number;
  body: unknown;
  raw: string;
  contentType: string;
}

class Unreachable extends Error {}

const describeErrors = (validate: ValidateFunction): string =>
  (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');

interface StreamedEvent {
  /** The SSE `id:` line. */
  sseId: number;
  /** The `id` inside the JSON envelope. Invariant 2 says these are the same value. */
  id: number;
  type: string;
  payload: unknown;
}

/**
 * Read an SSE stream until it goes quiet, then abort.
 *
 * Deliberately duplicated rather than shared with mock-agent (ADR-0005 rule 1): if
 * both sides used one SSE codec, a shared misreading of the framing would cancel out
 * and the loop would certify a stream no real client could parse.
 */
const readSse = async (
  url: string,
  token: string,
  lastEventId: number,
  windowMs: number,
): Promise<StreamedEvent[]> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), windowMs);

  try {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
        'last-event-id': String(lastEventId),
      },
      signal: controller.signal,
    });

    if (!res.ok || res.body === null) {
      throw new Error(`expected a 200 event-stream, got ${res.status}`);
    }
    if (!res.headers.get('content-type')?.includes('text/event-stream')) {
      throw new Error(
        `expected content-type text/event-stream, got ${res.headers.get('content-type')}`,
      );
    }

    const events: StreamedEvent[] = [];
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });

        let split = buffer.indexOf('\n\n');
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          split = buffer.indexOf('\n\n');

          let sseId = Number.NaN;
          const dataLines: string[] = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('id:')) sseId = Number.parseInt(line.slice(3).trim(), 10);
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
            // ':' comment lines (keep-alives) are ignored, as a client must.
          }
          if (dataLines.length === 0) continue;

          const envelope = JSON.parse(dataLines.join('\n')) as {
            id: number;
            type: string;
            payload: unknown;
          };
          events.push({ sseId, id: envelope.id, type: envelope.type, payload: envelope.payload });
        }
      }
    } catch (err) {
      // Aborting the read is how this function ends; it is not a failure.
      if ((err as Error).name !== 'AbortError') throw err;
    }

    return events;
  } catch (err) {
    if ((err as Error).name === 'AbortError') return [];
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

export const runConformance = async (options: RunOptions): Promise<Report> => {
  const base = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 10_000;
  const checks: Check[] = [];

  const pass = (id: string, title: string) =>
    checks.push({ id, title, result: 'pass', detail: null });
  const fail = (id: string, title: string, detail: string) =>
    checks.push({ id, title, result: 'fail', detail });
  const skip = (id: string, title: string, capability: string) =>
    checks.push({
      id,
      title,
      result: 'skip',
      detail: `agent does not declare '${capability}'`,
    });

  const eventsOfBody = (body: unknown): Array<{ id: number; type: string; payload: unknown }> =>
    (body as { events?: Array<{ id: number; type: string; payload: unknown }> })?.events ?? [];

  const request = async (
    path: string,
    init: RequestInit & { auth?: boolean } = {},
  ): Promise<Fetched> => {
    const { auth = true, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (auth) headers.set('authorization', `Bearer ${options.token}`);

    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        ...rest,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Unreachable(`${path}: ${(err as Error).message}`);
    }

    const raw = await res.text();
    let body: unknown = null;
    try {
      body = raw.length > 0 ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    return {
      status: res.status,
      body,
      raw,
      contentType: res.headers.get('content-type') ?? '',
    };
  };

  const ajv = new Ajv2020({ strict: true, allErrors: true });
  // format: uuid / date-time appear in the v1 schemas; ajv throws without this.
  addFormats(ajv);
  // outbox-page $refs event-envelope by absolute $id. Registering first resolves it
  // locally instead of fetching the (deliberately unpublished) $id URL.
  ajv.addSchema(readSchema('event-envelope'));
  const validateManifest = compile(ajv, 'manifest');
  const validateHealth = compile(ajv, 'health');
  const validateError = compile(ajv, 'error');
  const validateOutboxPage = compile(ajv, 'outbox-page');
  const validateAssistantReply = compile(ajv, 'assistant-reply');
  const validateUploadResponse = compile(ajv, 'upload-response');

  // ---------------------------------------------------------------------------
  // Manifest first. ADR-0006 makes the run manifest-driven, so a malformed manifest
  // fails early and loudly rather than producing a misleading partial report.
  // ---------------------------------------------------------------------------
  let capabilities: string[] = [];

  try {
    const res = await request('/app/v1/manifest');
    if (res.status !== 200) {
      fail(
        'manifest.ok',
        'GET /manifest returns 200',
        `expected 200, got ${res.status}; body: ${res.raw.slice(0, 200)}`,
      );
    } else if (!validateManifest(res.body)) {
      fail(
        'manifest.ok',
        'GET /manifest returns 200',
        `200 but body violates manifest.json: ${describeErrors(validateManifest)}`,
      );
    } else {
      pass('manifest.ok', 'GET /manifest returns 200');
      const manifest = res.body as {
        contract?: { name?: string; version?: number };
        capabilities?: string[];
      };
      capabilities = manifest.capabilities ?? [];

      if (manifest.contract?.name === 'app-ingress' && manifest.contract?.version === 1) {
        pass('manifest.contract', 'Manifest declares app-ingress v1');
      } else {
        fail(
          'manifest.contract',
          'Manifest declares app-ingress v1',
          `expected contract {name:"app-ingress",version:1}, got ${JSON.stringify(manifest.contract)}`,
        );
      }

      if (capabilities.includes('chat')) {
        pass('manifest.capabilities.chat', "Manifest declares the mandatory 'chat' capability");
      } else {
        fail(
          'manifest.capabilities.chat',
          "Manifest declares the mandatory 'chat' capability",
          `every conforming agent MUST declare 'chat'; got ${JSON.stringify(capabilities)}`,
        );
      }
    }

    // -------------------------------------------------------------------------
    // Auth. Invariant 1: bearer on every route, fail closed, 401 before routing.
    // -------------------------------------------------------------------------
    const noToken = await request('/app/v1/health', { auth: false });
    if (noToken.status === 401) {
      pass('health.auth.401', 'GET /health without a token returns 401');
    } else {
      fail(
        'health.auth.401',
        'GET /health without a token returns 401',
        `expected 401, got ${noToken.status}. Auth must fail closed on every route.`,
      );
    }

    const badToken = await request('/app/v1/health', {
      auth: false,
      headers: { authorization: 'Bearer definitely-not-the-token' },
    });
    if (badToken.status === 401) {
      pass('health.auth.badtoken.401', 'GET /health with a wrong token returns 401');
    } else {
      fail(
        'health.auth.badtoken.401',
        'GET /health with a wrong token returns 401',
        `expected 401, got ${badToken.status}. An unrecognized token must be rejected, not ignored.`,
      );
    }

    // 401 precedes 404: the route surface must not be enumerable without a token.
    const unauthUnknown = await request('/app/v1/uploads', { auth: false, method: 'POST' });
    if (unauthUnknown.status === 401) {
      pass('auth.precedes.404', 'Unauthenticated request to a gated route returns 401, not 404');
    } else {
      fail(
        'auth.precedes.404',
        'Unauthenticated request to a gated route returns 401, not 404',
        `expected 401, got ${unauthUnknown.status}. Auth is evaluated before routing, so an ` +
          'unauthenticated caller cannot discover which routes exist.',
      );
    }

    // -------------------------------------------------------------------------
    // Health (core).
    // -------------------------------------------------------------------------
    const health = await request('/app/v1/health');
    if (health.status !== 200) {
      fail(
        'health.ok',
        'GET /health returns 200',
        `expected 200, got ${health.status}; body: ${health.raw.slice(0, 200)}`,
      );
    } else if (!validateHealth(health.body)) {
      fail(
        'health.ok',
        'GET /health returns 200',
        `200 but body violates health.json: ${describeErrors(validateHealth)}`,
      );
    } else {
      pass('health.ok', 'GET /health returns 200');
    }

    // -------------------------------------------------------------------------
    // Capability gating (ADR-0006). Declaring is binding; not declaring means the
    // route must 404 — answering anyway makes the manifest a lie.
    // -------------------------------------------------------------------------
    if (capabilities.includes('files')) {
      // Build the multipart body by hand rather than sharing a helper with the mock
      // (ADR-0005 rule 1) — a shared encoder would hide a framing bug from both sides.
      const boundary = `----conformance${crypto.randomUUID()}`;
      const fileBody = `conformance-probe-${crypto.randomUUID()}`;
      const multipart = [
        `--${boundary}`,
        'content-disposition: form-data; name="file"; filename="probe.txt"',
        'content-type: text/plain',
        '',
        fileBody,
        `--${boundary}--`,
        '',
      ].join('\r\n');

      const upload = await request('/app/v1/uploads', {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: multipart,
      });

      let uploadId: string | null = null;

      if (upload.status === 404) {
        fail(
          'files.upload.201',
          'POST /uploads returns 201 with a valid upload-response',
          "the manifest declares 'files', so /app/v1/uploads must not 404. Either serve " +
            'the route or stop declaring the capability — declaring is binding (ADR-0006).',
        );
      } else if (upload.status === 501) {
        fail(
          'files.upload.201',
          'POST /uploads returns 201 with a valid upload-response',
          "the manifest declares 'files' but /app/v1/uploads answers 501 Not Implemented. " +
            'A declared capability must be served, not merely routed.',
        );
      } else if (upload.status !== 201) {
        fail(
          'files.upload.201',
          'POST /uploads returns 201 with a valid upload-response',
          `expected 201 Created, got ${upload.status}. The contract sets 201 explicitly ` +
            `and the harness asserts it exactly. Body: ${upload.raw.slice(0, 200)}`,
        );
      } else if (!validateUploadResponse(upload.body)) {
        fail(
          'files.upload.201',
          'POST /uploads returns 201 with a valid upload-response',
          `201 but body violates upload-response.json: ${describeErrors(validateUploadResponse)}`,
        );
      } else {
        pass('files.upload.201', 'POST /uploads returns 201 with a valid upload-response');
        uploadId = (upload.body as { uploadId: string }).uploadId;
      }

      // An unknown file id must 404 with the error shape — not 200 with an empty body,
      // and not a framework default.
      const missing = await request(`/app/v1/files/definitely-not-a-file-${crypto.randomUUID()}`);
      if (missing.status === 404 && validateError(missing.body)) {
        pass('files.download.404', 'GET /files/<unknown> returns 404 with the error shape');
      } else {
        fail(
          'files.download.404',
          'GET /files/<unknown> returns 404 with the error shape',
          `expected 404 with an error body, got ${missing.status} ` +
            `and ${missing.raw.slice(0, 200)}`,
        );
      }

      // The round trip a real client performs: upload, reference it in a message,
      // receive it back on the reply, download it. Each leg is meaningless alone.
      if (uploadId === null) {
        // NOT a skip. The agent declared `files`, so the round trip is required, and
        // reporting "skip" here would hide a real failure behind a status that means
        // "legitimately opted out" (ADR-0006). Declaring is binding.
        fail(
          'files.roundtrip',
          'An uploaded file survives message -> reply -> download intact',
          "the manifest declares 'files' but the upload leg did not return an uploadId, so " +
            'the round trip cannot even begin. See the files.upload.201 failure above.',
        );
      } else if (options.personId === undefined) {
        // A genuine harness-input gap rather than an agent property: without the owner
        // id no message can be accepted to carry the attachment.
        checks.push({
          id: 'files.roundtrip',
          title: 'An uploaded file survives message -> reply -> download intact',
          result: 'skip',
          detail: 'no --person-id supplied, so no message can be accepted to carry the attachment',
        });
      } else {
        const messageId = crypto.randomUUID();
        const cursor = eventsOfBody((await request('/app/v1/outbox')).body).at(-1)?.id ?? 0;
        await request('/app/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            schema: 1,
            messageId,
            personId: options.personId,
            text: 'conformance: attachment round trip',
            attachments: [uploadId],
            receivedAt: new Date().toISOString(),
          }),
        });

        const deadline = Date.now() + timeoutMs;
        let reply: { payload: unknown } | undefined;
        while (reply === undefined && Date.now() < deadline) {
          const page = eventsOfBody((await request(`/app/v1/outbox?after=${cursor}`)).body);
          reply = page.find((e) => e.type === 'reply');
          if (reply === undefined) await new Promise((r) => setTimeout(r, 50));
        }

        const replyFiles = (reply?.payload as { files?: string[] } | undefined)?.files ?? [];
        if (reply === undefined) {
          fail(
            'files.roundtrip',
            'An uploaded file survives message -> reply -> download intact',
            `no reply event arrived within ${timeoutMs}ms to carry the attachment back`,
          );
        } else if (!replyFiles.includes(uploadId)) {
          fail(
            'files.roundtrip',
            'An uploaded file survives message -> reply -> download intact',
            `the reply did not reference the uploaded file. Sent attachment ` +
              `${JSON.stringify(uploadId)}, reply.files was ${JSON.stringify(replyFiles)}. ` +
              'An agent declaring `files` must serve every id it emits.',
          );
        } else {
          const download = await request(`/app/v1/files/${encodeURIComponent(uploadId)}`);
          if (download.status !== 200) {
            fail(
              'files.roundtrip',
              'An uploaded file survives message -> reply -> download intact',
              `GET /files/${uploadId} returned ${download.status}; an agent must serve ` +
                'every file id it emits in assistant-reply.files.',
            );
          } else if (download.raw !== fileBody) {
            fail(
              'files.roundtrip',
              'An uploaded file survives message -> reply -> download intact',
              `downloaded bytes differ from what was uploaded. Sent ${JSON.stringify(fileBody)}, ` +
                `got ${JSON.stringify(download.raw.slice(0, 100))}.`,
            );
          } else {
            pass(
              'files.roundtrip',
              'An uploaded file survives message -> reply -> download intact',
            );
          }
        }
      }
    } else {
      skip('files.upload.201', 'POST /uploads returns 201 with a valid upload-response', 'files');
      skip('files.download.404', 'GET /files/<unknown> returns 404 with the error shape', 'files');
      skip(
        'files.roundtrip',
        'An uploaded file survives message -> reply -> download intact',
        'files',
      );

      const uploads = await request('/app/v1/uploads', { method: 'POST' });
      if (uploads.status === 404) {
        pass('files.undeclared.404', 'POST /uploads returns 404 when files is undeclared');
      } else {
        fail(
          'files.undeclared.404',
          'POST /uploads returns 404 when files is undeclared',
          `expected 404, got ${uploads.status}. The manifest does not declare 'files', so ` +
            'answering this route would make the manifest a lie and would hide working ' +
            'functionality from a capability-adaptive client (ADR-0006).',
        );
      }
    }

    // -------------------------------------------------------------------------
    // MCP (gated by mcp-tools and/or mcp-apps-ui). The two capabilities gate
    // DIFFERENT halves of the same endpoint, so they are checked independently.
    // -------------------------------------------------------------------------
    const rpc = async (method: string, params?: unknown): Promise<Fetched> =>
      request('/app/v1/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          ...(params === undefined ? {} : { params }),
        }),
      });

    const rpcResult = (res: Fetched): Record<string, unknown> | null => {
      const body = res.body as { result?: Record<string, unknown> } | null;
      return body?.result ?? null;
    };

    const declaresMcp = capabilities.includes('mcp-tools') || capabilities.includes('mcp-apps-ui');

    if (!declaresMcp) {
      skip('mcp.initialize', 'POST /mcp completes an MCP initialize handshake', 'mcp-tools');
      skip('mcp.tools', 'tools/list and tools/call work', 'mcp-tools');
      skip('mcp.ui', 'A ui:// resource is listed and readable as text/html', 'mcp-apps-ui');

      const mcp = await rpc('initialize');
      if (mcp.status === 404) {
        pass('mcp.undeclared.404', 'POST /mcp returns 404 when no MCP capability is declared');
      } else {
        fail(
          'mcp.undeclared.404',
          'POST /mcp returns 404 when no MCP capability is declared',
          `expected 404, got ${mcp.status}. Answering an endpoint the manifest does not ` +
            'claim makes the manifest a lie (ADR-0006).',
        );
      }
    } else {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
      const initResult = rpcResult(init);
      // The contract pins NO protocol version, so this asserts the handshake completed
      // and named a version — never which version.
      if (init.status === 200 && typeof initResult?.protocolVersion === 'string') {
        pass('mcp.initialize', 'POST /mcp completes an MCP initialize handshake');
      } else {
        fail(
          'mcp.initialize',
          'POST /mcp completes an MCP initialize handshake',
          `expected 200 with result.protocolVersion, got ${init.status} and ` +
            `${init.raw.slice(0, 200)}. The contract does not pin a protocol version; it ` +
            'requires only that initialize succeeds and names one.',
        );
      }

      if (capabilities.includes('mcp-tools')) {
        const list = rpcResult(await rpc('tools/list'));
        const tools = (list?.tools ?? []) as Array<{ name?: string }>;
        if (!Array.isArray(tools) || tools.length === 0) {
          fail(
            'mcp.tools',
            'tools/list and tools/call work',
            "the manifest declares 'mcp-tools', so tools/list must return at least one " +
              `tool. Got ${JSON.stringify(list)}`,
          );
        } else {
          const first = tools[0]?.name;
          const called = await rpc('tools/call', { name: first, arguments: {} });
          const callResult = rpcResult(called);
          if (called.status === 200 && Array.isArray(callResult?.content)) {
            pass('mcp.tools', 'tools/list and tools/call work');
          } else {
            fail(
              'mcp.tools',
              'tools/list and tools/call work',
              `tools/call on the first advertised tool (${String(first)}) did not return ` +
                `a content array. Got ${called.raw.slice(0, 200)}. A listed tool must be callable.`,
            );
          }
        }
      } else {
        skip('mcp.tools', 'tools/list and tools/call work', 'mcp-tools');
      }

      if (capabilities.includes('mcp-apps-ui')) {
        const list = rpcResult(await rpc('resources/list'));
        const resources = (list?.resources ?? []) as Array<{ uri?: string }>;
        const ui = resources.find((r) => r.uri?.startsWith('ui://'));
        if (ui?.uri === undefined) {
          fail(
            'mcp.ui',
            'A ui:// resource is listed and readable as text/html',
            "the manifest declares 'mcp-apps-ui', so resources/list must advertise at " +
              `least one ui:// resource. Got ${JSON.stringify(resources)}`,
          );
        } else {
          const read = rpcResult(await rpc('resources/read', { uri: ui.uri }));
          const contents = (read?.contents ?? []) as Array<{ mimeType?: string; text?: string }>;
          const html = contents.find((c) => c.mimeType === 'text/html');
          if (html?.text !== undefined && html.text.length > 0) {
            pass('mcp.ui', 'A ui:// resource is listed and readable as text/html');
          } else {
            fail(
              'mcp.ui',
              'A ui:// resource is listed and readable as text/html',
              `reading ${ui.uri} did not return text/html contents. MCP Apps resources are ` +
                `text/html by definition. Got ${JSON.stringify(contents).slice(0, 200)}`,
            );
          }
        }
      } else {
        skip('mcp.ui', 'A ui:// resource is listed and readable as text/html', 'mcp-apps-ui');
      }
    }

    // -------------------------------------------------------------------------
    // Error shape (invariant 6). Checked on the 401 above, because that is the one
    // error every conforming agent must be able to produce on demand.
    // -------------------------------------------------------------------------
    if (validateError(noToken.body)) {
      pass('error.shape', 'A 401 body uses the error shape');
    } else {
      fail(
        'error.shape',
        'A 401 body uses the error shape',
        `401 body violates error.json: ${describeErrors(validateError)}. Every non-2xx ` +
          'body uses the single error shape — never a bare string, an HTML page, or a ' +
          `framework default. Got: ${noToken.raw.slice(0, 200)}`,
      );
    }

    // -------------------------------------------------------------------------
    // Chat triad (core): messages -> events/outbox.
    // -------------------------------------------------------------------------
    const outboxPage = async (after?: number): Promise<Fetched> =>
      request(after === undefined ? '/app/v1/outbox' : `/app/v1/outbox?after=${after}`);

    const eventsOf = eventsOfBody;

    const firstPage = await outboxPage();
    if (firstPage.status !== 200) {
      fail(
        'outbox.ok',
        'GET /outbox returns 200 and a valid outbox-page',
        `expected 200, got ${firstPage.status}; body: ${firstPage.raw.slice(0, 200)}`,
      );
    } else if (!validateOutboxPage(firstPage.body)) {
      fail(
        'outbox.ok',
        'GET /outbox returns 200 and a valid outbox-page',
        `200 but body violates outbox-page.json: ${describeErrors(validateOutboxPage)}`,
      );
    } else {
      pass('outbox.ok', 'GET /outbox returns 200 and a valid outbox-page');
    }

    // An invalid cursor must be refused, not silently treated as 0 — a client that
    // sends a corrupt cursor would otherwise be handed the whole history again.
    const badCursor = await request('/app/v1/outbox?after=not-a-number');
    if (badCursor.status === 400) {
      pass('outbox.cursor.invalid', 'GET /outbox rejects a non-integer cursor with 400');
    } else {
      fail(
        'outbox.cursor.invalid',
        'GET /outbox rejects a non-integer cursor with 400',
        `expected 400, got ${badCursor.status}. A malformed cursor must be refused, not ` +
          'silently coerced to 0 and answered with the entire history.',
      );
    }

    // personId that is not the owner MUST be refused (invariant 4). This check needs
    // no configured owner id: an id this random is not anyone's owner.
    const notOwner = await request('/app/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: 1,
        messageId: crypto.randomUUID(),
        personId: `not-the-owner-${crypto.randomUUID()}`,
        text: 'conformance: personId check',
        attachments: [],
        receivedAt: new Date().toISOString(),
      }),
    });
    if (notOwner.status === 403) {
      pass('messages.notowner.403', 'POST /messages with a foreign personId returns 403');
    } else {
      fail(
        'messages.notowner.403',
        'POST /messages with a foreign personId returns 403',
        `expected 403, got ${notOwner.status}. Invariant 4: an agent MUST validate that ` +
          'personId equals its configured owner id and reject mismatches.',
      );
    }

    const malformed = await request('/app/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema: 1, text: 'missing everything else' }),
    });
    if (malformed.status === 400) {
      pass('messages.invalid.400', 'POST /messages with a malformed body returns 400');
    } else {
      fail(
        'messages.invalid.400',
        'POST /messages with a malformed body returns 400',
        `expected 400, got ${malformed.status}. A body that does not match ` +
          'inbound-message.json must be refused.',
      );
    }

    const chatIds = [
      'messages.202',
      'messages.dedup',
      'outbox.ack',
      'outbox.reply',
      'cursor.equivalence',
    ] as const;
    const chatTitles: Record<(typeof chatIds)[number], string> = {
      'messages.202': 'POST /messages returns 202 and echoes the messageId',
      'messages.dedup': 'Re-POSTing a messageId emits no additional events',
      'outbox.ack': 'An accepted message produces an ack event',
      'outbox.reply': 'A reply event arrives carrying a valid assistant-reply',
      'cursor.equivalence': 'Last-Event-ID and ?after= yield the same events (invariant 2)',
    };

    if (options.personId === undefined) {
      // Not a failure of the agent. The owner id is configured out of band, exactly
      // like the token, and the harness was not given it.
      for (const id of chatIds) {
        checks.push({
          id,
          title: chatTitles[id],
          result: 'skip',
          detail:
            'no --person-id supplied. Invariant 4 requires personId to equal the agent’s ' +
            'configured owner id, and the contract defines no way to discover it over the ' +
            'wire — supply it to exercise the chat triad.',
        });
      }
    } else {
      const before = eventsOf((await outboxPage()).body);
      const cursorBefore = before.length > 0 ? (before[before.length - 1]?.id ?? 0) : 0;

      const messageId = crypto.randomUUID();
      const post = async () =>
        request('/app/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            schema: 1,
            messageId,
            personId: options.personId,
            text: 'conformance probe',
            attachments: [],
            receivedAt: new Date().toISOString(),
          }),
        });

      const accepted = await post();
      const acceptedBody = accepted.body as { ok?: boolean; messageId?: string };
      if (accepted.status !== 202) {
        fail(
          'messages.202',
          chatTitles['messages.202'],
          `expected 202, got ${accepted.status}; body: ${accepted.raw.slice(0, 200)}. The reply ` +
            'is never returned on this response — it arrives later as a reply event.',
        );
      } else if (acceptedBody.messageId !== messageId) {
        fail(
          'messages.202',
          chatTitles['messages.202'],
          `202 but body echoed messageId ${JSON.stringify(acceptedBody.messageId)}, expected ` +
            `${JSON.stringify(messageId)}.`,
        );
      } else {
        pass('messages.202', chatTitles['messages.202']);
      }

      // Poll for the reply. The contract makes acceptance asynchronous, so a fixed
      // sleep would be either flaky or needlessly slow (ADR-0005).
      const deadline = Date.now() + timeoutMs;
      let after = eventsOf((await outboxPage(cursorBefore)).body);
      while (!after.some((e) => e.type === 'reply') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        after = eventsOf((await outboxPage(cursorBefore)).body);
      }

      const ack = after.find((e) => e.type === 'ack');
      if (ack) {
        pass('outbox.ack', chatTitles['outbox.ack']);
      } else {
        fail(
          'outbox.ack',
          chatTitles['outbox.ack'],
          `no ack event appeared after the message was accepted. Got types: ` +
            `${JSON.stringify(after.map((e) => e.type))}`,
        );
      }

      const reply = after.find((e) => e.type === 'reply');
      if (!reply) {
        fail(
          'outbox.reply',
          chatTitles['outbox.reply'],
          `no reply event within ${timeoutMs}ms. Got types: ` +
            `${JSON.stringify(after.map((e) => e.type))}`,
        );
      } else if (!validateAssistantReply(reply.payload)) {
        fail(
          'outbox.reply',
          chatTitles['outbox.reply'],
          `reply payload violates assistant-reply.json: ${describeErrors(validateAssistantReply)}`,
        );
      } else {
        pass('outbox.reply', chatTitles['outbox.reply']);
      }

      // Dedup: re-POST the same id. No new events may appear (invariant 5).
      const countBeforeRepost = eventsOf((await outboxPage()).body).length;
      const repost = await post();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const countAfterRepost = eventsOf((await outboxPage()).body).length;
      if (repost.status !== 202) {
        fail(
          'messages.dedup',
          chatTitles['messages.dedup'],
          `re-POST returned ${repost.status}, expected 202. A duplicate is a no-op that ` +
            'returns 202 again, not an error.',
        );
      } else if (countAfterRepost !== countBeforeRepost) {
        fail(
          'messages.dedup',
          chatTitles['messages.dedup'],
          `re-POSTing the same messageId added ${countAfterRepost - countBeforeRepost} event(s). ` +
            'Delivery is effectively-once at the agent: a client that retries on a timeout ' +
            'must not be able to duplicate a conversation turn.',
        );
      } else {
        pass('messages.dedup', chatTitles['messages.dedup']);
      }

      // -----------------------------------------------------------------------
      // Invariant 2, the one that makes live and catch-up interchangeable:
      // Last-Event-ID: n over SSE MUST yield exactly what ?after=n yields.
      // -----------------------------------------------------------------------
      try {
        const streamed = await readSse(`${base}/app/v1/events`, options.token, cursorBefore, 2000);
        const paged = eventsOf((await outboxPage(cursorBefore)).body);

        const streamedIds = streamed.map((e) => e.id);
        const pagedIds = paged.map((e) => e.id);

        if (streamed.some((e) => e.sseId !== e.id)) {
          fail(
            'cursor.equivalence',
            chatTitles['cursor.equivalence'],
            'the SSE `id:` field does not equal the envelope id. They are the same cursor ' +
              `(invariant 2). Got: ${JSON.stringify(streamed.map((e) => [e.sseId, e.id]))}`,
          );
        } else if (JSON.stringify(streamedIds) !== JSON.stringify(pagedIds)) {
          fail(
            'cursor.equivalence',
            chatTitles['cursor.equivalence'],
            `resuming with Last-Event-ID: ${cursorBefore} yielded ids ` +
              `${JSON.stringify(streamedIds)} but GET /outbox?after=${cursorBefore} yielded ` +
              `${JSON.stringify(pagedIds)}. These must match exactly, in order — that ` +
              'equivalence is what lets a client switch between live and catch-up without ' +
              'reconciliation logic.',
          );
        } else {
          pass('cursor.equivalence', chatTitles['cursor.equivalence']);
        }
      } catch (err) {
        fail(
          'cursor.equivalence',
          chatTitles['cursor.equivalence'],
          `could not read the SSE stream: ${(err as Error).message}`,
        );
      }
    }
  } catch (err) {
    if (err instanceof Unreachable) {
      return buildReport(
        base,
        checks,
        { contractVersion: '1', harnessVersion: options.harnessVersion ?? '0.1.0' },
        true,
      );
    }
    throw err;
  }

  return buildReport(base, checks, {
    contractVersion: '1',
    harnessVersion: options.harnessVersion ?? '0.1.0',
  });
};

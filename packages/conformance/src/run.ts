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
import { buildReport, type Check, type Report } from './report.js';

const SCHEMA_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'schemas', 'v1');

const compile = (ajv: Ajv2020, name: string): ValidateFunction =>
  ajv.compile(JSON.parse(readFileSync(join(SCHEMA_DIR, `${name}.json`), 'utf8')));

export interface RunOptions {
  baseUrl: string;
  token: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  harnessVersion?: string;
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
  const validateManifest = compile(ajv, 'manifest');
  const validateHealth = compile(ajv, 'health');

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
      const uploads = await request('/app/v1/uploads', { method: 'POST' });
      // Both 404 and 501 mean the route is not actually served. They are checked
      // separately because they say different things about the agent, and a detail
      // that names the wrong cause sends the implementer down the wrong path.
      if (uploads.status === 404) {
        fail(
          'files.uploads.served',
          'POST /uploads is served when files is declared',
          "the manifest declares 'files', so /app/v1/uploads must not 404. Either serve " +
            'the route or stop declaring the capability — declaring is binding (ADR-0006).',
        );
      } else if (uploads.status === 501) {
        fail(
          'files.uploads.served',
          'POST /uploads is served when files is declared',
          "the manifest declares 'files' but /app/v1/uploads answers 501 Not Implemented. " +
            'A declared capability must be served, not merely routed.',
        );
      } else {
        pass('files.uploads.served', 'POST /uploads is served when files is declared');
      }
    } else {
      skip('files.uploads.served', 'POST /uploads is served when files is declared', 'files');

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

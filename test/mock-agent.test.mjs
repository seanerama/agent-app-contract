/**
 * Unit tests for the reference agent's auth and capability-gating behavior.
 *
 * These assert the frozen invariants in contracts/app-ingress.md directly, at a
 * finer grain than the harness can — in particular the ordering rules (auth before
 * routing, 401 before 404) that are invisible from a passing conformance run.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, describe, it } from 'node:test';
import { createMockAgent } from '../packages/mock-agent/dist/index.js';

const TOKEN = 'unit-test-token';

const startAgent = async (capabilities = []) => {
  const server = createMockAgent({ token: TOKEN, capabilities });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const auth = { authorization: `Bearer ${TOKEN}` };

describe('mock-agent: authentication (contract invariant 1)', () => {
  let agent;
  before(async () => {
    agent = await startAgent();
  });
  after(() => agent.close());

  it('rejects a request with no Authorization header', async () => {
    const res = await fetch(`${agent.base}/app/v1/health`);
    assert.equal(res.status, 401);
  });

  it('rejects a malformed Authorization header', async () => {
    const res = await fetch(`${agent.base}/app/v1/health`, {
      headers: { authorization: TOKEN }, // missing the "Bearer " prefix
    });
    assert.equal(res.status, 401);
  });

  it('rejects an unrecognized token', async () => {
    const res = await fetch(`${agent.base}/app/v1/health`, {
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(res.status, 401);
  });

  it('requires auth on /manifest too — there is no anonymous route', async () => {
    const res = await fetch(`${agent.base}/app/v1/manifest`);
    assert.equal(res.status, 401);
  });

  it('returns the single error shape on 401, not a bare string or HTML', async () => {
    // schemas/v1/error.json: { ok: false, error: string, code?: string }. Reused from
    // the sibling control-api contract rather than invented — before the spec stage
    // this mock emitted a nested { schema, error: { code, message } } of its own
    // devising, which nothing else in the system spoke.
    const res = await fetch(`${agent.base}/app/v1/health`);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(typeof body.error, 'string');
    assert.ok(body.error.length > 0);
  });

  it('evaluates auth BEFORE routing: 401 wins over 404 on an unknown route', async () => {
    const res = await fetch(`${agent.base}/app/v1/nonexistent-route`);
    assert.equal(res.status, 401, 'the route surface must not be enumerable without a token');
  });

  it('evaluates auth BEFORE gating: 401 wins over 404 on an undeclared route', async () => {
    const res = await fetch(`${agent.base}/app/v1/uploads`, { method: 'POST' });
    assert.equal(res.status, 401);
  });
});

describe('mock-agent: core routes', () => {
  let agent;
  before(async () => {
    agent = await startAgent();
  });
  after(() => agent.close());

  it('serves health with the contracted shape', async () => {
    const res = await fetch(`${agent.base}/app/v1/health`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, 'string');
    assert.equal(typeof body.uptimeSec, 'number');
    assert.ok(body.uptimeSec >= 0);
  });

  it('serves a manifest declaring app-ingress v1 and the mandatory chat capability', async () => {
    const res = await fetch(`${agent.base}/app/v1/manifest`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.schema, 1);
    assert.deepEqual(body.contract, { name: 'app-ingress', version: 1 });
    assert.ok(body.capabilities.includes('chat'), 'chat is mandatory for every agent');
  });

  it('serves the outbox as a cursor-paged page of envelopes', async () => {
    const res = await fetch(`${agent.base}/app/v1/outbox`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.schema, 1);
    assert.ok(Array.isArray(body.events));
  });

  it('rejects a malformed cursor rather than silently replaying everything', async () => {
    const res = await fetch(`${agent.base}/app/v1/outbox?after=banana`, { headers: auth });
    assert.equal(res.status, 400);
  });

  it('answers 501 — not 404 — for a core route it has not implemented yet', async () => {
    // 404 would claim the capability is undeclared. Core routes have no capability,
    // so 404 there would be a lie about why the route is absent. /mcp is gated, so
    // the honest 501 case is a core route; none remain unimplemented, which is why
    // this asserts the rule on the mock's own fallback rather than a live route.
    const res = await fetch(`${agent.base}/app/v1/messages`, { method: 'PATCH', headers: auth });
    assert.equal(res.status, 501);
  });
});

describe('mock-agent: capability gating (ADR-0006)', () => {
  it('404s a gated route when its capability is undeclared', async () => {
    const agent = await startAgent();
    try {
      const res = await fetch(`${agent.base}/app/v1/uploads`, { method: 'POST', headers: auth });
      assert.equal(res.status, 404);
    } finally {
      await agent.close();
    }
  });

  it('stops 404ing that route once the capability IS declared', async () => {
    // 404 is reserved for "undeclared". Once files is declared the route must stop
    // 404ing; this mock has not built uploads yet, so it says 501 — honestly
    // non-conforming, and distinguishable from correct gating. The harness treats
    // that 501 as a failure, which is what loop scenario 2 proves.
    const agent = await startAgent(['files']);
    try {
      const res = await fetch(`${agent.base}/app/v1/uploads`, { method: 'POST', headers: auth });
      assert.equal(res.status, 501, 'declaring a capability is binding (ADR-0006)');
    } finally {
      await agent.close();
    }
  });

  it('always declares chat, even when the caller passes none', async () => {
    const agent = await startAgent([]);
    try {
      const res = await fetch(`${agent.base}/app/v1/manifest`, { headers: auth });
      const body = await res.json();
      assert.deepEqual(body.capabilities, ['chat']);
    } finally {
      await agent.close();
    }
  });

  it('never duplicates chat when the caller passes it explicitly', async () => {
    const agent = await startAgent(['chat', 'files']);
    try {
      const res = await fetch(`${agent.base}/app/v1/manifest`, { headers: auth });
      const body = await res.json();
      assert.deepEqual(body.capabilities, ['chat', 'files']);
    } finally {
      await agent.close();
    }
  });

  it('gates /mcp on EITHER mcp capability, not both', async () => {
    const agent = await startAgent(['mcp-apps-ui']);
    try {
      const res = await fetch(`${agent.base}/app/v1/mcp`, { method: 'POST', headers: auth });
      assert.equal(res.status, 501, 'declared via mcp-apps-ui alone, so it must not 404');
    } finally {
      await agent.close();
    }
  });

  it('404s /mcp when neither mcp capability is declared', async () => {
    const agent = await startAgent(['files']);
    try {
      const res = await fetch(`${agent.base}/app/v1/mcp`, { method: 'POST', headers: auth });
      assert.equal(res.status, 404);
    } finally {
      await agent.close();
    }
  });
});

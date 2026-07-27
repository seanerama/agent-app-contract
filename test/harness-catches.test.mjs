/**
 * Does the harness actually CATCH a non-conforming agent?
 *
 * ADR-0005 rule 3: no gate is added in a form that cannot fail. The self-proving loop
 * shows the harness passing a conforming agent, which proves only that it does not
 * produce false negatives. These tests are the other half — one deliberately broken
 * agent per invariant, asserting the SPECIFIC check that should catch it does.
 *
 * A check that never goes red against a violation is decoration, and the loop it sits
 * in is decoration too. The mock-agent cannot serve this purpose: it is built to
 * conform, so breaking it to test the harness would mean breaking the thing the loop
 * certifies. These fakes are non-conforming on purpose, in exactly one way each.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, describe, it } from 'node:test';
import { runConformance } from '../packages/conformance/dist/index.js';

const TOKEN = 'fake-token';
const OWNER = 'owner-fake';

const servers = [];
after(async () => {
  for (const server of servers) await new Promise((r) => server.close(r));
});

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

/**
 * A minimally conforming agent, with exactly the flaws asked for switched on.
 *
 * `flaws` is a plain object so each test reads as "conforming EXCEPT this one thing".
 */
const startFakeAgent = async (flaws = {}) => {
  const events = [];
  let nextId = 1;
  const seen = new Set();

  const emit = (type, payload) => {
    const event = { schema: 1, id: nextId, type, at: new Date().toISOString(), payload };
    nextId += 1;
    events.push(event);
    return event;
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const authed = req.headers.authorization === `Bearer ${TOKEN}`;

    if (!authed) {
      if (flaws.badErrorShape) {
        // The shape mock-agent invented before the spec existed: nested, and with no
        // `ok` discriminator. Structurally plausible, and wrong.
        json(res, 401, { schema: 1, error: { code: 'unauthorized', message: 'no' } });
      } else {
        json(res, 401, { ok: false, error: 'unauthorized', code: 'unauthorized' });
      }
      return;
    }

    if (path === '/app/v1/manifest') {
      json(res, 200, {
        schema: 1,
        agent: { name: 'fake', version: '0.0.0' },
        contract: { name: 'app-ingress', version: 1 },
        capabilities: ['chat'],
      });
      return;
    }

    if (path === '/app/v1/health') {
      json(res, 200, { ok: true, version: '0.0.0', uptimeSec: 1 });
      return;
    }

    if (path === '/app/v1/messages' && req.method === 'POST') {
      void (async () => {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          json(res, 400, { ok: false, error: 'bad json' });
          return;
        }

        if (typeof body.messageId !== 'string' || typeof body.personId !== 'string') {
          if (flaws.acceptsMalformed) {
            json(res, 202, { ok: true, messageId: body.messageId ?? 'whatever' });
          } else {
            json(res, 400, { ok: false, error: 'does not match inbound-message' });
          }
          return;
        }

        if (body.personId !== OWNER && !flaws.acceptsForeignPerson) {
          json(res, 403, { ok: false, error: 'not the owner' });
          return;
        }

        // Invariant 5: a duplicate must emit nothing further.
        if (!seen.has(body.messageId) || flaws.noDedup) {
          seen.add(body.messageId);
          emit('ack', { messageId: body.messageId });
          emit('reply', { schema: 1, text: 'ok', files: [] });
        }
        json(res, 202, { ok: true, messageId: body.messageId });
      })();
      return;
    }

    if (path === '/app/v1/outbox') {
      const afterParam = url.searchParams.get('after');
      if (afterParam !== null && !/^\d+$/.test(afterParam)) {
        json(res, 400, { ok: false, error: 'bad cursor' });
        return;
      }
      const cursor = afterParam === null ? 0 : Number.parseInt(afterParam, 10);
      json(res, 200, { schema: 1, events: events.filter((e) => e.id > cursor) });
      return;
    }

    if (path === '/app/v1/events') {
      const last = Number.parseInt(req.headers['last-event-id'] ?? '0', 10) || 0;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      });

      let streamed = events.filter((e) => e.id > last);
      // Invariant 2 violation: live and catch-up disagree. A client switching between
      // them would silently lose a turn.
      if (flaws.sseDropsAnEvent) streamed = streamed.slice(1);

      for (const event of streamed) {
        // Invariant 2 violation: the SSE id and the envelope id are the same cursor.
        const sseId = flaws.sseIdMismatch ? event.id + 1000 : event.id;
        res.write(`id: ${sseId}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
      return;
    }

    json(res, 404, { ok: false, error: 'no such route' });
  });

  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
};

const runAgainst = async (flaws) => {
  const baseUrl = await startFakeAgent(flaws);
  return runConformance({ baseUrl, token: TOKEN, personId: OWNER, timeoutMs: 3000 });
};

const checkNamed = (report, id) => {
  const found = report.checks.find((c) => c.id === id);
  assert.ok(found, `expected the report to contain a check named ${id}`);
  return found;
};

describe('the harness catches a non-conforming agent', () => {
  it('passes the baseline fake, so every failure below is caused by its flaw alone', async () => {
    const report = await runAgainst({});
    const failed = report.checks.filter((c) => c.result === 'fail');
    assert.deepEqual(
      failed.map((c) => c.id),
      [],
      `baseline fake should be conforming; failures: ${JSON.stringify(failed, null, 2)}`,
    );
    assert.equal(report.result, 'pass');
  });

  it('catches an error body that is not the contract error shape (invariant 6)', async () => {
    const report = await runAgainst({ badErrorShape: true });
    assert.equal(checkNamed(report, 'error.shape').result, 'fail');
    assert.equal(report.result, 'fail');
  });

  it('catches an agent that re-runs a duplicated messageId (invariant 5)', async () => {
    const report = await runAgainst({ noDedup: true });
    assert.equal(checkNamed(report, 'messages.dedup').result, 'fail');
    assert.match(checkNamed(report, 'messages.dedup').detail, /event\(s\)/);
  });

  it('catches an SSE id that does not match the envelope id (invariant 2)', async () => {
    const report = await runAgainst({ sseIdMismatch: true });
    assert.equal(checkNamed(report, 'cursor.equivalence').result, 'fail');
  });

  it('catches live and catch-up disagreeing about the same cursor (invariant 2)', async () => {
    const report = await runAgainst({ sseDropsAnEvent: true });
    assert.equal(checkNamed(report, 'cursor.equivalence').result, 'fail');
  });

  it('catches an agent that accepts a foreign personId (invariant 4)', async () => {
    const report = await runAgainst({ acceptsForeignPerson: true });
    assert.equal(checkNamed(report, 'messages.notowner.403').result, 'fail');
  });

  it('catches an agent that accepts a body violating inbound-message', async () => {
    const report = await runAgainst({ acceptsMalformed: true });
    assert.equal(checkNamed(report, 'messages.invalid.400').result, 'fail');
  });
});

/**
 * Unit tests for the harness's frozen output surface: exit-code mapping, skip
 * semantics, and the --json stdout discipline (contracts/conformance-report.md).
 *
 * These matter because downstream CI binds to them. A change here turns another
 * repo's build red for reasons unrelated to that repo.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildReport, EXIT, exitCodeFor } from '../packages/conformance/dist/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'packages', 'conformance', 'dist', 'cli.js');

const versions = { contractVersion: '1', harnessVersion: '0.1.0' };
const check = (id, result) => ({ id, title: id, result, detail: null });

const freePort = async () => {
  const srv = createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
};

const runCli = (args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

describe('conformance: frozen exit codes', () => {
  it('maps an all-pass run to 0', () => {
    const report = buildReport('http://x', [check('a', 'pass')], versions);
    assert.equal(report.result, 'pass');
    assert.equal(exitCodeFor(report), EXIT.PASS);
  });

  it('maps any failure to 1', () => {
    const report = buildReport('http://x', [check('a', 'pass'), check('b', 'fail')], versions);
    assert.equal(report.result, 'fail');
    assert.equal(exitCodeFor(report), EXIT.FAIL);
  });

  it('maps unreachable to 2, distinct from a conformance failure', () => {
    const report = buildReport('http://x', [], versions, true);
    assert.equal(report.result, 'unreachable');
    assert.equal(exitCodeFor(report), EXIT.UNREACHABLE);
  });

  it('holds the frozen numeric values', () => {
    assert.equal(EXIT.PASS, 0);
    assert.equal(EXIT.FAIL, 1);
    assert.equal(EXIT.UNREACHABLE, 2);
  });
});

describe('conformance: skip semantics (ADR-0006)', () => {
  it('does NOT fail a run because of skips — a chat-only agent can be conforming', () => {
    const report = buildReport(
      'http://x',
      [check('core', 'pass'), check('files.x', 'skip'), check('mcp.y', 'skip')],
      versions,
    );
    assert.equal(report.result, 'pass');
    assert.equal(exitCodeFor(report), EXIT.PASS);
  });

  it('counts pass/fail/skip separately', () => {
    const report = buildReport(
      'http://x',
      [check('a', 'pass'), check('b', 'fail'), check('c', 'skip'), check('d', 'pass')],
      versions,
    );
    assert.deepEqual(report.counts, { passed: 2, failed: 1, skipped: 1 });
  });

  it('still fails when a real failure sits alongside skips', () => {
    const report = buildReport('http://x', [check('a', 'fail'), check('b', 'skip')], versions);
    assert.equal(exitCodeFor(report), EXIT.FAIL);
  });
});

describe('conformance: report envelope', () => {
  it('carries the frozen envelope fields', () => {
    const report = buildReport('http://x/', [check('a', 'pass')], versions);
    assert.equal(report.schema, 1);
    assert.equal(report.contract, 'app-ingress');
    assert.equal(report.contractVersion, '1');
    assert.equal(typeof report.harnessVersion, 'string');
    assert.equal(report.target, 'http://x/');
    assert.ok(Array.isArray(report.checks));
  });
});

describe('conformance: CLI discipline', () => {
  it('exits 2 and writes nothing to stdout when the agent is unreachable', async () => {
    const port = await freePort(); // nothing bound
    const { code, stdout } = await runCli([`http://127.0.0.1:${port}`, '--token', 't']);
    assert.equal(code, EXIT.UNREACHABLE);
    assert.equal(stdout, '', 'human mode must keep stdout clean');
  });

  it('emits parseable JSON on stdout under --json, even when unreachable', async () => {
    const port = await freePort();
    const { code, stdout } = await runCli([`http://127.0.0.1:${port}`, '--token', 't', '--json']);
    assert.equal(code, EXIT.UNREACHABLE);
    const report = JSON.parse(stdout); // throws if diagnostics leaked into stdout
    assert.equal(report.result, 'unreachable');
  });

  it('sends diagnostics to stderr, never stdout', async () => {
    const port = await freePort();
    const { stdout, stderr } = await runCli([`http://127.0.0.1:${port}`, '--token', 't', '--json']);
    assert.doesNotThrow(() => JSON.parse(stdout));
    assert.ok(stderr.length >= 0);
  });

  it('exits 2 — not 1 — on CLI misuse, because the agent was never tested', async () => {
    const { code } = await runCli(['--token', 't']); // no url
    assert.equal(code, EXIT.UNREACHABLE);
  });

  it('rejects an unknown option rather than silently ignoring it', async () => {
    const { code, stderr } = await runCli(['http://x', '--token', 't', '--nope']);
    assert.equal(code, EXIT.UNREACHABLE);
    assert.match(stderr, /unknown option/);
  });
});

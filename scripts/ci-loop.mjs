#!/usr/bin/env node
/**
 * The self-proving loop — the repo's core invariant (ADR-0005).
 *
 * Boots the reference agent, waits for it by POLLING /app/v1/health (never by
 * sleeping — a sleep-based wait is the flakiest thing a CI job can contain, and
 * pressure to disable a flaky gate starts immediately), then runs the harness
 * against it and asserts the expected outcome.
 *
 * Three scenarios, because one green run would not exercise the gating rules:
 *
 *   1. chat-only          -> exit 0, and the files checks report `skip`
 *   2. declares files     -> exit 1, because declaring is binding and this mock
 *                            does not serve /uploads yet (ADR-0006)
 *   3. nothing listening  -> exit 2, distinct from a conformance failure
 *
 * Scenario 2 is the important one. Without it, the gating logic would be the one
 * part of the harness the loop never exercises, and "skip" would be indistinguishable
 * from "silently not checked".
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MOCK_CLI = join(ROOT, 'packages', 'mock-agent', 'dist', 'cli.js');
const CONFORMANCE_CLI = join(ROOT, 'packages', 'conformance', 'dist', 'cli.js');

const TOKEN = 'loop-test-token';
const READY_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 100;

let failures = 0;
const problem = (msg) => {
  console.error(`  FAIL ${msg}`);
  failures += 1;
};

/** Poll health until the agent answers. Never sleep-and-hope. */
const waitForReady = async (port) => {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = 'no attempt made';

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/app/v1/health`, {
        headers: { authorization: `Bearer ${TOKEN}` },
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err.message;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`agent not ready within ${READY_TIMEOUT_MS}ms (last: ${lastError})`);
};

const freePort = async () => {
  const { createServer } = await import('node:net');
  const srv = createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
};

const runHarness = (port) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [CONFORMANCE_CLI, `http://127.0.0.1:${port}`, '--token', TOKEN, '--json'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
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

const withMock = async (capabilities, fn) => {
  const port = await freePort();
  const args = [MOCK_CLI, '--port', String(port), '--token', TOKEN];
  if (capabilities.length > 0) args.push('--capabilities', capabilities.join(','));

  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });

  try {
    await waitForReady(port);
    return await fn(port);
  } catch (err) {
    throw new Error(`${err.message}\nmock-agent stderr:\n${stderr}`);
  } finally {
    child.kill('SIGTERM');
  }
};

// ---------------------------------------------------------------------------
console.log('scenario 1: chat-only agent -> conforming, files checks skipped');
await withMock([], async (port) => {
  const { code, stdout, stderr } = await runHarness(port);

  if (code !== 0) problem(`expected exit 0, got ${code}\n${stderr}`);

  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    problem(`--json stdout was not parseable JSON. Got: ${stdout.slice(0, 300)}`);
    return;
  }

  if (report.result !== 'pass') problem(`expected result "pass", got ${report.result}`);
  if (report.counts.skipped < 1)
    problem('expected at least one skipped check for undeclared files');

  const skipped = report.checks.filter((c) => c.result === 'skip');
  if (!skipped.some((c) => c.id.startsWith('files.'))) {
    problem(
      `expected a skipped files.* check, got ${JSON.stringify(report.checks.map((c) => [c.id, c.result]))}`,
    );
  }
  for (const check of skipped) {
    if (!check.detail?.includes('does not declare')) {
      problem(`skip on ${check.id} must say which capability was undeclared, got ${check.detail}`);
    }
  }
  const undeclared404 = report.checks.find((c) => c.id === 'files.undeclared.404');
  if (undeclared404?.result !== 'pass') {
    problem(`expected files.undeclared.404 to pass, got ${undeclared404?.result}`);
  }
  console.log(`  ok — exit 0, ${report.counts.passed} passed, ${report.counts.skipped} skipped`);
});

// ---------------------------------------------------------------------------
console.log('scenario 2: agent declares files it does not serve -> non-conforming');
await withMock(['files'], async (port) => {
  const { code, stdout } = await runHarness(port);

  if (code !== 1) problem(`expected exit 1 (declaring a capability is binding), got ${code}`);

  const report = JSON.parse(stdout);
  if (report.result !== 'fail') problem(`expected result "fail", got ${report.result}`);

  const served = report.checks.find((c) => c.id === 'files.uploads.served');
  if (served?.result !== 'fail') {
    problem(`expected files.uploads.served to FAIL, got ${served?.result}`);
  }
  if (report.checks.some((c) => c.id.startsWith('files.') && c.result === 'skip')) {
    problem('a declared capability must never be reported as skip (ADR-0006)');
  }
  console.log(`  ok — exit 1, declared-but-unserved capability caught`);
});

// ---------------------------------------------------------------------------
console.log('scenario 3: nothing listening -> unreachable, distinct from failure');
{
  const port = await freePort(); // nothing is bound to it
  const { code, stdout } = await runHarness(port);

  if (code !== 2) problem(`expected exit 2 (unreachable), got ${code}`);
  const report = JSON.parse(stdout);
  if (report.result !== 'unreachable')
    problem(`expected result "unreachable", got ${report.result}`);
  console.log('  ok — exit 2, infrastructure fault distinguished from a verdict');
}

if (failures > 0) {
  console.error(`\nself-proving loop FAILED — ${failures} problem(s)`);
  process.exit(1);
}
console.log('\nself-proving loop ok — schema, reference implementation, and harness agree');

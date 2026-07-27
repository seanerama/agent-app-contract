#!/usr/bin/env node
/**
 * The consumability gate (ADR-0004 Amendment 1, issue #6).
 *
 * Nothing here deploys, so the equivalent of a deploy check is proving that a
 * downstream repo can actually CONSUME this one. It packs the root exactly as a
 * git-tag install would — `npm pack` runs `prepare`, and `prepare` builds every
 * workspace — then installs the tarball into a throwaway project and uses it the
 * way `nightshift-client` and `nightshift-assistant` will.
 *
 * This replaces the old per-package `verify-pack` check, which passed while real
 * consumption was completely broken: it proved each workspace could pack, but
 * npm does not install a git repo's workspaces, so no consumer ever saw them.
 * A gate that is green while the thing it names is broken is worse than no gate.
 *
 * The subtle failure it exists to catch: with `files: ["packages/*\/dist"]` the
 * tarball silently ships ONLY the two `bin` targets, because npm force-includes
 * `bin` and `main` but drops the rest of a glob it did not expand. Everything
 * imports fine locally and the tarball is 2 files. Hence the explicit directory
 * list in package.json, and hence this check asserting on real imports rather
 * than on the file listing.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let failures = 0;
const problem = (msg) => {
  console.error(`  FAIL ${msg}`);
  failures += 1;
};
const ok = (msg) => console.log(`  ok ${msg}`);

const staging = mkdtempSync(join(tmpdir(), 'aac-consume-'));
const consumer = mkdtempSync(join(tmpdir(), 'aac-consumer-'));

/** Run a command, returning status + output instead of throwing. */
const run = (cmd, args, opts = {}) => {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...opts });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? String(err),
    };
  }
};

try {
  // 1. Pack the root. This is the real consumer path: `prepare` builds all workspaces.
  const packed = run('npm', ['pack', '--pack-destination', staging], { cwd: ROOT });
  if (packed.status !== 0) {
    problem(`npm pack failed:\n${packed.stderr}`);
    throw new Error('cannot continue without a tarball');
  }
  const tarball = readdirSync(staging).find((f) => f.endsWith('.tgz'));
  if (!tarball) {
    problem('npm pack produced no tarball');
    throw new Error('cannot continue without a tarball');
  }
  const tarballPath = join(staging, tarball);

  // 2. The tarball must carry built output for all three workspaces, not just the
  //    `bin` targets npm force-includes.
  const entries = run('tar', ['-tzf', tarballPath])
    .stdout.split('\n')
    .map((l) => l.trim().replace(/^package\//, ''))
    .filter(Boolean);

  const required = [
    'packages/types/dist/index.js',
    'packages/types/dist/index.d.ts',
    'packages/conformance/dist/index.js',
    'packages/conformance/dist/cli.js',
    'packages/mock-agent/dist/index.js',
    'packages/mock-agent/dist/cli.js',
    'schemas/v1/health.json',
  ];
  for (const entry of required) {
    if (!entries.includes(entry)) problem(`tarball is missing ${entry}`);
  }
  if (entries.some((e) => e.endsWith('.ts') && !e.endsWith('.d.ts'))) {
    problem('tarball contains raw .ts sources');
  }
  ok(`packed ${tarball} (${entries.length} entries)`);

  // 3. Install it into a throwaway project, as a downstream repo would.
  writeFileSync(
    join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'consumer-probe', version: '1.0.0', type: 'module', private: true }, null, 2)}\n`,
  );
  const installed = run('npm', ['install', '--no-audit', '--no-fund', tarballPath], {
    cwd: consumer,
  });
  if (installed.status !== 0) {
    problem(`consumer install failed:\n${installed.stderr}`);
    throw new Error('cannot continue without an install');
  }
  ok('installed into a throwaway consumer');

  // 4. Use it the way downstream will. Each of these was broken before issue #6.
  const probe = `
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    await import('agent-app-contract/types');
    await import('agent-app-contract/conformance');
    await import('agent-app-contract/mock-agent');
    require.resolve('agent-app-contract/schemas/v1/health.json');
    console.log('IMPORTS_OK');
  `;
  const imported = run(process.execPath, ['--input-type=module', '-e', probe], { cwd: consumer });
  if (imported.stdout.includes('IMPORTS_OK')) {
    ok('types, conformance, mock-agent and schemas all resolve from the consumer');
  } else {
    problem(`consumer could not import the package:\n${imported.stderr}`);
  }

  // 5. The CLI must run from a consumer's node_modules/.bin — this is what catches a
  //    tarball that shipped cli.js but none of the modules it imports.
  const cli = run(join(consumer, 'node_modules', '.bin', 'agent-app-conformance'), ['--help']);
  if (cli.status === 0 && cli.stdout.includes('Usage: agent-app-conformance')) {
    ok('agent-app-conformance runs from the consumer .bin');
  } else {
    problem(`agent-app-conformance --help failed (exit ${cli.status}):\n${cli.stderr}`);
  }
} catch (err) {
  if (failures === 0) problem(String(err));
} finally {
  rmSync(staging, { recursive: true, force: true });
  rmSync(consumer, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nconsumability FAILED — ${failures} problem(s)`);
  process.exit(1);
}
console.log('\nconsumability ok — a git-tag consumer gets working types, schemas, and CLIs');

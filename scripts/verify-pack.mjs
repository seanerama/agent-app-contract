#!/usr/bin/env node
/**
 * The walking skeleton's deploy-leg substitute (ADR-0004).
 *
 * Nothing here deploys, so the equivalent proof is that each publishable package
 * produces a tarball containing built JS and .d.ts — the `prepare`-on-install path
 * a git-tag consumer depends on. `npm pack` runs `prepare`, so this exercises the
 * real path rather than inspecting the working tree.
 *
 * Note: this proves each PACKAGE packs correctly. It does NOT prove the repo-level
 * consumption story works — see issue #6, where installing this monorepo as a git
 * dependency was found to deliver the root package rather than the workspaces.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Packages that are meant to be consumed elsewhere, and what must be inside. */
const PUBLISHABLE = [
  { dir: 'packages/types', requires: ['dist/index.js', 'dist/index.d.ts'] },
  { dir: 'packages/mock-agent', requires: ['dist/index.js', 'dist/index.d.ts', 'dist/cli.js'] },
  { dir: 'packages/conformance', requires: ['dist/index.js', 'dist/index.d.ts', 'dist/cli.js'] },
];

let failures = 0;
const problem = (msg) => {
  console.error(`  FAIL ${msg}`);
  failures += 1;
};

const staging = mkdtempSync(join(tmpdir(), 'aac-pack-'));

try {
  for (const pkg of PUBLISHABLE) {
    const cwd = join(ROOT, pkg.dir);
    execFileSync('npm', ['pack', '--pack-destination', staging], { cwd, stdio: 'pipe' });

    const tarball = readdirSync(staging).find((f) => f.endsWith('.tgz'));
    if (!tarball) {
      problem(`${pkg.dir}: npm pack produced no tarball`);
      continue;
    }

    const listing = execFileSync('tar', ['-tzf', join(staging, tarball)], { encoding: 'utf8' });
    const entries = listing
      .split('\n')
      .map((l) => l.trim().replace(/^package\//, ''))
      .filter(Boolean);

    for (const required of pkg.requires) {
      if (!entries.includes(required)) {
        problem(`${pkg.dir}: tarball is missing ${required}`);
      }
    }

    // A tarball shipping raw TypeScript means the build did not run or `files` is
    // wrong; consumers would get sources they cannot execute.
    if (entries.some((e) => e.endsWith('.ts') && !e.endsWith('.d.ts'))) {
      problem(`${pkg.dir}: tarball contains raw .ts sources`);
    }

    console.log(`  ok ${pkg.dir} -> ${tarball} (${entries.length} entries)`);
    rmSync(join(staging, tarball));
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\npack verification FAILED — ${failures} problem(s)`);
  process.exit(1);
}
console.log('\npack verification ok — every publishable package ships built JS + types');

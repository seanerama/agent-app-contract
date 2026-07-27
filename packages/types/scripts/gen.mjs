#!/usr/bin/env node
/**
 * Generates TypeScript from schemas/v1/ into src/generated/, plus a barrel index.
 *
 * The schemas are the single source of truth (ADR-0003). This output is committed
 * and CI fails on any diff between it and a fresh run, so a schema change that is
 * not regenerated cannot merge. Never hand-edit src/generated — the drift check
 * exists precisely to catch that.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const ROOT = join(PKG, '..', '..');
const SCHEMA_DIR = join(ROOT, 'schemas', 'v1');
const OUT_DIR = join(PKG, 'src', 'generated');

const BANNER = [
  '/* eslint-disable */',
  '/**',
  ' * GENERATED — DO NOT EDIT.',
  ' * Source: schemas/v1/. Regenerate with `npm run gen` at the repo root.',
  ' * CI fails on drift between this file and a fresh generation (ADR-0003).',
  ' */',
  '',
].join('\n');

const schemaFiles = readdirSync(SCHEMA_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

if (schemaFiles.length === 0) {
  console.error(`no schemas found in ${SCHEMA_DIR}`);
  process.exit(1);
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const modules = [];

for (const file of schemaFiles) {
  const shape = basename(file, '.json');
  const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8'));

  const ts = await compile(schema, schema.title ?? shape, {
    bannerComment: '',
    additionalProperties: true, // tolerant readers — mirrors the open schemas (ADR-0003)
    style: {
      singleQuote: true,
      semi: true,
      printWidth: 100,
    },
  });

  writeFileSync(join(OUT_DIR, `${shape}.ts`), `${BANNER}${ts}`, 'utf8');
  modules.push(shape);
}

const index = [BANNER, ...modules.map((m) => `export type * from './${m}.js';`), ''].join('\n');
writeFileSync(join(OUT_DIR, 'index.ts'), index, 'utf8');

console.log(`generated ${modules.length} module(s) into packages/types/src/generated/`);

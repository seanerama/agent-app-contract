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

/**
 * Frozen `$id` prefix (ADR-0003). Schemas cross-reference each other by absolute
 * `$id` — outbox-page's items are event-envelope, for instance.
 *
 * Those `$id`s are identifiers, not URLs anyone should fetch: the prefix points at a
 * GitHub Pages site that ADR-0004 explicitly declined to publish. Left alone, the ref
 * parser tries to resolve them over HTTP and codegen fails with ERESOLVER — or worse,
 * succeeds one day against whatever happens to be hosted there. This resolver maps the
 * prefix back to the local file, so generation is hermetic and offline by construction.
 */
const ID_PREFIX = 'https://seanerama.github.io/agent-app-contract/schemas/v1/';

const localSchemaResolver = {
  order: 1,
  canRead: (file) => file.url.startsWith(ID_PREFIX),
  read: (file) => readFileSync(join(SCHEMA_DIR, basename(file.url)), 'utf8'),
};

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
    $refOptions: { resolve: { agentAppContract: localSchemaResolver } },
    style: {
      singleQuote: true,
      semi: true,
      printWidth: 100,
    },
  });

  writeFileSync(join(OUT_DIR, `${shape}.ts`), `${BANNER}${ts}`, 'utf8');
  modules.push({ shape, ts, title: schema.title ?? shape });
}

/**
 * Build the barrel with EXPLICIT named re-exports rather than `export type *`.
 *
 * A schema that cross-references another by `$id` gets the referenced type INLINED
 * into its module — outbox-page.ts declares both `OutboxPage` and `EventEnvelope`.
 * Star-exporting every module then re-exports `EventEnvelope` from two places, which
 * is a hard TypeScript error (TS2308), not a warning. So each type is exported from
 * exactly one module: the one whose schema `title` owns the name, falling back to
 * whichever module declared it first.
 */
const declaredIn = new Map(); // type name -> owning module shape
for (const { shape, ts, title } of modules) {
  for (const [, name] of ts.matchAll(/export (?:interface|type) (\w+)/g)) {
    const owned = name === title;
    if (owned || !declaredIn.has(name)) declaredIn.set(name, shape);
  }
}

const exportsByModule = new Map(modules.map((m) => [m.shape, []]));
for (const [name, shape] of [...declaredIn.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  exportsByModule.get(shape).push(name);
}

const index = [
  BANNER,
  ...modules
    .filter(({ shape }) => exportsByModule.get(shape).length > 0)
    .map(
      ({ shape }) =>
        `export type { ${exportsByModule.get(shape).join(', ')} } from './${shape}.js';`,
    ),
  '',
].join('\n');
writeFileSync(join(OUT_DIR, 'index.ts'), index, 'utf8');

console.log(`generated ${modules.length} module(s) into packages/types/src/generated/`);

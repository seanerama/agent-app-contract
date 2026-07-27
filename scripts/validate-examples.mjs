#!/usr/bin/env node
/**
 * Validates every file in examples/ against its schema in schemas/v1/.
 *
 * Mapping: examples/<shape>.json          -> schemas/v1/<shape>.json
 *          examples/<shape>.<variant>.json -> schemas/v1/<shape>.json
 *
 * Also enforces two things the contract depends on and that review should not have
 * to catch by eye (contracts/app-ingress.md, ADR-0003):
 *   - every schema carries the frozen $id prefix, exactly
 *   - no schema closes additionalProperties (tolerant readers are additive-only)
 * and that every schema has at least one example, so a shape can never ship
 * undemonstrated.
 *
 * Exits non-zero on any failure. This script is a CI gate; it must be able to fail.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Directories are overridable so the gate itself can be tested against deliberately
 * broken fixtures. A CI gate nobody has watched fail is not a gate — see
 * test/validate-examples.test.mjs.
 */
const SCHEMA_DIR = process.env.SCHEMA_DIR ?? join(ROOT, 'schemas', 'v1');
const EXAMPLE_DIR = process.env.EXAMPLE_DIR ?? join(ROOT, 'examples');

/** Frozen by ADR-0003. Changing this invalidates every published schema identity. */
const ID_PREFIX = 'https://seanerama.github.io/agent-app-contract/schemas/v1/';

const failures = [];
const fail = (msg) => failures.push(msg);

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const listJson = (dir) => {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
};

/** Recursively assert no subschema sets additionalProperties:false. */
const assertOpen = (node, schemaFile, path = '$') => {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      assertOpen(item, schemaFile, `${path}[${i}]`);
    }
    return;
  }
  if (node.additionalProperties === false) {
    fail(
      `${schemaFile}: additionalProperties:false at ${path}. Closed schemas make every ` +
        'additive spec change breaking for older readers (ADR-0003).',
    );
  }
  for (const [key, value] of Object.entries(node)) {
    assertOpen(value, schemaFile, `${path}.${key}`);
  }
};

const schemaFiles = listJson(SCHEMA_DIR);
if (schemaFiles.length === 0) {
  console.error(`no schemas found in ${SCHEMA_DIR}`);
  process.exit(1);
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const schemasByShape = new Map();
for (const file of schemaFiles) {
  const shape = basename(file, '.json');
  const schema = readJson(join(SCHEMA_DIR, file));

  const expectedId = `${ID_PREFIX}${file}`;
  if (schema.$id !== expectedId) {
    fail(`${file}: $id is ${JSON.stringify(schema.$id)}, expected ${JSON.stringify(expectedId)}`);
  }
  assertOpen(schema, file);

  try {
    ajv.addSchema(schema);
    schemasByShape.set(shape, schema);
  } catch (err) {
    fail(`${file}: not a valid JSON Schema 2020-12 — ${err.message}`);
  }
}

const exampleFiles = listJson(EXAMPLE_DIR);
const demonstrated = new Set();
let checked = 0;

for (const file of exampleFiles) {
  const shape = basename(file, '.json').split('.')[0];
  const schema = schemasByShape.get(shape);
  if (!schema) {
    fail(`examples/${file}: no schema schemas/v1/${shape}.json to validate against`);
    continue;
  }

  const validate = ajv.getSchema(schema.$id);
  const data = readJson(join(EXAMPLE_DIR, file));
  checked += 1;

  if (validate(data)) {
    demonstrated.add(shape);
  } else {
    const detail = (validate.errors ?? [])
      .map((e) => `    ${e.instancePath || '/'} ${e.message}`)
      .join('\n');
    fail(`examples/${file}: does not validate against ${shape}.json\n${detail}`);
  }
}

for (const shape of schemasByShape.keys()) {
  if (!demonstrated.has(shape)) {
    fail(`schemas/v1/${shape}.json: no valid example in examples/ — every shape needs one`);
  }
}

if (failures.length > 0) {
  console.error('example validation FAILED:\n');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}

console.log(`example validation ok — ${schemasByShape.size} schema(s), ${checked} example(s)`);

/**
 * Tests for the `spec` gate itself.
 *
 * The point of these is not that the current examples happen to be valid — it is
 * that the gate REJECTS the things it claims to reject. A validator that always
 * exits 0 would keep CI green forever while the contract rotted (ADR-0005).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'validate-examples.mjs');
const ID_PREFIX = 'https://seanerama.github.io/agent-app-contract/schemas/v1/';

const tmpRoots = [];
after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

/** Build a throwaway schemas/examples pair and run the gate against it. */
const runAgainst = ({ schemas = {}, examples = {} }) => {
  const root = mkdtempSync(join(tmpdir(), 'aac-spec-'));
  tmpRoots.push(root);
  const schemaDir = join(root, 'schemas');
  const exampleDir = join(root, 'examples');
  mkdirSync(schemaDir, { recursive: true });
  mkdirSync(exampleDir, { recursive: true });

  for (const [name, body] of Object.entries(schemas)) {
    writeFileSync(join(schemaDir, name), JSON.stringify(body, null, 2));
  }
  for (const [name, body] of Object.entries(examples)) {
    writeFileSync(join(exampleDir, name), JSON.stringify(body, null, 2));
  }

  const res = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, SCHEMA_DIR: schemaDir, EXAMPLE_DIR: exampleDir },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
};

const goodSchema = (name = 'thing') => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `${ID_PREFIX}${name}.json`,
  title: 'Thing',
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
});

describe('validate-examples gate', () => {
  it('accepts a valid schema + example pair', () => {
    const res = runAgainst({
      schemas: { 'thing.json': goodSchema() },
      examples: { 'thing.json': { ok: true } },
    });
    assert.equal(res.status, 0, res.stderr);
  });

  it('FAILS when an example violates its schema', () => {
    const res = runAgainst({
      schemas: { 'thing.json': goodSchema() },
      examples: { 'thing.json': { ok: 'not-a-boolean' } },
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /does not validate/);
  });

  it('FAILS when a schema $id does not carry the frozen prefix', () => {
    const schema = { ...goodSchema(), $id: 'https://example.com/thing.json' };
    const res = runAgainst({
      schemas: { 'thing.json': schema },
      examples: { 'thing.json': { ok: true } },
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /\$id is/);
  });

  it('FAILS when a schema $id has the wrong filename under the right prefix', () => {
    const schema = { ...goodSchema(), $id: `${ID_PREFIX}other.json` };
    const res = runAgainst({
      schemas: { 'thing.json': schema },
      examples: { 'thing.json': { ok: true } },
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /\$id is/);
  });

  it('FAILS when a schema closes additionalProperties', () => {
    const schema = { ...goodSchema(), additionalProperties: false };
    const res = runAgainst({
      schemas: { 'thing.json': schema },
      examples: { 'thing.json': { ok: true } },
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /additionalProperties:false/);
  });

  it('FAILS when additionalProperties is closed on a NESTED subschema', () => {
    const schema = {
      ...goodSchema(),
      properties: {
        ok: { type: 'boolean' },
        nested: { type: 'object', additionalProperties: false, properties: {} },
      },
    };
    const res = runAgainst({
      schemas: { 'thing.json': schema },
      examples: { 'thing.json': { ok: true } },
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /additionalProperties:false/);
  });

  it('FAILS when a schema has no example at all', () => {
    const res = runAgainst({ schemas: { 'thing.json': goodSchema() }, examples: {} });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /no valid example/);
  });

  it('FAILS when an example has no matching schema', () => {
    const res = runAgainst({
      schemas: { 'thing.json': goodSchema() },
      examples: { 'thing.json': { ok: true }, 'ghost.json': { ok: true } },
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /no schema/);
  });
});

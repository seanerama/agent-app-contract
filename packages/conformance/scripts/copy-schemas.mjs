#!/usr/bin/env node
/**
 * Copies schemas/v1/ into dist/schemas/v1/ so the harness can validate an agent's
 * responses when installed in someone else's repo, with no path back to this one.
 *
 * This is duplicated in packages/mock-agent on purpose. See ADR-0005: conformance
 * and mock-agent must not share implementation code, or a shared misreading of the
 * spec would cancel out and the self-proving loop would go green on a bug.
 */
import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(PKG, '..', '..', 'schemas', 'v1');
const DEST = join(PKG, 'dist', 'schemas', 'v1');

mkdirSync(DEST, { recursive: true });
cpSync(SRC, DEST, { recursive: true });
console.log('copied schemas/v1 -> dist/schemas/v1');

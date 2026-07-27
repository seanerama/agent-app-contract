#!/usr/bin/env node
/**
 * agent-app-conformance CLI — frozen surface, see contracts/conformance-report.md.
 *
 *   agent-app-conformance <url> --token <token> [--json]
 *
 * Exit codes are part of the contract: 0 conforming, 1 non-conforming, 2 unreachable.
 * Under --json, stdout is parseable JSON or nothing; diagnostics go to stderr.
 */
import { EXIT, exitCodeFor } from './report.js';
import { runConformance } from './run.js';

const HARNESS_VERSION = '0.1.0';

const usage = `Usage: agent-app-conformance <url> --token <token> [--json]

  <url>              Base URL of the agent under test. The harness appends /app/v1/...
  --token <token>    Bearer token presented on authenticated checks. Required.
  --person-id <id>   Owner id to send as personId (contract invariant 4). Optional.
                     Without it the chat-triad checks report skip: the agent rejects
                     a foreign personId by design, and the contract defines no way to
                     discover the owner id over the wire — it is configured out of
                     band, exactly like the token.
  --json             Emit the machine-readable report on stdout instead of human output.

Exit codes:
  0  conforming
  1  non-conforming (the agent was reached; one or more checks failed)
  2  unreachable (could not test)
`;

const argv = process.argv.slice(2);
let url = '';
let token = '';
let personId = '';
let json = false;

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--json') {
    json = true;
  } else if (arg === '--person-id') {
    const value = argv[i + 1];
    if (value === undefined) {
      console.error('agent-app-conformance: --person-id requires a value\n');
      console.error(usage);
      process.exit(EXIT.UNREACHABLE);
    }
    personId = value;
    i += 1;
  } else if (arg === '--token') {
    const value = argv[i + 1];
    if (value === undefined) {
      console.error('agent-app-conformance: --token requires a value\n');
      console.error(usage);
      process.exit(EXIT.UNREACHABLE);
    }
    token = value;
    i += 1;
  } else if (arg === '--help' || arg === '-h') {
    console.log(usage);
    process.exit(0);
  } else if (arg?.startsWith('-')) {
    console.error(`agent-app-conformance: unknown option ${arg}\n`);
    console.error(usage);
    process.exit(EXIT.UNREACHABLE);
  } else if (arg !== undefined && url === '') {
    url = arg;
  } else {
    console.error(`agent-app-conformance: unexpected argument ${arg}\n`);
    console.error(usage);
    process.exit(EXIT.UNREACHABLE);
  }
}

if (url === '' || token === '') {
  console.error('agent-app-conformance: <url> and --token are both required\n');
  console.error(usage);
  // Misuse means we never tested the agent — that is "could not test", not a verdict
  // about the agent's conformance.
  process.exit(EXIT.UNREACHABLE);
}

const report = await runConformance({
  baseUrl: url,
  token,
  harnessVersion: HARNESS_VERSION,
  // exactOptionalPropertyTypes: omit the key entirely rather than pass undefined,
  // so "not supplied" stays distinguishable from "supplied as empty".
  ...(personId === '' ? {} : { personId }),
});

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const symbol = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' } as const;
  for (const check of report.checks) {
    const line = `${symbol[check.result].padEnd(4)}  ${check.id}  ${check.title}`;
    if (check.result === 'fail') {
      console.error(line);
      console.error(`      ${check.detail}`);
    } else {
      console.error(line);
      if (check.result === 'skip') console.error(`      ${check.detail}`);
    }
  }
  console.error('');
  console.error(
    `${report.result.toUpperCase()} — ${report.counts.passed} passed, ` +
      `${report.counts.failed} failed, ${report.counts.skipped} skipped (${report.target})`,
  );
  if (report.result === 'unreachable') {
    console.error(
      'The agent could not be reached. This is an infrastructure fault, not a verdict.',
    );
  }
}

process.exit(exitCodeFor(report));

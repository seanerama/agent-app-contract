/**
 * The report shape frozen in contracts/conformance-report.md.
 *
 * This is a published seam: downstream CI parses it and may key off check ids.
 * Adding a field is additive; renaming a check id or changing an exit code is a
 * breaking change and needs a new contract.
 */

export type CheckResult = 'pass' | 'fail' | 'skip';
export type RunResult = 'pass' | 'fail' | 'unreachable';

export interface Check {
  /** Stable, dotted, machine-readable. Never renamed, never reused. */
  id: string;
  title: string;
  result: CheckResult;
  /**
   * Human explanation on failure: what was expected and what actually arrived.
   * A detail that says only "assertion failed" is a bug in the harness (ADR-0005).
   * On a skip, states which undeclared capability gated it.
   */
  detail: string | null;
}

export interface Report {
  schema: 1;
  contract: 'app-ingress';
  contractVersion: string;
  harnessVersion: string;
  target: string;
  result: RunResult;
  counts: { passed: number; failed: number; skipped: number };
  checks: Check[];
}

/** Frozen exit codes. 0/1/2 never change meaning; any future code is >= 3. */
export const EXIT = {
  /** Conforming — every applicable check passed. */
  PASS: 0,
  /** Reached the agent; one or more checks failed. The agent's fault. */
  FAIL: 1,
  /** Could not test at all. An infrastructure fault, not a contract verdict. */
  UNREACHABLE: 2,
} as const;

export const buildReport = (
  target: string,
  checks: Check[],
  versions: { contractVersion: string; harnessVersion: string },
  unreachable = false,
): Report => {
  const counts = {
    passed: checks.filter((c) => c.result === 'pass').length,
    failed: checks.filter((c) => c.result === 'fail').length,
    skipped: checks.filter((c) => c.result === 'skip').length,
  };

  // Skips never fail a run. An agent declaring only `chat` and passing every core
  // check is conforming (ADR-0006).
  const result: RunResult = unreachable ? 'unreachable' : counts.failed > 0 ? 'fail' : 'pass';

  return {
    schema: 1,
    contract: 'app-ingress',
    contractVersion: versions.contractVersion,
    harnessVersion: versions.harnessVersion,
    target,
    result,
    counts,
    checks,
  };
};

export const exitCodeFor = (report: Report): number => {
  if (report.result === 'unreachable') return EXIT.UNREACHABLE;
  if (report.result === 'fail') return EXIT.FAIL;
  return EXIT.PASS;
};

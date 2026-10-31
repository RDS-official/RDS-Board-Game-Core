/* -------------------------------------------------------------------------- */
/* Tiny test harness                                                           */
/* -------------------------------------------------------------------------- */

export interface SuiteCaseResult {
  name: string;
  ok: boolean;
  error?: string;
  ms: number;
}

export interface SuiteResult {
  passed: number;
  failed: number;
  cases: SuiteCaseResult[];
}

type TestFn = () => void | Promise<void>;

const cases: { name: string; fn: TestFn }[] = [];

export function test(name: string, fn: TestFn): void {
  cases.push({ name, fn });
}

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new AssertionError(`${message} — expected ${String(expected)}, got ${String(actual)}`);
  }
}

/**
 * Sharding.
 *
 * The suite is one process by default. A CI/dev runner may spread the cases over
 * N processes with `SUITE_SHARDS=<n> SUITE_SHARD=<i>` (0-based): every process
 * still registers the whole suite — registration is deterministic and cheap — but
 * only executes its slice, so shard i runs cases i, i+n, i+2n, … Striding by index
 * rather than slicing a range keeps the slow cases (the full-game replays) spread
 * across shards instead of landing in one.
 */
const SHARD_TOTAL = Math.max(1, Math.floor(Number(process.env.SUITE_SHARDS ?? 1)) || 1);
const SHARD_INDEX = Math.min(
  SHARD_TOTAL - 1,
  Math.max(0, Math.floor(Number(process.env.SUITE_SHARD ?? 0)) || 0)
);

export function suiteShard(): { index: number; total: number } {
  return { index: SHARD_INDEX, total: SHARD_TOTAL };
}

export async function runCoreSuite(): Promise<SuiteResult> {
  const results: SuiteCaseResult[] = [];

  for (let index = 0; index < cases.length; index++) {
    if (index % SHARD_TOTAL !== SHARD_INDEX) continue;
    const testCase = cases[index];
    const started = Date.now();
    try {
      await testCase.fn();
      results.push({ name: testCase.name, ok: true, ms: Date.now() - started });
    } catch (err) {
      results.push({
        name: testCase.name,
        ok: false,
        error: (err as Error).message,
        ms: Date.now() - started
      });
    }
  }

  return {
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    cases: results
  };
}

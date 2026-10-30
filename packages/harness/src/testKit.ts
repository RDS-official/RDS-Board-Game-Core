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

export async function runCoreSuite(): Promise<SuiteResult> {
  const results: SuiteCaseResult[] = [];

  for (const testCase of cases) {
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

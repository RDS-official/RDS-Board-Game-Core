/**
 * Regression gates: wall-clock budget and memory ceiling.
 *
 * The suites already assert correctness; these two gates assert the *shape* of
 * the run, because both failure modes are silent otherwise — a test that grew
 * from 40s to 4 minutes, or one that leaks a few hundred MB per run, still goes
 * green. Each suite calls `gate()` at the end, which prints one `GATE` line and
 * returns a failure list the runner folds into its exit code.
 *
 * Budgets are deliberately generous (roughly 2× today's measurement) so ordinary
 * machine noise never fails a run, while a real regression — an accidental O(n²),
 * a new per-case fixture load, a leaked engine — trips it immediately. Override
 * with `GATE_<NAME>_MS` / `GATE_<NAME>_MB`, or scale everything with
 * `GATE_SCALE` (e.g. `GATE_SCALE=2` on a slow CI box).
 */

const SCALE = Math.max(0.1, Number(process.env.GATE_SCALE ?? 1) || 1);

/** Defaults measured on the dev machine, with 2× headroom. */
export const DEFAULT_BUDGETS = {
  core: { ms: 90_000, mb: 900 },
  matrix: { ms: 180_000, mb: 900 },
  ui: { ms: 360_000, mb: 1_400 }
};

/**
 * Sample RSS in the background.
 *
 * `process.resourceUsage().maxRSS` is not populated on Windows, so the peak is
 * tracked by sampling. `unref()` keeps the timer from holding the process open.
 */
export function startMemoryWatch(intervalMs = 250) {
  let peakMb = 0;
  const sample = () => {
    const rss = process.memoryUsage().rss / (1024 * 1024);
    if (rss > peakMb) peakMb = rss;
  };
  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref?.();
  return {
    sample,
    get peakMb() {
      sample();
      return peakMb;
    },
    stop() {
      clearInterval(timer);
    }
  };
}

/**
 * Check one suite against its budgets.
 *
 * Returns the list of failure strings (empty = pass) and prints a single line so
 * the numbers are visible in every run, not just on failure.
 */
export function gate(name, { startedAt, memory, budget }) {
  const limits = { ...(DEFAULT_BUDGETS[name] ?? { ms: 120_000, mb: 900 }), ...(budget ?? {}) };
  const elapsedMs = Date.now() - startedAt;
  const msLimit = Math.round(limits.ms * SCALE);
  const mbLimit = Math.round(limits.mb * SCALE);
  const peakMb = memory ? Math.round(memory.peakMb) : undefined;
  memory?.stop();

  const failures = [];
  if (elapsedMs > msLimit) {
    failures.push(
      `gate ${name}: took ${(elapsedMs / 1000).toFixed(1)}s, budget ${(msLimit / 1000).toFixed(0)}s`
    );
  }
  if (peakMb !== undefined && peakMb > mbLimit) {
    failures.push(`gate ${name}: peak RSS ${peakMb}MB, budget ${mbLimit}MB`);
  }

  const state = failures.length === 0 ? 'ok' : 'FAIL';
  console.log(
    `\n  GATE ${name.padEnd(7)} ${state}  ${(elapsedMs / 1000).toFixed(1)}s / ${(msLimit / 1000).toFixed(0)}s` +
      (peakMb === undefined ? '' : `  ·  ${peakMb}MB / ${mbLimit}MB`)
  );
  return failures;
}

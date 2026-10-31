/**
 * Parallel fixture-matrix runner.
 *
 * Each module gets its own process (`MATRIX_MODULES=<id>`): the fixtures are
 * independent, the kernel has no shared state, and one module per process also
 * keeps a slow fixture (betrayal, splendor) from stretching the whole run.
 *
 *   MATRIX_PARALLEL=4 node scripts/test-matrix-parallel.mjs
 */

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const LOG_DIR = join(process.env.TEMP ?? process.env.TMPDIR ?? '.', 'rds-verify');
mkdirSync(LOG_DIR, { recursive: true });

const MODULES = (process.env.MATRIX_PARALLEL_MODULES ?? 'catan,sanguosha,splendor,betrayal,dune_mahjong,poker')
  .split(',')
  .map(entry => entry.trim())
  .filter(Boolean);
const CONCURRENCY = Math.max(1, Number(process.env.MATRIX_PARALLEL ?? 3) || 3);

const startedAt = Date.now();

function runModule(id) {
  return new Promise(resolve => {
    const logPath = join(LOG_DIR, `matrix-${id}.log`);
    const out = openSync(logPath, 'w');
    const child = spawn(process.execPath, ['scripts/test-matrix.mjs'], {
      env: { ...process.env, MATRIX_MODULES: id, NO_COLOR: '1' },
      stdio: ['ignore', out, out]
    });
    child.on('exit', code => {
      closeSync(out);
      resolve({ id, code: code ?? 1, logPath });
    });
  });
}

const results = [];
let next = 0;
async function worker() {
  while (next < MODULES.length) {
    const id = MODULES[next++];
    results.push(await runModule(id));
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, MODULES.length) }, () => worker()));

const failures = [];
let runs = 0;
let steps = 0;
for (const result of results) {
  const text = readFileSync(result.logPath, 'utf8');
  const summary = /matrix: (\d+) modules, (\d+) seed-runs, \d+ scenarios, (\d+) applied actions/.exec(text);
  if (summary) {
    runs += Number(summary[2]);
    steps += Number(summary[3]);
  }
  let moduleFailed = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('✗')) {
      failures.push(`${result.id}: ${trimmed}`);
      moduleFailed = true;
    }
    if (trimmed.includes('GATE matrix') && trimmed.includes('FAIL')) {
      failures.push(`${result.id}: ${trimmed}`);
      moduleFailed = true;
    }
  }
  if (result.code !== 0 && !moduleFailed) {
    failures.push(`${result.id} exited ${result.code} — ${result.logPath}`);
  }
}

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(
  `\nmatrix (${MODULES.length} modules, ${CONCURRENCY} at a time): ${runs} seed-runs, ${steps} actions in ${seconds}s`
);
if (failures.length > 0) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log('All fixture matrix modules passed.');
}

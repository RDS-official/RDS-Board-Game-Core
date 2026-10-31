/**
 * Parallel core-suite runner.
 *
 * The kernel suite is one process and ~40s today, dominated by a handful of
 * full-game replay cases. It shards cleanly by case index (`SUITE_SHARD`), so
 * this spawns one process per shard and merges the summaries.
 *
 * Child output goes to files rather than pipes: a failing shard's log is worth
 * keeping verbatim, and file output cannot stall on a slow reader.
 *
 *   CORE_SHARDS=3 node scripts/test-core-parallel.mjs
 */

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const SHARDS = Math.max(1, Number(process.env.CORE_SHARDS ?? 3) || 3);
const LOG_DIR = join(process.env.TEMP ?? process.env.TMPDIR ?? '.', 'rds-verify');
mkdirSync(LOG_DIR, { recursive: true });

const startedAt = Date.now();

function runShard(index) {
  return new Promise(resolve => {
    const logPath = join(LOG_DIR, `core-shard-${index}.log`);
    const out = openSync(logPath, 'w');
    const child = spawn(process.execPath, ['scripts/test-core.mjs'], {
      env: { ...process.env, SUITE_SHARDS: String(SHARDS), SUITE_SHARD: String(index), NO_COLOR: '1' },
      stdio: ['ignore', out, out]
    });
    child.on('exit', code => {
      closeSync(out);
      resolve({ index, code: code ?? 1, logPath });
    });
  });
}

const results = await Promise.all(Array.from({ length: SHARDS }, (_, index) => runShard(index)));

let passed = 0;
let failed = 0;
let cases = 0;
const failures = [];
for (const result of results) {
  const text = readFileSync(result.logPath, 'utf8');
  const summary = /(\d+) passed, (\d+) failed, (\d+) cases/.exec(text);
  if (summary) {
    passed += Number(summary[1]);
    failed += Number(summary[2]);
    cases += Number(summary[3]);
  } else {
    failures.push(`shard ${result.index} produced no summary (exit ${result.code}) — ${result.logPath}`);
  }
  let shardFailed = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('✗')) {
      failures.push(`shard ${result.index}: ${trimmed}`);
      shardFailed = true;
    }
    if (trimmed.includes('GATE core') && trimmed.includes('FAIL')) {
      failures.push(`shard ${result.index}: ${trimmed}`);
      shardFailed = true;
    }
  }
  if (result.code !== 0 && !shardFailed) {
    failures.push(`shard ${result.index} exited ${result.code} — ${result.logPath}`);
  }
}

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(
  `\ncore (${SHARDS} shards): ${passed} passed, ${failed} failed, ${cases} cases in ${seconds}s`
);
if (failures.length > 0) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log('All core shards passed.');
}

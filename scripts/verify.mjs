/**
 * One-command regression run.
 *
 * Runs the gates that can run at the same time *at the same time* — they are
 * independent processes, and wall-clock is what hurts — then prints one summary.
 *
 *   node scripts/verify.mjs            # everything except the Playwright UI matrix
 *   node scripts/verify.mjs --ui       # + the UI matrix (the long pole)
 *   node scripts/verify.mjs --changed  # only what the current diff can affect
 *   node scripts/verify.mjs --all      # --ui and --changed together are ignored; this is the full sweep
 *
 * Timeouts and memory ceilings live in `scripts/lib/gates.mjs`; the individual
 * suites enforce them, so a slow or leaky run fails here without any extra logic.
 */

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';

const argv = new Set(process.argv.slice(2));
const WANT_UI = argv.has('--ui') || argv.has('--all');
const CHANGED = argv.has('--changed') && !argv.has('--all');

const LOG_DIR = join(process.env.TEMP ?? process.env.TMPDIR ?? '.', 'rds-verify');
mkdirSync(LOG_DIR, { recursive: true });

/** Files this branch or working tree touches, relative to the repo root. */
function changedFiles() {
  const files = new Set();
  const collect = args => {
    try {
      const out = execFileSync('git', args, { encoding: 'utf8' });
      for (const line of out.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) files.add(trimmed.replace(/\\/g, '/'));
      }
    } catch {
      // No git, or no origin/main: fall back to the full sweep.
    }
  };
  collect(['diff', '--name-only', 'HEAD']);
  collect(['diff', '--name-only', 'origin/main...HEAD']);
  return [...files];
}

const files = CHANGED ? changedFiles() : [];
const touches = pattern => files.some(file => pattern.test(file));

/**
 * Which gates the diff can affect.
 *
 * Mirrors the matrix in AGENTS.md §3.2, so a docs-only change does not pay for a
 * Playwright run and a kernel change still gets the replay matrix.
 */
const selected = (() => {
  if (!CHANGED || files.length === 0) {
    return { core: true, matrix: true, overlap: true, ui: WANT_UI, lint: true, types: true, docs: true };
  }
  const code = touches(/\.(ts|tsx|mjs|cjs|js|css)$/);
  const docs = touches(/\.md$/);
  const kernelish = touches(/^packages\/(kernel|games|harness)\//);
  const uish = touches(/^(apps\/web|packages\/app)\//);
  const geometry = touches(/roomTile\.ts$|render\/procedural\//);
  return {
    core: code || kernelish,
    matrix: kernelish,
    overlap: geometry,
    ui: WANT_UI || (uish && code),
    lint: code,
    types: code,
    docs: docs || code
  };
})();

const gates = [];
const add = (id, label, command, args, env = {}) =>
  gates.push({ id, label, command, args, env });

// Every gate that boots a browser gets its own port: verify runs them at the
// same time, and two gates sharing a solo server means one of them shuts it down
// under the other.
if (selected.core) add('core', 'core suite (3 shards)', process.execPath, ['scripts/test-core-parallel.mjs']);
if (selected.matrix)
  add('matrix', 'fixture matrix (3 at a time)', process.execPath, ['scripts/test-matrix-parallel.mjs']);
if (selected.overlap)
  add('overlap', 'probe:overlap', process.execPath, ['scripts/probe-overlap.mjs'], { SOLO_PORT: '5182' });
if (selected.ui)
  add('ui', 'UI matrix (worker pool)', process.execPath, ['scripts/test-ui-matrix.mjs'], { SOLO_PORT: '5180' });
if (selected.lint) add('lint', 'biome lint', 'pnpm', ['lint']);
if (selected.types) add('types', 'tsc + build', process.execPath, ['scripts/verify-types.mjs']);
if (selected.docs) add('docs', 'docs:check', process.execPath, ['scripts/check-doc-paths.mjs']);

if (gates.length === 0) {
  console.log('verify: nothing to run for this diff.');
  process.exit(0);
}

console.log(`verify: ${gates.map(gate => gate.id).join(' + ')}${CHANGED ? ` (changed: ${files.length} files)` : ''}\n`);

const startedAt = Date.now();
const results = await Promise.all(
  gates.map(
    gate =>
      new Promise(resolve => {
        const logPath = join(LOG_DIR, `verify-${gate.id}.log`);
        const out = openSync(logPath, 'w');
        const child = spawn(gate.command, gate.args, {
          env: { ...process.env, NO_COLOR: '1', ...gate.env },
          stdio: ['ignore', out, out],
          shell: process.platform === 'win32' && gate.command === 'pnpm'
        });
        child.on('exit', code => {
          closeSync(out);
          resolve({ ...gate, code: code ?? 1, logPath });
        });
      })
  )
);

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
let failed = 0;
for (const result of results) {
  const ok = result.code === 0;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${result.label.padEnd(30)} ${ok ? 'ok' : `exit ${result.code}`}`);
  if (!ok) {
    const tail = readFileSync(result.logPath, 'utf8')
      .split('\n')
      .filter(line => line.trim())
      .slice(-12)
      .join('\n');
    console.log(
      tail
        .split('\n')
        .map(line => `      ${line}`)
        .join('\n')
    );
  }
}

console.log(`\nverify: ${results.length - failed}/${results.length} gates ok in ${seconds}s`);
process.exitCode = failed === 0 ? 0 : 1;

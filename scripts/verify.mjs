/**
 * One-command regression run.
 *
 * Runs the gates that can run at the same time *at the same time* — they are
 * independent processes, and wall-clock is what hurts — then prints one summary.
 *
 *   node scripts/verify.mjs            # everything except the Playwright UI matrix
 *   node scripts/verify.mjs --ui       # + the UI matrix (the long pole)
 *   node scripts/verify.mjs --changed  # only what the current diff can affect (smart targeted mode)
 *   node scripts/verify.mjs --fast     # ultra-fast dev loop: types + lint + core/server, no browser/matrix
 *   node scripts/verify.mjs --all      # full sweep across all 8 gates (used for PR & CI)
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
const CHANGED = (argv.has('--changed') || argv.has('--fast') || argv.has('--quick')) && !argv.has('--all');
const FAST = (argv.has('--fast') || argv.has('--quick') || process.env.FAST === '1') && !argv.has('--all');

const LOG_DIR = join(process.env.TEMP ?? process.env.TMPDIR ?? '.', 'rds-verify');
mkdirSync(LOG_DIR, { recursive: true });

const DEFAULT_COREPACK_HOME = process.env.COREPACK_HOME ?? join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'corepack');

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

/** Targeted game detection: if diff only touches one game and no common kernel/web core, narrow gates to it. */
const changedGames = new Set();
for (const file of files) {
  const m = file.match(/(?:packages\/games\/src\/|apps\/web\/src\/render\/fixtures\/)([a-z0-9_]+)/);
  if (m) changedGames.add(m[1]);
}
const touchedCommonKernel = touches(/^packages\/kernel\//);
const touchedCommonApp = touches(/^packages\/app\//);
const touchedCommonWeb = touches(/^apps\/web\/src\/(?:ui|render\/(?!fixtures\/)|main\.ts)/);
const singleGame = changedGames.size === 1 && !touchedCommonKernel && !touchedCommonApp && !touchedCommonWeb
  ? [...changedGames][0]
  : null;

const serverOnly = files.length > 0 && files.every(f => f.startsWith('apps/server/') || f === 'package.json');

/**
 * Which gates the diff can affect.
 *
 * Mirrors the matrix in AGENTS.md §3.2, so a docs-only change does not pay for a
 * Playwright run and a kernel change still gets the replay matrix.
 */
const selected = (() => {
  if (!CHANGED || files.length === 0) {
    return { core: true, matrix: true, overlap: true, ui: WANT_UI, uiSmoke: false, lint: true, types: true, docs: true, server: false };
  }
  if (serverOnly) {
    return { core: false, matrix: false, overlap: false, ui: false, uiSmoke: false, lint: true, types: true, docs: false, server: true };
  }

  // Executable sources only: a `.css` edit cannot affect a kernel test.
  const code = touches(/\.(ts|tsx|mjs|cjs|js)$/);
  const styles = touches(/\.css$/);
  const docs = touches(/\.md$/);
  const kernelish = touches(/^packages\/(kernel|games|harness)\//);
  const uish = touches(/^(apps\/web|packages\/app)\//);
  const geometry = touches(/roomTile\.ts$|render\/procedural\//);

  return {
    core: (code || kernelish) && !serverOnly,
    matrix: kernelish && !FAST,
    overlap: geometry && !FAST,
    ui: !FAST && (WANT_UI || (uish && (code || styles))),
    // `--changed` is the inner loop: one screen per game is enough to catch a
    // broken boot, and the full sweep still runs in `verify:all`.
    uiSmoke: !WANT_UI,
    lint: code,
    types: code,
    docs: docs || code,
    server: touches(/^apps\/server\//)
  };
})();

const gates = [];
const add = (id, label, command, args, env = {}) =>
  gates.push({ id, label, command, args, env: { COREPACK_HOME: DEFAULT_COREPACK_HOME, ...env } });

// 1. Core Conformance Suite
if (selected.core) {
  const coreEnv = singleGame ? { CORE_MATCH: singleGame } : {};
  const label = singleGame ? `core suite (target: ${singleGame})` : 'core suite (3 shards)';
  add('core', label, process.execPath, ['scripts/test-core-parallel.mjs'], coreEnv);
}

// 2. Server Self-test (when server files are touched)
if (selected.server) {
  add('server', 'server selftest', process.execPath, ['node_modules/tsx/dist/cli.mjs', 'apps/server/src/selftest.ts']);
}

// 3. Matrix Replay
if (selected.matrix) {
  const matrixEnv = {
    ...(CHANGED ? { MATRIX_FAST: '1' } : {}),
    ...(singleGame ? { MATRIX_PARALLEL_MODULES: singleGame } : {})
  };
  const label = singleGame ? `fixture matrix (target: ${singleGame})` : (CHANGED ? 'fixture matrix (fast dev)' : 'fixture matrix (3 at a time)');
  add('matrix', label, process.execPath, ['scripts/test-matrix-parallel.mjs'], matrixEnv);
}

// 4. Overlap & Geometry
if (selected.overlap) {
  add('overlap', 'probe:overlap', process.execPath, ['scripts/probe-overlap.mjs'], { SOLO_PORT: '5182' });
}

// 5. UI Matrix
if (selected.ui) {
  const uiEnv = {
    SOLO_PORT: '5180',
    ...(singleGame ? { UI_ONLY: singleGame } : {})
  };
  if (selected.uiSmoke) {
    const label = singleGame ? `UI matrix (smoke, target: ${singleGame})` : 'UI matrix (smoke)';
    add('ui', label, process.execPath, ['scripts/test-ui-matrix.mjs'], { ...uiEnv, UI_SMOKE: '1' });
  } else {
    add('ui', 'UI matrix + card-overlay', 'pnpm', ['test:ui'], uiEnv);
  }
  // 目标轮盘：几何 + 拖拽结算 + 磨砂裁切 + 不压手牌区，一次浏览器跑完。
  add('wheel', 'probe:target-wheel', process.execPath, ['scripts/probe-target-wheel.mjs'], { SOLO_PORT: '5183' });
}

// 6. Lint, Structure, Types, Docs
if (selected.lint) add('lint', 'biome lint', 'pnpm', ['lint']);
if (selected.lint) add('structure', 'structure budget', process.execPath, ['scripts/check-structure.mjs']);
if (selected.lint) add('hygiene', 'HTML hygiene', process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/check-html-hygiene.ts']);
// 键位表是纯数据 + 纯函数，跑一次不到一秒，所以每次动到代码都验：清单与实际键位失配
// 时不必等到浏览器矩阵才发现。
if (selected.lint) add('keymap', 'probe:keymap', process.execPath, ['scripts/probe-keymap.mjs']);
if (selected.types) add('types', 'tsc + build', process.execPath, ['scripts/verify-types.mjs']);
if (selected.docs) add('docs', 'docs:check', process.execPath, ['scripts/check-doc-paths.mjs']);
// 随机源守卫只扫源码文本，很便宜，动到代码就跑。
if (selected.lint) add('rng', 'rng guard', process.execPath, ['scripts/check-rng.mjs']);

if (gates.length === 0) {
  console.log('verify: nothing to run for this diff.');
  process.exit(0);
}

const modeInfo = [
  CHANGED ? `changed: ${files.length} files` : null,
  FAST ? 'mode: fast-loop' : null,
  singleGame ? `target: ${singleGame}` : null
].filter(Boolean).join(', ');

console.log(`verify: ${gates.map(gate => gate.id).join(' + ')}${modeInfo ? ` (${modeInfo})` : ''}\n`);

const isWindows = process.platform === 'win32';
const startedAt = Date.now();
const results = await Promise.all(
  gates.map(
    gate =>
      new Promise(resolve => {
        const logPath = join(LOG_DIR, `verify-${gate.id}.log`);
        const out = openSync(logPath, 'w');
        // Windows 下 `shell: true` 会把 command 和 args 直接拼进命令行：Node 自己的
        // 路径是 `C:\Program Files\nodejs\node.exe`，不加引号 cmd 会在空格处截断，
        // 报 `'C:\Program' 不是内部或外部命令`。带空格的参数同理。
        const quote = value => (isWindows && /\s/.test(value) ? `"${value}"` : value);
        const child = spawn(quote(gate.command), gate.args.map(quote), {
          env: { ...process.env, NO_COLOR: '1', ...gate.env },
          stdio: ['ignore', out, out],
          shell: isWindows
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
  console.log(`  ${ok ? '✓' : '✗'} ${result.label.padEnd(36)} ${ok ? 'ok' : `exit ${result.code}`}`);
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

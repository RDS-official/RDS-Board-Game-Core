/**
 * Cross-fixture conformance matrix.
 *
 * Runs every registered game over multiple seeds and every named scenario,
 * then verifies projection generation and deterministic replay.
 *
 * Parallel run: `scripts/test-matrix-parallel.mjs` spawns one process per module
 * (`MATRIX_MODULES=<id>`). `MATRIX_FAST=1` keeps a single seed per table for the
 * inner dev loop; the time / memory gates still apply either way.
 */

import { createServer } from 'vite';
import { gate, startMemoryWatch } from './lib/gates.mjs';

const startedAt = Date.now();
const memory = startMemoryWatch();

const parseSeeds = (value, fallback) =>
  value
    ? value
        .split(',')
        .map(entry => Number(entry.trim()))
        .filter(entry => Number.isFinite(entry))
    : fallback;
const FAST = process.env.MATRIX_FAST === '1';
const SEEDS = FAST ? [7] : parseSeeds(process.env.MATRIX_SEEDS, [7, 2025, 91021]);
const SCENARIO_SEEDS = FAST ? [11] : parseSeeds(process.env.MATRIX_SCENARIO_SEEDS, [11, 4242]);
const MODULE_FILTER = process.env.MATRIX_MODULES
  ? new Set(process.env.MATRIX_MODULES.split(',').map(entry => entry.trim()))
  : null;

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error'
});

const { GAME_MODULES } = await server.ssrLoadModule('/packages/games/src/registry.ts');
const { UniversalGameEngine } = await server.ssrLoadModule('/packages/kernel/src/engine.ts');
const { RandomPolicy, runPolicies } = await server.ssrLoadModule('/packages/harness/src/policy.ts');

const failures = [];
let scenarios = 0;
let seeds = 0;
let steps = 0;

function run(label, module, seed, scenario, maxSteps) {
  const engine = new UniversalGameEngine(module, seed, scenario ? { scenario } : undefined);
  const state = engine.getRawState();
  const order = state.playerOrder ?? [];
  const policies = Object.fromEntries(order.map((pid, index) => [pid, new RandomPolicy(seed + index * 17, `${label}-${pid}`)]));
  let report;
  try {
    report = runPolicies(engine, policies, maxSteps);
  } catch (error) {
    failures.push(`${label}: threw during run — ${error?.stack ?? error}`);
    return;
  }
  steps += report.steps;
  if (report.errors.length > 0) {
    failures.push(`${label}: ${report.errors.length} dispatch errors — ${report.errors.slice(0, 3).join(' | ')}`);
  }
  if (!report.steps) {
    failures.push(`${label}: no legal progress`);
  }
  try {
    const replay = engine.verifyReplay();
    if (!replay.ok) failures.push(`${label}: replay mismatch — ${replay.errors.slice(0, 3).join(' | ')}`);
  } catch (error) {
    failures.push(`${label}: replay threw — ${error?.stack ?? error}`);
  }

  for (const viewer of ['GOD', ...order]) {
    try {
      engine.getProjectedStateFor(viewer);
    } catch (error) {
      failures.push(`${label}: projection ${viewer} threw — ${error?.stack ?? error}`);
    }
  }

  try {
    for (const actor of engine.getFocusActors()) {
      for (const action of engine.getLegalActions(actor)) {
        if (!action || typeof action.type !== 'string') failures.push(`${label}: malformed legal action for ${actor}`);
      }
    }
  } catch (error) {
    failures.push(`${label}: legal action generation threw — ${error?.stack ?? error}`);
  }

  console.log(
    `  ${label.padEnd(38)} steps=${String(report.steps).padStart(3)} errors=${report.errors.length} finished=${report.finished}`
  );
}

console.log('\n=== fixture matrix ===\n');
const modules = MODULE_FILTER
  ? GAME_MODULES.filter(module => MODULE_FILTER.has(module.meta.id))
  : GAME_MODULES;
for (const module of modules) {
  const id = module.meta.id;
  console.log(`\n[${id}]`);
  for (const seed of SEEDS) {
    seeds++;
    run(`${id}:seed-${seed}`, module, seed, undefined, 120);
  }
  for (const [scenario] of Object.entries(module.scenarios ?? {})) {
    scenarios++;
    for (const seed of SCENARIO_SEEDS) {
      seeds++;
      run(`${id}:${scenario}:seed-${seed}`, module, seed, scenario, 100);
    }
  }
}

await server.close();

console.log(
  `\nmatrix: ${modules.length} modules, ${seeds} seed-runs, ${scenarios} scenarios, ${steps} applied actions`
);
const gateFailures = gate('matrix', { startedAt, memory });
failures.push(...gateFailures);
if (failures.length > 0) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log('\nAll fixture matrix checks passed.');
}

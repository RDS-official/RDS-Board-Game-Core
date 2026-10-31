/**
 * Structural size check (docs/QUALITY-GATES.md §7 Phase 3).
 *
 * Biome 2.6.4 does not expose a configurable max-lines rule, so this script
 * owns the budget instead: every source file gets a soft ceiling of 1200
 * non-blank lines, matching the `max-lines: warn(1200)` intent of Phase 3.
 *
 * The gate is informational today — legacy offenders (hud.ts, the betrayal
 * rules) are listed, not rejected — so it can run in every verify without
 * blocking the team. Set STRUCTURE_STRICT=1 once the big files are split and
 * the list is empty; the same command then becomes a hard gate with no
 * further config change.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['apps', 'packages'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.cjs']);
const MAX_LINES = Number(process.env.STRUCTURE_MAX_LINES ?? 1200);
const STRICT = process.env.STRUCTURE_STRICT === '1';

/** Counts non-blank lines: pure padding should not buy headroom. */
const codeLines = file =>
  readFileSync(file, 'utf8').split('\n').filter(line => line.trim().length > 0).length;

const files = [];
const walk = dir => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'build' || entry.name === 'dist') continue;
      walk(full);
    } else if (entry.isFile() && EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      files.push(full);
    }
  }
};
for (const root of ROOTS) {
  const src = join(root);
  if (statSync(src, { throwIfNoEntry: false })) walk(src);
}

const offenders = files
  .map(file => ({ file: file.split('\\').join('/'), lines: codeLines(file) }))
  .filter(entry => entry.lines > MAX_LINES)
  .sort((a, b) => b.lines - a.lines);

if (offenders.length === 0) {
  console.log(`structure: all ${files.length} source files within ${MAX_LINES} non-blank lines.`);
  process.exit(0);
}

console.log(`structure: ${offenders.length} file(s) over ${MAX_LINES} non-blank lines (budget from QUALITY-GATES §7):`);
for (const entry of offenders) {
  console.log(`  ${String(entry.lines).padStart(5)}  ${entry.file}`);
}
if (STRICT) {
  console.error('structure: STRUCTURE_STRICT=1 — treating oversize files as errors.');
  process.exit(1);
}
console.log('structure: informational only (STRUCTURE_STRICT unset); split these before tightening.');

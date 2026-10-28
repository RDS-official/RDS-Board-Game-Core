import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/**
 * Run every `scripts/verify-*.mjs` end-to-end check and summarise.
 *
 * These scripts each drive a real browser through one feature (NPC movement,
 * the two-phase check window, placement framing, …). They were not part of any
 * matrix, so they silently rotted when the action dock changed: by the time
 * anyone ran them, most were failing. This runner makes them a first-class
 * check so that cannot happen again.
 *
 *   node scripts/run-verify.mjs            # all scripts
 *   node scripts/run-verify.mjs placement  # only names containing "placement"
 */

const FILTER = process.argv[2] ?? '';

const scripts = fs
  .readdirSync('scripts')
  .filter(name => /^verify-.*\.mjs$/.test(name))
  .filter(name => name.includes(FILTER))
  .sort();

if (scripts.length === 0) {
  console.log(`no verify scripts matched "${FILTER}"`);
  process.exit(1);
}

const run = file =>
  new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join('scripts', file)], { stdio: 'pipe' });
    let output = '';
    child.stdout.on('data', chunk => (output += chunk));
    child.stderr.on('data', chunk => (output += chunk));
    child.on('close', code => resolve({ file, code, output, ms: Date.now() - started }));
  });

const results = [];
for (const file of scripts) {
  process.stdout.write(`· ${file} … `);
  let result = await run(file);

  // The shared dev server can still be shutting down from the previous script,
  // which surfaces as ERR_CONNECTION_REFUSED instead of a failed assertion.
  const transient = /ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(result.output);
  if (result.code !== 0 && transient) {
    process.stdout.write('retry … ');
    await new Promise(r => setTimeout(r, 1500));
    result = await run(file);
  }

  results.push(result);
  console.log(result.code === 0 ? `ok (${result.ms}ms)` : `FAIL (${result.ms}ms)`);
  if (result.code !== 0) {
    // Surface the tail of a failing run; the full log is noise on success.
    const lines = result.output.split('\n').filter(line => line.trim());
    for (const line of lines.slice(-6)) console.log(`    ${line}`);
  }
}

const failed = results.filter(result => result.code !== 0);
console.log(`\nverify: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log(`\nFAILED (${failed.length}):`);
  for (const result of failed) console.log(`  x ${result.file}`);
  process.exitCode = 1;
}

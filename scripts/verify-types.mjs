/**
 * Type-check and production build, as one gate.
 *
 * `tsc` and `vite build` are cheap (~2s together) but they must both pass, and
 * keeping them in one script means `scripts/verify.mjs` can run them as a single
 * concurrent task instead of sequencing two spawns.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

function run(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('exit', code => resolve(code ?? 1));
  });
}

const tsc = await run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']);
if (tsc !== 0) {
  console.log('\ntypes: tsc failed');
  process.exit(1);
}

const build = await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
if (build !== 0) {
  console.log('\ntypes: build failed');
  process.exit(1);
}

console.log('\ntypes: tsc + build ok');

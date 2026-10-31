import { createServer } from 'vite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gate, startMemoryWatch } from './lib/gates.mjs';

/**
 * Core conformance runner.
 * 1. runs the kernel suite through Vite SSR;
 * 2. enforces the UI/application architecture boundary at the source level;
 * 3. checks the run against the time / memory gates (`scripts/lib/gates.mjs`).
 *
 * `SUITE_SHARDS=<n> SUITE_SHARD=<i>` runs one slice; `scripts/test-core-parallel.mjs`
 * drives that for the parallel run.
 */
const startedAt = Date.now();
const memory = startMemoryWatch();
const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error'
});

let exitCode = 1;

function listTs(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? listTs(path) : entry.name.endsWith('.ts') ? [path] : [];
    });
}

function boundaryCheck() {
  const rules = [
    {
      dir: 'apps/web/src/ui',
      name: 'UI cannot import kernel / games / renderer / net / ai',
      forbidden: [/@rds\/kernel/, /@rds\/games/, /@rds\/net/, /(['"])[^'"]*\/render\//, /(['"])[^'"]*\/net\//, /(['"])[^'"]*\/ai\//, /(['"])[^'"]*\/core\//]
    },
    {
      dir: 'packages/app/src',
      name: 'application layer cannot import UI / renderer / ai',
      forbidden: [/@rds\/web/, /(['"])[^'"]*\/ui\//, /(['"])[^'"]*\/render\//, /(['"])[^'"]*\/ai\//]
    },
    {
      dir: 'packages/kernel/src',
      name: 'kernel cannot import anything outside itself (no @rds/*, no app layers)',
      forbidden: [/@rds\//, /(['"])[^'"]*\/games\//, /(['"])[^'"]*\/app\//, /(['"])[^'"]*\/net\//, /(['"])[^'"]*\/render\//, /(['"])[^'"]*\/ui\//, /(['"])[^'"]*\/ai\//]
    }
  ];

  const failures = [];
  for (const rule of rules) {
    for (const file of listTs(rule.dir)) {
      const source = readFileSync(file, 'utf8');
      const importLines = source
        .split('\n')
        .filter(line => /^\s*(import|export)\b/.test(line) || /\bimport\(/.test(line));
      for (const line of importLines) {
        for (const pattern of rule.forbidden) {
          if (pattern.test(line)) failures.push(`${file}: ${line.trim()}`);
        }
      }
    }
  }

  return failures;
}

try {
  const { runCoreSuite } = await server.ssrLoadModule('/packages/harness/src/suite.ts');
  const result = await runCoreSuite();

  const shardTotal = Number(process.env.SUITE_SHARDS ?? 1) || 1;
  const shardIndex = Number(process.env.SUITE_SHARD ?? 0) || 0;
  const shardLabel = shardTotal > 1 ? ` [shard ${shardIndex + 1}/${shardTotal}]` : '';

  console.log(`\nUniversal Board Game Kernel — conformance suite${shardLabel}\n`);

  for (const testCase of result.cases) {
    const mark = testCase.ok ? '\u2713' : '\u2717';
    const time = `${testCase.ms}ms`.padStart(7);
    console.log(`  ${mark} ${testCase.name.padEnd(72, ' ')} ${time}`);
    if (!testCase.ok) console.log(`      \u2192 ${testCase.error}`);
  }

  console.log('\n  Architecture boundary\n');
  const boundaryFailures = boundaryCheck();
  if (boundaryFailures.length === 0) {
    console.log('  \u2713 UI / application / kernel imports are separated');
  } else {
    for (const failure of boundaryFailures) console.log(`  \u2717 forbidden import — ${failure}`);
  }

  const failed = result.failed + boundaryFailures.length;
  console.log(
    `\n  ${result.passed} passed, ${result.failed} failed, ${result.cases.length} cases` +
      `${boundaryFailures.length ? `, ${boundaryFailures.length} boundary violations` : ', 0 boundary violations'}\n`
  );

  const gateFailures = gate('core', { startedAt, memory });
  for (const failure of gateFailures) console.log(`  ✗ ${failure}`);

  exitCode = failed === 0 && gateFailures.length === 0 ? 0 : 1;
} catch (err) {
  console.error('Suite crashed:', err);
  memory.stop();
} finally {
  await server.close();
}

process.exitCode = exitCode;

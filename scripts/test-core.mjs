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

const filterArg = process.argv.slice(2).find(arg => !arg.startsWith('-'));
if (filterArg && !process.env.CORE_MATCH) {
  process.env.CORE_MATCH = filterArg;
}

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

  /**
   * 浏览器安全：内核 / 应用 / 渲染层的代码都会被打包进浏览器，那里没有 Node 的
   * `process` 全局量。曾经 `engine.ts` 的自动推进循环里直接读
   * `process.env.PUMP_DEBUG`，于是**每一次有 AI 座位的动作**都在浏览器里抛
   * `ReferenceError`（联机房间与单机 AI 桌都会走到），只有 UI 矩阵能发现它。
   * 这条静态检查把它挡在提交前：上述目录里除了显式 `globalThis` 探测，不许出现
   * `process.<x>`。
   */
  const browserDirs = ['packages/kernel/src', 'packages/app/src', 'packages/net/src', 'apps/web/src'];
  const processRef = /(?<![.\w$])process\s*(?:\.|\[)/;
  const allowed = /globalThis/;

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

  // 浏览器安全扫描：只认代码行（注释里提到 `process.env` 是说明，不是引用）。
  for (const dir of browserDirs) {
    for (const file of listTs(dir)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        // 只扫代码行：块注释 / 行注释 / JSDoc 里提到 `process.env` 是说明，不是引用。
        const code = line.replace(/\/\/.*$/, '').trim();
        if (!code || code.startsWith('*') || code.startsWith('/*')) return;
        if (!processRef.test(code)) return;
        // `globalThis.process?.env` 是允许的显式探测。
        if (allowed.test(code)) return;
        failures.push(`${file}:${index + 1}: browser-safe process access required — ${line.trim()}`);
      });
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
  const filterLabel = process.env.CORE_MATCH ? ` (filter: "${process.env.CORE_MATCH}")` : '';

  console.log(`\nUniversal Board Game Kernel — conformance suite${shardLabel}${filterLabel}\n`);

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

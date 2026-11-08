#!/usr/bin/env node
/**
 * 宪章覆盖报告（docs/KERNEL-CHARTER.md 的落地检查）。
 *
 * 逐个模组、逐条条款判定三种状态：
 *   - covered    有机器可判定的断言（schema / 不变量 / 账本 / 投影）
 *   - deviation  在 module.charter.deviations 里登记了偏离（带理由与到期日）
 *   - gap        既无断言也无登记
 *
 * 条款分两类：
 *   - 可判定（C-1 / C-2 / C-5 / C-6 / C-7 / C-9）：判据与
 *     packages/kernel/src/charter.ts 的执行器一致。
 *   - 需审计（C-3 / C-4 / C-8）：当前没有可静态判定的信号，只打印。
 *
 * 退出码暂时恒为 0：报告先挂进 `pnpm verify` 让缺口可见，但现有的 4 处缺口
 * （splendor 的 C-5、splendor / betrayal / dune 的 C-7）是已知的，由后续 PR
 * 补账本与投影。那些 PR 落地、`gaps` 归零之后，把下面的 exitCode 改成
 * `gaps === 0 ? 0 : 1`，从此缺口即 CI 失败。
 *
 * 只读模组声明，不跑对局，因此很便宜。
 */
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

/** 从声明上就能判定的条款。返回 'covered' | 'deviation' | 'gap'。 */
const CHECKABLE = [
  {
    id: 'C-1',
    name: '动作代数',
    status: m => (m.actionSchemas ? 'covered' : 'gap')
  },
  {
    id: 'C-2',
    name: '单步转移',
    // 执行器默认强制单步；只有登记了偏离才放行，所以未登记即已覆盖。
    status: m => (deviation(m, 'C-2') ? 'deviation' : 'covered')
  },
  {
    id: 'C-5',
    name: '信息约束',
    // 有投影函数，或显式声明 AI 入口已收口到投影。
    status: m => (deviation(m, 'C-5') ? 'deviation' : m.project || m.charter?.requiresProjection ? 'covered' : 'gap')
  },
  {
    id: 'C-6',
    name: '语义不变量',
    status: m => (deviation(m, 'C-6') ? 'deviation' : m.checkInvariants ? 'covered' : 'gap')
  },
  {
    id: 'C-7',
    name: '收益独立',
    status: m => (deviation(m, 'C-7') ? 'deviation' : m.charter?.requiresRewardLedger ? 'covered' : 'gap')
  },
  {
    id: 'C-9',
    name: '扩展字段收口',
    status: m => (deviation(m, 'C-9') ? 'deviation' : m.meta?.stateSchema?.globalVars ? 'covered' : 'gap')
  }
];

/** 目前只能靠人工审计的条款：报告里列出，但不作为失败条件。 */
const AUDIT_ONLY = [
  { id: 'C-3', name: '效果可组合' },
  { id: 'C-4', name: '区域所有权' },
  { id: 'C-8', name: '终止可判定' }
];

function deviation(module, clause) {
  return (module.charter?.deviations ?? []).find(entry => entry.clause === clause);
}

const MARK = { covered: '✓', deviation: '~', gap: '✗' };
const LABEL = { covered: '断言', deviation: '偏离', gap: '无' };

const server = await createServer({
  configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error'
});

let exitCode = 1;
try {
  const { GAME_MODULES } = await server.ssrLoadModule('@rds/games/registry.ts');

  let gaps = 0;
  const header = ['模组'.padEnd(14, ' '), ...CHECKABLE.map(clause => clause.id.padEnd(8, ' '))].join(' ');
  console.log('\n宪章覆盖（✓ 有断言   ~ 已登记偏离   ✗ 无覆盖）\n');
  console.log(`  ${header}`);

  for (const gameModule of GAME_MODULES) {
    const cells = CHECKABLE.map(clause => {
      const status = clause.status(gameModule);
      if (status === 'gap') gaps += 1;
      return `${MARK[status]} ${LABEL[status]}`.padEnd(7, ' ');
    });
    console.log(`  ${String(gameModule.meta.id).padEnd(14, ' ')} ${cells.join(' ')}`);
  }

  // 偏离必须自带理由，否则登记形同虚设。
  const bareDeviations = [];
  for (const gameModule of GAME_MODULES) {
    for (const entry of gameModule.charter?.deviations ?? []) {
      if (!entry.reason || entry.reason.trim().length === 0) {
        bareDeviations.push(`${gameModule.meta.id} ${entry.clause}`);
      }
    }
  }

  console.log(`\n  需人工审计（不计入失败）：${AUDIT_ONLY.map(clause => clause.id).join(' / ')}`);
  console.log(`  ${GAME_MODULES.length} 个模组，${CHECKABLE.length} 条可判定条款，${gaps} 处无覆盖\n`);

  for (const item of bareDeviations) console.log(`  ✗ 偏离缺少理由：${item}`);
  if (gaps > 0) {
    console.log('  （缺口已记录，暂不阻断 CI；补齐后把 exitCode 改成按 gaps 判定）\n');
  }
  exitCode = 0;
} catch (error) {
  console.error('覆盖报告失败:', error);
} finally {
  await server.close();
}

process.exit(exitCode);

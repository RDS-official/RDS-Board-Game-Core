#!/usr/bin/env node
/**
 * 统一质量入口（issue #233 的第一步）。
 *
 * 仓库里 probe / verify / shoot / test 四套前缀共 40+ 条命令，新人记不住哪个该在
 * 什么时候跑。这里只做**一层薄映射**：不改任何旧脚本，也不删 package.json 里的
 * 条目 —— 旧命令继续可用，新入口只是把它们按意图分组。
 *
 *   pnpm qa                    列出所有分组
 *   pnpm qa gate --changed     提交前增量闸门（默认）
 *   pnpm qa gate --all         全量闸门
 *   pnpm qa test poker         单个夹具的内核用例
 *   pnpm qa ui                 Playwright UI 矩阵
 *   pnpm qa probe board        任意 probe:<name>
 *   pnpm qa docs               文档路径校验
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const GROUPS = {
  gate: {
    help: '质量闸门（verify.mjs）：--changed（默认） / --fast / --all',
    run: args => ['node', ['scripts/verify.mjs', ...(args.length ? args : ['--changed'])]]
  },
  test: {
    help: '内核一致性用例：pnpm qa test <关键字>（空 = 全量）',
    run: args => ['node', ['scripts/test-core.mjs', ...args]]
  },
  ui: {
    help: 'Playwright UI 矩阵 + 卡面 overlay 探针',
    run: () => ['node', ['scripts/test-ui-matrix.mjs']]
  },
  probe: {
    help: '任意探针：pnpm qa probe <board|layout|overlap|a11y|hand|...>',
    run: ([name, ...rest]) => {
      if (!name) throw new Error('用法：pnpm qa probe <名字>');
      return ['node', [`scripts/probe-${name}.mjs`, ...rest]];
    }
  },
  docs: {
    help: '文档路径校验',
    run: () => ['node', ['scripts/check-doc-paths.mjs']]
  },
  lint: {
    help: 'Biome lint（0 error 基线）',
    run: () => ['node', ['node_modules/@biomejs/biome/bin/biome', 'lint', '.', '--diagnostic-level=error']]
  }
};

function printGroups() {
  console.log('可用分组：');
  for (const [name, group] of Object.entries(GROUPS)) console.log(`  ${name.padEnd(6)} ${group.help}`);
}

const [groupName, ...rest] = process.argv.slice(2);
if (!groupName || groupName === '--help' || groupName === 'list') {
  printGroups();
  process.exit(0);
}
const group = GROUPS[groupName];
if (!group) {
  console.error(`未知分组：${groupName}`);
  printGroups();
  process.exit(2);
}
const [command, args] = group.run(rest);
const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', code => process.exit(code ?? 1));

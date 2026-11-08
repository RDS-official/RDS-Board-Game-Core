#!/usr/bin/env node
/**
 * 随机源守卫。
 *
 * 规则代码里出现 `Math.random()` 会让同一颗种子走出两条牌序：回放哈希对不上，
 * 「同种子可复现」这条不变量就破了。随机只能来自内核的 PRNG
 * （`packages/kernel/src/prng.ts`，经 `ctx.rng` 取用）。
 *
 * 只扫代码行：注释里解释"为什么不用 Math.random"是允许的。
 * 退出码：发现调用为 1，否则为 0。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['packages/games/src', 'packages/kernel/src'];
const CALL = /Math\.random\s*\(/;

function listTs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listTs(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

const hits = [];
for (const root of ROOTS) {
  for (const file of listTs(root)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, '').trim();
        if (!code || code.startsWith('*') || code.startsWith('/*')) return;
        if (CALL.test(code)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
      });
  }
}

if (hits.length === 0) {
  console.log(`rng: ${ROOTS.join(' / ')} 中没有 Math.random() 调用`);
  process.exit(0);
}

console.log(`rng: 发现 ${hits.length} 处 Math.random()，随机必须走内核 PRNG：\n`);
for (const hit of hits) console.log(`  ${hit}`);
process.exit(1);

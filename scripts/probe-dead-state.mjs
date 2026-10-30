#!/usr/bin/env node
/**
 * 死状态字段探针
 *
 * 为什么需要
 * ----------
 * 本仓库已经踩过三次同类问题：
 *   - ItemDef.passive：板甲写着「减免 1 点伤害」，全仓库零读取 → 卡牌等于没有效果
 *   - customProps.maskWorn：面具的修正逻辑挂在一个没人设置/读取的开关上
 *   - globalVars.lastHauntRoll：作祟检定把结果写进没人读的字段 → 骰子浮层永远静默
 *
 * 共同点：tsc 通过、测试通过、日志也有输出，只是**效果不存在**。人眼审不出来。
 *
 * 实现说明（重要）
 * ----------------
 * 本仓库用的是 TypeScript 7（原生预览版），没有经典 JS AST API（只有 tsc.js），
 * 所以这里用「去注释 + 去字符串字面量 + 精确分类」的启发式扫描：
 *   1. 先把注释、字符串、模板字面量替换成等长占位符 —— 避免 '/api/auth/register'
 *      这类字符串被误当成一次「读取」。
 *   2. 只统计模块自定义状态袋上的属性访问；同一状态袋在投影态里可能叫别的名字
 *      （渲染层常用 globals / vars），用 CANON 归一到同一个袋。
 *   3. 写入 = 访问后紧跟 = / += / -= / ++ / --；其余算读取（含解构）。
 *   4. 动态键访问 X[expr] 或整袋替换无法静态判定，会在报告里标注。
 *
 * 因此它是**启发式**，不是编译器级分析：报告出的每一条都需要人确认一次，
 * 但它能把候选集从上百个字段稳定缩到个位数。
 *
 * 用法
 * ----
 *   node scripts/probe-dead-state.mjs
 *   node scripts/probe-dead-state.mjs --strict   # 有发现即退出码 1
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = [
  "packages/games/src",
  "packages/app/src",
  "packages/kernel/src",
  "packages/harness/src",
  "apps/web/src",
  "apps/server/src"
];
/** 袋名 → 规范名。同一份状态在别处的局部叫法都要归一。 */
const CANON = {
  customProps: "customProps",
  globalVars: "globalVars",
  globals: "globalVars",
  vars: "globalVars"
};
const BAGS = Object.keys(CANON);

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "build") continue;
      walk(full, out);
    } else if (/\.(ts|tsx|mts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** 把注释与字符串字面量替换成等长空白，保持行号与偏移不变。 */
function stripNonCode(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const two = text.slice(i, i + 2);
    if (two === "//") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === quote) { j += 1; break; }
        j += 1;
      }
      const inner = Math.max(0, j - i - 2);
      out += quote + " ".repeat(inner) + quote;
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const files = SCAN_DIRS.flatMap(dir => walk(path.join(ROOT, dir)));
const stats = new Map();
const dynamic = new Set();

function record(bagName, name, kind, where) {
  const bag = CANON[bagName];
  const key = bag + "." + name;
  const entry = stats.get(key) ?? { bag, name, writes: [], reads: [] };
  (kind === "write" ? entry.writes : entry.reads).push(where);
  stats.set(key, entry);
}

for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const code = stripNonCode(fs.readFileSync(file, "utf8"));
  const lineAt = idx => code.slice(0, idx).split("\n").length;

  for (const bag of BAGS) {
    const bracket = new RegExp("\\b" + bag + "\\s*(?:\\?\\s*)?\\.?\\s*\\[", "g");
    for (const m of code.matchAll(bracket)) {
      const after = code.slice(m.index + m[0].length);
      const firstChar = after.trimStart()[0];
      if (firstChar !== "'" && firstChar !== '"') { dynamic.add(CANON[bag]); continue; }
      const quote = firstChar;
      const rest = after.trimStart().slice(1);
      const close = rest.indexOf(quote);
      if (close < 0) continue;
      const name = rest.slice(0, close);
      if (!name) continue;
      const tail = rest.slice(close + 1);
      const isWrite = /^\s*\]\s*(?:=(?!=)|\+=|-=|\*=|\/=|\+\+|--)/.test(tail);
      record(bag, name, isWrite ? "write" : "read", rel + ":" + lineAt(m.index));
    }

    if (new RegExp("\\b" + bag + "\\s*=(?!=)", "g").test(code)) dynamic.add(CANON[bag]);

    const dot = new RegExp("\\b" + bag + "\\s*(?:\\?\\s*)?\\.\\s*([A-Za-z_$][\\w$]*)", "g");
    for (const m of code.matchAll(dot)) {
      const name = m[1];
      const after = code.slice(m.index + m[0].length);
      const isWrite = /^\s*(?:=(?!=)|\+=|-=|\*=|\/=|\+\+|--)/.test(after);
      record(bag, name, isWrite ? "write" : "read", rel + ":" + lineAt(m.index));
    }

    const spread = new RegExp("\\.\\.\\.\\s*" + bag + "[\\s\\S]{0,300}?\\}", "g");
    for (const m of code.matchAll(spread)) {
      for (const key of m[0].matchAll(/(?:^|[,{]\s*)([A-Za-z_$][\w$]*)\s*:/g)) {
        if (key[1]) record(bag, key[1], "write", rel + ":" + lineAt(m.index + key.index));
      }
    }

    // 说明：`customProps: { ... }` 这种初始化式写入暂不识别。实测按 2000 字符窗口
    // 去抓对象字面量会把无关的键一起吞进来，误报反而更多，所以这里宁可漏报。
    // 后果是「只读不写」方向的结论不可靠 —— 因此本探针只报告「只写不读」。
    const destruct = new RegExp("\\{([^{}]*)\\}\\s*=\\s*[\\w.$]*" + bag + "\\b", "g");
    for (const m of code.matchAll(destruct)) {
      for (const key of m[1].matchAll(/([A-Za-z_$][\w$]*)/g)) {
        if (!key[1].startsWith("_")) record(bag, key[1], "read", rel + ":" + lineAt(m.index));
      }
    }
  }
}

const dead = [...stats.values()]
  .filter(item => item.writes.length > 0 && item.reads.length === 0)
  .sort((a, b) => a.name.localeCompare(b.name));

console.log("死状态字段探针 — 扫描 " + files.length + " 个文件，覆盖 " + stats.size + " 个状态字段");
if (dynamic.size > 0) {
  console.log("  注意：" + [...dynamic].join(" / ") + " 存在动态键访问或整袋替换，下列结论需人工复核。");
}
console.log("");

if (dead.length === 0) {
  console.log("✓ 没有「只写不读」的状态字段");
} else {
  console.log("✗ 只写不读（" + dead.length + "）—— 写入方以为在起作用，其实没人消费：");
  for (const item of dead) {
    console.log("");
    console.log("  " + item.bag + "." + item.name);
    for (const where of item.writes.slice(0, 4)) console.log("      写于 " + where);
  }
}

if (process.argv.includes("--strict") && dead.length > 0) process.exit(1);

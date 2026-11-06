import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';
import { html, isSafeHtml, raw } from '../apps/web/src/ui/dom/html';

/**
 * HTML hygiene gate (AR-21 / issue #216).
 *
 * `el.innerHTML = …` is the one API in the UI layer that turns a string into
 * markup. Every such call is an injection sink unless the string was escaped by
 * hand — which is exactly the failure mode issue #216 recorded (43 assignments
 * and 101 interpolation holes in `hud.ts` alone, four duplicated `esc*` copies).
 *
 * Two things are enforced here:
 *
 * 1. **Behaviour** of the `html` tagged template: interpolations are escaped by
 *    default, `SafeHtml` passes through, arrays flatten, null/undefined/false
 *    render empty. These assertions are the contract every panel relies on.
 * 2. **A ratchet** on the remaining `innerHTML` sinks. Files listed in
 *    `BASELINE` may keep their current count; nothing may grow, and new files
 *    must not introduce a sink at all. When a file is migrated its baseline goes
 *    to 0 and can never come back.
 *
 * Run: node node_modules/tsx/dist/cli.mjs scripts/check-html-hygiene.ts
 * Refresh the baseline after a migration: --print-baseline
 */

const SRC = 'apps/web/src';

/**
 * Sanctioned sinks. `dom/html.ts` is the single writer; `dom/keyed.ts` parses a
 * fragment into a `<template>` and reads it back, which is the same trust
 * boundary as `setHtml`.
 */
const ALLOWED = new Set(['ui/dom/html.ts', 'ui/dom/keyed.ts']);

/**
 * Remaining sinks per file (relative to `apps/web/src`), all tracked by #216.
 * The number may only go down: `count <= budget` fails otherwise.
 *
 * Empty since the last migration: every panel now writes through
 * `setHtml(el, html`…`)`. Adding an entry here is a stop-the-line decision, not
 * a convenience — new markup goes through the tagged template.
 */
const BASELINE: Record<string, number> = {};

const FORBIDDEN = [
  { pattern: /\.outerHTML\s*=/, rule: 'outerHTML 赋值' },
  { pattern: /\.insertAdjacentHTML\s*\(/, rule: 'insertAdjacentHTML' },
  { pattern: /document\.write(?:ln)?\s*\(/, rule: 'document.write' }
];

const SINK = /\.innerHTML\s*(?:\+?=)/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function countSinks(file: string): number {
  const text = readFileSync(file, 'utf8');
  // Ignore prose: a doc comment that mentions `innerHTML = …` is not a sink.
  const code = text
    .split('\n')
    .map(line => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return '';
      return line;
    })
    .join('\n');
  return (code.match(SINK) ?? []).length;
}

const failures: string[] = [];
const counts: Record<string, number> = {};

for (const file of walk(SRC)) {
  const rel = relative(SRC, file).replace(/\\/g, '/');
  const sinks = countSinks(file);
  const text = readFileSync(file, 'utf8');

  for (const { pattern, rule } of FORBIDDEN) {
    if (pattern.test(text)) failures.push(`${rel}: 使用了 ${rule}，请改用 setHtml / html 模板`);
  }

  if (sinks === 0) continue;
  counts[rel] = sinks;
  if (ALLOWED.has(rel)) continue;
  const budget = BASELINE[rel];
  if (budget === undefined) {
    failures.push(`${rel}: 新增 ${sinks} 处 innerHTML 赋值，请改用 setHtml(el, html\`…\`)`);
  } else if (sinks > budget) {
    failures.push(`${rel}: innerHTML 赋值从 ${budget} 增至 ${sinks} 处（#216 只允许减少）`);
  }
}

/* ------------------------------------------------------------------ */
/* Behaviour of the tagged template                                    */
/* ------------------------------------------------------------------ */

function check(name: string, actual: string, expected: string): void {
  if (actual !== expected) {
    failures.push(
      `html 模板：${name} — 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`
    );
  }
}

check('文本插值被转义', String(html`<p>${'<b>x</b>'}</p>`), '<p>&lt;b&gt;x&lt;/b&gt;</p>');
check(
  '属性引号被转义',
  String(html`<div title="${'a" onmouseover="alert(1)'}">x</div>`),
  '<div title="a&quot; onmouseover=&quot;alert(1)">x</div>'
);
check('嵌套片段原样插入', String(html`<p>${html`<b>${'&'}</b>`}</p>`), '<p><b>&amp;</b></p>');
check('数组递归展开且逐个转义', String(html`${['<a>', html`<b>`, '<c>']}`), '&lt;a&gt;<b>&lt;c&gt;');
check('空值渲染为空', String(html`${null}${undefined}${false}|`), '|');
check('数字正常', String(html`${0}-${12}`), '0-12');
check('raw 原样插入', String(html`${raw('<i>x</i>')}`), '<i>x</i>');
check('未知对象当文本', String(html`${{ a: 1 }}`), '[object Object]');
check('返回值是 SafeHtml', String(isSafeHtml(html``)), 'true');

if (process.argv.includes('--print-baseline')) {
  console.log(JSON.stringify(counts, null, 2));
  process.exit(0);
}

if (failures.length > 0) {
  console.error(`\nHTML hygiene: ${failures.length} 项失败\n`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}

const remaining = Object.values(counts).reduce((sum, n) => sum + n, 0);
console.log(
  `HTML hygiene ok — html 模板 9 条断言通过；仍有 ${remaining} 处 innerHTML 赋值待迁移（#216，基线内）`
);

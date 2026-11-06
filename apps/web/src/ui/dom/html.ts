import { escapeHtml } from '../../htmlEscape';

/**
 * `html` tagged template —安全默认值的 HTML 拼装。
 *
 * ## 为什么
 *
 * 以前所有面板都是 `el.innerHTML = \`<div>${esc(name)}</div>\``，安全性完全依赖
 * **每一处插值都记得调 `esc`**。漏一处就是 XSS，而漏没漏只能靠 review。仅
 * `hud.ts` 就有 43 个赋值点、101 个插值孔，靠人眼守住不现实（issue #216）。
 *
 * `html` 把默认值反过来：**插值默认被转义**，只有显式 `raw()`（或另一个
 * `html` 片段）才会作为标记插入。
 *
 * ```ts
 * setHtml(el, html`<div class="name">${player.name}</div>`);
 * setHtml(el, html`<ul>${rows.map(row => html`<li>${row.label}</li>`)}</ul>`);
 * setHtml(el, html`${raw(trustedSvg)}`); // 仅限本仓库自己生成的标记
 * ```
 *
 * ## 契约
 *
 * - 字符串 / 数字 / 布尔 / null / undefined 作为**文本**插入，五个 HTML 敏感字符
 *   被转义；`null` / `undefined` / `false` 渲染为空。
 * - 数组递归展开（`map` 的返回值可以直接插，不用 `.join('')`——`join` 会把片段
 *   拍平成字符串，反而丢掉"已转义"的身份）。
 * - `SafeHtml`（`html` 的返回值或 `raw()`）原样插入。
 * - 其它对象按 `String(value)` 当文本处理：宁可显示 `[object Object]`，也不静默
 *   把未知对象当标记塞进 DOM。
 *
 * 这个模块是 `innerHTML` 的唯一合法出口（见 `scripts/check-html-hygiene.mjs`）。
 */

const SAFE_HTML = Symbol('rds.safeHtml');

export interface SafeHtml {
  readonly [SAFE_HTML]: true;
  readonly value: string;
  toString(): string;
}

export type HtmlValue =
  | SafeHtml
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly HtmlValue[];

export function isSafeHtml(value: unknown): value is SafeHtml {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<SafeHtml>)[SAFE_HTML] === true
  );
}

function makeSafe(value: string): SafeHtml {
  return {
    [SAFE_HTML]: true,
    value,
    toString() {
      return value;
    }
  };
}

/** 标记一段**由本仓库生成**的标记为可信。用于拼接 SVG、`<option>` 列表等。 */
export function raw(value: string | number | SafeHtml): SafeHtml {
  return isSafeHtml(value) ? value : makeSafe(String(value));
}

function render(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) return '';
  if (isSafeHtml(value)) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(value);
}

/**
 * 拼装一段 HTML。插值默认转义；`SafeHtml`（`html` / `raw` 的返回值）原样插入。
 */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + (strings[i + 1] ?? '');
  }
  return makeSafe(out);
}

/**
 * 把模板写进元素。
 *
 * 唯一的 DOM 写入点：所有面板都走这里，`innerHTML` 不再散落在 UI 代码里。
 * 只接受 `SafeHtml`，因此"忘了转义"在类型层面就编译不过。
 */
export function setHtml(element: Element | null | undefined, value: SafeHtml): void {
  if (!element) return;
  element.innerHTML = value.value;
}

/** 便捷：把片段数组拼成一段（等价于 `html` 的数组插值）。 */
export function joinHtml(values: readonly HtmlValue[]): SafeHtml {
  return makeSafe(render(values));
}

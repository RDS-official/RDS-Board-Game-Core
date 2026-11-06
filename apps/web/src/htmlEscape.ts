/**
 * HTML 转义（唯一实现）。
 *
 * 以前全仓有 4 份：`hud.ts` 的 `escHtml` / `escapeAttr`、`main.ts` 的 `escText`、
 * `render/webglSupport.ts` 的 `escapeHtml`。四份对 `'` 的处理还不一致（`&#39;` 与
 * `&#039;`），改一处很容易漏掉另外三处（issue #216）。
 *
 * 只转义进入 HTML 文本 / 属性值的五个字符；不做 URL 编码，也不假设输入是字符串。
 */
const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, ch => ENTITIES[ch] as string);
}

export default escapeHtml;

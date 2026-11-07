import { escapeHtml } from '../htmlEscape.ts';
import type { KeyBinding } from './keymap.ts';
import { keymapRows } from './keymap.ts';

/**
 * `? ` 快捷键清单的标记。
 *
 * 只做排版，数据一律来自 `keymap.ts`：清单与真实键位同源，改一处不会只改一半。
 * 纯函数（不碰 DOM）以便 Node 里直接断言——探针会塞进带 `<` 的假键位，验证所有
 * 文本都被转义。
 */
export function shortcutHelpHtml(bindings?: readonly KeyBinding[]): string {
  const rows = keymapRows(bindings).map(
    group => `
      <section class="sc-group" aria-label="${escapeHtml(group.title)}">
        <h3 class="sc-group-title">${escapeHtml(group.title)}<span class="sc-group-hint">${escapeHtml(
          group.hint
        )}</span></h3>
        <dl class="sc-rows">
          ${group.bindings
            .map(
              binding =>
                `<div class="sc-row" data-keymap-id="${escapeHtml(binding.id)}">` +
                `<dt><kbd class="sc-key">${escapeHtml(binding.keys)}</kbd></dt>` +
                `<dd>${escapeHtml(binding.label)}</dd></div>`
            )
            .join('')}
        </dl>
      </section>`
  );
  if (rows.length === 0) return '';
  return `<div class="shortcut-rows">${rows.join('')}</div>`;
}

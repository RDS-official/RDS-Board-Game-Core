/**
 * 键位表（Keymap）——全局键位的唯一事实来源。
 *
 * 审查 `docs/INTERACTION-AUDIT.md` G4 指出：数字键、Enter、←→ 这些入口一直能用，
 * 但界面上从来没有地方写清楚，玩家只能靠猜。这里把「有哪些键、各自做什么、属于
 * 哪一组」收成一份纯数据，于是：
 *
 * - `? ` 快捷键清单（`shortcutHelp.ts`）直接从这张表渲染，不会漏项；
 * - `main.ts` 的分发与「可编辑区域」判断也走这里的守卫，不再各写一遍
 *   `instanceof HTMLInputElement`（那条旧判断漏了 `<select>` 与 contenteditable，
 *   即 G12）；
 * - `scripts/probe-keymap.mjs` 断言这张表自洽，新增键位却没写进清单会当场报红。
 *
 * 约束：本模块是纯数据 + 纯函数，**不依赖 DOM 全局对象**。`isEditableTarget`
 * 用结构化判断（读 `tagName` / `isContentEditable` / `closest`），因此可以用普通
 * 假对象在 Node 里单测，不需要 jsdom。
 */

/** 清单里的分组顺序，同时也是渲染顺序。 */
export type KeymapGroup = 'global' | 'actions' | 'hand' | 'panels';

export interface KeyBinding {
  /** 稳定 id：探针断言唯一，清单与下发都靠它对齐。 */
  id: string;
  /** 键帽上印的样子，例如 `Esc`、`1 – 9`、`← / →`。 */
  keys: string;
  /** 一句话说明这个键干什么，用词与界面文案保持一致。 */
  label: string;
  group: KeymapGroup;
}

export const KEYMAP_GROUPS: ReadonlyArray<{ id: KeymapGroup; title: string; hint: string }> = [
  { id: 'global', title: '全局', hint: '任何非输入状态下都可用' },
  { id: 'actions', title: '动作', hint: '动作栏 / 动作手牌' },
  { id: 'hand', title: '手持位', hint: '聚焦手持出牌区之后' },
  { id: 'panels', title: '面板与浮层', hint: '浮层打开期间' }
];

/**
 * 全部键位。增删都改这里：清单、守卫、探针共用同一份。
 *
 * 只列**已经实现**的键；计划中的键不进表（否则清单会撒谎）。
 */
export const KEYMAP: readonly KeyBinding[] = [
  { id: 'help', keys: '?', label: '打开这张快捷键清单', group: 'global' },
  { id: 'escape', keys: 'Esc', label: '关掉最上层浮层；取消放置与目标选择', group: 'global' },
  { id: 'inspector', keys: 'I', label: '展开 / 收起内核检查器', group: 'global' },
  {
    id: 'actions.digits',
    keys: '1 – 9',
    label: '执行第 N 个动作；需要参数的动作会先开详情',
    group: 'actions'
  },
  { id: 'hand.cycle', keys: '← / →', label: '切换上一张 / 下一张动作卡', group: 'hand' },
  { id: 'hand.activate', keys: 'Enter', label: '执行当前动作卡（复杂动作展开详情）', group: 'hand' },
  { id: 'hand.wheel', keys: '滚轮 / 横向拖拽', label: '在手牌里滑动切换动作卡', group: 'hand' },
  { id: 'panels.focus', keys: 'Tab', label: '在打开的面板内循环焦点', group: 'panels' },
  { id: 'dice.advance', keys: 'Enter / Space', label: '推进骰子过场', group: 'panels' }
];

/** `localStorage` 里「已经提示过一次快捷键」的标记。 */
export const SHORTCUT_HINT_KEY = 'rds.shortcuts.hinted';

/** 按 `KEYMAP_GROUPS` 的顺序把键位分组；空组会被丢掉，免得清单出现空标题。 */
export function keymapRows(
  bindings: readonly KeyBinding[] = KEYMAP
): Array<{ id: KeymapGroup; title: string; hint: string; bindings: KeyBinding[] }> {
  return KEYMAP_GROUPS.map(group => ({
    id: group.id,
    title: group.title,
    hint: group.hint,
    bindings: bindings.filter(binding => binding.group === group.id)
  })).filter(group => group.bindings.length > 0);
}

/** Esc 的两个常见写法：标准值与部分浏览器/输入法给出的 `Esc`。 */
export function isEscapeKey(key: string): boolean {
  return key === 'Escape' || key === 'Esc';
}

/** `?`：中文输入法下会给出全角 `？`，两者都算。 */
export function isHelpKey(key: string): boolean {
  return key === '?' || key === '？';
}

/** 结构化地看「这个事件目标是不是一个文本输入控件」。 */
interface EditableLike {
  tagName?: unknown;
  isContentEditable?: unknown;
  closest?: unknown;
}

/**
 * 目标是否在可编辑控件里：`input` / `textarea` / `select` / contenteditable。
 *
 * 旧实现只看 `HTMLInputElement`，于是焦点停在 `<select>`（认知滤镜、局内场景）
 * 或 contenteditable 区域时按数字键仍会执行动作——正是 G12 描述的漏水。
 */
export function isEditableTarget(target: EventTarget | null | undefined): boolean {
  const element = target as EditableLike | null | undefined;
  if (!element || typeof element !== 'object') return false;

  const tag = String(element.tagName ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION') return true;
  if (element.isContentEditable === true) return true;
  if (typeof element.closest === 'function') {
    try {
      return Boolean(
        (element.closest as (selector: string) => unknown).call(
          element,
          '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'
        )
      );
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * 这一次按键该不该由游戏处理。
 *
 * 规则只有一条：**Esc 永远有效**（参数表单打开时焦点就在滑块上，全局守卫把它吞掉
 * 的话玩家只剩关页面这一条路），其余键在可编辑控件里一律让给浏览器。
 */
export function shouldHandleKey(event: {
  key: string;
  target?: EventTarget | null;
}): boolean {
  if (isEscapeKey(event.key)) return true;
  return !isEditableTarget(event.target ?? null);
}

/**
 * 首屏这一次性提示要不要弹。
 *
 * `storage` 传 `null`（无痕模式 / 被策略禁用）时返回 false：提示只是锦上添花，
 * 存储不可用时宁可安静，也不要每次刷新都弹一遍。
 */
export function shouldShowShortcutHint(
  storage: { getItem(key: string): string | null } | null | undefined
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(SHORTCUT_HINT_KEY) !== '1';
  } catch {
    return false;
  }
}

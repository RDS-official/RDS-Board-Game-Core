/**
 * Action-hand markup probe.
 *
 * Guards `apps/web/src/ui/actionHandHtml.ts` — the string builder the HUD will
 * `setHtml()` into the unified hand container. Pure, no browser.
 *
 * Proves:
 *   1. One button per card, keyed by data-action-id, in hand order.
 *   2. Each card carries its fan transform (--x/--s/--r/--z).
 *   3. Badges appear for selection / fields / placement and not for none.
 *   4. All text is escaped (a `<b>` label cannot inject markup).
 *   5. Empty hand emits nothing (callers can hide the shell).
 *
 * Run: node scripts/probe-action-hand-html.mjs   (or `pnpm probe:action-hand-html`)
 */

import { layoutActionHand } from '../apps/web/src/ui/actionHand.ts';
import { actionHandHtml } from '../apps/web/src/ui/actionHandHtml.ts';

const failures = [];
function check(ok, msg) {
  if (!ok) failures.push(msg);
  return ok;
}
function eq(a, b, msg) {
  return check(a === b, `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function contains(hay, needle, msg) {
  return check(hay.includes(needle), `${msg}: missing ${JSON.stringify(needle)}`);
}

const base = (over = {}) => ({ id: 'a', icon: '✦', label: 'A', hint: '', tone: 'normal', ...over });
const selection = { spec: { min: 1, max: 1 }, candidates: [{ id: 'p', label: 'P' }] };
const amount = { key: 'amount', label: 'Amount', kind: 'number', widget: 'slider', min: 1, max: 9 };

const ACTIONS = [
  base({ id: 'end', actionType: 'END_TURN', label: '结束回合' }),
  base({ id: 'move', highlightIds: ['n1'], label: '移动' }),
  base({ id: 'hit', selection, label: '攻击' }),
  base({ id: 'bet', fields: [amount], label: '下注' }),
  base({ id: 'build', placementEntityId: 'slot:1', label: '建造' }),
];

const view = layoutActionHand(ACTIONS, { containerWidth: 900, cardWidth: 96, focusX: 0.5 });
const out = actionHandHtml(view);

/* 1. one button per card, keyed, in order */
const ids = [...out.matchAll(/data-action-id="([^"]+)"/g)].map((m) => m[1]);
eq(ids.length, ACTIONS.length, 'card count');
check(ids.join(',') === ACTIONS.map((a) => a.id).join(','), 'card order matches hand order');

/* 2. fan transform on every card */
check(
  (out.match(/style="--x:[-\d.]+px;--s:[-\d.]+;--r:[-\d.]+deg;--z:[-\d.]+;--lift:[-\d.]+"/g) || []).length ===
    ACTIONS.length,
  'every card carries a fan transform',
);

/* 3. badges by intake mode */
check(out.includes('data-target-mode="selection"'), 'selection card tagged');
const badgeCount = (out.match(/class="ah-badge"/g) || []).length;
eq(badgeCount, 3, 'exactly three badges (selection/fields/placement)');
contains(out, '>◎<', 'selection badge glyph');
contains(out, '>#<', 'fields badge glyph');
contains(out, '>⌖<', 'placement badge glyph');

/* 4. escaping */
const evil = [base({ id: 'x', label: '<b>pwn</b>', hint: 'a"b' })];
const evilOut = actionHandHtml(layoutActionHand(evil, { containerWidth: 400, cardWidth: 96 }));
check(!evilOut.includes('<b>pwn</b>'), 'raw markup is escaped');
contains(evilOut, '&lt;b&gt;pwn&lt;/b&gt;', 'label escaped');
contains(evilOut, 'a&quot;b', 'hint attribute escaped');

/* 5. empty hand */
eq(actionHandHtml({ cards: [], count: 0, focusIndex: null }), '', 'empty hand emits nothing');

/* 6. inline SVG icons stay markup; other markup-looking strings are escaped */
const svgIcon = '<svg viewBox="0 0 32 32" width="30" height="30"><path d="M0 0"/></svg>';
const iconView = actionHandHtml(
  layoutActionHand([base({ id: 'svg-icon', icon: svgIcon })], { containerWidth: 400, cardWidth: 96 }),
);
contains(iconView, '<svg viewBox="0 0 32 32"', 'svg icon rendered as markup');
check(!iconView.includes('&lt;svg'), 'svg icon is not escaped');

const badIcon = '<img src=x onerror=alert(1)>';
const badView = actionHandHtml(
  layoutActionHand([base({ id: 'bad-icon', icon: badIcon })], { containerWidth: 400, cardWidth: 96 }),
);
check(!badView.includes('<img'), 'non-svg markup is escaped');
contains(badView, '&lt;img', 'non-svg markup escaped form');

/* 7. real board artwork replaces the generic icon, not the action wording */
const artOut = actionHandHtml(view, (card) => (card.id === 'hit' ? 'data:image/png;base64,AA==' : undefined));
eq((artOut.match(/class="ah-art"/g) || []).length, 1, 'one card uses real artwork');
eq((artOut.match(/ah-with-art/g) || []).length, 1, 'art card is styled separately');
contains(artOut, 'src="data:image/png;base64,AA=="', 'artwork URL retained');
contains(artOut, '<span class="ah-action-label">攻击</span>', 'action wording retained under artwork');
eq((artOut.match(/class="ah-ico"/g) || []).length, ACTIONS.length - 1, 'other cards keep icon fallback');

/* aria-label present on every button */
eq((out.match(/aria-label="/g) || []).length, ACTIONS.length, 'aria-label per card');

/* ---- report -------------------------------------------------------- */
if (failures.length > 0) {
  console.error(`✗ probe:action-hand-html — ${failures.length} failure(s)`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(
  `✓ probe:action-hand-html — markup, transforms, badges, escaping, empty all green (n=${ACTIONS.length})`,
);

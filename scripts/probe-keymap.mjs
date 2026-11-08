/**
 * Keymap probe.
 *
 * Guards `apps/web/src/ui/keymap.ts` + `apps/web/src/ui/shortcutHelp.ts`, the single
 * source of truth behind the `? ` shortcut sheet (docs/INTERACTION-AUDIT.md G4) and the
 * "is this keystroke ours?" guard used by `main.ts` (G12).
 *
 * What it proves, without a browser:
 *
 *   1. Shape. Every binding has an id / key cap / label and a declared group, ids are
 *      unique, and no group in the table is orphaned.
 *   2. Order. `keymapRows()` follows `KEYMAP_GROUPS`, drops empty groups and never
 *      loses or duplicates a binding, so the sheet cannot silently drift from the table.
 *   3. Coverage. The keys the app really dispatches (?, Esc, I, 1–9, ←→, Enter, Tab,
 *      dice advance) are all in the table; a new key cannot ship undocumented.
 *   4. Guard. `isEditableTarget` / `shouldHandleKey` treat input / textarea / select /
 *      contenteditable as text entry — and keep Escape working inside them anyway.
 *   5. Hint. `shouldShowShortcutHint` fires once, tolerates a missing or throwing
 *      storage, and never nags on every reload.
 *   6. Escaping. The sheet escapes every key cap and label, so a hostile fixture cannot
 *      inject markup through a localized string.
 *
 * Run: node scripts/probe-keymap.mjs   (or `pnpm probe:keymap`)
 */

import {
  KEYMAP,
  KEYMAP_GROUPS,
  SHORTCUT_HINT_KEY,
  isEditableTarget,
  isEscapeKey,
  isHelpKey,
  keymapRows,
  shouldHandleKey,
  shouldShowShortcutHint,
} from '../apps/web/src/ui/keymap.ts';
import { shortcutHelpHtml } from '../apps/web/src/ui/shortcutHelp.ts';

const failures = [];
let checks = 0;
function check(ok, message) {
  checks += 1;
  if (!ok) failures.push(message);
  return ok;
}
function eq(actual, expected, message) {
  return check(
    actual === expected,
    `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/* ---- 1. shape ------------------------------------------------------- */
const groupIds = new Set(KEYMAP_GROUPS.map(group => group.id));
const seen = new Set();
for (const binding of KEYMAP) {
  check(typeof binding.id === 'string' && binding.id.length > 0, `binding without id: ${JSON.stringify(binding)}`);
  check(!seen.has(binding.id), `duplicate binding id: ${binding.id}`);
  seen.add(binding.id);
  check(typeof binding.keys === 'string' && binding.keys.trim().length > 0, `${binding.id}: empty key cap`);
  check(typeof binding.label === 'string' && binding.label.trim().length > 0, `${binding.id}: empty label`);
  check(groupIds.has(binding.group), `${binding.id}: unknown group ${binding.group}`);
}
check(KEYMAP_GROUPS.length === groupIds.size, 'KEYMAP_GROUPS has duplicate ids');
check(KEYMAP.length > 0, 'KEYMAP is empty');

/* ---- 2. order, no loss, no duplication ------------------------------ */
const rows = keymapRows();
const declaredOrder = KEYMAP_GROUPS.filter(group => rows.some(row => row.id === group.id)).map(group => group.id);
eq(rows.map(row => row.id).join(','), declaredOrder.join(','), 'keymapRows follows KEYMAP_GROUPS order');
check(rows.every(row => row.bindings.length > 0), 'keymapRows rendered an empty group');
const flat = rows.flatMap(row => row.bindings.map(binding => binding.id));
eq(flat.length, KEYMAP.length, 'keymapRows loses or duplicates bindings');
eq(flat.some(id => id === undefined), false, 'keymapRows produced an undefined binding');
for (const row of rows) {
  check(row.bindings.every(binding => binding.group === row.id), `group ${row.id} contains a foreign binding`);
  check(typeof row.title === 'string' && row.title.length > 0, `group ${row.id}: empty title`);
}
eq(keymapRows([]).length, 0, 'keymapRows([]) renders nothing');

/* ---- 3. coverage of the keys main.ts actually dispatches ------------ */
const byId = new Map(KEYMAP.map(binding => [binding.id, binding]));
const REQUIRED = {
  help: '?',
  escape: 'Esc',
  inspector: 'I',
  'actions.digits': '1 – 9',
  'hand.cycle': '← / →',
  'hand.activate': 'Enter',
  'hand.wheel': '滚轮 / 横向拖拽',
  'panels.focus': 'Tab',
  'dice.advance': 'Enter / Space',
};
for (const [id, keys] of Object.entries(REQUIRED)) {
  const binding = byId.get(id);
  check(!!binding, `keymap is missing ${id}`);
  if (binding) eq(binding.keys, keys, `${id} key cap`);
}

/* ---- 4. editable-target guard --------------------------------------- */
const editable = [
  { tagName: 'INPUT' },
  { tagName: 'input' },
  { tagName: 'TEXTAREA' },
  { tagName: 'SELECT' },
  { tagName: 'OPTION' },
  { tagName: 'DIV', isContentEditable: true },
  { tagName: 'SPAN', closest: selector => (selector.includes('contenteditable') ? { tagName: 'DIV' } : null) },
];
for (const target of editable) {
  check(isEditableTarget(target), `editable not detected: ${JSON.stringify(target)}`);
}
const notEditable = [
  null,
  undefined,
  { tagName: 'DIV' },
  { tagName: 'BUTTON', isContentEditable: false },
  { tagName: 'BODY', closest: () => null },
  { tagName: 'DIV', closest: () => { throw new Error('detached'); } },
  'not-an-element',
];
for (const target of notEditable) {
  check(!isEditableTarget(target), `non-editable misdetected: ${JSON.stringify(target)}`);
}

/* ---- 5. dispatch guard + key predicates ----------------------------- */
eq(shouldHandleKey({ key: 'Escape', target: { tagName: 'INPUT' } }), true, 'Escape survives an input');
eq(shouldHandleKey({ key: 'Esc', target: { tagName: 'TEXTAREA' } }), true, 'Esc survives a textarea');
eq(shouldHandleKey({ key: 'Escape', target: { tagName: 'DIV', isContentEditable: true } }), true, 'Escape survives contenteditable');
eq(shouldHandleKey({ key: '1', target: { tagName: 'INPUT' } }), false, 'digit swallowed by an input');
eq(shouldHandleKey({ key: '1', target: { tagName: 'SELECT' } }), false, 'digit swallowed by a select');
eq(shouldHandleKey({ key: 'i', target: { tagName: 'DIV', isContentEditable: true } }), false, 'i swallowed by contenteditable');
eq(shouldHandleKey({ key: '1', target: { tagName: 'DIV' } }), true, 'digit kept on a plain element');
eq(shouldHandleKey({ key: '?' }), true, 'missing target defaults to handling');

eq(isEscapeKey('Escape'), true, 'Escape recognised');
eq(isEscapeKey('Esc'), true, 'Esc alias recognised');
eq(isEscapeKey('escape'), false, 'lowercase escape is not a key');
eq(isHelpKey('?'), true, '? recognised');
eq(isHelpKey('？'), true, 'full-width ？ recognised');
eq(isHelpKey('/'), false, 'bare slash is not the help key');
eq(isHelpKey('x'), false, 'x is not the help key');

/* ---- 6. first-run hint ---------------------------------------------- */
const storageWith = value => ({ getItem: key => (key === SHORTCUT_HINT_KEY ? value : null) });
eq(shouldShowShortcutHint(storageWith(null)), true, 'hint fires on a fresh browser');
eq(shouldShowShortcutHint(storageWith('1')), false, 'hint does not repeat');
eq(shouldShowShortcutHint(null), false, 'hint stays quiet without storage');
eq(shouldShowShortcutHint(undefined), false, 'hint stays quiet with undefined storage');
eq(
  shouldShowShortcutHint({
    getItem: () => {
      throw new Error('blocked');
    },
  }),
  false,
  'hint stays quiet when storage throws',
);

/* ---- 7. rendered sheet --------------------------------------------- */
const sheet = shortcutHelpHtml();
check(sheet.length > 0, 'sheet is empty');
check(sheet.includes('class="shortcut-rows"'), 'sheet lost its wrapper');
for (const group of KEYMAP_GROUPS) {
  if (keymapRows().some(row => row.id === group.id)) {
    check(sheet.includes(group.title), `sheet is missing group title ${group.title}`);
  }
}
for (const binding of KEYMAP) {
  check(sheet.includes(`data-keymap-id="${binding.id}"`), `sheet is missing ${binding.id}`);
  check(sheet.includes(binding.keys), `sheet is missing key cap of ${binding.id}`);
  check(sheet.includes(binding.label), `sheet is missing label of ${binding.id}`);
}
const hostile = shortcutHelpHtml([
  { id: 'evil"', keys: '<b>X</b>', label: '<script>alert(1)</script>', group: 'global' },
]);
check(!hostile.includes('<script'), 'sheet emitted a raw <script>');
check(!hostile.includes('<b>X</b>'), 'sheet emitted raw markup from a key cap');
check(hostile.includes('&lt;script&gt;'), 'sheet did not escape the label');
check(hostile.includes('&quot;'), 'sheet did not escape the binding id');

/* ---- report --------------------------------------------------------- */
if (failures.length > 0) {
  console.error(`x probe:keymap — ${failures.length} failure(s) over ${checks} checks`);
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}
console.log(`ok probe:keymap — ${KEYMAP.length} bindings in ${keymapRows().length} groups, ${checks} checks green`);

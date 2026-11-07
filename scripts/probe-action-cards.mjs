/**
 * Action-card derivation probe.
 *
 * Guards `apps/web/src/ui/actionCards.ts`, the single model that the unified
 * action hand (docs/INTERACTION-REDESIGN.md) renders and routes from.
 *
 * What it proves, without a browser:
 *
 *   1. Kind. entity / numeric / command are derived purely from declarative
 *      UiAction fields — no game id, no per-game table.
 *   2. Target mode. placement > selection > fields > highlight > none, in that
 *      precedence, matching the legacy hud.ts decision exactly.
 *   3. Execution route. selection|fields → payload, placement → placement,
 *      everything else → execute.
 *   4. Parity. `isSimpleAction` (new model) === the old inline predicate for a
 *      whole cross-product of action shapes, so the P1 refactor cannot silently
 *      change how any action runs.
 *   5. Order. deriveActionCards preserves hand order and count (stable keys).
 *
 * Run: node scripts/probe-action-cards.mjs   (or `pnpm probe:action-cards`)
 */

import {
  deriveActionCard,
  deriveActionCards,
  executionRoute,
  isSimpleCard,
  isSimpleAction,
} from '../apps/web/src/ui/actionCards.ts';

const failures = [];
function check(ok, message) {
  if (!ok) failures.push(message);
  return ok;
}
function eq(actual, expected, message) {
  return check(
    actual === expected,
    `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/* ---- tiny builders ------------------------------------------------- */
const base = (over = {}) => ({
  id: 'a',
  icon: '✦',
  label: 'Action',
  hint: '',
  tone: 'normal',
  ...over,
});

const amountField = {
  key: 'amount',
  label: 'Amount',
  kind: 'number',
  widget: 'slider',
  min: 1,
  max: 10,
};
const enumField = { key: 'choice', label: 'Choice', kind: 'enum', options: [{ value: 'x', label: 'X' }] };
const selection = { spec: { min: 1, max: 1 }, candidates: [{ id: 'p1', label: 'P1' }] };

const SAMPLES = {
  endTurn: base({ id: 'end', actionType: 'END_TURN' }),
  entity: base({ id: 'play', entityId: 'card:3' }),
  entityTarget: base({ id: 'target', entityId: 'card:3', selection }),
  selectionOnly: base({ id: 'sel', selection }),
  numeric: base({ id: 'bet', fields: [amountField] }),
  enumForm: base({ id: 'enum', fields: [enumField] }),
  placement: base({ id: 'place', placementEntityId: 'room:9' }),
  placementWithHighlight: base({ id: 'place2', placementEntityId: 'room:9', highlightIds: ['n1'] }),
  highlight: base({ id: 'hl', highlightIds: ['n1', 'n2'] }),
  selectionBeatsFields: base({ id: 'both', selection, fields: [amountField] }),
};

/* ---- 1 + 2. kind and targetMode per sample ------------------------- */
const EXPECT = {
  endTurn: { kind: 'command', targetMode: 'none', route: 'execute', simple: true },
  entity: { kind: 'entity', targetMode: 'none', route: 'execute', simple: true },
  entityTarget: { kind: 'entity', targetMode: 'selection', route: 'payload', simple: false },
  selectionOnly: { kind: 'command', targetMode: 'selection', route: 'payload', simple: false },
  numeric: { kind: 'numeric', targetMode: 'fields', route: 'payload', simple: false },
  enumForm: { kind: 'command', targetMode: 'fields', route: 'payload', simple: false },
  placement: { kind: 'command', targetMode: 'placement', route: 'placement', simple: false },
  placementWithHighlight: { kind: 'command', targetMode: 'placement', route: 'placement', simple: false },
  highlight: { kind: 'command', targetMode: 'highlight', route: 'execute', simple: false },
  selectionBeatsFields: { kind: 'numeric', targetMode: 'selection', route: 'payload', simple: false },
};

for (const [name, action] of Object.entries(SAMPLES)) {
  const card = deriveActionCard(action);
  const want = EXPECT[name];
  eq(card.kind, want.kind, `${name} kind`);
  eq(card.targetMode, want.targetMode, `${name} targetMode`);
  eq(executionRoute(card), want.route, `${name} route`);
  eq(isSimpleCard(card), want.simple, `${name} simple`);
  // id / label / tone carried over verbatim
  eq(card.id, action.id, `${name} id`);
  eq(card.label, action.label, `${name} label`);
  eq(card.tone, action.tone, `${name} tone`);
}

/* ---- 3 + 4. parity with the legacy predicate over a cross-product --- */
/** The exact predicate hud.ts used before the model existed. */
const legacySimple = (a) =>
  !(a.fields?.length || a.selection || a.highlightIds?.length || a.placementEntityId);

const FLAGS = {
  selection: [undefined, selection],
  fields: [undefined, [amountField], [enumField]],
  highlightIds: [undefined, ['n1']],
  placementEntityId: [undefined, 'room:9'],
  entityId: [undefined, 'card:3'],
};

let combos = 0;
for (const sel of FLAGS.selection)
  for (const fld of FLAGS.fields)
    for (const hl of FLAGS.highlightIds)
      for (const pl of FLAGS.placementEntityId)
        for (const ent of FLAGS.entityId) {
          combos += 1;
          const action = base({
            id: `c${combos}`,
            selection: sel,
            fields: fld,
            highlightIds: hl,
            placementEntityId: pl,
            entityId: ent,
          });
          eq(
            isSimpleAction(action),
            legacySimple(action),
            `parity c${combos} (sel=${!!sel} fld=${!!fld} hl=${!!hl} pl=${!!pl} ent=${!!ent})`,
          );
          // Execution route must agree with the legacy branch.
          const route = executionRoute(deriveActionCard(action));
          const legacyRoute = fld?.length || sel ? 'payload' : pl ? 'placement' : 'execute';
          eq(route, legacyRoute, `route parity c${combos}`);
        }

/* ---- 5. order and count -------------------------------------------- */
const hand = [SAMPLES.endTurn, SAMPLES.entity, SAMPLES.selectionOnly, SAMPLES.numeric];
const cards = deriveActionCards(hand);
eq(cards.length, hand.length, 'deriveActionCards count');
check(
  cards.every((card, i) => card.id === hand[i].id),
  'deriveActionCards preserves order',
);

/* ---- report -------------------------------------------------------- */
if (failures.length > 0) {
  console.error(`✗ probe:action-cards — ${failures.length} failure(s) over ${combos} parity combos`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(
  `✓ probe:action-cards — ${Object.keys(SAMPLES).length} shapes, ${combos} parity combos, all green`,
);

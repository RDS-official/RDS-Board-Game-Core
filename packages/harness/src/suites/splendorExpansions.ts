/* -------------------------------------------------------------------------- */
/* suite:splendorExpansions — moved verbatim from suite.ts */
/* -------------------------------------------------------------------------- */

import { UniversalGameEngine } from '@rds/kernel/engine';
import { canonicalize } from '@rds/kernel/serialize';
import { Entity } from '@rds/kernel/types';
import { GAME_REGISTRY } from '@rds/games/registry';
import { SplendorRules } from '@rds/games/splendor/rules';
import { setupSplendor } from '@rds/games/splendor/setup';
import { RandomPolicy, runPolicies } from '../policy';
import { test, assert, assertEqual } from '../testKit';
import { splendorPlace, splendorSyncTotals, splendorVariantModule, splendorCardsOfTier, splendorFind, splendorStockPouch } from '../suiteHelpers';

/* Pokémon Splendor — Mega Evolution + Poké Mart expansions                   */
/* -------------------------------------------------------------------------- */

test('fixture splendor: the Mega deck is a face-up offer and the goal becomes 20 VP', () => {
  const base = setupSplendor(7, 2, { mega: false, pokemart: false });
  assertEqual(base.zones.zone_mega_offer, undefined, 'the base game deals no Mega offer');
  assertEqual(base.globalVars.scoreToWin, 18, 'the base goal stays 18');
  assertEqual(base.globalVars.megaTokens, 0, 'the base game has no Mega token pool');
  assertEqual(base.players.p1.customProps.megaToken, 0, 'nobody starts with a Mega token');

  const mega = setupSplendor(7, 2, { mega: true, pokemart: false });
  assertEqual(mega.globalVars.scoreToWin, 20, 'the Mega goal is 20 VP');
  assertEqual(mega.globalVars.megaTokens, 4, 'the shared Mega token pool holds four');
  assertEqual(mega.zones.zone_mega_offer.orderedEntities.length, 10, 'all ten Mega cards are revealed');
  for (const id of mega.zones.zone_mega_offer.orderedEntities) {
    assertEqual(mega.entities[id].visibility.type, 'PUBLIC', 'every Mega card is face up');
    assertEqual(mega.entities[id].components.custom?.pkmnTier, 'mega', 'the offer holds Mega cards');
  }
  assertEqual(
    JSON.stringify(mega.globalVars.variant),
    JSON.stringify({ mega: true, pokemart: false }),
    'the variant is persisted for replays'
  );
  assertEqual(mega.zones.zone_deck_pmL1, undefined, 'Mega alone deals no Poké Mart rows');
});

test('fixture splendor: a Mega token costs the whole turn and is capped at one per player', () => {
  const engine = new UniversalGameEngine(splendorVariantModule({ mega: true, pokemart: false }), 5);
  const raw = engine.getRawState();

  const take = engine.getLegalActions('p1').find(action => action.type === 'TAKE_MEGA_TOKEN');
  assert(!!take, 'taking a Mega token is a legal action');
  assert(engine.dispatch(take!).ok, 'the take is accepted');

  const afterTake = engine.getRawState();
  assertEqual(afterTake.globalVars.megaTokens, 3, 'the shared pool pays out');
  assertEqual(afterTake.players.p1.customProps.megaToken, 1, 'the token is held');
  assertEqual(afterTake.activePlayerId, 'p2', 'the take consumes the turn');
  assertEqual(afterTake.globalVars.evolvedThisTurn, false, 'the next seat starts clean');

  // Holding one blocks a second, even with the pool still stocked.
  afterTake.activePlayerId = 'p1';
  afterTake.activeActorId = 'p1';
  assertEqual(
    engine.getLegalActions('p1').some(action => action.type === 'TAKE_MEGA_TOKEN'),
    false,
    'a player may only hold one Mega token'
  );

  // The pool itself can run dry.
  const dry = engine.getRawState();
  dry.globalVars.megaTokens = 0;
  dry.players.p1.customProps.megaToken = 0;
  assertEqual(
    engine.getLegalActions('p1').some(action => action.type === 'TAKE_MEGA_TOKEN'),
    false,
    'an empty pool offers no token'
  );

  // And the base game refuses the action outright.
  const plain = new UniversalGameEngine(GAME_REGISTRY.splendor, 5);
  plain.getRawState().globalVars.megaTokens = 4;
  assertEqual(
    plain.getLegalActions('p1').some(action => action.type === 'TAKE_MEGA_TOKEN'),
    false,
    'the base game never offers a Mega token'
  );
  assertEqual(raw.seed, 5, 'the fixture did not disturb the seed');
});

test('fixture splendor: super-evolution consumes the token, buries the base and pays balls', () => {
  const engine = new UniversalGameEngine(splendorVariantModule({ mega: true, pokemart: false }), 5);
  const raw = engine.getRawState();

  const mega = splendorFind(raw, meta => meta.pkmnTier === 'mega' && meta.name === '超级耿鬼');
  const base = splendorFind(raw, meta => meta.name === '耿鬼');
  assertEqual(base.components.custom?.pkmnTier, 'stage3', '耿鬼 is a third-stage Pokémon');
  splendorPlace(raw, base.id, 'zone_tableau_p1');
  raw.players.p1.customProps.megaToken = 1;
  raw.players.p1.customProps.bonuses = { red: 0, blue: 0, black: 0, pink: 0, yellow: 0, purple: 0 };
  raw.globalVars.megaTokens = 3;

  // Without ball tokens the Mega card is unaffordable.
  assertEqual(
    SplendorRules.megaEvolveOptions(raw, 'p1').length,
    0,
    'a token alone does not pay for the Mega card'
  );
  const broke = engine.getLegalActions('p1').filter(action => action.type === 'MEGA_EVOLVE');
  assertEqual(broke.length, 0, 'no super-evolution is offered while unaffordable');

  splendorStockPouch(raw, 'p1');
  const tokensBefore = canonicalize(raw.players.p1.customProps.tokens);
  const options = SplendorRules.megaEvolveOptions(raw, 'p1');
  assertEqual(options.length, 1, 'exactly one Mega matches the base Pokémon');
  assertEqual(options[0].megaId, mega.id, 'the offer names the right Mega');

  const legal = engine.getLegalActions('p1').find(action => action.type === 'MEGA_EVOLVE');
  assert(!!legal, 'the super-evolution is a legal action');
  assert(engine.dispatch(legal!).ok, 'the super-evolution is accepted');

  const next = engine.getRawState();
  assertEqual(next.playerOrder.length, 2, 'the table still has two seats');
  assert(
    canonicalize(next.players.p1.customProps.tokens) !== tokensBefore,
    'the Mega card cost balls'
  );
  assertEqual(next.players.p1.customProps.megaToken, 0, 'the token is spent');
  assertEqual(next.globalVars.megaTokens, 4, 'the token returns to the shared pool');
  assertEqual(next.globalVars.evolvedThisTurn, true, 'it counts as this turn evolution');
  assertEqual(next.zones.zone_buried_p1.orderedEntities.join(','), base.id, 'the base is buried');
  assertEqual(next.zones.zone_tableau_p1.orderedEntities.join(','), mega.id, 'the Mega takes the field');
  assertEqual(
    next.zones.zone_mega_offer.orderedEntities.length,
    9,
    'the Mega card leaves the offer for good'
  );
  assertEqual(
    next.zones.zone_mega_offer.orderedEntities.includes(mega.id),
    false,
    'the taken Mega is gone from the offer'
  );
  assertEqual(next.players.p1.score, Number(mega.components.custom?.vp ?? 0), 'only the Mega scores');
  assertEqual(
    SplendorRules.evolutionOptions(next, 'p1').length,
    0,
    'a super-evolution blocks the ordinary evolution for the turn'
  );
  assertEqual(
    SplendorRules.hasReachedGoal(next, 'p1'),
    false,
    'a Mega alone does not satisfy the 20 VP + colours goal'
  );
});

test('fixture splendor: the Mega victory needs 20 VP, every colour and a Mega in play', () => {
  const engine = new UniversalGameEngine(splendorVariantModule({ mega: true, pokemart: false }), 5);
  const raw = engine.getRawState();

  // Build a real 20 VP tableau from third-stage Pokémon, one per colour.
  // Third-stage cards only come in five colours and range from 3 to 5 VP, so
  // walking them in deck order can stop at 19: pick the best card of each
  // colour instead of the first one seen.
  const bestPerColour = new Map<string, Entity>();
  for (const card of splendorCardsOfTier(raw, 'stage3')) {
    const bonus = String(card.components.custom?.bonus ?? '');
    const best = bestPerColour.get(bonus);
    if (!best || Number(card.components.custom?.vp ?? 0) > Number(best.components.custom?.vp ?? 0)) {
      bestPerColour.set(bonus, card);
    }
  }
  let vp = 0;
  for (const card of bestPerColour.values()) {
    splendorPlace(raw, card.id, 'zone_tableau_p1');
    vp += Number(card.components.custom?.vp ?? 0);
  }
  assert(vp >= 20, `the tableau is worth at least 20 (${vp})`);
  splendorSyncTotals(raw, 'p1');
  assertEqual(SplendorRules.hasMegaWin(raw, 'p1'), false, 'no Mega means no Mega victory');

  // A Mega in play completes the goal.
  const mega = splendorFind(raw, meta => meta.pkmnTier === 'mega' && meta.bonus === 'yellow');
  splendorPlace(raw, mega.id, 'zone_tableau_p1');
  splendorSyncTotals(raw, 'p1');
  assertEqual(SplendorRules.hasMegaWin(raw, 'p1'), true, 'VP + every colour + a Mega wins');

  // Dropping one colour disqualifies the position. Every tableau card that
  // grants it has to go — the Mega itself is yellow, so burying only the
  // third-stage copy would leave the colour covered.
  const missing = engine.getRawState();
  const yellow = missing.zones.zone_tableau_p1.orderedEntities.filter(
    id => missing.entities[id]?.components.custom?.bonus === 'yellow'
  );
  assert(yellow.length > 0, 'the tableau covers yellow');
  for (const id of yellow) splendorPlace(missing, id, 'zone_buried_p1');
  splendorSyncTotals(missing, 'p1');
  assertEqual(missing.players.p1.customProps.bonuses.yellow ?? 0, 0, 'yellow is gone from the bonuses');
  assertEqual(
    SplendorRules.hasMegaWin(missing, 'p1'),
    false,
    'a missing colour disqualifies even with 20 VP and a Mega'
  );

  // A rival with more raw points but no Mega is not the winner.
  // `getRawState` hands back the live position, so the burial above is still in
  // effect here — restore the colour before scoring a second table.
  const scored = engine.getRawState();
  for (const id of yellow) splendorPlace(scored, id, 'zone_tableau_p1');
  splendorSyncTotals(scored, 'p1');
  scored.globalVars.finalRoundComplete = true;
  scored.players.p2.score = 40;
  assertEqual(
    SplendorRules.checkWinCondition(scored).winner,
    'p1',
    'only a player who meets the Mega goal is eligible'
  );

  // The base game keeps its plain 18-point rule.
  const base = setupSplendor(5, 2, { mega: false, pokemart: false });
  base.globalVars.finalRoundComplete = true;
  base.players.p1.score = 18;
  assertEqual(SplendorRules.checkWinCondition(base).winner, 'p1', '18 VP still wins the base game');
});

test('fixture splendor: the Poké Mart deals two cards per level and refills from its own deck', () => {
  const base = setupSplendor(7, 2, { mega: false, pokemart: false });
  assertEqual(base.zones.zone_pmL1, undefined, 'the base game deals no Poké Mart row');
  assertEqual(base.zones.zone_deck_pmL1, undefined, 'the base game holds no Poké Mart deck');

  const state = setupSplendor(7, 2, { mega: false, pokemart: true });
  for (const tier of ['pmL1', 'pmL2', 'pmL3'] as const) {
    assertEqual(state.zones[`zone_${tier}`].orderedEntities.length, 2, `${tier} reveals two cards`);
    assertEqual(state.zones[`zone_deck_${tier}`].orderedEntities.length, 8, `${tier} deck keeps eight`);
    for (const id of state.zones[`zone_${tier}`].orderedEntities) {
      assertEqual(state.entities[id].visibility.type, 'PUBLIC', `${tier} cards are face up`);
      assertEqual(state.entities[id].components.custom?.pkmnTier, tier, `${tier} holds only its own level`);
    }
  }
  // A Poké Mart row is reservable exactly like its base level.
  const engine = new UniversalGameEngine(splendorVariantModule({ mega: false, pokemart: true }), 7);
  const reservable = engine
    .getLegalActions('p1')
    .filter(action => action.type === 'RESERVE_CARD' && action.entityId)
    .map(action => engine.getRawState().entities[action.entityId!].components.custom?.pkmnTier);
  for (const tier of ['pmL1', 'pmL2', 'pmL3']) {
    assert(reservable.includes(tier), `${tier} cards can be reserved`);
  }

  // Catching a Poké Mart card refills that level from its own deck.
  const raw = engine.getRawState();
  const card = raw.zones.zone_pmL2.orderedEntities[0];
  splendorStockPouch(raw, 'p1');
  const deckBefore = raw.zones.zone_deck_pmL2.orderedEntities.length;
  const buy = engine.dispatch({ type: 'BUY_CARD', playerId: 'p1', entityId: card });
  assert(buy.ok, `the Poké Mart card is caught (${buy.error ?? 'ok'})`);
  const after = engine.getRawState();
  assertEqual(after.zones.zone_pmL2.orderedEntities.length, 2, 'the row refills to two');
  assertEqual(after.zones.zone_deck_pmL2.orderedEntities.length, deckBefore - 1, 'the level deck pays');
  assertEqual(after.zones.zone_tableau_p1.orderedEntities.includes(card), true, 'the card enters play');
});

test('fixture splendor: Poké Mart POTION grants two bonuses of its colour', () => {
  const engine = new UniversalGameEngine(splendorVariantModule({ mega: false, pokemart: true }), 7);
  const raw = engine.getRawState();
  const potion = splendorFind(raw, meta => meta.effect === 'double' && meta.pkmnTier === 'pmL2');
  const colour = String(potion.components.custom?.bonus);
  assertEqual(Number(potion.components.custom?.bonusCount), 2, 'the potion prints two bonuses');

  splendorPlace(raw, potion.id, 'zone_pmL2');
  splendorStockPouch(raw, 'p1');
  assert(engine.dispatch({ type: 'BUY_CARD', playerId: 'p1', entityId: potion.id }).ok, 'the potion is caught');

  const next = engine.getRawState();
  assertEqual(next.players.p1.customProps.bonuses[colour], 2, 'both bonuses land on the tableau');
  assertEqual(next.players.p1.score, 1, 'the potion also scores its VP');
});

test('fixture splendor: Poké Mart TM copies the colour of an owned card', () => {
  const engine = new UniversalGameEngine(splendorVariantModule({ mega: false, pokemart: true }), 7);
  const raw = engine.getRawState();
  const tm = splendorFind(raw, meta => meta.effect === 'copy' && meta.pkmnTier === 'pmL1');
  const source = splendorFind(
    raw,
    meta => meta.bonus === 'red' && String(meta.pkmnTier).startsWith('stage1')
  );
  assertEqual(tm.components.custom?.bonus, null, 'the TM prints no colour of its own');

  splendorPlace(raw, source.id, 'zone_tableau_p1');
  splendorPlace(raw, tm.id, 'zone_pmL1');
  splendorStockPouch(raw, 'p1');
  splendorSyncTotals(raw, 'p1');
  assertEqual(raw.players.p1.customProps.bonuses.red, 1, 'the source card already grants red');

  // Without a colour to copy, the TM cannot be caught at all.
  const empty = engine.getRawState();
  const noSource = new UniversalGameEngine(splendorVariantModule({ mega: false, pokemart: true }), 7);
  const bare = noSource.getRawState();
  const tmCard = splendorFind(bare, meta => meta.effect === 'copy' && meta.pkmnTier === 'pmL1');
  splendorPlace(bare, tmCard.id, 'zone_pmL1');
  splendorStockPouch(bare, 'p1');
  assertEqual(
    noSource.getLegalActions('p1').some(action => action.type === 'BUY_CARD' && action.entityId === tmCard.id),
    false,
    'a TM with nothing to copy is not a legal capture'
  );
  assertEqual(
    Object.keys(empty.players.p1.customProps.assoc ?? {}).length,
    0,
    'no association is recorded before the buy'
  );

  const buy = engine.dispatch({
    type: 'BUY_CARD',
    playerId: 'p1',
    entityId: tm.id,
    payload: { captureOpts: { copyTargetId: source.id } }
  });
  assert(buy.ok, `the TM is caught (${buy.error ?? 'ok'})`);

  const next = engine.getRawState();
  assertEqual(next.players.p1.customProps.assoc[tm.id], 'red', 'the TM records the borrowed colour');
  assertEqual(next.players.p1.customProps.bonuses.red, 2, 'the copied bonus stacks on the original');
});

test('fixture splendor: Poké Mart POKÉDEX pays two virtual master balls when discarded', () => {
  const engine = new UniversalGameEngine(splendorVariantModule({ mega: false, pokemart: true }), 7);
  const raw = engine.getRawState();
  const dex = splendorCardsOfTier(raw, 'pmL1').filter(card => card.components.custom?.effect === 'colorless_master');
  assert(dex.length >= 2, 'the fixture has two POKÉDEX cards');
  for (const card of dex.slice(0, 2)) splendorPlace(raw, card.id, 'zone_tableau_p1');

  // A card worth 4 pink, with an empty pouch, is payable by two POKÉDEX.
  const target = splendorFind(raw, meta => {
    const cost = (meta.cost ?? {}) as Record<string, number>;
    if (!String(meta.pkmnTier).startsWith('stage')) return false;
    if (Number(cost.pink ?? 0) !== 4) return false;
    return Object.entries(cost).every(([colour, value]) => colour === 'pink' || value === 0);
  });
  splendorPlace(raw, target.id, 'zone_market_t3');
  for (const colour of ['red', 'blue', 'black', 'pink', 'yellow', 'purple']) {
    raw.players.p1.customProps.tokens[colour] = 0;
  }

  // Nothing in hand: a bare capture would have to borrow the POKÉDEX, and the
  // reducer's defaults do exactly that — the discard is what makes it payable.
  const bare = engine.dispatch({ type: 'BUY_CARD', playerId: 'p1', entityId: target.id });
  assert(bare.ok, `the reducer defaults to spending the POKÉDEX (${bare.error ?? 'ok'})`);

  const buy = engine.dispatch({
    type: 'BUY_CARD',
    playerId: 'p1',
    entityId: target.id,
    payload: { captureOpts: { spendPokedex: dex.slice(0, 2).map(card => card.id) } }
  });
  assert(buy.ok, `two POKÉDEX pay for the card (${buy.error ?? 'ok'})`);

  const next = engine.getRawState();
  assertEqual(next.zones.zone_discarded.orderedEntities.length, 2, 'both POKÉDEX cards left the game');
  assertEqual(next.zones.zone_tableau_p1.orderedEntities.join(','), target.id, 'the caught card is the only one left');
  assertEqual(next.players.p1.score, Number(target.components.custom?.vp ?? 0), 'the discarded cards score nothing');
  for (const colour of ['red', 'blue', 'black', 'pink', 'yellow', 'purple']) {
    assertEqual(next.players.p1.customProps.tokens[colour], 0, 'no ball token was spent');
  }
});

test('fixture splendor: Poké Mart REPEL trades two same-colour cards instead of balls', () => {
  const engine = new UniversalGameEngine(splendorVariantModule({ mega: false, pokemart: true }), 7);
  const raw = engine.getRawState();
  const repel = splendorFind(raw, meta => meta.effect === 'discard_buy' && meta.pkmnTier === 'pmL3');
  const param = repel.components.custom?.effectParam as { discardColor: string; discardCount: number };
  assertEqual(param.discardCount, 2, 'the REPEL asks for two cards');

  const fodder = splendorCardsOfTier(raw, 'stage1').filter(
    card => card.components.custom?.bonus === param.discardColor
  );
  assert(fodder.length >= 2, `the fixture has two ${param.discardColor} cards`);
  for (const card of fodder.slice(0, 2)) splendorPlace(raw, card.id, 'zone_tableau_p1');
  splendorPlace(raw, repel.id, 'zone_pmL3');
  splendorStockPouch(raw, 'p1');
  const tokensBefore = canonicalize(raw.players.p1.customProps.tokens);

  // Without the two matching cards the REPEL is unaffordable.
  const thin = engine.getRawState();
  splendorPlace(thin, fodder[0].id, 'zone_discarded');
  assertEqual(
    engine.getLegalActions('p1').some(action => action.type === 'BUY_CARD' && action.entityId === repel.id),
    false,
    'one matching card is not enough'
  );
  splendorPlace(engine.getRawState(), fodder[0].id, 'zone_tableau_p1');

  const legal = engine.getLegalActions('p1').find(action => action.type === 'BUY_CARD' && action.entityId === repel.id);
  assert(!!legal, 'the REPEL is a legal capture');
  assert(engine.dispatch(legal!).ok, 'the REPEL is accepted');

  const next = engine.getRawState();
  assertEqual(canonicalize(next.players.p1.customProps.tokens), tokensBefore, 'no balls are spent');
  assertEqual(next.zones.zone_discarded.orderedEntities.length, 2, 'the two cards leave the game');
  assertEqual(
    next.zones.zone_tableau_p1.orderedEntities.join(','),
    repel.id,
    'only the REPEL is left on the tableau'
  );
  assertEqual(next.players.p1.customProps.bonuses[param.discardColor], 0, 'the sacrifice gives no bonus');
});

test('fixture splendor: Poké Mart EVOLVE STONE takes a free level-2 card, recursively', () => {
  const engine = new UniversalGameEngine(splendorVariantModule({ mega: false, pokemart: true }), 7);
  const raw = engine.getRawState();
  const stone = splendorFind(raw, meta => meta.effect === 'free' && meta.pkmnTier === 'pmL3');
  splendorPlace(raw, stone.id, 'zone_pmL3');
  splendorStockPouch(raw, 'p1');

  const freeCard = raw.zones.zone_market_t2.orderedEntities[0];
  const freeMeta = raw.entities[freeCard].components.custom!;
  const buy = engine.dispatch({
    type: 'BUY_CARD',
    playerId: 'p1',
    entityId: stone.id,
    payload: { captureOpts: { freeTakeId: freeCard } }
  });
  assert(buy.ok, `the stone is caught (${buy.error ?? 'ok'})`);

  const next = engine.getRawState();
  const tableau = next.zones.zone_tableau_p1.orderedEntities;
  assertEqual(tableau.includes(freeCard), true, 'the free card enters play');
  assertEqual(tableau.includes(stone.id), true, 'the stone itself also enters play');
  assertEqual(
    next.players.p1.score,
    Number(stone.components.custom?.vp ?? 0) + Number(freeMeta.vp ?? 0),
    'both cards score'
  );
  assertEqual(next.zones.zone_market_t2.orderedEntities.length, 4, 'the level-2 row refills');

  // A free card must come from the level below.
  const again = new UniversalGameEngine(splendorVariantModule({ mega: false, pokemart: true }), 7);
  const rawAgain = again.getRawState();
  const stoneAgain = splendorFind(rawAgain, meta => meta.effect === 'free' && meta.pkmnTier === 'pmL3');
  splendorPlace(rawAgain, stoneAgain.id, 'zone_pmL3');
  splendorStockPouch(rawAgain, 'p1');
  const wrongTier = rawAgain.zones.zone_market_t3.orderedEntities[0];
  again.dispatch({
    type: 'BUY_CARD',
    playerId: 'p1',
    entityId: stoneAgain.id,
    payload: { captureOpts: { freeTakeId: wrongTier } }
  });
  // The reducer refuses an illegal free take by returning the position
  // untouched: the capture simply does not happen. Assert the facts the player
  // would see rather than the kernel's return value, which stays `ok` because
  // the action was still a well-formed, logged transition.
  const afterReject = again.getRawState();
  assertEqual(
    afterReject.zones.zone_market_t3.orderedEntities.includes(wrongTier),
    true,
    'a level-3 card is never a legal free take: it stays in its row'
  );
  assertEqual(afterReject.entities[stoneAgain.id].zoneId, 'zone_pmL3', 'the stone was not caught');
  assertEqual(
    afterReject.zones.zone_tableau_p1.orderedEntities.length,
    0,
    'nothing entered the tableau'
  );
});

test('fixture splendor: Poké Mart RARE CANDY associates and takes a free level-1 card', () => {
  const engine = new UniversalGameEngine(splendorVariantModule({ mega: false, pokemart: true }), 7);
  const raw = engine.getRawState();
  const candy = splendorFind(raw, meta => meta.effect === 'copy_free' && meta.pkmnTier === 'pmL2');
  const source = splendorFind(
    raw,
    meta => meta.bonus === 'yellow' && String(meta.pkmnTier).startsWith('stage1')
  );
  splendorPlace(raw, source.id, 'zone_tableau_p1');
  splendorPlace(raw, candy.id, 'zone_pmL2');
  splendorStockPouch(raw, 'p1');

  const freeCard = raw.zones.zone_market_t1.orderedEntities[0];
  const buy = engine.dispatch({
    type: 'BUY_CARD',
    playerId: 'p1',
    entityId: candy.id,
    payload: { captureOpts: { copyTargetId: source.id, freeTakeId: freeCard } }
  });
  assert(buy.ok, `the candy is caught (${buy.error ?? 'ok'})`);

  const next = engine.getRawState();
  assertEqual(next.players.p1.customProps.assoc[candy.id], 'yellow', 'the candy borrows the colour');
  const tableau = next.zones.zone_tableau_p1.orderedEntities;
  assertEqual(tableau.includes(freeCard), true, 'the free level-1 card enters play');
  assertEqual(
    next.players.p1.customProps.bonuses.yellow,
    2,
    'the borrowed colour stacks with the source card'
  );

  // A free take may chain into another effect card (the recursion is bounded).
  const chain = new UniversalGameEngine(splendorVariantModule({ mega: false, pokemart: true }), 11);
  const chainRaw = chain.getRawState();
  const stone = splendorFind(chainRaw, meta => meta.effect === 'free' && meta.pkmnTier === 'pmL3');
  const nested = splendorFind(chainRaw, meta => meta.effect === 'copy_free' && meta.pkmnTier === 'pmL2');
  const nestedSource = splendorFind(
    chainRaw,
    meta => meta.bonus === 'blue' && String(meta.pkmnTier).startsWith('stage1')
  );
  splendorPlace(chainRaw, stone.id, 'zone_pmL3');
  splendorPlace(chainRaw, nested.id, 'zone_pmL2');
  splendorPlace(chainRaw, nestedSource.id, 'zone_tableau_p1');
  splendorStockPouch(chainRaw, 'p1');
  const leaf = chainRaw.zones.zone_market_t1.orderedEntities[0];

  const chained = chain.dispatch({
    type: 'BUY_CARD',
    playerId: 'p1',
    entityId: stone.id,
    payload: {
      captureOpts: {
        freeTakeId: nested.id,
        freeOpts: { copyTargetId: nestedSource.id, freeTakeId: leaf }
      }
    }
  });
  assert(chained.ok, `the chained free take resolves (${chained.error ?? 'ok'})`);
  const chainedNext = chain.getRawState();
  const chainedTableau = chainedNext.zones.zone_tableau_p1.orderedEntities;
  assertEqual(chainedTableau.includes(nested.id), true, 'the nested candy enters play for free');
  assertEqual(chainedTableau.includes(leaf), true, 'the chained level-1 card enters play too');
  assertEqual(chainedNext.players.p1.customProps.assoc[nested.id], 'blue', 'the nested association is recorded');
  assertEqual(chainedNext.players.p1.customProps.bonuses.blue, 2, 'the nested bonus lands');
});

test('fixture splendor: the four expansion scenarios all deal and play', () => {
  const expected: Record<string, { mega: boolean; pokemart: boolean }> = {
    base: { mega: false, pokemart: false },
    mega: { mega: true, pokemart: false },
    pokemart: { mega: false, pokemart: true },
    full: { mega: true, pokemart: true }
  };
  const scenarios = GAME_REGISTRY.splendor.scenarios ?? {};
  assertEqual(
    Object.keys(scenarios).sort().join(','),
    Object.keys(expected).sort().join(','),
    'the module exposes exactly the four variants'
  );

  for (const [name, variant] of Object.entries(expected)) {
    const scenario = scenarios[name];
    assert(!!scenario, `${name} is registered`);
    const state = scenario!.setup(11);
    assertEqual(state.playerOrder.length, 2, `${name} deals two seats`);
    assertEqual(
      JSON.stringify(state.globalVars.variant),
      JSON.stringify(variant),
      `${name} bakes its variant into the closure`
    );
    assertEqual(
      state.globalVars.scoreToWin,
      variant.mega ? 20 : 18,
      `${name} uses its goal`
    );
    assertEqual(
      state.globalVars.megaTokens,
      variant.mega ? 4 : 0,
      `${name} stocks the Mega pool only when the expansion is on`
    );
    assertEqual(
      !!state.zones.zone_mega_offer,
      variant.mega,
      `${name} reveals the Mega offer only when the expansion is on`
    );
    assertEqual(
      !!state.zones.zone_pmL1,
      variant.pokemart,
      `${name} reveals the Poké Mart rows only when the expansion is on`
    );
    assertEqual(state.seed, 11, `${name} keeps the seed`);
    // Setup must stay plain JSON.
    assertEqual(typeof JSON.parse(JSON.stringify(state)), 'object', `${name} deals a serialisable state`);

    // Every scenario plays a full game from its own deal.
    const engine = new UniversalGameEngine(GAME_REGISTRY.splendor, 11, { scenario: name });
    const order = engine.getRawState().playerOrder;
    const policies = Object.fromEntries(
      order.map((pid, index) => [pid, new RandomPolicy(11 + index * 17, `${name}-${pid}`)])
    );
    const report = runPolicies(engine, policies, 600);
    assertEqual(report.errors.length, 0, `${name} plays without dispatch errors (${report.errors[0] ?? ''})`);
    assert(report.steps > 0, `${name} makes progress`);
    const replay = engine.verifyReplay();
    assert(replay.ok, `${name} replays bit-exactly (${replay.errors.slice(0, 2).join(' | ')})`);

    // Balls are conserved per colour in every variant.
    const final = engine.getRawState();
    for (const colour of ['red', 'blue', 'black', 'pink', 'yellow']) {
      const held = Object.values(final.players).reduce(
        (sum, player) => sum + Number(player.customProps.tokens[colour] ?? 0),
        0
      );
      assertEqual(held + final.globalVars.bank[colour], 4, `${name}: ${colour} is conserved`);
    }
  }
});

test('fixture splendor: Mega tokens are conserved across a full expansion game', () => {
  for (const scenario of ['mega', 'full']) {
    const engine = new UniversalGameEngine(GAME_REGISTRY.splendor, 2025, { scenario });
    const order = engine.getRawState().playerOrder;
    const policies = Object.fromEntries(
      order.map((pid, index) => [pid, new RandomPolicy(2025 + index * 31, `${scenario}-${pid}`)])
    );
    const report = runPolicies(engine, policies, 600);
    assertEqual(report.errors.length, 0, `${scenario}: no dispatch errors (${report.errors[0] ?? ''})`);

    const state = engine.getRawState();
    const held = Object.values(state.players).reduce(
      (sum, player) => sum + Number(player.customProps.megaToken ?? 0),
      0
    );
    assertEqual(held + Number(state.globalVars.megaTokens ?? 0), 4, `${scenario}: Mega tokens are conserved`);
    for (const player of Object.values(state.players)) {
      assert(Number(player.customProps.megaToken ?? 0) <= 1, `${scenario}: at most one token per player`);
    }
    // Megas only ever enter play through a super-evolution, so every Mega on a
    // tableau must trace back to a buried base Pokémon.
    for (const pid of state.playerOrder) {
      const megas = state.zones[`zone_tableau_${pid}`].orderedEntities.filter(
        id => state.entities[id]?.components.custom?.pkmnTier === 'mega'
      );
      const buried = state.zones[`zone_buried_${pid}`].orderedEntities.length;
      assert(megas.length <= buried, `${scenario}: ${pid} buried a base for every Mega`);
    }
    assert(engine.verifyReplay().ok, `${scenario}: the expansion game replays bit-exactly`);
  }
});

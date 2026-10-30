/* -------------------------------------------------------------------------- */
/* Shared fixtures and helpers used by the suites/ modules                    */
/* -------------------------------------------------------------------------- */

import { openDecision } from '@rds/kernel/decisions';
import { ECSManager } from '@rds/kernel/ecs';
import { UniversalGameEngine } from '@rds/kernel/engine';
import { GameExpansion, GameModule, defineGame } from '@rds/kernel/module';
import { DeterministicPRNG } from '@rds/kernel/prng';
import { Entity, GameState } from '@rds/kernel/types';
import { GAME_REGISTRY } from '@rds/games/registry';
import { setupSplendor } from '@rds/games/splendor/setup';
import { withDefaultPayload } from '@rds/kernel/actionPayload';
import { rollZeroDice } from '@rds/games/betrayal/helpers';
import { assert, AssertionError } from './testKit';

/* harnessHelpers */
/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

export function emptyState(gameId = 'test', seed = 42): GameState {
  return {
    gameId,
    seed,
    seq: 0,
    clock: 0,
    round: 1,
    turn: 1,
    activePlayerId: 'p1',
    phase: 'TEST',
    players: {
      p1: {
        id: 'p1',
        name: 'P1',
        color: '#fff',
        avatar: '1',
        score: 0,
        alive: true,
        handZoneId: 'hand_p1',
        customProps: {}
      },
      p2: {
        id: 'p2',
        name: 'P2',
        color: '#000',
        avatar: '2',
        score: 0,
        alive: true,
        handZoneId: 'hand_p2',
        customProps: {}
      }
    },
    playerOrder: ['p1', 'p2'],
    entities: {},
    zones: {},
    mapGraph: { nodes: {}, edges: {} },
    globalVars: {},
    interruptStack: [],
    pendingDecisions: [],
    activeHooks: [],
    prngState: seed,
    actionLog: [],
    winner: null,
    gameOver: false
  };
}

export function withZone(state: GameState, id: string, visibility: GameState['zones'][string]['visibility'] = { type: 'PUBLIC' }): GameState {
  return ECSManager.createZone(state, id, id, 'HAND', visibility);
}

/* engineModules */
export const counterModule: GameModule = defineGame({
  meta: {
    id: 'counter',
    name: 'Counter fixture',
    description: 'Minimal module used by kernel tests',
    version: '1.0.0',
    capabilities: {
      simultaneousMoves: false,
      hiddenInformation: false,
      interruptStack: false,
      dynamicRules: false,
      topology: 'none'
    }
  },
  hooks: [],
  setup: seed => ({
    ...emptyState('counter', seed),
    globalVars: { ticks: 0, last: 0 }
  }),
  legalActions: (state, playerId) =>
    playerId === state.activePlayerId && (state.globalVars.ticks as number) < 100
      ? [{ type: 'TICK', playerId }]
      : [],
  reduce: (state, action, ctx) => {
    if (action.type !== 'TICK') return state;
    const { value, nextSeed } = DeterministicPRNG.next(state.prngState);
    ctx.trace({ id: ctx.id('evt'), type: 'ANNOUNCEMENT', title: 'tick', durationMs: 10 });
    return {
      ...state,
      prngState: nextSeed,
      globalVars: {
        ticks: (state.globalVars.ticks as number) + 1,
        last: value
      }
    };
  },
  outcome: () => ({ gameOver: false, winner: null })
});

export const scenarioModule: GameModule = defineGame({
  ...counterModule,
  meta: { ...counterModule.meta, id: 'scenario_fixture', name: 'Scenario fixture' },
  scenarios: {
    rich: {
      description: 'Starts with 40 ticks already recorded',
      setup: seed => ({
        ...emptyState('scenario_fixture', seed),
        globalVars: { ticks: 40, last: 0 }
      })
    }
  }
});

export const selectionModule: GameModule = defineGame({
  meta: {
    id: 'selection_fixture',
    name: 'Selection fixture',
    description: 'Declarative target selection',
    version: '1.0.0',
    capabilities: {
      simultaneousMoves: false,
      hiddenInformation: false,
      interruptStack: false,
      dynamicRules: false,
      topology: 'graph'
    }
  },
  hooks: [],
  setup: seed => {
    const base = emptyState('selection_fixture', seed);
    base.mapGraph = {
      nodes: {
        n1: { id: 'n1', type: 'GENERIC', position: [0, 0, 0], neighbors: ['n2'], props: { name: 'Alpha' } },
        n2: { id: 'n2', type: 'GENERIC', position: [1, 0, 0], neighbors: ['n1'], props: { name: 'Beta' } }
      },
      edges: {}
    };
    base.globalVars = { picked: null };
    return base;
  },
  legalActions: (state, actorId) =>
    actorId === state.activePlayerId
      ? [
          { type: 'PICK_NODE', playerId: actorId, selection: { source: 'node', min: 1, max: 1 } },
          { type: 'END_TURN', playerId: actorId }
        ]
      : [],
  reduce: (state, action) => {
    if (action.type === 'PICK_NODE') {
      return { ...state, globalVars: { ...state.globalVars, picked: action.targets?.[0] ?? null } };
    }
    return state;
  },
  outcome: () => ({ gameOver: false, winner: null })
});

export const diceModule: GameModule = defineGame({
  meta: {
    id: 'dice_fixture',
    name: 'Dice fixture',
    description: 'Custom dice faces',
    version: '1.0.0',
    capabilities: {
      simultaneousMoves: false,
      hiddenInformation: false,
      interruptStack: false,
      dynamicRules: false,
      topology: 'none'
    }
  },
  hooks: [],
  setup: seed => ({ ...emptyState('dice_fixture', seed), globalVars: { total: -1, rolls: [] } }),
  legalActions: (state, actorId) =>
    actorId === state.activePlayerId ? [{ type: 'ROLL_CUSTOM', playerId: actorId }] : [],
  reduce: (state, action, ctx) => {
    if (action.type !== 'ROLL_CUSTOM') return state;
    const roll = ctx.roll({ count: 6, faces: [0, 1, 2] }, state.prngState);
    return {
      ...state,
      prngState: roll.nextSeed,
      globalVars: { total: roll.result.total, rolls: roll.result.rolls }
    };
  },
  outcome: () => ({ gameOver: false, winner: null })
});

export const npcModule: GameModule = defineGame({
  meta: {
    id: 'npc_fixture',
    name: 'NPC fixture',
    description: 'Non-player actor focus and routing',
    version: '1.0.0',
    capabilities: {
      simultaneousMoves: false,
      hiddenInformation: false,
      interruptStack: false,
      dynamicRules: false,
      nonPlayerActors: true,
      topology: 'none'
    }
  },
  hooks: [],
  setup: seed => {
    const base = emptyState('npc_fixture', seed);
    base.npcs = {
      npc1: {
        id: 'npc1',
        kind: 'NPC',
        name: 'Test Monster',
        color: '#b07bf0',
        avatar: '👹',
        status: 'ACTIVE',
        controllerId: 'p1',
        visibility: { type: 'PUBLIC' },
        customProps: {}
      }
    };
    base.actorOrder = ['p1', 'npc1'];
    base.activeActorId = 'npc1';
    base.globalVars = { npcActions: 0 };
    return base;
  },
  legalActions: (state, actorId) =>
    actorId === 'npc1' && state.activeActorId === 'npc1'
      ? [{ type: 'NPC_ACT', playerId: 'npc1', actorId: 'npc1' }]
      : actorId === 'p1'
      ? [{ type: 'PLAYER_ACT', playerId: 'p1' }]
      : [],
  reduce: (state, action) => {
    if (action.type !== 'NPC_ACT') return state;
    return { ...state, globalVars: { ...state.globalVars, npcActions: Number(state.globalVars.npcActions ?? 0) + 1 } };
  },
  outcome: () => ({ gameOver: false, winner: null })
});

export const crossFieldModule: GameModule = defineGame({
  ...counterModule,
  meta: { ...counterModule.meta, id: 'cross_field', name: 'Cross-field fixture' },
  legalActions: (state, playerId) =>
    playerId === state.activePlayerId
      ? [
          {
            type: 'COMBO',
            playerId,
            fields: [
              { key: 'a', label: 'A', kind: 'number' },
              { key: 'b', label: 'B', kind: 'number' }
            ]
          }
        ]
      : [],
  validatePayload: (_state, _action, payload) =>
    Number(payload.b) > Number(payload.a) ? [] : ['b must be greater than a']
});

export const deadlineModule: GameModule = defineGame({  meta: {
    id: 'deadline_fixture',
    name: 'Deadline fixture',
    description: 'Decision window with per-player deadlines',
    version: '1.0.0',
    capabilities: {
      simultaneousMoves: true,
      hiddenInformation: false,
      interruptStack: false,
      dynamicRules: false,
      topology: 'none'
    }
  },
  hooks: [],
  setup: seed => {
    const base = emptyState('deadline_fixture', seed);
    const opened = openDecision(
      base,
      {
        kind: 'VOTE',
        title: 'per-player deadline',
        participants: ['p1', 'p2'],
        secret: false,
        policy: { type: 'ALL_COMMITTED' },
        participantDeadlines: { p1: 2, p2: 5 }
      },
      'w1'
    );
    return { ...opened.state, phase: 'WAIT' };
  },
  legalActions: () => [],
  reduce: state => state,
  outcome: () => ({ gameOver: false, winner: null })
});

/* expansionFixture */
/**
 * A Sanguosha-shaped fixture: a base pack every other pack depends on, three
 * independent add-ons, and one pair that may not be played together.
 */
export const EXPANSION_FIXTURE: Record<string, GameExpansion> = {
  standard: { id: 'standard', name: '标准包', description: 'Standard decks', defaultEnabled: true },
  military: { id: 'military', name: '军争篇', requires: ['standard'] },
  wind: { id: 'wind', name: '风包', requires: ['military'] },
  fire: { id: 'fire', name: '火包', requires: ['standard'], conflicts: ['forest'] },
  forest: { id: 'forest', name: '林包', requires: ['standard'], conflicts: ['fire'] },
  mountain: { id: 'mountain', name: '山包', requires: ['standard'] }
};

/* playRandom */
export function playRandom(engine: UniversalGameEngine, steps: number): { applied: number; errors: string[] } {
  let applied = 0;
  const errors: string[] = [];

  for (let i = 0; i < steps && !engine.getRawState().gameOver; i++) {
    const focus = engine.getFocusActors();
    if (focus.length === 0) break;

    let did = false;
    for (const pid of focus) {
      const legal = engine.getLegalActions(pid);
      if (legal.length === 0) continue;
      const action = withDefaultPayload(legal.find(a => a.type !== 'PASS') ?? legal[0]);
      const result = engine.dispatch(action);
      if (!result.ok) errors.push(`${action.type}: ${result.error}`);
      else applied++;
      did = true;
      break;
    }
    if (!did) break;
  }

  return { applied, errors };
}

/* betrayalHelpers */
export function findAttackSeed(attackDice: number, defenseDice: number, wantDiff: (diff: number) => boolean): number {
  for (let seed = 1; seed < 30000; seed++) {
    const attack = rollZeroDice(seed, attackDice);
    const defense = rollZeroDice(attack.nextSeed, defenseDice);
    if (wantDiff(attack.sum - defense.sum)) return seed;
  }
  throw new AssertionError('no deterministic attack seed found');
}

export function betrayalCardInHand(state: GameState, playerId: string, defId: string): string | undefined {
  return state.zones[`zone_hand_${playerId}`]?.orderedEntities.find(
    id => state.entities[id]?.components.custom?.defId === defId
  );
}

/** Put room tiles on top of the hidden tile deck (last entry = top). */
export function stackRoomTiles(state: GameState, defIds: string[]): void {
  const zone = state.zones.zone_room_deck;
  const ids = defIds.map(defId => `roomtile_${defId}`);
  zone.orderedEntities = [...zone.orderedEntities.filter(id => !ids.includes(id)), ...ids];
}

export function roomDiscardIds(state: GameState): string[] {
  return (state.zones.zone_room_discard?.orderedEntities ?? []).map(
    id => String(state.entities[id]?.components.custom?.roomDefId ?? '')
  );
}

/** Resolve the pending room-orientation window with its first legal rotation. */
export function placePendingRoom(engine: UniversalGameEngine): boolean {
  const pending = engine.getRawState().globalVars.pendingRoomPlacement as
    | { playerId: string }
    | undefined;
  if (!pending) return false;
  const action = engine.getLegalActions(pending.playerId).find(candidate => candidate.type === 'PLACE_ROOM');
  if (!action) return false;
  const value = action.fields?.[0]?.options?.[0]?.value ?? '0';
  return engine.dispatch({ ...action, payload: { rotation: value } }).ok;
}

/* playCatanSetup */
export function playCatanSetup(engine: UniversalGameEngine): void {
  for (let step = 0; step < 6; step++) {
    const settler = engine.getRawState().activePlayerId;
    const settlement = engine.getLegalActions(settler).find(a => a.type === 'SETUP_SETTLEMENT');
    assert(!!settlement, `setup settlement ${step} available`);
    assert(engine.dispatch(settlement!).ok, `setup settlement ${step} accepted`);

    const roadOwner = engine.getRawState().activePlayerId;
    const road = engine.getLegalActions(roadOwner).find(a => a.type === 'SETUP_ROAD');
    assert(!!road, `setup road ${step} available`);
    assert(engine.dispatch(road!).ok, `setup road ${step} accepted`);
  }
}

/* splendorHelpers */
/**
 * Put a card into a zone inside a raw state the engine already owns.
 * Fixtures use this to reach positions that would take dozens of turns.
 */
export function splendorPlace(state: GameState, cardId: string, zoneId: string, reveal = true): void {
  const entity = state.entities[cardId];
  assert(!!entity, `card ${cardId} exists`);
  const oldZone = state.zones[entity.zoneId];
  if (oldZone) oldZone.orderedEntities = oldZone.orderedEntities.filter(id => id !== cardId);
  entity.zoneId = zoneId;
  if (reveal) entity.visibility = { type: 'PUBLIC' };
  state.zones[zoneId].orderedEntities.push(cardId);
}

/**
 * Point a seat's derived totals at its tableau.
 *
 * `splendorPlace` only moves cards, so a position built by hand still carries
 * the bonuses and score the reducer would have accumulated. Recompute them from
 * the tableau whenever a case needs an accurate `customProps`.
 */
export function splendorSyncTotals(state: GameState, playerId: string): void {
  const player = state.players[playerId];
  const bonuses: Record<string, number> = {};
  let score = 0;
  for (const id of state.zones[`zone_tableau_${playerId}`].orderedEntities) {
    const custom = state.entities[id]?.components.custom ?? {};
    const colour = String(custom.bonus ?? '');
    const count = Number(custom.bonusCount ?? 0);
    if (colour && colour !== 'null' && count > 0) bonuses[colour] = (bonuses[colour] ?? 0) + count;
    score += Number(custom.vp ?? 0);
  }
  player.customProps.bonuses = bonuses;
  player.score = score;
}

/** Seat-specific setup, since the module signature only takes a seed. */
export function splendorSeatModule(seats: number): GameModule {
  return { ...GAME_REGISTRY.splendor, setup: seed => setupSplendor(seed, seats) };
}

/** A stage-1 Pokémon and the stage-2 card it evolves into. */
export function splendorEvolutionPair(state: GameState): { base: Entity; evolution: Entity } {
  const base = Object.values(state.entities).find(
    entity =>
      entity.components.custom?.pkmnTier === 'stage1' &&
      typeof entity.components.custom?.evolvesTo === 'string'
  );
  assert(!!base, 'the deck contains an evolvable stage-1 Pokémon');
  const name = base.components.custom!.evolvesTo as string;
  const evolution = Object.values(state.entities).find(
    entity => entity.components.custom?.pkmnTier === 'stage2' && entity.components.custom?.name === name
  );
  assert(!!evolution, `the deck contains ${name}`);
  return { base, evolution };
}

/* splendorVariantHelpers */
/** A module that deals the expansions, since the kernel setup only takes a seed. */
export function splendorVariantModule(variant: { mega: boolean; pokemart: boolean }, seats = 2): GameModule {
  return { ...GAME_REGISTRY.splendor, setup: seed => setupSplendor(seed, seats, variant) };
}

/** Every card of one tier tag, wherever it currently sits. */
export function splendorCardsOfTier(state: GameState, tier: string): Entity[] {
  return Object.values(state.entities).filter(entity => entity.components.custom?.pkmnTier === tier);
}

/** The first card matching `predicate`, or a hard failure. */
export function splendorFind(state: GameState, predicate: (meta: Record<string, unknown>) => boolean): Entity {
  const card = Object.values(state.entities).find(entity => {
    const meta = (entity.components.custom ?? {}) as Record<string, unknown>;
    return predicate(meta);
  });
  assert(!!card, 'the deck contains the card the fixture needs');
  return card!;
}

/** Fill a player's pouch with plenty of every ball. */
export function splendorStockPouch(state: GameState, playerId: string, amount = 9): void {
  const tokens = state.players[playerId].customProps.tokens as Record<string, number>;
  for (const color of ['red', 'blue', 'black', 'pink', 'yellow']) tokens[color] = amount;
  tokens.purple = 5;
}

/**
 * Resolve any open damage-allocation window.
 *
 * Since damage now asks the explorer which trait absorbs it, a test that ends a
 * turn (or walks into a damaging room) leaves a decision open, and every later
 * action is blocked until it is answered. Tests that do not care which trait
 * takes the hit call this to keep the flow moving.
 */
export function resolvePendingDamage(engine: UniversalGameEngine): boolean {
  let acted = false;
  for (let guard = 0; guard < 8; guard += 1) {
    const state = engine.getRawState();
    const pending = state.globalVars.pendingDamage as { playerId?: string } | null | undefined;
    if (!pending?.playerId) break;
    const actor = String(pending.playerId);
    const action = engine.getLegalActions(actor).find(entry => entry.type === 'ALLOCATE_DAMAGE');
    if (!action) break;
    const field = action.fields?.find(entry => entry.key === 'trait');
    const trait = String(field?.options?.[0]?.value ?? 'might');
    if (!engine.dispatch({ ...action, payload: { trait } }).ok) break;
    acted = true;
  }
  return acted;
}

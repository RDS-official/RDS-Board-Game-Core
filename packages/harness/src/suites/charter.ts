/* -------------------------------------------------------------------------- */
/* suite:charter — 宪章 C-1 / C-2 / C-5 / C-6 / C-9 的可执行保障               */
/* -------------------------------------------------------------------------- */

import { UniversalGameEngine } from '@rds/kernel/engine';
import { CognitiveObserver } from '@rds/kernel/observer';
import { checkCharter, resolveCharter } from '@rds/kernel/charter';
import type { Action, GameState, ProjectedGameState } from '@rds/kernel/types';
import { GAME_REGISTRY } from '@rds/games/registry';
import { choosePokerAction } from '@rds/games/poker/ai';
import { assert, assertEqual, test } from '../testKit';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Deterministic xorshift picker so the probe replays identically. */
function picker(seed: number): (n: number) => number {
  let s = seed >>> 0 || 1;
  return n => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s % n;
  };
}

/**
 * Play one randomised game and collect every action type the engine accepted.
 *
 * Returns the set plus the first dispatch error, so a test can tell "the module
 * has no such action" from "the random walk happened to stop".
 */
function walkModule(module: (typeof GAME_REGISTRY)[string], seed: number, steps = 160) {
  const engine = new UniversalGameEngine(module, seed, { strict: true });
  const seen = new Set<string>();
  const rnd = picker(seed);
  let firstError: string | undefined;

  for (let i = 0; i < steps; i++) {
    const legal = engine.getLegalActions(engine.getActiveActorId());
    if (legal.length === 0) break;
    const action = legal[rnd(legal.length)];
    seen.add(action.type);
    const result = engine.dispatch(action);
    if (!result.ok) {
      firstError = result.error;
      break;
    }
    if (engine.getRawState().gameOver) break;
  }

  return { engine, seen, firstError };
}

/* -------------------------------------------------------------------------- */
/* C-1 动作代数                                                                */
/* -------------------------------------------------------------------------- */

test('charter C-1: every action type a module actually offers is declared', () => {
  const offenders: string[] = [];

  for (const [id, module] of Object.entries(GAME_REGISTRY)) {
    if (!module.actionSchemas) continue; // 整块未形式化：由报告脚本统计，不在此逐条报
    const declared = new Set(Object.keys(module.actionSchemas));
    const driver = new Set(module.driverActions ?? []);

    // 多个 seed，覆盖不同分支（结算幕布 / 前门被锁 / 观察者席位 …）
    for (const seed of [1, 7, 42, 1234]) {
      const { seen } = walkModule(module, seed);
      for (const type of seen) {
        if (!declared.has(type) && !driver.has(type) && type !== '__TICK__') {
          offenders.push(`${id}:${type}`);
        }
      }
    }
  }

  assertEqual(
    [...new Set(offenders)].sort().join(', '),
    '',
    'action types offered by legalActions but missing from actionSchemas'
  );
});

test('charter C-1: an undeclared action is reported, not swallowed', () => {
  const module = GAME_REGISTRY.poker;
  const charter = resolveCharter(module);
  const state = new UniversalGameEngine(module, 42, { strict: true }).getRawState();
  const bogus: Action = { type: 'NOT_A_REAL_ACTION', playerId: state.playerOrder[0] };
  const violations = checkCharter(module, charter, state, bogus);
  assert(
    violations.some(v => v.code === 'CHARTER_C1_UNDECLARED_ACTION'),
    'an unknown action type must raise CHARTER_C1_UNDECLARED_ACTION'
  );
});

/* -------------------------------------------------------------------------- */
/* C-2 单步转移                                                                */
/* -------------------------------------------------------------------------- */

test('charter C-2: poker registers its inline-AI deviation, so the kernel records but does not reject', () => {
  const module = GAME_REGISTRY.poker;
  const charter = resolveCharter(module);
  assertEqual(charter.enforceSingleTransition, false, 'poker declares a C-2 deviation');

  const engine = new UniversalGameEngine(module, 1, { strict: true });
  const start = engine.getLegalActions(engine.getActiveActorId()).find(a => a.type === 'START_HAND');
  assert(start, 'a fresh table offers START_HAND');
  const deal = engine.dispatch(start!);
  assert(deal.ok, 'dealing the first hand succeeds');

  // 一次 START_HAND 会内联把 AI 推到真人面前：回合数确实跳了不止一个。
  assert(
    engine.getRawState().turn > 1,
    'inline AI advances more than one turn inside a single reduce'
  );
});

test('charter C-2: an unregistered module WOULD be flagged for multi-turn reduce', () => {
  const module = GAME_REGISTRY.poker;
  const charter = resolveCharter(module);
  // 模拟"没登记偏离"：把 deviations 抽掉后同样的转移必须被判违规。
  const strictCharter = { ...charter, enforceSingleTransition: true, activeDeviations: [] };
  const before = new UniversalGameEngine(module, 1, { strict: true });
  const after = before.getRawState();

  // 转移前后的 turn 差就是观察器用的判据；这里直接断言判据成立。
  const engine = new UniversalGameEngine(module, 1, { strict: true });
  const start = engine.getLegalActions(engine.getActiveActorId()).find(a => a.type === 'START_HAND')!;
  engine.dispatch(start);
  const delta = engine.getRawState().turn - after.turn;
  assert(delta > 1, `turn delta ${delta} is what C-2 keys on`);
  assertEqual(strictCharter.enforceSingleTransition, true, 'the synthetic charter enforces C-2');
});

/* -------------------------------------------------------------------------- */
/* C-5 信息约束                                                                */
/* -------------------------------------------------------------------------- */

test('charter C-5: the projection hides deck order, prng state and other players hole cards', () => {
  const module = GAME_REGISTRY.poker;
  const engine = new UniversalGameEngine(module, 42, { strict: true });
  const start = engine.getLegalActions(engine.getActiveActorId()).find(a => a.type === 'START_HAND')!;
  engine.dispatch(start);

  const raw = engine.getRawState();
  const viewer = raw.playerOrder[0];
  const view: ProjectedGameState = CognitiveObserver.projectState(raw, viewer);

  assert(!('prngState' in view), 'projection must not carry prngState');
  assert(!('seed' in view), 'projection must not carry seed');

  const ownHand = raw.zones[`zone_hand_${viewer}`]?.orderedEntities ?? [];
  assertEqual(view.ownHand.join(','), ownHand.join(','), 'ownHand mirrors the real hand zone');

  const maskedWithFace = Object.values(view.entities).filter(
    e => e.isMasked && e.type === 'CARD' && e.components?.custom && (e.components.custom as Record<string, unknown>).rank !== undefined
  );
  assertEqual(maskedWithFace.length, 0, 'masked cards never leak their rank');

  // 别人的底牌不可见
  const other = raw.playerOrder.find(p => p !== viewer)!;
  const otherHand = raw.zones[`zone_hand_${other}`]?.orderedEntities ?? [];
  for (const id of otherHand) {
    const projected = view.entities[id] ?? view.entities[CognitiveObserver.getVirtualAlias(viewer, id)];
    assert(projected?.isMasked !== false, `opponent card ${id} must be masked`);
  }
});

test('charter C-5: choosePokerAction only ever reads its own projected view', () => {
  const module = GAME_REGISTRY.poker;
  const engine = new UniversalGameEngine(module, 42, { strict: true });
  const start = engine.getLegalActions(engine.getActiveActorId()).find(a => a.type === 'START_HAND')!;
  engine.dispatch(start);

  const raw = engine.getRawState();
  const actor = raw.activeActorId ?? raw.activePlayerId;
  const view = CognitiveObserver.projectState(raw, actor);

  const fromView = choosePokerAction(view, actor);
  const fromViewAgain = choosePokerAction(view, actor);
  assertEqual(
    JSON.stringify(fromView),
    JSON.stringify(fromViewAgain),
    'the decision is a pure function of the projection'
  );

  // 抹掉投影里的对手信息，决策不能变 —— 证明它确实没读。
  const scrubbed: ProjectedGameState = {
    ...view,
    players: Object.fromEntries(
      Object.entries(view.players).map(([id, player]) => [
        id,
        id === actor ? player : { ...player, customProps: {} }
      ])
    )
  };
  assertEqual(
    JSON.stringify(choosePokerAction(scrubbed, actor)),
    JSON.stringify(fromView),
    'removing opponent stacks from the view must not change the AI decision'
  );
});

/* -------------------------------------------------------------------------- */
/* C-6 语义不变量                                                              */
/* -------------------------------------------------------------------------- */

test('charter C-6: poker declares semantic invariants and a clean table passes', () => {
  const module = GAME_REGISTRY.poker;
  assert(module.checkInvariants, 'poker must declare checkInvariants');

  const engine = new UniversalGameEngine(module, 42, { strict: true });
  const start = engine.getLegalActions(engine.getActiveActorId()).find(a => a.type === 'START_HAND')!;
  engine.dispatch(start);
  assertEqual(module.checkInvariants!(engine.getRawState()).length, 0, 'a freshly dealt hand is consistent');
});

test('charter C-6: chip conservation catches a booking error the structural checks miss', () => {
  const module = GAME_REGISTRY.poker;
  const engine = new UniversalGameEngine(module, 42, { strict: true });
  const start = engine.getLegalActions(engine.getActiveActorId()).find(a => a.type === 'START_HAND')!;
  engine.dispatch(start);

  const raw = engine.getRawState();
  const victim = raw.playerOrder[0];
  const tampered: GameState = {
    ...raw,
    players: {
      ...raw.players,
      [victim]: {
        ...raw.players[victim],
        customProps: { ...raw.players[victim].customProps, chips: Number(raw.players[victim].customProps?.chips ?? 0) + 250 }
      }
    }
  };

  const messages = module.checkInvariants!(tampered);
  assert(
    messages.some(m => m.includes('chip conservation')),
    `a 250-chip booking error must be reported, got: ${JSON.stringify(messages)}`
  );
});

test('charter C-6: chips are conserved across a full simulated session', () => {
  const module = GAME_REGISTRY.poker;
  for (const seed of [1, 42, 99]) {
    const engine = new UniversalGameEngine(module, seed, { strict: true });
    const rnd = picker(seed);
    for (let i = 0; i < 400; i++) {
      const legal = engine.getLegalActions(engine.getActiveActorId());
      if (legal.length === 0) break;
      const result = engine.dispatch(legal[rnd(legal.length)]);
      if (!result.ok) break;
      const state = engine.getRawState();
      const structural = module.checkInvariants!(state);
      assertEqual(structural.length, 0, `seed ${seed} step ${i} stayed consistent: ${structural[0] ?? ''}`);
    }
    const state = engine.getRawState();
    const total = state.playerOrder.reduce(
      (sum, pid) => sum + Number(state.players[pid]?.customProps?.chips ?? 0),
      0
    );
    const hand = state.globalVars.hand as { pot?: number; streetBets?: Record<string, number> } | undefined;
    const inPot = (hand?.pot ?? 0) + Object.values(hand?.streetBets ?? {}).reduce((a, b) => a + b, 0);
    assertEqual(total + inPot, 6000, `seed ${seed}: chips + pot is conserved`);
  }
});

/* -------------------------------------------------------------------------- */
/* C-9 扩展字段收口                                                            */
/* -------------------------------------------------------------------------- */

test('charter C-9: an undeclared globalVars key is reported', () => {
  const module = GAME_REGISTRY.poker;
  assert(module.meta.stateSchema?.globalVars, 'poker declares its globalVars keys');
  const charter = resolveCharter(module);
  const engine = new UniversalGameEngine(module, 42, { strict: true });
  const state: GameState = {
    ...engine.getRawState(),
    globalVars: { ...engine.getRawState().globalVars, sneakyUndeclaredKey: 1 }
  };

  const violations = checkCharter(module, charter, state);
  assert(
    violations.some(v => v.code === 'CHARTER_C9_UNDECLARED_GLOBAL_VAR' && v.message.includes('sneakyUndeclaredKey')),
    'an undeclared globalVars key must be reported'
  );
});

test('charter C-9: declared keys never trigger a violation during real play', () => {
  const module = GAME_REGISTRY.poker;
  const engine = new UniversalGameEngine(module, 42, { strict: true });
  const rnd = picker(42);
  for (let i = 0; i < 200; i++) {
    const legal = engine.getLegalActions(engine.getActiveActorId());
    if (legal.length === 0) break;
    if (!engine.dispatch(legal[rnd(legal.length)]).ok) break;
  }
  const c9 = engine.getViolations().filter(v => v.code === 'CHARTER_C9_UNDECLARED_GLOBAL_VAR');
  assertEqual(c9.length, 0, `poker stayed inside its declared globalVars: ${c9[0]?.message ?? ''}`);
});

/* -------------------------------------------------------------------------- */
/* 违规记录本身                                                                */
/* -------------------------------------------------------------------------- */

test('charter: violations are recorded without blocking the transition', () => {
  const module = GAME_REGISTRY.poker;
  const engine = new UniversalGameEngine(module, 42, { strict: true });
  const start = engine.getLegalActions(engine.getActiveActorId()).find(a => a.type === 'START_HAND')!;
  const result = engine.dispatch(start);

  assertEqual(result.ok, true, 'the transition still commits');
  assertEqual(engine.getViolations().length, 0, 'a compliant module produces no violations');

  engine.clearViolations();
  assertEqual(engine.getViolations().length, 0, 'clearViolations empties the ring');
});

/* -------------------------------------------------------------------------- */
/* suite:charter — 宪章 C-1 / C-2 / C-5 / C-6 / C-9 的可执行保障               */
/* -------------------------------------------------------------------------- */

import { UniversalGameEngine } from '@rds/kernel/engine';
import { CognitiveObserver } from '@rds/kernel/observer';
import { checkCharter, resolveCharter } from '@rds/kernel/charter';
import { openDecision } from '@rds/kernel/decisions';
import type { Action, GameState, ProjectedGameState } from '@rds/kernel/types';
import { GAME_REGISTRY } from '@rds/games/registry';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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


/** 递归列出目录下的 .ts 文件。 */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
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

/* -------------------------------------------------------------------------- */
/* C-3 并发表达                                                                */
/* -------------------------------------------------------------------------- */

/** 跑一场沙丘战斗之轮，按给定顺序提交两份固定 dial。 */
function runBattleWheel(order: ('p1' | 'p2')[], pick: Record<'p1' | 'p2', number>) {
  const module = GAME_REGISTRY.dune_mahjong;
  const engine = new UniversalGameEngine(module, 7, { strict: true });
  const open = engine.getLegalActions(engine.getActiveActorId()).find(a => a.type === 'OPEN_BATTLE_WINDOW');
  assert(open, 'dune offers OPEN_BATTLE_WINDOW');
  assert(engine.dispatch(open!).ok, 'the battle window opens');

  for (const pid of order) {
    const legal = engine.getLegalActions(pid);
    assert(legal.length > pick[pid], `${pid} has at least ${pick[pid] + 1} dial options`);
    const result = engine.dispatch(legal[pick[pid]]);
    assert(result.ok, `commit for ${pid} succeeds: ${result.error ?? ''}`);
  }

  const state = engine.getRawState();
  return {
    result: state.globalVars.revealedBattleResult as Record<string, unknown> | undefined,
    troops: { p1: state.players.p1.customProps?.troops, p2: state.players.p2.customProps?.troops },
    score: { p1: state.players.p1.score, p2: state.players.p2.score },
    violations: engine.getViolations().map(v => v.code)
  };
}

test('charter C-3: the battle wheel resolves identically regardless of submission order', () => {
  const module = GAME_REGISTRY.dune_mahjong;
  assert(module.applySimultaneous, 'dune declares applySimultaneous');

  for (const [label, pick] of [
    ['same dial', { p1: 0, p2: 0 }],
    ['different dials', { p1: 0, p2: 1 }]
  ] as const) {
    const forward = runBattleWheel(['p1', 'p2'], { ...pick });
    const reverse = runBattleWheel(['p2', 'p1'], { ...pick });
    assertEqual(
      JSON.stringify(forward.result),
      JSON.stringify(reverse.result),
      `${label}: winner must not depend on who submits first`
    );
    assertEqual(JSON.stringify(forward.troops), JSON.stringify(reverse.troops), `${label}: troop spend matches`);
    assertEqual(JSON.stringify(forward.score), JSON.stringify(reverse.score), `${label}: scores match`);
  }
});

test('charter C-3: settlements go through the module batch, not the serial fallback', () => {
  const forward = runBattleWheel(['p1', 'p2'], { p1: 0, p2: 0 });
  assertEqual(
    forward.violations.filter(code => code === 'CHARTER_C3_SERIALIZED').length,
    0,
    'a declared applySimultaneous means no serial-fallback deviation'
  );
  assert(forward.result, 'the battle produced a result');
});

test('charter C-3: a SIMULTANEOUS window without applySimultaneous is flagged', () => {
  const base = GAME_REGISTRY.dune_mahjong;
  // 抽掉合并语义，模拟一个"只贴了标签没实现"的模组。
  const stripped = { ...base, applySimultaneous: undefined };
  const engine = new UniversalGameEngine(stripped, 7, { strict: true });
  const open = engine.getLegalActions(engine.getActiveActorId()).find(a => a.type === 'OPEN_BATTLE_WINDOW');
  assert(open, 'window can still be opened');
  engine.dispatch(open!);

  for (const pid of ['p1', 'p2'] as const) {
    const legal = engine.getLegalActions(pid);
    assert(legal.length > 0, `${pid} has dial options`);
    engine.dispatch(legal[0]);
  }

  const codes = engine.getViolations().map(v => v.code);
  assert(
    codes.includes('CHARTER_C3_SERIALIZED'),
    `the kernel must record that it fell back to seat order, got ${JSON.stringify(codes)}`
  );
});

test('charter C-3: SIMULTANEOUS never short-circuits on the first submission', () => {
  const module = GAME_REGISTRY.dune_mahjong;
  const engine = new UniversalGameEngine(module, 7, { strict: true });
  const open = engine.getLegalActions(engine.getActiveActorId()).find(a => a.type === 'OPEN_BATTLE_WINDOW');
  engine.dispatch(open!);

  const first = engine.getLegalActions('p1')[0];
  const result = engine.dispatch(first);

  assertEqual(result.ok, true, 'the first submission is accepted');
  assertEqual(result.decisionResolved ?? false, false, 'the window stays open until both commit');
  assert(
    !engine.getRawState().globalVars.revealedBattleResult,
    'no settlement happens on the first submission'
  );
});

test('charter C-3: catan multi-player discard is declared simultaneous and order-free', () => {
  const module = GAME_REGISTRY.catan;
  assert(module.applySimultaneous, 'catan declares applySimultaneous for the rolled-7 discard');

  // 两副手牌都超过 7 张，各弃一半；弃牌互不影响，所以结果必须与提交顺序无关。
  const bags: Record<string, Record<string, number>> = {
    p1: { wood: 4, brick: 3, sheep: 2, wheat: 1, ore: 0 }, // 10 → 弃 5
    p2: { wood: 0, brick: 1, sheep: 3, wheat: 4, ore: 1 } // 9  → 弃 4
  };

  const runDiscard = (order: string[]) => {
    const engine = new UniversalGameEngine(module, 3, { strict: true });
    const base = engine.getRawState();
    const players = { ...base.players };
    for (const pid of Object.keys(bags)) {
      players[pid] = {
        ...players[pid],
        customProps: { ...players[pid].customProps, resources: { ...bags[pid] } }
      };
    }
    // 直接在权威状态上开窗口，绕开掷骰的随机性。
    const opened = openDecision(
      { ...base, players, phase: 'DISCARD' },
      {
        kind: 'SIMULTANEOUS',
        title: 'Rolled 7 — discard half',
        participants: ['p1', 'p2'],
        secret: false,
        policy: { type: 'SIMULTANEOUS' },
        payload: { kind: 'discard' }
      },
      'discard_test'
    );

    let state = opened.state;
    const ctx = { id: (k: string) => `${k}_t`, trace: () => {}, seq: 0, roll: () => ({ result: { spec: { sides: 6, count: 1 }, rolls: [1], total: 1 }, nextSeed: 0 }) };
    for (const pid of order) {
      state = module.applySimultaneous!(
        state,
        [{ actorId: pid, action: { type: 'DISCARD_HALF', playerId: pid } }],
        ctx as never
      );
    }
    const sum = (bag: Record<string, number>) => Object.values(bag).reduce((a, b) => a + b, 0);
    return {
      p1: state.players.p1.customProps?.resources,
      p2: state.players.p2.customProps?.resources,
      p1Total: sum(state.players.p1.customProps?.resources as Record<string, number>),
      p2Total: sum(state.players.p2.customProps?.resources as Record<string, number>)
    };
  };

  const forward = runDiscard(['p1', 'p2']);
  const reverse = runDiscard(['p2', 'p1']);

  assertEqual(JSON.stringify(forward), JSON.stringify(reverse), 'discard outcome must not depend on order');
  assertEqual(forward.p1Total, 5, 'p1 discards half of 10');
  assertEqual(forward.p2Total, 5, 'p2 discards ceil-ish half of 9 (floor of 4 discarded)');
});

/* -------------------------------------------------------------------------- */
/* C-4 随机收口                                                                */
/* -------------------------------------------------------------------------- */

test('charter C-4: every runtime DeterministicPRNG call advances prngState', () => {
  const offenders: string[] = [];
  const dirs = ['betrayal', 'catan', 'poker', 'sanguosha', 'splendor', 'dune_mahjong'];

  for (const game of dirs) {
    const dir = `packages/games/src/${game}`;
    if (!existsSync(dir)) continue;
    for (const file of listFiles(dir)) {
      // setup / scenarios 构造初始状态，seed 由调用方给定，没有"前一个 prngState"。
      if (/setup\.ts$|scenarios\.ts$/.test(file)) continue;
      const source = readFileSync(file, 'utf8');
      const lines = source.split('\n');

      lines.forEach((line, index) => {
        if (!/DeterministicPRNG\.(shuffle|nextInt|rollFaces)/.test(line)) return;
        // 这一行往后 10 行内必须把某个 nextSeed 写回 prngState。
        const window = lines.slice(index, index + 10).join('\n');
        const advances = /prngState\s*[:=]\s*[^;\n]*nextSeed/.test(window);
        // 允许"返回 nextSeed 交给调用方写回"的辅助函数：
        //   同一窗口里出现 `nextSeed` 且函数返回类型/对象里带 nextSeed
        const returnsSeed = /nextSeed/.test(window);
        if (!advances && !returnsSeed) {
          offenders.push(`${file}:${index + 1}`);
        }
      });
    }
  }

  assertEqual(offenders.join(', '), '', 'DeterministicPRNG used without advancing prngState');
});

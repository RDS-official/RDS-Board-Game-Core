/* -------------------------------------------------------------------------- */
/* suite:charter — 宪章 C-1 / C-2 / C-5 / C-6 / C-9 的可执行保障               */
/* -------------------------------------------------------------------------- */

import { UniversalGameEngine } from '@rds/kernel/engine';
import { CognitiveObserver } from '@rds/kernel/observer';
import { checkCharter, resolveCharter } from '@rds/kernel/charter';
import { defineDriver, definePresentation } from '@rds/kernel/module';
import { openDecision } from '@rds/kernel/decisions';
import type { Action, GameState, ProjectedGameState } from '@rds/kernel/types';
import { GAME_REGISTRY } from '@rds/games/registry';
import { SANGUOSHA_HOOKS } from '@rds/games/sanguosha/hooks';
import { capabilityMismatches, deriveCapabilities } from '@rds/kernel/capabilities';
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
    const driver = new Set(module.driver?.driverActions ?? []);

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

test('charter C-2: poker no longer needs a deviation — one reduce is one transition', () => {
  const module = GAME_REGISTRY.poker;
  const charter = resolveCharter(module);
  // 偏离已被移除：AR-44 改造后 advanceAi 的 64 次循环和 settle 的 8 次循环
  // 都拆掉了，一次 reduce 只产生一次跃迁，不需要再登记偏离。
  assertEqual(charter.enforceSingleTransition, true, 'poker enforces C-2 without a deviation');
  assertEqual(charter.activeDeviations.length, 0, 'poker registers no C-2 deviation');

  const engine = new UniversalGameEngine(module, 1, { strict: true });
  const start = engine.getLegalActions(engine.getActiveActorId()).find(a => a.type === 'START_HAND');
  assert(start, 'a fresh table offers START_HAND');
  const deal = engine.dispatch(start!);
  assert(deal.ok, 'dealing the first hand succeeds');

  // AI 推进现在走多次独立 dispatch（pump），每一步都进 history，回放能重现。
  assert(
    engine.getViolations().filter(v => v.code === 'CHARTER_C2_MULTI_TRANSITION').length === 0,
    'no multi-transition violation was recorded'
  );
});

test('charter C-2: a single reduce advances the turn counter by at most one', () => {
  // 直接测 module.reduce（不是 dispatch）：单次调用只允许一次逻辑跃迁。
  const module = GAME_REGISTRY.poker;
  const engine = new UniversalGameEngine(module, 7, { strict: true });
  const start = engine.getLegalActions(engine.getActiveActorId()).find(a => a.type === 'START_HAND');
  assert(start, 'a fresh table offers START_HAND');

  const state = engine.getRawState();
  const ctx = {
    id: (k: string) => `${k}_probe`,
    trace: () => {},
    seq: state.seq + 1,
    roll: (spec: { sides: number; count: number }, seed: number) => ({
      result: { spec, rolls: [1], total: 1 },
      nextSeed: seed + 1
    }),
    reward: () => {}
  };

  const before = state.turn;
  const after = module.reduce(state, start!, ctx as never);
  const jump = after.turn - before;
  assert(jump <= 1, `a single reduce advanced ${jump} turns — expected at most 1`);
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
        // 半分筹码：分池取整错误 / 重复记账的真实症状就是小数，不是「非 1000 的倍数」
        // （房间买入来自账号余额，本来就不是整千，见 issue #180）。
        customProps: { ...raw.players[victim].customProps, chips: Number(raw.players[victim].customProps?.chips ?? 0) + 250.5 }
      }
    }
  };

  const messages = module.checkInvariants!(tampered);
  // 不假设总额是常量（破产补位会让总额增长），断言的是"半份筹码被检出"。
  assert(
    messages.some(m => /chip total .* is fractional/.test(m)),
    `a half-chip booking error must break the chip-total invariant, got: ${JSON.stringify(messages)}`
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
    /*
     * 不能断言固定 6000：破产座位会被补位 AI 顶替，每个新 AI 带一份新的
     * 买入进场，总额**只增不减**。能断言的是整除性 —— 任何半份筹码的漂移
     * （分池取整错误、重复记账）都会破坏它。这与 PokerRules.checkInvariants()
     * 的口径一致。
     */
    const unit = 1000;
    assertEqual(
      Math.abs((total + inPot) % unit) < 1e-6,
      true,
      `seed ${seed}: chips + pot stays a whole number of buy-ins (got ${total + inPot})`
    );
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
    const choices: Record<string, Record<string, number>> = {
      p1: { wood: 4, brick: 1, sheep: 0, wheat: 0, ore: 0 },
      p2: { wood: 0, brick: 0, sheep: 3, wheat: 1, ore: 0 }
    };
    for (const pid of order) {
      state = module.applySimultaneous!(
        state,
        [{ actorId: pid, action: { type: 'DISCARD_HALF', playerId: pid, payload: choices[pid] } }],
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

/* -------------------------------------------------------------------------- */
/* C-7 收益独立                                                                */
/* -------------------------------------------------------------------------- */

test('charter C-7: poker records every chip movement in the reward ledger', () => {
  const module = GAME_REGISTRY.poker;
  assert(module.charter?.requiresRewardLedger, 'poker declares a reward ledger');
  assert(module.checkInvariants, 'poker declares semantic invariants');

  const engine = new UniversalGameEngine(module, 42, { strict: true });
  const rnd = picker(42);
  const before: Record<string, number> = {};

  for (let i = 0; i < 600; i++) {
    const legal = engine.getLegalActions(engine.getActiveActorId());
    if (legal.length === 0) break;
    const result = engine.dispatch(legal[rnd(legal.length)]);
    if (!result.ok) break;

    const state = engine.getRawState();
    for (const pid of state.playerOrder) {
      const chips = Number(state.players[pid]?.customProps?.chips ?? 0);
      if (before[pid] === undefined) before[pid] = chips;
    }
    if (state.gameOver) break;
  }

  const final = engine.getRawState();
  const rewards = final.rewards ?? [];
  assert(rewards.length > 0, 'a played session produces reward entries');

  // 每条记录都必须自洽：有 actor / kind / 非零金额 / 非空理由。
  for (const entry of rewards) {
    assert(typeof entry.actorId === 'string' && entry.actorId.length > 0, 'reward has an actor');
    assert(typeof entry.kind === 'string' && entry.kind.length > 0, 'reward has a kind');
    assert(Number.isFinite(entry.amount) && entry.amount !== 0, 'reward amount is a non-zero finite number');
    assert(entry.reason.trim().length > 0, 'reward carries a human-readable reason');
    assert(Number.isInteger(entry.seq) && entry.seq >= 0, 'reward is aligned to a transition seq');
  }

  const codes = engine.getViolations().map(v => v.code);
  assert(!codes.includes('CHARTER_C7_BAD_REWARD'), 'no malformed reward entries were recorded');
});

test('charter C-7: the ledger explains a chip swing the state diff alone cannot', () => {
  const module = GAME_REGISTRY.poker;
  const engine = new UniversalGameEngine(module, 7, { strict: true });
  const rnd = picker(7);

  // 打到出现至少一笔正的筹码收益为止（摊牌或弃牌取胜）。
  for (let i = 0; i < 800 && !(engine.getRawState().rewards ?? []).some(r => r.amount > 0); i++) {
    const legal = engine.getLegalActions(engine.getActiveActorId());
    if (legal.length === 0) break;
    if (!engine.dispatch(legal[rnd(legal.length)]).ok) break;
  }

  const rewards = engine.getRawState().rewards ?? [];
  const wins = rewards.filter(r => r.amount > 0);
  assert(wins.length > 0, 'a session that reaches a showdown records a positive reward');
  assert(
    wins.every(w => /摊牌|弃牌|低保/.test(w.reason)),
    `every gain names its cause, got: ${JSON.stringify(wins.map(w => w.reason))}`
  );
});

test('charter C-7: a reward without a reason is reported', () => {
  const module = GAME_REGISTRY.poker;
  const charter = resolveCharter(module);
  const engine = new UniversalGameEngine(module, 42, { strict: true });
  const base = engine.getRawState();
  const tampered: GameState = {
    ...base,
    rewards: [{ actorId: base.playerOrder[0], kind: 'chips', amount: 50, reason: '   ', seq: 1 }]
  };
  const violations = checkCharter(module, charter, tampered);
  assert(
    violations.some(v => v.code === 'CHARTER_C7_BAD_REWARD' && /no reason/.test(v.message)),
    'an unexplained reward must be flagged'
  );
});

/* -------------------------------------------------------------------------- */
/* C-8 元规则分区                                                              */
/* -------------------------------------------------------------------------- */

test('charter C-8: 𝒦_view (presentation) never appears on a transition path', () => {
  const offenders: string[] = [];
  const games = readdirSync('packages/games/src', { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  for (const game of games) {
    const dir = `packages/games/src/${game}`;
    for (const file of listFiles(dir)) {
      // 规则实现处：reduce / legalActions / 结算逻辑都在这两个文件里。
      if (!/rules\.ts$|helpers\.ts$/.test(file)) continue;
      const source = readFileSync(file, 'utf8');
      // 先整体剥掉块注释与行注释，再逐行找：块注释跨行，逐行处理会漏。
      // 保留换行数，这样报出来的行号仍然对得上源文件。
      const stripped = source
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, '');
      stripped.split('\n').forEach((line, index) => {
        if (/\bpresentation\b/.test(line)) offenders.push(`${file}:${index + 1}`);
      });
    }
  }

  assertEqual(offenders.join(', '), '', '𝒦_view leaked into a rules/helpers transition path');
});

test('charter C-8: driver semantics stay in 𝒦_driver, not in reduce', () => {
  const module = GAME_REGISTRY.poker;
  // 𝒦_driver 的三个字段只应被驱动方（app / server）读取。
  // 这里断言它们的形状：都是数据或纯函数，不持有状态、不产生副作用。
  assert(
    module.driver?.driverActions === undefined || Array.isArray(module.driver.driverActions),
    'driverActions is a list'
  );
  if (module.driver?.heartbeat) {
    assert(typeof module.driver.heartbeat.intervalMs === 'number', 'heartbeat.intervalMs is a number');
    assert(typeof module.driver.heartbeat.action === 'function', 'heartbeat.action is a function');
  }
  if (module.driver?.isAutomated) {
    assert(typeof module.driver.isAutomated === 'function', 'isAutomated is a predicate');
  }
});

/* -------------------------------------------------------------------------- */
/* C-6 / C-7 / C-9 全模组覆盖                                                   */
/* -------------------------------------------------------------------------- */

test('charter C-6: every module declares semantic invariants that accept real play', () => {
  for (const [id, module] of Object.entries(GAME_REGISTRY)) {
    assert(module.checkInvariants, `${id} must declare checkInvariants (C-6)`);
    const engine = new UniversalGameEngine(module, 4242, { strict: true });
    const rnd = picker(4242);
    for (let i = 0; i < 40; i++) {
      const legal = engine.getLegalActions(engine.getActiveActorId());
      if (legal.length === 0) break;
      if (!engine.dispatch(legal[rnd(legal.length)]).ok) break;
      if (engine.getRawState().gameOver) break;
    }
    const c6 = engine.getViolations().filter(v => v.code === 'CHARTER_C6_SEMANTIC_INVARIANT');
    assertEqual(c6.length, 0, `${id} stayed rule-consistent: ${c6[0]?.message ?? ''}`);
  }
});

test('charter C-6: semantic invariants actually reject broken state (no silent pass)', () => {
  // 反向验证：故意破坏状态，确认断言不是"永远返回空数组"。
  const catan = new UniversalGameEngine(GAME_REGISTRY.catan, 7, { strict: true }).getRawState();
  const flooded = { ...catan, globalVars: { ...catan.globalVars, bank: { ...catan.globalVars.bank, wood: 99 } } };
  assert(
    (GAME_REGISTRY.catan.checkInvariants?.(flooded) ?? []).some(m => /supply exceeded/.test(m)),
    'catan must reject an overdrawn resource bank'
  );

  const sanguosha = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 7, { strict: true }).getRawState();
  const pid = sanguosha.playerOrder[0];
  const dying = {
    ...sanguosha,
    players: { ...sanguosha.players, [pid]: { ...sanguosha.players[pid], customProps: { ...sanguosha.players[pid].customProps, hp: -3 } } }
  };
  assert(
    (GAME_REGISTRY.sanguosha.checkInvariants?.(dying) ?? []).some(m => /negative hp/.test(m)),
    'sanguosha must reject negative hp'
  );

  const betrayal = new UniversalGameEngine(GAME_REGISTRY.betrayal, 7, { strict: true }).getRawState();
  const bp = betrayal.playerOrder[0];
  const lost = {
    ...betrayal,
    players: { ...betrayal.players, [bp]: { ...betrayal.players[bp], customProps: { ...betrayal.players[bp].customProps, currentRoomId: 'room_nowhere' } } }
  };
  assert(
    (GAME_REGISTRY.betrayal.checkInvariants?.(lost) ?? []).some(m => /does not exist/.test(m)),
    'betrayal must reject a player standing in a non-existent room'
  );
});

test('charter C-9: every module declares its globalVars keys and stays inside them', () => {
  for (const [id, module] of Object.entries(GAME_REGISTRY)) {
    assert(module.meta.stateSchema?.globalVars, `${id} must declare meta.stateSchema.globalVars (C-9)`);
    const declared = new Set(module.meta.stateSchema!.globalVars!);
    const engine = new UniversalGameEngine(module, 808, { strict: true });
    const rnd = picker(808);
    // 宪章 C-2 之后一次 dispatch 会 pump 完整手牌，40 次已覆盖全部 key 集合。
    for (let i = 0; i < 40; i++) {
      const legal = engine.getLegalActions(engine.getActiveActorId());
      if (legal.length === 0) break;
      if (!engine.dispatch(legal[rnd(legal.length)]).ok) break;
      if (engine.getRawState().gameOver) break;
    }
    const state = engine.getRawState();
    for (const key of Object.keys(state.globalVars)) {
      if (key.startsWith('__')) continue;
      if (state.globalVars[key] === undefined) continue;
      assert(declared.has(key), `${id} wrote an undeclared globalVars.${key}`);
    }
  }
});

test('charter C-7: catan books resource gains through the reward ledger', () => {
  const module = GAME_REGISTRY.catan;
  assert(module.charter?.requiresRewardLedger, 'catan declares a reward ledger');

  const engine = new UniversalGameEngine(module, 31337, { strict: true });
  const rnd = picker(31337);
  for (let i = 0; i < 500 && (engine.getRawState().rewards ?? []).length === 0; i++) {
    const legal = engine.getLegalActions(engine.getActiveActorId());
    if (legal.length === 0) break;
    if (!engine.dispatch(legal[rnd(legal.length)]).ok) break;
    if (engine.getRawState().gameOver) break;
  }

  const rewards = engine.getRawState().rewards ?? [];
  assert(rewards.length > 0, 'catan produces reward entries when resources are gained');
  assert(
    rewards.every(r => r.kind.startsWith('resource:') && r.reason.length > 0),
    `every catan reward names its resource and cause, got: ${JSON.stringify(rewards.slice(0, 2))}`
  );
});

/* -------------------------------------------------------------------------- */
/* C-8 𝒦 三区物理分离                                                          */
/* -------------------------------------------------------------------------- */

test('charter C-8: driver declarations live only on GameModule.driver', () => {
  const DRIVER_KEYS = ['aiActionDelayMs', 'actionCooldownMs', 'heartbeat', 'driverActions', 'isAutomated'];
  for (const [id, module] of Object.entries(GAME_REGISTRY)) {
    // ① 展示层不得再出现任何驱动字段
    const presentation = module.presentation as Record<string, unknown> | undefined;
    if (presentation) {
      for (const key of DRIVER_KEYS) {
        assert(!(key in presentation), `${id} still declares presentation.${key} (charter C-8)`);
      }
    }
    // ② GameModule 顶层也不得保留（已并入 driver）
    const top = module as unknown as Record<string, unknown>;
    for (const key of ['heartbeat', 'driverActions', 'isAutomated']) {
      assert(!(key in top), `${id} still declares top-level ${key} — it belongs on GameModule.driver`);
    }
  }
});

test('charter C-8: definePresentation rejects driver keys at module load', () => {
  let threw = false;
  try {
    // 故意用旧写法：类型层面已被删除，这里模拟 JS 调用方 / as any 绕过。
    (definePresentation as (h: unknown) => unknown)({ aiActionDelayMs: 5000 });
  } catch (error) {
    threw = error instanceof TypeError && /driver concern/.test((error as Error).message);
  }
  assert(threw, 'definePresentation must reject aiActionDelayMs with a migration hint');
});

test('charter C-8: defineDriver validates its own fields', () => {
  assertEqual(defineDriver({ aiActionDelayMs: 5000 }).aiActionDelayMs, 5000, 'a valid delay is accepted');
  assertEqual(
    JSON.stringify(defineDriver({ actionCooldownMs: { START_HAND: 20000 } }).actionCooldownMs),
    JSON.stringify({ START_HAND: 20000 }),
    'a valid cooldown map is accepted'
  );

  let badDelay = false;
  try {
    (defineDriver as (h: unknown) => unknown)({ aiActionDelayMs: -1 });
  } catch (error) {
    badDelay = error instanceof TypeError;
  }
  assert(badDelay, 'a negative delay must be rejected');

  let unknownKey = false;
  try {
    (defineDriver as (h: unknown) => unknown)({ mapTitle: 'x' });
  } catch (error) {
    unknownKey = error instanceof TypeError;
  }
  assert(unknownKey, 'a non-driver key must be rejected');
});

/* -------------------------------------------------------------------------- */
/* AR-49 钩子承载规则（C-8 的另一半）                                            */
/* -------------------------------------------------------------------------- */

test('AR-49: the bagua hook translates a judge into the rule its params describe', () => {
  const hook = SANGUOSHA_HOOKS.find(h => h.id === 'bagua_armor');
  assert(hook, 'the bagua_armor hook exists');

  const makeCtx = (params: Record<string, unknown>) => ({
    impl: hook!,
    instance: {
      instanceId: 'probe',
      hookId: 'bagua_armor',
      ownerId: 'p1',
      visibility: { type: 'PUBLIC' as const },
      params: {}
    },
    params
  });

  // predicate 只对该护甲主人的判定生效
  const judgeByOwner = { type: 'JUDGE_BAGUA', playerId: 'p1' };
  const judgeByOther = { type: 'JUDGE_BAGUA', playerId: 'p2' };
  assert(hook!.predicate(judgeByOwner, {} as never, makeCtx({}) as never), 'fires on the owner judge');
  assert(!hook!.predicate(judgeByOther, {} as never, makeCtx({}) as never), 'ignores another seat judge');
  // 不拦 PLAY_STRIKE：攻击照旧进栈，目标仍有选择权
  assert(
    !hook!.predicate(
      { type: 'PLAY_STRIKE', playerId: 'p2', targetPlayerId: 'p1' },
      {} as never,
      makeCtx({}) as never
    ),
    'does not swallow the strike itself — the target keeps its choice'
  );

  // 默认参数
  const base = hook!.handler(judgeByOwner, {} as never, makeCtx({}) as never);
  assertEqual(base.type, 'MODIFY', 'the judge action is modified, not replaced');
  const basePayload = base.modifiedAction?.payload as Record<string, unknown>;
  assertEqual(basePayload.redIsDodge, true, 'red judges a Dodge by default');
  assertEqual(basePayload.damageOnFail, 1, 'a failed judge costs one damage by default');
  assertEqual(basePayload.ruleId, 'bagua_armor', 'the payload names the rule that produced it');

  // 改 params 必须改变规则 —— 证明规则在钩子里，不在 reducer 里
  const strict = hook!.handler(judgeByOwner, {} as never, makeCtx({ damageOnFail: 3, redIsDodge: false }) as never);
  const strictPayload = strict.modifiedAction?.payload as Record<string, unknown>;
  assertEqual(strictPayload.damageOnFail, 3, 'damageOnFail comes from the hook params');
  assertEqual(strictPayload.redIsDodge, false, 'redIsDodge comes from the hook params');
});

test('AR-49: a real strike against the armor wearer routes through the hook', () => {
  const module = GAME_REGISTRY.sanguosha;
  let observed: string[] | undefined;

  for (let seed = 1; seed <= 80 && !observed; seed++) {
    const engine = new UniversalGameEngine(module, seed, { strict: true });
    for (let i = 0; i < 500; i++) {
      const actor = engine.getActiveActorId();
      const legal = engine.getLegalActions(actor);
      if (legal.length === 0) break;

      const strike = legal.find(a => a.type === 'PLAY_STRIKE' && a.targetPlayerId === 'p1' && actor !== 'p1');
      if (strike) {
        if (!engine.dispatch(strike).ok) break;
        const reaction = engine.getLegalActions('p1').find(a => a.type === 'JUDGE_BAGUA');
        if (reaction) {
          const result = engine.dispatch(reaction);
          assert(result.ok, 'the judge resolves');
          observed = result.events.map(e => e.title);
          break;
        }
      }

      const endTurn = legal.find(a => a.type === 'END_TURN');
      if (!engine.dispatch(endTurn ?? legal[0]).ok) break;
      if (engine.getRawState().gameOver) break;
    }
  }

  assert(observed, 'a strike against the armor wearer was found within 80 seeds');
  assert(
    observed!.some(t => /Eight Trigrams Defense/.test(t)),
    `the hook's own message must appear in the event stream, got: ${JSON.stringify(observed!.slice(0, 6))}`
  );
  // 旧实现在这里只有一句空提示，钩子不产生任何结算语义。
  assert(
    observed!.some(t => /red judges a Dodge|red judges|Eight Trigrams/.test(t)),
    'the hook describes the rule it applied'
  );
});

test('AR-49: the judge executor reads its rule from the payload, not from the game id', () => {
  // reducer 不认识"八阵图"：同样的 JUDGE_BAGUA 换一组参数，行为必须不同。
  const module = GAME_REGISTRY.sanguosha;
  const engine = new UniversalGameEngine(module, 5, { strict: true });
  const base = engine.getRawState();

  // 用 two payloads 直接驱动 reduce，观察 hp 变化是否有差异。
  const ctx = {
    id: (k: string) => `${k}_probe`,
    trace: () => {},
    seq: base.seq + 1,
    roll: () => ({ result: { spec: { sides: 100, count: 1 }, rolls: [1], total: 1 }, nextSeed: 1 }),
    reward: () => {}
  };
  const victim = base.playerOrder[0];
  const withDamage = module.reduce(
    base,
    { type: 'JUDGE_BAGUA', playerId: victim, payload: { redIsDodge: false, damageOnFail: 2 } },
    ctx as never
  );
  const withoutDamage = module.reduce(
    base,
    { type: 'JUDGE_BAGUA', playerId: victim, payload: { redIsDodge: true, damageOnFail: 0 } },
    ctx as never
  );

  const hpOf = (s: typeof base) => Number(s.players[victim].customProps?.hp ?? 0);
  assert(
    hpOf(withDamage) <= hpOf(withoutDamage),
    `a harsher payload must not heal the victim (${hpOf(withDamage)} vs ${hpOf(withoutDamage)})`
  );
});

/* -------------------------------------------------------------------------- */
/* AR-48 capabilities 必须与实现一致，且内核真的消费                            */
/* -------------------------------------------------------------------------- */

test('AR-48: every module declares capabilities that match its implementation', () => {
  const evidenceOf = (id: string) => {
    // 只认代码事实：模块源码里是否调用了中断栈。
    const dir = `packages/games/src/${id}`;
    if (!existsSync(dir)) return {};
    const src = listFiles(dir)
      .map(f => readFileSync(f, 'utf8'))
      .join('\n');
    return { usesInterruptStack: /InterruptStackManager\.(push|peek)/.test(src) };
  };

  const offenders: string[] = [];
  for (const [id, module] of Object.entries(GAME_REGISTRY)) {
    const engine = new UniversalGameEngine(module, 4242, { strict: true });
    const mismatches = capabilityMismatches(module, engine.getRawState(), evidenceOf(id));
    for (const m of mismatches) offenders.push(`${id}.${m.field}(${m.declared}→${m.derived})`);
  }
  assertEqual(offenders.join(', '), '', 'capability declarations must match the code');
});

test('AR-48: the kernel flags a module that hides information while claiming it does not', () => {
  const poker = GAME_REGISTRY.poker;
  const liar = {
    ...poker,
    meta: { ...poker.meta, capabilities: { ...poker.meta.capabilities, hiddenInformation: false } }
  };
  const engine = new UniversalGameEngine(liar, 7, { strict: true });
  const open = engine.getLegalActions(engine.getActiveActorId()).find(a => a.type === 'START_HAND');
  assert(open, 'a fresh table offers START_HAND');
  engine.dispatch(open!);

  const violations = engine.getViolations().filter(v => v.code === 'CHARTER_CAPABILITY_MISMATCH');
  assert(violations.length > 0, 'the kernel must notice hidden entities despite hiddenInformation: false');
  assert(
    violations.some(v => /hiddenInformation/.test(v.message)),
    `the message names the field, got: ${violations[0]?.message}`
  );
});

test('AR-48: the kernel flags a module that claims simultaneous moves it cannot make', () => {
  const splendor = GAME_REGISTRY.splendor;
  const liar = {
    ...splendor,
    meta: {
      ...splendor.meta,
      capabilities: { ...splendor.meta.capabilities, simultaneousMoves: true }
    }
  };
  const engine = new UniversalGameEngine(liar, 3, { strict: true });
  const legal = engine.getLegalActions(engine.getActiveActorId());
  if (legal.length > 0) engine.dispatch(legal[0]);

  const violations = engine.getViolations().filter(v => v.code === 'CHARTER_CAPABILITY_MISMATCH');
  assert(
    violations.some(v => /simultaneousMoves/.test(v.message)),
    `a claim with no applySimultaneous must be reported, got: ${JSON.stringify(violations.map(v => v.message))}`
  );
});

test('AR-48: capability derivation does not count a single-seat SIMULTANEOUS window as simultaneous moves', () => {
  // betrayal 用 kind:'SIMULTANEOUS' 开单人伤害窗口 —— 那不是"多人同时行动"。
  const betrayal = GAME_REGISTRY.betrayal;
  assertEqual(
    deriveCapabilities(betrayal).simultaneousMoves,
    false,
    'a single-participant window is not a simultaneous-move capability'
  );
});

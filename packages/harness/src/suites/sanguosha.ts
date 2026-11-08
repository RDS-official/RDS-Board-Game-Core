import { describeActionView } from '@rds/app/actionText';
import { buildActionsView, resolveBoundAction } from '@rds/app/session';
import { UniversalGameEngine } from '@rds/kernel/engine';
import { Action, GameState } from '@rds/kernel/types';
import { GAME_REGISTRY } from '@rds/games/registry';
import { MILITARY_DECK, STANDARD_DECK } from '@rds/games/sanguosha/cards';
import { SANGUOSHA_HEROES } from '@rds/games/sanguosha/heroes';
import { SANGUOSHA_ACTION_TYPES } from '@rds/games/sanguosha/legal';
import { checkSanguoshaWin } from '@rds/games/sanguosha/outcome';
import { SANGUOSHA_SCORE, sanguoshaScoreDeltas } from '@rds/games/sanguosha/scoring';
import { isAiSeat } from '@rds/games/sanguosha/ai';
import { sanguoshaCardFacts, sanguoshaCardStyle, sanguoshaDescribeMoment, sanguoshaRoleLabel } from '@rds/games/sanguosha/presentation';
import { setupSanguosha } from '@rds/games/sanguosha/setup';
import { assert, assertEqual, test } from '../testKit';

function moveCardToZone(state: GameState, cardId: string, zoneId: string, ownerId?: string): void {
  const from = state.entities[cardId]?.zoneId;
  if (!from) return;
  state.zones[from].orderedEntities = state.zones[from].orderedEntities.filter(id => id !== cardId);
  state.entities[cardId].zoneId = zoneId;
  if (ownerId) {
    state.entities[cardId].ownerId = ownerId;
    state.entities[cardId].visibility = { type: 'OWNER_ONLY', ownerId };
  } else {
    state.entities[cardId].visibility = zoneId === 'zone_deck' ? { type: 'HIDDEN' } : { type: 'PUBLIC' };
  }
  state.zones[zoneId].orderedEntities.push(cardId);
}

function passAllResponseWindows(engine: UniversalGameEngine): void {
  for (let guard = 0; guard < 24; guard += 1) {
    const state = engine.getRawState();
    const frame = state.interruptStack[state.interruptStack.length - 1];
    if (!frame?.responseWindow || frame.status !== 'WAITING_INPUT') return;
    const eligible = frame.responseWindow.eligibleActors ?? frame.responseWindow.eligiblePlayers;
    let acted = false;
    for (const pid of eligible) {
      const pass = engine.getLegalActions(pid).find(action => action.type === 'PASS');
      if (pass) {
        const result = engine.dispatch(pass);
        if (result.ok) acted = true;
      }
    }
    if (!acted) return;
  }
}

function actionForCard(state: GameState, playerId: string, code: string): Action | undefined {
  return GAME_REGISTRY.sanguosha
    .legalActions(state, playerId)
    .find(action => action.entityId && state.entities[action.entityId]?.components.custom?.code === code);
}

function moveDeckCardTo(state: GameState, code: string, zoneId: string, ownerId?: string): string | null {
  const cardId = Object.keys(state.entities).find(
    id => state.entities[id].components.custom?.code === code && state.entities[id].zoneId === 'zone_deck'
  );
  if (!cardId) return null;
  const deck = state.zones.zone_deck.orderedEntities;
  deck.splice(deck.indexOf(cardId), 1);
  const card = state.entities[cardId];
  card.zoneId = zoneId;
  if (ownerId) {
    card.ownerId = ownerId;
    card.visibility = { type: 'OWNER_ONLY', ownerId };
  }
  state.zones[zoneId].orderedEntities.push(cardId);
  return cardId;
}



test('fixture sanguosha: 108-card standard deck, 52-card military deck and 17 heroes', () => {
  assertEqual(STANDARD_DECK.length, 108, 'standard deck has 108 cards');
  assertEqual(MILITARY_DECK.length, 52, 'military expansion adds 52 cards');
  assertEqual(new Set(SANGUOSHA_HEROES.map(hero => hero.id)).size, SANGUOSHA_HEROES.length, 'hero ids are unique');
  assertEqual(SANGUOSHA_HEROES.length, 17, 'the fixture ships 17 fully implemented heroes');
  const state = setupSanguosha(7);
  assertEqual(Object.keys(state.entities).length, 108, 'setup puts exactly one standard deck in the state');
  assertEqual(new Set(Object.keys(state.entities)).size, 108, 'card entity ids are unique');
  assertEqual(state.zones.zone_equip_p1.orderedEntities.length, 1, 'the classic seat starts with one armour');
  assertEqual(state.entities[state.zones.zone_equip_p1.orderedEntities[0]].components.custom?.code, 'bagua', 'the armour is Eight Trigrams');
  assertEqual(state.players.p1.customProps.maxHp, 5, 'the lord gets the +1 maximum HP');
  for (const actionType of SANGUOSHA_ACTION_TYPES) {
    assert(!!GAME_REGISTRY.sanguosha.actionSchemas?.[actionType], `${actionType} has a declared action schema`);
  }
  const military = setupSanguosha(7, { variant: 'military' });
  assertEqual(Object.keys(military.entities).length, 160, 'military scenario uses the combined 160-card pile');
  const militaryCodes = new Set(Object.values(military.entities).map(entity => entity.components.custom?.code));
  for (const code of ['huosha', 'leisha', 'jiu', 'tiesuo', 'huogong', 'bingliang', 'tengjia', 'guding', 'zhuque', 'baiyin']) {
    assert(militaryCodes.has(code), `military deck contains ${code}`);
  }
});

test('fixture sanguosha: 洛神每次只亮一张判定牌，每张都进对局日志', () => {
  // 宪章 C-2：洛神不再在一次 reduce 里循环。种子 2 的 5 人身份局里 p2 是甄姬，
  // 开局即带洛神。p1 结束回合后，引擎的 follow-up 泵逐步派发 LUOSHEN_STEP，
  // 每张判定牌各成一条日志，且全部落在延时锦囊判定之前。
  const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 2, { scenario: 'identity_5' });
  assert(
    (engine.getRawState().players.p2.customProps.skills as string[]).includes('luoshen'),
    'p2 starts with luoshen under this seed'
  );

  const end = engine.getLegalActions('p1').find(action => action.type === 'END_TURN');
  assert(!!end, 'the active player can end the play phase');
  const result = engine.dispatch(end!);
  assert(result.ok, `end turn failed: ${result.error}`);

  const after = engine.getRawState();
  const indexes = after.actionLog
    .map((action, index) => (action.type === 'LUOSHEN_STEP' ? index : -1))
    .filter(index => index >= 0);
  assert(indexes.length >= 1, 'luoshen revealed at least one card as its own action');
  const contiguous = indexes.every((index, position) => position === 0 || index === indexes[position - 1] + 1);
  assert(contiguous, 'the luoshen steps run back to back, one card each');
  assertEqual(after.globalVars.luoshenLeft, undefined, 'the chain settled before the judge phase');
  assert(indexes.length <= 12, 'luoshen never reveals more than 12 cards in one preparation phase');
  const judgeIndex = after.actionLog.findIndex(action => action.type === 'RESOLVE_JUDGE');
  assert(indexes[indexes.length - 1] < judgeIndex, 'every luoshen step precedes the delayed-trick judgement');
  assert(engine.verifyReplay().ok, 'the stepped chain replays exactly');
});

test('fixture sanguosha: six-phase turn advances through automatic follow-ups', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 5);
  const end = engine.getLegalActions('p1').find(action => action.type === 'END_TURN');
  assert(!!end, 'the active player can end the play phase');
  const result = engine.dispatch(end!);
  assert(result.ok, `end turn failed: ${result.error}`);
  const state = engine.getRawState();
  assertEqual(state.activePlayerId, 'p2', 'turn passes to the next living player');
  assertEqual(state.phase, 'PLAY', 'the next player reaches their play phase');
  assertEqual(state.zones.zone_hand_p2.orderedEntities.length, 6, 'the next player drew two cards');
  const types = state.actionLog.map(action => action.type);
  for (const step of ['FINISH_DISCARD', 'FINISH_TURN', 'START_TURN', 'RESOLVE_JUDGE', 'DRAW_PHASE']) {
    assert(types.includes(step), `automatic phase step ${step} was recorded`);
  }
  assert(engine.verifyReplay().ok, 'the automatic phase chain replays exactly');
});

test('fixture sanguosha: Strike can be dodged, and Bagua judges a real card', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 5);
  const strike = engine.getLegalActions('p1').find(action => action.type === 'PLAY_STRIKE' && action.targetPlayerId === 'p2');
  assert(!!strike, 'p1 can strike p2');
  assert(engine.dispatch(strike!).ok, 'strike accepted');
  const dodge = engine.getLegalActions('p2').find(action => action.type === 'PLAY_DODGE');
  assert(!!dodge, 'p2 has a Dodge');
  const before = engine.getRawState().players.p2.customProps.hp;
  assert(engine.dispatch(dodge!).ok, 'Dodge accepted');
  assertEqual(engine.getRawState().players.p2.customProps.hp, before, 'Dodge prevents the damage');
  assertEqual(engine.getRawState().interruptStack.length, 0, 'the strike frame is popped');

  const baguaEngine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 1);
  const end = baguaEngine.getLegalActions('p1').find(action => action.type === 'END_TURN');
  assert(!!end, 'p1 can pass the turn');
  assert(baguaEngine.dispatch(end!).ok, 'turn passed');
  const incoming = baguaEngine.getLegalActions('p2').find(action => action.type === 'PLAY_STRIKE' && action.targetPlayerId === 'p1');
  assert(!!incoming, 'p2 can strike the Bagua wearer');
  assert(baguaEngine.dispatch(incoming!).ok, 'incoming strike accepted');
  const judge = baguaEngine.getLegalActions('p1').find(action => action.type === 'JUDGE_BAGUA');
  assert(!!judge, 'the wearer can invoke Bagua');
  const judged = baguaEngine.dispatch(judge!);
  assert(judged.ok, `Bagua failed: ${judged.error}`);
  assert(
    judged.events.some(event => /Eight Trigrams Defense/.test(event.title)),
    'the equipment hook contributes its message'
  );
});

test('fixture sanguosha: damage enters dying, and Peach rescues', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 16);
  const raw = engine.getRawState();
  raw.players.p2.customProps.hp = 1;
  const strike = engine.getLegalActions('p1').find(action => action.type === 'PLAY_STRIKE' && action.targetPlayerId === 'p2');
  assert(!!strike, 'p1 can strike the wounded target');
  assert(engine.dispatch(strike!).ok, 'strike accepted');
  const pass = engine.getLegalActions('p2').find(action => action.type === 'PASS');
  assert(!!pass, 'target may decline to dodge');
  assert(engine.dispatch(pass!).ok, 'target passes');
  assertEqual(engine.getRawState().players.p2.customProps.hp, 0, 'damage reaches zero HP');
  assertEqual(engine.getRawState().players.p2.alive, true, 'zero HP is dying, not dead yet');
  assertEqual(engine.getRawState().interruptStack[0]?.type, 'DYING_RESCUE', 'dying opens a rescue window');
  const peach = engine.getLegalActions('p1').find(action => action.type === 'PLAY_PEACH');
  assert(!!peach, 'the rescuer has Peach');
  assert(engine.dispatch(peach!).ok, 'Peach accepted');
  assertEqual(engine.getRawState().players.p2.customProps.hp, 1, 'Peach restores one HP');
  assertEqual(engine.getRawState().players.p2.alive, true, 'rescued player stays alive');
});

test('fixture sanguosha: Duel alternates Strikes and eventually damages the exhausted side', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 7);
  const duel = actionForCard(engine.getRawState(), 'p1', 'juedou');
  assert(!!duel, 'p1 has Duel');
  assert(engine.dispatch(duel!).ok, 'Duel accepted');
  passAllResponseWindows(engine);
  const state = engine.getRawState();
  assertEqual(state.players.p2.customProps.hp, 3, 'the side that cannot answer takes one damage');
  assertEqual(state.interruptStack.length, 0, 'the Duel chain is closed');
  // Any Wuxie windows before the Duel are also fully consumed by the helper.
  assert(state.actionLog.filter(action => action.type === 'PASS').length >= 1, 'responses are recorded as actions');
});

test('fixture sanguosha: Fangtian Halberd chains one Strike into multiple targets', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 29);
  const state = engine.getRawState();
  const hand = state.zones.zone_hand_p1.orderedEntities;
  const strikeId = hand.find(id => state.entities[id].components.custom?.code === 'sha');
  const fangtianId = hand.find(id => state.entities[id].components.custom?.code === 'fangtian');
  assert(!!strikeId && !!fangtianId, 'seed has a Strike and Fangtian Halberd');
  for (const id of [...hand]) {
    if (id !== strikeId) moveCardToZone(state, id, 'zone_discard');
  }
  moveCardToZone(state, fangtianId!, 'zone_equip_p1', 'p1');
  const multi = engine
    .getLegalActions('p1')
    .find(action => action.type === 'PLAY_STRIKE' && Array.isArray(action.payload?.extraTargetIds));
  assert(!!multi, 'the last hand Strike offers a multi-target action');
  assert(engine.dispatch(multi!).ok, 'multi-target Strike accepted');
  passAllResponseWindows(engine);
  const after = engine.getRawState();
  const hp = (pid: string) => Number(after.players[pid].customProps.hp);
  assert(hp('p2') < 4 || hp('p3') < 4, 'at least one of the chained targets took damage');
  assertEqual(after.globalVars.strikeQueue, undefined, 'the multi-target queue drains');
});

test('fixture sanguosha: a collapsed Strike dispatches the target the player picked', () => {
  // 端到端复现「出杀被服务器拒绝」：一张【杀】在合法动作里是每个目标一条，UI 把
  // 它们塌缩成一个按钮。玩家在轮盘里选的目标必须能真的派发出去——联机版曾经只把
  // targets 贴在首个目标那条动作上，权威一律判非法。
  const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 29);
  const state = engine.getRawState();
  state.phase = 'PLAY';
  state.activePlayerId = 'p1';
  // 保证手里有【杀】，且攻击范围内不止一个目标（4 人环里 p1 的邻座就是两个）。
  moveDeckCardTo(state, 'sha', 'zone_hand_p1', 'p1');
  const strikes = engine.getLegalActions('p1').filter(action => action.type === 'PLAY_STRIKE');
  const byCard = new Map<string, Action[]>();
  for (const action of strikes) {
    const key = String(action.entityId ?? '');
    byCard.set(key, [...(byCard.get(key) ?? []), action]);
  }
  const multi = [...byCard.values()].find(group => group.length >= 2);
  assert(!!multi, 'a Strike with more than one legal target exists');

  const projection = engine.getProjectedStateFor('p1');
  const bound = buildActionsView(projection, strikes, (actorId, spec) =>
    engine.getSelectionCandidates(actorId, spec)
  );
  const collapsed = bound.find(entry => (entry.targetVariants?.size ?? 0) >= 2);
  assert(!!collapsed, 'the multi-target Strike is collapsed into one card');
  assertEqual(collapsed!.ui.selection?.candidates.length, collapsed!.targetVariants!.size, 'every legal target is offered');

  // 选一个「不是首个目标」的目标，否则测不出换回逻辑。
  const firstTarget = String(collapsed!.action?.targetPlayerId ?? '');
  const chosen = [...collapsed!.targetVariants!.keys()].find(id => id !== firstTarget);
  assert(!!chosen, 'a non-first target exists');

  const resolved = resolveBoundAction(collapsed!, undefined, [chosen!]);
  assert(!!resolved.action, 'the picked target resolves to a concrete action');
  assertEqual(resolved.action!.targetPlayerId, chosen, 'it is the action for the picked target');
  assert(engine.dispatch(resolved.action!).ok, 'the authority accepts the picked target');

  // 反向断言：旧联机版的形状（首个目标的动作 + 贴一个 targets）必须被判非法，
  // 否则这条回归用例保护不了那段逻辑。
  const buggy = { ...collapsed!.action!, targets: [chosen!] } as Action;
  const rejected = engine.dispatch(buggy);
  assert(!rejected.ok, 'the old "attach targets to the first action" shape is rejected');
});

test('fixture sanguosha: Rende gives a card and heals on the second gift', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 5);
  engine.getRawState().players.p1.customProps.hp = 4;
  const first = engine.getLegalActions('p1').find(action => action.type === 'USE_SKILL' && action.payload?.skill === 'rende');
  assert(!!first, 'Liu Bei can use Rende');
  assert(engine.dispatch(first!).ok, 'first Rende accepted');
  assertEqual(engine.getRawState().players.p1.customProps.hp, 4, 'one gift does not heal yet');
  const second = engine.getLegalActions('p1').find(action => action.type === 'USE_SKILL' && action.payload?.skill === 'rende');
  assert(!!second, 'Liu Bei can give a second card');
  assert(engine.dispatch(second!).ok, 'second Rende accepted');
  assertEqual(engine.getRawState().players.p1.customProps.hp, 5, 'the second gift heals one HP');
});

test('fixture sanguosha: Dismantle and Harvest choices are real player actions', () => {
  const dismantleEngine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 8);
  const dismantle = actionForCard(dismantleEngine.getRawState(), 'p1', 'guohe');
  assert(!!dismantle, 'p1 has Dismantle');
  assert(dismantleEngine.dispatch(dismantle!).ok, 'Dismantle accepted');
  passAllResponseWindows(dismantleEngine);
  const choiceDecision = dismantleEngine.getRawState().pendingDecisions.find(window => window.status === 'OPEN');
  assertEqual(choiceDecision?.payload?.kind, 'sgs_choice', 'the target-card choice is a decision window');
  const choice = dismantleEngine.getLegalActions('p1').find(action => action.type === 'RESOLVE_CHOICE');
  assert(!!choice, 'the choosing seat receives concrete choice actions');
  assert(dismantleEngine.dispatch(choice!).ok, 'choice resolved');
  assertEqual(dismantleEngine.getRawState().pendingDecisions.filter(window => window.status === 'OPEN').length, 0, 'decision closes');

  const harvestEngine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 21);
  const harvest = actionForCard(harvestEngine.getRawState(), 'p1', 'wugu');
  assert(!!harvest, 'p1 has Harvest');
  assert(harvestEngine.dispatch(harvest!).ok, 'Harvest accepted');
  passAllResponseWindows(harvestEngine);
  const seen: string[] = [];
  for (let guard = 0; guard < 6; guard += 1) {
    const beforeChoice = harvestEngine.getRawState();
    const choiceOwner = beforeChoice.globalVars.pendingChoice?.playerId;
    if (!choiceOwner) break;
    seen.push(choiceOwner);
    const pick = harvestEngine.getLegalActions(choiceOwner).find(action => action.type === 'RESOLVE_CHOICE');
    assert(!!pick, `${choiceOwner} receives a Harvest choice`);
    assert(harvestEngine.dispatch(pick!).ok, `${choiceOwner} pick accepted`);
  }
  assertEqual(seen.join(','), 'p1,p2,p3,p4', 'Harvest asks every living target in seat order');
  assertEqual(harvestEngine.getRawState().zones.zone_judge_public.orderedEntities.length, 0, 'unused revealed cards are discarded');

  const projectionEngine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 8);
  const projectionDismantle = actionForCard(projectionEngine.getRawState(), 'p1', 'guohe');
  assert(!!projectionDismantle, 'projection probe has Dismantle');
  assert(projectionEngine.dispatch(projectionDismantle!).ok, 'projection probe accepted');
  passAllResponseWindows(projectionEngine);
  const p2View = projectionEngine.getProjectedStateFor('p2');
  const redactedChoice = p2View.globalVars.pendingChoice as { options?: { zone?: string; cardId?: string }[] } | undefined;
  assert(!!redactedChoice, 'the choice is visible as a table event');
  assert(
    (redactedChoice!.options ?? []).every(option => option.zone !== 'HAND' || option.cardId === undefined),
    'the non-chooser cannot see hand-card entity ids'
  );
});

test('fixture sanguosha: a choice decision times out to its first option', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 8);
  const dismantle = actionForCard(engine.getRawState(), 'p1', 'guohe');
  assert(!!dismantle, 'timeout probe has Dismantle');
  assert(engine.dispatch(dismantle!).ok, 'timeout probe accepted');
  passAllResponseWindows(engine);
  const decision = engine.getRawState().pendingDecisions.find(window => window.status === 'OPEN');
  assert(!!decision?.deadline, 'the choice decision has a kernel deadline');
  const ticks = decision!.deadline! - engine.getRawState().clock + 1;
  assert(engine.dispatch({ type: '__TICK__', playerId: 'SYSTEM', payload: { ticks } }).ok, 'clock advances');
  const after = engine.getRawState();
  assertEqual(after.pendingDecisions.filter(window => window.status === 'OPEN').length, 0, 'timeout closes the decision');
  assertEqual(after.globalVars.pendingChoice, undefined, 'the timeout fallback consumes the choice');
});

test('fixture sanguosha: Fire Attack reveals a card and asks the source whether to burn', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 1, { scenario: 'military' });
  const cardId = moveDeckCardTo(engine.getRawState(), 'huogong', 'zone_hand_p1', 'p1');
  assert(!!cardId, 'the military seed has Fire Attack');
  const fire = engine.getLegalActions('p1').find(action => action.entityId === cardId && action.targetPlayerId === 'p2');
  assert(!!fire, 'p1 can Fire Attack p2');
  assert(engine.dispatch(fire!).ok, 'Fire Attack accepted');
  passAllResponseWindows(engine);
  const decision = engine.getRawState().pendingDecisions.find(window => window.status === 'OPEN');
  assertEqual(decision?.payload?.kind, 'sgs_choice', 'the source gets a damage-or-pass decision');
  const choices = engine.getLegalActions('p1').filter(action => action.type === 'RESOLVE_CHOICE');
  assert(choices.length >= 1, 'the source sees a pass option');
  assert(engine.dispatch(choices.find(action => action.payload?.optionId === 'pass')!).ok, 'the source can decline');
  assertEqual(engine.getRawState().pendingDecisions.filter(window => window.status === 'OPEN').length, 0, 'the Fire Attack decision closes');
});

test('fixture sanguosha: delayed trick opens a Wuxie window before its judgement', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 4);
  const state = engine.getRawState();
  assert(!!moveDeckCardTo(state, 'lebu', 'zone_judge_p2'), 'seed has an Indulgence');
  assert(!!moveDeckCardTo(state, 'wuxie', 'zone_hand_p3', 'p3'), 'seed has a Nullification');
  assert(engine.dispatch(engine.getLegalActions('p1').find(action => action.type === 'END_TURN')!).ok, 'turn passed');
  const frame = engine.getRawState().interruptStack[0];
  assertEqual(frame?.type, 'JUDGE_TRICK_RESOLUTION', 'the delayed trick asks for Nullification');
  assert(engine.getLegalActions('p3').some(action => action.type === 'PLAY_WUXIE'), 'p3 can cancel it');
  passAllResponseWindows(engine);
  assertEqual(engine.getRawState().players.p2.customProps.skipPlay, true, 'the delayed trick resolves after responses');
});

test('fixture sanguosha: identity victory conditions are role-based', () => {
  const state = setupSanguosha(3);
  const dead = (next: GameState, pid: string): GameState => ({
    ...next,
    players: { ...next.players, [pid]: { ...next.players[pid], alive: false } }
  });
  let probe = state;
  probe = dead(probe, 'p3');
  probe = dead(probe, 'p4');
  const loyal = checkSanguoshaWin(probe);
  assert(loyal.gameOver, 'lord side wins once rebel and spy are dead');
  assert(Array.isArray(loyal.winner) && loyal.winner.includes('p1') && loyal.winner.includes('p2'), 'lord and loyalist share the win');

  probe = state;
  probe = dead(probe, 'p1');
  const rebel = checkSanguoshaWin(probe);
  assert(rebel.gameOver, 'lord death ends the game');
  assert(Array.isArray(rebel.winner) && rebel.winner.includes('p3'), 'rebels win when the lord dies');

  probe = dead(dead(dead(state, 'p1'), 'p2'), 'p3');
  const spy = checkSanguoshaWin(probe);
  assert(spy.gameOver, 'sole survivor wins');
  assertEqual(spy.winner, 'p4', 'the spy wins as the last survivor');
});

test('fixture sanguosha: 5/8-seat identity, 4-seat team and arbitrary kill-next tables', () => {
  const five = setupSanguosha(11, { seats: 5, mode: 'identity', variant: 'warlords' });
  assertEqual(five.playerOrder.length, 5, '5-seat identity table deals five players');
  assertEqual(five.players.p1.role, 'LORD', 'the lord sits in seat one');
  assertEqual(five.players.p5.role, 'SPY', 'the spy is the fifth seat');
  assertEqual(five.globalVars.playerCount, 5, 'player count is persisted for presentation and scoring');

  const eight = setupSanguosha(12, { seats: 8, mode: 'identity', variant: 'warlords' });
  assertEqual(eight.playerOrder.length, 8, '8-seat identity table deals eight players');
  assertEqual(
    eight.playerOrder.filter(pid => eight.players[pid].role === 'REBEL').length,
    4,
    'an 8-seat identity table has four rebels'
  );
  assertEqual(
    eight.playerOrder.filter(pid => eight.players[pid].role === 'LOYALIST').length,
    2,
    'an 8-seat identity table has two loyalists'
  );

  const team = setupSanguosha(13, { seats: 4, mode: 'team', variant: 'warlords' });
  assertEqual(team.players.p1.role, 'TEAM_A', 'team mode alternates the two camps');
  assertEqual(team.players.p2.role, 'TEAM_B', 'team mode alternates the two camps');
  const teamDead = {
    ...team,
    players: {
      ...team.players,
      p1: { ...team.players.p1, alive: false },
      p3: { ...team.players.p3, alive: false }
    }
  };
  const teamWin = checkSanguoshaWin(teamDead);
  assert(teamWin.gameOver, 'eliminating one camp ends team mode');
  assert(Array.isArray(teamWin.winner) && teamWin.winner.includes('p2'), 'the surviving camp shares the win');
  const teamDeadMate = {
    ...team,
    players: {
      ...team.players,
      p1: { ...team.players.p1, alive: false },
      p3: { ...team.players.p3, alive: false },
      p4: { ...team.players.p4, alive: false }
    }
  };
  const teamMateWin = checkSanguoshaWin(teamDeadMate);
  assert(
    Array.isArray(teamMateWin.winner) && teamMateWin.winner.includes('p4'),
    'a dead teammate still shares the camp win and its points'
  );

  const defaultSmall = setupSanguosha(14, { seats: 2 });
  assertEqual(defaultSmall.globalVars.mode, 'kill_next', 'a 2-seat room without an explicit variant falls back to kill-next');
  const kill = setupSanguosha(14, { seats: 6, mode: 'kill_next', variant: 'warlords' });
  assertEqual(kill.playerOrder.length, 6, 'kill-next supports an arbitrary 2–8 seat table');
  assertEqual(kill.players.p3.role, 'KILL_NEXT', 'all seats share the village-rule role token');
  const killProbe = { ...kill, players: { ...kill.players, p2: { ...kill.players.p2, alive: false } } };
  const killWin = checkSanguoshaWin(killProbe, { victimId: 'p2', killerId: 'p1', nextOfKiller: 'p2' });
  assertEqual(killWin.winner, 'p1', 'killing your next living seat wins immediately');
});

test('fixture sanguosha: scoring follows the table rules', () => {
  const identity = setupSanguosha(21);
  const lordWin = sanguoshaScoreDeltas(identity, ['p1', 'p2']);
  assertEqual(lordWin.p1, SANGUOSHA_SCORE.standardWin, 'lord side winner gets 500');
  assertEqual(lordWin.p3, SANGUOSHA_SCORE.standardLoss, 'identity losers lose 500');

  const spyWin = sanguoshaScoreDeltas(identity, 'p4');
  assertEqual(spyWin.p4, SANGUOSHA_SCORE.spyWin, 'a sole spy winner gets the doubled 1000');
  assertEqual(spyWin.p1, SANGUOSHA_SCORE.standardLoss, 'the lord still loses 500 when the spy wins');

  const team = setupSanguosha(22, { mode: 'team', seats: 4 });
  const teamScore = sanguoshaScoreDeltas(team, ['p1', 'p3']);
  assertEqual(teamScore.p1, SANGUOSHA_SCORE.teamWin, 'team winners get 500 each');
  assertEqual(teamScore.p2, SANGUOSHA_SCORE.teamLoss, 'team losers lose 500 each');

  const kill = setupSanguosha(23, { mode: 'kill_next', seats: 3 });
  const killScore = sanguoshaScoreDeltas(kill, 'p2');
  assertEqual(killScore.p2, SANGUOSHA_SCORE.killNextWin, 'kill-next winner gets 250');
  assertEqual(killScore.p1, SANGUOSHA_SCORE.killNextLoss, 'kill-next losers lose 250');
});

test('fixture sanguosha: physical duplicate cards get distinct action labels without poker sniffing', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 41);
  const state = engine.getProjectedStateFor('p1');
  const actions = engine.getLegalActions('p1');
  const cardActions = actions.filter(action => action.type === 'PLAY_STRIKE' || action.type === 'EQUIP_CARD');
  const labels = cardActions
    .map(action => describeActionView(state, action)?.label ?? '')
    .filter(label => label.includes('【'));
  assert(labels.length >= 2, 'there are at least two physical card actions');
  assertEqual(new Set(labels).size, labels.length, 'no two card buttons share a printed label');
});

test('fixture sanguosha: the AI plays cards instead of discarding every turn', () => {
  // 宪章 C-5 改动的回归：AI 只看投影之后，决策质量不能退化成"每回合只弃牌"。
  // 多 seed 实跑，统计出牌与弃牌的比例。
  let plays = 0;
  let discards = 0;
  for (const seed of [3, 11, 29, 41, 73]) {
    const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, seed, { scenario: 'ai_standard_4' });
    for (let step = 0; step < 400 && !engine.getRawState().gameOver; step += 1) {
      const actor = engine.getActiveActorId();
      const legal = engine.getLegalActions(actor);
      if (legal.length === 0) break;
      const action = legal[0];
      if (action.type === 'PLAY_CARD' || action.type === 'PLAY_STRIKE' || action.type === 'EQUIP_CARD') plays += 1;
      if (action.type === 'DISCARD_CARD') discards += 1;
      if (!engine.dispatch(action).ok) break;
    }
  }
  assert(plays > 0, 'the AI plays at least one card across five seeds');
  assert(plays > discards, `the AI plays more cards than it discards (played ${plays}, discarded ${discards})`);
});

test('fixture sanguosha: AI seats produce one concrete action and are marked for the driver', () => {
  const state = setupSanguosha(31, { seats: 4, humans: 1, aiSeats: 3 });
  assert(isAiSeat(state, 'p2'), 'p2 is an AI seat');
  assert(!isAiSeat(state, 'p1'), 'the human seat is not automated');
  state.activePlayerId = 'p2';
  state.phase = 'PLAY';
  const legal = GAME_REGISTRY.sanguosha.legalActions(state, 'p2');
  assertEqual(legal.length, 1, 'an AI seat receives exactly one chosen action');
  assertEqual(legal[0].playerId, 'p2', 'the chosen action belongs to the AI seat');
  const scenarioEngine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 32, { scenario: 'ai_standard_4' });
  assertEqual(scenarioEngine.getRawState().playerOrder.length, 4, 'single-player AI scenario seats four');
  assert(isAiSeat(scenarioEngine.getRawState(), 'p2'), 'the AI scenario marks fillers as automated');
});

test('fixture sanguosha: discard stops exactly at the hand limit', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 51);
  const state = engine.getRawState();
  state.phase = 'DISCARD';
  state.activePlayerId = 'p1';
  const startHand = state.zones.zone_hand_p1.orderedEntities.length;
  const limit = startHand - 1;
  state.players.p1.customProps.hp = limit;
  state.players.p1.score = limit;
  assert(startHand > limit, 'the probe starts one card over the limit');
  const discard = engine.getLegalActions('p1').find(action => action.type === 'DISCARD_CARD');
  assert(!!discard, 'the over-limit seat can discard');
  assert(engine.dispatch(discard!).ok, 'discard accepted');
  assertEqual(engine.getRawState().zones.zone_hand_p1.orderedEntities.length, limit, 'the hand stops at the limit');
  assertEqual(engine.getRawState().phase, 'PLAY', 'the phase advances instead of allowing another discard');
});

test('fixture sanguosha: presentation vocabulary and final moment are declared by the game', () => {
  assertEqual(sanguoshaRoleLabel('LORD'), '主公', 'role labels live with the game');
  const facts = sanguoshaCardFacts({ category: 'EQUIP', subtype: 'WEAPON', suit: '♠', rank: 5, equipSlot: 'WEAPON', range: 3 });
  assert(facts.some(fact => fact.label === '攻击范围' && fact.value === '3'), 'weapon facts are printed for the inspector');
  const style = sanguoshaCardStyle({ category: 'TRICK', subtype: 'DUEL' });
  assertEqual(style.badge, '锦囊牌 · 决斗', 'the card band is localised by the game');
  const moment = sanguoshaDescribeMoment({
    globalVars: { finalWinner: ['p1', 'p2'], finalReason: '反贼与内奸均已肃清' },
    players: {
      p1: { name: '刘备', role: 'LORD', alive: true },
      p2: { name: '关羽', role: 'LOYALIST', alive: true },
      p3: { name: '曹操', role: 'REBEL', alive: false }
    }
  });
  assert(!!moment, 'a finished game produces a curtain');
  assert(moment!.title.includes('胜负已分'), 'the curtain has a game-authored title');
  assertEqual(moment!.hold, true, 'the final curtain stays until dismissed');
});

test('fixture sanguosha: every scenario starts and replays the same way', () => {
  for (const scenario of ['classic', 'warlords', 'military', 'military_warlords']) {
    const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 42, { scenario });
    assertEqual(engine.getRawState().playerOrder.length, 4, `${scenario}: four seats`);
    assert(engine.getLegalActions('p1').length > 0, `${scenario}: first seat has a legal action`);
    for (let step = 0; step < 30 && !engine.getRawState().gameOver; step += 1) {
      const actor = engine.getActiveActorId();
      const legal = engine.getLegalActions(actor);
      if (legal.length === 0) break;
      const result = engine.dispatch(legal[step % legal.length]);
      assert(result.ok, `${scenario}: legal action accepted (${result.error ?? ''})`);
    }
    assert(engine.verifyReplay().ok, `${scenario}: replay is bit-exact`);
  }
});

/* -------------------------------------------------------------------------- */
/* suite:presentation — moved verbatim from suite.ts */
/* -------------------------------------------------------------------------- */

import { OccupancyIndex } from '@rds/kernel/occupancy';
import { UniversalGameEngine } from '@rds/kernel/engine';
import { GAME_REGISTRY } from '@rds/games/registry';
import { UniversalSession } from '@rds/app/session';
import { buildEntityInspectNotice } from '@rds/app/inspect';
import { readdirSync, readFileSync } from 'node:fs';
import { itemSlotId } from '@rds/games/betrayal/helpers';
import { layoutRoom, hashString as layoutHash } from '@rds/web/render/procedural/roomLayout';
import { PROPS } from '@rds/web/render/procedural/props';
import { test, assert, assertEqual } from '../testKit';
import { counterModule } from '../suiteHelpers';

test('presenter: visual events are forwarded to the animation port', () => {
  const session = new UniversalSession(counterModule, 3);
  let batches = 0;
  const off = session.onVisualEvent(() => {
    batches += 1;
  });
  const action = session.getSnapshot().actions[0];
  assert(!!action, 'fixture exposes an action');
  assert(session.perform(action.id).ok, 'fixture action accepted');
  assert(batches > 0, 'visual event batch forwarded');
  off();
  session.dispose();
});

test('fixture betrayal: generic PLACE_ENTITY drops into the room slot', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 5, { scenario: 'exploration' });
  const place = engine.getLegalActions('p1').find(action => action.type === 'PLACE_ENTITY');
  assert(!!place, 'generic placement action exists');
  assert(engine.dispatch(place!).ok, 'generic placement accepted');
  const raw = engine.getRawState();
  assertEqual(raw.entities[place!.entityId!]?.components.spatial?.slotId, place!.targetSlotId, 'generic slot applied');
  assertEqual(OccupancyIndex.validate(raw).length, 0, 'generic placement preserves occupancy invariants');
});

test('fixture betrayal: dropped items occupy the room item slot', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 5, { scenario: 'exploration' });
  const drop = engine.getLegalActions('p1').find(action => action.type === 'DROP_ITEM');
  assert(!!drop, 'drop action exists');
  assert(engine.dispatch(drop!).ok, 'drop accepted');
  const raw = engine.getRawState();
  const entity = raw.entities[drop!.entityId!];
  assert(!!entity, 'dropped entity exists');
  assertEqual(entity.components.spatial?.slotId, itemSlotId(raw.players.p1.customProps.currentRoomId), 'item slot assigned');
  assertEqual(OccupancyIndex.validate(raw).length, 0, 'occupancy invariant holds after drop');
});

test('presenter: click-to-place arms a slot action and resolves on node pick', () => {
  const session = new UniversalSession(GAME_REGISTRY.betrayal, 5, 'exploration');
  const board = session.getSnapshot().board;
  const action = session.getSnapshot().actions.find(candidate => candidate.placementEntityId);
  assert(!!action, 'placement action exposes targeted mode');
  const roomId = String(board.players.p1.customProps.currentRoomId);
  assert(session.armPlacement(action!.id).ok, 'placement action arms');
  assertEqual(session.getSnapshot().board.actionLog.length, 0, 'arming does not mutate state');
  const picked = session.pickTarget({ kind: 'node', id: roomId });
  assert(picked.handled, `node pick failed: ${picked.message}`);
  const entity = Object.values(session.getSnapshot().board.entities).find(
    candidate => candidate.id === action!.placementEntityId
  );
  assertEqual(entity?.components?.spatial?.slotId, `slot_${roomId}_items`, 'click target slot applied');
});

test('presenter: drag-drop resolves a node to a legal PLACE_ENTITY action', () => {
  const session = new UniversalSession(GAME_REGISTRY.betrayal, 5, 'exploration');
  const board = session.getSnapshot().board;
  const roomId = String(board.players.p1.customProps.currentRoomId);
  const candidates = Object.values(board.entities).filter(
    entity => entity.type === 'CARD' && entity.components?.custom?.cardType !== 'EVENT'
  );
  let placedId: string | undefined;
  for (const item of candidates) {
    if (!item.id) continue;
    const targets = session.getPlacementTargets(item.id);
    if (targets.length === 0) continue;
    assert(targets.some(target => target.nodeId === roomId), 'drag target includes current room');
    const result = session.placeEntityAtNode(item.id, roomId);
    if (result.ok) {
      placedId = item.id;
      break;
    }
  }
  assert(!!placedId, 'one hand entity has a legal drag target');
  const after = session.getSnapshot().board;
  assertEqual(after.entities[placedId!]?.components?.spatial?.slotId, `slot_${roomId}_items`, 'drop resolved target slot');
});

test('presenter: discard drops into the actor current room, not an arbitrary slot', () => {
  const session = new UniversalSession(GAME_REGISTRY.betrayal, 5, 'exploration');
  const before = session.getSnapshot();
  const roomId = String(before.board.players.p1.customProps.currentRoomId);
  const itemId = before.board.zones.zone_hand_p1.orderedEntities.find(id => {
    const entity = before.board.entities[id];
    return !!entity && !entity.components?.custom?.companion;
  });
  assert(!!itemId, 'hand item exists');
  const drop = before.actions.find(action => action.label.includes('丢下'));
  assert(!!drop, 'drop action exposed');
  const result = session.perform(drop!.id);
  assert(result.ok, `drop dispatch failed: ${result.error}`);
  const after = session.getSnapshot().board;
  const dropped = after.entities[itemId!];
  assertEqual(dropped.zoneId, `zone_room_${roomId}`, 'discard stayed in the current room');
  assertEqual(dropped.components?.spatial?.slotId, `slot_${roomId}_items`, 'discard used the room slot');

  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 5, { scenario: 'exploration' });
  const raw = engine.getRawState();
  const handId = raw.zones.zone_hand_p1.orderedEntities[0];
  const otherSlot = Object.values(raw.mapGraph.slots ?? {}).find(slot => slot.nodeId !== roomId);
  assert(!!otherSlot, 'another room slot exists');
  const rejected = engine.dispatch({
    type: 'PLACE_ENTITY',
    playerId: 'p1',
    actorId: 'p1',
    entityId: handId,
    targetSlotId: otherSlot!.id
  });
  assert(!rejected.ok, 'discard into another room is rejected');
  assertEqual(engine.getRawState().entities[handId]?.zoneId, 'zone_hand_p1', 'rejected discard left the item in hand');
  session.dispose();
});

test('presenter: a single highlighted drop executes from the action dock', () => {
  const session = new UniversalSession(GAME_REGISTRY.betrayal, 5, 'exploration');
  const drop = session.getSnapshot().actions.find(action => action.label.startsWith('丢下'));
  assert(!!drop, 'drop action exposed');
  const before = session.getSnapshot().log.cursor;
  const result = session.perform(drop!.id);
  assert(result.ok, `drop dispatch failed: ${result.error}`);
  const after = session.getSnapshot();
  assert(after.log.cursor > before, 'drop advanced the action log');
  assert(!after.actions.some(action => action.label.startsWith('丢下「斧头」')), 'item no longer in hand');
});

test('layout: furniture never blocks a doorway and every door stays reachable', () => {
  const INNER = 2.84 / 2 - 0.1;
  const DOOR_HALF = 0.46;
  const APPROACH = 0.58;
  const wishLists = new Map<string, (string | { id: string; count: number })[]>();
  // Mirror of ROOM_PROPS: only the ids matter for this invariant test.
  const sampleSets: (string | { id: string; count: number })[][] = [
    ['fourPosterBed', 'wardrobe', { id: 'nightstand', count: 2 }],
    ['diningTable', { id: 'diningChair', count: 4 }, 'fireplace'],
    ['ritualCircle', 'altar', 'sarcophagus', 'candelabra'],
    ['grandStaircase', 'bookshelf', { id: 'bookshelf', count: 2 }],
    ['labBench', 'operatingTable', 'workbench', 'specimenShelf'],
    ['furnace', 'coalPile', { id: 'wineRack', count: 2 }, 'barrelStack']
  ];
  void wishLists;

  const doorCombos: ('N' | 'S' | 'E' | 'W')[][] = [
    ['N'],
    ['S', 'E'],
    ['N', 'S'],
    ['N', 'S', 'E'],
    ['N', 'S', 'E', 'W'],
    ['N', 'W'],
    ['E', 'W']
  ];

  let checked = 0;
  for (const doors of doorCombos) {
    for (const wanted of sampleSets) {
      const result = layoutRoom({
        inner: INNER,
        doors,
        wanted,
        seed: layoutHash(`${doors.join('')}|${wanted.map(w => (typeof w === 'string' ? w : w.id)).join(',')}`),
        doorHalf: DOOR_HALF
      });
      checked += 1;

      for (const placed of result.placed) {
        assert(!!PROPS[placed.spec.id], `prop ${placed.spec.id} is registered`);
        if (placed.spec.decal || placed.spec.ceiling || placed.spec.wallMounted) continue;
        // Inside the tile footprint.
        assert(
          Math.abs(placed.rect.x) + placed.rect.w / 2 <= INNER + 0.001,
          `${placed.spec.id} stays inside the tile on X`
        );
        assert(
          Math.abs(placed.rect.z) + placed.rect.d / 2 <= INNER + 0.001,
          `${placed.spec.id} stays inside the tile on Z`
        );
        // Clear of every doorway approach corridor.
        for (const door of doors) {
          const vx = door === 'E' ? 1 : door === 'W' ? -1 : 0;
          const vz = door === 'N' ? -1 : door === 'S' ? 1 : 0;
          const corridor = {
            x: vx * (INNER - APPROACH / 2),
            z: vz * (INNER - APPROACH / 2),
            w: vx !== 0 ? APPROACH : DOOR_HALF * 2,
            d: vz !== 0 ? APPROACH : DOOR_HALF * 2
          };
          const hitX = Math.abs(placed.rect.x - corridor.x) < (placed.rect.w + corridor.w) / 2;
          const hitZ = Math.abs(placed.rect.z - corridor.z) < (placed.rect.d + corridor.d) / 2;
          assert(!(hitX && hitZ), `${placed.spec.id} must not block the ${door} doorway`);
        }
      }

      // No two solid props may overlap.
      const solids = result.placed.filter(
        p => !p.spec.decal && !p.spec.ceiling && !p.spec.wallMounted
      );
      for (let i = 0; i < solids.length; i += 1) {
        for (let j = i + 1; j < solids.length; j += 1) {
          const a = solids[i].rect;
          const b = solids[j].rect;
          const overlapX = Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 0.001;
          const overlapZ = Math.abs(a.z - b.z) < (a.d + b.d) / 2 - 0.001;
          assert(
            !(overlapX && overlapZ),
            `${solids[i].spec.id} and ${solids[j].spec.id} must not intersect`
          );
        }
      }
    }
  }
  assert(checked >= 40, 'layout matrix exercised enough combinations');
});

test('layout: deterministic across repeated runs', () => {
  const args = {
    inner: 2.84 / 2 - 0.1,
    doors: ['N', 'S', 'E'] as ('N' | 'S' | 'E' | 'W')[],
    wanted: ['sofa', 'armchair', 'sideTable', 'fireplace', 'globeStand'],
    seed: layoutHash('determinism'),
    doorHalf: 0.46
  };
  const a = layoutRoom(args).placed.map(p => `${p.spec.id}@${p.x.toFixed(3)},${p.z.toFixed(3)},${p.yaw}`);
  const b = layoutRoom(args).placed.map(p => `${p.spec.id}@${p.x.toFixed(3)},${p.z.toFixed(3)},${p.yaw}`);
  assertEqual(a.join('|'), b.join('|'), 'identical seed yields identical furniture layout');
});

test('presenter: snapshot exposes actions and performs by id', () => {
  const session = new UniversalSession(GAME_REGISTRY.sanguosha, 5);
  const before = session.getSnapshot();

  assert(before.actions.length > 0, 'snapshot exposes actions');
  assert(before.legalCount >= before.actions.length, 'legal count covers grouped actions');
  assertEqual(before.players.length, before.board.playerOrder.length, 'players DTO mirrors state');

  const action = before.actions.find(candidate => !candidate.highlightIds);
  assert(!!action, 'has a directly executable action');

  const result = session.perform(action!.id);
  assert(result.ok, `perform failed: ${result.error}`);

  const after = session.getSnapshot();
  assert(after.revision > before.revision, 'revision advances after a successful action');
  assertEqual(after.log.cursor, 1, 'log cursor advances');
  assertEqual(after.actions.length >= 1, true, 'new actions are offered');
});

test('presenter: clicking a dropped card inspects it instead of picking it up', () => {
  const session = new UniversalSession(GAME_REGISTRY.betrayal, 5, 'exploration');
  const drop = session.getSnapshot().actions.find(action => action.label.startsWith('丢下'));
  assert(!!drop, 'drop action exposed');
  assert(session.perform(drop!.id).ok, 'drop accepted');

  const pickup = session.getSnapshot().actions.find(action => action.label.startsWith('拾取'));
  assert(!!pickup?.highlightIds?.[0], 'dropped item is on the room pile');
  const itemId = pickup!.highlightIds![0];
  const before = session.getSnapshot().log.cursor;

  const inspect = session.pickTarget({ kind: 'entity', id: itemId });
  assert(inspect.handled, 'inspection handled');
  assertEqual(session.getSnapshot().log.cursor, before, 'inspection did not pick the card up');

  assert(session.perform(pickup!.id).ok, 'pickup targeting mode');
  assert(session.pickTarget({ kind: 'entity', id: itemId }).handled, 'explicit pickup handled');
  assert(session.getSnapshot().log.cursor > before, 'explicit pickup dispatches one action');
});

test('presenter: board picks are resolved to legal actions', () => {
  const session = new UniversalSession(GAME_REGISTRY.catan, 5);
  const group = session.getSnapshot().actions.find(action => action.highlightIds);

  assert(!!group, 'has a board-targeting action');
  assert(session.perform(group!.id).ok, 'board action enters targeting mode');
  const kind = group!.label.includes('道路') ? 'edge' : 'node';
  const pick = { kind: kind as 'edge' | 'node', id: group!.highlightIds![0] };

  const result = session.pickTarget(pick);
  assert(result.handled, `pick failed: ${result.message}`);
  assertEqual(session.getSnapshot().log.cursor, 1, 'pick dispatches exactly one action');
});

test('presenter: viewer switching reprojects without exposing the raw engine', () => {
  const session = new UniversalSession(GAME_REGISTRY.sanguosha, 9);
  const god = session.getSnapshot();
  assertEqual(god.viewer, 'GOD', 'starts in god mode');

  session.setViewer('p2');
  const view = session.getSnapshot();
  assertEqual(view.viewer, 'p2', 'viewer propagated');
  assert(view.board.maskedEntityCount > 0, 'hidden entities are masked in the projection');
  assert(view.board.maskedEntityCount >= god.board.maskedEntityCount, 'masking never decreases');

  const select = view.viewers.map(entry => entry.id);
  assert(select.includes('GOD') && select.includes('p2'), 'viewer list is DTO data');
});

test('presenter: notices are emitted for kernel visual events', () => {
  const session = new UniversalSession(GAME_REGISTRY.sanguosha, 4);
  const notices: string[] = [];
  session.onNotice(notice => notices.push(notice.kind));

  const strike = session.getSnapshot().actions.find(action => action.label.startsWith('出【杀】'));
  assert(!!strike, 'strike available');
  session.perform(strike!.id);

  assert(notices.length > 0, 'kernel events surface as UI notices');
  assert(notices.some(kind => kind === 'event' || kind === 'announce'), 'notice kinds are UI-level');
});

test('presenter: payload fields collapse multi-step choices into one action', () => {
  const session = new UniversalSession(GAME_REGISTRY.catan, 3, 'rich_action');
  const pipValue = (label: string) =>
    Number(
      session
        .getSnapshot()
        .players.find(player => player.id === 'p1')!
        .pips.find(pip => pip.label === label)?.value ?? 0
    );

  const bank = session.getSnapshot().actions.find(action => action.label.includes('银行 / 港口交易'));
  assert(!!bank, 'bank trade offered in one action');
  assertEqual(bank!.fields?.length, 2, 'give/want fields exposed to the UI');

  const beforeWood = pipValue('木材');
  const beforeOre = pipValue('矿');
  const bankResult = session.perform(bank!.id, { give: 'wood', want: 'ore' });
  assert(bankResult.ok, `bank trade failed: ${bankResult.error}`);
  const paid = beforeWood - pipValue('木材');
  assert(paid >= 2 && paid <= 4, `bank ratio applied from payload (paid ${paid})`);
  assertEqual(pipValue('矿'), beforeOre + 1, 'wanted resource received');

  const year = session.getSnapshot().actions.find(action => action.label.includes('丰饶'));
  assert(!!year, 'year of plenty offered in one action');
  assertEqual(year!.fields?.length, 2, 'two resource fields exposed');

  const beforeSheep = pipValue('羊毛');
  const beforeWheat = pipValue('麦');
  const yearResult = session.perform(year!.id, { a: 'sheep', b: 'wheat' });
  assert(yearResult.ok, `year of plenty failed: ${yearResult.error}`);
  assertEqual(pipValue('羊毛'), beforeSheep + 1, 'first pick granted');
  assertEqual(pipValue('麦'), beforeWheat + 1, 'second pick granted');
  assert(session.getSnapshot().phaseLabel.includes('ACTION'), 'no intermediate phase remains');

  const monopoly = session.getSnapshot().actions.find(action => action.label.includes('垄断'));
  assert(!!monopoly, 'monopoly offered in one action');
  const beforeBrick = pipValue('砖');
  const monopolyResult = session.perform(monopoly!.id, { resource: 'brick' });
  assert(monopolyResult.ok, `monopoly failed: ${monopolyResult.error}`);
  assertEqual(pipValue('砖'), beforeBrick + 3, 'monopoly payload takes all brick');
  assertEqual(
    Number(
      session.getSnapshot().players.find(player => player.id === 'p2')!.pips.find(pip => pip.label === '砖')?.value ?? 0
    ),
    0,
    'victim loses the resource'
  );
});

/* -------------------------------------------------------------------------- */
/* Card inspection: one shared implementation, capability-driven previews */
/* -------------------------------------------------------------------------- */

function noticeFor(session: UniversalSession, entityId: string) {
  const notices: { card?: { facts?: { label: string; value: string }[]; art?: string } }[] = [];
  session.onNotice(notice => notices.push(notice as never));
  const pick = session.pickTarget({ kind: 'entity', id: entityId });
  return { pick, notices };
}

test('presentation: splendor declares hover previews and never opens a click sheet', () => {
  assertEqual(GAME_REGISTRY.splendor.presentation?.cardPreviewOnHover, true, 'splendor declares hover previews');
  const session = new UniversalSession(GAME_REGISTRY.splendor, 7);
  const card = Object.values(session.getSnapshot().board.entities).find(entity => entity.components?.cardFace);
  assert(!!card, 'splendor exposes a card');
  const { pick, notices } = noticeFor(session, card!.id);
  assert(pick.handled, `splendor card pick handled: ${pick.message ?? ''}`);
  const notice = notices[notices.length - 1];
  assert(!!notice, 'splendor card pick emits a notice');
  assertEqual(notice.card, undefined, 'no second card sheet on top of the hover preview');
  session.dispose();
});

test('presentation: betrayal item cards keep their sheet, facts come from the game', () => {
  assert(!!GAME_REGISTRY.betrayal.presentation?.cardFacts, 'betrayal declares its own card facts');
  const session = new UniversalSession(GAME_REGISTRY.betrayal, 5, 'exploration');
  const item = Object.values(session.getSnapshot().board.entities).find(
    entity => entity.components?.cardFace && entity.components?.custom?.kind
  );
  assert(!!item, 'betrayal exposes a typed item card');
  const kind = String(item!.components?.custom?.kind);
  const labels: Record<string, string> = { weapon: '武器', armor: '护甲', relic: '圣物', consumable: '消耗品', tool: '工具' };
  const { pick, notices } = noticeFor(session, item!.id);
  assert(pick.handled, `betrayal item pick handled: ${pick.message ?? ''}`);
  const notice = notices[notices.length - 1];
  assert(!!notice?.card, 'betrayal item opens the framed sheet');
  assertEqual(notice.card!.facts?.[0]?.label, '类别', 'the game vocabulary row leads the facts');
  assertEqual(notice.card!.facts?.[0]?.value, labels[kind] ?? kind, 'card kind is translated by the game');
  session.dispose();
});

test('presentation: the shared inspector renders any game without a game-id branch', () => {
  const entity = {
    id: 'card_x',
    components: {
      cardFace: { title: '测试卡', type: 'RELIC', desc: '说明', color: '#abc', imageUrl: 'img/x.png' },
      custom: { en: 'Test Card' }
    }
  };
  // A module that declares nothing gets the neutral default: a sheet with the
  // card's own artwork and no invented fact rows.
  const neutral = buildEntityInspectNotice(entity, { snapshot: { actions: [] }, module: counterModule });
  assert(!!neutral?.card, 'neutral module still opens a sheet');
  assertEqual(neutral!.card!.art, 'img/x.png', 'imported face artwork is reused');
  assertEqual(neutral!.card!.facts?.length, 0, 'no fact rows without a game declaration');
  assertEqual(neutral!.card!.kind, 'RELIC', 'face type is the fallback kind');
  // Hover-preview modules suppress the sheet but keep the toast.
  const hover = buildEntityInspectNotice(entity, {
    snapshot: { actions: [] },
    module: { ...counterModule, presentation: { cardPreviewOnHover: true } }
  });
  assert(!!hover, 'hover-preview module still emits the toast');
  assertEqual(hover!.card, undefined, 'hover-preview module suppresses the sheet');
  // Entities without a card face are not inspectable cards at all.
  assertEqual(
    buildEntityInspectNotice({ id: 'plain', components: {} }, { snapshot: { actions: [] }, module: counterModule }),
    null,
    'a face-less entity is not a card'
  );
});

test('presentation: both sessions inspect through the shared module, never by module id', () => {
  const appDir = new URL('../../../app/src/', import.meta.url);
  for (const file of ['session.ts', 'netSession.ts']) {
    const source = readFileSync(new URL(file, appDir), 'utf8');
    assert(source.includes("from './inspect'"), `${file} reuses the shared inspector`);
  }
  // Capability checks replaced identity checks: the application layer must not
  // ask "which game is this?" to decide how to present something.
  const offenders: string[] = [];
  for (const entry of readdirSync(appDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const source = readFileSync(`${entry.parentPath}/${entry.name}`, 'utf8');
    if (source.includes('meta.id ===')) offenders.push(entry.name);
  }
  assertEqual(offenders.length, 0, `presentation decided by module id: ${offenders.join(', ')}`);
});

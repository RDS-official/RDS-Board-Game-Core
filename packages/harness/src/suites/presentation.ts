/* -------------------------------------------------------------------------- */
/* suite:presentation — moved verbatim from suite.ts */
/* -------------------------------------------------------------------------- */

import { OccupancyIndex } from '@rds/kernel/occupancy';

// ---- Step 2b-2 regression: presentation hints drive map layers ----------
test('betrayal: presentation hints expose map title, player node, cast, loot, tokens', () => {
  const session = new UniversalSession(GAME_REGISTRY.betrayal, 5, 'exploration');
  const snap = session.getSnapshot();
  assertEqual(snap.spatial?.title, '洋馆总览', 'map title flows into spatial snapshot');
  const tags = (snap.spatial?.floors ?? []).map(f => f.tag);
  assert(tags.includes('2F'), 'floor tags flow into spatial snapshot: ' + tags.join(','));
  assertEqual(typeof session.playerNodeId?.('p1'), 'string', 'playerNodeId returns current room');
  const roomId = session.playerNodeId?.('p1') ?? 'unknown-room';
  assertEqual(session.traitLabel?.('speed'), '速度', 'traitLabel resolves localized trait name');
  assertEqual(session.castMembers?.().length ?? 0, 0, 'no monster on board at game start');
  assertEqual(session.roomLoot?.(String(roomId)) ?? null, null, 'no loot in an empty room');
  session.dispose();
});

test('hud: minimap renders purely from snapshot.spatial and presenter ports', () => {
  const hud = readFileSync(new URL('../../../../apps/web/src/ui/hud.ts', import.meta.url), 'utf8');
  const banned = ['BASEMENT', '洋馆总览', 'zone_room_', 'traitZh', 'currentRoomId', '怪物'];
  for (const token of banned) assert(!hud.includes(token), 'hud.ts must not hardcode ' + token);
  const required = ['playerNodeId', 'castMembers', 'roomLoot', 'tokenBadge', 'traitLabel', 'snapshot.spatial'];
  for (const token of required) assert(hud.includes(token), 'hud.ts must use ' + token);
});

test('betrayal: presentation.ts owns the betrayal-specific label vocabulary', () => {
  const pres = readFileSync(new URL('../../../games/src/betrayal/presentation.ts', import.meta.url), 'utf8');
  const required = ['betrayalPlayerNode', 'betrayalCastMember', 'betrayalRoomLoot', 'betrayalTokenBadge', '洋馆总览'];
  for (const token of required) assert(pres.includes(token), 'betrayal presentation must define ' + token);
});

import { UniversalGameEngine } from '@rds/kernel/engine';
import { GAME_REGISTRY } from '@rds/games/registry';
import { UniversalSession } from '@rds/app/session';
import { buildEntityInspectNotice, buildMoment, buildNodeDiscoveryView } from '@rds/app/inspect';
import { entityDetailKey, nodeDetailKey } from '@rds/app/contracts';
import type { UiDetailView, UiNotice } from '@rds/app/contracts';
import { OverlayArbiter } from '@rds/web/ui/overlay';
import type { OverlayState } from '@rds/web/ui/overlay';
import type { MapGraphNode } from '@rds/kernel/types';
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
  const notices: UiNotice[] = [];
  session.onNotice(notice => notices.push(notice));
  const pick = session.pickTarget({ kind: 'entity', id: entityId });
  return { pick, notices };
}

test('presentation: splendor declares hover previews and never opens a click sheet', () => {
  assertEqual(GAME_REGISTRY.splendor.presentation?.cardPreviewOnHover, true, 'splendor declares hover previews');
  const session = new UniversalSession(GAME_REGISTRY.splendor, 7);
  const card = Object.values(session.getSnapshot().board.entities).find(entity => entity.components?.cardFace);
  assert(!!card, 'splendor exposes a card');
  const { pick, notices } = noticeFor(session, String(card!.id));
  assert(pick.handled, `splendor card pick handled: ${pick.message ?? ''}`);
  const notice = notices[notices.length - 1];
  assert(!!notice, 'splendor card pick emits a notice');
  assertEqual(notice.view, undefined, 'no second card view on top of the hover preview');
  session.dispose();
});

test('presentation: betrayal item cards keep their sheet, badge and facts come from the game', () => {
  assert(!!GAME_REGISTRY.betrayal.presentation?.cardFacts, 'betrayal declares its own card facts');
  assert(!!GAME_REGISTRY.betrayal.presentation?.cardStyle, 'betrayal declares its own card style');
  const session = new UniversalSession(GAME_REGISTRY.betrayal, 5, 'exploration');
  const item = Object.values(session.getSnapshot().board.entities).find(
    entity => entity.components?.cardFace && entity.components?.custom?.kind
  );
  assert(!!item, 'betrayal exposes a typed item card');
  const kind = String(item!.components?.custom?.kind);
  const labels: Record<string, string> = { weapon: '武器', armor: '护甲', relic: '圣物', consumable: '消耗品', tool: '工具' };
  const { pick, notices } = noticeFor(session, String(item!.id));
  assert(pick.handled, `betrayal item pick handled: ${pick.message ?? ''}`);
  const notice = notices[notices.length - 1];
  assert(!!notice?.view, 'betrayal item opens the framed sheet');
  const view = notice.view!;
  assertEqual(view.sections[0]?.label, '类别', 'the game vocabulary row leads the sections');
  assertEqual(view.sections[0]?.value, labels[kind] ?? kind, 'card kind is translated by the game');
  assertEqual(view.badge, '遗物 · ITEM', 'the badge is a localised label owned by the game');
  assertEqual(view.tone, 'treasure', 'the tone is an opaque token the view layer maps to paint');
  assertEqual(view.seal, '◆', 'the decorative glyph also comes from the game');
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
  // card's own artwork, no invented sections and no game-specific paint.
  const neutral = buildEntityInspectNotice(entity, { snapshot: { actions: [] }, module: counterModule });
  assert(!!neutral?.view, 'neutral module still opens a sheet');
  assertEqual(neutral!.view!.art, 'img/x.png', 'imported face artwork is reused');
  assertEqual(neutral!.view!.sections.length, 0, 'no sections without a game declaration');
  assertEqual(neutral!.view!.badge, 'RELIC', 'face type is the fallback badge');
  assertEqual(neutral!.view!.tone, undefined, 'no tone without a game declaration');
  assertEqual(neutral!.view!.key, entityDetailKey('card_x'), 'the sheet key follows the shared convention');
  // Hover-preview modules suppress the sheet but keep the toast.
  const hover = buildEntityInspectNotice(entity, {
    snapshot: { actions: [] },
    module: { ...counterModule, presentation: { cardPreviewOnHover: true } }
  });
  assert(!!hover, 'hover-preview module still emits the toast');
  assertEqual(hover!.view, undefined, 'hover-preview module suppresses the sheet');
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
    assert(source.includes('buildEntityInspectNotice('), `${file} calls the shared inspector`);
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

test('presentation: the overlay arbiter keeps one view per subject and ranks peek below pinned', () => {
  const arbiter = new OverlayArbiter();
  const states: OverlayState[] = [];
  const unsubscribe = arbiter.subscribe(state => states.push(state));
  const card = (key: string): UiDetailView => ({ key, title: key, sections: [], actions: [] });

  assert(arbiter.open({ owner: 'test', mode: 'peek', view: card('entity:a') }).accepted, 'peek accepted');
  assertEqual(arbiter.current().peek?.view.key, 'entity:a', 'the chip addresses the hovered card');
  // Moving the pointer to another card swaps the chip; peek never stacks.
  assert(arbiter.open({ owner: 'test', mode: 'peek', view: card('entity:b') }).accepted, 'a new peek replaces');
  assertEqual(arbiter.current().peek?.view.key, 'entity:b', 'only one peek at a time');

  // Clicking pins the same subject and drops the redundant chip: the user sees
  // one view of that card, not two.
  assert(arbiter.open({ owner: 'test', mode: 'pinned', view: card('entity:b') }).accepted, 'pinned accepted');
  assertEqual(arbiter.current().peek, undefined, 'pinning supersedes the chip for the same card');
  assertEqual(arbiter.current().pinned?.view.key, 'entity:b', 'the sheet takes over');
  assertEqual(arbiter.sheet()?.view.key, 'entity:b', 'sheet() resolves the visible sheet');

  // Hovering a different card must not steal the pinned sheet.
  const refused = arbiter.open({ owner: 'test', mode: 'peek', view: card('entity:c') });
  assertEqual(refused.accepted, false, 'pointer drift cannot evict a pinned sheet');
  assertEqual(refused.reason, 'busy-pinned', 'the refusal names the blocker');
  assertEqual(arbiter.sheet()?.view.key, 'entity:b', 'the pinned sheet survives the hover');

  // A modal (a room reveal) outranks the sheet and refuses weaker requests.
  assert(arbiter.open({ owner: 'test', mode: 'modal', view: card('node:r1') }).accepted, 'modal accepted');
  assertEqual(arbiter.sheet()?.view.key, 'node:r1', 'modal outranks the pinned sheet');
  assertEqual(
    arbiter.open({ owner: 'test', mode: 'peek', view: card('entity:b') }).reason,
    'busy-modal',
    'a modal refuses previews'
  );
  assertEqual(
    arbiter.open({ owner: 'test', mode: 'pinned', view: card('entity:b') }).reason,
    'busy-modal',
    'a modal refuses the pinned sheet too'
  );
  assertEqual(arbiter.current().modal?.view.key, 'node:r1', 'the modal is not displaced');

  // The same subject is never on screen twice across the three slots.
  arbiter.close('modal');
  arbiter.open({ owner: 'test', mode: 'peek', view: card('entity:a') });
  arbiter.open({ owner: 'test', mode: 'pinned', view: card('entity:a') });
  arbiter.closeKey('entity:a');
  const visible = [arbiter.current().peek, arbiter.current().pinned, arbiter.current().modal]
    .filter((entry): entry is NonNullable<typeof entry> => !!entry)
    .map(entry => entry.view.key);
  assertEqual(visible.length, 0, 'closing a key clears it from every slot');
  assert(states.length > 0, 'listeners observe the stack');
  unsubscribe();
  const seen = states.length;
  arbiter.open({ owner: 'test', mode: 'peek', view: card('entity:d') });
  assertEqual(states.length, seen, 'unsubscribe stops notifications');
});

test('presentation: a newly explored node is described by the game, not by the HUD', () => {
  // The generic layer only knows that a node it had never seen just appeared.
  // Everything the player reads about it comes from the game's describeNode.
  const node = {
    id: 'room_x',
    type: 'ROOM',
    position: [0, 0, 0],
    neighbors: [],
    props: {
      name: '图书馆',
      en: 'Library',
      floor: 'UPPER',
      doors: ['N', 'S'],
      symbol: 'OMEN',
      text: '书架上摆满了发霉的卷册。'
    }
  } as unknown as MapGraphNode;

  const discovery = buildNodeDiscoveryView(node, { module: GAME_REGISTRY.betrayal });
  assert(!!discovery, 'betrayal describes its rooms');
  assertEqual(discovery!.view.key, nodeDetailKey('room_x'), 'the dossier addresses the node');
  assertEqual(discovery!.view.title, '图书馆', 'the name is the room name');
  assertEqual(discovery!.view.subtitle, 'Library', 'the english line survives');
  assertEqual(discovery!.view.tone, 'place', 'rooms use the neutral place tone');
  assertEqual(discovery!.view.desc, '书架上摆满了发霉的卷册。', 'the flavour text is the room text');
  assertEqual(
    discovery!.view.sections.map(section => section.label).join('/'),
    '楼层/已连通门位/符号',
    'the dossier rows are the game vocabulary'
  );
  assertEqual(
    discovery!.view.sections.map(section => section.value).join('|'),
    '二楼|N · S|预兆 👁',
    'the values are translated by the game'
  );
  assertEqual(discovery!.footer, '新房间已加入洋馆布局', 'the footnote belongs to the game');
  assertEqual(discovery!.reveal, true, 'rooms that matter reveal full screen');

  // A game that declares no node hints simply gets no cutscene.
  assertEqual(buildNodeDiscoveryView(node, { module: counterModule }), null, 'no hints, no dossier');
  assertEqual(buildNodeDiscoveryView(node, { module: GAME_REGISTRY.splendor }), null, 'splendor declares none');
  assertEqual(buildNodeDiscoveryView(undefined, { module: GAME_REGISTRY.betrayal }), null, 'missing node is null');
  const door = { ...node, id: 'door_1', type: 'DOOR' } as unknown as MapGraphNode;
  assertEqual(buildNodeDiscoveryView(door, { module: GAME_REGISTRY.betrayal }), null, 'only rooms carry dossiers');
});

test('presentation: the HUD holds no room vocabulary, the game package does', () => {
  const read = (relative: string) =>
    readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const hud = read('../../../../apps/web/src/ui/hud.ts');
  for (const word of ['已连通门位', '新房间已加入洋馆布局', '洋馆布局']) {
    assert(!hud.includes(word), `generic HUD still spells out ${word}`);
  }
  assert(hud.includes('maybeRevealNode('), 'the HUD reacts to a new node');
  assert(hud.includes('presenter.nodeDetail?.'), 'the dossier is asked from the presenter');

  const betrayal = read('../../../games/src/betrayal/presentation.ts');
  assert(betrayal.includes('已连通门位'), 'the room vocabulary lives with the game');
  assert(betrayal.includes('betrayalDescribeNode'), 'the game exports its node description');
});

test('presentation: the trait ladders are declared by the game, not by the shell', () => {
  const betrayal = GAME_REGISTRY.betrayal.presentation;
  const sanity = betrayal?.describeTrait?.('sanity');
  assert(!!sanity, 'betrayal describes its ladders');
  assertEqual(sanity!.label, '神智', 'the printed name is the game word');
  assertEqual(sanity!.short, '智', 'the pip abbreviation too');
  assertEqual(sanity!.damageKind, 'MENTAL', 'mental damage is a game claim, not a HUD guess');
  assertEqual(sanity!.max, 8, 'the track length is the printed one');
  assertEqual(betrayal?.describeTrait?.('might')?.damageKind, 'PHYSICAL', 'might still hits the body');
  assertEqual(betrayal?.describeTrait?.('luck'), null, 'a foreign key is not invented');

  // Enumerating a player's ladders is also the game's call: the shell has no
  // idea that trait values live under `traitIndex`.
  assertEqual(
    JSON.stringify(betrayal?.traits?.({ traitIndex: { speed: 4, might: 3 } })),
    JSON.stringify({ speed: 4, might: 3 }),
    'the ladder read out of custom props'
  );
  assertEqual(betrayal?.traits?.({}), null, 'no ladder bag, no pips');
  assertEqual(GAME_REGISTRY.splendor.presentation?.describeTrait, undefined, 'splendor has no ladders');
  assertEqual(GAME_REGISTRY.sanguosha.presentation?.describeTrait, undefined, 'neither does sanguosha');
});

test('presentation: the overture is a moment the game declares', () => {
  const board = {
    globalVars: {
      hauntTriggered: true,
      haunt: { id: 'haunt_mummy', number: 3, title: '木乃伊苏醒', intro: '沙尘里有什么东西站起来了。', traitorId: 'p2' }
    },
    players: { p1: { name: '甲' }, p2: { name: '乙', role: 'TRAITOR' } }
  };
  const moment = buildMoment(board, '英雄目标：找出出口。', { module: GAME_REGISTRY.betrayal });
  assert(!!moment, 'betrayal declares the haunt curtain');
  assertEqual(moment!.key, 'haunt_mummy', 'the bookmark key is the haunt id, so it replays once');
  assertEqual(moment!.kicker, '作祟开始 · THE HAUNT BEGINS', 'every word on the curtain is the game word');
  assertEqual(moment!.caption, 'HAUNT No.03', 'the haunt number is padded by the game');
  assertEqual(moment!.title, '木乃伊苏醒', 'the haunt title');
  assertEqual(moment!.story, '沙尘里有什么东西站起来了。', 'the overture text');
  assertEqual(moment!.cast?.length, 1, 'one traitor is named');
  assertEqual(moment!.cast?.[0].label, '背叛者', 'the cast label is game vocabulary');
  assertEqual(moment!.cast?.[0].name, '乙', 'the cast name is resolved from the projection');
  assertEqual(moment!.objective, '英雄目标：找出出口。', 'the objective is the projected mission line');
  assertEqual(moment!.durationMs, 9000, 'the game picks how long the table stares at it');

  // Nothing is staged before the haunt actually starts.
  assertEqual(
    buildMoment(
      { globalVars: { haunt: { id: 'haunt_mummy' } }, players: {} },
      undefined,
      { module: GAME_REGISTRY.betrayal }
    ),
    null,
    'an unpacked haunt has no curtain'
  );
  assertEqual(buildMoment(board, undefined, { module: counterModule }), null, 'no hints, no curtain');
  assertEqual(buildMoment(board, undefined, { module: GAME_REGISTRY.splendor }), null, 'splendor never inherits it');
});

test('presentation: the HUD holds no trait tables, role names or overture copy', () => {
  const read = (relative: string) =>
    readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const hud = read('../../../../apps/web/src/ui/hud.ts');
  for (const word of ['HUD_TRAIT_SHORT', '叛徒', '英雄', '探索者', '作祟', 'HAUNT No.', 'THE HAUNT BEGINS']) {
    assert(!hud.includes(word), `generic HUD still spells out ${word}`);
  }
  assert(hud.includes('maybeShowMoment('), 'the HUD reacts to a declared moment');
  assert(hud.includes('presenter.moment?.('), 'the curtain is asked from the presenter');
  assert(hud.includes('presenter.roleLabel?.'), 'role names are asked from the presenter');
  assert(hud.includes('dataset.traitKey'), 'the pip flash addresses rows by opaque key');

  const betrayal = read('../../../games/src/betrayal/presentation.ts');
  for (const word of ['作祟开始', '叛徒', '神智', 'traitIndex']) {
    assert(betrayal.includes(word), `the game package owns ${word}`);
  }
  assert(betrayal.includes('betrayalDescribeMoment'), 'the game exports its overture');
  assert(betrayal.includes('betrayalDescribeTrait'), 'the game exports its ladder metadata');

  const sanguosha = read('../../../games/src/sanguosha/presentation.ts');
  assert(sanguosha.includes('主公'), 'the identity tokens live with sanguosha');
  const session = read('../../../app/src/session.ts');
  assert(!session.includes('LOYALIST'), 'the shared layer no longer holds identity tables');
  assert(!session.includes('TRAIT_LABEL'), 'nor trait label tables');
});

/**
 * Named Betrayal scenarios for the UI, tests and replays.
 *
 * `?scenario=haunt_mummy` jumps straight into the Mummy haunt, `exploration`
 * gives a half-explored mansion, `trade_ready` demonstrates the consent-based
 * item trade.
 */

import { ECSManager } from '@rds/kernel/ecs';
import { GameScenario, ReduceContext } from '@rds/kernel/module';
import { DeterministicPRNG } from '@rds/kernel/prng';
import { Entity, GameState, PlayerId } from '@rds/kernel/types';
import { ITEM_DEFS, OMEN_DEFS, RoomDef, ROOM_DEFS } from './cards';
import { BetrayalRules } from './rules';
import { setupBetrayal } from './setup';
import { addRoomNode, applyItemGain, applyOmenGain, commit, connectRooms, linkSpecialRooms, makeCardEntity, movePlayerTo } from './helpers';

function scenarioContext(): ReduceContext {
  let counter = 0;
  return {
    seq: 0,
    id: (kind: string) => `${kind}_sc_${(++counter).toString(36)}`,
    trace: () => undefined,
    roll: (spec, seed) => {
      const roll = DeterministicPRNG.rollFaces(seed, spec);
      return { result: { spec, rolls: roll.rolls, total: roll.sum }, nextSeed: roll.nextSeed };
    }
  };
}

export function addExploredRoom(state: GameState, defId: string, col: number, row: number, parentId?: string): string {
  const def: RoomDef = ROOM_DEFS[defId];
  const nodeId = `room_${defId}`;
  if (!state.mapGraph.nodes[nodeId]) addRoomNode(state, def, col, row, 0, nodeId);
  state.mapGraph.nodes[nodeId].props.resolved = true;
  const tileId = `roomtile_${defId}`;
  if (state.entities[tileId]) {
    commit(state, ECSManager.moveEntity(state, tileId, 'zone_room_placed'));
    state.entities[tileId].visibility = { type: 'PUBLIC' };
    state.mapGraph.nodes[nodeId].props.tileEntityId = tileId;
  }
  if (parentId) connectRooms(state, parentId, nodeId, 'DOOR');
  linkSpecialRooms(state);
  return nodeId;
}

export function grantItem(state: GameState, playerId: PlayerId, defId: string): Entity {
  const def = ITEM_DEFS[defId];
  const entity = makeCardEntity(
    `scenario_item_${playerId}_${defId}`,
    `zone_hand_${playerId}`,
    defId,
    'ITEM',
    { name: def.name, en: def.en, desc: def.desc },
    { tradeable: def.tradeable, charges: def.charges ?? 0, kind: def.kind, stealable: def.stealable !== false }
  );
  entity.visibility = { type: 'PUBLIC' };
  entity.ownerId = playerId;
  const next = ECSManager.addEntity(state, entity);
  state.entities = next.entities;
  state.zones = next.zones;
  applyItemGain(state, playerId, defId);
  return state.entities[entity.id];
}

export function grantOmen(state: GameState, playerId: PlayerId, defId: string): Entity {
  const def = OMEN_DEFS[defId];
  const entity = makeCardEntity(
    `scenario_omen_${playerId}_${defId}`,
    `zone_hand_${playerId}`,
    defId,
    'OMEN',
    { name: def.name, en: def.en, desc: def.desc },
    { tradeable: def.tradeable, companion: !!def.companion }
  );
  entity.visibility = { type: 'PUBLIC' };
  entity.ownerId = playerId;
  const next = ECSManager.addEntity(state, entity);
  state.entities = next.entities;
  state.zones = next.zones;
  applyOmenGain(state, playerId, defId);
  state.globalVars.omensRevealed = Number(state.globalVars.omensRevealed ?? 0) + 1;
  state.globalVars.omenNames = [...(state.globalVars.omenNames ?? []), def.name];
  return state.entities[entity.id];
}

function setRoom(state: GameState, playerId: PlayerId, roomId: string): void {
  movePlayerTo(state, playerId, roomId);
}

export const BETRAYAL_SCENARIOS: Record<string, GameScenario> = {
  exploration: {
    description: '半探索的山庄：三层各已铺开数间房，玩家持有关键道具。',
    setup: seed => {
      const state = setupBetrayal(seed);
      addExploredRoom(state, 'ballroom', 1, 1, 'room_foyer');
      addExploredRoom(state, 'library', 3, 1, 'room_foyer');
      addExploredRoom(state, 'kitchen', 1, 0, 'room_entrance_hall');
      addExploredRoom(state, 'master_bedroom', 1, 2, 'room_upper_landing');
      addExploredRoom(state, 'balcony', 2, 1, 'room_upper_landing');
      addExploredRoom(state, 'tower', 3, 2, 'room_upper_landing');
      addExploredRoom(state, 'catacombs', 1, 2, 'room_basement_landing');
      addExploredRoom(state, 'furnace_room', 3, 2, 'room_basement_landing');
      addExploredRoom(state, 'the_pentagram_chamber', 2, 1, 'room_basement_landing');

      setRoom(state, 'p1', 'room_ballroom');
      setRoom(state, 'p2', 'room_library');
      setRoom(state, 'p3', 'room_foyer');

      grantItem(state, 'p1', 'axe');
      grantItem(state, 'p2', 'rope');
      grantItem(state, 'p2', 'medical_kit');
      grantItem(state, 'p3', 'candle');
      grantOmen(state, 'p3', 'holy_symbol');

      state.activePlayerId = 'p1';
      state.globalVars.hauntTriggered = false;
      state.globalVars.haunt = null;
      return state;
    }
  },

  omen_ready: {
    description: '作祟检定演示：p1 已抽出多张预兆，结束回合即进入 HAUNT_CHECK 响应栈。',
    setup: seed => {
      const state = setupBetrayal(seed);
      addExploredRoom(state, 'chapel', 3, 0, 'room_entrance_hall');
      setRoom(state, 'p1', 'room_chapel');
      setRoom(state, 'p2', 'room_foyer');
      setRoom(state, 'p3', 'room_entrance_hall');
      grantOmen(state, 'p1', 'book');
      grantOmen(state, 'p1', 'skull');
      grantOmen(state, 'p1', 'mask');
      state.globalVars.omensRevealed = 8;
      state.globalVars.omenNames = ['禁忌古籍', '裂痕头骨', '诡异面具'];
      state.globalVars.pendingHauntRoll = { playerId: 'p1', omens: 8 };
      state.activePlayerId = 'p1';
      state.activeActorId = 'p1';
      state.players.p1.customProps.movesLeft = 0;
      return state;
    }
  },

  trade_ready: {
    description: '前厅交易演示：p1 持手斧，p2 持麻绳，可直接发起同房间交易。',
    setup: seed => {
      const state = setupBetrayal(seed);
      addExploredRoom(state, 'library', 3, 1, 'room_foyer');
      setRoom(state, 'p1', 'room_foyer');
      setRoom(state, 'p2', 'room_foyer');
      setRoom(state, 'p3', 'room_entrance_hall');
      grantItem(state, 'p1', 'axe');
      grantItem(state, 'p1', 'lucky_stone');
      grantItem(state, 'p2', 'rope');
      grantItem(state, 'p2', 'armor');
      state.activePlayerId = 'p1';
      return state;
    }
  },

  haunt_mummy: {
    description: '剧本 1「木乃伊苏醒」：地下墓穴开局，小女孩在神父手中。',
    setup: seed => {
      const state = setupBetrayal(seed);
      addExploredRoom(state, 'catacombs', 1, 2, 'room_basement_landing');
      addExploredRoom(state, 'furnace_room', 3, 2, 'room_basement_landing');
      addExploredRoom(state, 'crypt', 2, 1, 'room_basement_landing');
      connectRooms(state, 'room_catacombs', 'room_furnace_room', 'DOOR');

      setRoom(state, 'p1', 'room_catacombs');
      setRoom(state, 'p2', 'room_catacombs');
      setRoom(state, 'p3', 'room_furnace_room');

      grantOmen(state, 'p2', 'girl');
      grantOmen(state, 'p3', 'holy_symbol');
      grantItem(state, 'p2', 'rope');

      BetrayalRules.beginHaunt(state, 'p1', 'mummy', 'room_catacombs', scenarioContext());
      state.globalVars.hauntObjectives = {
        hero: '携带神圣徽记或指环抵达石棺房间，完成 2 次知识 5+ 的封印检定。',
        traitor: '让木乃伊夺走小女孩并带回石棺，或杀死所有英雄。'
      };
      return state;
    }
  },

  haunt_eye: {
    description: '剧本 6「巨眼降临」：叛徒被母舰接引，p2 已被精神控制。',
    setup: seed => {
      const state = setupBetrayal(seed);
      addExploredRoom(state, 'tower', 3, 2, 'room_upper_landing');
      addExploredRoom(state, 'balcony', 2, 1, 'room_upper_landing');
      connectRooms(state, 'room_balcony', 'room_tower', 'DOOR');

      setRoom(state, 'p1', 'room_tower');
      setRoom(state, 'p2', 'room_balcony');
      setRoom(state, 'p3', 'room_tower');

      grantOmen(state, 'p1', 'holy_symbol');
      grantItem(state, 'p2', 'axe');
      grantItem(state, 'p3', 'axe');
      grantOmen(state, 'p3', 'spear');

      BetrayalRules.beginHaunt(state, 'p1', 'floating_eye', 'room_tower', scenarioContext());
      state.globalVars.hauntObjectives = {
        hero: '摧毁两只巨眼，然后在飞船标记房间炸毁信标。',
        traitor: '用巨眼控制所有英雄并把他们送进飞船。'
      };
      state.players.p2.customProps.controlled = true;
      // Start on the free hero so the table has a meaningful opening action.
      state.activePlayerId = 'p3';
      state.activeActorId = 'p3';
      state.players.p3.customProps.attacksLeft = 1;
      state.players.p3.customProps.usedItems = [];
      return state;
    }
  },

  haunt_phantom: {
    description: '剧本 10「幽灵的拥抱」：五芒星堂开局，遗骨尚未找到。',
    setup: seed => {
      const state = setupBetrayal(seed);
      addExploredRoom(state, 'the_pentagram_chamber', 2, 1, 'room_basement_landing');
      addExploredRoom(state, 'catacombs', 1, 2, 'room_basement_landing');
      addExploredRoom(state, 'crypt', 3, 2, 'room_basement_landing');
      connectRooms(state, 'room_the_pentagram_chamber', 'room_catacombs', 'DOOR');
      connectRooms(state, 'room_the_pentagram_chamber', 'room_crypt', 'DOOR');

      setRoom(state, 'p1', 'room_the_pentagram_chamber');
      setRoom(state, 'p2', 'room_catacombs');
      setRoom(state, 'p3', 'room_crypt');

      grantOmen(state, 'p3', 'holy_symbol');
      grantItem(state, 'p2', 'axe');
      grantItem(state, 'p2', 'rope');

      BetrayalRules.beginHaunt(state, 'p1', 'phantom', 'room_the_pentagram_chamber', scenarioContext());
      state.globalVars.hauntObjectives = {
        hero: '在地下室找到遗骨，携带神圣徽记在五芒星堂完成 3 次神智 5+ 的安魂咏唱。',
        traitor: '让怨灵杀死所有英雄，把整座洋馆拖入灵界。'
      };
      state.globalVars.bonesRoomId = 'room_crypt';
      return state;
    }
  },

  haunt_zombie: {
    description: '剧本 3「活死人之夜」：亡者大军破土而出，英雄需调配圣水净化洋馆。',
    setup: seed => {
      const state = setupBetrayal(seed);
      addExploredRoom(state, 'the_pentagram_chamber', 2, 1, 'room_basement_landing');
      // 实验室不能放在 (2,2)：那里是地下平台（楼梯井）的格子，两块房块会
      // 叠在一起。放到 (1,2)，与其他剧本把地下室房间摆在平台两侧一致。
      addExploredRoom(state, 'research_laboratory', 1, 2, 'room_basement_landing');
      addExploredRoom(state, 'kitchen', 1, 0, 'room_entrance_hall');
      connectRooms(state, 'room_the_pentagram_chamber', 'room_research_laboratory', 'DOOR');

      setRoom(state, 'p1', 'room_the_pentagram_chamber');
      setRoom(state, 'p2', 'room_research_laboratory');
      setRoom(state, 'p3', 'room_kitchen');

      grantItem(state, 'p2', 'revolver');
      grantItem(state, 'p3', 'medical_kit');

      BetrayalRules.beginHaunt(state, 'p1', 'living_dead', 'room_the_pentagram_chamber', scenarioContext());
      state.globalVars.hauntObjectives = {
        hero: '在实验室调配圣水，前往五芒星堂完成 2 次圣化仪式；或消灭死灵法师。',
        traitor: '操控活死人大军消灭所有探索者。'
      };
      state.activePlayerId = 'p2';
      state.activeActorId = 'p2';
      state.players.p2.customProps.attacksLeft = 1;
      return state;
    }
  },

  haunt_werewolf: {
    description: '剧本 5「月圆狂兽」：叛徒化为嗜血狼人，英雄需铸造银弹或压制月相。',
    setup: seed => {
      const state = setupBetrayal(seed);
      addExploredRoom(state, 'workshop', 1, 2, 'room_basement_landing');
      addExploredRoom(state, 'observatory', 3, 2, 'room_upper_landing');
      addExploredRoom(state, 'master_bedroom', 1, 2, 'room_upper_landing');

      setRoom(state, 'p1', 'room_workshop');
      setRoom(state, 'p2', 'room_workshop');
      setRoom(state, 'p3', 'room_observatory');

      grantItem(state, 'p2', 'revolver');
      grantItem(state, 'p3', 'candle');

      BetrayalRules.beginHaunt(state, 'p1', 'werewolf', 'room_workshop', scenarioContext());
      state.globalVars.hauntObjectives = {
        hero: '在工坊打造银弹射杀狼人；或在观星室完成 3 次月相压制仪式驱散狼人诅咒。',
        traitor: '在黎明前猎杀并撕碎所有探索者。'
      };
      state.activePlayerId = 'p2';
      state.activeActorId = 'p2';
      state.players.p2.customProps.attacksLeft = 1;
      return state;
    }
  },

  room_features: {
    description: '房间特性演示：煤槽、坍塌之室、神秘电梯与未开启的金库同场，用于验证特性交互与危险提示。',
    setup: seed => {
      const state = setupBetrayal(seed);
      addExploredRoom(state, 'coal_chute', 1, 1, 'room_basement_landing');
      addExploredRoom(state, 'the_vault', 3, 1, 'room_basement_landing');
      addExploredRoom(state, 'mystic_elevator', 1, 3, 'room_basement_landing');
      addExploredRoom(state, 'collapsed_room', 1, 3, 'room_upper_landing');
      addExploredRoom(state, 'furnace_room', 3, 3, 'room_basement_landing');

      connectRooms(state, 'room_basement_landing', 'room_coal_chute', 'DOOR');
      connectRooms(state, 'room_basement_landing', 'room_furnace_room', 'DOOR');

      setRoom(state, 'p1', 'room_the_vault');
      setRoom(state, 'p2', 'room_coal_chute');
      setRoom(state, 'p3', 'room_collapsed_room');

      // No rope on purpose: the chute should hurt, and the vault must be
      // cracked by the knowledge check rather than a skeleton key.
      grantItem(state, 'p1', 'candle');

      state.activePlayerId = 'p1';
      state.activeActorId = 'p1';
      return state;
    }
  }
};

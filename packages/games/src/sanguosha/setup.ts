import { ECSManager } from '@rds/kernel/ecs';
import { GameSetupOptions } from '@rds/kernel/module';
import { DeterministicPRNG } from '@rds/kernel/prng';
import { Entity, GameState, Player } from '@rds/kernel/types';
import { MILITARY_DECK, STANDARD_DECK, isStrikeCode } from './cards';
import { CLASSIC_HERO_IDS, GENDER_LABEL, KINGDOM_COLOR, KINGDOM_LABEL, SANGUOSHA_HEROES, SgsHero, heroById } from './heroes';
import { DECK_ZONE, DISCARD_ZONE, EQUIP_ZONE, HAND_ZONE, JUDGE_ZONE, createCardEntity, syncEquipmentHooks } from './helpers';
import type { SanguoshaMode, SgsRole, SgsSeatAssignment, SgsCardSeed } from './types';

export type SanguoshaVariant = 'classic' | 'warlords' | 'military' | 'military_warlords';

export interface SanguoshaSetupOptions extends GameSetupOptions {
  variant?: SanguoshaVariant;
  mode?: SanguoshaMode;
}

/** How many seats each table rule supports. */
export const SANGUOSHA_SEAT_LIMITS: Record<SanguoshaMode, { min: number; max: number; default: number }> = {
  identity: { min: 4, max: 8, default: 4 },
  team: { min: 4, max: 4, default: 4 },
  kill_next: { min: 2, max: 8, default: 4 }
};

const AI_TIERS: SgsSeatAssignment['aiTier'][] = ['beginner', 'intermediate', 'advanced'];

function resolveSeats(mode: SanguoshaMode, requested: number | undefined): number {
  const limits = SANGUOSHA_SEAT_LIMITS[mode];
  const value = Math.floor(Number(requested ?? limits.default));
  if (!Number.isFinite(value) || value < limits.min || value > limits.max) {
    throw new Error(`${mode} 模式不支持 ${String(requested)} 人（可用 ${limits.min}–${limits.max} 人）`);
  }
  return value;
}

/** Official identity composition for 4–8 seats; smaller/non-standard tables still
 * get a deterministic, playable role split so local experiments never crash. */
function assignRoles(mode: SanguoshaMode, count: number): SgsRole[] {
  if (mode === 'team') return Array.from({ length: count }, (_, index) => (index % 2 === 0 ? 'TEAM_A' : 'TEAM_B'));
  if (mode === 'kill_next') return Array.from({ length: count }, () => 'KILL_NEXT');

  const spy = count >= 3 ? 1 : 0;
  const loyalists = count >= 7 ? 2 : count >= 4 ? 1 : 0;
  const rebels = Math.max(0, count - 1 - spy - loyalists);
  return [
    'LORD',
    ...Array.from({ length: loyalists }, () => 'LOYALIST' as const),
    ...Array.from({ length: rebels }, () => 'REBEL' as const),
    ...(spy ? ['SPY' as const] : [])
  ];
}

function assignHeroes(variant: SanguoshaVariant, seed: number, count: number): { heroes: SgsHero[]; nextSeed: number } {
  const classicDeck = variant === 'classic' || variant === 'military';
  if (classicDeck && count === CLASSIC_HERO_IDS.length) {
    return {
      heroes: CLASSIC_HERO_IDS.map(id => heroById(id) ?? SANGUOSHA_HEROES[0]),
      nextSeed: seed
    };
  }
  const pool = [...SANGUOSHA_HEROES];
  const { result, nextSeed } = DeterministicPRNG.shuffle(seed, pool);
  return { heroes: result.slice(0, count), nextSeed };
}

function makePlayer(
  pid: string,
  hero: SgsHero,
  role: SgsRole,
  seatIndex: number,
  isAi: boolean,
  aiTier?: SgsSeatAssignment['aiTier']
): Player {
  const maxHp = hero.maxHp + (role === 'LORD' ? 1 : 0);
  return {
    id: pid,
    name: hero.name,
    color: KINGDOM_COLOR[hero.kingdom],
    avatar: hero.avatar,
    score: maxHp,
    alive: true,
    isAI: isAi,
    role,
    secretRole: role,
    handZoneId: HAND_ZONE(pid),
    customProps: {
      hp: maxHp,
      maxHp,
      points: 0,
      heroId: hero.id,
      heroName: hero.name,
      kingdom: hero.kingdom,
      kingdomLabel: KINGDOM_LABEL[hero.kingdom],
      gender: hero.gender,
      genderLabel: GENDER_LABEL[hero.gender],
      skills: hero.skills.map(skill => skill.id),
      skillNames: hero.skills.map(skill => `${skill.name}（${skill.kind === 'LORD' ? '主公技' : skill.kind === 'PASSIVE' ? '锁定技' : skill.kind === 'TRIGGERED' ? '触发技' : '主动技'}）`),
      lordSkills: hero.skills.filter(skill => skill.kind === 'LORD').map(skill => skill.id),
      strikesUsed: 0,
      chained: false,
      skipPlay: false,
      skipDraw: false,
      wineBonus: 0,
      wineUsed: false,
      seatIndex,
      isAi,
      ...(aiTier ? { aiTier } : {})
    }
  };
}

function seatPosition(index: number, seats: number): [number, number, number] {
  const rx = seats <= 4 ? 8.9 : seats <= 6 ? 10.4 : 11.6;
  const rz = seats <= 4 ? 5.6 : seats <= 6 ? 6.4 : 7.0;
  const angle = Math.PI / 2 + (index * Math.PI * 2) / seats;
  return [Math.cos(angle) * rx, 0.1, Math.sin(angle) * rz];
}

function seatGraph(playerOrder: string[], seats: number) {
  const nodes = Object.fromEntries(
    playerOrder.map((pid, index) => {
      const previous = playerOrder[(index - 1 + playerOrder.length) % playerOrder.length];
      const next = playerOrder[(index + 1) % playerOrder.length];
      return [
        `seat_${pid}`,
        {
          id: `seat_${pid}`,
          type: 'SEAT' as const,
          position: seatPosition(index, seats),
          positionSpace: 'world' as const,
          neighbors: [...new Set([previous, next].map(id => `seat_${id}`))],
          props: { playerId: pid, seatIndex: index }
        }
      ];
    })
  );
  return {
    nodes,
    edges: {},
    topology: {
      kind: 'ring' as const,
      adjacency: 'neighbors' as const,
      geometry: 'ring' as const,
      geometrySpec: {
        radiusX: seats <= 4 ? 8.9 : seats <= 6 ? 10.4 : 11.6,
        radiusZ: seats <= 4 ? 5.6 : seats <= 6 ? 6.4 : 7.0,
        origin: [0, 0.1, 0] as [number, number, number]
      }
    }
  };
}

/**
 * Deal a table for any supported mode and seat count.
 *
 * `humans` / `aiSeats` use the same kernel contract as Poker:
 * seat order is always humans first, then AI fillers. Hosted rooms pass both;
 * tests and local hot-seat tables omit them and get all-human seats.
 */
export function setupSanguosha(seed = 42, options: SanguoshaSetupOptions = {}): GameState {
  const variant = options.variant ?? 'classic';
  // Tables below four seats cannot satisfy an identity split. The lobby may
  // create such a room without an explicit variant (the default "标准" option);
  // in that case the only supported 2–3 seat rule is the kill-next village rule.
  const requestedMode = options.mode;
  const requestedSeats = Number(options.seats);
  const mode: SanguoshaMode =
    requestedMode ??
    (Number.isFinite(requestedSeats) && requestedSeats >= 2 && requestedSeats < 4 ? 'kill_next' : 'identity');
  const limits = SANGUOSHA_SEAT_LIMITS[mode];
  if (!limits) throw new Error(`Unknown Sanguosha mode: ${String(mode)}`);
  const seats = resolveSeats(mode, options.seats);
  if (mode === 'team' && seats !== 4) throw new Error('4人对抗固定需要 4 个座位');

  const humanCount = Math.max(1, Math.min(seats, Math.floor(Number(options.humans ?? seats))));
  const aiCount = Math.max(
    0,
    Math.min(seats - humanCount, Math.floor(Number(options.aiSeats ?? seats - humanCount)))
  );
  // Humans occupy the first seats, AI fillers the next `aiCount`. A caller that
  // passes only `seats` therefore gets an all-human table; a room passes both
  // counts and gets exactly the split the host configured.
  const playerOrder = Array.from({ length: seats }, (_, index) => `p${index + 1}`);

  const military = variant === 'military' || variant === 'military_warlords';
  const heroAssignment = assignHeroes(variant, seed, seats);
  let prngState = heroAssignment.nextSeed;

  const roleOrder = assignRoles(mode, seats);
  const players: Record<string, Player> = {};
  const seatAssignments: SgsSeatAssignment[] = [];
  playerOrder.forEach((pid, index) => {
    const isAi = index >= humanCount && index < humanCount + aiCount;
    const aiTier = isAi ? AI_TIERS[(index - humanCount) % AI_TIERS.length] : undefined;
    players[pid] = makePlayer(
      pid,
      heroAssignment.heroes[index] ?? SANGUOSHA_HEROES[index % SANGUOSHA_HEROES.length],
      roleOrder[index] ?? 'KILL_NEXT',
      index,
      isAi,
      aiTier
    );
    seatAssignments.push({ playerId: pid, isAi, ...(aiTier ? { aiTier } : {}) });
  });

  let state: GameState = {
    gameId: 'sanguosha',
    seed,
    seq: 0,
    clock: 0,
    round: 1,
    turn: 1,
    activePlayerId: 'p1',
    phase: 'PLAY',
    players,
    playerOrder,
    entities: {},
    zones: {},
    mapGraph: seatGraph(playerOrder, seats),
    globalVars: {
      drawDeckCount: 0,
      hasPlayedStrikeThisTurn: false,
      wuxieCount: 0,
      turnOwner: 'p1',
      mode,
      variant,
      playerCount: seats,
      seats: seatAssignments
    },
    interruptStack: [],
    pendingDecisions: [],
    activeHooks: [],
    prngState,
    actionLog: [],
    winner: null,
    gameOver: false
  };

  state = ECSManager.createZone(state, DECK_ZONE, '牌堆', 'DECK', { type: 'HIDDEN' }, undefined, 'STACK', [-7.4, 0.06, -5.2]);
  state = ECSManager.createZone(state, DISCARD_ZONE, '弃牌堆', 'DISCARD', { type: 'PUBLIC' }, undefined, 'STACK', [-5.5, 0.06, -5.2]);
  state = ECSManager.createZone(state, 'zone_judge_public', '判定展示区', 'JUDGE', { type: 'PUBLIC' }, undefined, 'ROW', [0, 0.06, -6.2]);

  playerOrder.forEach(pid => {
    state = ECSManager.createZone(state, HAND_ZONE(pid), `${players[pid].name} 手牌`, 'HAND', { type: 'OWNER_ONLY', ownerId: pid }, pid, 'FAN');
    state = ECSManager.createZone(state, EQUIP_ZONE(pid), `${players[pid].name} 装备`, 'EQUIP', { type: 'PUBLIC' }, pid, 'ROW');
    state = ECSManager.createZone(state, JUDGE_ZONE(pid), `${players[pid].name} 判定区`, 'JUDGE', { type: 'PUBLIC' }, pid, 'ROW');
  });

  const deckSeeds = [...STANDARD_DECK, ...(military ? MILITARY_DECK : [])];
  const shuffled = DeterministicPRNG.shuffle(prngState, deckSeeds);
  prngState = shuffled.nextSeed;
  const pool = [...shuffled.result];

  const takeBy = (predicate: (card: SgsCardSeed) => boolean): SgsCardSeed | null => {
    const index = pool.findIndex(predicate);
    if (index < 0) return null;
    return pool.splice(index, 1)[0] ?? null;
  };

  // Demo-friendly opening: seat 1 gets one Strike and one Bagua so the first
  // screen always has a legal attack and an armour reaction. This is a fixture
  // deal, not a claim about random distribution; documented in SANGUOSHA.md.
  const baguaSeed = takeBy(card => card.code === 'bagua');
  const guaranteedStrike = takeBy(card => isStrikeCode(card.code));

  const hands: Record<string, SgsCardSeed[]> = {};
  for (const pid of playerOrder) {
    // Seat one keeps the demo card (Strike + Bagua), so it draws three random
    // cards and then receives the guaranteed Strike; every other seat draws four.
    hands[pid] = pool.splice(0, pid === 'p1' ? 3 : 4);
  }
  if (guaranteedStrike) hands.p1.unshift(guaranteedStrike);

  let cardCounter = 0;
  const nextId = (): string => `sgs_card_${String(cardCounter++).padStart(3, '0')}`;

  if (baguaSeed) {
    const bagua: Entity = createCardEntity(nextId(), baguaSeed, EQUIP_ZONE('p1'), 'p1');
    state = ECSManager.addEntity(state, bagua);
  }

  playerOrder.forEach(pid => {
    for (const seedCard of hands[pid]) {
      const entity = createCardEntity(nextId(), seedCard, HAND_ZONE(pid), pid);
      state = ECSManager.addEntity(state, entity);
    }
  });

  for (const seedCard of pool) {
    const entity = createCardEntity(nextId(), seedCard, DECK_ZONE);
    state = ECSManager.addEntity(state, entity);
  }

  state = {
    ...state,
    globalVars: {
      ...state.globalVars,
      drawDeckCount: state.zones[DECK_ZONE]?.orderedEntities.length ?? 0
    },
    prngState
  };
  state = syncEquipmentHooks(state);
  return state;
}

export function sanguoshaScenario(
  variant: SanguoshaVariant,
  mode: SanguoshaMode = 'identity',
  fixedSeats?: number
) {
  return (seed: number, options?: GameSetupOptions): GameState =>
    setupSanguosha(seed, {
      ...(options ?? {}),
      variant,
      mode,
      ...(fixedSeats === undefined ? {} : { seats: fixedSeats })
    });
}

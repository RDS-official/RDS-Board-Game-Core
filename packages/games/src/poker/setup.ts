import { ECSManager } from '@rds/kernel/ecs';
import { DeterministicPRNG } from '@rds/kernel/prng';
import type { GameState, Player } from '@rds/kernel/types';
import { deckEntity, fullDeck } from './cards';

/**
 * Texas Hold'em table setup.
 *
 * The kernel only ever calls `setup(seed)`, so the seat count is baked into a
 * closure: the registry exposes `seats_2` … `seats_10` scenarios plus a
 * short-stacked variant used by the matrix/UI tests to reach the end condition.
 */

export interface PokerConfig {
  seats: number;
  /** Chips each seat starts with. */
  startingStack?: number;
  smallBlind?: number;
  bigBlind?: number;
  /** Per-seat overrides (length may be shorter than `seats`). */
  stacks?: number[];
}

export const POKER_LIMITS = { minSeats: 2, maxSeats: 10 } as const;
export const POKER_DEFAULTS = { startingStack: 1000, smallBlind: 5, bigBlind: 10 } as const;

const SEAT_COLORS = [
  '#e0604e',
  '#4ec9b0',
  '#e3b341',
  '#6aa6f5',
  '#b07bf0',
  '#57c08b',
  '#ef8fc7',
  '#8b93a1',
  '#f0a35e',
  '#5bc8d8'
];

const SEAT_AVATARS = ['♠️', '♥️', '♦️', '♣️', '🃏', '🎴', '🂡', '🂱', '🃑', '🃁'];

export function clampSeats(seats: number): number {
  return Math.min(POKER_LIMITS.maxSeats, Math.max(POKER_LIMITS.minSeats, Math.floor(seats)));
}

/** Ellipse radii for a table with `seats` players; keeps 10 seats from colliding. */
export function tableRadii(seats: number): { rx: number; rz: number } {
  const rx = seats <= 2 ? 5.8 : seats <= 4 ? 7.8 : seats <= 6 ? 9.4 : seats <= 8 ? 10.4 : 11.2;
  return { rx, rz: rx * 0.58 };
}

/**
 * World-space seat position.
 *
 * `positionSpace: 'ring'` is *not* used here: the renderer projects ring
 * coordinates in fixed 90° steps, which only fits four seats. Seat nodes carry
 * explicit world coordinates instead, so 2–10 players all land on the ellipse.
 */
export function seatPosition(seatIndex: number, seats: number): [number, number, number] {
  const { rx, rz } = tableRadii(seats);
  const angle = Math.PI / 2 + (seatIndex * Math.PI * 2) / seats;
  return [Math.cos(angle) * rx, 0.1, Math.sin(angle) * rz];
}

function createPlayer(seatIndex: number, stack: number): Player {
  const id = `p${seatIndex + 1}`;
  return {
    id,
    name: `玩家 ${seatIndex + 1}`,
    color: SEAT_COLORS[seatIndex % SEAT_COLORS.length],
    avatar: SEAT_AVATARS[seatIndex % SEAT_AVATARS.length],
    score: stack,
    alive: true,
    handZoneId: `zone_hand_${id}`,
    customProps: {
      seat: seatIndex,
      chips: stack,
      inHand: false,
      folded: false,
      allIn: false,
      busted: false
    }
  };
}

export function setupPoker(seed = 42, config: PokerConfig = { seats: 4 }): GameState {
  const seats = clampSeats(config.seats);
  const startingStack = config.startingStack ?? POKER_DEFAULTS.startingStack;
  const smallBlind = config.smallBlind ?? POKER_DEFAULTS.smallBlind;
  const bigBlind = config.bigBlind ?? POKER_DEFAULTS.bigBlind;

  const playerOrder = Array.from({ length: seats }, (_, index) => `p${index + 1}`);
  const players: Record<string, Player> = {};
  playerOrder.forEach((pid, index) => {
    players[pid] = createPlayer(index, config.stacks?.[index] ?? startingStack);
  });

  const nodes: GameState['mapGraph']['nodes'] = {};
  playerOrder.forEach((pid, index) => {
    nodes[`seat_${pid}`] = {
      id: `seat_${pid}`,
      type: 'SEAT',
      position: seatPosition(index, seats),
      neighbors: [
        `seat_${playerOrder[(index + 1) % seats]}`,
        `seat_${playerOrder[(index - 1 + seats) % seats]}`
      ],
      props: { playerId: pid, seatIndex: index, name: players[pid].name }
    };
  });

  const { rx, rz } = tableRadii(seats);
  let state: GameState = {
    gameId: 'poker',
    seed,
    seq: 0,
    clock: 0,
    round: 1,
    turn: 1,
    activePlayerId: playerOrder[0],
    phase: 'HAND_OVER',
    players,
    playerOrder,
    entities: {},
    zones: {},
    mapGraph: {
      nodes,
      edges: {},
      topology: {
        kind: 'ring',
        adjacency: 'neighbors',
        geometry: 'ring',
        geometrySpec: { radiusX: rx, radiusZ: rz, origin: [0, 0.1, 0] }
      }
    },
    globalVars: {
      config: { startingStack, smallBlind, bigBlind },
      hand: {
        handNo: 0,
        street: 'COMPLETE',
        // The first START_HAND advances the button onto seat 0.
        buttonSeat: seats - 1,
        sbSeat: 0,
        bbSeat: Math.min(1, seats - 1),
        pot: 0,
        currentBet: 0,
        lastRaiseSize: bigBlind,
        bigBlind,
        streetBets: Object.fromEntries(playerOrder.map(pid => [pid, 0])),
        handBets: Object.fromEntries(playerOrder.map(pid => [pid, 0])),
        actedSinceRaise: [],
        folded: [],
        allIn: [],
        community: [],
        lastAggressor: null
      },
      lastHand: null,
      log: [`牌局开始 · 盲注 ${smallBlind} / ${bigBlind} · 每人 ${startingStack} 筹码`]
    },
    interruptStack: [],
    pendingDecisions: [],
    activeHooks: [],
    prngState: seed,
    actionLog: [],
    winner: null,
    gameOver: false
  };

  // The board sits dead centre. The renderer offsets plain BOARD zones by
  // +0.85 on z, so the anchor is pulled back by the same amount.
  state = ECSManager.createZone(state, 'zone_board', '公共牌', 'BOARD', { type: 'PUBLIC' }, undefined, 'ROW', [0, 0.16, -0.85]);
  state = ECSManager.createZone(state, 'zone_deck', '牌堆', 'DECK', { type: 'HIDDEN' }, undefined, 'STACK', [-6.0, 0.06, -2.2]);
  state = ECSManager.createZone(state, 'zone_burn', '烧牌', 'DISCARD', { type: 'HIDDEN' }, undefined, 'STACK', [-6.0, 0.06, 0]);
  state = ECSManager.createZone(state, 'zone_muck', '弃牌', 'DISCARD', { type: 'HIDDEN' }, undefined, 'STACK', [-6.0, 0.06, 2.2]);

  playerOrder.forEach((pid, index) => {
    const [x, , z] = seatPosition(index, seats);
    state = ECSManager.createZone(
      state,
      `zone_hand_${pid}`,
      `${players[pid].name} 底牌`,
      'HAND',
      { type: 'OWNER_ONLY', ownerId: pid },
      pid,
      'FAN',
      [x * 0.82, 0.12, z * 0.82]
    );
  });

  for (const card of fullDeck()) {
    state = ECSManager.addEntity(state, deckEntity(card, 'zone_deck'));
  }

  // Deterministic shuffle: the deck order is the only randomness in setup.
  const shuffled = DeterministicPRNG.shuffle(state.prngState, state.zones.zone_deck.orderedEntities);
  state = {
    ...state,
    prngState: shuffled.nextSeed,
    zones: {
      ...state.zones,
      zone_deck: { ...state.zones.zone_deck, orderedEntities: shuffled.result }
    }
  };

  return state;
}

/** Named seat-count scenarios (the kernel's `setup` only receives a seed). */
export function pokerScenario(seats: number, overrides: Partial<PokerConfig> = {}) {
  return (seed: number): GameState => setupPoker(seed, { seats, ...overrides });
}

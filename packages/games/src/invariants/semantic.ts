/**
 * 各模组的语义不变量（宪章 C-6）。
 *
 * 内核的 `invariants.ts` 只保证状态**形状**没坏；这里保证**规则没被违反**。
 * 每条都挑该模组最有价值的那个守恒/一致性，而不是凑数量。
 */

import type { GameState } from '@rds/kernel/types';
import { MASTER_BALL, MASTER_BALL_SUPPLY, POKEBALL_COLORS, TOKEN_SUPPLY_BY_PLAYERS } from '@rds/games/splendor/setup';

/* -------------------------------------------------------------------------- */
/* catan：资源供给不超发                                                        */
/* -------------------------------------------------------------------------- */

const CATAN_RESOURCES = ['wood', 'brick', 'sheep', 'wheat', 'ore'] as const;

/**
 * 玩家手上的资源 + 银行库存不得超过初始供给（每种 19）。
 *
 * 卡坦里资源只会转移，建造成本会真正消耗，所以是**上界**而非等式：
 * 超过 19 说明有地方凭空造了牌。
 */
export function checkCatanInvariants(state: GameState): string[] {
  const out: string[] = [];
  const bank = (state.globalVars.bank ?? {}) as Record<string, unknown>;

  for (const res of CATAN_RESOURCES) {
    let held = 0;
    for (const pid of state.playerOrder) {
      const bag = (state.players[pid]?.customProps?.resources ?? {}) as Record<string, unknown>;
      const n = Number(bag[res] ?? 0);
      if (!Number.isFinite(n) || n < 0) {
        out.push(`catan: ${pid} holds an invalid amount of ${res} (${bag[res]})`);
        continue;
      }
      held += n;
    }
    const banked = Number(bank[res] ?? 0);
    if (!Number.isFinite(banked) || banked < 0) {
      out.push(`catan: bank has an invalid amount of ${res} (${bank[res]})`);
      continue;
    }
    if (held + banked > 19) {
      out.push(`catan: ${res} supply exceeded — ${held} held + ${banked} in bank = ${held + banked} > 19`);
    }
  }

  for (const pid of state.playerOrder) {
    const score = Number(state.players[pid]?.score ?? 0);
    if (!Number.isFinite(score) || score < 0) out.push(`catan: ${pid} has an invalid score (${score})`);
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* splendor：宝可球守恒                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 玩家手上的球 + 银行里的球 = 初始供给。
 *
 * 与卡坦不同，球**只会转移不会消耗**（买卡的球变成折扣，不是消失），
 * 因此这里用等式。
 */
export function checkSplendorInvariants(state: GameState): string[] {
  const out: string[] = [];
  const bank = (state.globalVars.bank ?? {}) as Record<string, unknown>;
  const colors = Object.keys(bank);
  if (colors.length === 0) return out;

  for (const color of colors) {
    const banked = Number(bank[color] ?? 0);
    if (!Number.isFinite(banked) || banked < 0) {
      out.push(`splendor: bank has an invalid amount of ${color} (${bank[color]})`);
      continue;
    }
    let held = 0;
    for (const pid of state.playerOrder) {
      const n = Number(state.players[pid]?.customProps?.tokens?.[color] ?? 0);
      if (!Number.isFinite(n) || n < 0) {
        out.push(`splendor: ${pid} holds an invalid amount of ${color} (${n})`);
        continue;
      }
      held += n;
    }
    // 供给量随人数变化，从初始化时的 "bank + 所有玩家" 推出基准值。
    const total = held + banked;
    const cap = SPLENDOR_CAP[color];
    if (cap !== undefined && total > cap) {
      out.push(`splendor: ${color} supply exceeded — ${held} held + ${banked} in bank = ${total} > ${cap}`);
    }
  }

  for (const pid of state.playerOrder) {
    const score = Number(state.players[pid]?.score ?? 0);
    if (!Number.isFinite(score) || score < 0) out.push(`splendor: ${pid} has an invalid score (${score})`);
  }

  return out;
}

/** 每种球在任何人数下的最大供给 —— 直接引用初始化常量，避免两份数字打架。 */
const SPLENDOR_CAP: Record<string, number> = (() => {
  const caps: Record<string, number> = {};
  const maxPerColor = Math.max(...Object.values(TOKEN_SUPPLY_BY_PLAYERS));
  for (const color of POKEBALL_COLORS) {
    caps[color] = color === MASTER_BALL ? MASTER_BALL_SUPPLY : maxPerColor;
  }
  return caps;
})();

/* -------------------------------------------------------------------------- */
/* sanguosha：血量边界                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 体力必须在 `[0, maxHp]` 且都是整数。
 *
 * 扣血没下限会让角色"负血存活"，加血没上限会让桃把人喂成无敌。
 */
export function checkSanguoshaInvariants(state: GameState): string[] {
  const out: string[] = [];
  for (const pid of state.playerOrder) {
    const props = (state.players[pid]?.customProps ?? {}) as Record<string, unknown>;
    const hp = Number(props.hp ?? 0);
    const maxHp = Number(props.maxHp ?? 0);
    if (!Number.isInteger(maxHp) || maxHp <= 0) {
      out.push(`sanguosha: ${pid} has an invalid maxHp (${props.maxHp})`);
      continue;
    }
    if (!Number.isInteger(hp)) {
      out.push(`sanguosha: ${pid} has a non-integer hp (${props.hp})`);
      continue;
    }
    if (hp < 0) out.push(`sanguosha: ${pid} has negative hp (${hp})`);
    if (hp > maxHp) out.push(`sanguosha: ${pid} has hp ${hp} above maxHp ${maxHp}`);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* dune_mahjong：兵力与押注                                                     */
/* -------------------------------------------------------------------------- */

/** 兵力/香料非负，且押注不超出手上兵力。 */
export function checkDuneInvariants(state: GameState): string[] {
  const out: string[] = [];
  const dials = (state.globalVars.committedDials ?? {}) as Record<string, { troops?: unknown } | undefined>;

  for (const pid of state.playerOrder) {
    const props = (state.players[pid]?.customProps ?? {}) as Record<string, unknown>;
    if ('troops' in props) {
      const troops = Number(props.troops);
      if (!Number.isFinite(troops) || troops < 0) {
        out.push(`dune: ${pid} has an invalid troop count (${props.troops})`);
      }
    }
    if ('spice' in props) {
      const spice = Number(props.spice);
      if (!Number.isFinite(spice) || spice < 0) {
        out.push(`dune: ${pid} has an invalid spice amount (${props.spice})`);
      }
    }
    const dial = dials[pid];
    if (dial) {
      const bet = Number(dial.troops ?? 0);
      const held = Number(props.troops ?? 0);
      if (!Number.isFinite(bet) || bet < 0) {
        out.push(`dune: ${pid} committed an invalid troop dial (${dial.troops})`);
      } else if (bet > held) {
        out.push(`dune: ${pid} committed ${bet} troops but only holds ${held}`);
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* betrayal：属性与位置一致性                                                    */
/* -------------------------------------------------------------------------- */

const BETRAYAL_TRAITS = ['might', 'speed', 'knowledge', 'sanity'] as const;

/** 属性值是整数；角色所在房间必须存在。 */
export function checkBetrayalInvariants(state: GameState): string[] {
  const out: string[] = [];

  for (const pid of state.playerOrder) {
    const props = (state.players[pid]?.customProps ?? {}) as Record<string, unknown>;
    const traits = (props.traits ?? null) as Record<string, unknown> | null;
    if (traits && typeof traits === 'object') {
      for (const key of BETRAYAL_TRAITS) {
        if (!(key in traits)) continue;
        const value = Number(traits[key]);
        if (!Number.isInteger(value)) {
          out.push(`betrayal: ${pid} has a non-integer ${key} (${String(traits[key])})`);
        }
      }
    }
    const roomId = props.currentRoomId;
    if (typeof roomId === 'string' && roomId.length > 0 && !state.mapGraph.nodes[roomId]) {
      out.push(`betrayal: ${pid} is in a room that does not exist (${roomId})`);
    }
  }

  return out;
}

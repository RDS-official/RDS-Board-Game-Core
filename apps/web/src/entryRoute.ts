/**
 * 入口路由契约：URL 上的网络对局参数（`hub/roomId/token/playerId`）是进入
 * 牌桌的**唯一**深链形式，但它永远不能绕过登录。
 *
 * 这条约束是入口逻辑的防线，而不是可选的优化：
 *  - 外壳进牌桌前必须确认本浏览器**已经登录**、URL 里的 token 就是本机持有的
 *    那个会话、服务端仍认它，并且玩家确实还在这场房间里。否则过期/伪造/
 *    分享出去的 token，或上一次对局残留在地址栏里的参数，都会把玩家直接塞
 *    进一张死桌，登录页被整个跳过；
 *  - 登录成功与登出一律回到「选择游戏 / 快速加入」首页，并清掉地址栏里残留的
 *    对局参数，避免刷新或重新打开时又被当成深链弹进牌桌。
 */

/** 判定「这是一次深链进桌」的最小参数集，缺一不可。 */
export const NET_KEYS = ['hub', 'roomId', 'token', 'playerId'] as const;

/** 网络对局参数全集：清地址栏时一并抹掉，避免半套参数残留。 */
const NET_PARAM_KEYS: readonly string[] = [
  ...NET_KEYS,
  'room',
  'player',
  'role',
  'authority',
  'hostId',
  'host',
  'scenario',
  'seats',
  'roster',
  'owners',
  'game'
];

export interface NetEntry {
  /** 规范化后的 query（不含前导 `?`），可直接交给 enterGameView。 */
  query: string;
  token: string;
  roomId: string;
}

/** 一次深链进桌的形状判定；参数不全就不是深链，走大厅。 */
export function netEntryOf(search: string): NetEntry | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (!NET_KEYS.every(key => params.get(key))) return null;
  return {
    query: params.toString(),
    token: params.get('token') ?? '',
    roomId: params.get('roomId') ?? ''
  };
}

/** 本浏览器持有的会话 token（隐私模式下 localStorage 会抛，按未登录处理）。 */
export function localToken(): string | null {
  try {
    return localStorage.getItem('token');
  } catch {
    return null;
  }
}

async function getJson<T>(path: string, token: string, timeoutMs = 2500): Promise<T | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface MeBody { id?: unknown }
interface RoomBody { status?: unknown; players?: Array<{ id?: unknown }> }

/**
 * 这次深链是否值得放行。
 *
 * 四条都要过：
 *  1. 本浏览器**已经登录**（localStorage 有 token）——首次进入永远是登录页，
 *     邀请链接不能替访客完成登录；
 *  2. URL 里的 token 就是本机持有的那个会话——挡住分享出去的链接带着别人的 token；
 *  3. 服务端仍认这个会话——账号被删/禁用、改密后的旧 token 签名依旧「看起来」
 *     有效，只有 `/api/me` 回查能判死；
 *  4. 这场房间还在，且玩家确实在房里——挡住刷新/收藏夹里那场早就散了的对局。
 *
 * 任一条件不满足就当没带参数，退回大厅入口（未登录时即登录页）。
 * 超时一律按失败处理：宁可在登录页多点一次，也不把人塞进死桌。
 */
export async function canEnterNetGame(entry: NetEntry): Promise<boolean> {
  const local = localToken();
  if (!local || local !== entry.token) return false;

  const me = await getJson<MeBody>('/api/me', local);
  if (!me || typeof me.id !== 'string' || !me.id) return false;

  const room = await getJson<RoomBody>(`/api/rooms/${encodeURIComponent(entry.roomId)}`, local);
  if (!room || room.status === 'closed') return false;
  const players = Array.isArray(room.players) ? room.players : [];
  return players.some(player => player?.id === me.id);
}

/**
 * 把地址栏里的对局参数抹掉（保持路径与 hash 不变）。
 *
 * 大厅首页、登录成功、登出三处都会调用：没有这一步，进过牌桌之后地址栏就
 * 永久带着 `hub/roomId/token/playerId`，刷新即被外壳当成深链重新弹进牌桌。
 */
export function stripNetParamsFromUrl(): void {
  try {
    const url = new URL(location.href);
    let dirty = false;
    for (const key of [...url.searchParams.keys()]) {
      if (!NET_PARAM_KEYS.includes(key)) continue;
      url.searchParams.delete(key);
      dirty = true;
    }
    if (dirty) history.replaceState(null, '', url.toString());
  } catch {
    // 畸形 URL 不该阻断入口：清不掉就按原样继续，入口判定不依赖这一步。
  }
}

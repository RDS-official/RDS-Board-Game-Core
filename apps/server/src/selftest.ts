/** M1 自检：不依赖浏览器，直接调用各模块断言核心行为。 */
// 数据隔离：自检必须在一次性临时目录里跑（部署机 data/ 软链到生产数据，
// `pnpm test:server` 若不隔离会把 tester 用户/测试房间写进线上库）。
// 因此必须先设好 HUB_DATA_DIR 再动态 import 业务模块（静态 import 会在本行之前求值）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
process.env.HUB_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'rds-selftest-'));
// 自检不能依赖「默认口令」：管理员口令在导入业务模块前换成一次性随机值，
// 既跑通登录链路，又顺带证明默认口令即使存在也不再被信任（issue #228）。
const ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
// ---- 旧版 JSON 迁移夹具：必须在「导入业务模块」之前落盘，迁移才会在导入时执行 ----
const legacyDir = process.env.HUB_DATA_DIR!;
const legacyUser = { id: 'u_legacy_probe', name: 'legacy_probe', passHash: 'x', salt: 'y', createdAt: 1 };
const legacyRoom = {
  id: 'r_legacy_probe', name: '旧房间', gameId: 'poker', hostId: 'u_legacy_probe',
  status: 'open', maxPlayers: 4, players: [], createdAt: 1
};
fs.writeFileSync(path.join(legacyDir, 'hub.json'), JSON.stringify({ users: [legacyUser], rooms: [legacyRoom] }));
fs.writeFileSync(
  path.join(legacyDir, 'poker-ledger.json'),
  JSON.stringify({ version: 1, accounts: { u_legacy_probe: { userId: 'u_legacy_probe', chips: 777, peakChips: 900, career: {} } } })
);
const {
  register, login, verifyJwt, userFromAuthHeader, createUser, isAdminUser, changeOwnPassword,
  adminListUsers, adminUpdateUser, adminResetPassword, adminDeleteUser, profileOf
} = await import('./auth.ts');
const { createRoom, joinRoom, listRooms, setRoomStatus, setReady, kickPlayer, transferHost, getRoomInfo, leaveRoom, seatedPlayers, setAiSeats } = await import('./rooms.ts');
const { GAMES } = await import('./games.ts');
const { GAME_REGISTRY } = await import('@rds/games/registry');
const { MatchManager } = await import('./match.ts');
const { app } = await import('./index.ts');
const { settleHand, takeSeat, leaveSeat } = await import('./pokerSettle.ts');
const { accountOf, peekAccount, updateAccount } = await import('./pokerLedger.ts');
const { rankAccounts } = await import('./pokerLeaderboard.ts');
const { getAiHeroName } = await import('@rds/games/poker/seating');
const { settleSanguosha } = await import('./sanguoshaSettle.ts');

let failed = 0;
const ok = (cond: boolean, name: string) => { if (!cond) { failed++; console.error('FAIL', name); } else console.log('ok -', name); };

/* -------------------------------------------------------------------------- */
/* 旧版 JSON（hub.json / poker-ledger.json）→ SQLite 一次性迁移                    */
/* -------------------------------------------------------------------------- */
{
  const storage = await import('./storage.ts');
  const ledger = await import('./pokerLedger.ts');
  ok(storage.users.byId('u_legacy_probe')?.name === 'legacy_probe', 'legacy hub.json users land in SQLite');
  ok(storage.rooms.byId('r_legacy_probe')?.name === '旧房间', 'legacy hub.json rooms land in SQLite');
  ok(ledger.peekAccount('u_legacy_probe').chips === 777, 'legacy poker-ledger.json accounts land in SQLite');
  ok(fs.existsSync(path.join(legacyDir, 'hub.sqlite')), 'the database file lives in DATA_DIR');
  const leftovers = fs
    .readdirSync(legacyDir)
    .filter(f => f.startsWith('hub.json.imported.') || f.startsWith('poker-ledger.json.imported.'));
  ok(leftovers.length === 2, 'the legacy json files are renamed (kept as backup), not deleted');
  // 清场：夹具不能污染后面的账号 / 房间 / 排行榜断言。
  storage.users.remove('u_legacy_probe');
  storage.rooms.remove('r_legacy_probe');
  ledger.removeAccount('u_legacy_probe');
}

// ---- 管理员自检：口令来自 env 里的随机值，不是仓库里的默认值 ----
const adminLogin: any = await login('rds', ADMIN_PASSWORD);
ok(adminLogin.token && adminLogin.user.name === 'rds' && adminLogin.user.role === 'admin', 'admin rds login works');
ok(isAdminUser(verifyJwt(adminLogin.token)), 'admin rds has admin privileges');
ok((await login('rds', 'wrong_pass') as any).error, 'admin wrong password rejected');
ok((await login('rds', 'kgnb666') as any).error, 'the old default password is not accepted');

// ---- 注册功能已关闭断言 ----
const regClosed: any = register('new_user_' + Date.now(), 'secret123');
ok(!!regClosed.error && regClosed.error.includes('注册功能已关闭'), 'public register is closed');

// ---- 管理员创建账号及管理能力断言 ----

/** 投影的 legalActions 必须属于该座位本身（中心模式：客户端只看到自己的合法动作）。 */
function HostProjectionIsSeat(state: any, seat: string): boolean {
  const players = state?.players ?? {};
  if (!(seat in players)) return false;
  const actions: any[] = Array.isArray(state?.legalActions) ? state.legalActions : [];
  return actions.every(action => (action.actorId ?? action.playerId) === seat);
}

const name = 'tester_' + Date.now();
const reg: any = createUser(name, 'secret123', { displayName: '测试员1' });
ok(reg.token && reg.user.id && reg.user.name === name, 'createUser issues token and user');
ok((createUser(name, 'secret123') as any).error, 'duplicate name rejected by createUser');
ok(verifyJwt(reg.token)?.sub === reg.user.id, 'jwt roundtrip');
// 三国杀积分：胜负双方按模块表加减，同一房间只结算一次。
const sgsScoreUser = createUser('sgs_score_' + Date.now(), 'secret123');
if ('user' in sgsScoreUser) {
  settleSanguosha('r_sgs_score', { p1: 500, p2: -500 }, ['p1'], seat => (seat === 'p1' ? sgsScoreUser.user.id : undefined));
  const afterFirst = profileOf(sgsScoreUser.user.id);
  ok(afterFirst?.sanguoshaPoints === 500 && afterFirst?.sanguoshaCareer?.wins === 1, 'sanguosha score settles a winner');
  settleSanguosha('r_sgs_score', { p1: 500, p2: -500 }, ['p1'], seat => (seat === 'p1' ? sgsScoreUser.user.id : undefined));
  ok(profileOf(sgsScoreUser.user.id)?.sanguoshaPoints === 500, 'replaying a settled room does not double-count points');
}
const login_r: any = await login(name, 'secret123');
ok(login_r.token, 'login works');
ok((await login(name, 'wrong!!') as any).error, 'wrong password rejected');

// 列表查询
const userList = adminListUsers();
ok(userList.some(u => u.name === 'rds' && u.role === 'admin'), 'admin listed in user list');
ok(userList.some(u => u.name === name), 'created user listed');

// 管理员直接重置他人密码（无需原密码）
const resetRes: any = adminResetPassword(reg.user.id, 'new_secret_888');
ok(resetRes.ok === true, 'adminResetPassword works');
ok(!!(await login(name, 'new_secret_888') as any).token, 'login with new password works');

// 令牌吊销：改密/重置后旧 token 必须立即失效（authUserFromToken 回查记录 + tokenEpoch）
ok(userFromAuthHeader('Bearer ' + reg.token) === null, 'old token rejected after admin password reset');
const reLogin: any = await login(name, 'new_secret_888');
ok(!!(userFromAuthHeader('Bearer ' + reLogin.token)?.sub), 'fresh token after reset is accepted');

// 用户自主修改密码（需校验原密码）
ok(!!(changeOwnPassword(reg.user.id, 'wrong_old', 'user_new_pass_666') as any).error, 'changeOwnPassword rejects wrong old password');
ok(!!(changeOwnPassword(reg.user.id, 'new_secret_888', '123') as any).error, 'changeOwnPassword rejects short password');
const selfChangeRes: any = changeOwnPassword(reg.user.id, 'new_secret_888', 'user_new_pass_666');
ok(selfChangeRes.ok === true, 'changeOwnPassword works with correct old password');
ok(!!(await login(name, 'user_new_pass_666') as any).token, 'login with user changed password works');
ok(userFromAuthHeader('Bearer ' + reLogin.token) === null, 'old token rejected after self password change');

// 资料与禁用更新
const updateRes: any = adminUpdateUser(reg.user.id, { displayName: '改名测试员', disabled: true }, adminLogin.user.id);
ok(updateRes.user && updateRes.user.displayName === '改名测试员' && updateRes.user.disabled === true, 'adminUpdateUser works');
ok(!!(await login(name, 'user_new_pass_666') as any).error, 'disabled user login rejected');
// 禁用账号的旧 token 同样被拒
adminUpdateUser(reg.user.id, { disabled: false }, adminLogin.user.id);
const enabledLogin: any = await login(name, 'user_new_pass_666');
adminUpdateUser(reg.user.id, { disabled: true }, adminLogin.user.id);
ok(userFromAuthHeader('Bearer ' + enabledLogin.token) === null, 'token rejected while account is disabled');
adminUpdateUser(reg.user.id, { disabled: false }, adminLogin.user.id);

// 恢复启用
adminUpdateUser(reg.user.id, { disabled: false }, adminLogin.user.id);
ok(!!(await login(name, 'user_new_pass_666') as any).token, 'enabled user login works again');

// 删除保护：不能删除系统管理员 rds
ok(!!(adminDeleteUser('u_admin_rds', adminLogin.user.id) as any).error, 'rds admin cannot be deleted');

// 房间与联机测试依赖普通测试用户
const room: any = createRoom(reg.user.id, '测试房', 'splendor');
ok(room.id && room.maxPlayers === 2, 'create room uses game maxPlayers (S9: engine fixture seats)');
const other: any = createUser(name + 'b', 'secret123');
ok((joinRoom(other.user.id, room.id) as any).players.length === 2, 'guest joins');
ok((createRoom(reg.user.id, 'x', 'nope') as any).error, 'unknown game rejected');
const st: any = setRoomStatus(reg.user.id, room.id, 'playing');
ok(st.status === 'playing', 'host sets status');
ok((setRoomStatus(other.user.id, room.id, 'open') as any).error, 'non-host cannot set status');
ok(listRooms().some((r: any) => r.id === room.id), 'room listed');
ok(GAMES.some(g => g.id === 'splendor'), 'splendor in catalog (first P2P test game)');

// ---- Phase B ----
const st2: any = setRoomStatus(reg.user.id, room.id, 'open');
ok(st2.status === 'open' && st2.readyPlayers.length === 1 && st2.readyPlayers[0] === reg.user.id, 'reopen resets host ready');
const rd: any = setReady(other.user.id, room.id, true);
ok(rd.readyPlayers.includes(other.user.id), 'guest can ready');
ok((setReady(reg.user.id + 'x', room.id, true) as any).error, 'non-member cannot ready');
const rdOff: any = setReady(other.user.id, room.id, false);
ok(!rdOff.readyPlayers.includes(other.user.id), 'guest can unready');
setReady(other.user.id, room.id, true);
const kicked: any = kickPlayer(reg.user.id, room.id, other.user.id);
ok(!kicked.players.includes(other.user.id) && !kicked.readyPlayers.includes(other.user.id), 'host kicks guest (ready cleared)');
ok((kickPlayer(other.user.id, room.id, reg.user.id) as any).error, 'non-host cannot kick');
joinRoom(other.user.id, room.id);
const th: any = transferHost(reg.user.id, room.id, other.user.id);
ok(th.hostId === other.user.id, 'host transfer');
const info: any = getRoomInfo(room.id, reg.user.id);
ok(info.code === undefined, 'code only for host'); // 已转移：原房主不再见 code
ok((getRoomInfo(room.id, other.user.id) as any).code !== undefined, 'new host sees code');
const priv: any = createRoom(reg.user.id, '私密房', 'splendor', { isPrivate: true });
ok(priv.isPrivate && typeof priv.code === 'string' && priv.code.length === 6, 'private room gets 6-char code');
ok((joinRoom(other.user.id, priv.id) as any).error, 'private join without code rejected');
ok((joinRoom(other.user.id, priv.id, 'WRONG1') as any).error, 'private join wrong code rejected');
ok((joinRoom(other.user.id, priv.id, priv.code) as any).players.length === 2, 'private join with code works');
ok(priv.maxPlayers === 2, 'create room clamps maxPlayers to fixture seats (S9)');
const scen: any = createRoom(reg.user.id, '变体房', 'betrayal', { scenarioId: 'exploration' });
ok(scen.scenarioId === 'exploration', 'scenario variant stored');
ok((createRoom(reg.user.id, 'x', 'betrayal', { scenarioId: 'nope' }) as any).error, 'unknown variant rejected');
const sgsRoom: any = createRoom(reg.user.id, '三国杀五人房', 'sanguosha', { scenarioId: 'identity_5' });
ok(sgsRoom.maxPlayers === 5, 'identity_5 room exposes five seats');
const sgsAi = setAiSeats(reg.user.id, sgsRoom.id, 4) as any;
ok(sgsAi.aiSeats === 4, 'sanguosha room accepts four AI fillers');
ok((setRoomStatus(reg.user.id, sgsRoom.id, 'playing') as any).status === 'playing', 'a one-human + four-AI identity room starts');
leaveRoom(reg.user.id, sgsRoom.id);

// 德州扑克：默认桌是「1 真人 + 5 AI」的 6 人桌（不足 6 人由 AI 补齐），
// 房间座位数跟着所选场景走。
const pokerDefault: any = createRoom(reg.user.id, '扑克默认房', 'poker');
// 默认房不限座位（可容纳 6-10 人）；不足 6 人时由内置 AI 补齐到 6。
ok(pokerDefault.maxPlayers === 10, 'poker room allows the full 2-10 range by default');
const pokerSix: any = createRoom(reg.user.id, '扑克六人房', 'poker', { scenarioId: 'seats_6' });
ok(pokerSix.maxPlayers === 6, 'poker 6-seat variant widens the room cap');
const pokerTwo: any = createRoom(reg.user.id, '扑克单挑房', 'poker', { scenarioId: 'seats_2', maxPlayers: 9 });
ok(pokerTwo.maxPlayers === 2, 'poker heads-up variant clamps the cap to 2');

// ---- 座位号是唯一权威：掉线重连 / 离开再加入都必须回到原座 ----
// 以前座位按 `players` 数组下标推导，而数组是「加入顺序」；离开者的座位号又被
// 新来的人重复占用，`seatedPlayers` 排序因此不确定 —— 重连的人被排到别人后面。
{
  const { rooms: roomStore } = await import('./storage.ts');
  const seatRoom: any = createRoom(reg.user.id, '座位房', 'poker', { maxPlayers: 10 });
  const guests = ['c', 'd', 'e'].map(suffix => (createUser(name + suffix, 'secret123') as any).user.id);
  const [u2, u3, u4] = guests;
  for (const uid of guests) joinRoom(uid, seatRoom.id);

  const seatOfUser = (uid: string) => seatedPlayers(seatRoom.id).indexOf(uid);
  ok(
    seatedPlayers(seatRoom.id).join(',') === [reg.user.id, u2, u3, u4].join(','),
    'seats start in join order'
  );
  ok(
    (getRoomInfo(seatRoom.id) as any).players.map((p: any) => p.seat).join(',') === '0,1,2,3',
    'room info exposes the authoritative seat numbers'
  );
  // 大厅拿 `seat + 1` 拼 `?playerId=pN` 与 `roster`/`owners`，必须是连续的 0..n-1，
  // 否则会出现 p6 这种建局时根本不存在的座位号。
  ok(
    (getRoomInfo(seatRoom.id) as any).players.every((p: any, i: number) => p.seat === i),
    'seat numbers are contiguous so pN always exists'
  );

  // 重连（仍在房间内）是幂等的，不会改座位。
  const remembered = seatOfUser(u2);
  joinRoom(u2, seatRoom.id);
  ok(seatOfUser(u2) === remembered, 'rejoining an existing member keeps the seat');

  // 有人离开后，新来的人不能拿走他保留的座位号。
  leaveRoom(u3, seatRoom.id);
  const newcomer = (createUser(name + 'f', 'secret123') as any).user.id;
  joinRoom(newcomer, seatRoom.id);
  ok(seatOfUser(newcomer) === 3, 'a newcomer takes the free seat, not the departed player\u2019s number');
  // 座位表本身不能出现重号：一旦重号，`seatedPlayers` 的排序就只能靠数组顺序
  // 兜底，重连的人就可能在别人前后浮动。
  const rawSeats = Object.values((roomStore.byId(seatRoom.id) as any).seatIndex ?? {}) as number[];
  ok(new Set(rawSeats).size === rawSeats.length, 'the seat table never stores the same number twice');

  // 原玩家回来必须回到原座，其他人不跟着挪。
  joinRoom(u3, seatRoom.id);
  ok(seatOfUser(u3) === 2, 'a returning player gets the original seat back');
  ok(seatOfUser(reg.user.id) === 0 && seatOfUser(u2) === 1, 'the other seats do not shift when someone returns');
  const seats = (getRoomInfo(seatRoom.id) as any).players.map((p: any) => p.seat);
  ok(new Set(seats).size === seats.length, 'no two players share a seat number');
  ok(
    (getRoomInfo(seatRoom.id) as any).players.map((p: any) => p.id).join(',') === seatedPlayers(seatRoom.id).join(','),
    'room info order matches the seats the match will deal'
  );

  // #286 之前建的房间没有 seatIndex：按玩家顺序补齐，后来的人不能跳到 p1。
  const legacy: any = createRoom(reg.user.id, '旧座位房', 'poker', { maxPlayers: 10 });
  const legacyRec: any = roomStore.byId(legacy.id);
  delete legacyRec.seatIndex;
  joinRoom(u2, legacy.id);
  ok(
    seatedPlayers(legacy.id).join(',') === [reg.user.id, u2].join(','),
    'a legacy room backfills seats in player order'
  );
}

// 大厅清单与模组注册表必须一一对应：少一个 = 能跑但开不了房，多一个 = 开房即崩（issue #236）。
{
  const listed = GAMES.map(game => game.id).sort();
  const registered = Object.keys(GAME_REGISTRY).sort();
  ok(
    listed.join(',') === registered.join(','),
    `lobby games match the registry (lobby: ${listed.join(',')} / registry: ${registered.join(',')})`
  );
}

// ---- 中心模式（服务器权威对局） ----
{
  const matches = new MatchManager();
  const host = reg.user.id;
  const guest = other.user.id;
  const match = matches.ensure({
    roomId: room.id,
    gameId: 'splendor',
    players: [
      { userId: host, name: '测试员1' },
      { userId: guest, name: '测试员2' }
    ],
    seed: 2024
  });
  ok(match.seatOf(host) === 'p1' && match.seatOf(guest) === 'p2', 'server assigns seats by room player order');

  // 两个客户端都只是读者：各自拿到自己的投影 O(s,i)
  const hostView: any = match.attach(host);
  const guestView: any = match.attach(guest);
  ok(!!hostView.state && HostProjectionIsSeat(hostView.state, 'p1'), 'host client receives its own seat projection');
  ok(!!guestView.state && HostProjectionIsSeat(guestView.state, 'p2'), 'guest client receives its own seat projection');
  ok(match.attachedUsers().length === 2, 'both clients are attached to the server match');

  // 客户端无法伪造他人身份（座位由服务器绑定，actor 必须等于自己）
  const forged = match.submit(guest, { type: 'TAKE_3_DIFF_GEMS', playerId: 'p1', payload: { gems: ['red'] } });
  ok(forged.ok === false, 'server rejects an action forging another seat');
  ok(match.revision === 0, 'forged action does not advance the server revision');

  // issue #183：AI 补位的买入必须真的进到桌上，不能被 `stacks` 的 slice 丢掉。
  // 之前只切到真人数，AI 账号被 `takeSeat` 扣过款、桌上却拿默认 1000 开局。
  {
    // 让两个 AI 的余额低于标准买入：这样「按扣款额开局」与「按夹具默认 1000
    // 开局」才可区分（默认都是 1000 时这条断言恒真，等于没测）。
    for (const ordinal of [1, 2]) {
      const aiUserId = `ai:hero:${getAiHeroName(ordinal)}`;
      accountOf(aiUserId);
      updateAccount(aiUserId, account => ({ ...account, chips: 700 }));
    }
    const aiMatch = matches.ensure({
      roomId: 'r_ai_buyin',
      gameId: 'poker',
      players: [{ userId: host, name: '测试员1' }],
      seats: 1,
      aiSeats: 2,
      seed: 7
    });
    const raw: any = aiMatch.rawState();
    const tableSeats = (raw.globalVars.seats as { playerId: string; isAi: boolean }[]) ?? [];
    const aiSeats = tableSeats.filter(seat => seat.isAi);
    ok(aiSeats.length === 2, 'two AI seats joined the table');
    for (const [index, seat] of aiSeats.entries()) {
      const chips = Number(raw.players?.[seat.playerId]?.customProps?.chips);
      const hero = getAiHeroName(1 + index);
      const charged = Number(peekAccount(`ai:hero:${hero}`).atTable?.['r_ai_buyin'] ?? 0);
      ok(charged > 0, `AI ${seat.playerId} was charged a buy-in`);
      ok(chips === charged, `AI ${seat.playerId} starts with the charged stack, not the fixture default`);
    }
    matches.close('r_ai_buyin');
  }
  // 三国杀 AI 补位：1 真人 + 3 AI，座位标记与驱动入口必须一致。
  {
    const sgsMatch = matches.ensure({
      roomId: 'r_sgs_ai',
      gameId: 'sanguosha',
      players: [{ userId: host, name: '测试员1' }],
      seats: 1,
      aiSeats: 3,
      seed: 77
    });
    const raw: any = sgsMatch.rawState();
    const tableSeats = (raw.globalVars.seats as { playerId: string; isAi: boolean }[]) ?? [];
    ok(tableSeats.filter(seat => seat.isAi).length === 3, 'sanguosha hosted room seats three AI fillers');
    ok(GAME_REGISTRY.sanguosha.driver?.isAutomated?.(raw, 'p2') === true, 'sanguosha AI seat is marked automated');
    ok(GAME_REGISTRY.sanguosha.driver?.isAutomated?.(raw, 'p1') === false, 'sanguosha human seat is not automated');
    matches.close('r_sgs_ai');
  }
  // 内核控制通道（__ 前缀）不可被客户端使用
  const control = match.submit(host, { type: '__TICK__', playerId: 'p1', payload: { ticks: 1 } });
  ok(control.ok === false, 'server rejects kernel control actions from clients');

  // 合法动作由服务器权威执行并推进 revision
  const legal = (hostView.state as any).legalActions as any[];
  const first = legal.find(a => a.type === 'TAKE_3_DIFF_GEMS') ?? legal[0];
  const accepted = match.submit(host, { ...first, playerId: 'p1' });
  ok(accepted.ok === true, 'server accepts a legal action from the seat owner');
  ok(match.revision > 0, 'accepted action advances the server revision');

  // AR-1：中心模式的虚拟别名必须是 HMAC，不能退化成 FNV 32 位。
  // 没有密钥时隐藏实体 id 可被穷举（几秒钟），德扑牌面 / 山屋房间排列会暴露。
  {
    // 用一副牌面朝下的对局观察别名：splendor 没有隐藏实体，换 poker。
    const hidden = matches.ensure({
      roomId: 'r_alias_probe',
      gameId: 'poker',
      players: [
        { userId: host, name: '测试员1' },
        { userId: guest, name: '测试员2' }
      ],
      seats: 2,
      seed: 99
    });
    // 只走公开 API：让房主开一手，牌面因此成为隐藏实体。
    const openView: any = hidden.attach(host);
    const startHand = (openView.state?.legalActions ?? []).find((a: any) => a.type === 'START_HAND');
    if (startHand) hidden.submit(host, { ...startHand, playerId: 'p1' });
    const view: any = hidden.attach(host);
    const aliasIds = Object.keys(view.state.entities ?? {}).filter((k: string) => k.startsWith('v_id_'));
    ok(aliasIds.length > 0, 'a centre-mode poker table masks hidden entities');
    ok(
      aliasIds.every((id: string) => /^v_id_[0-9a-f]{16}$/.test(id)),
      `centre-mode aliases are HMAC (16 hex), not FNV — got ${aliasIds.slice(0, 2).join(', ')}`
    );
    matches.close('r_alias_probe');
  }

  // 增量与全量都可用，且座位表稳定
  const delta: any = match.deltaFor(guest);
  ok(Array.isArray(delta.patches), 'server serves per-viewer deltas');
  ok(match.seatList().length === 2, 'seat list stays stable for the match');

  // 房间关闭 → 对局释放
  ok(matches.close(room.id) === true, 'closing a room disposes its server match');
  ok(matches.get(room.id) === undefined, 'disposed match is no longer reachable');

  // 座位数 = 房间里的真人：2 人房间的扑克桌只发 2 个座位（曾经的 bug 是发 4 个，
  // 回合卡在无人控制的 p4）。
  const duo = matches.ensure({
    roomId: 'r_duo_poker',
    gameId: 'poker',
    players: [
      { userId: host, name: '测试员1' },
      { userId: guest, name: '测试员2' }
    ],
    seats: 2,
    seed: 77
  });
  const duoState = duo.snapshotFor(host) as any;
  ok(
    duo.seatList().length === 2 && duoState.state.playerOrder.length === 2,
    'a two-player poker room is dealt exactly two seats'
  );
  ok(duoState.state.players.p3 === undefined, 'no ghost seat p3 in a two-player room');
  const duoActor = duoState.state.activePlayerId;
  ok(['p1', 'p2'].includes(duoActor), 'the first actor is a real seat');
  matches.close('r_duo_poker');

  const catanMatchFour = matches.ensure({
    roomId: 'r_catan_four',
    gameId: 'catan',
    players: [
      { userId: 'catan_seat_1', name: '卡坦1' },
      { userId: 'catan_seat_2', name: '卡坦2' },
      { userId: 'catan_seat_3', name: '卡坦3' },
      { userId: 'catan_seat_4', name: '卡坦4' }
    ],
    seats: 4,
    seed: 8
  });
  const catanMatchFourState = catanMatchFour.snapshotFor('catan_seat_1') as any;
  ok(
    catanMatchFour.seatList().length === 4 && catanMatchFourState.state.playerOrder.length === 4,
    'a four-player catan match is dealt exactly four seats'
  );
  ok(!!catanMatchFourState.state.players.p4, 'the fourth catan seat exists');
  matches.close('r_catan_four');

  // 座位区间外的请求无法发牌 → 开局失败并给出可读原因，而不是摆空座位。
  let fixedRosterRejected = false;
  try {
    matches.ensure({
      roomId: 'r_bad_catan',
      gameId: 'catan',
      players: [
        { userId: host, name: '测试员1' },
        { userId: guest, name: '测试员2' }
      ],
      seats: 2,
      seed: 5
    });
  } catch (error) {
    fixedRosterRejected = /不支持 2 人/.test(String(error));
  }
  ok(fixedRosterRejected, 'a fixed-roster game refuses to deal a mismatched seat count');

  // 大厅层面同样拦住人数不符的开局。
  const catanRoom: any = createRoom(reg.user.id, '卡坦两人房', 'catan');
  const badStart: any = setRoomStatus(reg.user.id, catanRoom.id, 'playing');
  ok(typeof badStart.error === 'string' && /3 人/.test(badStart.error), 'lobby rejects starting catan with 2 players');

  const catanFour: any = createRoom(reg.user.id, '卡坦四人房', 'catan');
  ok(catanFour.maxPlayers === 4, 'catan rooms expose four seats');
  const catanGuests = [1, 2, 3].map(index =>
    createUser(`cg${index}_${Date.now().toString(36)}`, 'secret123')
  );
  for (const guest of catanGuests) {
    if ('user' in guest) joinRoom(guest.user.id, catanFour.id);
  }
  const catanFourStart: any = setRoomStatus(reg.user.id, catanFour.id, 'playing');
  ok(
    catanFourStart.status === 'playing',
    `lobby starts a four-player catan room${catanFourStart.error ? ` (${catanFourStart.error})` : ''}`
  );

  const pokerRoom: any = createRoom(reg.user.id, '扑克两人房', 'poker');
  joinRoom(other.user.id, pokerRoom.id);
  const pokerStart: any = setRoomStatus(reg.user.id, pokerRoom.id, 'playing');
  ok(pokerStart.status === 'playing', 'lobby starts a two-player poker room');
}

// ---- 德州扑克账号账本：买入扣款、每手结算去重、全服排行 ----
{
  const matches = new MatchManager();
  const a = reg.user.id;
  const b = other.user.id;

  // 上桌 = 从余额扣买入；扣到的金额就是桌上筹码，账本不会凭空生钱。
  const before = peekAccount(a).chips;
  const charged = takeSeat(a, 1000, 'r_selftest_seat');
  ok(charged === 1000 && peekAccount(a).chips === before - 1000, 'taking a seat charges the buy-in from the bankroll');
  // 透支用独立房间与独立账号，避免前一步的押注让「扣到 0」测不出来。
  const broke = other.user.id;
  const brokeBefore = peekAccount(broke).chips;
  const overdraw = takeSeat(broke, 10 ** 9, 'r_selftest_overdraw');
  ok(overdraw === brokeBefore && peekAccount(broke).chips === 0, 'a buy-in larger than the balance stops at zero');
  leaveSeat(broke, overdraw, 'r_selftest_overdraw');
  ok(peekAccount(broke).chips === brokeBefore, 'leaving the table returns the remaining stack');

  // 每手结算按「房间 + 手数」去重：重连 / 重放不会重复计数。
  const fact = (playerId: string, over: Record<string, unknown> = {}) => ({
    playerId, seatIndex: 0, vpip: true, sawFlop: true, wentToShowdown: true,
    wonAmount: 200, invested: 100, won: true, ...over
  });
  const seats = new Map([[a, 'p1'], [b, 'p2']]);
  const seatOf = (seat: string) => [...seats].find(([, claimed]) => claimed === seat)?.[0];
  const facts = [fact('p1'), fact('p2', { wonAmount: 0, won: false, wentToShowdown: false })];
  const first = settleHand('r_selftest', 1, facts, seatOf, Date.now());
  ok(first.settled.length === 2, 'both human seats fold into the ledger');
  const afterFirst = peekAccount(a).career;
  ok(afterFirst.hands === 1 && afterFirst.won === 1, 'a won hand counts towards hands and wins');
  ok(afterFirst.vpip === 1 && afterFirst.showdowns === 1, 'VPIP and showdown are recorded');
  ok(afterFirst.netChips === 100, 'net chips are winnings minus investment');

  settleHand('r_selftest', 1, facts, seatOf, Date.now());
  ok(peekAccount(a).career.hands === 1, 'replaying the same hand does not double-count');

  settleHand('r_selftest', 2, [fact('p1', { wonAmount: 0, won: false })], seatOf, Date.now());
  ok(peekAccount(a).career.hands === 2, 'the next hand is recorded separately');

  // 内置 AI 座位没有账号，不能被记进任何人的生涯。
  const aiSettle = settleHand('r_selftest', 3, [fact('p9')], seatOf, Date.now());
  ok(aiSettle.settled.length === 0, 'built-in AI seats never enter the ledger');

  // 测试 AI 救济金发放机制（半小时内最多 2 次，每次 1000 筹码）
  const testAiId = 'ai:hero:测试名将';
  const { tryGrantAiRelief } = await import('./pokerLedger.ts');
  const now = Date.now();
  const r1 = tryGrantAiRelief(testAiId, now);
  ok(r1.granted && r1.chips === 6000, 'first relief granted');
  const r2 = tryGrantAiRelief(testAiId, now + 1000);
  ok(r2.granted && r2.chips === 7000, 'second relief granted');
  const r3 = tryGrantAiRelief(testAiId, now + 2000);
  ok(!r3.granted && r3.chips === 7000, 'third relief within 30 min rejected');
  const r4 = tryGrantAiRelief(testAiId, now + 31 * 60 * 1000);
  ok(r4.granted && r4.chips === 8000, 'relief granted again after 30 min window expires');

  // 全服排行：余额 + 桌上筹码，按筹码降序。包含真人与内置名将 AI。
  takeSeat(b, 250, 'r_selftest_seat');
  const board = rankAccounts(matches, [a, b]);
  ok(board.length >= 2, 'the leaderboard lists accounts and ai');
  ok(board[0].chips >= board[1].chips, 'the leaderboard is sorted by chips');
  ok(board.every(row => row.bankroll + row.onTable === row.chips), 'bankroll plus table stakes equals the ranked total');
  ok(board.some(row => row.isAi), 'the leaderboard includes AI heroes');
  // 排行榜是公开 GET：绝不能给内置名将**新建**账本档案（issue #186 的写放大）。
  // 前面的救济/买入用例会合法写掉个别 AI 账号，所以只断言「没碰过的名将保持空档」。
  const { allAccounts } = await import('./pokerLedger.ts');
  const untouched = ['ai:hero:夏侯惇', 'ai:hero:马超', 'ai:hero:甘宁'];
  ok(
    untouched.every(id => !allAccounts().some(acct => acct.userId === id)),
    'ranking never materializes untouched built-in AI accounts into the ledger'
  );
  ok(
    board.some(row => row.userId === 'ai:hero:夏侯惇' && row.name === '夏侯惇 (AI)'),
    'untouched AI hero rows still appear with their display name'
  );
  matches.closeAll();

  // 房间重建 / 服务端重启：同一房间重复买入不能二次扣款。
  {
    const bank = peekAccount(a).chips;
    const again = takeSeat(a, 1000, 'r_selftest_seat');
    ok(again === 1000 && peekAccount(a).chips === bank, 're-entering the same room reuses the committed buy-in');
    const other = takeSeat(a, 800, 'r_selftest_other');
    ok(other === 800 && peekAccount(a).chips === bank - 800, 'a different room charges its own buy-in');
    leaveSeat(a, 800, 'r_selftest_other');
    ok(peekAccount(a).chips === bank, 'leaving the second room refunds exactly its stake');
    leaveSeat(a, 800, 'r_selftest_other');
    ok(peekAccount(a).chips === bank, 'a repeated leave refunds nothing twice');
  }

  // 开局失败必须退款：否则每次「座位数不符」的进入都会静默吞掉一笔买入。
  {
    const bankBefore = peekAccount(a).chips;
    let threw = false;
    try {
      // 扑克固定 6 座，1 人房间会被夹具拒绝——这正是最常见的失败路径。
      matches.ensure({
        roomId: 'r_refund_probe',
        gameId: 'poker',
        players: [{ userId: a, name: '测试员1' }],
        seats: 1,
        scenario: 'seats_2'
      });
    } catch {
      threw = true;
    }
    ok(threw, 'a mismatched poker table is refused');
    ok(peekAccount(a).chips === bankBefore, 'a refused table refunds the buy-in it had already charged');
  }

  // 排名数据不含隐藏信息：字段只有余额与统计。
  ok(!('entities' in board[0]) && !('hand' in board[0]), 'the leaderboard carries no hidden game state');

  // ---- issue #185：离开/被踢后座位撤销 ----
  {
    const { MatchBroker } = await import('./matchBroker.ts');
    const { leaveRoom, kickPlayer: kick, createRoom: create, setRoomStatus: setStatus, joinRoom: join, setRoomChangedHook } =
      await import('./rooms.ts');
    const { rooms } = await import('./storage.ts');
    const broker = new MatchBroker();
    // 与 index.ts 相同的钩子接线：成员变化也通知 broker（自检模块默认钩子是空函数）。
    setRoomChangedHook(room => {
      if (room.status === 'closed') broker.onRoomClosed(room.id);
      else broker.onRoomMembersChanged(room.id);
    });
    const host = a;
    const mkGuest = (tag: string): string => {
      const created: any = createUser('seatrev_' + tag + '_' + Date.now(), 'secret123');
      return created.user.id;
    };
    const guest = mkGuest('k');
    const guest2 = mkGuest('l');
    // 默认扑克桌：3 真人 + 3 AI 补位（joinRoom 只在 open 状态收人，两个客人先入房）。
    const pokerRoom: any = create(host, '撤销测试房', 'poker');
    join(guest, pokerRoom.id);
    join(guest2, pokerRoom.id);
    const { setAiSeats } = await import('./rooms.ts');
    setAiSeats(host, pokerRoom.id, 3);
    setStatus(host, pokerRoom.id, 'playing');
    // 建局并 attach 三个真人
    const seats = ((rooms.byId(pokerRoom.id) as any).players as string[]).map(pid => ({ userId: pid, name: pid }));
    const match = broker.matches.ensure({
      roomId: pokerRoom.id,
      gameId: 'poker',
      players: seats,
      seats: seats.length,
      aiSeats: 3
    });
    ok(!!match.attach(host), 'host attach works');
    ok(!!match.attach(guest), 'guest attach works');
    ok(!('error' in match.snapshotFor(guest)), 'guest gets a snapshot before removal');

    // 房主把 guest 请离（房间仍在 playing）：座位必须立即撤销。
    const kickedNow: any = kick(host, pokerRoom.id, guest);
    ok(!kickedNow.error, 'host kicks the guest mid-hand');
    ok(!match.seatOf(guest), 'the removed player no longer owns a seat');
    ok('error' in match.snapshotFor(guest), 'snapshot is refused after removal');
    ok('error' in match.deltaFor(guest), 'delta push is refused after removal');
    const rejected = match.submit(guest, { type: 'FOLD', playerId: 'p2' });
    ok(!rejected.ok, 'submit is refused after removal');

    // 主动离开同样撤销座位。
    const left: any = leaveRoom(guest2, pokerRoom.id);
    ok(!left.error, 'a player can leave mid-hand');
    ok(!match.seatOf(guest2), 'the leaver no longer owns a seat');
    ok('error' in match.snapshotFor(guest2), 'snapshot is refused after leaving');
    ok(match.seatOf(host) === 'p1', 'the staying player keeps their seat');
    broker.dispose();
  }
}

// 测试用户删除
const deleteRes: any = adminDeleteUser(other.user.id, adminLogin.user.id);
ok(deleteRes.ok === true, 'adminDeleteUser works');


/* -------------------------------------------------------------------------- */
/* AR-4：跨站写请求必须被拒                                                    */
/* -------------------------------------------------------------------------- */
{
  const callApp = async (method: string, path: string, headers: Record<string, string>) => {
    const res = await app.fetch(new Request(`http://127.0.0.1${path}`, { method, headers }));
    return res.status;
  };

  const host = { host: '127.0.0.1', 'content-type': 'application/json' };

  ok(
    (await callApp('POST', '/api/auth/login', { ...host, origin: 'https://evil.example.com' })) === 403,
    'AR-4: a cross-origin write is rejected'
  );
  ok(
    (await callApp('POST', '/api/auth/login', { ...host, origin: 'http://127.0.0.1' })) !== 403,
    'AR-4: a same-origin write reaches the handler'
  );
  ok(
    (await callApp('POST', '/api/auth/login', { ...host })) !== 403,
    'AR-4: a write without an Origin header is allowed (curl / same-site form)'
  );
  ok(
    (await callApp('GET', '/api/games', { host: '127.0.0.1', origin: 'https://evil.example.com' })) !== 403,
    'AR-4: reads are not blocked by the origin guard'
  );
}

/* -------------------------------------------------------------------------- */
/* #231：匿名访客不能拿它当账号枚举接口                                          */
/* -------------------------------------------------------------------------- */
{
  const anon = await app.fetch(new Request('http://127.0.0.1/api/poker/leaderboard', { headers: { host: '127.0.0.1' } }));
  const anonBody: any = await anon.json();
  const masked = (anonBody.rows ?? []).filter((row: any) => !String(row.name).endsWith('(AI)'));
  ok(
    masked.length > 0 && masked.every((row: any) => /^\S\*\*\*$/.test(row.name) && row.userId === ''),
    'anonymous callers only get masked names and no user ids'
  );

  const signed = await app.fetch(
    new Request('http://127.0.0.1/api/poker/leaderboard', {
      headers: { host: '127.0.0.1', authorization: `Bearer ${adminLogin.token}` }
    })
  );
  const signedBody: any = await signed.json();
  const plain = (signedBody.rows ?? []).filter((row: any) => !String(row.name).endsWith('(AI)'));
  ok(
    plain.length > 0 && plain.every((row: any) => !String(row.name).includes('***')),
    'signed-in callers still see real names'
  );
}

/* -------------------------------------------------------------------------- */
/* #187：账本健康状态必须能从 /healthz 看见                                       */
/* -------------------------------------------------------------------------- */
{
  const res = await app.fetch(new Request('http://127.0.0.1/healthz', { headers: { host: '127.0.0.1' } }));
  const body: any = await res.json();
  ok(res.status === 200 && body.ok === true, 'healthz still answers ok');
  ok(body.pokerLedger === 'ok', 'a healthy ledger is reported as ok');
}

/* -------------------------------------------------------------------------- */
/* #187 方案 A：账本降级 = 只读，且不允许开新的扑克桌                            */
/* -------------------------------------------------------------------------- */
{
  const { __resetLedgerDegradedForTest, __setLedgerDegradedForTest, isLedgerDegraded, ledgerHealth } = await import('./pokerLedger.ts');
  __setLedgerDegradedForTest();
  ok(isLedgerDegraded(), 'the ledger reports a read-only degraded state');
  ok(ledgerHealth().ok === false, 'ledgerHealth() surfaces the degraded flag');

  const degradedMatches = new MatchManager();
  let refused = false;
  try {
    degradedMatches.ensure({
      roomId: 'r_degraded',
      gameId: 'poker',
      players: [{ userId: 'degraded_user', name: '测试员1' }],
      seats: 1,
      aiSeats: 0,
      seed: 1
    });
  } catch (error) {
    refused = String(error).includes('只读降级');
  }
  ok(refused, 'a poker table refuses to start while the ledger is read-only');
  degradedMatches.closeAll();

  __resetLedgerDegradedForTest();
  ok(!isLedgerDegraded(), 'the ledger returns to normal for the rest of the suite');
}

/* -------------------------------------------------------------------------- */
/* #227：生产环境弱口令必须被拒绝                                                 */
/* -------------------------------------------------------------------------- */
{
  const { validateProductionSecrets } = await import('./config.ts');
  const good = { NODE_ENV: 'production', ADMIN_PASSWORD: 's3cure-Random-Value', HUB_SECRET: 'a'.repeat(32) };
  ok(validateProductionSecrets(good).length === 0, 'strong production secrets pass');

  const weak = validateProductionSecrets({ ...good, ADMIN_PASSWORD: 'kgnb666' });
  ok(weak.some(p => p.variable === 'ADMIN_PASSWORD' && p.reason.includes('弱口令')), 'the repo default password is rejected');

  const missing = validateProductionSecrets({ NODE_ENV: 'production', HUB_SECRET: good.HUB_SECRET });
  ok(missing.some(p => p.variable === 'ADMIN_PASSWORD' && p.reason === '未配置'), 'a missing admin password is rejected');

  const devSecret = validateProductionSecrets({ ...good, HUB_SECRET: 'dev-secret-do-not-use-in-prod' });
  ok(devSecret.some(p => p.variable === 'HUB_SECRET'), 'the dev hub secret is rejected in production');

  ok(validateProductionSecrets({ NODE_ENV: 'development' }).length === 0, 'development stays permissive');
}

/* -------------------------------------------------------------------------- */
/* #221：每个对局只能有一个定时泵                                                 */
/* -------------------------------------------------------------------------- */
{
  const originalSetInterval = globalThis.setInterval;
  let timerCount = 0;
  (globalThis as unknown as { setInterval: typeof setInterval }).setInterval = ((fn: never, ms?: number) => {
    timerCount++;
    return originalSetInterval(fn, ms);
  }) as unknown as typeof setInterval;
  try {
    const timerMatches = new MatchManager();
    timerMatches.ensure({
      roomId: 'r_timer_count',
      gameId: 'poker',
      players: [{ userId: 'timer_host', name: '计时' }],
      seats: 2,
      aiSeats: 1,
      seed: 3
    });
    ok(timerCount <= 1, `a match uses a single interval timer (saw ${timerCount})`);
    timerMatches.closeAll();
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
}

/* -------------------------------------------------------------------------- */
/* 掉线重连不能换座位（线上事故）                                                */
/* -------------------------------------------------------------------------- */
{
  const seatHost = createUser('seat_host', 'secret123', { displayName: '座位房主' }) as unknown as { user: { id: string } };
  const seatA = createUser('seat_a', 'secret123', { displayName: '座位A' }) as unknown as { user: { id: string } };
  const seatB = createUser('seat_b', 'secret123', { displayName: '座位B' }) as unknown as { user: { id: string } };
  const seatRoom = createRoom(seatHost.user.id, '座位稳定性', 'poker') as any;
  ok(!seatRoom.error, 'seat room created');
  joinRoom(seatA.user.id, seatRoom.id);
  joinRoom(seatB.user.id, seatRoom.id);
  const orderBefore = seatedPlayers(seatRoom.id);
  ok(orderBefore.join(',') === [seatHost.user.id, seatA.user.id, seatB.user.id].join(','), 'seats follow join order');

  // 掉线 → 离开房间 → 重连：必须回到原座位，而不是被追加到末尾。
  leaveRoom(seatA.user.id, seatRoom.id);
  joinRoom(seatA.user.id, seatRoom.id);
  ok(seatedPlayers(seatRoom.id).join(',') === orderBefore.join(','), 'reconnecting player keeps the same seat');

  // 被请离则释放座位，新玩家可以补进来。
  kickPlayer(seatHost.user.id, seatRoom.id, seatB.user.id);
  const seatC = createUser('seat_c', 'secret123', { displayName: '座位C' }) as unknown as { user: { id: string } };
  joinRoom(seatC.user.id, seatRoom.id);
  const orderAfterKick = seatedPlayers(seatRoom.id);
  ok(orderAfterKick.length === 3, 'the kicked seat is reusable');
  ok(orderAfterKick[2] === seatC.user.id, 'a new player takes the freed seat');
}

/* -------------------------------------------------------------------------- */
/* #202：hub.json 损坏 → 只读降级，而不是进程退出                                  */
/* -------------------------------------------------------------------------- */
{
  const { parseDb, hubStorageHealth } = await import('./storage.ts');
  const good = parseDb(JSON.stringify({ users: [], rooms: [] }));
  ok(good.ok === true, 'a well-formed hub.json parses');

  const broken = parseDb('{ oops');
  ok(broken.ok === false, 'a truncated hub.json is reported as invalid');
  ok(!broken.ok && broken.error.length > 0, 'the parse error explains why');

  const wrongShape = parseDb(JSON.stringify({ users: {}, rooms: [] }));
  ok(wrongShape.ok === false, 'a wrong-shaped hub.json is reported as invalid');

  ok(hubStorageHealth().ok === true, 'the live store reports healthy');

  const res = await app.fetch(new Request('http://127.0.0.1/healthz', { headers: { host: '127.0.0.1' } }));
  const body: any = await res.json();
  ok(body.hubStorage === 'ok', 'healthz exposes the hub storage state');
}

/* -------------------------------------------------------------------------- */
/* #203：并发登录必须被限速（预扣名额）                                            */
/* -------------------------------------------------------------------------- */
{
  const raceName = 'race_' + Date.now();
  createUser(raceName, 'secret123');
  const attempt = () =>
    app.fetch(
      new Request('http://127.0.0.1/api/auth/login', {
        method: 'POST',
        headers: { host: '127.0.0.1', 'content-type': 'application/json' },
        body: JSON.stringify({ name: raceName, password: 'definitely-wrong' })
      })
    );
  const results = await Promise.all(Array.from({ length: 14 }, attempt));
  const limited = results.filter(r => r.status === 429).length;
  ok(limited >= 3, `concurrent wrong passwords are rate limited (429 x${limited})`);

  // 正确的密码也不能在限速生效后再放行。
  const afterLimit = await app.fetch(
    new Request('http://127.0.0.1/api/auth/login', {
      method: 'POST',
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      body: JSON.stringify({ name: raceName, password: 'secret123' })
    })
  );
  ok(afterLimit.status === 429, 'the limiter rejects even a correct password once tripped');
}

/* -------------------------------------------------------------------------- */
/* #201：房间写入按行落盘，不再整库重写                                            */
/* -------------------------------------------------------------------------- */
{
  const storage = await import('./storage.ts');
  const baseCount = storage.storageWriteCount();
  const burstRoom = {
    id: 'r_write_burst',
    name: '写入合并',
    gameId: 'poker',
    hostId: 'u_write_burst',
    status: 'open' as const,
    maxPlayers: 6,
    players: [],
    createdAt: Date.now()
  };
  storage.rooms.add(burstRoom);
  let lastActivity = 0;
  for (let i = 0; i < 60; i++) {
    lastActivity = Date.now() + i;
    storage.rooms.update(burstRoom.id, { lastActivity });
  }
  ok(storage.storageWriteCount() === baseCount + 61, 'each room change writes exactly one row');
  const rows = storage.rooms.all().filter(r => r.id === burstRoom.id);
  ok(rows.length === 1, 'a burst of updates never duplicates the room row');
  ok(rows[0]?.lastActivity === lastActivity, 'the last update is the one that persists');
  storage.rooms.remove(burstRoom.id);
  ok(storage.rooms.byId(burstRoom.id) === undefined, 'removing a room deletes its row');
}

console.log(failed ? failed + ' FAILURES' : 'ALL PASS');
try { fs.rmSync(process.env.HUB_DATA_DIR!, { recursive: true, force: true }); } catch { /* 临时目录清理失败无所谓 */ }
process.exit(failed ? 1 : 0);

/** M1 自检：不依赖浏览器，直接调用各模块断言核心行为。 */
// 数据隔离：自检必须在一次性临时目录里跑（部署机 data/ 软链到生产数据，
// `pnpm test:server` 若不隔离会把 tester 用户/测试房间写进线上库）。
// 因此必须先设好 HUB_DATA_DIR 再动态 import 业务模块（静态 import 会在本行之前求值）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.HUB_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'rds-selftest-'));
const {
  register, login, verifyJwt, userFromAuthHeader, createUser, isAdminUser, changeOwnPassword,
  adminListUsers, adminUpdateUser, adminResetPassword, adminDeleteUser
} = await import('./auth.ts');
const { createRoom, joinRoom, listRooms, setRoomStatus, setReady, kickPlayer, transferHost, getRoomInfo } = await import('./rooms.ts');
const { GAMES } = await import('./games.ts');
const { MatchManager } = await import('./match.ts');

let failed = 0;
const ok = (cond: boolean, name: string) => { if (!cond) { failed++; console.error('FAIL', name); } else console.log('ok -', name); };

// ---- 默认管理员 rds / kgnb666 自检 ----
const adminLogin: any = login('rds', 'kgnb666');
ok(adminLogin.token && adminLogin.user.name === 'rds' && adminLogin.user.role === 'admin', 'admin rds login works');
ok(isAdminUser(verifyJwt(adminLogin.token)), 'admin rds has admin privileges');
ok((login('rds', 'wrong_pass') as any).error, 'admin wrong password rejected');

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
const login_r: any = login(name, 'secret123');
ok(login_r.token, 'login works');
ok((login(name, 'wrong!!') as any).error, 'wrong password rejected');

// 列表查询
const userList = adminListUsers();
ok(userList.some(u => u.name === 'rds' && u.role === 'admin'), 'admin listed in user list');
ok(userList.some(u => u.name === name), 'created user listed');

// 管理员直接重置他人密码（无需原密码）
const resetRes: any = adminResetPassword(reg.user.id, 'new_secret_888');
ok(resetRes.ok === true, 'adminResetPassword works');
ok(!!(login(name, 'new_secret_888') as any).token, 'login with new password works');

// 令牌吊销：改密/重置后旧 token 必须立即失效（authUserFromToken 回查记录 + tokenEpoch）
ok(userFromAuthHeader('Bearer ' + reg.token) === null, 'old token rejected after admin password reset');
const reLogin: any = login(name, 'new_secret_888');
ok(!!(userFromAuthHeader('Bearer ' + reLogin.token)?.sub), 'fresh token after reset is accepted');

// 用户自主修改密码（需校验原密码）
ok(!!(changeOwnPassword(reg.user.id, 'wrong_old', 'user_new_pass_666') as any).error, 'changeOwnPassword rejects wrong old password');
ok(!!(changeOwnPassword(reg.user.id, 'new_secret_888', '123') as any).error, 'changeOwnPassword rejects short password');
const selfChangeRes: any = changeOwnPassword(reg.user.id, 'new_secret_888', 'user_new_pass_666');
ok(selfChangeRes.ok === true, 'changeOwnPassword works with correct old password');
ok(!!(login(name, 'user_new_pass_666') as any).token, 'login with user changed password works');
ok(userFromAuthHeader('Bearer ' + reLogin.token) === null, 'old token rejected after self password change');

// 资料与禁用更新
const updateRes: any = adminUpdateUser(reg.user.id, { displayName: '改名测试员', disabled: true }, adminLogin.user.id);
ok(updateRes.user && updateRes.user.displayName === '改名测试员' && updateRes.user.disabled === true, 'adminUpdateUser works');
ok(!!(login(name, 'user_new_pass_666') as any).error, 'disabled user login rejected');
// 禁用账号的旧 token 同样被拒
adminUpdateUser(reg.user.id, { disabled: false }, adminLogin.user.id);
const enabledLogin: any = login(name, 'user_new_pass_666');
adminUpdateUser(reg.user.id, { disabled: true }, adminLogin.user.id);
ok(userFromAuthHeader('Bearer ' + enabledLogin.token) === null, 'token rejected while account is disabled');
adminUpdateUser(reg.user.id, { disabled: false }, adminLogin.user.id);

// 恢复启用
adminUpdateUser(reg.user.id, { disabled: false }, adminLogin.user.id);
ok(!!(login(name, 'user_new_pass_666') as any).token, 'enabled user login works again');

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

// 德州扑克：默认桌是「1 真人 + 5 AI」的 6 人桌（不足 6 人由 AI 补齐），
// 房间座位数跟着所选场景走。
const pokerDefault: any = createRoom(reg.user.id, '扑克默认房', 'poker');
// 默认房不限座位（可容纳 6-10 人）；不足 6 人时由内置 AI 补齐到 6。
ok(pokerDefault.maxPlayers === 10, 'poker room allows the full 2-10 range by default');
const pokerSix: any = createRoom(reg.user.id, '扑克六人房', 'poker', { scenarioId: 'seats_6' });
ok(pokerSix.maxPlayers === 6, 'poker 6-seat variant widens the room cap');
const pokerTwo: any = createRoom(reg.user.id, '扑克单挑房', 'poker', { scenarioId: 'seats_2', maxPlayers: 9 });
ok(pokerTwo.maxPlayers === 2, 'poker heads-up variant clamps the cap to 2');

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

  // 内核控制通道（__ 前缀）不可被客户端使用
  const control = match.submit(host, { type: '__TICK__', playerId: 'p1', payload: { ticks: 1 } });
  ok(control.ok === false, 'server rejects kernel control actions from clients');

  // 合法动作由服务器权威执行并推进 revision
  const legal = (hostView.state as any).legalActions as any[];
  const first = legal.find(a => a.type === 'TAKE_3_DIFF_GEMS') ?? legal[0];
  const accepted = match.submit(host, { ...first, playerId: 'p1' });
  ok(accepted.ok === true, 'server accepts a legal action from the seat owner');
  ok(match.revision > 0, 'accepted action advances the server revision');

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

  // 固定阵容的玩法无法为 2 人发牌 → 开局失败并给出可读原因，而不是摆空座位。
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
  const pokerRoom: any = createRoom(reg.user.id, '扑克两人房', 'poker');
  joinRoom(other.user.id, pokerRoom.id);
  const pokerStart: any = setRoomStatus(reg.user.id, pokerRoom.id, 'playing');
  ok(pokerStart.status === 'playing', 'lobby starts a two-player poker room');
}

// 测试用户删除
const deleteRes: any = adminDeleteUser(other.user.id, adminLogin.user.id);
ok(deleteRes.ok === true, 'adminDeleteUser works');

console.log(failed ? failed + ' FAILURES' : 'ALL PASS');
try { fs.rmSync(process.env.HUB_DATA_DIR!, { recursive: true, force: true }); } catch { /* 临时目录清理失败无所谓 */ }
process.exit(failed ? 1 : 0);

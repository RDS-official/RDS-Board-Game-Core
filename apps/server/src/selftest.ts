/** M1 自检：不依赖浏览器，直接调用各模块断言核心行为。 */
import {
  register, login, verifyJwt, createUser, isAdminUser, changeOwnPassword,
  adminListUsers, adminUpdateUser, adminResetPassword, adminDeleteUser
} from './auth.ts';
import { createRoom, joinRoom, listRooms, setRoomStatus, setReady, kickPlayer, transferHost, getRoomInfo } from './rooms.ts';
import { GAMES } from './games.ts';
import { MatchManager } from './match.ts';

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

// 用户自主修改密码（需校验原密码）
ok(!!(changeOwnPassword(reg.user.id, 'wrong_old', 'user_new_pass_666') as any).error, 'changeOwnPassword rejects wrong old password');
ok(!!(changeOwnPassword(reg.user.id, 'new_secret_888', '123') as any).error, 'changeOwnPassword rejects short password');
const selfChangeRes: any = changeOwnPassword(reg.user.id, 'new_secret_888', 'user_new_pass_666');
ok(selfChangeRes.ok === true, 'changeOwnPassword works with correct old password');
ok(!!(login(name, 'user_new_pass_666') as any).token, 'login with user changed password works');

// 资料与禁用更新
const updateRes: any = adminUpdateUser(reg.user.id, { displayName: '改名测试员', disabled: true }, adminLogin.user.id);
ok(updateRes.user && updateRes.user.displayName === '改名测试员' && updateRes.user.disabled === true, 'adminUpdateUser works');
ok(!!(login(name, 'user_new_pass_666') as any).error, 'disabled user login rejected');

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
}

// 测试用户删除
const deleteRes: any = adminDeleteUser(other.user.id, adminLogin.user.id);
ok(deleteRes.ok === true, 'adminDeleteUser works');

console.log(failed ? failed + ' FAILURES' : 'ALL PASS');
process.exit(failed ? 1 : 0);

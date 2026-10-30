/** M1 自检：不依赖浏览器，直接调用各模块断言核心行为。 */
import {
  register, login, verifyJwt, createUser, isAdminUser, changeOwnPassword,
  adminListUsers, adminUpdateUser, adminResetPassword, adminDeleteUser
} from './auth.ts';
import { createRoom, joinRoom, listRooms, setRoomStatus, setReady, kickPlayer, transferHost, getRoomInfo } from './rooms.ts';
import { GAMES } from './games.ts';

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

// 测试用户删除
const deleteRes: any = adminDeleteUser(other.user.id, adminLogin.user.id);
ok(deleteRes.ok === true, 'adminDeleteUser works');

console.log(failed ? failed + ' FAILURES' : 'ALL PASS');
process.exit(failed ? 1 : 0);

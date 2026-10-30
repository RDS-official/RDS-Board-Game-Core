import crypto from 'node:crypto';
import { users, UserRecord } from './storage.ts';
import { randomId, JWT_SECRET, TOKEN_TTL_SEC } from './config.ts';

// ---- 密码：scrypt（node:crypto 内置，零依赖） ----
export function hashPassword(password: string, salt?: string) {
  const s = salt ?? crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, s, 32).toString('hex');
  return { salt: s, passHash: hash };
}
function verify(password: string, salt: string, expected: string) {
  return crypto.timingSafeEqual(Buffer.from(hashPassword(password, salt).passHash), Buffer.from(expected));
}

// ---- JWT：HMAC-SHA256，手写避免依赖 ----
const b64u = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');
export function signJwt(payload: Record<string, unknown>): string {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC }));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(header + '.' + body).digest('base64url');
  return header + '.' + body + '.' + sig;
}
export function verifyJwt(token: string): { sub: string; name: string; role?: 'admin' | 'user' } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expect = crypto.createHmac('sha256', JWT_SECRET).update(parts[0] + '.' + parts[1]).digest('base64url');
  // 长度先比：timingSafeEqual 对不等长输入直接 throw（审查报告 S1，畸形签名可打崩进程）
  const got = Buffer.from(parts[2]);
  const want = Buffer.from(expect);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (typeof payload.exp === 'number' && payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch { return null; }
}

// ---- 默认管理员初始化（admin 账号: rds，密码: kgnb666） ----
export function ensureDefaultAdmin(): void {
  const existing = users.byName('rds');
  if (!existing) {
    const { salt, passHash } = hashPassword('kgnb666');
    users.add({
      id: 'u_admin_rds',
      name: 'rds',
      displayName: '管理员',
      role: 'admin',
      passHash,
      salt,
      createdAt: Date.now(),
      disabled: false,
    });
  } else {
    const updates: Partial<UserRecord> = {};
    if (existing.role !== 'admin') updates.role = 'admin';
    if (existing.disabled) updates.disabled = false;
    if (!verify('kgnb666', existing.salt, existing.passHash)) {
      const { salt, passHash } = hashPassword('kgnb666');
      updates.salt = salt;
      updates.passHash = passHash;
    }
    if (Object.keys(updates).length > 0) {
      users.update(existing.id, updates);
    }
  }
}

// 模块加载时自举默认管理员账号
ensureDefaultAdmin();

// ---- 账号创建（内部及管理员使用） ----
export function createUser(
  name: string,
  password: string,
  opts: { displayName?: string; role?: 'admin' | 'user' } = {}
): { token: string; user: { id: string; name: string; displayName: string; role: 'admin' | 'user'; createdAt: number } } | { error: string } {
  if (!/^\w{2,24}$/.test(name)) return { error: '用户名需 2-24 位字母数字下划线' };
  if (password.length < 6) return { error: '密码至少 6 位' };
  if (users.byName(name)) return { error: '用户名已存在' };

  let displayName = opts.displayName?.trim() || name;
  displayName = displayName.slice(0, 24);
  const banned = new Set(['<', '>', String.fromCharCode(34), String.fromCharCode(39), String.fromCharCode(96), '&']);
  for (const ch of displayName) {
    const c = ch.charCodeAt(0);
    if (banned.has(ch) || c < 32) return { error: '昵称含非法字符' };
  }

  const { salt, passHash } = hashPassword(password);
  const id = randomId('u_');
  const role: 'admin' | 'user' = opts.role === 'admin' ? 'admin' : 'user';
  const rec: UserRecord = {
    id,
    name,
    displayName,
    role,
    passHash,
    salt,
    createdAt: Date.now(),
    disabled: false,
  };
  users.add(rec);
  return {
    token: signJwt({ sub: id, name, role }),
    user: { id, name, displayName, role, createdAt: rec.createdAt },
  };
}

// ---- 账号接口 ----
// 需求：关闭注册功能
export function register(_name: string, _password: string): { token: string; user: { id: string; name: string } } | { error: string } {
  return { error: '注册功能已关闭，请联系管理员分配账号' };
}

export function login(name: string, password: string) {
  const u = users.byName(name);
  if (!u || !verify(password, u.salt, u.passHash)) return { error: '用户名或密码错误' };
  if (u.disabled) return { error: '账号已被禁用，请联系管理员' };
  const role: 'admin' | 'user' = u.role ?? (u.name === 'rds' ? 'admin' : 'user');
  return issue(u.id, u.name, role);
}

function issue(id: string, name: string, role: 'admin' | 'user' = 'user') {
  return { token: signJwt({ sub: id, name, role }), user: { id, name, role } };
}

export function userFromAuthHeader(header?: string): { sub: string; name: string; role?: 'admin' | 'user' } | null {
  if (!header?.startsWith('Bearer ')) return null;
  return verifyJwt(header.slice(7));
}

export function isAdminUser(user: { sub: string; name: string; role?: string } | null): boolean {
  if (!user) return false;
  if (user.role === 'admin' || user.name === 'rds') return true;
  const rec = users.byId(user.sub);
  return rec?.role === 'admin' || rec?.name === 'rds';
}

// ---- 阶段一：用户资料（昵称/头像） ----
export interface UserProfile {
  id: string; name: string; displayName: string; role?: 'admin' | 'user'; disabled?: boolean; avatarUrl?: string;
}

export function profileOf(id: string): UserProfile | null {
  const u = users.byId(id);
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    displayName: u.displayName || u.name,
    role: u.role ?? (u.name === 'rds' ? 'admin' : 'user'),
    disabled: !!u.disabled,
    avatarUrl: u.avatarExt ? '/avatars/' + u.id + '.' + u.avatarExt + '?v=' + (u.avatarRev ?? 1) : undefined,
  };
}

export function updateDisplayName(id: string, displayName: string): UserProfile | { error: string } {
  const name = displayName.trim().slice(0, 24);
  if (!name) return { error: '昵称不能为空' };
  // 审查报告 S4：昵称是存储型 XSS 的源头，禁用 HTML/模板语法相关字符（中文/字母/数字/常规标点不受影响）
  const banned = new Set(['<', '>', String.fromCharCode(34), String.fromCharCode(39), String.fromCharCode(96), '&']);
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    if (banned.has(ch) || c < 32) return { error: '昵称含非法字符' };
  }
  const u = users.update(id, { displayName: name });
  if (!u) return { error: '用户不存在' };
  return profileOf(id)!;
}

// ---- 管理员后台账号管理接口 ----
export function adminListUsers() {
  return users.all().map(u => ({
    id: u.id,
    name: u.name,
    displayName: u.displayName || u.name,
    role: u.role ?? (u.name === 'rds' ? 'admin' : 'user'),
    disabled: !!u.disabled,
    createdAt: u.createdAt,
    avatarUrl: u.avatarExt ? '/avatars/' + u.id + '.' + u.avatarExt + '?v=' + (u.avatarRev ?? 1) : undefined,
  }));
}

export function adminUpdateUser(
  id: string,
  patch: { displayName?: string; role?: 'admin' | 'user'; disabled?: boolean },
  operatorId?: string
): { user: UserProfile } | { error: string } {
  const u = users.byId(id);
  if (!u) return { error: '用户不存在' };

  if (u.name === 'rds') {
    if (patch.role && patch.role !== 'admin') return { error: '不能修改系统管理员 rds 的角色' };
    if (patch.disabled) return { error: '不能禁用系统管理员 rds 账号' };
  }

  if (operatorId && operatorId === id && patch.disabled) {
    return { error: '不能禁用当前登录的账号' };
  }

  const updates: Partial<UserRecord> = {};
  if (patch.displayName !== undefined) {
    const name = patch.displayName.trim().slice(0, 24);
    if (!name) return { error: '昵称不能为空' };
    const banned = new Set(['<', '>', String.fromCharCode(34), String.fromCharCode(39), String.fromCharCode(96), '&']);
    for (const ch of name) {
      const c = ch.charCodeAt(0);
      if (banned.has(ch) || c < 32) return { error: '昵称含非法字符' };
    }
    updates.displayName = name;
  }
  if (patch.role !== undefined) {
    updates.role = patch.role === 'admin' ? 'admin' : 'user';
  }
  if (patch.disabled !== undefined) {
    updates.disabled = !!patch.disabled;
  }

  users.update(id, updates);
  return { user: profileOf(id)! };
}

export function adminResetPassword(id: string, newPass: string): { ok: true } | { error: string } {
  const u = users.byId(id);
  if (!u) return { error: '用户不存在' };
  if (!newPass || newPass.length < 6) return { error: '密码至少 6 位' };
  const { salt, passHash } = hashPassword(newPass);
  users.update(id, { salt, passHash });
  return { ok: true };
}

export function adminDeleteUser(id: string, operatorId?: string): { ok: true } | { error: string } {
  const u = users.byId(id);
  if (!u) return { error: '用户不存在' };
  if (u.name === 'rds') return { error: '系统管理员账号 rds 不可删除' };
  if (operatorId && operatorId === id) return { error: '不能删除当前登录的管理员账号' };

  const success = users.remove(id);
  if (!success) return { error: '删除用户失败' };
  return { ok: true };
}

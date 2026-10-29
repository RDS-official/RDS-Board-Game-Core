import crypto from 'node:crypto';
import { users } from './storage.ts';
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
export function verifyJwt(token: string): { sub: string; name: string } | null {
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

// ---- 账号接口 ----
export function register(name: string, password: string): { token: string; user: { id: string; name: string } } | { error: string } {
  if (!/^\w{2,24}$/.test(name)) return { error: '用户名需 2-24 位字母数字下划线' };
  if (password.length < 6) return { error: '密码至少 6 位' };
  if (users.byName(name)) return { error: '用户名已存在' };
  const { salt, passHash } = hashPassword(password);
  const id = randomId('u_');
  users.add({ id, name, passHash, salt, createdAt: Date.now() });
  return issue(id, name);
}
export function login(name: string, password: string) {
  const u = users.byName(name);
  if (!u || !verify(password, u.salt, u.passHash)) return { error: '用户名或密码错误' };
  return issue(u.id, u.name);
}
function issue(id: string, name: string) {
  return { token: signJwt({ sub: id, name }), user: { id, name } };
}
export function userFromAuthHeader(header?: string) {
  if (!header?.startsWith('Bearer ')) return null;
  return verifyJwt(header.slice(7));
}

// ---- 阶段一：用户资料（昵称/头像） ----
export interface UserProfile {
  id: string; name: string; displayName: string; avatarUrl?: string;
}

export function profileOf(id: string): UserProfile | null {
  const u = users.byId(id);
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    displayName: u.displayName || u.name,
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

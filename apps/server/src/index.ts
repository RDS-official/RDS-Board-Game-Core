import { fileURLToPath } from 'node:url';
// serveStatic root 相对 CWD；统一定位到 apps/server/
process.chdir(fileURLToPath(new URL('../', import.meta.url))); // → apps/server/
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PORT, DATA_DIR } from './config.ts';
import { users } from './storage.ts';
import {
  register, login, userFromAuthHeader, profileOf, updateDisplayName,
  createUser, isAdminUser, adminListUsers, adminUpdateUser, adminResetPassword, adminDeleteUser
} from './auth.ts';
import { listRooms, createRoom, joinRoom, leaveRoom, setRoomStatus, getRoomInfo, setReady, kickPlayer, transferHost, setRoomChangedHook, sweepRooms } from './rooms.ts';
import { GAMES } from './games.ts';
import { SignalHub } from './signal.ts';

interface AppEnv {
  Variables: {
    adminUser: { sub: string; name: string; role?: 'admin' | 'user' };
  };
}

const app = new Hono<AppEnv>();

// ---- 认证 ----
app.post('/api/auth/register', async c => {
  return c.json({ error: '注册功能已关闭，请联系管理员分配账号' }, 403);
});
app.post('/api/auth/login', async c => {
  const body = await c.req.json().catch(() => ({}));
  const r = login(String(body.name ?? ''), String(body.password ?? ''));
  return 'error' in r ? c.json({ error: r.error }, 401) : c.json(r);
});
app.get('/api/auth/me', c => {
  const u = userFromAuthHeader(c.req.header('authorization'));
  return u ? c.json(u) : c.json({ error: 'unauthorized' }, 401);
});

// ---- 后台管理 (Admin) ----
app.use('/api/admin/*', async (c, next) => {
  const u = userFromAuthHeader(c.req.header('authorization'));
  if (!u) return c.json({ error: '未授权，请先登录' }, 401);
  if (!isAdminUser(u)) return c.json({ error: '拒绝访问：需要管理员权限' }, 403);
  c.set('adminUser', u);
  await next();
});

app.get('/api/admin/users', c => {
  return c.json({
    users: adminListUsers(),
    stats: {
      totalUsers: users.all().length,
      adminUsers: users.all().filter(u => u.role === 'admin' || u.name === 'rds').length,
      disabledUsers: users.all().filter(u => !!u.disabled).length,
    }
  });
});

app.post('/api/admin/users', async c => {
  const body = await c.req.json().catch(() => ({}));
  const r = createUser(String(body.name ?? ''), String(body.password ?? ''), {
    displayName: body.displayName ? String(body.displayName) : undefined,
    role: body.role === 'admin' ? 'admin' : 'user',
  });
  return 'error' in r ? c.json({ error: r.error }, 400) : c.json(r);
});

app.put('/api/admin/users/:id', async c => {
  const u = c.get('adminUser') || userFromAuthHeader(c.req.header('authorization'));
  if (!u) return c.json({ error: '未授权' }, 401);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const r = adminUpdateUser(id, body, u.sub);
  return 'error' in r ? c.json({ error: r.error }, 400) : c.json(r);
});

app.post('/api/admin/users/:id/password', async c => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const r = adminResetPassword(id, String(body.password ?? ''));
  return 'error' in r ? c.json({ error: r.error }, 400) : c.json(r);
});

app.delete('/api/admin/users/:id', c => {
  const u = c.get('adminUser') || userFromAuthHeader(c.req.header('authorization'));
  if (!u) return c.json({ error: '未授权' }, 401);
  const id = c.req.param('id');
  const r = adminDeleteUser(id, u.sub);
  return 'error' in r ? c.json({ error: r.error }, 400) : c.json(r);
});

// ---- 阶段一：用户资料（昵称/头像） ----
app.get('/api/me', c => {
  const u = userFromAuthHeader(c.req.header('authorization'));
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const p = profileOf(u.sub);
  return p ? c.json(p) : c.json({ error: 'user gone' }, 404);
});
app.put('/api/me', async c => {
  const u = userFromAuthHeader(c.req.header('authorization'));
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const r = updateDisplayName(u.sub, String(body.displayName ?? ''));
  return 'error' in r ? c.json({ error: r.error }, 400) : c.json(r);
});
const AVATAR_TYPES: Record<string, 'png' | 'jpg' | 'webp'> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
};
app.put('/api/me/avatar', async c => {
  const u = userFromAuthHeader(c.req.header('authorization'));
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const ext = AVATAR_TYPES[c.req.header('content-type') ?? ''];
  if (!ext) return c.json({ error: '仅支持 png / jpeg / webp' }, 400);
  const buf = Buffer.from(await c.req.arrayBuffer());
  if (buf.length === 0) return c.json({ error: '空文件' }, 400);
  if (buf.length > 300 * 1024) return c.json({ error: '头像需 ≤300KB（前端已压缩）' }, 400);
  if (!(buf[0] === 0x89 && buf[1] === 0x50) && !(buf[0] === 0xff && buf[1] === 0xd8) && !(buf[0] === 0x52 && buf[1] === 0x49)) {
    return c.json({ error: '文件头不像图片' }, 400);
  }
  const rec = users.byId(u.sub);
  const rev = (rec?.avatarRev ?? 0) + 1;
  const dir = path.join(DATA_DIR, 'avatars');
  fs.mkdirSync(dir, { recursive: true });
  // 清掉旧扩展名的残留文件（换格式时）
  for (const e of ['png', 'jpg', 'webp']) { try { fs.unlinkSync(path.join(dir, u.sub + '.' + e)); } catch {} }
  fs.writeFileSync(path.join(dir, u.sub + '.' + ext), buf);
  users.update(u.sub, { avatarExt: ext, avatarRev: rev });
  return c.json({ avatarUrl: '/avatars/' + u.sub + '.' + ext + '?v=' + rev });
});
const AVATAR_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
app.get('/avatars/:file', c => {
  const m = /^u_[A-Za-z0-9_]+\.(png|jpg|webp)$/.exec(c.req.param('file'));
  if (!m) return c.json({ error: 'bad file' }, 400);
  const file = path.join(DATA_DIR, 'avatars', m[0]);
  let buf: Buffer;
  try { buf = fs.readFileSync(file); } catch { return c.json({ error: 'not found' }, 404); }
  c.header('Content-Type', AVATAR_MIME[m[1]]);
  c.header('Cache-Control', 'public, max-age=60');
  return c.body(new Uint8Array(buf));
});

// ---- 游戏 / 房间 ----
app.get('/api/games', c => c.json(GAMES));
app.get('/api/rooms', c => c.json(listRooms()));
app.post('/api/rooms', async c => {
  const u = userFromAuthHeader(c.req.header('authorization'));
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const r = createRoom(u.sub, String(body.name ?? ''), String(body.gameId ?? ''), {
    maxPlayers: body.maxPlayers == null ? undefined : Number(body.maxPlayers),
    isPrivate: !!body.isPrivate,
    scenarioId: body.scenarioId == null ? undefined : String(body.scenarioId),
  });
  return 'error' in r ? c.json({ error: r.error }, 400) : c.json(r);
});
app.get('/api/rooms/:id', c => {
  const u = userFromAuthHeader(c.req.header('authorization'));
  if (!u) return c.json({ error: '未登录' }, 401);
  const r = getRoomInfo(c.req.param('id'), u.sub);
  return 'error' in r ? c.json({ error: r.error }, 404) : c.json(r);
});
app.post('/api/rooms/:id/join', async c => {
  const u = userFromAuthHeader(c.req.header('authorization'));
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const code = body.code == null ? undefined : String(body.code);
  const r = joinRoom(u.sub, c.req.param('id'), code);
  return 'error' in r ? c.json({ error: r.error }, 400) : c.json(r);
});
app.post('/api/rooms/:id/leave', c => {
  const u = userFromAuthHeader(c.req.header('authorization'));
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const r = leaveRoom(u.sub, c.req.param('id'));
  return 'error' in r ? c.json({ error: r.error }, 400) : c.json({ ok: true });
});
app.post('/api/rooms/:id/status', async c => {
  const u = userFromAuthHeader(c.req.header('authorization'));
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const r = setRoomStatus(u.sub, c.req.param('id'), body.status);
  return 'error' in r ? c.json({ error: r.error }, 400) : c.json(r);
});
// ---- Phase B：就绪 / 请离 / 转移房主 ----
app.post('/api/rooms/:id/ready', async c => {
  const u = userFromAuthHeader(c.req.header('authorization'));
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const r = setReady(u.sub, c.req.param('id'), !!body.ready);
  return 'error' in r ? c.json({ error: r.error }, 400) : c.json(r);
});
app.post('/api/rooms/:id/kick', async c => {
  const u = userFromAuthHeader(c.req.header('authorization'));
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const r = kickPlayer(u.sub, c.req.param('id'), String(body.target ?? ''));
  return 'error' in r ? c.json({ error: r.error }, 400) : c.json(r);
});
app.post('/api/rooms/:id/host', async c => {
  const u = userFromAuthHeader(c.req.header('authorization'));
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const r = transferHost(u.sub, c.req.param('id'), String(body.target ?? ''));
  return 'error' in r ? c.json({ error: r.error }, 400) : c.json(r);
});
app.get('/healthz', c => c.json({ ok: true }));

// ---- 游戏客户端静态托管（GAMES 目录挂载 RDS-Board-Core 构建产物 dist/ → /games/rds-board-core/） ----
// 生产 compose 卷：./rds-board-core-dist:/app/games/rds-board-core
app.use('/games/*', serveStatic({ root: '../../dist', rewriteRequestPath: p => p.replace(/^\/games\/rds-board-core/, '') || '/index.html' }));

// ---- 静态大厅（生产：web/dist；开发：vite 独立端口） ----
app.use('/*', serveStatic({ root: '../../dist' }));
app.get('/*', serveStatic({ path: '../../dist/index.html' }));

const server = serve({ fetch: app.fetch, port: PORT }, info => {
  console.log('[hub] listening on http://127.0.0.1:' + info.port);
});

// ---- /ws 信令 ----
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const hub = new SignalHub();
hub.startHeartbeat();
setRoomChangedHook(room => {
  // 审查报告 S8：房间广播面向全部大厅订阅者，必须剥掉私密房加入码（房主经 REST 拿全量）
  const { code: _code, ...safe } = room;
  hub.broadcastRoomUpdate(safe as typeof room);
});
// 阶段三：房间回收——60s 清扫一次（全员离线 >10min 或 6h 无动作 → 关房）。
setInterval(() => {
  const closedIds = sweepRooms(id => hub.onlineUsers(id));
  if (closedIds.length) console.log('[hub] room-sweep closed:', closedIds.join(','));
}, 60_000);
server.on('upgrade', (req: http.IncomingMessage, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    // 审查报告 S1：信令层任何异常都不允许打崩 HTTP 进程
    try {
      hub.accept(ws, url.searchParams.get('token'));
    } catch (err) {
      console.error('[hub] ws accept error:', err);
      try { ws.close(4000, 'error'); } catch { /* already closed */ }
    }
  });
});

// 兜底：未捕获异常记日志而不裸崩（pm2 内存阈值/显式重启仍可控）
process.on('uncaughtException', err => console.error('[hub] uncaught exception:', err));
process.on('unhandledRejection', err => console.error('[hub] unhandled rejection:', err));

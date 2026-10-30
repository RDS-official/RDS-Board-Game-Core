import type { HubGameInfo, HubRoomInfo } from '@rds/room-protocol';
import { getGames, getRooms, createRoom, joinRoom, leaveRoom, setRoomStatus, getRoom, me, setReady, kickPlayer, transferHost, updateDisplayName, changeMyPassword, uploadAvatar, UserProfile } from './api.ts';
import { showToast } from './toast.ts';

/**
 * 大厅 2.0（Phase B）：游戏货架 + 快速加入 + 创建模态 + 座位/就绪/聊天 + ws 实时。
 *
 * 继承 Phase A 约束：
 * - 所有动态插值一律经 esc()（存储型 XSS 防御）
 * - 渲染按数据签名跳过无变化重建（保 focus/hover）
 * - 轮询在大厅隐藏时暂停；ws 健康时轮询仅作兜底
 * - 错误用 toast，不用 alert
 */
export interface LobbyHandle { destroy(): void; }

export interface EnterGameParams { query: string; }

let user: { sub: string; name: string; displayName?: string; avatarUrl?: string; role?: 'admin' | 'user' } | null = null;
let onAdmin: (() => void) | null = null;

/** 个人资料弹窗里待上传的头像（已压缩）。 */
let pendingAvatar: { blob: Blob; dataUrl: string } | null = null;

/** 客户端压缩：最长边 256px、WebP（质量 0.85），单张 ~10-30KB，服务端只做兜底校验。 */
async function compressImage(file: File, maxEdge = 256): Promise<{ blob: Blob; dataUrl: string }> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('仅支持 png / jpg / webp');
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/webp', 0.85);
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    if (blob.size > 300 * 1024) throw new Error('压缩后仍超过 300KB，请换一张');
    return { blob, dataUrl };
  } finally { bitmap.close(); }
}

const displayNameOf = (u?: { name: string; displayName?: string } | null) => u?.displayName || u?.name || '?';
const avatarChipHtml = (p?: { name: string; displayName?: string; avatarUrl?: string } | null, cls = 'lob-avatar') =>
  p?.avatarUrl
    ? `<img class="${cls}" src="${esc(p.avatarUrl)}" alt="" loading="lazy" />`
    : `<span class="${cls}">${esc(displayNameOf(p).slice(0, 1).toUpperCase())}</span>`;
let games: HubGameInfo[] = [];
let currentRoom: HubRoomInfo | null = null;
let roomsCache: HubRoomInfo[] = [];
let roomsCacheSig = '';
/** 阶段二：当前房间在线的 userId 列表（信令 presence 推送） */
let onlineIds: string[] = [];
let roomTimer: ReturnType<typeof setInterval> | null = null;
let roomsTimer: ReturnType<typeof setInterval> | null = null;
let rootEl: HTMLElement | null = null;
let onEnterGame: ((p: EnterGameParams) => void) | null = null;
let visibilityHandler: (() => void) | null = null;
/** 上次渲染房间页的数据签名：未变化则跳过 DOM 重建 */
let lastRoomSig = '';

/** 聊天记录：roomId → 消息缓冲（上限 200 条，仅内存） */
interface ChatMsg { from: string; name: string; text: string; at: number; self: boolean; }
const chatLog = new Map<string, ChatMsg[]>();

// ---- ws 实时通道（lobby-sub + join-room + room-updated + lobby-chat） ----
let ws: WebSocket | null = null;
let wsWanted = false;
let wsRetryTimer: ReturnType<typeof setTimeout> | null = null;
let wsHealthy = false;

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return proto + location.host + '/ws?token=' + encodeURIComponent(localStorage.getItem('token') ?? '');
}

function wsSend(msg: unknown): void {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function openWs(): void {
  if (!user || ws || !wsWanted) return;
  try { ws = new WebSocket(wsUrl()); } catch { scheduleWsRetry(); return; }
  ws.onopen = () => {
    wsHealthy = true;
    wsSend({ t: 'lobby-sub' });
    if (currentRoom) wsSend({ t: 'join-room', roomId: currentRoom.id });
    void refreshRooms();
  };
  ws.onmessage = ev => {
    let msg: any;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.t === 'room-updated') onRoomUpdated(msg.room as HubRoomInfo);
    else if (msg.t === 'presence') onPresence(String(msg.roomId), Array.isArray(msg.online) ? msg.online.map(String) : []);
    else if (msg.t === 'lobby-chat' && user) onChat(msg.roomId, { from: msg.from, name: msg.name, text: msg.text, at: msg.at, self: msg.from === user.sub });
    // hello/peer-join/peer-leave：游戏信令消息，大厅忽略
  };
  ws.onclose = () => { ws = null; wsHealthy = false; scheduleWsRetry(); };
  ws.onerror = () => { /* onclose 会跟着触发 */ };
}

function scheduleWsRetry(): void {
  if (!wsWanted || wsRetryTimer) return;
  wsRetryTimer = setTimeout(() => { wsRetryTimer = null; openWs(); }, 3000);
}

function closeWs(): void {
  wsWanted = false; wsHealthy = false;
  if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
  if (ws) { const s = ws; ws = null; try { s.close(); } catch { /* noop */ } }
}

function onRoomUpdated(room: HubRoomInfo): void {
  const uid = user?.sub;
  if (!uid) return;
  if (currentRoom && room.id === currentRoom.id) {
    // 开局瞬间（open→playing）房内非房主玩家自动进对局；房主由开局按钮自己导航。
    // 仅在状态「跃迁」时触发，轮询/重进的 playing 不自动跳，避免回大厅即被弹回。
    if (currentRoom.status === 'open' && room.status === 'playing'
        && room.hostId !== uid && room.players.some(p => p.id === uid) && onEnterGame) {
      showToast('全员已就绪，对局开始！', 'success');
      onEnterGame({ query: gameQuery(room, 'guest') });
      return;
    }
    if (room.status === 'closed' || !room.players.some(p => p.id === uid)) {
      currentRoom = null;
      onlineIds = [];
      showToast('你已不在该房间', 'info');
      render();
      void refreshRooms();
      return;
    }
    if (roomSig(room) !== lastRoomSig) { currentRoom = room; render(); }
    else currentRoom = room;
    return;
  }
  roomsCacheSig = '';
  void refreshRooms();
}

/** 阶段二：在线状态推送 → 座位卡在线点（轻量更新，不重建整页） */
function onPresence(roomId: string, ids: string[]): void {
  if (!currentRoom || roomId !== currentRoom.id) return;
  onlineIds = ids;
  document.querySelectorAll<HTMLElement>('.lob-seat[data-seat]').forEach(el => {
    const uid = el.dataset.seat ?? '';
    const dot = el.querySelector<HTMLElement>('.lob-online-dot');
    if (dot) dot.classList.toggle('on', ids.includes(uid));
  });
}

function onChat(roomId: string, m: ChatMsg): void {
  const buf = chatLog.get(roomId) ?? [];
  buf.push(m);
  if (buf.length > 200) buf.splice(0, buf.length - 200);
  chatLog.set(roomId, buf);
  appendChatDom(m);
}

function appendChatDom(m: ChatMsg): void {
  const log = document.getElementById('chat-log');
  if (!log || !currentRoom) return;
  log.querySelector('.lob-chat-empty')?.remove();
  const div = document.createElement('div');
  div.className = 'lob-chat-msg' + (m.self ? ' self' : '');
  div.innerHTML = '<span class="lob-chat-name">' + esc(m.self ? '你' : m.name) + '</span>' + esc(m.text);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** 大厅是否处于前台（进对局后 lobby-root 被 shell 隐藏，轮询应暂停） */
function lobbyVisible(): boolean {
  return !!rootEl && !(rootEl as HTMLElement & { hidden?: boolean }).hidden && !document.hidden;
}

export async function startLobby(
  container: HTMLElement,
  enterGame: (p: EnterGameParams) => void,
  onOpenAdmin?: () => void
): Promise<LobbyHandle> {
  rootEl = container;
  onEnterGame = enterGame;
  onAdmin = onOpenAdmin ?? null;
  visibilityHandler = () => {
    if (lobbyVisible()) {
      if (currentRoom) void refreshRoom(); else void refreshRooms();
    }
  };
  document.addEventListener('visibilitychange', visibilityHandler);
  await boot();
  return {
    destroy() {
      stopTimer('room'); stopTimer('list');
      closeWs();
      if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
      if (rootEl) rootEl.innerHTML = '';
      rootEl = null; onEnterGame = null; onAdmin = null; currentRoom = null; lastRoomSig = ''; roomsCacheSig = ''; onlineIds = [];
    }
  };
}

function stopTimer(which: 'room' | 'list'): void {
  const t = which === 'room' ? roomTimer : roomsTimer;
  if (t) clearInterval(t);
  if (which === 'room') roomTimer = null; else roomsTimer = null;
}

function render(): void {
  if (!rootEl) return;
  rootEl.innerHTML = !user ? authHtml() : (currentRoom ? roomHtml() : lobbyHtml()) + profileModalHtml();
  lastRoomSig = currentRoom ? roomSig(currentRoom) : '';
  bind();
}

/** 房间页渲染签名：签名字段变化才值得重建 DOM */
function roomSig(r: HubRoomInfo): string {
  return [r.id, r.status, r.name, r.gameId, r.hostId, r.maxPlayers, r.isPrivate ? 1 : 0, r.code ?? '', r.scenarioId ?? '',
    r.players.map(p => p.id + ':' + ((p as any).displayName || p.name) + ':' + ((p as any).avatarUrl ?? '')).join(','),
    (r.readyPlayers ?? []).join(','), onlineIds.join(',')].join('|');
}

const accentOf = (g?: HubGameInfo): string => g?.accent ?? '#6ea8fe';

// ---------------- 认证视图 ----------------

function authHtml() {
  return `
  <div class="lob-auth-wrap">
    <div class="lob-card lob-auth">
      <div class="lob-brand"><span class="lob-brand-dot"></span>RDS Board</div>
      <h2>联机大厅</h2>
      <p class="lob-muted">请登录已有账号，和朋友来一局桌游。</p>
      <div class="lob-stack">
        <input id="name" placeholder="用户名" autocomplete="username" />
        <input id="pass" type="password" placeholder="密码" autocomplete="current-password" />
        <div class="lob-row">
          <button id="login" style="flex: 1;">登录</button>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 13px; color: var(--muted); margin-top: 4px;">
          <span>注册功能已关闭</span>
          <button id="goto-admin" style="background: none; border: none; color: var(--gold); cursor: pointer; font-size: 13px; padding: 0; text-decoration: underline;">管理员后台 →</button>
        </div>
        <div id="err" class="lob-error"></div>
      </div>
    </div>
  </div>`;
}

// ---------------- 首页：货架 + 快速加入 ----------------

function lobbyHtml() {
  const isAdmin = user && (user.role === 'admin' || user.name === 'rds');
  return `
  <header class="lob-header">
    <div class="lob-brand"><span class="lob-brand-dot"></span>RDS Board<span class="lob-muted lob-brand-sub">联机大厅</span></div>
    <div class="lob-row">
      <button id="solo" class="lob-secondary">本地单机</button>
      ${isAdmin ? '<button id="admin-open" class="lob-secondary" style="color: var(--gold); border-color: rgba(217, 180, 91, 0.4);">⚙ 管理后台</button>' : ''}
      <button id="profile-open" class="lob-userchip lob-userchip-btn" title="个人资料">${avatarChipHtml(user)}<span>${esc(displayNameOf(user))}</span></button>
      <button id="logout" class="lob-secondary">退出</button>
    </div>
  </header>
  <div class="lob-main lob-home">
    <section class="lob-primary">
      <div class="lob-section-head">
        <h2>选择游戏</h2>
        <button id="create-open" class="lob-primary-btn">＋ 创建房间</button>
      </div>
      <div class="lob-shelf" id="shelf">
        ${games.map(shelfCard).join('')}
      </div>
      <div class="lob-section-head">
        <h2>快速加入</h2>
        <span class="lob-muted" id="rooms-hint"></span>
      </div>
      <div id="rooms" class="lob-quick">加载中…</div>
    </section>
    <aside class="lob-side">
      <div class="lob-card lob-solo">
        <b>单机模式</b>
        <p class="lob-muted">不想联机？直接开一桌本地对局，与联机同一内核。</p>
        <button id="solo2" class="lob-secondary">本地单机</button>
      </div>
      <div class="lob-card">
        <b>联机说明</b>
        <p class="lob-muted">对局为 P2P（WebRTC）：房主浏览器是对局权威。全员就绪后由房主开局。</p>
      </div>
    </aside>
  </div>
  ${createModalHtml()}`;
}

function shelfCard(g: HubGameInfo) {
  const openCount = roomsCache.filter(r => r.gameId === g.id && r.status === 'open' && r.players.length < r.maxPlayers).length;
  return `
  <button class="lob-gamecard" data-game="${esc(g.id)}" style="--accent:${accentOf(g)}">
    <span class="lob-gamecard-art"></span>
    <span class="lob-gamecard-body">
      <span class="lob-gamecard-name">${esc(g.name)}</span>
      <span class="lob-gamecard-meta">${g.minPlayers}-${g.maxPlayers} 人${g.durationMin ? ' · 约 ' + g.durationMin + ' 分钟' : ''}</span>
      <span class="lob-gamecard-open">${openCount > 0 ? openCount + ' 个房间等待中' : '暂无等待中的房间'}</span>
    </span>
  </button>`;
}

function quickRow(r: HubRoomInfo) {
  const g = games.find(x => x.id === r.gameId);
  const full = r.players.length >= r.maxPlayers;
  return `
  <div class="lob-quick-row" style="--accent:${accentOf(g)}">
    <span class="lob-quick-dot"></span>
    <span class="lob-quick-name">${esc(r.name)}${r.isPrivate ? ' 🔒' : ''}</span>
    <span class="lob-quick-game">${esc(g?.name ?? r.gameId)}</span>
    <span class="lob-quick-count">${r.players.length}/${r.maxPlayers}</span>
    <span class="lob-badge ${r.status}">${r.status === 'open' ? '等待中' : '游戏中'}</span>
    <button data-join="${esc(r.id)}" ${r.status !== 'open' || full ? 'disabled' : ''}>${r.isPrivate ? '输码加入' : '加入'}</button>
  </div>`;
}

async function refreshRooms() {
  const el = document.getElementById('rooms');
  if (!el || !lobbyVisible() || !user) return;
  try {
    const rooms = await getRooms();
    const sig = rooms.map(r => r.id + r.status + r.players.length + (r.isPrivate ? 1 : 0)).join('|');
    roomsCache = rooms;
    if (sig !== roomsCacheSig) {
      roomsCacheSig = sig;
      // 阶段二：列表同时展示对局中的房间（不可加入，仅展示状态）
      const openRooms = rooms.filter(r => r.status === 'open' && r.players.length < r.maxPlayers)
        .sort((a, b) => b.players.length - a.players.length);
      const playingRooms = rooms.filter(r => r.status === 'playing')
        .sort((a, b) => b.createdAt - a.createdAt);
      const rows = openRooms.map(quickRow).join('') + playingRooms.map(quickRow).join('');
      el.innerHTML = rows
        ? rows
        : '<div class="lob-empty">暂无可加入的房间——从上面选个游戏开一桌吧。</div>';
      const hint = document.getElementById('rooms-hint');
      if (hint) hint.textContent = rooms.length ? '（' + openRooms.length + ' 个可加入' + (playingRooms.length ? '，' + playingRooms.length + ' 个对局中' : '') + '）' : '';
      const shelf = document.getElementById('shelf');
      if (shelf) shelf.innerHTML = games.map(shelfCard).join('');
    }
  } catch (e: any) { el.innerHTML = '<span class="lob-error">' + esc(e.message) + '</span>'; }
}

/** 阶段一：个人资料弹窗（render 时对所有已登录视图追加，含房间页头部入口）。 */
function profileModalHtml() {
  return `
  <div class="lob-modal-backdrop" id="profile-modal" hidden>
    <div class="lob-card lob-modal">
      <h3>个人资料</h3>
      <div class="lob-stack">
        <div class="lob-profile-row">
          <span id="pf-avatar-wrap" class="lob-seat-avatar lob-profile-avatar">${avatarChipHtml(user)}</span>
          <div class="lob-stack" style="gap:6px">
            <button id="pf-upload" class="lob-secondary">上传头像</button>
            <span class="lob-muted" style="font-size:12px">自动压缩为 256px / WebP</span>
            <input type="file" id="pf-file" accept="image/png,image/jpeg,image/webp" hidden />
          </div>
        </div>
        <label class="lob-field-label">昵称（对其他玩家展示）</label>
        <input id="pf-name" maxlength="24" placeholder="${esc(displayNameOf(user))}" />
        <p class="lob-muted" style="font-size:12px">登录名：${esc(user!.name)}（不可更改）</p>
        <div class="lob-row" style="justify-content:flex-end">
          <button id="pf-cancel" class="lob-secondary">取消</button>
          <button id="pf-save" class="lob-primary-btn">保存资料</button>
        </div>

        <div style="border-top: 1px solid var(--line); margin: 8px 0;"></div>
        <details class="lob-pass-details" style="cursor: pointer;">
          <summary style="font-weight: 600; color: var(--gold); font-size: 14px; user-select: none;">修改登录密码</summary>
          <div class="lob-stack" style="gap: 8px; margin-top: 10px;">
            <input id="pf-old-pass" type="password" placeholder="原密码 *" autocomplete="current-password" />
            <input id="pf-new-pass" type="password" placeholder="新密码（至少 6 位） *" autocomplete="new-password" />
            <input id="pf-new-pass2" type="password" placeholder="确认新密码 *" autocomplete="new-password" />
            <div id="pf-pass-err" class="lob-error" style="display: none;"></div>
            <div class="lob-row" style="justify-content: flex-end; margin-top: 4px;">
              <button id="pf-pass-submit" class="lob-secondary">确认修改密码</button>
            </div>
          </div>
        </details>
      </div>
    </div>
  </div>
`;
}

// ---------------- 创建房间模态 ----------------

function createModalHtml() {
  return `
  <div class="lob-modal-backdrop" id="create-modal" hidden>
    <div class="lob-card lob-modal">
      <h3>创建房间</h3>
      <div class="lob-stack">
        <label class="lob-field-label">游戏</label>
        <div class="lob-chips" id="cm-games">
          ${games.map((g, i) => '<button class="lob-chip' + (i === 0 ? ' on' : '') + '" data-id="' + esc(g.id) + '" style="--accent:' + accentOf(g) + '">' + esc(g.name) + '</button>').join('')}
        </div>
        <label class="lob-field-label">房间名</label>
        <input id="cm-name" placeholder="今晚开一桌" maxlength="40" />
        <label class="lob-field-label">人数上限 <span id="cm-max-label"></span></label>
        <input type="range" id="cm-max" min="2" max="6" value="4" />
        <div id="cm-variant-wrap" hidden>
          <label class="lob-field-label">开局变体</label>
          <select id="cm-variant"></select>
        </div>
        <label class="lob-check"><input type="checkbox" id="cm-private" /> 私密房（需要 6 位房间码加入）</label>
        <div class="lob-row" style="justify-content:flex-end">
          <button id="cm-cancel" class="lob-secondary">取消</button>
          <button id="cm-create" class="lob-primary-btn">创建</button>
        </div>
      </div>
    </div>
  </div>
  <div class="lob-modal-backdrop" id="code-modal" hidden>
    <div class="lob-card lob-modal">
      <h3>加入私密房</h3>
      <p class="lob-muted" id="code-hint"></p>
      <div class="lob-stack">
        <input id="code-input" placeholder="6 位房间码" maxlength="6" style="text-transform:uppercase" />
        <div class="lob-row" style="justify-content:flex-end">
          <button id="code-cancel" class="lob-secondary">取消</button>
          <button id="code-join">加入</button>
        </div>
      </div>
    </div>
  </div>`;
}

// ---------------- 房间页：座位 + 就绪 + 聊天 ----------------

function seatOf(r: HubRoomInfo, userId: string): number {
  return r.players.findIndex(p => p.id === userId);
}

function roomHtml() {
  const r = currentRoom!;
  const g = games.find(x => x.id === r.gameId);
  const isHost = r.hostId === user!.sub;
  const seat = seatOf(r, user!.sub);
  const ready = (r.readyPlayers ?? []);
  const min = g?.minPlayers ?? 1;
  const allReady = r.players.every(p => ready.includes(p.id));
  const canStart = isHost && r.status === 'open' && r.players.length >= min && allReady;
  const myReady = ready.includes(user!.sub);
  const variantLabel = r.scenarioId ? (g?.variants?.find(v => v.id === r.scenarioId)?.label ?? r.scenarioId) : '';
  return `
  <header class="lob-header">
    <div class="lob-row">
      <button id="exit-room" class="lob-secondary">← 离开房间</button>
      <h1 class="lob-room-title">${esc(r.name)}</h1>
      <span class="lob-badge ${r.status}">${r.status === 'open' ? '等待中' : '游戏中'}</span>
      ${r.isPrivate && isHost && r.code ? '<button id="copy-invite" class="lob-code-chip" title="点击复制">房间码 ' + esc(r.code) + '</button>' : ''}
    </div>
    <div class="lob-row"><button id="profile-open" class="lob-userchip lob-userchip-btn" title="个人资料">${avatarChipHtml(user)}<span>${esc(displayNameOf(user))}</span></button></div>
  </header>
  <div class="lob-main lob-room">
    <section class="lob-card lob-seats-card">
      <div class="lob-room-gameinfo" style="--accent:${accentOf(g)}">
        <b>${esc(g?.name ?? r.gameId)}</b>
        <span class="lob-muted">${r.players.length}/${r.maxPlayers} 人${variantLabel ? ' · ' + esc(variantLabel) : ''}${g?.durationMin ? ' · 约 ' + g.durationMin + ' 分钟' : ''}</span>
      </div>
      <div class="lob-seats">
        ${r.players.map((p, i) => seatCard(r, p, i, isHost)).join('')}
        ${Array.from({ length: Math.max(0, r.maxPlayers - r.players.length) }, (_, i) =>
          '<div class="lob-seat empty"><span class="lob-seat-avatar"></span><span class="lob-seat-name lob-muted">空位 p' + (r.players.length + i + 1) + '</span></div>').join('')}
      </div>
      <div class="lob-row lob-room-actions">
        ${isHost && r.status === 'open'
          ? '<button id="start-game" class="lob-primary-btn"' + (canStart ? '' : ' disabled') + '>开始游戏（' + min + '人起，需全员就绪）</button>'
            + (canStart ? '' : '<span class="lob-muted">' + (r.players.length < min ? '人数不足' : ready.length + '/' + r.players.length + ' 已就绪') + '</span>')
          : ''}
        ${!isHost && r.status === 'open'
          ? '<button id="ready-toggle" class="' + (myReady ? 'lob-secondary' : 'lob-primary-btn') + '">' + (myReady ? '✓ 已就绪（点击取消）' : '准备') + '</button>'
            + '<span class="lob-muted">' + ready.length + '/' + r.players.length + ' 已就绪，等待房主开局…</span>'
          : ''}
        ${isHost && r.status === 'playing' ? '<button id="reopen-game">再次进入对局</button>' : ''}
        ${!isHost && r.status === 'playing' ? '<button id="join-game">进入对局</button>' : ''}
      </div>
      <p class="lob-muted lob-room-note">对局为 P2P（WebRTC）：房主浏览器是对局权威，房主关闭对局窗口则对局中断。你的座位：p${seat + 1}。</p>
    </section>
    <aside class="lob-card lob-chat">
      <b>房间聊天</b>
      <div id="chat-log" class="lob-chat-log">
        ${(chatLog.get(r.id) ?? []).map(m =>
          '<div class="lob-chat-msg' + (m.self ? ' self' : '') + '"><span class="lob-chat-name">' + esc(m.self ? '你' : m.name) + '</span>' + esc(m.text) + '</div>').join('') || '<div class="lob-muted lob-chat-empty">暂无消息</div>'}
      </div>
      <div class="lob-row">
        <input id="chat-input" placeholder="说点什么…" maxlength="200" />
        <button id="chat-send">发送</button>
      </div>
    </aside>
  </div>`;
}

function seatCard(r: HubRoomInfo, p: { id: string; name: string; displayName?: string; avatarUrl?: string }, i: number, isHost: boolean) {
  const ready = (r.readyPlayers ?? []).includes(p.id);
  const isRoomHost = p.id === r.hostId;
  const me = p.id === user!.sub;
  const hostCtl = isHost && !me
    ? '<div class="lob-seat-ctl"><button data-kick="' + esc(p.id) + '" class="lob-mini lob-danger">请离</button><button data-host="' + esc(p.id) + '" class="lob-mini">转房主</button></div>'
    : '';
  const online = onlineIds.includes(p.id);
  return `
  <div class="lob-seat${ready ? ' ready' : ''}" data-seat="${esc(p.id)}">
    <span class="lob-online-dot${online ? ' on' : ''}" title="${online ? '在线' : '离线'}"></span>
    <span class="lob-seat-avatar">${p.avatarUrl ? '<img src="' + esc(p.avatarUrl) + '" alt="" loading="lazy" />' : esc(displayNameOf(p).slice(0, 1).toUpperCase())}</span>
    <span class="lob-seat-name">${esc(displayNameOf(p))}${isRoomHost ? ' <span title="房主">👑</span>' : ''}${me ? '<span class="lob-muted">（你）</span>' : ''}</span>
    <span class="lob-seat-sub">座位 p${i + 1}${r.status === 'open' ? (ready ? ' · <span class="lob-ready-tag">已就绪</span>' : ' · 未就绪') : ''}</span>
    ${hostCtl}
  </div>`;
}

async function refreshRoom() {
  if (!currentRoom || !lobbyVisible()) return;
  try {
    const fresh = await getRoom(currentRoom.id);
    if (roomSig(fresh) === lastRoomSig) { currentRoom = fresh; return; }
    currentRoom = fresh;
    render();
  } catch (e: any) {
    currentRoom = null; render(); showToast(e.message, 'error');
  }
}

// ---------------- 事件绑定 ----------------

function bind() {
  const $ = (id: string) => document.getElementById(id) as HTMLElement;
  const err = (m: string) => { const e = $('err'); if (e) e.textContent = m; };

  if (!user) {
    const doLogin = async () => {
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: ($('name') as HTMLInputElement).value, password: ($('pass') as HTMLInputElement).value }),
        });
        const body = await res.json();
        if (!res.ok) return err(body.error);
        localStorage.setItem('token', body.token);
        await boot();
      } catch (e: any) { err(e.message); }
    };
    $('login')?.addEventListener('click', doLogin);
    $('name')?.addEventListener('keydown', ev => { if (ev.key === 'Enter') doLogin(); });
    $('pass')?.addEventListener('keydown', ev => { if (ev.key === 'Enter') doLogin(); });
    $('goto-admin')?.addEventListener('click', () => {
      if (onAdmin) onAdmin();
      else location.hash = '#admin';
    });
    return;
  }

  $('admin-open')?.addEventListener('click', () => {
    if (onAdmin) onAdmin();
    else location.hash = '#admin';
  });

  // ---- 阶段一：个人资料弹窗 ----
  $('profile-open')?.addEventListener('click', () => {
    const nameInput = $('pf-name') as HTMLInputElement;
    nameInput.value = displayNameOf(user);
    $('pf-avatar-wrap').innerHTML = avatarChipHtml(user);
    pendingAvatar = null;
    ($('profile-modal') as HTMLElement).hidden = false;
    nameInput.focus();
  });
  $('pf-cancel')?.addEventListener('click', () => { ($('profile-modal') as HTMLElement).hidden = true; });
  $('profile-modal')?.addEventListener('click', ev => { if (ev.target === $('profile-modal')) ($('profile-modal') as HTMLElement).hidden = true; });
  $('pf-upload')?.addEventListener('click', () => ($('pf-file') as HTMLInputElement).click());
  $('pf-file')?.addEventListener('change', async () => {
    const input = $('pf-file') as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      pendingAvatar = await compressImage(file);
      $('pf-avatar-wrap').innerHTML = '<img class="lob-avatar" src="' + pendingAvatar.dataUrl + '" alt="" />';
      showToast('头像已就绪，点保存生效', 'success');
    } catch (e: any) { showToast(e.message || '图片处理失败', 'error'); }
    input.value = '';
  });
  $('pf-save')?.addEventListener('click', async () => {
    const name = (($('pf-name') as HTMLInputElement).value || displayNameOf(user)).trim();
    try {
      if (pendingAvatar) {
        const { avatarUrl } = await uploadAvatar(pendingAvatar.blob);
        if (user) user.avatarUrl = avatarUrl;
      }
      if (name !== displayNameOf(user)) {
        const p = await updateDisplayName(name);
        if (user) user.displayName = p.displayName;
      }
      pendingAvatar = null;
      ($('profile-modal') as HTMLElement).hidden = true;
      // 房间页 seat 卡与大厅列表里的展示名即时刷新
      if (currentRoom) { try { currentRoom = await getRoom(currentRoom.id); } catch { /* 忽略 */ } }
      roomsCacheSig = '';
      render();
      showToast('资料已更新', 'success');
    } catch (e: any) { showToast(e.message, 'error'); }
  });

  $('pf-pass-submit')?.addEventListener('click', async () => {
    const oldPass = (($('pf-old-pass') as HTMLInputElement)?.value || '').trim();
    const newPass = ($('pf-new-pass') as HTMLInputElement)?.value || '';
    const newPass2 = ($('pf-new-pass2') as HTMLInputElement)?.value || '';
    const errEl = $('pf-pass-err') as HTMLElement;

    if (!oldPass) {
      if (errEl) { errEl.textContent = '请输入原密码'; errEl.style.display = 'block'; }
      return;
    }
    if (!newPass || newPass.length < 6) {
      if (errEl) { errEl.textContent = '新密码长度至少需 6 位'; errEl.style.display = 'block'; }
      return;
    }
    if (newPass !== newPass2) {
      if (errEl) { errEl.textContent = '两次输入的新密码不一致'; errEl.style.display = 'block'; }
      return;
    }
    if (newPass === oldPass) {
      if (errEl) { errEl.textContent = '新密码不能与原密码相同'; errEl.style.display = 'block'; }
      return;
    }

    try {
      await changeMyPassword(oldPass, newPass);
      const o = $('pf-old-pass') as HTMLInputElement; if (o) o.value = '';
      const n1 = $('pf-new-pass') as HTMLInputElement; if (n1) n1.value = '';
      const n2 = $('pf-new-pass2') as HTMLInputElement; if (n2) n2.value = '';
      if (errEl) errEl.style.display = 'none';
      showToast('密码修改成功，请牢记新密码', 'success');
      ($('profile-modal') as HTMLElement).hidden = true;
    } catch (e: any) {
      if (errEl) { errEl.textContent = e.message || '修改密码失败'; errEl.style.display = 'block'; }
      showToast(e.message || '修改密码失败', 'error');
    }
  });

  $('logout')?.addEventListener('click', () => { localStorage.removeItem('token'); user = null; currentRoom = null; closeWs(); render(); });
  $('solo')?.addEventListener('click', () => onEnterGame?.({ query: '' }));
  $('solo2')?.addEventListener('click', () => onEnterGame?.({ query: '' }));

  if (currentRoom) { bindRoom(); return; }

  // ---- 首页 ----
  $('create-open')?.addEventListener('click', () => openCreateModal());
  document.getElementById('shelf')?.addEventListener('click', ev => {
    const card = (ev.target as HTMLElement).closest<HTMLElement>('[data-game]');
    if (card) openCreateModal(card.dataset.game);
  });
  $('cm-cancel')?.addEventListener('click', () => { $('create-modal').hidden = true; });
  $('create-modal')?.addEventListener('click', ev => { if (ev.target === $('create-modal')) $('create-modal').hidden = true; });
  document.getElementById('cm-games')?.addEventListener('click', ev => {
    const chip = (ev.target as HTMLElement).closest<HTMLElement>('.lob-chip');
    if (chip?.dataset.id) syncCreateModal(chip.dataset.id);
  });

  $('cm-create')?.addEventListener('click', async () => {
    const gameId = document.querySelector('#cm-games .lob-chip.on')?.getAttribute('data-id') ?? games[0]?.id;
    const name = ($('cm-name') as HTMLInputElement).value;
    const maxPlayers = Number(($('cm-max') as HTMLInputElement).value);
    const isPrivate = ($('cm-private') as HTMLInputElement).checked;
    const variantSel = $('cm-variant') as HTMLSelectElement | null;
    const scenarioId = variantSel && !variantSel.closest('[hidden]') ? (variantSel.value || undefined) : undefined;
    try {
      const room = await createRoom(name, gameId, { maxPlayers, isPrivate, scenarioId });
      showToast('房间已创建', 'success');
      $('create-modal').hidden = true;
      currentRoom = room; render();
      wsSend({ t: 'join-room', roomId: room.id });
    } catch (e: any) { showToast(e.message, 'error'); }
  });

  // 快速加入 / 私密码模态
  let codeRoomId = '';
  $('code-cancel')?.addEventListener('click', () => { $('code-modal').hidden = true; });
  $('code-join')?.addEventListener('click', async () => {
    try {
      currentRoom = await joinRoom(codeRoomId, ($('code-input') as HTMLInputElement).value.trim().toUpperCase());
      $('code-modal').hidden = true;
      render();
      wsSend({ t: 'join-room', roomId: currentRoom.id });
    } catch (e: any) { showToast(e.message, 'error'); }
  });
  $('rooms')?.addEventListener('click', async (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-join]');
    if (!btn || (btn as HTMLButtonElement).disabled) return;
    const id = btn.dataset.join!;
    const r = roomsCache.find(x => x.id === id);
    if (r?.isPrivate) {
      codeRoomId = id;
      $('code-hint').textContent = '「' + r.name + '」需要房间码。';
      ($('code-input') as HTMLInputElement).value = '';
      $('code-modal').hidden = false;
      $('code-input').focus();
      return;
    }
    try { currentRoom = await joinRoom(id); render(); wsSend({ t: 'join-room', roomId: id }); }
    catch (e: any) { showToast(e.message, 'error'); }
  });

  refreshRooms();
  stopTimer('list');
  roomsTimer = setInterval(refreshRooms, wsHealthy ? 10000 : 5000);
}

/** 创建模态：选中游戏 → 联动人数滑条与变体 */
function openCreateModal(selectGame?: string) {
  const modal = document.getElementById('create-modal');
  if (!modal || !games.length) return;
  syncCreateModal(selectGame ?? games[0].id);
  (document.getElementById('cm-name') as HTMLInputElement).value = '';
  (document.getElementById('cm-private') as HTMLInputElement).checked = false;
  modal.hidden = false;
  document.getElementById('cm-name')?.focus();
}

function syncCreateModal(gameId: string) {
  const g = games.find(x => x.id === gameId) ?? games[0];
  document.querySelectorAll('#cm-games .lob-chip').forEach(el => { el.classList.toggle('on', (el as HTMLElement).dataset.id === g.id); });
  const range = document.getElementById('cm-max') as HTMLInputElement;
  range.min = String(g.minPlayers); range.max = String(g.maxPlayers); range.value = String(g.maxPlayers);
  const label = document.getElementById('cm-max-label')!;
  label.textContent = range.value + ' 人（' + g.minPlayers + '-' + g.maxPlayers + '）';
  range.oninput = () => { label.textContent = range.value + ' 人（' + g.minPlayers + '-' + g.maxPlayers + '）'; };
  const wrap = document.getElementById('cm-variant-wrap')!;
  const sel = document.getElementById('cm-variant') as HTMLSelectElement;
  if (g.variants?.length) {
    wrap.hidden = false;
    sel.innerHTML = '<option value="">标准</option>' + g.variants.map(v => '<option value="' + esc(v.id) + '">' + esc(v.label) + '</option>').join('');
  } else { wrap.hidden = true; sel.innerHTML = ''; }
}

function bindRoom() {
  const $ = (id: string) => document.getElementById(id) as HTMLElement;
  const r0 = currentRoom!;
  const isHost = r0.hostId === user!.sub;

  $('exit-room')?.addEventListener('click', async () => {
    try { await leaveRoom(r0.id); } catch (e: any) { showToast(e.message, 'error'); return; }
    wsSend({ t: 'leave-room' });
    currentRoom = null; onlineIds = []; render();
  });
  $('copy-invite')?.addEventListener('click', async () => {
    const text = 'RDS Board 房间号 ' + r0.id + (r0.code ? '，房间码 ' + r0.code : '') + '，来一局 ' + (games.find(g => g.id === r0.gameId)?.name ?? '');
    try { await navigator.clipboard.writeText(text); showToast('邀请信息已复制', 'success'); }
    catch { showToast(text, 'info'); }
  });

  $('start-game')?.addEventListener('click', async () => {
    if (!currentRoom) return;
    try {
      currentRoom = await setRoomStatus(r0.id, 'playing');
      onEnterGame?.({ query: gameQuery(currentRoom, 'host') });
    } catch (e: any) { showToast(e.message, 'error'); }
  });
  $('reopen-game')?.addEventListener('click', () => onEnterGame?.({ query: gameQuery(currentRoom ?? r0, 'host') }));
  $('join-game')?.addEventListener('click', () => onEnterGame?.({ query: gameQuery(currentRoom ?? r0, 'guest') }));
  $('ready-toggle')?.addEventListener('click', async () => {
    const myReady = (currentRoom?.readyPlayers ?? []).includes(user!.sub);
    try { currentRoom = await setReady(r0.id, !myReady); render(); }
    catch (e: any) { showToast(e.message, 'error'); }
  });

  // 房主座位操作（事件委托：seat 卡片随刷新重建）
  document.querySelector('.lob-seats')?.addEventListener('click', async ev => {
    const kick = (ev.target as HTMLElement).closest<HTMLElement>('[data-kick]');
    const host = (ev.target as HTMLElement).closest<HTMLElement>('[data-host]');
    try {
      if (kick) { currentRoom = await kickPlayer(r0.id, kick.dataset.kick!); render(); }
      else if (host) { currentRoom = await transferHost(r0.id, host.dataset.host!); render(); showToast('已转移房主', 'success'); }
    } catch (e: any) { showToast(e.message, 'error'); }
  });

  // 聊天
  const sendChat = () => {
    const input = $('chat-input') as HTMLInputElement;
    const text = input.value.trim();
    if (!text || !currentRoom) return;
    wsSend({ t: 'lobby-chat', roomId: currentRoom.id, text });
    input.value = '';
  };
  $('chat-send')?.addEventListener('click', sendChat);
  $('chat-input')?.addEventListener('keydown', ev => { if (ev.key === 'Enter') sendChat(); });

  stopTimer('list');
  stopTimer('room');
  roomTimer = setInterval(refreshRoom, wsHealthy ? 8000 : 3000);
}

/**
 * 网络对局启动参数契约见 docs/LOBBY-INTEGRATION.md（同页切换而非 window.open）。
 *
 * `authority=server`（默认）：中心模式，服务器持有唯一权威引擎，座位由服务器
 * 按大厅玩家顺序下发；`role` 只影响 UI 文案，不再决定权威位置，也不需要
 * WebRTC 直连（因此不再需要 `hostId`）。
 * 传 `authority=p2p` 可回退旧的房主浏览器权威直连模式。
 */
const NET_AUTHORITY: 'server' | 'p2p' = 'server';

function gameQuery(r: HubRoomInfo, role: 'host' | 'guest'): string {
  const q = new URLSearchParams({
    game: r.gameId,
    hub: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws',
    roomId: r.id,
    token: localStorage.getItem('token') ?? '',
    role,
    authority: NET_AUTHORITY,
    playerId: 'p' + (seatOf(r, user!.sub) + 1),
  });
  if (NET_AUTHORITY === 'p2p' && role === 'guest') q.set('hostId', r.hostId);
  if (r.scenarioId) q.set('scenario', r.scenarioId);
  // 阶段一：座位 → 昵称/头像，房主开局时写进内核 Player 同步全员。
  const roster: Record<string, { name: string; avatarUrl?: string }> = {};
  r.players.forEach((p, i) => {
    const name = (p as any).displayName || p.name;
    const avatarUrl = (p as any).avatarUrl;
    roster['p' + (i + 1)] = avatarUrl ? { name, avatarUrl } : { name };
  });
  q.set('roster', JSON.stringify(roster));
  // 阶段二：座位 → hub userId，presence 反映射回玩家卡片在线点用。
  const owners: Record<string, string> = {};
  r.players.forEach((pl, i) => { owners['p' + (i + 1)] = pl.id; });
  q.set('owners', JSON.stringify(owners));
  return q.toString();
}

async function boot() {
  games = await getGames();
  const token = localStorage.getItem('token');
  if (token) {
    try {
      const p: UserProfile = await me();
      user = { sub: p.id, name: p.name, displayName: p.displayName, avatarUrl: p.avatarUrl, role: p.role };
    } catch { localStorage.removeItem('token'); }
  }
  if (user) { wsWanted = true; openWs(); }
  render();
}


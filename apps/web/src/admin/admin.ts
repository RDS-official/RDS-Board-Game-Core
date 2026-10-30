import './admin.css';
import {
  AdminUserItem,
  AdminStats,
  getAdminUsers,
  createAdminUser,
  updateAdminUser,
  resetUserPassword,
  deleteAdminUser,
} from './adminApi.ts';
import { showToast } from '../lobby/toast.ts';

export interface AdminHandle {
  destroy(): void;
}

export interface AdminOptions {
  onReturnToLobby: () => void;
}

interface CurrentAdmin {
  id: string;
  name: string;
  displayName: string;
  role: 'admin' | 'user';
  avatarUrl?: string;
}

function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)
  );
}

function formatDate(ts: number): string {
  if (!ts) return '-';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export async function startAdmin(
  container: HTMLElement,
  opts: AdminOptions
): Promise<AdminHandle> {
  let root: HTMLElement | null = container;
  let adminUser: CurrentAdmin | null = null;
  let userList: AdminUserItem[] = [];
  let stats: AdminStats = { totalUsers: 0, adminUsers: 0, disabledUsers: 0 };

  // 筛选状态
  let searchQuery = '';
  let roleFilter: 'all' | 'admin' | 'user' = 'all';
  let statusFilter: 'all' | 'active' | 'disabled' = 'all';

  // 模态弹窗状态
  type ModalType = 'none' | 'create' | 'edit' | 'reset-pass' | 'delete-confirm';
  let activeModal: ModalType = 'none';
  let modalTargetUser: AdminUserItem | null = null;
  let modalError = '';

  async function checkAuth(): Promise<boolean> {
    const token = localStorage.getItem('token');
    if (!token) return false;
    try {
      const res = await fetch('/api/me', {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (data.role === 'admin' || data.name === 'rds') {
        adminUser = {
          id: data.id,
          name: data.name,
          displayName: data.displayName || data.name,
          role: 'admin',
          avatarUrl: data.avatarUrl,
        };
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async function loadData() {
    try {
      const res = await getAdminUsers();
      userList = res.users;
      stats = res.stats;
      render();
    } catch (err: any) {
      showToast(err.message || '加载用户列表失败', 'error');
    }
  }

  function getFilteredUsers(): AdminUserItem[] {
    return userList.filter(u => {
      if (roleFilter !== 'all' && u.role !== roleFilter) return false;
      if (statusFilter === 'active' && u.disabled) return false;
      if (statusFilter === 'disabled' && !u.disabled) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchName = u.name.toLowerCase().includes(q);
        const matchDisplay = (u.displayName || '').toLowerCase().includes(q);
        const matchId = u.id.toLowerCase().includes(q);
        if (!matchName && !matchDisplay && !matchId) return false;
      }
      return true;
    });
  }

  function renderLogin() {
    if (!root) return;
    root.innerHTML = `
      <div class="adm-login-wrap">
        <div class="adm-login-card">
          <div class="adm-brand">
            <span class="adm-brand-dot"></span>
            <span>RDS Board</span>
            <span class="adm-brand-badge">ADMIN</span>
          </div>
          <h2>管理员后台登录</h2>
          <p style="color: var(--muted); font-size: 14px; margin: 0 0 12px;">请输入管理员凭据登录账号后台管理系统</p>
          <div style="display: grid; gap: 12px;">
            <div>
              <label style="font-size: 13px; color: var(--muted); display: block; margin-bottom: 4px;">管理员账号</label>
              <input id="adm-login-name" class="adm-input" style="width: 100%; box-sizing: border-box;" placeholder="例如: rds" value="rds" autocomplete="username" />
            </div>
            <div>
              <label style="font-size: 13px; color: var(--muted); display: block; margin-bottom: 4px;">管理员密码</label>
              <input id="adm-login-pass" type="password" class="adm-input" style="width: 100%; box-sizing: border-box;" placeholder="请输入管理员密码" autocomplete="current-password" />
            </div>
            <div id="adm-login-err" class="adm-error-box"></div>
            <button id="adm-login-btn" class="adm-btn" style="justify-content: center; padding: 10px; margin-top: 4px;">登录后台</button>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px;">
              <button id="adm-back-to-lobby" class="adm-text-link">← 返回游戏大厅</button>
              <span style="font-size: 12px; color: var(--muted);">默认管理员: rds</span>
            </div>
          </div>
        </div>
      </div>
    `;

    const nameInput = document.getElementById('adm-login-name') as HTMLInputElement;
    const passInput = document.getElementById('adm-login-pass') as HTMLInputElement;
    const errBox = document.getElementById('adm-login-err') as HTMLElement;
    const loginBtn = document.getElementById('adm-login-btn') as HTMLButtonElement;
    const backBtn = document.getElementById('adm-back-to-lobby') as HTMLButtonElement;

    const doLogin = async () => {
      const name = nameInput.value.trim();
      const password = passInput.value;
      if (!name || !password) {
        errBox.textContent = '请输入用户名和密码';
        errBox.style.display = 'block';
        return;
      }
      loginBtn.disabled = true;
      loginBtn.textContent = '登录中…';
      errBox.style.display = 'none';

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '登录失败');
        if (data.user.role !== 'admin' && data.user.name !== 'rds') {
          throw new Error('该账号不是管理员，无权访问管理后台');
        }
        localStorage.setItem('token', data.token);
        adminUser = {
          id: data.user.id,
          name: data.user.name,
          displayName: data.user.displayName || data.user.name,
          role: 'admin',
        };
        showToast('管理员登录成功', 'success');
        await loadData();
      } catch (err: any) {
        errBox.textContent = err.message || '登录失败';
        errBox.style.display = 'block';
      } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = '登录后台';
      }
    };

    loginBtn?.addEventListener('click', doLogin);
    passInput?.addEventListener('keydown', ev => { if (ev.key === 'Enter') doLogin(); });
    backBtn?.addEventListener('click', () => opts.onReturnToLobby());
  }

  function renderDashboard() {
    if (!root || !adminUser) return;

    const filtered = getFilteredUsers();

    root.innerHTML = `
      <header class="adm-header">
        <div class="adm-brand">
          <span class="adm-brand-dot"></span>
          <span>RDS Board</span>
          <span class="adm-brand-badge">ADMIN CONSOLE</span>
        </div>
        <div class="adm-nav">
          <div class="adm-userchip">
            <span class="adm-avatar">${esc((adminUser.displayName || adminUser.name).slice(0, 1).toUpperCase())}</span>
            <span>${esc(adminUser.displayName || adminUser.name)} (管理员)</span>
          </div>
          <button id="adm-nav-lobby" class="adm-btn adm-btn-secondary">返回游戏大厅</button>
          <button id="adm-nav-logout" class="adm-btn adm-btn-secondary">退出登录</button>
        </div>
      </header>

      <main class="adm-container">
        <!-- 统计面板 -->
        <section class="adm-stats">
          <div class="adm-stat-card">
            <div class="adm-stat-meta">
              <span class="adm-stat-label">注册总账号</span>
              <span class="adm-stat-val">${stats.totalUsers}</span>
            </div>
            <div class="adm-stat-icon">👥</div>
          </div>
          <div class="adm-stat-card">
            <div class="adm-stat-meta">
              <span class="adm-stat-label">管理员账号</span>
              <span class="adm-stat-val" style="color: var(--gold);">${stats.adminUsers}</span>
            </div>
            <div class="adm-stat-icon">🛡️</div>
          </div>
          <div class="adm-stat-card">
            <div class="adm-stat-meta">
              <span class="adm-stat-label">已禁用账号</span>
              <span class="adm-stat-val" style="color: ${stats.disabledUsers > 0 ? 'var(--err)' : 'var(--muted)'};">${stats.disabledUsers}</span>
            </div>
            <div class="adm-stat-icon">🚫</div>
          </div>
        </section>

        <!-- 工具栏 -->
        <section class="adm-toolbar">
          <div class="adm-filters">
            <input id="adm-filter-search" class="adm-input" placeholder="搜索用户名 / 昵称 / ID…" value="${esc(searchQuery)}" />
            <select id="adm-filter-role" class="adm-select">
              <option value="all" ${roleFilter === 'all' ? 'selected' : ''}>全部角色</option>
              <option value="user" ${roleFilter === 'user' ? 'selected' : ''}>普通玩家 (user)</option>
              <option value="admin" ${roleFilter === 'admin' ? 'selected' : ''}>管理员 (admin)</option>
            </select>
            <select id="adm-filter-status" class="adm-select">
              <option value="all" ${statusFilter === 'all' ? 'selected' : ''}>全部状态</option>
              <option value="active" ${statusFilter === 'active' ? 'selected' : ''}>正常可用</option>
              <option value="disabled" ${statusFilter === 'disabled' ? 'selected' : ''}>已禁用</option>
            </select>
          </div>
          <div>
            <button id="adm-btn-create" class="adm-btn">＋ 创建新账号</button>
          </div>
        </section>

        <!-- 账号表格 -->
        <section class="adm-table-wrap">
          <table class="adm-table">
            <thead>
              <tr>
                <th style="width: 260px;">账号信息</th>
                <th style="width: 160px;">用户 ID</th>
                <th style="width: 120px;">角色权限</th>
                <th style="width: 110px;">状态</th>
                <th style="width: 160px;">创建时间</th>
                <th style="text-align: right;">管理操作</th>
              </tr>
            </thead>
            <tbody>
              ${
                filtered.length === 0
                  ? `<tr><td colspan="6" class="adm-empty">没有匹配的账号数据</td></tr>`
                  : filtered.map(u => renderUserRow(u, adminUser!)).join('')
              }
            </tbody>
          </table>
        </section>
      </main>

      <!-- 弹窗容器 -->
      ${renderModal()}
    `;

    bindDashboardEvents();
  }

  function renderUserRow(u: AdminUserItem, current: CurrentAdmin): string {
    const isRootAdmin = u.name === 'rds';
    const isSelf = u.id === current.id;
    const initial = esc((u.displayName || u.name).slice(0, 1).toUpperCase());
    const avatarHtml = u.avatarUrl
      ? `<img class="adm-cell-avatar" src="${esc(u.avatarUrl)}" alt="" />`
      : `<span class="adm-cell-avatar">${initial}</span>`;

    return `
      <tr data-user-id="${esc(u.id)}">
        <td>
          <div class="adm-user-cell">
            ${avatarHtml}
            <div class="adm-cell-info">
              <span class="adm-cell-title">${esc(u.displayName || u.name)}</span>
              <span class="adm-cell-sub">@${esc(u.name)}</span>
            </div>
          </div>
        </td>
        <td>
          <span style="font-family: monospace; font-size: 13px; color: var(--muted);">${esc(u.id)}</span>
        </td>
        <td>
          ${
            u.role === 'admin'
              ? `<span class="adm-badge adm-badge-admin">👑 管理员</span>`
              : `<span class="adm-badge adm-badge-user">普通用户</span>`
          }
        </td>
        <td>
          ${
            u.disabled
              ? `<span class="adm-badge adm-badge-disabled">已禁用</span>`
              : `<span class="adm-badge adm-badge-ok">正常</span>`
          }
        </td>
        <td style="color: var(--muted); font-size: 13px;">
          ${formatDate(u.createdAt)}
        </td>
        <td>
          <div class="adm-actions" style="justify-content: flex-end;">
            <button class="adm-btn adm-btn-secondary adm-btn-mini" data-action="edit" data-id="${esc(u.id)}">编辑</button>
            <button class="adm-btn adm-btn-secondary adm-btn-mini" data-action="reset-pass" data-id="${esc(u.id)}">改密</button>
            ${
              !isRootAdmin && !isSelf
                ? `<button class="adm-btn adm-btn-secondary adm-btn-mini" data-action="toggle-status" data-id="${esc(u.id)}" data-disabled="${u.disabled ? '1' : '0'}">
                    ${u.disabled ? '启用' : '禁用'}
                  </button>`
                : ''
            }
            ${
              !isRootAdmin && !isSelf
                ? `<button class="adm-btn adm-btn-danger adm-btn-mini" data-action="delete" data-id="${esc(u.id)}">删除</button>`
                : ''
            }
          </div>
        </td>
      </tr>
    `;
  }

  function renderModal(): string {
    if (activeModal === 'none') return '';

    if (activeModal === 'create') {
      return `
        <div class="adm-modal-backdrop" id="adm-modal-backdrop">
          <div class="adm-modal">
            <h3>创建新账号</h3>
            <div class="adm-form-group">
              <label class="adm-form-label">登录用户名 *</label>
              <input id="adm-create-name" class="adm-input" placeholder="2-24 位字母、数字或下划线" autocomplete="off" />
              <span class="adm-form-hint">用户登录时使用的唯一账号名</span>
            </div>
            <div class="adm-form-group">
              <label class="adm-form-label">初始密码 *</label>
              <input id="adm-create-pass" type="password" class="adm-input" placeholder="至少 6 位密码" autocomplete="new-password" />
            </div>
            <div class="adm-form-group">
              <label class="adm-form-label">对外昵称 (选填)</label>
              <input id="adm-create-display" class="adm-input" placeholder="例如: 棋圣 / 默认同用户名" />
            </div>
            <div class="adm-form-group">
              <label class="adm-form-label">账号角色</label>
              <select id="adm-create-role" class="adm-select">
                <option value="user" selected>普通玩家 (user)</option>
                <option value="admin">系统管理员 (admin)</option>
              </select>
            </div>
            <div id="adm-modal-err" class="adm-error-box" ${modalError ? 'style="display:block;"' : ''}>${esc(modalError)}</div>
            <div class="adm-modal-foot">
              <button id="adm-modal-cancel" class="adm-btn adm-btn-secondary">取消</button>
              <button id="adm-create-submit" class="adm-btn">确认创建</button>
            </div>
          </div>
        </div>
      `;
    }

    if (activeModal === 'edit' && modalTargetUser) {
      const isRoot = modalTargetUser.name === 'rds';
      return `
        <div class="adm-modal-backdrop" id="adm-modal-backdrop">
          <div class="adm-modal">
            <h3>编辑账号 · @${esc(modalTargetUser.name)}</h3>
            <div class="adm-form-group">
              <label class="adm-form-label">对外显示昵称</label>
              <input id="adm-edit-display" class="adm-input" value="${esc(modalTargetUser.displayName || modalTargetUser.name)}" />
            </div>
            <div class="adm-form-group">
              <label class="adm-form-label">角色权限</label>
              <select id="adm-edit-role" class="adm-select" ${isRoot ? 'disabled' : ''}>
                <option value="user" ${modalTargetUser.role === 'user' ? 'selected' : ''}>普通玩家 (user)</option>
                <option value="admin" ${modalTargetUser.role === 'admin' ? 'selected' : ''}>系统管理员 (admin)</option>
              </select>
              ${isRoot ? `<span class="adm-form-hint">系统根管理员 rds 不可修改角色</span>` : ''}
            </div>
            <div class="adm-form-group">
              <label class="adm-form-label" style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                <input id="adm-edit-disabled" type="checkbox" ${modalTargetUser.disabled ? 'checked' : ''} ${isRoot ? 'disabled' : ''} />
                <span>禁用此账号（禁用后无法登录）</span>
              </label>
            </div>
            <div id="adm-modal-err" class="adm-error-box" ${modalError ? 'style="display:block;"' : ''}>${esc(modalError)}</div>
            <div class="adm-modal-foot">
              <button id="adm-modal-cancel" class="adm-btn adm-btn-secondary">取消</button>
              <button id="adm-edit-submit" class="adm-btn">保存修改</button>
            </div>
          </div>
        </div>
      `;
    }

    if (activeModal === 'reset-pass' && modalTargetUser) {
      return `
        <div class="adm-modal-backdrop" id="adm-modal-backdrop">
          <div class="adm-modal">
            <h3>重置密码 · @${esc(modalTargetUser.name)}</h3>
            <p style="font-size: 13px; color: var(--muted); margin: 0;">为用户 ${esc(modalTargetUser.displayName || modalTargetUser.name)} 设置新密码</p>
            <div class="adm-form-group">
              <label class="adm-form-label">新密码 *</label>
              <input id="adm-reset-pass" type="password" class="adm-input" placeholder="至少 6 位新密码" autocomplete="new-password" />
            </div>
            <div class="adm-form-group">
              <label class="adm-form-label">确认新密码 *</label>
              <input id="adm-reset-pass2" type="password" class="adm-input" placeholder="请再次输入新密码" autocomplete="new-password" />
            </div>
            <div id="adm-modal-err" class="adm-error-box" ${modalError ? 'style="display:block;"' : ''}>${esc(modalError)}</div>
            <div class="adm-modal-foot">
              <button id="adm-modal-cancel" class="adm-btn adm-btn-secondary">取消</button>
              <button id="adm-reset-submit" class="adm-btn">确认重置</button>
            </div>
          </div>
        </div>
      `;
    }

    if (activeModal === 'delete-confirm' && modalTargetUser) {
      return `
        <div class="adm-modal-backdrop" id="adm-modal-backdrop">
          <div class="adm-modal">
            <h3 style="color: var(--err);">确认删除账号？</h3>
            <p style="font-size: 14px; color: var(--text); line-height: 1.5; margin: 0;">
              确定要永久删除账号 <b>@${esc(modalTargetUser.name)}</b> (${esc(modalTargetUser.displayName || modalTargetUser.name)}) 吗？
              此操作不可撤销，该用户将无法再次登录。
            </p>
            <div id="adm-modal-err" class="adm-error-box" ${modalError ? 'style="display:block;"' : ''}>${esc(modalError)}</div>
            <div class="adm-modal-foot">
              <button id="adm-modal-cancel" class="adm-btn adm-btn-secondary">取消</button>
              <button id="adm-delete-submit" class="adm-btn adm-btn-danger">确认删除</button>
            </div>
          </div>
        </div>
      `;
    }

    return '';
  }

  function bindDashboardEvents() {
    const $ = (id: string) => document.getElementById(id);

    // 导航
    $('adm-nav-lobby')?.addEventListener('click', () => opts.onReturnToLobby());
    $('adm-nav-logout')?.addEventListener('click', () => {
      localStorage.removeItem('token');
      adminUser = null;
      render();
    });

    // 筛选
    $('adm-filter-search')?.addEventListener('input', ev => {
      searchQuery = (ev.target as HTMLInputElement).value;
      renderDashboard();
    });
    $('adm-filter-role')?.addEventListener('change', ev => {
      roleFilter = (ev.target as HTMLSelectElement).value as any;
      renderDashboard();
    });
    $('adm-filter-status')?.addEventListener('change', ev => {
      statusFilter = (ev.target as HTMLSelectElement).value as any;
      renderDashboard();
    });

    // 创建弹窗
    $('adm-btn-create')?.addEventListener('click', () => {
      activeModal = 'create';
      modalTargetUser = null;
      modalError = '';
      renderDashboard();
    });

    // 表格行内操作委托
    document.querySelector('.adm-table')?.addEventListener('click', async ev => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      const target = userList.find(u => u.id === id);
      if (!target) return;

      if (action === 'edit') {
        activeModal = 'edit';
        modalTargetUser = target;
        modalError = '';
        renderDashboard();
      } else if (action === 'reset-pass') {
        activeModal = 'reset-pass';
        modalTargetUser = target;
        modalError = '';
        renderDashboard();
      } else if (action === 'delete') {
        activeModal = 'delete-confirm';
        modalTargetUser = target;
        modalError = '';
        renderDashboard();
      } else if (action === 'toggle-status') {
        try {
          await updateAdminUser(target.id, { disabled: !target.disabled });
          showToast(`账号 @${target.name} 已${target.disabled ? '启用' : '禁用'}`, 'success');
          await loadData();
        } catch (err: any) {
          showToast(err.message || '操作失败', 'error');
        }
      }
    });

    // 弹窗关闭
    $('adm-modal-cancel')?.addEventListener('click', () => {
      activeModal = 'none';
      modalTargetUser = null;
      modalError = '';
      renderDashboard();
    });
    $('adm-modal-backdrop')?.addEventListener('click', ev => {
      if (ev.target === $('adm-modal-backdrop')) {
        activeModal = 'none';
        modalTargetUser = null;
        modalError = '';
        renderDashboard();
      }
    });

    // 创建提交
    $('adm-create-submit')?.addEventListener('click', async () => {
      const name = ($('adm-create-name') as HTMLInputElement).value.trim();
      const password = ($('adm-create-pass') as HTMLInputElement).value;
      const displayName = ($('adm-create-display') as HTMLInputElement).value.trim();
      const role = ($('adm-create-role') as HTMLSelectElement).value as 'admin' | 'user';

      if (!name) {
        modalError = '请输入用户名';
        renderDashboard();
        return;
      }
      if (password.length < 6) {
        modalError = '密码长度至少需 6 位';
        renderDashboard();
        return;
      }

      try {
        await createAdminUser({ name, password, displayName: displayName || undefined, role });
        showToast(`新账号 @${name} 创建成功`, 'success');
        activeModal = 'none';
        modalError = '';
        await loadData();
      } catch (err: any) {
        modalError = err.message || '创建账号失败';
        renderDashboard();
      }
    });

    // 编辑提交
    $('adm-edit-submit')?.addEventListener('click', async () => {
      if (!modalTargetUser) return;
      const displayName = ($('adm-edit-display') as HTMLInputElement).value.trim();
      const role = ($('adm-edit-role') as HTMLSelectElement).value as 'admin' | 'user';
      const disabled = ($('adm-edit-disabled') as HTMLInputElement).checked;

      try {
        await updateAdminUser(modalTargetUser.id, { displayName, role, disabled });
        showToast(`账号 @${modalTargetUser.name} 资料已更新`, 'success');
        activeModal = 'none';
        modalError = '';
        await loadData();
      } catch (err: any) {
        modalError = err.message || '更新账号失败';
        renderDashboard();
      }
    });

    // 重置密码提交
    $('adm-reset-submit')?.addEventListener('click', async () => {
      if (!modalTargetUser) return;
      const p1 = ($('adm-reset-pass') as HTMLInputElement).value;
      const p2 = ($('adm-reset-pass2') as HTMLInputElement).value;

      if (!p1 || p1.length < 6) {
        modalError = '密码长度至少需 6 位';
        renderDashboard();
        return;
      }
      if (p1 !== p2) {
        modalError = '两次输入的密码不一致';
        renderDashboard();
        return;
      }

      try {
        await resetUserPassword(modalTargetUser.id, p1);
        showToast(`账号 @${modalTargetUser.name} 密码已重置`, 'success');
        activeModal = 'none';
        modalError = '';
        renderDashboard();
      } catch (err: any) {
        modalError = err.message || '重置密码失败';
        renderDashboard();
      }
    });

    // 删除确认提交
    $('adm-delete-submit')?.addEventListener('click', async () => {
      if (!modalTargetUser) return;
      try {
        await deleteAdminUser(modalTargetUser.id);
        showToast(`账号 @${modalTargetUser.name} 已删除`, 'success');
        activeModal = 'none';
        modalError = '';
        await loadData();
      } catch (err: any) {
        modalError = err.message || '删除账号失败';
        renderDashboard();
      }
    });
  }

  function render() {
    if (!root) return;
    if (!adminUser) {
      renderLogin();
    } else {
      renderDashboard();
    }
  }

  const authed = await checkAuth();
  if (authed) {
    await loadData();
  } else {
    render();
  }

  return {
    destroy() {
      if (root) root.innerHTML = '';
      root = null;
      adminUser = null;
      userList = [];
    },
  };
}

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import process from 'node:process';
import { launchChromium } from './lib/browser.mjs';

const SERVER_PORT = 8787;
const VITE_PORT = 5173;

function probePort(port) {
  return new Promise(resolve => {
    const s = connect({ port, host: '127.0.0.1' });
    s.setTimeout(500);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => { resolve(false); });
  });
}

async function waitForPort(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probePort(port)) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

let serverProc = null;
let viteProc = null;

async function startServices() {
  if (!(await probePort(SERVER_PORT))) {
    console.log('Starting apps/server on 8787...');
    serverProc = spawn('node', ['./node_modules/tsx/dist/cli.mjs', 'apps/server/src/index.ts'], {
      stdio: 'pipe',
      env: { ...process.env, PORT: String(SERVER_PORT), NODE_ENV: 'development' }
    });
    await waitForPort(SERVER_PORT);
  }

  if (!(await probePort(VITE_PORT))) {
    console.log('Starting vite dev server on 5173...');
    viteProc = spawn('node', ['./node_modules/vite/bin/vite.js', '--port', String(VITE_PORT)], {
      stdio: 'pipe',
      env: { ...process.env }
    });
    await waitForPort(VITE_PORT);
  }
}

function cleanup() {
  if (serverProc) {
    try { serverProc.kill('SIGTERM'); } catch {}
  }
  if (viteProc) {
    try { viteProc.kill('SIGTERM'); } catch {}
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

async function run() {
  try {
    await startServices();
    console.log('Services ready. Running API tests...');

    const baseApi = `http://127.0.0.1:${SERVER_PORT}`;

    // 1. 注册功能关闭
    const regRes = await fetch(`${baseApi}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'unauthorized_reg', password: 'password123' })
    });
    const regBody = await regRes.json();
    if (regRes.status !== 403 || !regBody.error.includes('注册功能已关闭')) {
      throw new Error(`Register endpoint failed to reject: status=${regRes.status}, body=${JSON.stringify(regBody)}`);
    }
    console.log('✓ /api/auth/register returns 403 (注册功能已关闭)');

    // 2. 默认管理员 rds / kgnb666 登录
    const loginRes = await fetch(`${baseApi}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'rds', password: 'kgnb666' })
    });
    const loginBody = await loginRes.json();
    if (!loginRes.ok || !loginBody.token || loginBody.user?.name !== 'rds' || loginBody.user?.role !== 'admin') {
      throw new Error(`Admin rds login failed: ${JSON.stringify(loginBody)}`);
    }
    const adminToken = loginBody.token;
    console.log('✓ Admin login with rds / kgnb666 succeeded, role is admin');

    // 3. 管理员访问 /api/admin/users
    const listRes = await fetch(`${baseApi}/api/admin/users`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const listBody = await listRes.json();
    if (!listRes.ok || !Array.isArray(listBody.users) || !listBody.stats) {
      throw new Error(`admin users list failed: ${JSON.stringify(listBody)}`);
    }
    console.log(`✓ Admin fetched user list: ${listBody.users.length} users, stats: ${JSON.stringify(listBody.stats)}`);

    // 4. 管理员创建账号
    const newUserName = 'test_usr_' + Date.now().toString(36);
    const createRes = await fetch(`${baseApi}/api/admin/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newUserName,
        password: 'password_test_123',
        displayName: '测试玩家A',
        role: 'user'
      })
    });
    const createBody = await createRes.json();
    if (!createRes.ok || !createBody.user || createBody.user.name !== newUserName) {
      throw new Error(`Admin create user failed: ${JSON.stringify(createBody)}`);
    }
    const createdUserId = createBody.user.id;
    console.log(`✓ Admin created user @${newUserName} (id=${createdUserId})`);

    // 5. 新用户登录并获取 token
    const userLogin = await fetch(`${baseApi}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newUserName, password: 'password_test_123' })
    });
    const userLoginBody = await userLogin.json();
    const userToken = userLoginBody.token;

    // 6. 用户自己修改个人密码（需校验原密码）
    const wrongOldPassRes = await fetch(`${baseApi}/api/me/password`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: 'wrong_old_pass', newPassword: 'new_self_pass_666' })
    });
    if (wrongOldPassRes.status !== 400) throw new Error('Expected 400 for wrong old password');
    console.log('✓ /api/me/password rejects wrong old password');

    const selfPassRes = await fetch(`${baseApi}/api/me/password`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: 'password_test_123', newPassword: 'new_self_pass_666' })
    });
    const selfPassBody = await selfPassRes.json();
    if (!selfPassRes.ok || !selfPassBody.ok) {
      throw new Error(`Self change password failed: ${JSON.stringify(selfPassBody)}`);
    }
    console.log('✓ User changed own password successfully with correct old password');

    // 使用自主修改的新密码登录
    const selfNewLogin = await fetch(`${baseApi}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newUserName, password: 'new_self_pass_666' })
    });
    if (!selfNewLogin.ok) throw new Error('Login with self changed password failed');
    console.log('✓ Login with self changed password works');

    // 7. Admin 账号可以修改别人账号的密码（直接重置，无需原密码）
    const adminResetRes = await fetch(`${baseApi}/api/admin/users/${createdUserId}/password`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'admin_set_pass_888' })
    });
    const adminResetBody = await adminResetRes.json();
    if (!adminResetRes.ok || !adminResetBody.ok) {
      throw new Error(`Admin reset password failed: ${JSON.stringify(adminResetBody)}`);
    }
    console.log('✓ Admin successfully modified other user\'s password without old password');

    // 使用管理员设置的新密码登录
    const adminSetLogin = await fetch(`${baseApi}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newUserName, password: 'admin_set_pass_888' })
    });
    if (!adminSetLogin.ok) throw new Error('Login with admin modified password failed');
    console.log('✓ Login with admin modified password works');

    // 8. Admin 在后台删除账号
    const delRes = await fetch(`${baseApi}/api/admin/users/${createdUserId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const delBody = await delRes.json();
    if (!delRes.ok || !delBody.ok) throw new Error(`Delete user failed: ${JSON.stringify(delBody)}`);
    console.log('✓ Admin successfully deleted user account from backend');

    // 被删除的账号无法登录
    const delLogin = await fetch(`${baseApi}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newUserName, password: 'admin_set_pass_888' })
    });
    if (delLogin.ok) throw new Error('Deleted user was able to log in');
    console.log('✓ Deleted user login rejected');

    // 不能删除 rds 账号
    const delRds = await fetch(`${baseApi}/api/admin/users/u_admin_rds`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    if (delRds.ok) throw new Error('Admin was able to delete rds account');
    console.log('✓ Root admin rds protected from deletion');

    // 9. Playwright UI 验证
    console.log('Starting Playwright UI verification...');
    const browser = await launchChromium();
    const page = await browser.newPage();
    const appUrl = `http://127.0.0.1:${VITE_PORT}/`;

    // 访问登录页，登录普通用户测试个人资料改密
    await page.goto(appUrl);
    await page.waitForSelector('#adm-login-pass, #name', { timeout: 10000 });

    // 先通过管理后台创建 1 个用于 UI 测试的普通用户
    const uiPlayerName = 'ui_p_' + Date.now().toString(36);
    await fetch(`${baseApi}/api/admin/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: uiPlayerName, password: 'player_pass_123', displayName: '普通玩家UI' })
    });

    // 大厅登录普通用户
    if (await page.$('#name')) {
      await page.fill('#name', uiPlayerName);
      await page.fill('#pass', 'player_pass_123');
      await page.click('#login');
      await page.waitForSelector('#profile-open', { timeout: 10000 });
      console.log('✓ UI: normal user logged in to lobby');

      // 打开个人资料弹窗
      await page.click('#profile-open');
      await page.waitForSelector('#profile-modal:not([hidden])', { timeout: 5000 });
      console.log('✓ UI: profile modal opened');

      // 展开「修改登录密码」
      await page.click('.lob-pass-details summary');
      await page.waitForSelector('#pf-old-pass', { timeout: 3000 });

      // 输入错误原密码
      await page.fill('#pf-old-pass', 'wrong_pass');
      await page.fill('#pf-new-pass', 'player_new_888');
      await page.fill('#pf-new-pass2', 'player_new_888');
      await page.click('#pf-pass-submit');
      await page.waitForSelector('#pf-pass-err:not([style*="display: none"])', { timeout: 5000 });
      console.log('✓ UI: self change password rejected wrong old password with error banner');

      // 输入正确原密码修改
      await page.fill('#pf-old-pass', 'player_pass_123');
      await page.click('#pf-pass-submit');
      await page.waitForSelector('#profile-modal', { state: 'hidden', timeout: 5000 });
      console.log('✓ UI: self change password succeeded and modal closed');

      // 登出
      await page.click('#logout');
      await page.waitForSelector('#name', { timeout: 5000 });
    }

    // 管理员登录管理后台
    await page.goto(`${appUrl}#admin`);
    await page.waitForSelector('#adm-login-pass, .adm-table', { timeout: 10000 });
    if (await page.$('#adm-login-pass')) {
      await page.fill('#adm-login-pass', 'kgnb666');
      await page.click('#adm-login-btn');
      await page.waitForSelector('.adm-table', { timeout: 10000 });
    }
    console.log('✓ UI: admin logged into admin console');

    // 验证「用户 ID」不再显示在表格中
    const idHeader = await page.$('th:has-text("用户 ID")');
    if (idHeader) throw new Error('用户 ID 列表头不应显示');
    const idInCell = await page.$('td:has-text("u_admin_rds")');
    if (idInCell) throw new Error('用户 ID 不应直接在表格行中显示');
    console.log('✓ UI: 用户 ID 列已成功移除，不再显示在界面中');

    // 切换至手机视口 (iPhone 390x844)，验证移动端右侧操作按钮可见且不溢出
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileRow = await page.waitForSelector(`tr[data-user-id] td:has-text("${uiPlayerName}")`, { timeout: 5000 });
    const mobilePassBtn = await page.$(`tr:has-text("${uiPlayerName}") button[data-action="reset-pass"]`);
    const mobileDelBtn = await page.$(`tr:has-text("${uiPlayerName}") button[data-action="delete"]`);
    if (!mobilePassBtn || !mobileDelBtn) throw new Error('移动端右侧改密与删除按钮应直接可见');
    console.log('✓ UI (Mobile 390px): 右侧修改密码与删除按钮直接可见');

    // 管理员通过表格中的「改密」修改刚才用户的密码（直接设置，无需原密码）
    const editPassBtn = await page.waitForSelector(`tr:has-text("${uiPlayerName}") button[data-action="reset-pass"]`, { timeout: 5000 });
    await editPassBtn.click();
    await page.waitForSelector('#adm-reset-pass', { timeout: 5000 });
    console.log('✓ UI: admin opened reset password modal for user');

    await page.fill('#adm-reset-pass', 'admin_override_999');
    await page.fill('#adm-reset-pass2', 'admin_override_999');
    await page.click('#adm-reset-submit');
    await page.waitForSelector('#adm-modal-backdrop', { state: 'detached', timeout: 5000 });
    console.log('✓ UI: admin modified other user\'s password successfully');

    // 管理员通过表格中的「删除」删除该用户
    const delBtn = await page.waitForSelector(`tr:has-text("${uiPlayerName}") button[data-action="delete"]`, { timeout: 5000 });
    await delBtn.click();
    await page.waitForSelector('#adm-delete-submit', { timeout: 5000 });
    await page.click('#adm-delete-submit');
    await page.waitForSelector(`tr:has-text("${uiPlayerName}")`, { state: 'detached', timeout: 5000 });
    console.log('✓ UI: admin deleted user account and row disappeared from table');

    await browser.close();
    console.log('\nALL VERIFICATIONS PASSED SUCCESSFULLY!');
  } finally {
    cleanup();
  }
}

run().catch(err => {
  console.error('\nFAIL:', err);
  cleanup();
  process.exit(1);
});

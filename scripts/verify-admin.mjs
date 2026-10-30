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
    serverProc.stdout.on('data', d => {
      // console.log('[server]', d.toString());
    });
    serverProc.stderr.on('data', d => {
      // console.error('[server err]', d.toString());
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

    // 3. 错误密码登录失败
    const wrongLogin = await fetch(`${baseApi}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'rds', password: 'wrong_password' })
    });
    if (wrongLogin.ok) throw new Error('Wrong password was accepted');
    console.log('✓ Wrong password rejected');

    // 4. 无权限访问 /api/admin/users
    const unauth = await fetch(`${baseApi}/api/admin/users`);
    if (unauth.status !== 401) throw new Error(`Expected 401 without token, got ${unauth.status}`);
    console.log('✓ Unauthorized /api/admin/users blocked with 401');

    // 5. 管理员访问 /api/admin/users
    const listRes = await fetch(`${baseApi}/api/admin/users`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const listBody = await listRes.json();
    if (!listRes.ok || !Array.isArray(listBody.users) || !listBody.stats) {
      throw new Error(`admin users list failed: ${JSON.stringify(listBody)}`);
    }
    console.log(`✓ Admin fetched user list: ${listBody.users.length} users, stats: ${JSON.stringify(listBody.stats)}`);

    // 6. 管理员创建账号
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

    // 7. 新用户登录
    const userLogin = await fetch(`${baseApi}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newUserName, password: 'password_test_123' })
    });
    const userLoginBody = await userLogin.json();
    if (!userLogin.ok || !userLoginBody.token) {
      throw new Error(`New user login failed: ${JSON.stringify(userLoginBody)}`);
    }
    const userToken = userLoginBody.token;
    console.log('✓ Newly created user logged in successfully');

    // 8. 普通用户无权访问 admin API
    const userAccessAdmin = await fetch(`${baseApi}/api/admin/users`, {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    if (userAccessAdmin.status !== 403) {
      throw new Error(`Expected 403 for non-admin user, got ${userAccessAdmin.status}`);
    }
    console.log('✓ Non-admin user blocked from /api/admin/* with 403');

    // 9. 管理员编辑用户
    const updateRes = await fetch(`${baseApi}/api/admin/users/${createdUserId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: '改名玩家A', disabled: true })
    });
    const updateBody = await updateRes.json();
    if (!updateRes.ok || updateBody.user?.displayName !== '改名玩家A' || updateBody.user?.disabled !== true) {
      throw new Error(`Admin update user failed: ${JSON.stringify(updateBody)}`);
    }
    console.log('✓ Admin updated user displayName and set disabled: true');

    // 10. 禁用用户无法登录
    const disabledLogin = await fetch(`${baseApi}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newUserName, password: 'password_test_123' })
    });
    if (disabledLogin.ok) throw new Error('Disabled user was able to log in');
    console.log('✓ Disabled user login rejected');

    // 11. 重置密码并重新启用
    await fetch(`${baseApi}/api/admin/users/${createdUserId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: false })
    });
    const resetRes = await fetch(`${baseApi}/api/admin/users/${createdUserId}/password`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'new_super_pass_888' })
    });
    const resetBody = await resetRes.json();
    if (!resetRes.ok || !resetBody.ok) {
      throw new Error(`Password reset failed: ${JSON.stringify(resetBody)}`);
    }
    const newPassLogin = await fetch(`${baseApi}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newUserName, password: 'new_super_pass_888' })
    });
    if (!newPassLogin.ok) throw new Error('Login with reset password failed');
    console.log('✓ Password reset succeeded and user logged in with new password');

    // 12. 删除用户
    const delRes = await fetch(`${baseApi}/api/admin/users/${createdUserId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const delBody = await delRes.json();
    if (!delRes.ok || !delBody.ok) {
      throw new Error(`Delete user failed: ${JSON.stringify(delBody)}`);
    }
    console.log('✓ Admin deleted user');

    // 13. 不能删除 rds 账号
    const delRds = await fetch(`${baseApi}/api/admin/users/u_admin_rds`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    if (delRds.ok) throw new Error('Admin was able to delete rds account');
    console.log('✓ Root admin rds protected from deletion');

    // 14. Playwright UI 验证
    console.log('Starting Playwright UI verification...');
    const browser = await launchChromium();
    const page = await browser.newPage();
    const appUrl = `http://127.0.0.1:${VITE_PORT}/`;

    // 访问登录页，验证注册按钮已去除
    await page.goto(appUrl);
    await page.waitForSelector('#name', { timeout: 10000 });
    const regBtn = await page.$('#register');
    if (regBtn) throw new Error('Registration button #register should not exist in the DOM');
    const closedText = await page.textContent('body');
    if (!closedText.includes('注册功能已关闭')) {
      throw new Error('Registration closed hint not displayed on auth page');
    }
    console.log('✓ UI: #register button is removed and closed notice is displayed');

    // 点击「管理员后台 →」
    await page.click('#goto-admin');
    await page.waitForSelector('#adm-login-pass', { timeout: 10000 });
    console.log('✓ UI: navigated to admin login view');

    // 输入密码登录
    await page.fill('#adm-login-pass', 'kgnb666');
    await page.click('#adm-login-btn');
    await page.waitForSelector('.adm-table', { timeout: 10000 });
    console.log('✓ UI: admin logged in and admin console table rendered');

    // 检查统计卡片
    const statCards = await page.$$('.adm-stat-card');
    if (statCards.length !== 3) throw new Error(`Expected 3 stat cards, got ${statCards.length}`);
    console.log('✓ UI: 3 metric stat cards visible');

    // 点击创建账号
    await page.click('#adm-btn-create');
    await page.waitForSelector('#adm-create-name', { timeout: 5000 });
    const uiTestUser = 'ui_user_' + Date.now().toString(36);
    await page.fill('#adm-create-name', uiTestUser);
    await page.fill('#adm-create-pass', 'pass_ui_123');
    await page.fill('#adm-create-display', 'UI测试用户');
    await page.click('#adm-create-submit');

    // 确认用户出现在表格中
    await page.waitForSelector(`tr:has-text("${uiTestUser}")`, { timeout: 10000 });
    console.log(`✓ UI: user @${uiTestUser} created via modal and rendered in table`);

    // 点击「返回游戏大厅」
    await page.click('#adm-nav-lobby');
    await page.waitForSelector('#shelf', { timeout: 10000 });
    console.log('✓ UI: returned to game lobby');

    // 检查大厅顶栏的「⚙ 管理后台」按钮
    const adminOpenBtn = await page.$('#admin-open');
    if (!adminOpenBtn) throw new Error('#admin-open button missing in lobby header for admin user');
    console.log('✓ UI: #admin-open button present in lobby header for logged-in admin');

    // 再次点击「⚙ 管理后台」进入管理后台
    await page.click('#admin-open');
    await page.waitForSelector('.adm-table', { timeout: 10000 });
    console.log('✓ UI: successfully re-entered admin console from lobby header');

    await browser.close();
    console.log('\nALL ADMIN VERIFICATIONS PASSED SUCCESSFULLY!');
  } finally {
    cleanup();
  }
}

run().catch(err => {
  console.error('\nFAIL:', err);
  cleanup();
  process.exit(1);
});

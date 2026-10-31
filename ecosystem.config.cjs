const fs = require('node:fs');
const path = require('node:path');

// 轻量解析 .env 文件（不引入额外依赖，KEY=VALUE 格式）
function parseDotEnv(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, 'utf8');
    const res = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const k = trimmed.slice(0, idx).trim();
        const v = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        res[k] = v;
      }
    }
    return res;
  } catch {
    return {};
  }
}

// 可选的本地凭据：优先支持 .env 文件，同时兼容历史 secrets.json。
const envFiles = [
  process.env.RDS_ENV_FILE,
  process.env.ENV_FILE,
  path.join(__dirname, '.env'),
  path.join(__dirname, '..', '.env'),
  path.join(__dirname, '..', 'deploy-webhook', '.env'),
].filter(Boolean);

let envConfig = {};
for (const f of envFiles) {
  const parsed = parseDotEnv(f);
  if (Object.keys(parsed).length > 0) {
    envConfig = { ...envConfig, ...parsed };
  }
}

const secretsFile =
  process.env.RDS_SECRETS_FILE ||
  path.join(__dirname, '..', 'secrets.json');
const secrets = (() => {
  try { return JSON.parse(fs.readFileSync(secretsFile, 'utf8')); } catch { return {}; }
})();

const credentials = { ...secrets, ...envConfig };

module.exports = {
  apps: [
    {
      name: 'rds-board-core',
      script: 'node_modules/tsx/dist/cli.mjs',
      args: 'apps/server/src/index.ts',
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || '8787',
        HUB_SECRET: process.env.HUB_SECRET || credentials.HUB_SECRET || 'dev-secret-do-not-use-in-prod',
        ADMIN_USER: process.env.ADMIN_USER || credentials.ADMIN_USER || 'rds',
        ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || credentials.ADMIN_PASSWORD
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M'
    }
  ]
};

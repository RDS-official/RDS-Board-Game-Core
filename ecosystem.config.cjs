const fs = require('node:fs');
const path = require('node:path');

// 可选的本地密钥文件（不入库，chmod 600）：提供 HUB_SECRET / ADMIN_PASSWORD。
// 查找顺序：环境变量 RDS_SECRETS_FILE 指定的路径 → 仓库目录旁的 secrets.json（/opt/rds-board/secrets.json 布局）。
const secretsFile =
  process.env.RDS_SECRETS_FILE ||
  path.join(__dirname, '..', 'secrets.json');
const secrets = (() => {
  try { return JSON.parse(fs.readFileSync(secretsFile, 'utf8')); } catch { return {}; }
})();

module.exports = {
  apps: [
    {
      name: 'rds-board-core',
      script: 'node_modules/tsx/dist/cli.mjs',
      args: 'apps/server/src/index.ts',
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || '8787',
        HUB_SECRET: process.env.HUB_SECRET || secrets.HUB_SECRET || 'dev-secret-do-not-use-in-prod',
        ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || secrets.ADMIN_PASSWORD
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M'
    }
  ]
};

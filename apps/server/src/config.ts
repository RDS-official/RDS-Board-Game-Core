import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
function secret(): string {
  // 运维用 HUB_SECRET 覆盖；生产缺失时拒绝启动（审查报告 S2）
  if (env.HUB_SECRET) return env.HUB_SECRET;
  if (env.NODE_ENV === 'production') {
    throw new Error('[hub] 生产环境必须通过 HUB_SECRET 提供签名密钥，拒绝用默认密钥启动');
  }
  return 'dev-secret-do-not-use-in-prod';
}
export const PORT = Number(env.PORT || 8787);
export const JWT_SECRET = secret();
export const TOKEN_TTL_SEC = 7 * 24 * 3600;
// 绝对路径：src/../data。之前的 URL.pathname 写法在 Linux 会剥掉开头 '/' 变相对路径，
// 拼上 cwd 后产生嵌套畸形目录，且会被 rsync --delete 清掉导致每次部署用户数据归零。
export const DATA_DIR = env.HUB_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

// 初始管理员账号配置（可通过环境变量 ADMIN_USER / ADMIN_PASSWORD 自定义）。
// 生产环境必须显式提供 ADMIN_PASSWORD，拒绝用入库默认口令启动（公开仓库 + 默认口令 = 任何人可直登 admin）。
export const DEFAULT_ADMIN_USER = env.ADMIN_USER || 'rds';
export const DEFAULT_ADMIN_PASSWORD = adminPassword();

function adminPassword(): string {
  if (env.ADMIN_PASSWORD) return env.ADMIN_PASSWORD;
  if (env.NODE_ENV === 'production') {
    throw new Error('[hub] 生产环境必须通过 ADMIN_PASSWORD 提供初始管理员口令，拒绝用默认口令启动');
  }
  return 'kgnb666'; // 仅开发/自检环境使用
}

export function randomId(prefix = ''): string {
  return prefix + crypto.randomBytes(8).toString('hex');
}

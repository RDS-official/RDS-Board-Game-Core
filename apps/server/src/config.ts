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
// 生产环境强烈建议显式提供 ADMIN_PASSWORD（可在 ecosystem secrets.json 配置）。
// 注意：默认口令已随公开仓库泄露，未配置 ADMIN_PASSWORD 时这里只降级为高危警告而不拒绝启动
// （自动部署机无法交互补配，硬拒启会把线上站点打挂）；首次登录后应立即改密。
export const DEFAULT_ADMIN_USER = env.ADMIN_USER || 'rds';
export const DEFAULT_ADMIN_PASSWORD = adminPassword();

function adminPassword(): string {
  if (env.ADMIN_PASSWORD) return env.ADMIN_PASSWORD;
  if (env.NODE_ENV === 'production') {
    console.error('[hub] 高危：未配置 ADMIN_PASSWORD，正在使用仓库内默认管理员口令（已泄露）。请在部署环境（ecosystem secrets.json 或环境变量）中设置 ADMIN_PASSWORD 并重启。');
  }
  return 'kgnb666';
}

export function randomId(prefix = ''): string {
  return prefix + crypto.randomBytes(8).toString('hex');
}

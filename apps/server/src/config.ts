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

export function randomId(prefix = ''): string {
  return prefix + crypto.randomBytes(8).toString('hex');
}

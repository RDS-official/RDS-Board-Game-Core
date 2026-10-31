import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 尝试加载 .env 配置文件（支持通过 .env 传输环境变量配置）
function tryLoadEnv(): void {
  const candidates = [
    process.env.RDS_ENV_FILE,
    process.env.ENV_FILE,
    path.join(process.cwd(), '.env'),
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env'),
  ].filter(Boolean) as string[];

  for (const f of candidates) {
    try {
      if (fs.existsSync(f)) {
        const proc = process as unknown as { loadEnvFile?: (p?: string) => void };
        if (typeof proc.loadEnvFile === 'function') {
          proc.loadEnvFile(f);
        } else {
          const content = fs.readFileSync(f, 'utf8');
          for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq > 0) {
              const k = trimmed.slice(0, eq).trim();
              const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
              if (process.env[k] === undefined) process.env[k] = v;
            }
          }
        }
        break;
      }
    } catch {}
  }
}
tryLoadEnv();

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

// 初始管理员账号配置（优先通过环境变量/Env 文件 ADMIN_USER / ADMIN_PASSWORD 传输）。
// 生产环境应在部署机通过 .env 或环境变量提供 ADMIN_PASSWORD。
// 注意：未配置 ADMIN_PASSWORD 时生产环境输出高危警告（自动部署机无法交互补配，硬拒启会打挂站点）。
export const DEFAULT_ADMIN_USER = env.ADMIN_USER || 'rds';
export const DEFAULT_ADMIN_PASSWORD = adminPassword();

function adminPassword(): string {
  if (env.ADMIN_PASSWORD) return env.ADMIN_PASSWORD;
  if (env.NODE_ENV === 'production') {
    console.error('[hub] 高危：未配置 ADMIN_PASSWORD，正在使用默认口令。请在部署环境（.env 文件或环境变量）中配置 ADMIN_PASSWORD 并重启。');
  }
  return 'kgnb666';
}

export function randomId(prefix = ''): string {
  return prefix + crypto.randomBytes(8).toString('hex');
}

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
  // 运维用 HUB_SECRET 覆盖；生产缺失时拒绝启动
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

/** 仓库里出现过的弱口令 / NPM 示例值，生产一律拒绝。 */
const WEAK_PASSWORDS = new Set(['kgnb666', 'admin', 'password', '123456', 'changeme', 'your-secure-jwt-secret-here']);
const DEV_HUB_SECRET = 'dev-secret-do-not-use-in-prod';

export interface SecretProblem {
  variable: 'ADMIN_PASSWORD' | 'HUB_SECRET';
  reason: string;
}

/**
 * 生产环境凭据校验（issue #227）。
 *
 * 纯函数：只看传入的 env，便于单测；开发/CI 环境（NODE_ENV !== 'production'）永远返回空数组。
 */
export function validateProductionSecrets(input: {
  NODE_ENV?: string;
  ADMIN_PASSWORD?: string;
  HUB_SECRET?: string;
}): SecretProblem[] {
  if (input.NODE_ENV !== 'production') return [];
  const problems: SecretProblem[] = [];
  const password = input.ADMIN_PASSWORD ?? '';
  if (!password) problems.push({ variable: 'ADMIN_PASSWORD', reason: '未配置' });
  else if (WEAK_PASSWORDS.has(password.toLowerCase())) problems.push({ variable: 'ADMIN_PASSWORD', reason: '是仓库示例/弱口令' });
  else if (password.length < 8) problems.push({ variable: 'ADMIN_PASSWORD', reason: '少于 8 位' });

  const secret = input.HUB_SECRET ?? '';
  if (!secret) problems.push({ variable: 'HUB_SECRET', reason: '未配置' });
  else if (secret === DEV_HUB_SECRET) problems.push({ variable: 'HUB_SECRET', reason: '仍是开发默认值' });
  else if (secret.length < 16) problems.push({ variable: 'HUB_SECRET', reason: '少于 16 位' });
  return problems;
}

function adminPassword(): string {
  if (env.ADMIN_PASSWORD) return env.ADMIN_PASSWORD;
  if (env.NODE_ENV === 'production') {
    // 生产缺失会在下面的 assertProductionSecrets() 里直接拒绝启动，
    // 这里只保证开发环境有个可用的默认口令。
    return 'kgnb666';
  }
  return 'kgnb666';
}

/** 生产环境缺凭据 / 用弱口令时**拒绝启动**（issue #227）。 */
export function assertProductionSecrets(): void {
  const problems = validateProductionSecrets(env);
  if (problems.length === 0) return;
  const detail = problems.map(p => `${p.variable} ${p.reason}`).join('；');
  throw new Error(
    `[hub] 生产环境凭据不合格：${detail}。请通过 .env 或 PM2 环境变量注入强随机值后重启（参考 .env.example）。`
  );
}
assertProductionSecrets();

export function randomId(prefix = ''): string {
  return prefix + crypto.randomBytes(8).toString('hex');
}

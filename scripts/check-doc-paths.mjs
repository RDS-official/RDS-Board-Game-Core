#!/usr/bin/env node
/**
 * 文档路径检查器（docs:check）。
 *
 * 背景：仓库从单体 `src/` 布局迁到 monorepo（`packages/<pkg>/src`、`apps/<app>/src`）后，
 * 文档里残留了大量旧路径，链接点到不存在的文件。本脚本把「文档路径有效性」
 * 变成可自动化的门禁：
 *
 * 1. 禁止旧布局引用：`src/core`、`src/app`、`src/net`、`src/games`、
 *    `src/ui`、`src/render`、`src/ai`、`src/main.ts` 等（外部仓库引用除外）；
 * 2. 文档中的仓库内相对路径（`packages/...`、`apps/...`、`scripts/...`、`docs/...`）
 *    必须指向真实存在的文件或目录（允许省略扩展名、允许 `:行号` 后缀、跳过通配符）；
 * 3. Markdown 相对链接同样校验（目录存在即可）。
 *
 * 用法：`node scripts/check-doc-paths.mjs`（CI 中与 pnpm test 一起跑）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCAN_DIRS = ['docs'];
const SCAN_ROOT_FILES = ['README.md', 'AGENTS.md', 'CONTRIBUTING.md'];

/** 旧单体布局 → 现行路径（用于给出可操作的修复建议）。 */
const LEGACY_LAYOUT = [
  ['src/core/', 'packages/kernel/src/'],
  ['src/app/', 'packages/app/src/'],
  ['src/net/', 'packages/net/src/'],
  ['src/games/', 'packages/games/src/'],
  ['src/ui/', 'apps/web/src/ui/'],
  ['src/render/', 'apps/web/src/render/'],
  ['src/main.ts', 'apps/web/src/main.ts'],
  ['src/ai/policy.ts', 'packages/harness/src/policy.ts'],
  ['src/core/testing/suite.ts', 'packages/harness/src/suite.ts']
];

/** 明确指向外部仓库的历史引用，不校验也不报旧布局。 */
const EXTERNAL_ALLOWLIST = [
  { file: 'docs/RULES-CROSSCHECK.md', snippet: 'BachNewton/Novelty-World' },
  // 历史审计记录：临时诊断脚本，验证完即删，不再要求存在。
  { file: 'docs/SIMULATOR-AUDIT.md', snippet: 'scripts/tmp-' },
  // Biome 忽略名单：这一行列出的正是**不该进仓库**的运行期目录，要求它
  // 存在与文档的原意相反。
  { file: 'docs/QUALITY-GATES.md', snippet: 'files.ignore' },
  // 部署数据目录是运行期软链目标（.gitignore 里的 apps/server/data/），
  // 只在部署机存在；CI 干净检出里必然没有，不能因此判定文档失效。
  { file: 'docs/DEPLOY.md', snippet: 'apps/server/data' }
];

function listMd(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMd(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function repoPathExists(p) {
  const abs = resolve(ROOT, p);
  if (!abs.startsWith(ROOT)) return false;
  if (existsSync(abs)) return true;
  if (!/\.[A-Za-z0-9]+$/.test(p)) {
    return ['.ts', '.mjs', '.tsx', '.md', '.css', '.json'].some(ext => existsSync(abs + ext));
  }
  return false;
}

const failures = [];
const checks = { files: 0, refs: 0, legacy: 0 };

for (const rel of SCAN_ROOT_FILES) {
  if (!existsSync(join(ROOT, rel))) failures.push(`${rel}: 文件不存在（SCAN_ROOT_FILES 配置过期）`);
}
const mdFiles = [
  ...SCAN_ROOT_FILES.map(f => join(ROOT, f)).filter(existsSync),
  ...SCAN_DIRS.flatMap(d => (existsSync(join(ROOT, d)) ? listMd(join(ROOT, d)) : []))
];

/** 代码内路径 token：packages/... apps/... scripts/... docs/... */
const REF_RE = /(?<![\w@/.\-])((?:packages|apps|scripts|docs)\/[A-Za-z0-9_\-./]*[A-Za-z0-9_\-])/g;
/** 旧布局 token。 */
const LEGACY_RE = /(?<![\w@/.\-])src\/(?:core|app|net|games|ui|render|ai|main\.ts|projects)/g;
/** Markdown 相对链接。 */
const LINK_RE = /\]\((\.{0,2}\/?[A-Za-z0-9_\-./]+\.(?:md|ts|mjs|css|json|tsx))(?::\d+(?:-\d+)?)?\)/g;

for (const file of mdFiles) {
  checks.files++;
  const relFile = relative(ROOT, file).split('\\').join('/');
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');

  const allow = EXTERNAL_ALLOWLIST.filter(entry => entry.file === relFile).map(entry => entry.snippet);
  const isAllowedLine = line => allow.some(snippet => line.includes(snippet));

  lines.forEach((line, index) => {
    if (isAllowedLine(line)) return;

    for (const match of line.matchAll(LEGACY_RE)) {
      const hit = match[1] ?? match[0];
      const suggestion = LEGACY_LAYOUT.find(([from]) => hit.startsWith(from.slice(0, -1)));
      checks.legacy++;
      failures.push(
        `${relFile}:${index + 1} 旧布局引用 \`${hit}\`` +
          (suggestion ? `（应改为 \`${suggestion[1]}\`）` : '')
      );
    }

    for (const match of line.matchAll(REF_RE)) {
      const raw = match[1].replace(/[:#].*$/, '');
      const nextChar = line[(match.index ?? 0) + match[0].length] ?? '';
      const ref = raw;
      // 跳过通配/前缀写法（`scripts/shoot*.mjs`、`scripts/verify-*.mjs`）。
      if (!ref || ref.endsWith('/') || ref.endsWith('-') || ref.includes('*') || nextChar === '*') continue;
      checks.refs++;
      if (!repoPathExists(ref)) failures.push(`${relFile}:${index + 1} 路径不存在：${ref}`);
    }

    for (const match of line.matchAll(LINK_RE)) {
      const target = match[1];
      if (target.startsWith('http')) continue;
      const abs = resolve(dirname(file), target);
      if (!existsSync(abs)) {
        failures.push(`${relFile}:${index + 1} 链接目标不存在：${target}`);
      }
    }
  });
}

console.log(
  `docs:check — ${checks.files} 个文件，${checks.refs} 个路径引用，${checks.legacy} 处旧布局引用`
);
if (failures.length > 0) {
  console.error(`\n✗ 文档路径检查失败（${failures.length} 处）：`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('✓ 文档路径全部有效');

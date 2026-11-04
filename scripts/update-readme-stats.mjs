#!/usr/bin/env node
/**
 * README 代码贡献量统计生成器。
 *
 * 数据源只有 `git log`，不依赖 GitHub API，因此本地、CI、离线环境得到的结果一致：
 *
 *   - 提交次数：所有可达提交（含合并提交），与 GitHub Contributors 页面的口径一致；
 *   - 增删行数：`--no-merges --numstat`，跳过二进制文件，重命名按 Git 的重命名检测计算；
 *   - 作者身份：`scripts/contributors-map.json` 把邮箱归并到 GitHub 登录名；
 *     未登记的 `*@users.noreply.github.com` 会自动提取登录名，其余作者按 Git 姓名展示。
 *
 * 输出写入 README 的 `<!-- CONTRIBUTORS-STATS:START -->` 与 `...:END -->` 之间。
 * 该区块是生成物，不要手工编辑；需要改口径时改本脚本，需要改身份时改映射表。
 *
 * 用法：
 *   node scripts/update-readme-stats.mjs            # 刷新 README
 *   node scripts/update-readme-stats.mjs --check    # 只检查是否需要刷新（退出码 1 表示有差异）
 *   node scripts/update-readme-stats.mjs --print    # 打印生成的区块，不写文件
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const README = resolve(ROOT, 'README.md');
const MAP_PATH = resolve(ROOT, 'scripts/contributors-map.json');
const START = '<!-- CONTRIBUTORS-STATS:START -->';
const END = '<!-- CONTRIBUTORS-STATS:END -->';
const SHIELDS = 'https://img.shields.io';

const checkOnly = process.argv.includes('--check');
const printOnly = process.argv.includes('--print');

/** 运行 git 并把 stdout 当 UTF-8 字符串返回。 */
function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** 整数千分位格式化（README 里统一用 en-US 逗号）。 */
const formatNumber = value => Number(value).toLocaleString('en-US');

/** 转义 Markdown 表格里的竖线与尖括号。 */
const escapeCell = value => String(value).replace(/\|/g, '\\|').replace(/</g, '&lt;');

/** 从 GitHub noreply 邮箱提取登录名（`123+login@users.noreply.github.com`）。 */
function loginFromNoreply(email) {
  const match = /^(?:\d+\+)?([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)@users\.noreply\.github\.com$/i.exec(
    email,
  );
  return match ? match[1] : null;
}

function readMap() {
  if (!existsSync(MAP_PATH)) {
    throw new Error(`缺少身份映射表：${MAP_PATH}`);
  }
  const parsed = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
  const aliases = parsed.aliases;
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) {
    throw new Error(`${MAP_PATH} 的 aliases 必须是对象`);
  }
  return { repo: parsed.repo, aliases };
}

function resolveRepo(configured) {
  const repo = process.env.GITHUB_REPOSITORY || configured;
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`无法确定仓库 slug（配置或 GITHUB_REPOSITORY）：${repo ?? ''}`);
  }
  return repo;
}

/**
 * 邮箱 → 展示身份。
 *
 * 返回 `{ key, login, display, note }`：key 用于合并同一人的多个邮箱，login 非空时渲染成
 * GitHub 链接，note 是附在姓名后的说明（例如未关联 GitHub 的本地智能体）。
 */
function makeIdentityResolver(aliases) {
  return (name, rawEmail) => {
    const email = rawEmail.trim().toLowerCase();
    const alias = aliases[email];

    if (typeof alias === 'string') {
      return { key: `login:${alias.toLowerCase()}`, login: alias, display: alias, note: '' };
    }
    if (alias && typeof alias === 'object') {
      const login = typeof alias.login === 'string' && alias.login ? alias.login : null;
      const display = typeof alias.name === 'string' && alias.name ? alias.name : (login ?? name);
      return {
        key: login ? `login:${login.toLowerCase()}` : `name:${display.toLowerCase()}`,
        login,
        display,
        note: typeof alias.note === 'string' ? alias.note : '',
      };
    }

    const derived = loginFromNoreply(email);
    if (derived) {
      return { key: `login:${derived.toLowerCase()}`, login: derived, display: derived, note: '' };
    }

    return {
      key: `email:${email}`,
      login: null,
      display: name,
      note: '未关联 GitHub 账号',
    };
  };
}

function collect() {
  const { repo: configuredRepo, aliases } = readMap();
  const repo = resolveRepo(configuredRepo);
  const identityFor = makeIdentityResolver(aliases);

  if (git(['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    throw new Error('当前是浅克隆，历史统计会不完整；请先 git fetch --unshallow');
  }

  const people = new Map();
  const personFor = (name, email) => {
    const identity = identityFor(name, email);
    let person = people.get(identity.key);
    if (!person) {
      person = { ...identity, commits: 0, added: 0, deleted: 0 };
      people.set(identity.key, person);
    }
    return person;
  };

  // 1) 提交次数：包含合并提交，和 GitHub Contributors 的 contributions 口径一致。
  const commitLines = git(['log', '--format=%aN%x1f%aE'])
    .split('\n')
    .filter(line => line.length > 0);
  for (const line of commitLines) {
    const sep = line.lastIndexOf('\x1f');
    if (sep < 0) continue;
    personFor(line.slice(0, sep), line.slice(sep + 1)).commits += 1;
  }

  // 2) 增删行数：合并提交没有 diff，二进制文件在 numstat 里是 `-`，都要跳过。
  const numstat = git([
    'log',
    '--no-merges',
    '--numstat',
    '--find-renames',
    '--format=%x1e%aN%x1f%aE',
    '-z',
  ]);

  let current = null;
  for (const rawToken of numstat.split('\0')) {
    if (rawToken.length === 0) continue;

    if (rawToken.startsWith('\x1e')) {
      const header = rawToken.slice(1);
      const sep = header.lastIndexOf('\x1f');
      if (sep >= 0) current = personFor(header.slice(0, sep), header.slice(sep + 1));
      continue;
    }

    if (!current) continue;
    const line = rawToken.replace(/^\n+/, '');
    const firstTab = line.indexOf('\t');
    const secondTab = firstTab < 0 ? -1 : line.indexOf('\t', firstTab + 1);
    if (secondTab < 0) continue;

    const added = line.slice(0, firstTab);
    const deleted = line.slice(firstTab + 1, secondTab);
    if (added === '-' || deleted === '-') continue;

    const add = Number(added);
    const del = Number(deleted);
    if (!Number.isFinite(add) || !Number.isFinite(del)) continue;
    current.added += add;
    current.deleted += del;
  }

  const contributors = [...people.values()].sort(
    (a, b) => b.commits - a.commits || b.added - a.added || a.display.localeCompare(b.display),
  );
  const totalCommits = commitLines.length;
  const mergeCommits = Number(git(['rev-list', '--count', '--merges', 'HEAD']).trim());
  const totalAdded = contributors.reduce((sum, person) => sum + person.added, 0);
  const totalDeleted = contributors.reduce((sum, person) => sum + person.deleted, 0);

  return {
    repo,
    contributors,
    totalCommits,
    mergeCommits,
    totalAdded,
    totalDeleted,
    linkedContributors: contributors.filter(person => person.login).length,
  };
}

function render({ repo, contributors, totalCommits, mergeCommits, totalAdded, totalDeleted, linkedContributors }) {
  const rows = contributors
    .map(person => {
      const percent = totalCommits === 0 ? 0 : (person.commits / totalCommits) * 100;
      const name = person.login
        ? `**[@${person.login}](https://github.com/${person.login})**`
        : `**${escapeCell(person.display)}**${person.note ? `（${person.note}）` : ''}`;
      return `| ${name} | **${formatNumber(person.commits)} 次** | ${percent.toFixed(1)}% | +${formatNumber(person.added)} / -${formatNumber(person.deleted)} |`;
    })
    .join('\n');

  return [
    '### 11.2 代码贡献量指标 (Contribution Metrics)',
    '',
    '<p align="center">',
    `  <img src="${SHIELDS}/github/commit-activity/m/${repo}?label=Monthly%20Commits&color=d9b45b" alt="Commit Activity" />`,
    `  <img src="${SHIELDS}/github/contributors/${repo}?label=Contributors&color=4ade80" alt="Contributors Count" />`,
    `  <img src="${SHIELDS}/badge/Total%20Commits-${totalCommits}-blue" alt="Total Commits" />`,
    '</p>',
    '',
    '数据由 `scripts/update-readme-stats.mjs` 从 Git 历史自动生成（每 4 小时刷新一次）。提交次数含合并提交；增删行数不含合并提交与二进制文件。',
    '',
    '| 贡献者 (GitHub ID) | 提交次数 (Commits) | 贡献占比 | 代码增删行数 (Lines Changed) |',
    '| :--- | :---: | :---: | :---: |',
    rows,
    '',
    '### 11.3 仓库规模概览 (Repository Overview)',
    '',
    `- **总提交次数**：${formatNumber(totalCommits)} 次（含 ${formatNumber(mergeCommits)} 次合并提交）`,
    `- **贡献者**：${formatNumber(contributors.length)} 位（${formatNumber(linkedContributors)} 位已关联 GitHub 账号）`,
    `- **代码增删总计**：+${formatNumber(totalAdded)} / -${formatNumber(totalDeleted)} 行`,
    '- **工程结构**：Monorepo 多包架构（`packages/kernel` 核心内核、`packages/games` 六款游戏夹具、`packages/app` 应用状态桥接、`packages/net` 联机信令、`apps/web` Three.js 3D 渲染与 Web 调试器、`apps/server` 独立服务大厅）',
    '- **语言与规范**：100% 严格类型 TypeScript + ESM 模块规范，无外部框架依赖的纯函数内核与严格状态隔离',
    `- **实时图表**：可前往 [GitHub 官方贡献图表页面](https://github.com/${repo}/graphs/contributors) 查看更多维度的代码增删行数与周期统计。`,
  ].join('\n');
}

function replaceBlock(readme, block) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`README.md 缺少统计区块标记 ${START} / ${END}`);
  }
  const before = readme.slice(0, start + START.length);
  const after = readme.slice(end);
  return `${before}\n${block}\n\n${after}`;
}

const stats = collect();
const block = render(stats);
const summary = `${formatNumber(stats.totalCommits)} commits / ${formatNumber(stats.contributors.length)} contributors / +${formatNumber(stats.totalAdded)} / -${formatNumber(stats.totalDeleted)}`;

if (printOnly) {
  process.stdout.write(`${block}\n`);
  process.exit(0);
}

const readme = readFileSync(README, 'utf8');
const next = replaceBlock(readme, block);
const changed = next !== readme;

if (checkOnly) {
  console.log(`contributors: ${summary}`);
  if (changed) {
    console.error('✗ README.md 的统计区块不是最新，请运行 node scripts/update-readme-stats.mjs');
    process.exit(1);
  }
  console.log('✓ README.md 的统计区块已是最新');
  process.exit(0);
}

if (!changed) {
  console.log(`contributors: ${summary}`);
  console.log('README.md 已是最新，无需改写');
  process.exit(0);
}

writeFileSync(README, next, 'utf8');
console.log(`contributors: ${summary}`);
console.log('✓ 已更新 README.md 的代码贡献量统计');

import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src`, import.meta.url));

/** 构建期注入的仓库元信息：哈希、作者、仓库地址（About 弹窗使用）。 */
const gitInfo = (() => {
  const run = (cmd: string): string => {
    try {
      return execSync(cmd, { encoding: 'utf-8' }).trim();
    } catch {
      return '';
    }
  };

  const hash = run('git rev-parse --short HEAD') || 'dev';
  const fullHash = run('git rev-parse HEAD') || hash;
  const author = run('git log -1 --format="%an <%ae>"') || 'unknown';
  const commitDate = run('git log -1 --format=%cI') || '';
  // 归一化 remote URL：git@host:path / ssh:// → https://，便于弹窗内直接点击跳转。
  const rawUrl = run('git remote get-url origin');
  let repo = rawUrl;
  const scpLike = rawUrl.match(/^(?:git@|ssh:\/\/git@)([^/:]+)[/:](.+?)(?:\.git)?$/);
  if (scpLike) repo = `https://${scpLike[1]}/${scpLike[2]}`;
  else if (rawUrl) repo = rawUrl.replace(/\.git$/, '');

  const slugMatch = repo.match(/github\.com\/([^/]+\/[^/]+)/);
  const repoSlug = slugMatch ? slugMatch[1] : 'RDS-official/RDS-Board-Game-Core';

  // 贡献者 ID 归一化：将 xhopo/Xhopo 的历史提交与记录统一归入 Xhopo-hk。
  const normalizeAuthor = (raw: string): string => {
    const s = String(raw || '').toLowerCase().trim();
    if (s.includes('xhopo')) return 'Xhopo-hk';
    if (s.includes('qsansi') || s.includes('qingsansi') || s.includes('西梅')) return 'QSanSi';
    if (s.includes('zooter') || s.includes('1368129224')) return '1368129224';
    return raw ? raw.trim() : '';
  };

  // 获取仓库的 contributors 列表及 commit 次数统计（归一化为纯 ID，xhopo 归入 Xhopo-hk）。
  const contributors = (() => {
    try {
      const rawLines = run('git log --format="%an|%ae"').split(/\r?\n/).filter(Boolean);
      const map = new Map<string, number>();
      for (const line of rawLines) {
        const [an, ae] = line.split('|');
        if (/^AI\s+Developer$/i.test(an)) continue;
        const id = normalizeAuthor(an) || normalizeAuthor(ae);
        if (id) {
          map.set(id, (map.get(id) || 0) + 1);
        }
      }
      const list = Array.from(map.entries())
        .map(([login, commits]) => ({ login, commits }))
        .sort((a, b) => b.commits - a.commits);
      if (list.length > 0) return list;
    } catch {}

    return [
      { login: 'Xhopo-hk', commits: 72 },
      { login: 'QSanSi', commits: 30 },
      { login: '1368129224', commits: 24 }
    ];
  })();

  const totalCommits = run('git rev-list --count HEAD') || '140+';

  return { hash, fullHash, author, commitDate, repo, contributors, totalCommits };
})();

export default defineConfig({
  define: {
    __COMMIT_HASH__: JSON.stringify(gitInfo.hash),
    __COMMIT_FULL_HASH__: JSON.stringify(gitInfo.fullHash),
    __COMMIT_AUTHOR__: JSON.stringify(gitInfo.author),
    __CONTRIBUTORS__: JSON.stringify(gitInfo.contributors),
    __TOTAL_COMMITS__: JSON.stringify(gitInfo.totalCommits),
    __COMMIT_DATE__: JSON.stringify(gitInfo.commitDate),
    __REPO_URL__: JSON.stringify(gitInfo.repo),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString())
  },
  resolve: {
    alias: [
      { find: '@rds/kernel', replacement: pkg('kernel') },
      { find: '@rds/games', replacement: pkg('games') },
      { find: '@rds/app', replacement: pkg('app') },
      { find: '@rds/net', replacement: pkg('net') },
      { find: '@rds/web', replacement: fileURLToPath(new URL('./apps/web/src', import.meta.url)) },
      { find: '@rds/room-protocol', replacement: fileURLToPath(new URL('./packages/room-protocol/src/index.ts', import.meta.url)) }
    ]
  },
  // 相对路径：dist 会被挂在子路径（如 Hub 的 /games/rds-board-core/）下提供，
  // 默认的绝对 /assets/... 会打到宿主站点根路径而 404→HTML fallback
  base: './',
  server: {
    port: 3000,
    host: true,
    open: false,
    // Dev-time proxy to apps/server (8787)：让统一外壳在 vite dev 下也能探测到大厅。
    // 没有它，/healthz 命中 SPA fallback 的 200 HTML，shell 会退回本地单机模式。
    proxy: {
      '/healthz': 'http://localhost:8787',
      '/api': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true }
    }
  },
  build: {
    target: 'esnext'
  }
});

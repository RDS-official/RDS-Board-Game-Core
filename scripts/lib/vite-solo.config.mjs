import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

/**
 * Solo-mode Vite config for layout/probe scripts.
 *
 * The repo config proxies `/healthz`, `/api` and `/ws` to the Hub server so the
 * unified shell can detect the lobby in dev. That makes every probe's result
 * depend on whether a Hub happens to be running: with it up the shell shows the
 * lobby and the game DOM never mounts, which silently turns geometry assertions
 * into no-ops.
 *
 * This config drops the proxy, so `hubAlive()` fails and the shell boots
 * straight into single-machine mode — the same view a probe wants to measure.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const pkg = name => `${root}packages/${name}/src`;

// 与根 vite.config.ts 保持一致：注入 git 元信息（About 弹窗读取这些常量）。
const run = (cmd) => {
  try {
    return execSync(cmd, { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
};
const gitInfo = (() => {
  const hash = run('git rev-parse --short HEAD') || 'dev';
  const fullHash = run('git rev-parse HEAD') || hash;
  const author = run('git log -1 --format="%an <%ae>"') || 'unknown';
  const commitDate = run('git log -1 --format=%cI') || '';
  const rawUrl = run('git remote get-url origin');
  let repo = rawUrl;
  const scpLike = rawUrl.match(/^(?:git@|ssh:\/\/git@)([^/:]+)[/:](.+?)(?:\.git)?$/);
  if (scpLike) repo = `https://${scpLike[1]}/${scpLike[2]}`;
  else if (rawUrl) repo = rawUrl.replace(/\.git$/, '');

  const slugMatch = repo.match(/github\.com\/([^/]+\/[^/]+)/);
  const repoSlug = slugMatch ? slugMatch[1] : 'RDS-official/RDS-Board-Game-Core';

  const contributors = (() => {
    try {
      const raw = run(`gh api repos/${repoSlug}/contributors 2>/dev/null || curl -s --max-time 3 -H "User-Agent: build" https://api.github.com/repos/${repoSlug}/contributors`);
      if (raw && raw.startsWith('[')) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const list = parsed
            .map(item => ({
              login: String(item?.login || '').trim(),
              commits: Number(item?.contributions) || 0
            }))
            .filter(item => Boolean(item.login));
          if (list.length > 0) return list;
        }
      }
    } catch {}

    try {
      const gitAuthors = run('git log --format="%an"')
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(s => s && !/^AI\s+Developer$/i.test(s));
      const counts = {};
      for (const a of gitAuthors) counts[a] = (counts[a] || 0) + 1;
      const list = Object.entries(counts).map(([login, commits]) => ({ login, commits }));
      if (list.length > 0) return list;
    } catch {}

    return [
      { login: 'QSanSi', commits: 30 },
      { login: '1368129224', commits: 20 },
      { login: 'Xhopo-hk', commits: 8 }
    ];
  })();

  const totalCommits = run('git rev-list --count HEAD') || '140+';

  return { hash, fullHash, author, commitDate, repo, contributors, totalCommits };
})();

export default defineConfig({
  root,
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
      { find: '@rds/web', replacement: `${root}apps/web/src` },
      { find: '@rds/room-protocol', replacement: `${root}packages/room-protocol/src/index.ts` }
    ]
  },
  base: './',
  server: { port: 5180, host: '127.0.0.1', open: false, strictPort: true },
  build: { target: 'esnext' }
});

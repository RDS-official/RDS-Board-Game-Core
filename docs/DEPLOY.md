
# 部署与运维

> 本文记录**线上真实拓扑**与两条部署链路。历史上的 Docker / GHCR 方案（`deploy.sh`）已停用，
> 仅作参考保留在 README §10。

---

## 1. 线上拓扑（2026-10-31 核对）

| 站点 | 主机 | 路径 | 进程 | 部署来源 |
| --- | --- | --- | --- | --- |
| `https://rdsbg.zooter.eu.org/` | AWS Lightsail · Ubuntu 24.04 | `/opt/rds-board/app` | PM2 `rds-board-core` + Caddy 反代 | 服务器自带的 `/api/github-webhook` 触发 `git reset --hard origin/main` → `pnpm install` → `pnpm build` → `pm2 reload` |
| `http://117.72.60.103:8787/` | 京东云 · 端口 2134 | `/opt/rds-board/app` | PM2 `rds-board-core`（`tsx` 直跑，非 git 仓库） | GitHub Actions `deploy.yml`：`pnpm test` / `test:server` / `docs:check` / `build` 通过后 rsync `--delete` 上传 |

两条链路由 **push 到 `main`** 同时触发，互不依赖。数据目录 `apps/server/data` 在部署机上是
指向 `/opt/rds-board/data` 的软链，`deploy.yml` 会在 rsync 后重建该软链（`--exclude=apps/server/data`）。

### 1.1 已知运维坑

- **进程进入 `errored` 后 webhook 的 `pm2 reload` 拉不起来**：必须登录服务器 `pm2 restart rds-board-core`。
- **改动生产启动校验要留退路**：无人值守的部署机无法交互补配环境变量，硬性 `throw` 会直接打挂线上站点
  （`config.ts` 现在缺 `ADMIN_PASSWORD` 只告警不拒启）。
- **`pnpm test:server` 会在部署机上跑**：自检已改为使用临时 `HUB_DATA_DIR`，避免把测试账号写进生产数据目录。
- **京东云机不是 git 仓库**：不要指望在那台机器上 `git pull`；回滚请重新触发 `deploy.yml`（`workflow_dispatch`）。

---

## 2. 部署密钥（secrets.json）

生产机在仓库目录旁放置 secrets.json（chmod 600，不入库）即可提供 HUB_SECRET 与 ADMIN_PASSWORD：

```json
{ "HUB_SECRET": "...", "ADMIN_PASSWORD": "..." }
```

ecosystem.config.cjs 会优先读环境变量，其次读该文件（可用 RDS_SECRETS_FILE 指定路径）。未配置 ADMIN_PASSWORD 时服务仍会启动，但会输出高危警告——默认口令已随公开仓库泄露，上线后必须立即改密。

---

## 3. 部署后验证

```bash
# 两个站点都应返回 {"ok":true}
curl -s https://rdsbg.zooter.eu.org/healthz
curl -s http://117.72.60.103:8787/healthz

# 未登录访问登录端点应返回 401（说明鉴权链路存活，而不是静态目录兜底）
curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{}' http://117.72.60.103:8787/api/auth/login
```


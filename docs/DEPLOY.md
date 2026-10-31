
## 部署密钥（secrets.json）

生产机在仓库目录旁放置 secrets.json（chmod 600，不入库）即可提供 HUB_SECRET 与 ADMIN_PASSWORD：

```json
{ "HUB_SECRET": "...", "ADMIN_PASSWORD": "..." }
```

ecosystem.config.cjs 会优先读环境变量，其次读该文件（可用 RDS_SECRETS_FILE 指定路径）。未配置 ADMIN_PASSWORD 时服务仍会启动，但会输出高危警告——默认口令已随公开仓库泄露，上线后必须立即改密。

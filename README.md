# BotCamp — dsh 前端静态资源

将 DeepSeek Harness（dsh）Web 前端的 **Vite dist** 单独放到静态托管（Demox），  
`camp.aigc.sx.cn` 仍由本机 `dsh web` 负责鉴权、`/api`、`/plugins` 与 index 注入；  
nginx 把 `/assets/` 等静态路径反代到 Demox，实现前端资源与后端进程分离。

## 架构

```
浏览器 ──► https://camp.aigc.sx.cn
              │
              ├─ /、/api、/plugins、WebSocket ──► 127.0.0.1:3080 (dsh web)
              └─ /assets/、favicon、manifest ──► https://<id>.demox.site (静态)
```

不能把整个 SPA 入口单独挂到另一个域名：dsh 的 cookie（`SameSite=Strict`）与  
`__DSH_BOOT__` / `/plugins` 都要求浏览器入口与 API 同源。

## 目录

| 路径 | 说明 |
| --- | --- |
| `dist/` | 从服务器 `@deepseek-ai/dsh-web-frontend/dist` 同步出的静态构建 |
| `scripts/sync-frontend-from-server.sh` | SSH 拉取最新 dist |
| `scripts/deploy-demox.sh` | 部署 `dist/` 到 Demox |
| `deploy/nginx/camp-assets-demox.conf.snippet` | nginx 静态反代片段 |

## 常用命令

```bash
# 从腾讯云拉取最新前端（需 DSH_SSH_*）
./scripts/sync-frontend-from-server.sh

# 部署到 Demox（需已 demox login 或 DEMOX_TOKEN）
./scripts/deploy-demox.sh
```

## 服务器侧

1. 把 `deploy/nginx/camp-assets-demox.conf.snippet` 合入 `/etc/nginx/conf.d/camp.conf`（替换 `DEMOX_ORIGIN`）。
2. `nginx -t && systemctl reload nginx`
3. dsh 进程保持：`dsh web --public-url https://camp.aigc.sx.cn/ --trusted-host camp.aigc.sx.cn`

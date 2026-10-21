# BotCamp

dsh 的纯前端。界面在这个仓库里开发和构建，静态产物部署到 Demox 项目 **botcamp**。会话、模型和工具仍由腾讯云上的 dsh 内核执行，入口是 [https://camp.aigc.sx.cn](https://camp.aigc.sx.cn)。

内核拒绝跨站调用：从 `botcamp.demox.site` 直接请求 `camp.aigc.sx.cn/api` 会得到 403。浏览器必须和 `/api` 同源。本地开发由 Vite 把 `/api` 反代到内核；线上由 camp 的 nginx 提供页面，并把 `/api` 转到本机 `dsh web`。

## 本地

```bash
npm --prefix web ci
npm --prefix web run dev
```

打开 http://127.0.0.1:5173 。开发服务器会自行完成内核登录，不需要把令牌写进仓库。

```bash
npm --prefix web test
npm --prefix web run build
```

## Demox

| 字段 | 值 |
| --- | --- |
| 项目 | `botcamp` / `PQBDTM6GLZ` |
| 站点 | `botcamp-dsh-frontend` / `IVBLF9PE` |
| 地址 | https://botcamp.demox.site/ |

```bash
# 需要 demox login 或 DEMOX_TOKEN
./scripts/deploy-demox.sh
```

部署会替换该站点上的静态文件。camp 目前把 `/assets/` 指到这个站点；换上新前端之后，需要同时套用 `deploy/nginx/camp.conf`，让已登录的 `/` 返回新的 `index.html`，`/api/` 继续走本机 3080。

```bash
nginx -t && systemctl reload nginx
```

内核进程保持：`dsh web --public-url https://camp.aigc.sx.cn/ --trusted-host camp.aigc.sx.cn`。

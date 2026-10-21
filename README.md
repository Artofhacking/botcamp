# BotCamp

页面用的是 [DeepSeek Bot](https://github.com/Fei2411/DeepSeek-Bot) 自己的窗口（`app/ui`，Apache-2.0），不是 DeepSeek Harness 那套壳，也不依赖 `window.__ModuleLoader__`。界面在这个仓库里构建，静态产物部署到 Demox 项目 **botcamp**。会话仍由腾讯云上的 dsh 内核执行，入口是 [https://camp.aigc.sx.cn](https://camp.aigc.sx.cn)。

内核拒绝跨站调用：从 `botcamp.demox.site` 直接请求 `camp.aigc.sx.cn/api` 会得到 403。浏览器必须和 `/api` 同源。本地开发由 Vite 把 `/api` 反代到内核；线上由 camp 的 nginx 提供这个页面，并把 `/api` 转到本机 `dsh web`。

这个窗口只跟 ds-bot 插件说话：`POST /api/bot` 和 `GET /api/bot/feed`。插件还没装进内核时，页面能打开，状态请求会得到 404。在腾讯云那台机器上、内核所在的环境里执行：

```bash
npx @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add ds-bot
```

## 本地

```bash
npm --prefix app ci
npm --prefix app run dev
```

打开 http://127.0.0.1:5173 。标题是 DeepSeek Bot，侧栏牌子是 DS Bot。开发服务器会自行完成内核登录，不需要把令牌写进仓库。

```bash
npm --prefix app run build
```

产物在 `app/ui/dist`。

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

部署会替换该站点上的静态文件。camp 目前把 `/assets/` 指到这个站点上的 Harness 资源。换上 DeepSeek Bot 页面时，要同时套用 `deploy/nginx/camp.conf`：已登录且没有 `?token=` 的 `/` 返回新的 `index.html`，`/assets/` 改指向这份产物，`/api/` 继续走本机 3080。两边不要分开上。

```bash
nginx -t && systemctl reload nginx
```

内核进程保持：`dsh web --public-url https://camp.aigc.sx.cn/ --trusted-host camp.aigc.sx.cn`。

# BotCamp

用户只打开 [https://botcamp.demox.site/](https://botcamp.demox.site/)。页面是 [DeepSeek Bot](https://github.com/Fei2411/DeepSeek-Bot) 自己的窗口（`app/ui`，Apache-2.0），不是 DeepSeek Harness 那套壳，也不依赖 `window.__ModuleLoader__`。整站前端部署在 Demox。浏览器停在这个源站，页面里没有跳转到 camp 的脚本，也不要加。

[https://camp.aigc.sx.cn](https://camp.aigc.sx.cn) 只提供核心 API：dsh / ds-bot 的 `POST /api/bot`、`GET /api/bot/feed`，以及内核在 `/api/` 上需要的其它请求（含 websocket 升级）。它不是给人打开的网站。

浏览器不能直接调用 camp。从 `botcamp.demox.site` 跨站请求会得到 403，内核 cookie 又是 `SameSite=Strict`，跨站不会带上。Demox 静态托管也不能做反向代理。所以这个站点上唯一的 `/api` 是 Demox 云函数，slug 是 `bot`。页面用相对路径 `fetch('api/bot')`（POST JSON `{endpoint, payload}`）和 `fetch('api/bot/feed')`（SSE）。`index.html` 的 CSP `connect-src` 是 `'self'`，因为这些请求都留在 Demox 源站。

云函数在服务端请求 `https://camp.aigc.sx.cn`，把 `Origin` 设成这个源，跟随启动时的 303 拿到内核 cookie，再代发 `/api`。cookie 和启动令牌不回给浏览器，也不写进日志。函数只能返回完整的 `body`，不能把一条无限 SSE 留在连接上：`/api/bot/feed` 读到第一条事件，或大约 2.5 秒，就取消上游。页面如果发现流在几秒内自己结束，会等 5 秒再重连，避免把内核打满。

这个窗口只跟 ds-bot 插件说话。插件还没装进内核时，页面能打开，状态请求会得到 404。在腾讯云那台机器上、内核所在的环境里执行：

```bash
npx @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add ds-bot
```

## 本地

```bash
npm --prefix app ci
npm --prefix app run dev
```

打开 http://127.0.0.1:5173 。标题是 DeepSeek Bot，侧栏牌子是 DS Bot。开发服务器会自行完成内核登录，不需要把令牌写进仓库。本地的 `/api` 反代只给开发用，浏览器地址仍然是本机。

```bash
npm --prefix app run build
```

产物在 `app/ui/dist`。构建会清空该目录。产物里不能出现把 `*.demox.site` 送去 camp 的脚本。

## Demox

| 字段 | 值 |
| --- | --- |
| 项目 | `botcamp` / `PQBDTM6GLZ` |
| 站点 | `botcamp-dsh-frontend` / `IVBLF9PE` |
| 地址 | https://botcamp.demox.site/ |

```bash
# 需要 demox login 或 DEMOX_TOKEN。未登录时只构建，不发布。
./scripts/deploy-demox.sh
```

脚本会构建 `app/ui/dist`，登录后发布静态站点，并执行：

```bash
npx --yes @demox-site/cli@1.1.6 functions push ./functions/bot --id IVBLF9PE --slug bot --name bot --routes /api/bot,/api/bot/feed
```

`--routes` 只在第一次创建函数时生效，必须同时覆盖 `/api/bot` 和 `/api/bot/feed`。云函数推送失败不会让已经完成的静态发布失败，脚本会把上面这条命令再打印一遍。

第一次 push 创建 v1，`production` 和 `develop` 都指向 v1。再上传只增加版本，不会移动别名。要让线上用新版本：

```bash
npx --yes @demox-site/cli@1.1.6 functions alias set --id IVBLF9PE --slug bot production --version=N
```

## 腾讯云上的 nginx

`deploy/nginx/camp.conf` 让 camp 不再提供 HTML，也不再代理 Demox 的首页或 `/assets/`。只有 `/api/` 转到本机 `127.0.0.1:3080`（带上 websocket 需要的 `Upgrade`）。其它路径返回一行纯文本，说明这个主机只提供 API。

这份配置要在腾讯云那台机器上替换后执行才会生效：

```bash
nginx -t && systemctl reload nginx
```

这里没有到 `119.91.123.2` 的 SSH，不能代为 reload。reload 之前，线上的 camp 仍可能把 Demox 页面当成入口。

内核今天在 `GET /` 上用 303 换 `dsh-auth` cookie，不会在 `/api` 上签发。云函数跟的就是这次跳转。换成新的 `camp.conf` 并 reload 之后，`/` 不再把这次交换交给 dsh。如果函数因此拿到 401，需要让「还没有 `dsh-auth` cookie 的 `GET /`」在不返回 HTML 的前提下到达 `127.0.0.1:3080`。不要恢复 Demox 首页代理，也不要把浏览器送进内核页面。

内核进程保持：`dsh web --public-url https://camp.aigc.sx.cn/ --trusted-host camp.aigc.sx.cn`。

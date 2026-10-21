# BotCamp

页面用的是 [DeepSeek Bot](https://github.com/Fei2411/DeepSeek-Bot) 自己的窗口（`app/ui`，Apache-2.0），不是 DeepSeek Harness 那套壳，也不依赖 `window.__ModuleLoader__`。用户只打开 [https://botcamp.demox.site/](https://botcamp.demox.site/)。界面在这个仓库里构建，整站部署在 Demox 项目 **botcamp**。

[https://camp.aigc.sx.cn](https://camp.aigc.sx.cn) 只提供内核 API，不提供页面。浏览器从 `botcamp.demox.site` 直接请求它会得到 403。线上由 Demox 云函数在服务端把 `POST /api/bot` 和 `GET /api/bot/feed` 转到该内核。本地开发由 Vite 把 `/api` 反代到内核。

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

产物在 `app/ui/dist`。构建会清空该目录。

## Demox

| 字段 | 值 |
| --- | --- |
| 项目 | `botcamp` / `PQBDTM6GLZ` |
| 站点 | `botcamp-dsh-frontend` / `IVBLF9PE` |
| 地址 | https://botcamp.demox.site/ |

```bash
# 需要 demox login 或 DEMOX_TOKEN
./scripts/deploy-demox.sh
npx --yes @demox-site/cli functions push ./functions/bot --id IVBLF9PE --slug bot --name bot --routes /api/bot,/api/bot/feed
```

`--routes` 只在第一次创建函数时生效。之后再推版本不会改路径，需要的话把 production 别名指到新版本：

```bash
npx --yes @demox-site/cli functions alias set --id IVBLF9PE --slug bot production --version N
```

部署会替换该站点上的静态文件。camp 的 nginx（`deploy/nginx/camp.conf`）只把 `/api/` 转到本机 `127.0.0.1:3080`，其它路径返回纯文本 404，不返回页面，也不代理 Demox 的首页。这份配置要在腾讯云那台机器上执行 `nginx -t && systemctl reload nginx` 之后才会生效。

内核进程保持：`dsh web --public-url https://camp.aigc.sx.cn/ --trusted-host camp.aigc.sx.cn`。

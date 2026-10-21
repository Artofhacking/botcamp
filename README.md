# BotCamp

只打开 [https://botcamp.demox.site/](https://botcamp.demox.site/)。页面是 [DeepSeek Bot](https://github.com/Fei2411/DeepSeek-Bot) 自己的窗口（`app/ui`，Apache-2.0），不是 DeepSeek Harness 那套壳。浏览器停在这个源站。页面里没有跳转到 camp 的脚本，也不要加。

[https://camp.aigc.sx.cn](https://camp.aigc.sx.cn) 是私有 API，不是网站。它不提供 HTML，也不把人送去 Demox。只有 `/api/`（含 `POST /api/bot`、`GET /api/bot/feed`，以及内核在 `/api/` 上的 websocket）可以转到本机 `127.0.0.1:3080` 的 dsh。其它路径是一行纯文本 404。

浏览器不能直接调用 camp。从 `botcamp.demox.site` 跨站请求会得到 403，内核 cookie 又是 `SameSite=Strict`。页面用相对路径把 `POST api/bot` 和 `GET api/bot/feed` 打到本站。线上这条路径是 Demox 云函数，slug 是 `bot`。本地开发由 Vite 接到同一个网关。两边都先核对邮箱会话 `botcamp_session`。没有会话返回 401，请求不会到达内核。

内核自己的 `dsh-auth` 只由这个网关在服务端向内核换取。它不回到浏览器，不写进日志，也不放进仓库。

dsh 和 ds-bot 是单租户。隔离和配额做在 `app/botcamp/`，发生在进内核之前。云函数（`functions/bot/entry.mjs`）和 Vite（`app/kernelProxy.mjs`）调用的是同一个 `createBotcamp`。用户 A 的会话不能读到用户 B 的机器人，也不能花掉用户 B 的配额。

登录、当前用户和管理员接口也走 `POST /api/bot`，端点名是 `botcamp/login`、`botcamp/me`、`botcamp/logout` 和 `botcamp/admin-*`。Demox 创建函数时只能登记 `/api/bot` 和 `/api/bot/feed`，所以不能另开 `/api/auth`。本地的 `/api/auth` 和 `/api/admin` 仍然可用。

云函数读到实时流的第一条事件（或上游结束）就取消连接。页面如果发现流在几秒内自己结束，会等 5 秒再重连。401 会停掉重连。

这个窗口只跟 ds-bot 插件说话。插件还没装进内核时，页面能打开，状态请求会得到 404。在腾讯云那台机器上、内核所在的环境里执行：

```bash
npx @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add ds-bot
```

## 本地

```bash
npm --prefix app ci
npm --prefix app run dev
```

打开 http://127.0.0.1:5173 。未登录只会看到登录页。开发服务器自己完成内核登录，不需要把令牌写进仓库。

## 账号

- 邮箱加密码登录。没有公开注册，账号由管理员开通。密码用 scrypt 保存，不明文落地。会话是本站的 `botcamp_session` httpOnly cookie，和内核的 `dsh-auth` 不是同一个。
- 每个账号有一个稳定的 `kernelKey`。发往内核的 Bot 请求会带上 `x-botcamp-namespace`。机器人、会话、群和设置的归属记在本地账本里。别人的 id 在进内核之前就被拒绝。
- 配额按消息条数。发送一条（`send`），或向记忆提问一次（`memory-ask`），计 1 次。配额为 0 或已用尽时，发送会被拒绝。管理员在侧栏「用户与配额」里修改。

用户库为空时，用环境变量创建第一名管理员：

```bash
BOTCAMP_ADMIN_EMAIL=you@example.com BOTCAMP_ADMIN_PASSWORD='至少 8 位' npm --prefix app run dev
```

`NODE_ENV=production`（或 `BOTCAMP_PRODUCTION=1`）时，没有这两个变量就不会创建管理员。云函数固定按生产环境跑，因此不会装上本地默认口令。本地 `npm run dev` 如果两个变量都没设，并且用户库是空的，会用文档里的开发账号：邮箱 `admin@localhost`，密码 `botcamp-dev`。这个默认值只给本机，不要拿到正式环境用。

新用户的默认配额是 200，可以用 `BOTCAMP_DEFAULT_QUOTA` 改。数据目录可以用 `BOTCAMP_DATA_DIR` 指到别处。本地账本在 `data/`，已 gitignore。

云函数的账本在实例的 `/tmp/botcamp-data`。冷启动会清空它。正式环境要在函数环境变量里设置 `BOTCAMP_ADMIN_EMAIL` 和 `BOTCAMP_ADMIN_PASSWORD`（不要写进仓库）：

```bash
npx --yes @demox-site/cli@1.1.6 env set --id IVBLF9PE --slug bot BOTCAMP_ADMIN_EMAIL=you@example.com
npx --yes @demox-site/cli@1.1.6 env set --id IVBLF9PE --slug bot BOTCAMP_ADMIN_PASSWORD='至少 8 位'
```

环境变量在该实例的第一次请求时读入。改完之后需要等新实例起来，或再推一版函数。

```bash
npm --prefix app test
npm --prefix app run build
```

产物在 `app/ui/dist`。产物里不能出现把 `*.demox.site` 送去 camp 的脚本。

## Demox

| 字段 | 值 |
| --- | --- |
| 项目 | `botcamp` / `PQBDTM6GLZ` |
| 站点 | `botcamp-dsh-frontend` / `IVBLF9PE` |
| 地址 | https://botcamp.demox.site/ |
| 函数 | slug `bot`，routes `/api/bot`、`/api/bot/feed` |

```bash
# 需要 demox login 或 DEMOX_TOKEN。未登录时只构建，不发布。
./scripts/deploy-demox.sh
```

脚本会构建页面和云函数，登录后发布静态站点，并执行：

```bash
npx --yes @demox-site/cli@1.1.6 functions push ./functions/bot --id IVBLF9PE --slug bot --name bot --routes /api/bot,/api/bot/feed
```

`--routes` 只在第一次创建函数时生效。再上传只增加版本，不会移动别名。要让线上用新版本：

```bash
npx --yes @demox-site/cli@1.1.6 functions alias set --id IVBLF9PE --slug bot production --version=N
```

## 腾讯云上的 nginx

`deploy/nginx/camp.conf` 让 camp 不再提供 HTML，也不再代理 Demox 的首页或 `/assets/`。只有 `/api/` 转到本机 `127.0.0.1:3080`。其它路径返回一行纯文本。

这份配置要在腾讯云那台机器上替换后执行才会生效：

```bash
nginx -t && systemctl reload nginx
```

这里没有到 `119.91.123.2` 的 SSH（公钥登录被拒绝），不能代为 reload。在有人执行上面的命令之前，线上的 camp 仍可能把页面或跳转留在这个域名上。

内核今天在 `GET /` 上用 303 换 `dsh-auth`，不会在 `/api` 上签发。换成这份配置并 reload 之后，`/` 不再把这次交换交给 dsh。如果函数因此在代发时得到内核的 401，需要让「还没有 `dsh-auth` 的 `GET /`」在不返回 HTML 的前提下到达 `127.0.0.1:3080`。不要恢复网站，不要代理 Demox 首页，也不要把这张 cookie 交给浏览器。

内核进程保持：`dsh web --public-url https://camp.aigc.sx.cn/ --trusted-host camp.aigc.sx.cn`。

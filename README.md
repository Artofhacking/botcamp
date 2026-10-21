# BotCamp

用户只打开 [https://botcamp.demox.site/](https://botcamp.demox.site/)。页面是 [DeepSeek Bot](https://github.com/Fei2411/DeepSeek-Bot) 自己的窗口（`app/ui`，Apache-2.0）。浏览器停在这个源站：页面里没有跳转到 camp 的脚本。未登录只看到登录页。

[https://camp.aigc.sx.cn](https://camp.aigc.sx.cn) 不是网站。`deploy/nginx/camp.conf` 让它不返回 HTML、不托管静态资源、不把浏览器送到 Demox，也不再把 `/` 交给内核（避免 303 到 `./` 的循环）。只有 `/api/` 可以到达 `127.0.0.1:3080`，而且请求必须带 `botcamp_session`。没有这个 cookie 时，nginx 在进 dsh 之前返回 401。这份配置写进仓库之后，还要在腾讯云那台机器上 `nginx -t && systemctl reload nginx` 才会生效。

## 账号

dsh 内核和 ds-bot 插件都是单租户。隔离和配额做在网关里，发生在请求进入内核之前。

- 邮箱加密码登录。没有公开注册，账号由管理员开通。密码用 scrypt 保存。会话是 `botcamp_session` httpOnly cookie。内核的 `dsh-auth` 只留在网关进程里，不回给浏览器，也不写进日志。
- Demox 上已经存在的云函数只能接到 `/api/bot` 和 `/api/bot/feed`。登录和管理也走 `POST /api/bot`（`auth/login`、`auth/me`、`admin/create` 这些 endpoint），网关再改写成原来的账号接口。直接调用 `/api/auth/*` 和 `/api/admin/*` 在本地开发服务器上仍然可用。
- 未登录的 `POST /api/bot` 和 `GET /api/bot/feed` 返回 401，不会请求内核。用户 A 读不到用户 B。配额为 0 时发送会被拒绝，同样不会进内核。
- 每个账号有一个稳定的 `kernelKey`。发往内核的 Bot 请求会带上 `x-botcamp-namespace`，以及调用者自己的 `botcamp_session`，好让 camp 的 nginx 认出这是已登录调用。
- 对话原文、个人设置和工作区文件跟账本走同一处存储。本地开发写在 `data/`（已 gitignore）。线上不写 `/tmp`。
- 每个账号有自己的工作区目录。文件、目录和工作区列表只来自这个目录；路径一旦越出目录，在进内核之前就拒绝。模型目录和服务商密钥任何账号（包括管理员）都不能通过页面改。用量只返回调用者自己的记录。

`NODE_ENV=production`（或 `BOTCAMP_PRODUCTION=1`）时，没有 `BOTCAMP_ADMIN_EMAIL` 和 `BOTCAMP_ADMIN_PASSWORD` 就不会创建管理员。源码里的 `admin@localhost` / `botcamp-dev` 只给本机 `npm run dev`，Demox 函数会强制按生产环境处理，不会使用这对开发密码。

新用户的默认配额是 200，可以用 `BOTCAMP_DEFAULT_QUOTA` 改。

Demox 用户函数的磁盘会在冷启动时清空，函数环境变量也不是数据库。平台留得住的业务数据在项目库里：网站 API `https://api.demox.site/website` 的 `project_rows`（MySQL），项目 `PQBDTM6GLZ`。函数设置 `BOTCAMP_STORE=demox-project` 后，账号、会话、配额、个人设置和每个账号的工作区文件都写进这个库。进程里的目录只是当次实例的缓存，打开时从项目库灌进来，写完再写回。不要设置 `BOTCAMP_DATA_DIR=/tmp/botcamp-data`。项目库一行大约 32KB，更长的正文会拆开存放。访问项目库的令牌放在函数环境变量 `BOTCAMP_STORE_TOKEN`，不要写进仓库。Demox 的个人访问令牌目前没有更细的权限，这块令牌也能管理站点，所以只放在函数环境里。

## 本地

```bash
npm --prefix app ci
npm --prefix app test
npm --prefix app run dev
```

打开 http://127.0.0.1:5173 。标题是 DeepSeek Bot。

用户库为空时，用环境变量创建第一名管理员：

```bash
BOTCAMP_ADMIN_EMAIL=you@example.com BOTCAMP_ADMIN_PASSWORD='至少 8 位' npm --prefix app run dev
```

## Demox

| 字段 | 值 |
| --- | --- |
| 项目 | `botcamp` / `PQBDTM6GLZ` |
| 站点 | `botcamp-dsh-frontend` / `IVBLF9PE` |
| 地址 | https://botcamp.demox.site/ |
| 函数 | slug `bot`，routes `/api/bot`、`/api/bot/feed`（只在创建时生效） |

```bash
./scripts/deploy-demox.sh
```

脚本会跑测试、构建页面、发布静态文件，把 `functions/bot/entry.mjs` 打成单个 `index.js` 上传，并把 `production` 别名指到新版本。云函数平台只保存入口文件的内容，所以登录、隔离和配额必须打进这一个文件。

管理员密码不要写进 git。函数上传之后单独执行（把值换成现场生成的密码）：

```bash
npx --yes @demox-site/cli@1.1.6 env set --id IVBLF9PE --slug bot \
  NODE_ENV=production BOTCAMP_PRODUCTION=1 \
  BOTCAMP_ADMIN_EMAIL=you@example.com BOTCAMP_ADMIN_PASSWORD='至少 8 位' \
  BOTCAMP_STORE=demox-project BOTCAMP_PROJECT_ID=PQBDTM6GLZ \
  BOTCAMP_STORE_TOKEN='项目库令牌'
npx --yes @demox-site/cli@1.1.6 env unset --id IVBLF9PE --slug bot BOTCAMP_DATA_DIR
```

云函数不能把一条无限 SSE 留在连接上。`/api/bot/feed` 读到第一条事件或大约 2.5 秒就取消上游。页面如果发现流在几秒内自己结束，会等 5 秒再重连。

内核进程保持：`dsh web --public-url https://camp.aigc.sx.cn/ --trusted-host camp.aigc.sx.cn`。浏览器打开 `https://camp.aigc.sx.cn/` 仍是纯文本 404。网关换 `dsh-auth` 时请求 `GET /` 并带上 `x-botcamp-exchange`，值来自函数环境变量 `BOTCAMP_KERNEL_EXCHANGE`。服务器上的 `/etc/nginx/snippets/dsh-camp-exchange.conf` 对上这个值，才把这一次请求交给内核，并继续用原来的 `/etc/nginx/snippets/dsh-camp-token.conf` 带上启动令牌。这个值不要写进 git。装上 nginx 的命令是 `./scripts/apply-camp-exchange.sh`，它读取环境变量 `sshkey`。

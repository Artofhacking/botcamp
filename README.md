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

打开 http://127.0.0.1:5173 。标题是 DeepSeek Bot，侧栏牌子是 DS Bot。未登录只会看到登录页，请求到不了内核。开发服务器会自行完成内核登录，不需要把令牌写进仓库。

## 账号

dsh 内核和 ds-bot 插件都是单租户。多个用户不能共用一个工作区再靠页面过滤。隔离做在网关里，发生在请求进入内核之前。本地由 `app/kernelProxy.mjs` 挂上 `app/botcamp/`。Demox 上的 `functions/bot` 走同一套网关，未登录的 `/api/bot` 直接 401。

- 邮箱加密码登录。没有公开注册，账号由管理员开通。密码用 scrypt 保存，不明文落地。会话是本站的 `botcamp_session` httpOnly cookie，和内核的 `dsh-auth` 不是同一个。
- 每个账号有一个稳定的 `kernelKey`，并对应自己的目录 `data/workspaces/<kernelKey>/`。文件、机器人文件夹、会话清单和设置都写在这个目录里。别人的目录不会出现在列表里，也不能被打开。
- 路径、会话 id、机器人 id、工作区 id 只要不属于当前账号，就在转发给内核之前拒绝。`../`、绝对路径和指向别人目录的符号链接同样拒绝，不会读到工作区外面。
- 发往内核的 Bot 请求会带上 `x-botcamp-namespace`。文件和文件夹接口不转发给共享内核，只读写这个账号自己的目录。`state` 和实时流只返回这个账号自己的部分。
- 主题等个人设置写在这个账号的工作区里，不会改共享内核里的全局配置。模型供应商密钥和诊断日志也不能通过页面改到别人身上。
- 对话原文另存在 `data/namespaces/<kernelKey>.json`。账本在 `data/accounts.json`。`data/` 已 gitignore，重启开发服务器后还在。不要把这个目录提交上去。云函数可以用 `BOTCAMP_DATA_DIR` 把同一份数据指到持久目录；没设置时落在该实例的临时目录，换实例后不会自动带上。
- 配额按消息条数。发送一条（`send`），或向记忆提问一次（`memory-ask`），计 1 次。配额为 0 或已用尽时，发送会被拒绝，并提示联系管理员。管理员在侧栏「用户与配额」里修改。

用户库为空时，用环境变量创建第一名管理员：

```bash
BOTCAMP_ADMIN_EMAIL=you@example.com BOTCAMP_ADMIN_PASSWORD='至少 8 位' npm --prefix app run dev
```

`NODE_ENV=production`（或 `BOTCAMP_PRODUCTION=1`）时，没有这两个变量就不会创建管理员，源码里也没有生产密码。本地 `npm run dev` 如果两个变量都没设，并且用户库是空的，会用文档里的开发账号：邮箱 `admin@localhost`，密码 `botcamp-dev`。这个默认值只给本机开发，不要拿到正式环境用。

新用户的默认配额是 200，可以用 `BOTCAMP_DEFAULT_QUOTA` 改。数据目录可以用 `BOTCAMP_DATA_DIR` 指到别处。

```bash
npm --prefix app test
```

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

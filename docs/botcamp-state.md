# BotCamp 当前状态与续做说明

> 这份文件就是“压缩后的上下文”。新会话先读它，再动手。

## 架构

```
前端（Demox）  https://botcamp.demox.site/
  ├─ /                 产品页（版本检测 + 登录态读 bc_auth_token）
  ├─ /console/         Rakazo SPA（构建 base=/console/）
  └─ /admin/           管理后台（静态单页，绝对 API 地址）
后端（腾讯云 CVM 106.53.199.91 / 内网 10.0.1.9）
  └─ https://botcamp.aigc.sx.cn   → nginx → 127.0.0.1:3100 (Rakazo API)
数据库 10.0.1.3 rakazo（Prisma + RLS）
沙箱   本机 Docker 小容器 + TKE 大容器（NFS home 挂 CFS）
```

## 认证：只用 Bearer token

- 登录响应头 `set-auth-token` → 前端存 `localStorage["bc_auth_token"]`
- 所有请求带 `Authorization: Bearer <token>`
- Cookie 已弃用（跨站会被 Safari 拦）
- 服务端 `signedBearer` 插件把 token 还原成 session
- CORS 必须暴露该头：`exposeHeaders: [SERVER_BUILD_HEADER, "set-auth-token"]`

## 部署命令

**前端**
```bash
# 服务器构建（注意 npx 要先起 pnpm：npx -y -p pnpm@9.15.0 pnpm --filter …）
cd /opt/rakazo/src && RAKAZO_WEB_BASE=/console/ npx -y -p pnpm@9.15.0 pnpm --filter @rakazo/web build
# 取出 dist（base64 传回本地，避免 SSH 断连）
cd apps/web/dist && tar czf - . | base64 -w0
# 本地展开到 /tmp/deploy2/console，写 config.js，再上传
demox deploy ./deploy2 --name botcamp-site --id IVBLF9PE --project PQBDTM6GLZ
```
**deploy2 结构**：`index.html`(产品页) + `console/`(SPA) + `admin/` + `console/config.js` + `console/computer-screen/WuyingWebSDK.js`(占位，否则 Demox 校验失败)

**后端**
```bash
cd /opt/rakazo/src && npx -y -p pnpm@9.15.0 pnpm --filter @rakazo/db generate
cd /opt/rakazo/src && npx -y -p pnpm@9.15.0 pnpm --filter @rakazo/api build
systemctl restart rakazo-api rakazo-worker
```
改 `packages/*` 也要重新 build api（esbuild 直接打包源码，不需要单独 build 包）。

## 部署配置（console/config.js）

```js
window.__RAKAZO_API_ORIGIN__ = "https://botcamp.aigc.sx.cn";
window.__RAKAZO_UI__ = { hiddenSections: ["models", "computer", "billing", "voice"] };
```

## 已完成

- 三端 token 认证；产品页/控制台/后台登录状态一致
- 档位：free/pro/plus/max/max_plus，额度用「积分」算（1000 积分 = ¥10 标价），对外只显示百分比
- 额度周期以 `user.quotaAnchorAt`（改档时刻，UTC）为锚，每 7 天一轮，用量页显示具体重置日期
- 全部用户 pro；演示账号已删；旧 Python 系统已停（备份 `botcamp/backups-legacy-botcamp.db`）
- 旧用户迁移：`legacy_credentials` 存 PBKDF2，首次登录自动升级为 scrypt
- 主 bot：`bots.isPrimary` + 唯一索引 + 回填（每人最早创建的 bot）
- 主 bot 鉴权：只有它能创建/删除/归档其他 bot；主 bot 不可自删
- 主 bot 角色提示：`run-instructions.ts` 里 `PRIMARY_BOT_DUTIES` 注入
- 主 bot 才拿到管理工具：`executor.ts` 给非主 bot 的 disabled 集合塞
  `BOT_MANAGEMENT_TOOL_NAMES`（spawn/archive/delete + 全部 fleet 工具），运行中
  `run-tool-request.ts` 再查一次 `isPrimary`
- `delete_bot` 真删除：`child-bots.ts#deleteSpawnedBot` → `destroyBot`，拒绝主 bot 自删，
  需 owner 在审批卡确认
- 转移主 bot：`bots.update { isPrimary: true }` 事务里降旧抬新；面板「权限」里是
  「主 bot」一行（当前 / 设为主 bot 按钮），不再有 Manage other bots 开关
- 新账号第一个 bot 自动 `isPrimary`（`repos.ts#createBot`）
- 修好登录：`Auth.tsx` 的 `signInWithLegacyFallback` 原本定义在重置密码组件里，
  登录页调用时是 `ReferenceError` → 邮箱密码登录一直报「无法连接服务器」；已移回模块层并重新部署
- 修好深链接刷新：PWA 之前按站点根写死（precache `"/"`、`/assets/*`），在 `/console/` 子路径下
  预缓存全是 404 → SW 装不上。现在 `rakazoPwa(buildId, base)` 按 base 生成 precache/manifest，
  SW 对 base 内的导航直接回外壳，刷新深层路径不再 404
- 修好模型中转：nginx `/etc/nginx/conf.d/opencode-go.conf` 少 `Authorization` 头，
  opencode 上游返回 401「Go requires a credential」；已补 `proxy_set_header Authorization`
- 工具配置收口：bot 设置里不再有「禁用工具」选择器和开关列表，所有工具默认全开
  （`disabledBuiltinTools` 字段保留，主 bot 鉴权靠它给非主 bot 关工具；线上现有 bot 该列表都是空）
- bot 面板「高级」去掉模型/电脑/语音；设置里隐藏四个区块
- 砍掉上游痕迹（第一批）：集成弹层里的「提交插件」（原来跳 rakazo.com）已删，
  `SUBMIT_PLUGIN_URL` 常量一并删除；登录页标题从「登录 Rakazo」改成「登录 BotCamp」
- 空间设置的覆盖项也跟着 `hiddenSections` 过滤（`SpaceSettingOverrides` 里 `.filter(!sectionHidden)`），
  现在只剩「审批 / 保管库」两项，模型和语音不再出现

## 未完成（按顺序）

1. ~~部署默认模型通道不通~~ **已修（2026-11-05）**：nginx 加了 `/v1/` 网关
   （`set $relay_expected` 校验 Bearer，无 key 返回 403），`PI_COMPATIBLE_BASE_URL` 改成
   `https://botcamp.aigc.sx.cn/v1`，重启 api+worker。所有没有个人连接的账号统一走这个口。
   下面保留当时的排查记录：
   
   owner 账号 23:23 的 run 是 `completed`（首字 5.5s），走的是它自己的模型连接；
   而 `quota-test` 这类只有部署默认的账号回落到 3199 中转会 `run.failure=TransientModelError
   reason=Connection error.`。nginx 3199 访问日志里**没有任何来自应用的请求**，
   但同机 `curl`/`node fetch` 打 `http://127.0.0.1:3199/v1` 都是 200 —— 连接在建立前就失败了。
   已排除：中转 401（已修）、私网端点开关（`MCP_ALLOW_PRIVATE_ENDPOINT=true` 已试）、配额（0%）、
   env 配置。建议：把中转挂到公网 HTTPS（`https://botcamp.aigc.sx.cn/v1/` + Bearer 校验，
   注意 nginx `if` 里带引号的 header 比较会报 `invalid condition`，改用 map），
   或给每个账号配自己的模型 key，绕开部署默认。
2. 可选：`fleetManagement` 字段已不参与鉴权（保留只为兼容），可择机删掉列与契约字段
3. 可选：额度按自然周显示、大容器（TKE）端到端验证
4. 测试债：`apps/web/src/pages/shell/bot-panel.test.tsx` 仍断言已删掉的模型/语音区块、
   「Manage other bots」开关和「Disable a tool」选择器（部署不跑它，要跑就先改断言）

## 产品页 / 下载

- 页面源文件：`botcamp/web/site/index.html`，部署到 Demox 根路径（`/`）
- 登录态：读 `localStorage.bc_auth_token` + `/api/auth/get-session` 校验；未登录右上角只有「登录」，
  登录后显示邮箱/退出 + 高亮的「进入控制台」（手机端隐藏邮箱，只留退出和入口）
- 下载：Android 按钮直链 `https://botcamp.aigc.sx.cn/downloads/BotCamp-2.1.0.apk`，
  macOS / Windows / iOS 是「即将推出」占位卡片
- **Demox 不托管 .apk**（部署会报「是可执行文件」），安装包放在 CVM：
  `/var/www/downloads/*.apk` + nginx `location /downloads/`（`application/vnd.android.package-archive`）

## 关于 / 检查更新

- 控制台「设置 → 关于」：显示 BotCamp 版本（安卓壳注入 `window.__BOTCAMP_APP__`，网页回落构建号），
  一个「检查更新」按钮拉 `https://botcamp.aigc.sx.cn/downloads/latest.json`，有新版本显示「下载」
- 发布新版本：传 apk 到 `/var/www/downloads/`、改 `latest.json` 的 `version` 和 `android` 地址、
  改产品页的 `ANDROID_VERSION` 与链接，重新打包安卓壳时把 `APP_VERSION`、`build-apk.sh` 的版本号一起改

## 安卓 APK

- 工程：`botcamp/android`（WebView 壳，只加载 `/console/`，不含产品页/后台）
- 构建：`cd android && ./build-apk.sh`（aapt2+javac+d8+apksigner，不需要 Gradle）
- 产物：`dist/BotCamp-2.1.0.apk`，包名 `site.demox.botcamp`，versionCode 2050
- 下载地址：`https://botcamp.aigc.sx.cn/downloads/BotCamp-2.1.0.apk`（nginx 静态）
- 签名：`android/botcamp-android.keystore`（沿用旧壳的密钥，可覆盖安装）
- 细节见 `android/README.md`；页面是远端的，改网页不用重装 APK

## 关键环境

- `.env`：`PI_*`（模型固定 deepseek-v4.1-flash，中转 127.0.0.1:3199）、`MANAGED_MODELS_ONLY=1`、
  `RAKAZO_CROSS_SITE_COOKIES=1`、`WEB_ORIGIN=https://botcamp.demox.site`、
  `BETTER_AUTH_URL=https://botcamp.aigc.sx.cn`、`RAKAZO_ADMIN_USER_IDS`
- 管理后台管理员：`phosa@qq.com`（靠 `RAKAZO_ADMIN_USER_IDS`，无邮件验证）
- 测试账号：`quota-test@example.com` / `Test1234!pass`
- SSH：`root@106.53.199.91` 用 `~/.botcamp-edge.pass`；旧服务器 `root@server.aigc.sx.cn:2222` 用 `~/.botcamp-nat.pass`（已停服）

## 已知坑

- Demox 拒绝 `app/` 目录名（改成 `console/`）；没有 SPA 回退，直接访问/刷新 `/console/xxx` 是 404。
  **已修**：Service Worker 对 `/console/` 下的导航直接返回缓存的外壳（`pwa/service-worker.ts`），
  前提是这台浏览器访问过一次控制台（SW 需要先安装）；安卓壳里另有原生 `shouldInterceptRequest` 兜底
- HashRouter 与 `useTransitions` 不兼容 → 白屏，勿改
- Lingui 未编译的新字符串会显示哈希 ID（如 `ZDZ2jZ`），产品文案直接写中文字面量
- 迁移时 `now()` 写入的是本地时间，必须 `now() AT TIME ZONE 'UTC'`

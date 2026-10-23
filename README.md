# BotCamp

自媒体创作者工具：按设计文档持久化 **MediaAccount（自媒体账号）** 号下数据，并用带标签页的工作台查看。

种子账号：**小稿的AI日记 @ 小黑盒**（`xiaoheihe`）。Schema 固定，无用户自定义字段。凭证只存 `credential_ref` 指针，不入库密文。

## 本地运行

```bash
npm install
npm install --prefix web
npm run seed          # 写入 data/kv + data/blobs（host.kv 形状）
npm run test:isolation  # 证明 phosa 看不到 other_creator 的号
npm run dev           # API :8787 + Vite :5173（已代理 /api）
```

浏览器打开 http://127.0.0.1:5173 → 登录 `phosa` 或 `other_creator`（演示切换）。

生产：

```bash
npm run build
npm start             # 种子 + Express 托管 web/dist，端口 8787
```

## 多用户隔离

- 每个请求经 session（httpOnly cookie `botcamp_session` 或 `Authorization: Bearer`）解析 `owner_user_id`。
- 无硬编码全局 OWNER；未登录访问数据 API → **401**。
- `GET /api/accounts/:id` / manuscripts / workspace：资源 `owner_user_id` 不匹配 → **403**。
- 列表只返回 `owner:{uid}:media_accounts` 下且归属校验通过的号。
- `/api/debug/kv-keys` 已删除，不向客户端暴露全局 KV。
- 种子：`phosa` → 小稿的AI日记；`other_creator` → 别家效率号（含机密选题探针）。

## 存储键 → UI Tab

| Tab | KV / 数据 |
| --- | --- |
| 运营看板 | 派生自号下实体（`accountStore.deriveBoard`） |
| 帖子 / 选题发布 | `media_account:{id}:post:*` |
| 历史稿件 | `media_account:{id}:manuscript:*` + `data/blobs/manuscripts/**` |
| 已发作品 | Post 中 `status∈{已发布,被隐藏}`（当前镜像指标） |
| 互动快照（趋势） | `media_account:{id}:engagement_snapshot:*`（SoT，append-only） |
| 粉丝 | `media_account:{id}:follower_snapshot:*` |
| 收益 | `media_account:{id}:revenue:*` |
| 平台事件 | `media_account:{id}:platform_event:*` |

权威链：趋势以互动快照为准；帖子 metrics 仅为当前镜像；稿页 ≠ 发布版。

设计文档：仓库外 Project store `docs/account-data-model.md`（小黑盒实操锚定）。

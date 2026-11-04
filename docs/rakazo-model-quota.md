# Rakazo 改造：模型锁定 + 计量 + 周额度

分支 `rakazo`。三条硬约束：

1. 用户**不能配置模型、不能选模型、不知道用的是什么模型**
2. 每个用户的 token 使用**精确记录**
3. 管理员可给每个用户配**每周额度**，默认 **50,000,000**（五千万）总 token

## 一、现状（已核实，非推测）

Rakazo 本身已经具备大部分底座，改造量比预想小：

| 能力 | 位置 | 状态 |
|---|---|---|
| 用量记录表 | `usage_records`（`UsageRecord`） | ✅ 已有 input/output/cache/reasoning/total tokens、cost、provider、model、userId、runId |
| 写入函数 | `packages/db/src/usage.ts` `recordUsage()` | ✅ 已在 `executor.ts` / `run-turn.ts` 等调用 |
| 部署级模型 | `resolveDeploymentModel()`（`packages/adapters/src/deployment-model.ts`） | ⚠️ 只支持 openrouter / anthropic，**不支持自定义 baseUrl** |
| 用户自带 key | `UserModelCredential` + `findModelCredential()` | 需要**旁路**掉 |
| 额度 | 无 | 需新增 |
| 管理员 | `DeploymentSettings.ownerUserId`（已废弃、不鉴权）、`isAdmin()` | 需确认来源 |

关键发现：`modelSetup()`（`apps/api/src/routes/shared.ts`）的优先级是
**用户自己的凭证 > 部署级模型**。所以只要把这段改成"永远走部署级"，用户 key 就自动失效。

## 二、改造方案

### 2.1 打通自定义渠道（openai-compatible）

`deployment-model.ts` 增加分支：

```ts
// PI_DEFAULT_PROVIDER=openai-compatible
// PI_COMPATIBLE_BASE_URL=https://<我们的渠道>/v1
// PI_COMPATIBLE_API_KEY=sk-xxx
// PI_DEFAULT_MODEL=<模型 id>
```

`configured = Boolean(baseUrl && key)`，模型走现有 `OPENAI_COMPATIBLE_PROVIDER_ID` 适配器。

### 2.2 强制使用部署模型（用户 key 失效）

`apps/api/src/routes/shared.ts` 的 `modelSetup()`：

```ts
const main = FORCED ? null : (member && ... ? member : null);
```

`FORCED = process.env.MANAGED_MODELS_ONLY === "1"`。

同时 `needsModel` 恒为 `false`，前端就不会再弹"去配置模型"。

### 2.3 隐藏模型相关 UI / 接口

- `apps/api/src/routes/models.ts` 在 `MANAGED_MODELS_ONLY=1` 时对写操作返回 403（保留读，用于内部展示"当前可用"）
- Web：设置页隐藏「模型」区块（`apps/web/src` 里搜 `model-settings`，e2e 有 `model-settings.spec.ts` 可作定位参考）
- `deployment/status` 返回里把 `defaultProvider`/`defaultModel` 置空，避免泄露模型名

### 2.4 周额度

**Schema**（`packages/db/prisma/schema.prisma`，`User`）：

```prisma
weeklyTokenQuota BigInt @default(50000000)
```

**额度计算**（新增 `packages/db/src/token-quota.ts`）：

```ts
// 自然周，周一 00:00 起（按用户时区，缺省 UTC+8）
export function weekStart(now = new Date(), tz = "Asia/Shanghai"): Date

// 本周已用：SUM(totalTokens) FROM usage_records WHERE userId=? AND createdAt >= weekStart
export async function weeklyUsage(prisma, userId, now?): Promise<bigint>

// 超额则抛 QuotaExceededError，带上 used / quota / 重置时间
export async function assertWithinQuota(prisma, userId, now?)
```

**执行点**：
- 开工前：`threads.ts` 启动 run 时 `assertWithinQuota`，超额返回 429 + 友好提示
- 开工后：`recordUsage()` 已有，无需改（token 数来自 provider 响应，精确到每次调用）
- 兜底：单次 run 结束后再校验一次，防止一个 run 内超支过多

**管理员接口**（新增 `apps/api/src/routes/admin-quota.ts`）：

```
GET  /api/admin/quota           列出用户 + 本周用量 + 额度
PUT  /api/admin/quota/:userId   { weeklyTokenQuota: number }
```

鉴权：`isAdmin()`；管理员身份用 `DeploymentSettings` 新增 `adminUserIds String @default("")`（逗号分隔）或复用现有 `AUTH_ADMIN_EMAILS` 环境变量（需确认 `isAdmin` 实现）。

## 三、待确认（阻塞项）

1. **渠道三要素**：base URL、key、模型 id。目前只知道走的是 BotCamp 的 relay（`/botcamp/api/relay/*`，计量 0.14/0.28 每百万 token），但上游 key 在旧服务器的网关配置里，需要取出来。
2. **管理员怎么定义**：用环境变量白名单，还是库里的字段？
3. **超额行为**：直接拒绝（推荐），还是降级到小模型？

## 四、验证清单

- [ ] 新用户注册后不出现任何模型配置入口
- [ ] 用户在设置里看不到模型名；接口返回里也没有
- [ ] 一次对话后 `usage_records` 有记录，token 数与渠道账单一致
- [ ] 把额度改成 1000，发起对话，第 2 轮被拒并提示
- [ ] 周日 23:59 → 周一 00:01 用量归零

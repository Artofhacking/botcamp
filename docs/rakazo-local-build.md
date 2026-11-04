# Rakazo 本地构建（Mac 测试用）

分支 `rakazo`。目标不是发版，是**在本机跑起来一套可点的产品**给你验收。

## 为什么是 Rakazo

| 项目 | 星 | 许可 | 形态 | 结论 |
|---|---|---|---|---|
| **Rakazo** `elie222/rakazo` | 6.8k | Apache-2.0 | TS 全栈，Web + Electron + iOS + Android | **选它** |
| OpenMausBot | 11.7k | Apache-2.0 | Electron 为主 | 云和手机弱 |
| Gawkbot | 1.5k | 非 OSI（Sustainable Use） | — | 许可证挡产品化 |
| Celesto | 1.1k | Apache-2.0 | 只有运行时 | 是零件不是产品 |

决定性证据：Rakazo 已有 `packages/adapters/src/kubernetes-sandbox.ts`（735 行），
`SandboxProvider` 抽象里包含 namespace / runtimeClassName / computerImage / cpuLimit /
memoryLimit / homeClaim，底层用 `@kubernetes/client-node` 的 create/delete/read/exec。
这和我们已建好的 TKE + 超级节点 + CFS 是同一个模型。

## 本机环境要求

- Node **26**（`/opt/homebrew/opt/node@26/bin`）——仓库 `engines` 要求 `^22.22.2 || ^24 || >=26`，
  本机默认 22.22.0 会被 `engine-strict=true` 挡住
- pnpm 9.15.0（走 `npx -y pnpm@9.15.0`，不走本机 pnpm 10）
- Docker（用 colima：`colima start --cpu 4 --memory 8 --disk 60`）

## 构建步骤

```bash
cd ~/data/project/rakazo
cp .env.example .env    # 填 POSTGRES_PASSWORD / POSTGRES_APP_PASSWORD / BETTER_AUTH_SECRET

export PATH="/opt/homebrew/opt/node@26/bin:$PATH"
npx -y pnpm@9.15.0 install

pnpm dev                # 起 postgres 容器 + api(3100) + worker + web(5173) + supervisor(7091)

pnpm --filter @rakazo/desktop pack:dir   # 产出未签名 .app
```

产物在 `apps/desktop/dist/mac-arm64/`。

## 已知的网络坑（本机实测）

- `ghcr.io` **不可达**（超时）→ 桌面端自带的「本地镜像栈」用不了，必须走源码 `pnpm dev`
- npm 官方源慢（单请求 8–10s），npmmirror / 腾讯 / 华为镜像同样慢或不可用 → 安装耗时长，`--prefer-offline` 可复用缓存
- 首次 `pnpm install` 拉下来约 3 GB store

## 和已建云资源的关系

| 现有资源 | 在 Rakazo 里的位置 |
|---|---|
| TKE 集群 `cls-fkgj580u` + 超级节点 | `KubernetesSandboxOptions.namespace` / `runtimeClassName` |
| CFS `10.0.4.2` | `homeClaim` + `homes/<bot id>` 子目录 |
| TCR 私有镜像 | `computerImage` |
| Pod 出网 SNAT | Rakazo 不管网络，沿用现有配置 |
| `sandbox/control/app.py`（自研控制面） | 可退役，Rakazo 自己调 K8s API |

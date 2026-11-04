# BotCamp 云端化改造方案（TKE Serverless）

> 状态：P0 启动
> 更新：2026-11-03
> 价格口径：腾讯云广州、AMD 机型、刊例价（2026-11 抓取，不含活动折扣）

## 1. 目标与边界

**目标**：把「每人一台跑在自己电脑上的 Bot 团队」改成「集中式聊天层 + 按需沙盒」。用户不再需要装桌面端、不需要自己的设备在线；手机和网页打开就是同一个会话。

**不做**：

- 不追求 7×24 常驻容器。会话结束后沙盒立即销毁。
- 不在容器里跑模型推理。模型继续走网关（`/botcamp/api` 计费链路不变）。
- 不在这一期做多地域、多可用区容灾。10–300 人规模用单地域。

**成立的前提**（上一轮讨论确定的四条）：

1. 状态 100% 外置：工作区在 CFS，媒体在 COS，对话在聊天层 DB。
2. 沙盒可随时销毁，靠 drain 保证不丢工作。
3. 大对象不经服务器：浏览器直连 COS 预签名地址。
4. 5Mbps 只承载控制面（HTML/JSON/SSE），不升级带宽。

## 2. 目标架构

```
手机 / 网页
   │  HTTPS  camp.aigc.sx.cn
   ▼
┌─────────────────────────────────────────────┐
│ nginx（现有 CVM，2C4G）                       │
│  /botcamp/     → 网关 8790（账号/计费/路由）   │
│  /u/<uid>/     → 沙盒控制面 8791              │
│  /_next/ /m/   → 静态（开 gzip）               │
└───────────────┬─────────────────────────────┘
                │ 内网
                ▼
┌─────────────────────────────────────────────┐
│ 沙盒控制面（sandbox/control，8791）           │
│  lease 生命周期 · drain · 配额 · 反向代理      │
└───────┬───────────────────────┬─────────────┘
        │ Pod API（K8s）         │ 对象存储
        ▼                       ▼
┌──────────────────────┐   ┌──────────────┐
│ TKE Serverless 超级节点│   │ COS           │
│  Pod: 1C2G, TTL 10min │   │ 媒体 / 备份    │
│  └ 挂载 CFS subPath   │   └──────────────┘
└──────────────────────┘
        │ CFS（NFS，内网）
        ▼
   /home/user/<uid>  ← 工作区唯一真相
```

### 组件清单

| 组件 | 选型 | 作用 | 是否新增 |
|---|---|---|---|
| 入口 | 现有 nginx + 现有 CVM | TLS、静态、路由 | 否 |
| 网关 | `server/app.py` | 账号、token 计费、会话 | 否（改路由） |
| 沙盒控制面 | `sandbox/control/app.py` | lease/Pod/代理 | **是** |
| 沙盒运行时 | `sandbox/image` | headless DSH host + 工具链 | **是** |
| 编排 | TKE Serverless 超级节点 | 按秒计费、微虚拟机隔离 | **是** |
| 工作区存储 | CFS 通用标准型 0.35 元/GB·月 | POSIX，多 Pod 挂载 | **是** |
| 媒体存储 | COS 标准 0.099 元/GB·月 | 直链下发、备份 | **是** |
| 出口 | NAT 网关 0.195 元/h + CU | 沙盒唯一公网出口 | **是** |
| 镜像仓库 | TCR 个人版（免费） | 镜像分发 | **是** |
| 日志 | CLS | 结构化采集 | **是** |
| 设备隧道 | `agent/` + `/desk/dN/` | 旧架构 | **下线** |

## 3. 关键设计决策

### D1. lease 而不是容器

沙盒按 **lease** 管理，不是按容器。一个 lease = `(user_id, session_id)`，字段：

```
id, user_id, session_id, state(running|draining|dead),
pod_name, pod_ip, created_at, expires_at, last_used_at, billed_seconds
```

- 同一用户同时最多 1 个 lease（第二个请求复用或排队）。
- 默认 TTL 600s，每次代理请求续期 120s，上限 2 小时（长任务走显式续期）。
- 到期前 60s 进入 `draining`，拒绝新请求但允许存量请求完成。

### D2. 一个回合一个 Pod，不要一调用一个

多步工具循环（读→改→测→修）必须复用同一个 Pod，否则冷启动次数 ×5。控制面按 session 维度保活，会话结束才销毁。

### D3. 资源规格靠 requests/limits 表达

TKE Serverless 会根据 `requests/limits` 自动匹配规格；不写则默认 1C2G。显式写死更可控：

```yaml
annotations:
  eks.tke.cloud.tencent.com/cpu: "1"
  eks.tke.cloud.tencent.com/mem: "2Gi"
```

三档规格，按任务类型选：`small` 0.5C1G（纯文本/命令）、`std` 1C2G（默认）、`big` 2C4G（构建/浏览器）。

### D4. 工作区用 CFS subPath，不用每用户一套 PVC

一套 CFS 文件系统 + `/users/<uid>` 子目录，Pod 通过 `volumeMounts.subPath` 挂载。好处：不用给每个用户建 PV，扩容只需扩文件系统。

**禁止把 `node_modules` 放 CFS**：通用标准型元数据性能弱，冷缓存下 `npm install`/`git status` 会慢到不可接受。依赖和工具链全部预烘焙进镜像，工作区只放源码和产物。

### D5. 媒体走 COS，不走反代

沙盒里产生的截图、视频、导出文件，落盘后立即上传 COS，消息里只放 key。控制面签发预签名 URL（默认 15 分钟），浏览器直连 COS。

- COS 外网下行 0.5 元/GB（比 CVM 按流量 0.8 元/GB 便宜）
- 同地域 CVM/沙盒访问 COS 走内网，免费
- 5Mbps 链路只承载 HTML/JSON/SSE

### D6. drain 是一等公民

Pod 收到 SIGTERM 后：停止接受新请求 → 等待在途请求（最长 30s）→ 把脏数据 sync 到 CFS → 退出 0。控制面在 `draining` 状态等 Pod 真正退出才删除，超时才强杀。

容器里跑的东西必须能承受「随时被回收」，唯一的补偿是 CFS 上的工作区。

### D7. 出口收口 + 配额

- 所有 Pod 走 NAT 网关，安全组只放行 443/80 + 网关内网地址。
- 每用户每秒请求数、每分钟沙盒秒数、并发 lease 数三个配额，超限直接 429。
- 出口域名白名单（可选，P3 再做）：防止被当跳板。

## 4. 容量与成本

### 4.1 单人成本模型

沙盒 1C2G = (0.061 + 0.032×2) × 730 ≈ **0.125 元/小时 = 0.12 元/10 分钟**。

| 使用强度 | 计费小时/月 | 算力成本 |
|---|---|---|
| 10 轮/天 × 2 分钟 | 100 | 12.5 元 |
| 20 轮/天 × 3 分钟 | 300 | 37.5 元 |
| 50 轮/天 × 5 分钟 | 1,250 | 156 元 |

### 4.2 当前定价方案：5 人，纯按需（方案一）

已确认按「纯按需、无轻壳」配置：不做常驻轻壳，沙盒只在工具回合存在，入口机兼做 SNAT。

| 项 | 计算 | 月费 |
|---|---|---|
| 入口机 CVM 2C2G（包月，100M 按流量 EIP） | 含 nginx/网关/控制面/NAT | **105.4** |
| TKE 沙盒 | 5 人 × 20 轮 × 3 分钟 = 150 pod·h × 0.125 | **18.8** |
| CFS | 5 × 2 GiB = 10 GiB × 0.35 | **3.5** |
| 日志 CLS | 5 人量级 | ~5 |
| 出口流量 | 1–3 GB × 0.8 | 1–2.4 |
| **合计** | | **≈ 134** |
| **人均** | | **27** |

入口机 7×24 必须在线，适合包年：`825 元/年 = 68.8 元/月`，合计降到 **≈ 97 元/月，人均 19.5**。

> 5 人时入口机占 79%，沙盒只占 14%。**省钱的杠杆是入口机，不是沙盒。**

### 4.3 三种形态对比（5 人）

| 形态 | 月费 | 人均 | 体验 |
|---|---|---|---|
| **纯按需（当前选择）** | 134 / 包年 97 | 27 / 19.5 | 每回合开头等 5–10 秒 |
| 轻壳 + 按需 | ≈ 170（入口机换 2C4G） | 34 | 秒响应 |
| 全常驻 0.5C1G | ≈ 270 | 54 | 零冷启动、支持长任务 |

### 4.4 规模外推（纯按需口径）

| 项 | 5 人 | 100 人 | 1,000 人 |
|---|---|---|---|
| 沙盒算力 | 19 | 375 | 3,750 |
| CFS（2 GiB/人） | 3.5 | 70 | 700 |
| 入口机（含 SNAT） | 105 | 210（双机） | 700（多机 + CLB） |
| 日志 + 流量 | 7 | 120 | 900 |
| **合计** | **≈ 134** | **≈ 775** | **≈ 6,050** |
| 人均 | 27 | 7.8 | 6.1 |

规模上来后固定成本被摊薄，人均从 27 元掉到 6 元。

### 4.3 一次性成本

- 工程：3–5 人月（控制面 1.5、镜像与工具链 1、存储与媒体 0.5、联调与灰度 1）
- 现金：0（全部按量）

## 5. 迁移阶段

### P0 — 抽象与地基（本周，不花钱）

| 产出 | 验收 |
|---|---|
| `sandbox/control` 控制面（lease API + Docker 后端） | `POST /leases` 起容器、`DELETE` 销毁、`/healthz` 通 |
| `sandbox/image` 沙盒镜像（headless host + drain） | 容器内 8765 可访问，SIGTERM 后 5s 内退出且工作区已 sync |
| 网关路由抽象 | `/api/relay/go` 能按 `BOTCAMP_SANDBOX_URL` 返回 `/u/<uid>/` |
| nginx gzip | 首屏 JS 传输体积从 400 KB 降到 ≤ 120 KB |

### P1 — 本地验证（第 2 周）

| 产出 | 验收 |
|---|---|
| Docker 后端跑通 lease 全生命周期 | 10 个 lease 反复启停 100 次，无残留容器、无孤儿卷 |
| 反向代理 `/u/<uid>/` | 手机打开能连进沙盒里的 host，SSE 正常 |
| drain 压测 | 100 次 Random Kill，工作区文件零丢失 |

**注意**：这一步需要一台能跑 Docker 的机器。现有 2C4G/20GB 的机器腾不出来（实测剩 3.3 GB），必须新开一台 4C16G 轻量（320 元/月）或直接用 TKE。

### P2 — 切 TKE（第 3–4 周）

| 产出 | 验收 |
|---|---|
| K8s 后端（Pod 直连 API server） | 与 Docker 后端同一接口，切换只改一个环境变量 |
| CFS subPath 挂载 | Pod 重建后工作区内容不变 |
| 灰度 1–3 个用户 | 一周内无 P1 故障 |
| 冷启动基线 | p95 ≤ 8s（空集群首次），预热后 ≤ 4s |

### P3 — 媒体与存储改造（第 5–6 周）

| 产出 | 验收 |
|---|---|
| 沙盒产物自动上传 COS | 截图/视频不再经过控制面 |
| 预签名 URL 下发 | 浏览器直连 COS，控制面只返回 302 |
| 更新包迁 COS + CDN | `/botcamp/updates/` 从 alias 改为 302 |
| 备份策略 | CFS 每日快照 + COS 跨地域复制（可选） |

### P4 — 下线旧架构（第 7–8 周）

| 产出 | 验收 |
|---|---|
| 全量切 `/u/<uid>/` | `/desk/dN/` 无流量（观测 7 天） |
| 删设备槽位与隧道 | nginx 去掉 10 个 location，`agent/` 归档 |
| 计量接沙盒秒数 | 账单里能看到每用户沙盒时长 |
| 成本看板 | 日粒度：算力/存储/流量/人均 |

## 6. 接口契约

控制面（内网，Bearer `SANDBOX_TOKEN`）：

```
POST   /leases              {user_id, session_id, profile?}  → {id, expires_at}
GET    /leases/{id}                                          → {state, pod_ip, ...}
POST   /leases/{id}/extend  {seconds}                        → {expires_at}
DELETE /leases/{id}         {reason}                         → {ok: true}
GET    /healthz                                              → {ok, leases, backend}
```

网关侧：

```
POST /botcamp/api/relay/go  →  {redirect: "/u/<uid>/"}    ← 取代 "/desk/dN/"
```

nginx 侧：

```
location ^~ /u/ {
    auth_request /botcamp/api/relay/check/any;   # 复用现有鉴权子请求
    proxy_pass http://127.0.0.1:8791;            # 控制面
    proxy_buffering off;                         # SSE 必须关
    proxy_read_timeout 3600s;
}
```

## 7. 风险登记册

| 风险 | 影响 | 对策 |
|---|---|---|
| 冷启动 30s+ | 用户体感差 | 瘦镜像（<500MB）+ 投机预热（模型开始流式输出时并发起 Pod） |
| Pod 被回收时丢工作 | 数据丢失 | drain + 30s 宽限 + 工作区直写 CFS |
| VPC IP 耗尽 | 新 Pod 调度失败 | 子网 /22 起，IP 回收监控 |
| CFS 元数据慢 | 工具变慢 | 依赖预烘焙，工作区只放源码 |
| 出口被滥用 | 账单/安全 | NAT + 安全组 + 配额 + 域名白名单 |
| 并发打满配额 | 突发不可用 | 预热池 20 个 + 队列 + 429 |
| 单地域故障 | 全站不可用 | 本期接受；P4 后评估双地域 |
| 改造成本超预期 | 延期 | P0/P1 用 Docker 后端，随时可停在「单机沙盒」形态 |

## 8. 上线与回滚

**灰度顺序**：内部 1 人 → 3 人 → 10 人 → 全量。每档观察 3–7 天，指标：

- lease 成功率 ≥ 99%
- 冷启动 p95
- drain 丢失率 = 0
- 每用户日沙盒秒数
- 5Mbps 入口带宽利用率 < 60%

**回滚**：网关保留 `BOTCAMP_SANDBOX_URL` 开关，置空即回到 `/desk/dN/` 隧道。控制面与 TKE 集群可整体删除，无状态。

## 9. 待确认（阻塞进 P2 的项）

1. 腾讯云账号：是否有可用额度/子账号，地域定广州还是上海。
2. CFS 文件系统是否已创建（需要 ID 才能建 StorageClass）。
3. VPC 与子网网段（决定并发上限）。
4. 域名：`/u/<uid>/` 是否复用 `camp.aigc.sx.cn`，还是要独立子域。
5. 沙盒里要不要允许用户 `pip install` / `npm install`（影响镜像与配额策略）。
6. 单用户数据上限（决定 CFS 容量与配额告警阈值）。

## 10. P0 实况（2026-11-03）

**目标账号：易点 `100052992193`**（子用户 `phosa` / `100052993095`，tccli profile `yidian`），余额 986 元。
`100021031865`（VPC「友序」）是另一个账号，只托管现有生产服务器，不是本次改造的目标。

### 10.1 易点账号已建资源

| 资源 | ID | 规格 | 费用 |
|---|---|---|---|
| VPC | `vpc-4oxk960z`（botcamp） | `10.0.0.0/16` | 0 |
| 子网（沙盒） | `subnet-22j4ijw2` | `10.0.4.0/22`，1021 IP | 0 |
| 子网（入口） | `subnet-4p0czj3k` | `10.0.1.0/24`，253 IP | 0 |
| CFS | `cfs-c76f7i8n`（botcamp-home） | 通用标准型 SD，NFS，挂载点 `10.0.4.2` | ≈ 3.5 元/月 |
| 入口机 CVM | `ins-cuqxolew` | 2C2G / 50GB，`10.0.1.9` / `106.53.199.91` | 首月 28.98，续费 115.9 |
| TKE 集群 | `cls-fkgj580u` | **标准集群 L5**，K8s **1.36.2**，VPC-CNI | **0.13 元/时 ≈ 95 元/月** |
| 超级节点池 | `np-1szy8zdk` | 子网 `subnet-22j4ijw2`，节点 `eklet-subnet-22j4ijw2-pmyblozp` | 按 Pod 秒计费 |
| 沙盒安全组 | `sg-dit3ttvr` | 入站仅 `10.0.1.9/32`，出站全放通 | 0 |

**集群 API 内网端点：`https://10.0.1.13`**（外网端点未开，控制面走内网）。

### 10.2 已验证

- 集群状态 Running，超级节点 Ready
- 通过 API 建 Pod：`busybox` 启动成功，`podIP = 10.0.4.3`（在沙盒子网内），状态 Running
- 用 client 证书直接调 K8s API（未装 kubectl，证书在 `/root/.kube/pki/`）
- **Pod 出网已打通**：沙盒子网路由表 `rtb-pblouhl2`（`0.0.0.0/0 → NORMAL_CVM 10.0.1.9`），入口机 `ip_forward + MASQUERADE`；实测 Pod 出口 IP = `106.53.199.91`，`curl pypi.org` 返回 200

### 10.3 尚未完成

| 项 | 说明 |
|---|---|
| 聊天层路由改造 | 网关还没接 `/u/<uid>/` |
| 沙盒镜像替换真实 host | 目前镜像里是占位 HTTP 服务 |

### 10.4 CFS 挂载：CSI 走不通，改用特权 Pod 自挂

超级节点上**所有 node 级 daemonset 的 desired 都是 0**（没有常规节点），CFS CSI 的 node plugin 跑不起来，PVC 能 Bound 但 Pod 永远 `FailedMount: mount failed`。

可用方案：Pod 里自己挂（已验证）

```bash
mount -t nfs -o vers=4.0,noresvport 10.0.4.2:/ /home/user
```

- 需要 `privileged: true`（或 CAP_SYS_ADMIN）
- **必须用 v4.0**：v3 报 `No such file or directory`；导出路径是 `/`，不是 `/cfs-xxx/`
- 实测：Pod 写入的文件能在入口机挂载后看到，共享生效

沙盒镜像（`/opt/botcamp-sandbox/Dockerfile`）：`alpine:3.20` + `nfs-utils` + `python3`，entrypoint 挂 CFS 后起 8765 端口的健康服务，收到 SIGTERM 时 umount。构建时 apk 必须换腾讯源（`mirrors.cloud.tencent.com`），走默认 CDN 会卡死。

### 10.5 镜像分发的坑

- 入口机上起了 `registry:2`（`10.0.1.9:5000`），`docker push` 成功
- 超级节点拉取报 `ImagePullBackOff`——它只认 HTTPS registry，HTTP 一律拒绝
- TCR 企业版通过 API 创建失败：`TCR_QCSRole` 需要 COS 权限，手工建角色 + 挂 `QcloudTCRFullAccess` 后仍报 COS 403
- **结论：TCR 必须在控制台开通一次**（控制台会自动配好角色和 COS 权限）

### 10.6 镜像与沙盒跑通（2026-11-04）

- 个人版 TCR：命名空间 `botcamp`、仓库 `botcamp/sandbox`，域名 `ccr.ccs.tencentyun.com`
- 镜像：`ccr.ccs.tencentyun.com/botcamp/sandbox:dev`（alpine + nfs-utils + python3，约 60MB）
- 集群内 Secret：`botcamp/tcr-cred`（dockerconfigjson）
- 特权 Pod `sandbox-v1` 实测：
  - 日志 `cfs mounted at /home/user`
  - `GET /healthz` → `{"ok": true}`
  - `GET /files` → `{"files": ["from-pod.txt"]}`（上个 Pod 写的文件，跨 Pod 持久化成立）
  - Pod IP `10.0.4.21`，入口机可直接访问 8765

### 10.7 控制面已跑通（2026-11-04）

代码：`sandbox/control/app.py`（437 行，仅标准库 + K8s REST API）。
部署：入口机 systemd `botcamp-sandbox.service`，监听 `127.0.0.1:8791`，环境变量在 `/etc/botcamp-sandbox.env`（600）。

| 接口 | 行为 |
|---|---|
| `POST /leases` | 建 Pod（privileged + CFS 挂载 + TCR 拉镜像），等到 Running 才返回 |
| `GET /leases/{id}` | 查租约 |
| `POST /leases/{id}/extend` | 续期 |
| `DELETE /leases/{id}` | 删除 Pod（grace 30s，触发容器内 umount） |
| `* /u/<uid>/…` | 反代到 Pod 的 8765，同时续期 |
| `GET /healthz` | 当前活跃租约数 |

实测：

- **建租约 32.3 秒**（含调度、拉镜像、挂 CFS、readiness 通过）
- `GET /u/u_test/healthz` → `{"ok": true, "host": "sbx-..."}`
- `GET /u/u_test/files` → 看到上一个 Pod 写的 `from-pod.txt`
- 同一用户再次 `POST /leases` 返回原租约（`created: false`），不重复建 Pod
- `DELETE` 后 Pod 在 grace 期结束时消失

### 10.8 入口机 nginx 已接上（2026-11-04）

```
公网 → (待开放 80/443) → nginx 127.0.0.1:8080
                          /sandbox/ → 127.0.0.1:8791（注入 Bearer token）
                                       → Pod IP:8765
```

- 配置文件 `/etc/nginx/conf.d/botcamp-sandbox.conf`（600，token 注入其中）
- `proxy_buffering off`，`read_timeout 3600s`（为 SSE 准备）
- 实测：`POST /sandbox/leases` **40.3 秒**返回 201；`GET /sandbox/u/u_edge/healthz` 返回 Pod 主机名；`DELETE` 正常
- 从本地 Mac 经 SSH 隧道访问 `:8080` 验证通过（80/443 尚未对外开放）

已知问题：冷启动方差大。有一次 Pod 在 `Starting pod` 之后卡了 **2.5 分钟**才进入拉镜像阶段，导致 150s 超时。已改：`SANDBOX_POD_TIMEOUT` 默认 300s，且等待失败时自动删除 Pod（不留孤儿）。

### 10.9 版本坑

- `CreateEKSCluster`（旧 Serverless 接口）已废弃：能建出集群但 **API 端点永远为空**，不要用。
- 正确姿势：`CreateCluster`（MANAGED_CLUSTER + VPC-CNI）+ `CreateClusterEndpoint`（内网）+ `CreateClusterVirtualNodePool`。
- VPC-CNI 下不能传 `ClusterCIDR`（会报错），ServiceCIDR 掩码必须在 /17–/27。
- 控制台新建集群时版本可选范围比 `DescribeVersions` 更宽，1.36.2 可用。


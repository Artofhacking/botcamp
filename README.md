# BotCamp

一个账号，连自己的电脑：桌面客户端跑 Bot 团队（能操作电脑），手机和网页通过中转连到同一支团队。

> 本分支废弃了旧的 Tauri 客户端与 Node 网关（保留在原 `main` 历史里）。
> 新架构只保留三件东西：**网关**、**中继**、**客户端**。

## 结构

| 目录 | 作用 |
|---|---|
| `server/` | BotCamp 网关（Python 标准库 + SQLite）：账号、登录、设备注册、计量、路由校验 |
| `relay/macos/` | macOS 中继：启动本机 DSH host，注册设备，建反向隧道 |
| `mobile/` | 手机端（Next.js）：登录 + 设备列表 + 进入会话 |
| `deploy/` | systemd、nginx 片段、发布与回滚脚本 |
| `docs/` | 架构与运维说明 |

## 工作方式

```
手机 / 网页 ──HTTPS──> camp.aigc.sx.cn (nginx)
                        │  /desk/dN/   ← 每台设备一个隧道入口
                        │  /botcamp/   ← 网关：登录、设备、计量
                        ▼
                  反向隧道 127.0.0.1:1876N
                        │
                  你的电脑（DSH host + ds-bot 团队）
```

- **一个 Bot 团队只有一个“家”**（某台电脑）。所有端都是它的客户端，不复制、不分叉。
- 没有设备 = 没有入口：账号没在客户端登录过，设备列表为空，任何 `/desk/dN/` 都会被拒。
- 设备凭证由服务端签发（登录换），共享密钥已删除。

## 网关接口（摘要）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/botcamp/api/login` | 账号登录，返回 API token |
| POST | `/botcamp/api/devices/register` | Bearer 用户 token + 设备信息 → 设备凭证 |
| POST | `/botcamp/api/devices/heartbeat` | Bearer 设备凭证 + host token → 心跳 |
| POST | `/botcamp/api/relay/login` | 网页登录（cookie） |
| GET | `/botcamp/api/relay/devices` | 当前账号的设备列表 |
| POST | `/botcamp/api/relay/go` | 选择设备 → 返回 `/desk/dN/?token=…` |
| GET | `/desk/dN/…` | 经 nginx 鉴权 + 隧道到达本机 host |

## 部署

```bash
# 网关
/opt/botcamp/deploy.sh <app.py> <version>     # 语法检查 → 切版本 → 健康检查 → 失败回滚

# 客户端更新（macOS）
/opt/botcamp/publish-update.sh <version> <产物目录>
```

详见 `docs/architecture.md`。

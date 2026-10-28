# BotCamp Agent

一个跨平台进程，把这个电脑保持在设备列表里，并让手机/网页能连进来。

```bash
node agent/botcamp-agent.mjs login     # 一次：邮箱 + 密码，换取本机设备凭证
node agent/botcamp-agent.mjs up        # 常驻：启动 host + 心跳 + 反向隧道
node agent/botcamp-agent.mjs status    # 查看本机注册信息
node agent/botcamp-agent.mjs logout    # 清除凭证
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `BOTCAMP_GATEWAY` | `https://camp.aigc.sx.cn` | 网关地址 |
| `BOTCAMP_SSH_HOST` | `root@server.aigc.sx.cn` | 隧道落点 |
| `BOTCAMP_SSH_KEY` | 空 | SSH 私钥路径（留空用默认 key） |
| `BOTCAMP_HOST_PORT` | `8765` | 本机 host 端口 |
| `BOTCAMP_REMOTE_PORT_BASE` | `18765` | 槽位 1 对应的服务器端口 |

## 平台说明

- macOS / Linux：直接用系统 `ssh`
- Windows：用系统自带 OpenSSH（`设置 → 应用 → 可选功能 → OpenSSH 客户端`）
- 凭证存 `~/.botcamp/agent.json`（0600），只含设备 secret，不含密码

## 与 relay.sh 的关系

`relay/macos/relay.sh` 是旧的一体化脚本（bash + launchd）。Agent 是它的跨平台替代：

| 能力 | relay.sh | agent |
|---|---|---|
| 注册设备 | 共享密钥 | **登录换设备凭证** |
| 心跳 | 每次重连 | 每轮循环 |
| 隧道 | ssh -R | ssh -R |
| Windows | ❌ | ✅ |

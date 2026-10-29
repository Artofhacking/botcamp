# 本机运行时配置

这些文件不参与构建，只是让「一台新机器怎么配起来」可复现。真实密钥不在这里。

| 文件 | 落到哪里 |
|---|---|
| `profile.web.cordis.patch.yml` | `~/.botcamp/profiles/web/cordis.patch.yml` —— 把 host 的模型指向 BotCamp 网关 |
| `site.demox.botcamp.agent.plist` | `~/Library/LaunchAgents/` —— macOS 开机自启 agent |
| `env.example` | 复制成 `~/.botcamp/relay.env`，填地址与密钥 |
| `agent.json`（由 `botcamp-agent pair` 生成） | 设备凭证，**不要提交** |

# BotCamp Library

BotCamp 的文档库插件，派生自
[`@s1lencewill/dsh-markdown-reader`](https://github.com/s1lencewill/dsh-markdown-reader)
（BSD-3-Clause，见 `LICENSE` / `NOTICE`）。

它只做三件事：

1. 扫描一个固定的库根目录，列出 Markdown 终稿（标题、摘要、封面、标签）。
2. 用一个 Notion 式的只读阅读页打开它（Markdown、图片、视频、代码、表格）。
3. 把库根、列表、文档和媒体通过宿主路由提供给桌面/手机客户端。

## 与上游的差异

| 项 | 上游 reader | BotCamp Library |
|---|---|---|
| 读取范围 | 任意已注册工作区 | 固定的 BotCamp 库根 |
| 入口 | 路径输入 + 最近文件 | 文库首页（封面/搜索/最近） |
| 版式 | 文档阅读器（左侧大纲、宽版心） | Notion 式居中页（封面/图标/标题/708px） |
| 媒体 | 图片 | 图片 + 视频（range） |
| 版本 | 外部文件变更提示 | 保持只读；不做版本管理 |
| 品牌 | dsh-markdown-reader | BotCamp |

## 库根

默认 `~/BotCamp/library/`，可用环境变量 `BOTCAMP_LIBRARY_ROOT` 覆盖。
库内约定：

```
library/
  docs/<slug>/index.md      # 终稿，一文一文件夹
  docs/<slug>/assets/       # 该篇自带图片/视频
  media/                    # 可复用的原始素材
```

文档 frontmatter（可选）：

```yaml
---
title: 一条口播视频的完整生产包
icon: 🎬
cover: assets/cover.jpg
description: 从选题到终稿的完整示例
tags: [口播, SOP]
updated: 2026-10-29
---
```

没有 frontmatter 时，标题取第一个 H1，封面取同目录的 `cover.*`。

## 开发与预览

```bash
cd desktop/plugins/botcamp-library
node --test test/*.test.mjs
PORT=4173 node preview/server.mjs   # http://127.0.0.1:4173/
```

`preview/` 是一个不依赖 DSH 的宿主，复用真实的 host 路由和 client bundle，
样例库在 `preview/library/`；`preview/shots/` 是 1440/390 宽度下的截图。

## 安装到 BotCamp 桌面端

**随构建（推荐）**：`desktop/apply.mjs` 会把本目录复制到
`dsh-desktop-next/plugins/botcamp-library`，以
`"@botcamp/dsh-library": "file:plugins/botcamp-library"` 加进依赖，并修改
`src/profiles.ts`：

- `WEB_BUNDLES` 追加 `ds-bot` 和 `@botcamp/dsh-library`，新 profile 默认带上；
- 已有 profile 在 `ensure()` 时补上缺失的这两个 bundle。

这样不是“把包放进 payload”就完了，而是真正把它放进 `dsh.profile.bundles`，
Host 才会加载插件的 `cordis.patch.yml`。我用 upstream checkout 跑过
`apply.mjs`，并用 esbuild 检查过改后的 `profiles.ts`。

**本地试用**：

```bash
cd desktop/plugins/botcamp-library
npm pack
# 产物 botcamp-dsh-library-0.1.0.tgz
```

在 BotCamp 桌面端打开 **Plugins → Add plugin**，粘贴 tarball 的本地路径或
`http://127.0.0.1:<port>/botcamp-dsh-library-0.1.0.tgz`，重启客户端。desktop
profile 由 Electron 管理，`dsh plugin --profile desktop` 会被拒绝。

## 手机端

插件在宿主上额外提供 `/library/` 独立页面（`standalone/`），和桌面浮层共用
同一个 `lib/client.cjs`、同一套 CSS 和同一套 `/md-reader/*` 路由。手机打开：

```text
https://camp.aigc.sx.cn/desk/dN/library/
```

客户端会从 `location.pathname` 识别 `/desk/dN` 前缀，所有路由自动带上，
经 nginx 重写回宿主的 `/md-reader/*`。`mobile/app/page.jsx` 里已经加了
「文档库」入口，用 iframe 指向这个 URL；如果宿主设了 frame 策略，改成
`window.open` 或 WebView 即可。

## 验证

- `node --test test/host.test.mjs test/client.test.mjs`：12 个用例通过。
- 真实 DSH `0.2.1-rc.4`：在临时 `DSH_HOME` 里 `dsh plugin --profile web add <tgz>`，
  再 `dsh web` 启动；浮层按钮出现，`/md-reader/list`、`/read`、`/raw` 全 200，
  `clip.mp4` 返回 206 并能播放，`/library/` 在 390 宽度正常，无 console error。
- `desktop/apply.mjs` 在 `anywhere-labs/dsh-desktop` 的 fresh checkout 上跑过：
  复制插件、加 `file:` 依赖、把 `ds-bot` / `@botcamp/dsh-library` 写进
  `WEB_BUNDLES` 并给已有 profile 补齐；改后的 `profiles.ts` 用 esbuild 解析通过。
- 完整 `yarn workspace dsh-desktop-next dist:mac-smoke` 跑通：产出
  `BotCamp.app` 和 `BotCamp-2.0.21-next-universal.dmg`；sealed payload 的
  descriptor 里有 `@botcamp/dsh-library`，编译后的 `WEB_BUNDLES` 也包含它；
  packaged Host 以 `profile desktop` 启动并通过。
- `mobile` 的 `next build` 通过。
- 未跑：Developer ID 签名/公证；真机手机走 nginx。`apply.mjs` 顺带修了
  `verify-fuses.ts` / `verify-mac-release.ts` 里写死的 `DSH NEXT` 产品名，
  否则 smoke 构建会在最后一步误报。

## 已知边界

- 只读：没有写路由、没有版本管理；留档靠复制文档。
- 视频按 range 流式播放；不做转码、不做缩略图队列。若手机拖动进度条卡顿，
  在 nginx 的 `/desk/dN/` location 加 `proxy_buffering off;`（range 请求不要被缓冲）。
- 库根可以指向任何目录，但必须是宿主可读的本地路径。
- 上游 BSD-3-Clause 的 `LICENSE` / `NOTICE` 必须随包保留。

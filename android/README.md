# BotCamp Android 壳

把控制台（`https://botcamp.demox.site/console/`）原样装进 WebView 的极简应用：
只有登录和聊天，**不含**产品下载页和管理后台。

## 产物

```
dist/BotCamp-2.1.0.apk        # 已签名，可直接安装
android/build/manual/         # 构建中间产物
```

下载地址：<https://botcamp.aigc.sx.cn/downloads/BotCamp-2.1.0.apk>
（Demox 不托管 .apk，由 CVM 的 nginx `/downloads/` 目录发文件；新增版本时把 apk 放进 `/var/www/downloads/`）

- 包名 `site.demox.botcamp`，versionCode `2050`，versionName `2.1.0`，minSdk 26（Android 8）
- 签名密钥 `android/botcamp-android.keystore`（密码在 `keystore.properties`）
- **同一个包名 + 同一个密钥**才能覆盖安装；换密钥必须先卸载旧版

## 构建

不需要 Gradle / AGP，只用 Android SDK 的 build-tools：

```bash
cd android && ./build-apk.sh
```

脚本做的事：`aapt2 compile/link` → `javac`（对 `android.jar`）→ `d8` → `zip` 打包 dex →
`zipalign` → `apksigner`（v2/v3 签名）。产物落在 `android/build/manual/BotCamp-<version>.apk`。

> 细节：JDK 17 只允许 `-source 8` 时用 `-bootclasspath android.jar`，所以源码里不用 lambda
> （lambda 需要 JDK 的 `LambdaMetafactory`，android.jar 里没有）；版本号写在 `build-apk.sh`
> 顶部，Gradle 的 `app/build.gradle.kts` 也同步维护（装了 Gradle 也能 `assembleRelease`）。

## 行为

| 项 | 说明 |
|---|---|
| 入口 | 固定 `https://botcamp.demox.site/console/`，登录后进入聊天 |
| 站内跳转 | 只认 `/console` 前缀；其它链接（含产品页 `/`、`/admin/`）交给系统浏览器 |
| 深层链接 | Demox 没有 SPA 回退，`/console/app/<id>` 会拿到产品页；应用用 `shouldInterceptRequest` 把它换回 `index.html`，前端路由照常工作 |
| 登录态 | token 存在 WebView 的 localStorage，重启应用仍保持登录 |
| 附件 | `onShowFileChooser` 接系统文件选择器 |
| 下载 | `DownloadListener` 交给系统 DownloadManager，存到「下载」目录 |
| 语音 | 麦克风权限按需申请（仅语音对话用） |
| 返回键 | 先回退网页历史，退到底再退出应用 |
| 断网 | 主文档加载失败显示「连接不上 BotCamp + 重试」 |

页面是远端托管的，**网页更新不需要重装 APK**；只有改动壳本身才要重新打包。

## 更新流程

1. 改 `MainActivity.java` 后调高 `build-apk.sh` 和 `app/build.gradle.kts` 里的 versionCode/versionName
2. `./build-apk.sh`
3. 拷贝 `build/manual/BotCamp-<version>.apk` 给用户覆盖安装

## 已知限制

- 需要联网（页面在服务器上，模型也在服务器侧）
- 老设备 WebView 过旧（Chromium < 87）可能打不开新版前端
- 页面按移动宽度自适应，深层页面刷新依赖上面的 SPA 回退

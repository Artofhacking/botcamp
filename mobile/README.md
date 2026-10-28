# BotCamp Mobile (Next.js)

手机端的登录与设备入口。目标：PWA 先行，后续用 WebView 壳出原生包。

- 数据来源：BotCamp 网关（`https://camp.aigc.sx.cn`）
- 登录：跳转网关的 `/botcamp/relay`，登录态是 `botcamp_relay` cookie
- 设备列表：`GET /botcamp/api/relay/devices`
- 连接：`POST /botcamp/api/relay/go { dev: "d1" }` → 跳转 `/desk/d1/?token=…`

```bash
npm --prefix mobile install
npm --prefix mobile run dev
```

生产构建 `npm --prefix mobile run build` 输出 `mobile/out/`，可放到任意静态托管。

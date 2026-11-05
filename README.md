# BotCamp

BotCamp is a self-hosted AI agent workspace. Bots keep their own conversations, memory, routines,
and computers; the product runs as a web console, an Electron desktop app, and an Android shell.

## Layout

- `apps/web` — the console UI
- `apps/desktop` — the Electron shell for macOS and Windows
- `apps/api` and `apps/worker` — the server and background jobs
- `android/` — the Android WebView shell
- `web/site` — the public download page
- `packages/` — shared contracts, core logic, UI, tokens, and adapters
- `infra/` — Compose files, sandbox images, and the updater

## Development

Requires Node 22.22 or newer and pnpm 9.15.

```sh
pnpm install
pnpm db:generate
pnpm dev
```

## Desktop

The macOS build targets Apple silicon:

```sh
pnpm --filter @rakazo/web build
pnpm --filter @rakazo/desktop build
CSC_IDENTITY_AUTO_DISCOVERY=false \
  pnpm --filter @rakazo/desktop exec electron-builder --mac --arm64 --publish never -c.mac.identity=-
```

The installer lands in `apps/desktop/out/`.

## Android

The shell is built without Gradle:

```sh
cd android
./build-apk.sh
```

## License

Apache-2.0. BotCamp is based on Rakazo; the original copyright notices remain in
[`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).

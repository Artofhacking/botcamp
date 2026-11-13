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

Node and pnpm versions are `package.json` `engines` and `packageManager`. `.npmrc` rejects anything older.

```sh
pnpm install
pnpm db:generate
pnpm dev
```

`docs/handbook.md` is the map for the next change: layout, tests, deployment configuration, and which directories are legacy. `docs/ci.md` is how a change ships. `AGENTS.md` is the rule set. A release tag may point only at a commit already on `main`. Production runs that one commit. It does not follow the moving tip of `main`, and it does not run a commit that `main` does not contain. The console is published from that same commit. Self-hosting is [docs/self-host.md](./docs/self-host.md).

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

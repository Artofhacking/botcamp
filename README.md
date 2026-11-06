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

`docs/handbook.md` is the map for the next change: layout, tests, deployment configuration, and which directories are legacy. `docs/ci.md` is how a change ships. `AGENTS.md` is the rule set. Self-hosting is [docs/self-host.md](./docs/self-host.md).

## Releases

`node scripts/ship-plan.mjs` reads the current diff and prints each place that diff has to reach, with the command. Pass paths to ask about those files instead. A merge to `main` only moves the image registry, and only after the server checks pass.

| Place | What it serves |
|---|---|
| Demox, [botcamp.demox.site](https://botcamp.demox.site) | `/` download page, `/console/` console, `/admin/` operator page |
| CVM, [botcamp.aigc.sx.cn](https://botcamp.aigc.sx.cn) | API, worker, computer supervisor, `/downloads/` |
| `ghcr.io/<owner>/<repo>/{app,computer,updater}` | Images. `edge` moves on a green `main`. The CVM does not run `app`. |
| Update feed, `publish` in `apps/desktop/package.json` | In-app desktop updates |

The download button, the file in `/downloads/`, and the update feed are three writes. The console and the Android shell load `/console/` from Demox, so a console publish reaches them on the next load. `config.js` and `computer-screen/WuyingWebSDK.js` stay on Demox across a console overlay. A full site zip replaces every object.

## Desktop

The macOS build targets Apple silicon:

```sh
pnpm --filter @botcamp/web build
pnpm --filter @botcamp/desktop build
CSC_IDENTITY_AUTO_DISCOVERY=false \
  pnpm --filter @botcamp/desktop exec electron-builder --mac --arm64 --publish never -c.mac.identity=-
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

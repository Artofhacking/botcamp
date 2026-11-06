# Handbook

Read this before changing the product, CI, or a deployment. `AGENTS.md` is the rule set. This file is the map. If it disagrees with another doc about where code lives or how a change ships, update both in the same change.

The repository is public. Do not add secrets, private URLs, host inventory, account ids, or production data. Name a GitHub secret when a workflow reads it. Never write its value. If a task needs a credential that is not named below, stop and ask. Do not reconstruct one from chat, a server, or an old note.

## What ships

BotCamp is one product: a web console, an Electron desktop app, and an Android WebView shell. Shared behavior lives in `packages/`. The server is `apps/api` and `apps/worker`. Bot computers are sandbox images under `infra/sandboxes/`, not a process inside the API.

Product behavior for readers of the app is under `docs/` (`computer.md`, `run-execution.md`, `self-host.md`, and the pages those link). Contributor facts are here, in `docs/architecture.md`, `docs/ci.md`, and `docs/legacy.md`.

## Where to change things

| Path | Owns |
|---|---|
| `apps/web` | Console UI. Static `config.js` is deployment configuration; see below. |
| `apps/desktop` | Electron shell: native navigation, storage, permissions, and the host computer. It loads the web UI. |
| `apps/api` | HTTP API, auth, and starting runs in the request process. |
| `apps/worker` | Recovery, scheduled work, and runs handed over by a shutting-down API. |
| `android/` | WebView shell. The page it loads is remote, so a web deploy does not need a new APK. |
| `packages/contracts` | Shared types and RPC contracts. |
| `packages/core` | Product logic that is not a vendor or a UI. |
| `packages/db` | Prisma schema and migrations. |
| `packages/adapters` | Vendor and platform translation. Provider names stay in this package and in composition roots. |
| `packages/ui-web`, `packages/ui-tokens` | Shared UI and semantic colors. |
| `infra/compose` | Self-host Compose, image install, and `deploy-main.sh`. |
| `infra/sandboxes` | Computer image and the supervisor that runs it. |
| `web/site`, `web/admin` | Marketing page and the operator page. They are not the console. |
| `docs/legacy.md` | Trees that are not this product. Do not add features there. |

## Local setup

`package.json` `engines` and `"packageManager"` are the versions that work. `.npmrc` sets `engine-strict=true`, so an older Node fails `pnpm install`.

```sh
pnpm install
pnpm db:generate
pnpm dev
```

`scripts/dev.mjs` starts the API, worker, web app, and sandbox supervisor. It uses `DATABASE_URL` from `.env` when that server accepts a connection. Otherwise it starts the `rakazo-dev-postgres` container and reuses it. Copy `.env.example` to `.env` before Compose or whenever you need real secrets. Compose is `pnpm compose:up` (`infra/compose/docker-compose.yml`). Self-host details are `docs/self-host.md`.

`pnpm dev` prints the web origin. The desktop app against that stack is `pnpm --filter @rakazo/desktop dev`.

## Tests

| Command | What it runs | Needs |
|---|---|---|
| `pnpm test` | Unit tests. Offline. | Nothing beyond the install. |
| `pnpm check` | Typecheck. | `pnpm db:generate` first. |
| `pnpm lint` | Biome. | Nothing beyond the install. |
| `pnpm test:integration` | Postgres journeys. The harness starts Postgres. | Docker. |
| `pnpm --filter @rakazo/web exec playwright test` | Web end-to-end tests. | CI is the usual place. |
| `pnpm --filter @rakazo/desktop test:e2e` | Electron windows. | Do not run this on a maintainer machine. It steals focus. CI runs it. |

Judge-style checks that call a model are opt-in. Do not turn them on to make a unit test pass.

## Deployment configuration

A static host can serve the web app from one origin and the API from another.

- `apps/web/public/config.js` sets `window.__RAKAZO_API_ORIGIN__` and `window.__RAKAZO_ADMIN_API__`. Empty means the page's own origin. `window.__RAKAZO_UI__` hides sections and can list integration apps. The comments in that file are the contract.
- A published `config.js` is filled in on the host. A fresh build ships the empty file. Do not overwrite a host's `config.js` with the copy from `public/`.
- `RAKAZO_WEB_BASE` is the URL path the console is served from, with a trailing slash. Unset, `apps/web/vite.config.ts` uses `/`. Set it when the console is not the site root. Do not guess a path; read it from the host that already serves the console.
- Liveness is `GET /health` on the API (`apps/api/src/health.ts`). It returns `{"ok":true}`. `/rpc/health` is not that route.
- The API listens on the host and port in its environment (`apps/api/src/index.ts`). The dev default is in `scripts/dev.mjs`.
- Build the API with `pnpm --filter @rakazo/api build` and start `node --enable-source-maps` on `apps/api/dist/index.js`. The worker is the same pattern on `@rakazo/worker`. Apply migrations with `pnpm --filter @rakazo/api db:migrate` (source) or `db:deploy` (the built CLI) before restarting. The previous release keeps running through that migration. The drop and rename rule is in `AGENTS.md`.
- The default computer image tag is `edge` (`infra/compose/docker-compose.images.yml`, `KUBERNETES_SANDBOX_COMPUTER_IMAGE`, `INCUS_SANDBOX_COMPUTER_IMAGE`). CI moves `edge` only after the server checks pass (`docs/ci.md`).

The computer screen page loads `WuyingWebSDK.js` next to `packages/adapters/src/wuying-screen/screen.html`. Generate a missing SDK with `node scripts/wuying-web-sdk.mjs`. Do not delete a host's existing copy as part of an unrelated publish.

## Shipping

`docs/ci.md` is the workflow map and the list of secret names. Automatic production deploy is off until the repository variable `PRODUCTION_DEPLOY_ENABLED` is `true`, and it only targets a host installed as `docs/self-host-production.md` describes. This repo does not list hosts. Do not add a second deploy path in a feature change. If a host does not match that installer, say so and change `docs/ci.md` in the same PR.

Desktop installers are the `desktop-unsigned` workflow, not a side effect of merging. Android packages are `android/build-apk.sh`. The version that script writes is `VERSION_NAME` and `VERSION_CODE` at the top of that file. `android/app/build.gradle.kts` is the optional Gradle path and can lag; bump both when you cut a shell release. Keystores and `keystore.properties` are gitignored.

Feature pull requests do not edit `CHANGELOG.md`. Cutting a version is `.agents/skills/release/SKILL.md`. After opening a PR, stay with it as `.agents/skills/pr-watch/SKILL.md` describes.

## Pull requests

Use `.github/PULL_REQUEST_TEMPLATE.md`. The heading order and the public-writing rules are in `AGENTS.md`. One feature or fix per PR. Do not paste command output, metrics, hostnames, or account details into the description.

# CI

`ci.yml` is the pull-request and main pipeline. The other workflow files are listed below. A new workflow is named in this file in the same change. `.github/scripts/ci-docs.test.py` fails the build when one is missing.

## Pull requests

`changed-areas.sh` decides which jobs a pull request can affect. A docs-only change still builds the web app. It does not run the Postgres journeys or the web end-to-end tests. CI, the lockfile, and files outside the package graph run the full typecheck and unit suite.

| Job | Required for a server deploy | What it covers |
|---|---|---|
| Lint and typecheck | Yes, through the **Checks** aggregate | Biome on pull requests, translation catalogs, typecheck, and the small safety scripts under `.github/scripts` and `infra/compose`. |
| Unit tests | Yes, through **Checks** | `pnpm test`, three shards. |
| Checks | Yes | Passes only when lint, typecheck, and every unit shard passed. |
| Postgres journeys | Yes | `pnpm test:integration`. Skipped inside the job when the diff cannot affect the server. |
| Web E2E | No | Playwright. The check still reports when the diff cannot affect it. |
| Production builds | No | `pnpm build` and a headless Electron smoke, when the diff can affect the web app. |
| Native computer | No | Desktop computer tests on macOS and Windows, when those files change. |
| Postgres upgrade | No | Compose upgrade drill, when Compose files change. |
| Publish server images | Called on its own for image-definition diffs | Pull requests build with a read-only token. They do not push. |

Fork pull requests can fail the Vercel "Authorization required to deploy" check. That failure is expected.

Review bots are not the **Checks** job. Qodo reviews every pull request. CodeRabbit and Greptile run only after `review-bot.yml` moves the fallback label. Passing tests do not finish a review. `.agents/skills/pr-watch/SKILL.md` is how to wait for them.

## Main

A push to `main` runs the same server checks. Two extra jobs exist:

1. **Publish server images** runs only after **Checks** and **Postgres journeys** succeed. It pushes `ghcr.io/<owner>/<repo>/computer` tagged `sha-<commit>` and `edge`. `edge` is the default computer image, so a red main does not move it. Release tags publish semver tags from `publish-server-image.yml` directly. The `app` and `updater` images are not published.
2. **Deploy** runs only when all of these are true: the push is to `main`, **Checks**, **Postgres journeys**, and **Publish server images** succeeded, and the repository variable `PRODUCTION_DEPLOY_ENABLED` is `true`. Otherwise the job is skipped. Merging does not by itself update a host.

The deploy job uses the GitHub environment `production`. It joins a tailnet with OIDC, then SSH runs `deploy-main <sha>`. The host setup, the forced command, and the rollback are [Deploying from CI](./self-host-production.md#deploying-from-ci). That host is a Compose install. The public pages go to Demox. The API host is a source checkout; its rule is [Releases](#releases). The README lists those places.

Secret and variable names the workflow reads. Values are set in GitHub, not in git.

| Name | Kind |
|---|---|
| `PRODUCTION_DEPLOY_ENABLED` | Repository variable. The string `true` arms the deploy. |
| `TAILSCALE_CLIENT_ID` | Repository variable. OIDC client id. |
| `TAILSCALE_AUDIENCE` | Repository variable. |
| `PRODUCTION_SSH_HOST` | Environment secret. |
| `PRODUCTION_SSH_USER` | Environment secret. |
| `PRODUCTION_SSH_PRIVATE_KEY` | Environment secret. The matching `authorized_keys` entry is forced to `rakazo-deploy-main`. |
| `PRODUCTION_SSH_KNOWN_HOSTS` | Environment secret. |

Image builds use `DEPOT_PROJECT_ID` when that repository variable is set, and GitHub runners otherwise. Pull requests never use Depot.

## Other workflows

| File | When it runs |
|---|---|
| `ci.yml` | Pull requests and pushes to `main`. |
| `publish-server-image.yml` | Called by `ci.yml` on green main. Also tag pushes `v*`, manual runs, and pull requests that change image definitions. |
| `playwright.yml` | Called by `ci.yml` and by the nightly run. Also manual. |
| `publish-playwright-report.yml` | After the `ci` workflow completes. Publishes the report. |
| `nightly-verification.yml` | Nightly, and manual. Refreshes the web screenshot baseline. |
| `desktop-unsigned.yml` | Manual. macOS arm64 (ad-hoc signed) and unsigned Windows. Inputs can override the desktop version, limit the platform, and upload the update feed. Artifacts also stay on the workflow run. The download page is a separate edit. |
| `desktop-macos-screenshot.yml` | Pull requests and `main` when desktop setup files change. |
| `build-win.yml` | Manual. Checks out this repo beside the upstream desktop tree named in the workflow. Current installers are `desktop-unsigned.yml`. |
| `computer-replay.yml` | Pull requests that change the computer image or its supervisor, and manual runs. |
| `topology-verification.yml` | Manual production-topology smoke. |
| `review-bot.yml` | Comment on a pull request, to hand a blocked review to the next bot. It does not check out the pull request. |
| `weekly-dependencies.yml` | Weekly, and manual. Opens a dependency pull request. |
| `model-catalog-bump.yml` | Weekly, and manual. Opens a model-catalog pull request. |

## Releases

Every agent working in this repository follows this section. `AGENTS.md` is the rule. `node scripts/ship-plan.mjs` prints which places the current diff has to reach. A merge to `main` does not update the API host.

A release tag is `vX.Y.Z`, and it may point only at a commit already on `main`. Production runs that one commit. It does not follow the moving tip of `main`, and it does not run a commit that `main` does not contain. The API checkout, the console, the homepage, and the operator page of that release are published from that same commit. Cut the tag with `.agents/skills/release/SKILL.md` on the merge commit of the release pull request, then push that tag. Do not move a tag that already exists.

The API host runs only that tag:

1. `infra/compose/release-tag.sh deploy <checkout> vX.Y.Z`. The tag must already exist on the GitHub remote, and its commit must be on `main`. The script refuses the tag before it replaces the checkout. A branch, a commit, and a file copied onto the host are refused. Leave `.env`, `node_modules`, `data`, and `apps/web/public/config.js` in place.
2. Build the API and the worker, then apply migrations.
3. `infra/compose/release-tag.sh seal <checkout>`.
4. Restart the API, the worker, and the supervisor only after `infra/compose/release-tag.sh require <checkout>` passes. Install that command as `ExecStartPre`. They start only when the checkout still matches the tag and the build still matches the seal.

Do not edit the checkout. Do not extract an archive over it, and do not copy a single file onto it. A computer that is already running keeps the image it started with. `edge` moves only after Checks and Postgres journeys on `main`.

The console, the homepage, and the operator page are separate publishes of that same commit. A full site zip replaces every object. Desktop and Android are below, and they are not a side effect of the tag.

## Desktop and Android

Desktop and Android are not published by `ci.yml`.

- Desktop: run `desktop-unsigned.yml`. The feed URL is the `publish` provider in `apps/desktop/package.json`. The `publish` input runs `scripts/publish-desktop.py`, which uploads the installer, its blockmap, and `latest.yml` or `latest-mac.yml`, and reads `COS_SECRET_ID` and `COS_SECRET_KEY`. It leaves `web/site` alone. The download page reads `/downloads/latest.json` for the button version and file. Update that catalog when the new installer is the one the page should offer. Do not treat a previously uploaded installer as the git version. `apps/desktop/package.json` `version` changes in the release pull request (`.agents/skills/release/SKILL.md`).
- Android: `android/build-apk.sh`. The version is the pair at the top of that script. Keep `android/app/build.gradle.kts` on the same pair when cutting a shell. The signing keystore is not in git.

## What not to add

Do not add a deploy script that embeds a host, a bucket, a site id, or a credential. Do not enable `PRODUCTION_DEPLOY_ENABLED` in the repository file; it is a GitHub variable so a fork cannot turn on this repo's production. Do not add a third way onto the API host. The Compose install uses `deploy-main`, and the source checkout uses `release-tag.sh`.

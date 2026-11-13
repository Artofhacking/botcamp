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

1. **Publish server images** runs only after **Checks** and **Postgres journeys** succeed. It pushes `ghcr.io/<owner>/<repo>/{app,updater,computer}` tagged `sha-<commit>` and `edge`. `edge` is the default computer image, so a red main does not move it. Release tags publish semver tags from `publish-server-image.yml` directly.
2. **Deploy** runs only when all of these are true: the push is to `main`, **Checks**, **Postgres journeys**, and **Publish server images** succeeded, and the repository variable `PRODUCTION_DEPLOY_ENABLED` is `true`. Otherwise the job is skipped. Merging does not by itself update a host.

A release tag is `vX.Y.Z`, and it may point only at a commit already on `main`. Production runs that one commit. It does not follow the moving tip of `main`, and it does not run a commit that `main` does not contain. The release skill refuses to tag any other commit. `deploy-main` refuses a commit that is not on `main` before it changes the host. The console is published from that same commit. A local tree, a branch, and a merge are not a finished product change. The finish rule is in `AGENTS.md`.

The deploy job uses the GitHub environment `production`. It joins a tailnet with OIDC, then SSH runs `deploy-main <sha>`. The host setup, the forced command, and the rollback are [Deploying from CI](./self-host-production.md#deploying-from-ci).

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
| `desktop-unsigned.yml` | Manual. macOS arm64 (ad-hoc signed) and unsigned Windows. An input can override `apps/desktop/package.json` `version`. Artifacts stay on the workflow run until someone publishes them. The `publish` input works only on `main`. |
| `desktop-macos-screenshot.yml` | Pull requests and `main` when desktop setup files change. |
| `build-win.yml` | Manual. Checks out this repo beside the upstream desktop tree named in the workflow. Current installers are `desktop-unsigned.yml`. |
| `computer-replay.yml` | Pull requests that change the computer image or its supervisor, and manual runs. |
| `topology-verification.yml` | Manual production-topology smoke. |
| `review-bot.yml` | Comment on a pull request, to hand a blocked review to the next bot. It does not check out the pull request. |
| `weekly-dependencies.yml` | Weekly, and manual. Opens a dependency pull request. |
| `model-catalog-bump.yml` | Weekly, and manual. Opens a model-catalog pull request. |

## Desktop and Android

Desktop and Android are not published by `ci.yml`.

- Desktop: run `desktop-unsigned.yml` from `main`. With `publish` checked, a run on any other branch fails before it builds, so the update feed always matches `main`. The generic update feed URL is the `publish` provider in `apps/desktop/package.json`. Do not treat a previously uploaded installer as the git version. `apps/desktop/package.json` `version` changes in the release pull request (`.agents/skills/release/SKILL.md`).
- Android: `android/build-apk.sh`. The version is the pair at the top of that script. Keep `android/app/build.gradle.kts` on the same pair when cutting a shell. The signing keystore is not in git.

## What not to add

Do not add a deploy script that embeds a host, a bucket, a site id, or a credential. Do not enable `PRODUCTION_DEPLOY_ENABLED` in the repository file; it is a GitHub variable so a fork cannot turn on this repo's production. A host that is not the `deploy-main` install is undocumented on purpose. Bring it onto that install, or describe the new mechanism in this file without secrets.

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

The deploy job uses the GitHub environment `production`. It joins a tailnet with OIDC, then SSH runs `deploy-main <sha>`. The host setup, the forced command, and the rollback are [Deploying from CI](./self-host-production.md#deploying-from-ci). That host is a Compose install. The public pages go to Demox. The API host is a source checkout; its rule is [Releases](#releases). The README lists those places.

A job that is skipped is not a deploy. Without `PRODUCTION_DEPLOY_ENABLED` the job never starts, and without `TAILSCALE_CLIENT_ID` and `TAILSCALE_AUDIENCE` it stops at its first step, so a green merge and a pushed tag change nothing on a host. Read the settings rather than the history:

```sh
gh variable list
gh api repos/{owner}/{repo}/environments/production/secrets --jq '.secrets[].name'
```

Neither command needs a value to be written down. An empty answer means no host is updated by CI, and the host and the console have to be updated by hand on a machine that can reach them.

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
| `desktop-unsigned.yml` | Manual. macOS arm64 (ad-hoc signed) and unsigned Windows. Inputs can override the desktop version, limit the platform, and upload the update feed. The `publish` input works only on `main`. Artifacts also stay on the workflow run. The download page is a separate edit. |
| `desktop-macos-screenshot.yml` | Pull requests and `main` when desktop setup files change. |
| `build-win.yml` | Manual. Checks out this repo beside the upstream desktop tree named in the workflow. Current installers are `desktop-unsigned.yml`. |
| `computer-replay.yml` | Pull requests that change the computer image or its supervisor, and manual runs. |
| `topology-verification.yml` | Manual production-topology smoke. |
| `review-bot.yml` | Comment on a pull request, to hand a blocked review to the next bot. It does not check out the pull request. |
| `weekly-dependencies.yml` | Weekly, and manual. Opens a dependency pull request. |
| `model-catalog-bump.yml` | Weekly, and manual. Opens a model-catalog pull request. |

## Releases

Every agent working in this repository follows this section. `AGENTS.md` is the rule. `node scripts/ship-plan.mjs` prints which places the current diff has to reach. A merge to `main` does not update the API host.

A release tag is `vX.Y.Z`. Cut it with `.agents/skills/release/SKILL.md` on the merge commit of the release pull request, then push that tag. Do not move a tag that already exists.

The API host runs that one tag and nothing else. It is a source checkout kept at `/opt/botcamp/src`; `/opt/rakazo` is a symlink to it that must stay, because running computers still mount that path. The command this repository ships as `infra/compose/release-tag.sh` is installed on the host as `/usr/local/sbin/botcamp-release-tag`.

Log in as `root`. The host refuses public keys and accepts only a password, and it does not read a command from standard input, so put the command in the argument to `ssh`. The credential is never in this repository: the operator keeps it in the `server-mgmt` skill's inventory, which is outside git, as `BOTCAMP_HOST`, `BOTCAMP_USER`, and `BOTCAMP_PASSWORD`. Read it from there; do not copy it into a file the repository tracks.

```sh
# Pass the password in the environment, not on the command line, so it stays out of `ps`.
SSHPASS="$BOTCAMP_PASSWORD" sshpass -e ssh -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no -o NumberOfPasswordPrompts=1 \
  "$BOTCAMP_USER@$BOTCAMP_HOST" '<command>'
```

Then run these steps in order:

```sh
# 1. Deploy the tag. It must already exist on the GitHub remote: a branch, a commit, and
#    a file copied into the checkout are refused. The host cannot reach github.com, so this
#    one command gets a mirror; the checkout's own remote is left alone.
export PATH="/root/.npm/_npx/3d41f72c9dd7981b/node_modules/.bin:$PATH"   # a non-login shell has no pnpm;
# re-read the directory with: ls -d /root/.npm/_npx/*/node_modules/.bin
export BOTCAMP_REMOTE="https://gh-proxy.com/https://github.com/<owner>/<repo>.git"
export GIT_HTTP_VERSION=HTTP/1.1
/usr/local/sbin/botcamp-release-tag deploy /opt/botcamp/src vX.Y.Z

# 2. Build the server, then apply migrations.
cd /opt/botcamp/src
pnpm install --frozen-lockfile
pnpm --filter @botcamp/api build
pnpm --filter @botcamp/worker build
pnpm --filter @botcamp/api db:migrate

# 3. Freeze the source and the built output.
/usr/local/sbin/botcamp-release-tag seal /opt/botcamp/src

# 4. Restart only when the checkout still matches the tag and the build still matches the seal.
/usr/local/sbin/botcamp-release-tag require /opt/botcamp/src
systemctl restart botcamp-api botcamp-worker

# 5. The API binds its port before it answers; a first request can be refused.
curl -fsS http://127.0.0.1:3100/health   # {"ok":true}
```

A deploy leaves `.env`, `node_modules`, `data`, and `apps/web/public/config.js` in place. Do not edit the checkout by hand, do not extract an archive over it, and do not copy a single file onto it: `seal` makes a later change fail, and the units refuse to start when `require` does not pass. The supervisor, the web unit, and the computer image keep running unless the release changes them, and a computer that is already started keeps the image it started with.

`GET /health` on the public hostname is a `404` from nginx and `/rpc/health` answers `405`. Neither says whether the API is up; the loopback route above does.

The console is a separate publish on the host that serves `botcamp.demox.site`, and an API release does not update it. A publish replaces every object of that site, so put the new console build on top of what is already there and keep the live `console/config.js` (the API origin and the hidden settings) and `console/computer-screen/WuyingWebSDK.js`: both are filled in on that host, and a fresh build ships them empty. No workflow in this tree performs that publish. Desktop and Android are below, and they are not a side effect of the tag.

## Desktop and Android

Desktop and Android are not published by `ci.yml`.

- Desktop: run `desktop-unsigned.yml` from `main`. With `publish` checked, a run on any other branch fails before it builds, so the update feed always matches `main`. The generic update feed URL is the `publish` provider in `apps/desktop/package.json`. The `publish` input runs `scripts/publish-desktop.py`, which uploads the installer, its blockmap, and `latest.yml` or `latest-mac.yml`, and reads `COS_SECRET_ID` and `COS_SECRET_KEY`. It leaves `web/site` alone. The download page reads `/downloads/latest.json` for the button version and file. Update that catalog when the new installer is the one the page should offer. Do not treat a previously uploaded installer as the git version. `apps/desktop/package.json` `version` changes in the release pull request (`.agents/skills/release/SKILL.md`).
- Android: `android/build-apk.sh`. The version is the pair at the top of that script. Keep `android/app/build.gradle.kts` on the same pair when cutting a shell. The signing keystore is not in git.

## What not to add

Do not add a deploy script that embeds a host, a bucket, a site id, or a credential. Do not enable `PRODUCTION_DEPLOY_ENABLED` in the repository file; it is a GitHub variable so a fork cannot turn on this repo's production. Do not add a third way onto the API host. The Compose install uses `deploy-main`, and the source checkout uses `release-tag.sh`.

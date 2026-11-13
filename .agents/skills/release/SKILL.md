---
name: release
description: Prepare a BotCamp release - draft the CHANGELOG section from the pull requests merged since the last tag, bump the desktop version, open the release PR, and tag its merge commit on main. Production runs that one commit. The API host may run only that tag, as docs/ci.md requires. Use when asked to cut, prepare, or ship a release or a new version.
---

# Release

Feature pull requests never touch `CHANGELOG.md`; the release writes it in one pass.

## 1. Gather

```sh
git fetch origin --tags
last="$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' origin/main)"
git log --format='%s' "$last"..origin/main | grep -oE '\(#[0-9]+\)$' | tr -d '(#)'
```

Read each pull request's title and `## What`/`## Why`/`## Risk` (`gh pr view N --json title,body,labels`). With many PRs, fan the reading out to parallel subagents, each returning candidate entries for its slice.

## 2. Draft the section

Pick the version: patch for fixes, minor when users get new capability or self-hosters must act. Replace `## [Unreleased]` content (fold in anything already there) with `## [X.Y.Z] - YYYY-MM-DD` above the previous release, and leave an empty `## [Unreleased]` on top.

- Order: `### Security`, `### Added`, `### Changed`, `### Removed`, `### Fixed`, then `### Self-host upgrade notes` for anything an operator must do (new required settings, commands to rerun, behavior that changes by default).
- Include what a user or self-hoster would notice. Drop refactors, tests, CI, internal tooling, docs-only and marketing-site changes, and fixes to bugs that never shipped in a release.
- One entry per change, merging PRs that are steps of one feature. Say what changed for the reader in plain words, link the relevant doc, and name settings exactly.
- Every security fix gets an entry. Public repo rules apply: no metrics, private hosts, or account details.

## 3. Release PR

Bump `apps/desktop/package.json` to the new version in the same branch and open the PR titled `Release vX.Y.Z`. The maintainer reviews the changelog wording there. Right before it merges, rerun the gather against current `main` and add entries for anything merged since, because the tag covers everything up to the release PR's merge commit.

## 4. Tag

After the PR merges, tag its merge commit and push the tag. Refuse unless that commit is already on `main`:

```sh
sha="$(gh pr view <release PR> --json mergeCommit -q .mergeCommit.oid)"
git fetch origin main
git merge-base --is-ancestor "$sha" origin/main || {
  echo "Refusing the tag. A release tag must point at a commit on main." >&2
  exit 1
}
git tag vX.Y.Z "$sha" && git push origin vX.Y.Z
```

The tag records that one commit. It may point only at a commit already on `main`. Pushing it does not update a host. Production runs that commit. It does not follow the moving tip of `main`, and it does not run a commit that `main` does not contain. `deploy-main` refuses such a commit before it changes the host. The console is published from that same commit.

## 5. Where the tag runs

Every agent working in this repository follows `docs/ci.md`. The API host runs this tag and no other revision. It is a source checkout at `/opt/botcamp/src`, and `/opt/rakazo` stays a symlink to it because running computers still mount that path. The command this repository ships as `infra/compose/release-tag.sh` is installed there as `/usr/local/sbin/botcamp-release-tag`.

Log in as `root`: the host refuses public keys and asks for the password, and it does not read a command from standard input, so pass it as the argument to `ssh`. It cannot reach GitHub either, so the deploy command gets `BOTCAMP_REMOTE` (a mirror of this repository) and `GIT_HTTP_VERSION=HTTP/1.1` in its environment. That does not change the checkout's own remote.

In order: `deploy`, `pnpm install --frozen-lockfile`, build the API and the worker, `pnpm --filter @botcamp/api db:migrate`, `seal`, `require`, and only then `systemctl restart botcamp-api botcamp-worker`. Readiness is `GET http://127.0.0.1:3100/health` answering `{"ok":true}`; the public `404` and `405` are not readiness. Leave `.env`, `node_modules`, `data`, and `apps/web/public/config.js` alone, and restart the supervisor, the web unit, or the computer image only when the release changes them.

Do not copy files onto that host. Do not check out `main` or a commit there. The console and the other pages are a separate publish on the host that serves `botcamp.demox.site`, and it must keep the live `console/config.js` and `console/computer-screen/WuyingWebSDK.js`. Desktop installers stay the `desktop-unsigned` workflow. `node scripts/ship-plan.mjs` names the other places this tag still has to reach.

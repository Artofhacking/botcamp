#!/usr/bin/env bash
# release-tag.sh against a local git remote. No network and no chattr.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
script="$root/release-tag.sh"

export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export BOTCAMP_REMOTE="$scratch/origin"
export BOTCAMP_RELEASE_PIN="$scratch/pin"
export BOTCAMP_RELEASE_MANIFEST="$scratch/source.sha256"
export BOTCAMP_RELEASE_DIST_MANIFEST="$scratch/dist.sha256"
export BOTCAMP_RELEASE_LOCK=0

origin="$scratch/origin"
git init -q "$origin"
mkdir -p "$origin/apps/api/src" "$origin/apps/web/public"
printf 'export const marker = "tag-a"\n' >"$origin/apps/api/src/index.ts"
printf 'from-tag\n' >"$origin/.env.example"
printf 'from-tag-config\n' >"$origin/apps/web/public/config.js"
git -C "$origin" -c commit.gpgsign=false add .
git -C "$origin" -c commit.gpgsign=false commit -q -m a
git -C "$origin" branch -M main
git -C "$origin" tag v1.2.3
printf 'export const marker = "branch"\n' >"$origin/apps/api/src/index.ts"
git -C "$origin" -c commit.gpgsign=false add .
git -C "$origin" -c commit.gpgsign=false commit -q -m b
git -C "$origin" tag -a v1.2.4 -m v1.2.4
git -C "$origin" checkout -q -b side
printf 'export const marker = "side"\n' >"$origin/apps/api/src/index.ts"
git -C "$origin" -c commit.gpgsign=false add .
git -C "$origin" -c commit.gpgsign=false commit -q -m side
git -C "$origin" tag v1.2.5
git -C "$origin" checkout -q main

checkout="$scratch/checkout"
mkdir -p "$checkout/apps/api/src" "$checkout/apps/web/public" "$checkout/data/homes" "$checkout/node_modules" "$checkout/apps/api/dist"
printf 'keep-env\n' >"$checkout/.env"
printf 'keep-config\n' >"$checkout/apps/web/public/config.js"
printf 'keep-home\n' >"$checkout/data/homes/note"
printf 'keep-mod\n' >"$checkout/node_modules/pkg"
printf 'stray\n' >"$checkout/apps/api/src/stray.ts"
printf 'old-dist\n' >"$checkout/apps/api/dist/index.js"

if "$script" deploy "$checkout" main >"$scratch/out" 2>"$scratch/err"; then fail "a branch was accepted"; fi
grep -q 'Only a vX.Y.Z tag' "$scratch/err" || fail "branch refusal did not name the rule"
[[ "$(cat "$checkout/apps/api/src/stray.ts")" == stray ]] || fail "an invalid tag changed the checkout"

if "$script" deploy "$checkout" v9.9.9 >"$scratch/out" 2>"$scratch/err"; then fail "a missing tag was accepted"; fi
grep -q 'Could not fetch tag v9.9.9' "$scratch/err" || fail "missing tag was not reported"
[[ "$(cat "$checkout/apps/api/src/stray.ts")" == stray ]] || fail "a missing tag changed the checkout"

"$script" deploy "$checkout" v1.2.3 >"$scratch/out"
grep -q 'tag-a' "$checkout/apps/api/src/index.ts" || fail "checkout is not the tag"
[[ ! -f "$checkout/apps/api/src/stray.ts" ]] || fail "a copied file survived the checkout"
[[ "$(cat "$checkout/.env")" == "keep-env" ]] || fail ".env was replaced"
[[ "$(cat "$checkout/apps/web/public/config.js")" == "keep-config" ]] || fail "config.js was replaced"
[[ "$(cat "$checkout/data/homes/note")" == "keep-home" ]] || fail "data was replaced"
[[ "$(cat "$checkout/node_modules/pkg")" == "keep-mod" ]] || fail "node_modules was replaced"
[[ "$(cat "$checkout/.env.example")" == "from-tag" ]] || fail "a tracked file was not updated"
grep -q '^tag v1.2.3$' "$scratch/pin" || fail "the pin is not the tag"

if "$script" require "$checkout" >"$scratch/out" 2>"$scratch/err"; then fail "an unsealed build was accepted"; fi

mkdir -p "$checkout/apps/worker/dist"
printf 'api-build\n' >"$checkout/apps/api/dist/index.js"
printf 'worker-build\n' >"$checkout/apps/worker/dist/index.js"
"$script" seal "$checkout" >"$scratch/out"
"$script" require "$checkout" >"$scratch/out"
grep -q 'release v1.2.3' "$scratch/out" || fail "require did not name the tag"

printf 'export const marker = "edited"\n' >"$checkout/apps/api/src/index.ts"
if "$script" require "$checkout" >"$scratch/out" 2>"$scratch/err"; then fail "edited source was accepted"; fi
grep -q 'Source does not match' "$scratch/err" || fail "source edit was not reported"

printf 'export const marker = "tag-a"\n' >"$checkout/apps/api/src/index.ts"
printf 'api-hacked\n' >"$checkout/apps/api/dist/index.js"
if "$script" require "$checkout" >"$scratch/out" 2>"$scratch/err"; then fail "an edited build was accepted"; fi
grep -q 'Build does not match' "$scratch/err" || fail "build edit was not reported"

"$script" deploy "$checkout" v1.2.4 >"$scratch/out"
grep -q 'branch' "$checkout/apps/api/src/index.ts" || fail "annotated tag was not checked out"
[[ "$(cat "$checkout/.env")" == "keep-env" ]] || fail ".env was replaced by the second tag"
if "$script" require "$checkout" >"$scratch/out" 2>"$scratch/err"; then fail "the old seal was kept"; fi

if "$script" deploy "$checkout" v1.2.5 >"$scratch/out" 2>"$scratch/err"; then fail "a tag off main was accepted"; fi
grep -q 'A release tag must point at a commit on main' "$scratch/err" || fail "off-main tag refusal did not name the rule"
grep -q 'branch' "$checkout/apps/api/src/index.ts" || fail "a tag off main changed the checkout"
[[ "$(cat "$checkout/.env")" == "keep-env" ]] || fail "a tag off main replaced .env"

sha="$(git -C "$origin" rev-parse HEAD)"
if "$script" deploy "$checkout" "$sha" >"$scratch/out" 2>"$scratch/err"; then fail "a commit was accepted"; fi
grep -q 'Only a vX.Y.Z tag' "$scratch/err" || fail "commit refusal did not name the rule"

echo "release-tag smoke ok"

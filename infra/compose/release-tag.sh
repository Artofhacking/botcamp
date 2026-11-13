#!/usr/bin/env bash
# The API host may run only a vX.Y.Z tag fetched from GitHub.
# A branch, a commit, and a file copied onto the checkout are refused.
# .env, node_modules, data, and apps/web/public/config.js stay on the host.
set -euo pipefail

remote="${BOTCAMP_REMOTE:-https://github.com/artofhacking/botcamp.git}"
pin_file="${BOTCAMP_RELEASE_PIN:-/etc/botcamp/release-tag}"
source_manifest="${BOTCAMP_RELEASE_MANIFEST:-/var/lib/botcamp/release.sha256}"
dist_manifest="${BOTCAMP_RELEASE_DIST_MANIFEST:-/var/lib/botcamp/release-dist.sha256}"

usage() {
  echo "Usage: release-tag.sh deploy <checkout> <vX.Y.Z>" >&2
  echo "       release-tag.sh seal|require|lock|unlock <checkout>" >&2
  exit 2
}

die() { echo "$1" >&2; exit 1; }

checkout_of() {
  local path="${1:-${BOTCAMP_CHECKOUT:-}}"
  [[ "$path" == /* && "$path" != / && -d "$path" ]] || die "Checkout must be an existing absolute directory."
  printf '%s\n' "$path"
}

tag_of() {
  [[ "${1:-}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Refusing ${1:-<empty>}. Only a vX.Y.Z tag can be checked out."
  printf '%s\n' "$1"
}

# Host state stays writable. data is a live volume, so the walk prunes it.
kept() {
  local rel="${1#./}"
  case "$rel" in
    .env | .env.local | .env.bak* | .env.*.local | apps/web/public/config.js) return 0 ;;
    node_modules/* | */node_modules/* | data/* | .turbo/* | .git/* | *.log) return 0 ;;
  esac
  return 1
}

tracked() {
  # Host files and build output are not the tag. Everything else must match it.
  kept "$1" && return 1
  local rel="${1#./}"
  case "$rel" in
    apps/web/dist/* | apps/api/dist/* | apps/worker/dist/* | infra/sandboxes/supervisor/dist/*) return 1 ;;
    packages/db/src/generated/*) return 1 ;;
  esac
  return 0
}

frozen() {
  kept "$1" && return 1
  return 0
}

built() {
  local rel="${1#./}"
  case "$rel" in
    apps/api/dist/* | apps/worker/dist/*) return 0 ;;
  esac
  return 1
}

hash_one() {
  local file="$1" rel="$2" sum
  if command -v sha256sum >/dev/null 2>&1; then
    sum="$(sha256sum "$file" | awk '{print $1}')"
  else
    sum="$(shasum -a 256 "$file" | awk '{print $1}')"
  fi
  printf '%s  %s\n' "$sum" "$rel"
}

list_files() {
  local root="$1" kind="$2" rel
  (
    cd "$root"
    find . -xdev \( -type d \( -name node_modules -o -name data -o -name .turbo -o -name .git \) -prune \) -o -type f -print
  ) | sort | while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    case "$kind" in
      tracked) tracked "$rel" && printf '%s\n' "${rel#./}" ;;
      built) built "$rel" && printf '%s\n' "${rel#./}" ;;
      frozen) frozen "$rel" && printf '%s\n' "${rel#./}" ;;
    esac
  done
}

manifest_of() {
  local root="$1" kind="$2" rel
  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    hash_one "$root/$rel" "$rel"
  done < <(list_files "$root" "$kind")
}

write_file() {
  local dest="$1"
  mkdir -p "$(dirname "$dest")"
  cat >"${dest}.tmp"
  mv "${dest}.tmp" "$dest"
}

read_pin() {
  [[ -f "$pin_file" ]] || die "No release tag is pinned."
  pin_tag="$(awk 'NR==1 {print $2}' "$pin_file")"
  pin_commit="$(awk 'NR==2 {print $2}' "$pin_file")"
  [[ "$pin_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Pinned name is not a release tag."
  [[ "$pin_commit" =~ ^[0-9a-f]{40}$ ]] || die "Pinned commit is not a full SHA."
}

same_manifest() {
  local expected="$1" actual="$2" label="$3"
  [[ -f "$expected" ]] || die "${label} is not sealed."
  if ! diff -q "$expected" "$actual" >/dev/null; then
    echo "${label} does not match the pinned tag." >&2
    diff -u "$expected" "$actual" | head -40 >&2 || true
    exit 1
  fi
}

lock_files() {
  local checkout="$1" kind="$2"
  set_flag +i "$checkout" "$kind"
}

unlock_files() {
  local checkout="$1"
  set_flag -i "$checkout" frozen
  [[ "${BOTCAMP_RELEASE_LOCK:-1}" == 1 ]] || return 0
  command -v chattr >/dev/null 2>&1 || return 0
  [[ -e "$pin_file" ]] && chattr -i "$pin_file" 2>/dev/null || true
  [[ -e "$source_manifest" ]] && chattr -i "$source_manifest" 2>/dev/null || true
  [[ -e "$dist_manifest" ]] && chattr -i "$dist_manifest" 2>/dev/null || true
}

set_flag() {
  local flag="$1" checkout="$2" kind="$3" rel
  local -a batch
  [[ "${BOTCAMP_RELEASE_LOCK:-1}" == 1 ]] || return 0
  command -v chattr >/dev/null 2>&1 || return 0
  flush() {
    [[ ${#batch[@]} -eq 0 ]] && return 0
    chattr "$flag" "${batch[@]}"
    batch=()
  }
  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    batch+=("$checkout/$rel")
    [[ ${#batch[@]} -eq 50 ]] && flush
  done < <(list_files "$checkout" "$kind")
  flush
}

seal_pins() {
  [[ "${BOTCAMP_RELEASE_LOCK:-1}" == 1 ]] || return 0
  command -v chattr >/dev/null 2>&1 || return 0
  chattr +i "$pin_file" "$source_manifest"
  [[ -e "$dist_manifest" ]] && chattr +i "$dist_manifest" || true
}

cmd="${1:-}"
shift || usage

case "$cmd" in
  deploy)
    [[ $# -eq 2 ]] || usage
    checkout="$(checkout_of "$1")"
    tag="$(tag_of "$2")"
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    git init -q "$work/repo"
    git -C "$work/repo" fetch --depth 1 --quiet "$remote" "refs/tags/${tag}:refs/tags/${tag}" \
      || die "Could not fetch tag ${tag}."
    commit="$(git -C "$work/repo" rev-parse "${tag}^{commit}")"
    mkdir -p "$work/tree"
    git -C "$work/repo" archive "$commit" | tar -x -C "$work/tree"
    unlock_files "$checkout"
    rsync -a --delete --no-owner --no-group \
      --exclude '.env' \
      --exclude '.env.local' \
      --exclude '.env.bak*' \
      --exclude '.env.*.local' \
      --exclude 'node_modules/' \
      --exclude 'data/' \
      --exclude '.turbo/' \
      --exclude '.git/' \
      --exclude 'apps/web/dist/' \
      --exclude 'apps/api/dist/' \
      --exclude 'apps/worker/dist/' \
      --exclude 'infra/sandboxes/supervisor/dist/' \
      --exclude 'packages/db/src/generated/' \
      --exclude 'apps/web/public/config.js' \
      --exclude '*.log' \
      "$work/tree/" "$checkout/"
    manifest_of "$work/tree" tracked | write_file "$source_manifest"
    printf 'tag %s\ncommit %s\n' "$tag" "$commit" | write_file "$pin_file"
    rm -f "$dist_manifest"
    # Source is frozen here. Dist and generated stay writable until the build is sealed.
    lock_files "$checkout" tracked
    seal_pins
    printf 'checked out %s %s\n' "$tag" "$commit"
    ;;
  seal)
    [[ $# -eq 1 ]] || usage
    checkout="$(checkout_of "$1")"
    read_pin
    actual="$(mktemp)"
    trap 'rm -f "$actual"' EXIT
    manifest_of "$checkout" tracked >"$actual"
    same_manifest "$source_manifest" "$actual" "Source"
    [[ -f "$checkout/apps/api/dist/index.js" && -f "$checkout/apps/worker/dist/index.js" ]] \
      || die "Build the API and the worker before sealing."
    manifest_of "$checkout" built | write_file "$dist_manifest"
    lock_files "$checkout" frozen
    seal_pins
    printf 'sealed %s %s\n' "$pin_tag" "$pin_commit"
    ;;
  require)
    [[ $# -eq 1 || $# -eq 0 ]] || usage
    checkout="$(checkout_of "${1:-}")"
    read_pin
    actual="$(mktemp)"
    built_actual="$(mktemp)"
    trap 'rm -f "$actual" "$built_actual"' EXIT
    manifest_of "$checkout" tracked >"$actual"
    same_manifest "$source_manifest" "$actual" "Source"
    manifest_of "$checkout" built >"$built_actual"
    same_manifest "$dist_manifest" "$built_actual" "Build"
    printf 'release %s %s\n' "$pin_tag" "$pin_commit"
    ;;
  lock | unlock)
    [[ $# -eq 1 || $# -eq 0 ]] || usage
    checkout="$(checkout_of "${1:-}")"
    count="$(list_files "$checkout" frozen | wc -l | tr -d ' ')"
    ((count <= 20000)) || die "Refusing to change ${count} files."
    if [[ "$cmd" == lock ]]; then
      lock_files "$checkout" frozen
      printf 'froze %s files\n' "$count"
    else
      unlock_files "$checkout"
      printf 'unlocked %s files\n' "$count"
    fi
    ;;
  *) usage ;;
esac

#!/usr/bin/env bash
# Installs the staged packages for one target into a scratch project, the way a user's npm would,
# and checks that the launcher runs the binary and explains itself when the binary is missing.
#   scripts/smoke-npm.sh dist/npm linux-x64 1.2.3
set -euo pipefail

npm_dir=$(cd "$1" && pwd)
target=$2
version=$3
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

npm pack --silent --pack-destination "$work" "$npm_dir/$target" "$npm_dir/patchbook" >/dev/null
platform_tgz=$(ls "$work"/patchbook-"$target"-*.tgz)
main_tgz=$(ls "$work"/patchbook-cli-[0-9]*.tgz)

install() {
  local dir=$1
  shift
  mkdir "$work/$dir"
  (cd "$work/$dir" && npm init -y >/dev/null && npm install --no-audit --no-fund --loglevel=error "$@")
}

install with-binary "$main_tgz" "$platform_tgz"
reported=$(cd "$work/with-binary" && npx --no-install patchbook --version)
echo "with the platform package: $reported"
grep -qF "$version" <<<"$reported"

install without-binary --omit=optional "$main_tgz"
if message=$(cd "$work/without-binary" && npx --no-install patchbook --version 2>&1); then
  echo "the launcher ran without the platform package" >&2
  exit 1
fi
echo "with --omit=optional:"
echo "$message"
grep -qF "is not installed" <<<"$message"

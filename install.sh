#!/bin/sh
# Installs the patchbook binary for this machine from a GitHub release.
#   curl -fsSL https://raw.githubusercontent.com/willgosnold/patchbook/main/install.sh | sh
#
# PATCHBOOK_VERSION      release tag to install, like v1.2.3. Default: the latest release.
# PATCHBOOK_INSTALL_DIR  where to put the binary. Default: ~/.local/bin.
# PATCHBOOK_BASE_URL     where the release assets are served. Default: the GitHub release.
set -eu

repo=willgosnold/patchbook

say() { printf 'patchbook: %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

is_musl() {
  case "$(ldd --version 2>&1 || true)" in
    *musl*) return 0 ;;
    *[Gg][Ll][Ii][Bb][Cc]*) return 1 ;;
  esac
  for loader in /lib/ld-musl-* /usr/lib/ld-musl-*; do
    [ -e "$loader" ] && return 0
  done
  return 1
}

# Prints the release target id: <os>-<cpu>, plus -musl on musl Linux.
detect_target() {
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) die "this installer supports Linux and macOS, not $(uname -s). On Windows, use 'npm install -g @patchbook/cli' or download the .exe from https://github.com/$repo/releases." ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) cpu=x64 ;;
    arm64 | aarch64) cpu=arm64 ;;
    *) die "there is no prebuilt binary for the $(uname -m) architecture." ;;
  esac
  suffix=
  if [ "$os" = linux ] && is_musl; then
    suffix=-musl
  fi
  # A shell running under Rosetta reports x86_64 on Apple Silicon, and Rosetta can't run Bun's x64 build.
  if [ "$os" = darwin ] && [ "$cpu" = x64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
    cpu=arm64
  fi
  printf '%s-%s%s' "$os" "$cpu" "$suffix"
}

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2" || die "could not download $1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1" || die "could not download $1"
  else
    die "curl or wget is required."
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    die "sha256sum or shasum is required to verify the download."
  fi
}

main() {
  target=$(detect_target)
  asset=patchbook-$target
  dir=${PATCHBOOK_INSTALL_DIR:-$HOME/.local/bin}

  if [ -n "${PATCHBOOK_BASE_URL:-}" ]; then
    base=$PATCHBOOK_BASE_URL
  elif [ -n "${PATCHBOOK_VERSION:-}" ]; then
    base=https://github.com/$repo/releases/download/$PATCHBOOK_VERSION
  else
    base=https://github.com/$repo/releases/latest/download
  fi

  tmp=$(mktemp -d)
  staged=
  trap 'rm -rf "$tmp"; [ -z "$staged" ] || rm -f "$staged"' EXIT
  trap 'exit 1' HUP INT TERM

  say "downloading $asset"
  fetch "$base/$asset" "$tmp/$asset"
  fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS"

  expected=$(awk -v name="$asset" '{ file = $2; sub(/^\*/, "", file); if (file == name) { print $1; exit } }' "$tmp/SHA256SUMS")
  [ -n "$expected" ] || die "SHA256SUMS has no entry for $asset."
  actual=$(sha256_of "$tmp/$asset")
  [ "$actual" = "$expected" ] || die "checksum mismatch for $asset: expected $expected, got $actual. Nothing was installed."

  mkdir -p "$dir"
  # Stage beside the destination so the final mv is a rename, which works while an old copy is running.
  staged=$dir/.patchbook.$$
  cp "$tmp/$asset" "$staged"
  chmod 755 "$staged"
  mv -f "$staged" "$dir/patchbook"
  staged=

  say "installed $dir/patchbook"
  case ":$PATH:" in
    *":$dir:"*) ;;
    *)
      say "$dir is not on your PATH. Add it to your shell profile:"
      printf '%s\n' "  export PATH=\"$dir:\$PATH\"" >&2
      ;;
  esac
}

main "$@"

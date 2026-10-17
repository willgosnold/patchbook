#!/usr/bin/env bash
# Run two patchbook implementations on copies of wstack and diff what they write and print.
#
#   scripts/compare-wstack.sh [wstack-dir]
#
# PATCHBOOK_REF  the reference command (default: the Python patchbook at REF_COMMIT)
# PATCHBOOK_NEW  the command under test (default: bun src/cli.ts)
# SYNC_REF       also sync each copy to this upstream commit and compare again
# NEW_HOOKS      ts (default) gives the copy under test hooks.ts; py keeps hooks.py
#
# The reference copy keeps wstack's hooks.py. The other gets scripts/wstack-hooks.ts instead.
# Exits 0 when nothing differs.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
wstack=$(cd "${1:-$HOME/.t3/projects/wstack}" && pwd)
REF_COMMIT=${REF_COMMIT:-9f5a86e}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [ -z "${PATCHBOOK_REF:-}" ]; then
  git -C "$here" show "$REF_COMMIT:patchbook.py" > "$work/patchbook.py"
  PATCHBOOK_REF="python3 $work/patchbook.py"
fi
PATCHBOOK_NEW=${PATCHBOOK_NEW:-bun $here/src/cli.ts}

export PYTHONDONTWRITEBYTECODE=1 XDG_CONFIG_HOME="$work/config" PATCHBOOK_HOOK=0 PATCHBOOK_SKILL=0
unset PATCHBOOK_PROVIDER PATCHBOOK_MODEL PATCHBOOK_EFFORT

run() {  # run <side> <name> <args...>: keep stdout, stderr and the exit code under results/<side>
  local side=$1 name=$2 cmd
  shift 2
  [ "$side" = ref ] && cmd=$PATCHBOOK_REF || cmd=$PATCHBOOK_NEW
  local out="$work/results/$side/$name"
  mkdir -p "$(dirname "$out")"
  (cd "$work/$side" && set +e; $cmd "$@" > "$out.stdout" 2> "$out.stderr"; echo $? > "$out.code")
}

snapshot() {  # snapshot <side> <label>: copy the repo's files, minus .git and the hooks file
  mkdir -p "$work/results/$1/$2"
  (cd "$work/$1" && git ls-files -z -co --exclude-standard \
    | grep -zv -e '^\.patchbook/hooks\.\(py\|ts\)$' \
    | xargs -0 cp --parents -P -t "$work/results/$1/$2")
}

for side in ref new; do
  cp -a "$wstack" "$work/$side"
  rm -rf "$work/$side/.patchbook/__pycache__"
done
if [ "${NEW_HOOKS:-ts}" = ts ]; then
  rm "$work/new/.patchbook/hooks.py"
  cp "$here/scripts/wstack-hooks.ts" "$work/new/.patchbook/hooks.ts"
fi

changes=$(grep -v '^\s*\(#\|$\)' "$wstack/.patchbook/series")
upstream=$(cd "$work/ref" && $PATCHBOOK_REF upstream pstack)
md=$(grep '\.md$' <<< "$upstream")

for side in ref new; do
  run "$side" build build --force
  run "$side" status status
  run "$side" status-json status --json
  run "$side" upstream upstream pstack
  run "$side" config config
  for c in $changes; do run "$side" "show/$c" show "$c"; done
  for f in $md; do run "$side" "blocks/$f" blocks "$f"; done
  snapshot "$side" tree
  if [ -n "${SYNC_REF:-}" ]; then
    run "$side" sync sync pstack "$SYNC_REF"
    run "$side" sync-status status --json
    snapshot "$side" synced-tree
  fi
done

if [ "$(cat "$work/results/ref/build.code")" != 0 ]; then
  cat "$work/results/ref/build.stderr" >&2
  echo "the reference build failed, so a comparison would prove nothing" >&2
  exit 2
fi
echo "reference: $(cat "$work/results/ref/build.stdout")"
sed -i "s#$work/ref#WORK#g; s#$work/new#WORK#g" "$work"/results/*/config.stdout
if diff -r "$work/results/ref" "$work/results/new" > "$work/diff.txt"; then
  echo "no differences across $(find "$work/results/ref" -type f | wc -l) files and outputs"
else
  cat "$work/diff.txt"
  echo "differences: $(grep -c '^diff\|^Only in' "$work/diff.txt")" >&2
  exit 1
fi

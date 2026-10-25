outcome() {
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" > "$QA_RESULT"
  exit 0
}

check() {
  local desc=$1; shift
  echo "## check: $desc"
  rec "$@" || outcome fail "" "$desc"
}

known() {
  local issue=$1 desc=$2; shift 2
  echo "## check (#$issue): $desc"
  if ! rec "$@"; then outcome known "#$issue" "$desc"; fi
  # The fake model is deterministic, so a known check that passes there has a stale tag that would hide a regression.
  real || outcome fail "" "$desc passes, so #$issue looks fixed: change its known to check"
}

real() { [ "$QA_MODEL" = real ]; }

expect_no_pending() {
  check "no change is left pending" no_pending
}

no_pending() {
  [ ! -e .patchbook/changes/pending ] || { echo "found changes/pending"; return 1; }
  local code=0
  grep -lxE 'intent:[[:space:]]*' .patchbook/changes/*/CHANGE.md || code=$?
  [ "$code" = 1 ]
}

listed() {
  local e
  for e in "$@"; do
    grep -qxF -- "- $e" .patchbook/changes/*/CHANGE.md || { echo "in no CHANGE.md: - $e"; return 1; }
  done
}

intent_of() {
  local f
  f=$(grep -lxF -- "- $1" .patchbook/changes/*/CHANGE.md | head -n 1)
  [ -n "$f" ] && sed -n 's/^intent: *//p' "$f"
}

status_agrees_with_build() {
  local out status build
  out=$(patchbook status 2>&1) || true
  printf '%s\n' "$out"
  case $out in *" apply at "*) ;; *) echo "status printed no summary"; return 1 ;; esac
  case $out in *"no problems"*) status=clean ;; *) status=problems ;; esac
  if patchbook build; then build=ok; else build=refused; fi
  echo "status: $status, build: $build"
  [ "$status:$build" = clean:ok ] || [ "$status:$build" = problems:refused ]
}

# sed -i differs between GNU and BSD.
sub() { sed -e "$2" "$1" > "$1.qa" && mv "$1.qa" "$1"; }

in_upstream() {
  local name=$1; shift
  (cd "$SB/work/$name" && "$@" && git add -A && git commit -qm "$name: upstream revision")
}

fixture() {
  cd "$SB/work"
  git init -q -b main up
  mkdir -p up/skills/a
  printf -- '---\nname: a\n---\n\nFirst paragraph of a.\n\nSecond paragraph of a.\n\nThird paragraph of a.\n' > up/skills/a/SKILL.md
  git -C up add -A && git -C up commit -qm up
  git init -q -b main extra
  mkdir -p extra/skills/x
  printf -- '---\nname: x\n---\n\nThe x skill.\n' > extra/skills/x/SKILL.md
  git -C extra add -A && git -C extra commit -qm extra
  git init -q -b main fork
  cd fork
  check "init starts a folder-layout patchbook" patchbook init --upstream "file://$SB/work/up" --output-from skills --output-to skills
  check "track follows a second upstream" patchbook track extra "file://$SB/work/extra" --mount extra
  check "the first build succeeds" patchbook build
  git add -A && PATCHBOOK_HOOK=0 git commit -qm init
}

SKILLS="s01 s02 s03 s04 s05 s06 s07 s08 s09 s10 s11 s12"

twelve_skills_in_extra() {
  local ex=$1
  in_upstream extra sh -c '
    for s in '"$SKILLS"'; do
      mkdir -p skills/$s && printf -- "---\nname: %s\n---\n\nThe %s skill.\n" $s $s > skills/$s/SKILL.md
    done
    printf "MIT License\n\nCopyright (c) extra\n" > LICENSE'
  check "sync moves extra's pin" patchbook sync
  check "build after sync succeeds" patchbook build
  git add -A
  check "the sync commit succeeds" git commit -qm "sync extra"
  check "upstream --export writes extra's files" patchbook upstream extra --export "$ex"
}

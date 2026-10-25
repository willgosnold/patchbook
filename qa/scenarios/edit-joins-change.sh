old="Ship extra's x skill as upstream wrote it."
intents_are_current() {
  local f i found=
  for f in $(grep -lE '^- [a-z]+ [^ ]*x/SKILL\.md$' .patchbook/changes/*/CHANGE.md); do
    found=1 i=$(sed -n 's/^intent: *//p' "$f")
    echo "$f: $i"
    [ -n "$i" ] && [ "$i" != "$old" ] || return 1
  done
  [ -n "$found" ]
}

patchbook upstream extra --export "$SB/work/ex" >/dev/null
cp -r "$SB/work/ex/skills/x" skills/x
git add -A
check "the ship commit records the copy" env PATCHBOOK_INTENT="$old" git commit -qm "ship x"
sub skills/x/SKILL.md 's/The x skill./The x skill, reworded for our agents./'
git add -A
check "the reword commit records the edit" env PB_FAKE_CHANGE=ship-extra-s-x PB_FAKE_INTENT="Ship extra's x skill, reworded for our agents." git commit -qm "reword x"
expect_no_pending
check "each change that holds the reword has a current intent" intents_are_current
check "status agrees with build" status_agrees_with_build
in_upstream extra sub skills/x/SKILL.md '/^name: x$/a\
description: revised upstream.'
check "sync takes extra's revision" patchbook sync
check "build after sync succeeds" patchbook build
check "skills/x follows upstream" grep -q "revised upstream" skills/x/SKILL.md
check "skills/x keeps the reword" grep -q "reworded for our agents" skills/x/SKILL.md
check "status agrees with build after sync" status_agrees_with_build

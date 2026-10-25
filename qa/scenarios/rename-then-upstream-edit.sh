says_renamed() { intent_of "move skills/a -> skills/a2" | grep -Ei 'renam|move'; }

git mv skills/a skills/a2
sub skills/a2/SKILL.md 's/^name: a$/name: a2/'
git add -A
check "the commit records the rename" git commit -qm "rename a to a2"
cp "$SB/prompt.txt" "$SB/rename-prompt.txt"
expect_no_pending
check "CHANGE.md moves skills/a to skills/a2" listed "move skills/a -> skills/a2"
check "status agrees with build" status_agrees_with_build
in_upstream up sub skills/a/SKILL.md 's/Second paragraph of a./Second paragraph of a, revised upstream./'
check "sync takes up's revision" patchbook sync
check "build after sync succeeds" patchbook build
check "skills/a2 follows upstream" grep -q "revised upstream" skills/a2/SKILL.md
check "skills/a2 keeps its new name" grep -qx "name: a2" skills/a2/SKILL.md
check "status agrees with build after sync" status_agrees_with_build
check "the intent prompt names the old path" grep -Eq '(^|[ /])a/SKILL\.md|skills/a -> skills/a2' "$SB/rename-prompt.txt"
if real; then check "the intent says the skill was renamed" says_renamed; fi

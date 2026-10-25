mkdir -p skills/c
cp skills/a/SKILL.md skills/c/SKILL.md
git add -A
check "the commit records the copy" env PB_FAKE_CHANGE=copy-a-to-c git commit -qm "copy a to c"
check "CHANGE.md copies skills/a to skills/c" listed "copy skills/a -> skills/c"
sub skills/c/SKILL.md 's/Third paragraph of a./Third paragraph, in our words./'
git add -A
check "the commit records the edit" env PB_FAKE_CHANGE=copy-a-to-c git commit -qm "edit c"
expect_no_pending
check "status agrees with build" status_agrees_with_build
in_upstream up sub skills/a/SKILL.md 's/Second paragraph of a./Second paragraph of a, revised upstream./'
check "sync takes up's revision" patchbook sync
check "build after sync succeeds" patchbook build
check "skills/c keeps our edit" grep -q "in our words" skills/c/SKILL.md
check "status agrees with build after sync" status_agrees_with_build
known 317 "skills/c follows upstream" grep -q "revised upstream" skills/c/SKILL.md

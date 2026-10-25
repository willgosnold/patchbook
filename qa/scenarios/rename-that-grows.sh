git mv skills/a skills/a2
sub skills/a2/SKILL.md 's/^name: a$/name: a2/'
for i in 1 2 3 4 5 6 7 8; do printf '\nNew paragraph %s of a2.\n' "$i" >> skills/a2/SKILL.md; done
git add -A
check "the commit records the rename" git commit -qm "rename a to a2 and extend it"
expect_no_pending
check "status agrees with build" status_agrees_with_build
known 317 "CHANGE.md moves skills/a to skills/a2" listed "move skills/a -> skills/a2"
in_upstream up sub skills/a/SKILL.md 's/Second paragraph of a./Second paragraph of a, revised upstream./'
check "sync takes up's revision" patchbook sync
check "build after sync succeeds" patchbook build
check "skills/a2 follows upstream" grep -q "revised upstream" skills/a2/SKILL.md

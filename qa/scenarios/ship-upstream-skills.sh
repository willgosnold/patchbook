counts_copies() { patchbook status | grep -E '(^|[^0-9])12 [a-z ]*edits? apply'; }

twelve_skills_in_extra "$SB/work/ex"
cp -r "$SB"/work/ex/skills/s* skills/
git add -A
check "the commit records the skills" git commit -qm "ship extra's skills"
expect_no_pending
want=(); for s in $SKILLS; do want+=("copy extra/skills/$s -> skills/$s"); done
check "CHANGE.md copies each skill from extra" listed "${want[@]}"
check "status agrees with build" status_agrees_with_build
in_upstream extra sub skills/s05/SKILL.md 's/The s05 skill./The s05 skill, revised upstream./'
check "sync takes extra's revision" patchbook sync
check "build after sync succeeds" patchbook build
check "skills/s05 follows upstream" grep -q "revised upstream" skills/s05/SKILL.md
check "status agrees with build after sync" status_agrees_with_build
check "status counts the twelve copy edits" counts_copies

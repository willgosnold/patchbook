twelve_skills_in_extra "$SB/work/ex"
cp -r "$SB"/work/ex/skills/s* skills/
git add -A
check "the ship commit records the skills" env PATCHBOOK_INTENT="Ship extra's twelve skills." git commit -qm "ship extra's skills"
for s in $SKILLS; do cp "$SB/work/ex/LICENSE" "skills/$s/LICENSE"; done
git add -A
check "the license commit records the copies" git commit -qm "license each skill"
expect_no_pending
want=(); for s in $SKILLS; do want+=("copy extra/LICENSE -> skills/$s/LICENSE"); done
check "CHANGE.md copies extra/LICENSE into each folder" listed "${want[@]}"
check "status agrees with build" status_agrees_with_build
in_upstream extra sub LICENSE 's/Copyright (c) extra/Copyright (c) extra, revised upstream/'
check "sync takes extra's revision" patchbook sync
check "build after sync succeeds" patchbook build
check "skills/s07/LICENSE follows upstream" grep -q "revised upstream" skills/s07/LICENSE
check "status agrees with build after sync" status_agrees_with_build

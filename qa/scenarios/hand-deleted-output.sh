rm skills/a/SKILL.md
known 317 "status agrees with build" status_agrees_with_build
check "record moves the delete into a change" patchbook record --intent "Drop skill a."
check "CHANGE.md deletes skills/a/SKILL.md" listed "delete skills/a/SKILL.md"
check "status agrees with build after record" status_agrees_with_build

notes_the_intent() {
  patchbook status | grep -xF "note      changes/$1: patchbook wrote its intent from the edits. To replace it, run \`patchbook intent $1\` or edit its line to \`intent: <yours>\`"
}

export PB_FAKE_MODEL=fail
if real; then export PATCHBOOK_PROVIDER=none; fi
git mv skills/a skills/a2
sub skills/a2/SKILL.md 's/^name: a$/name: a2/'
git add -A
check "the commit records the rename with no model" git commit -qm "rename a to a2"
expect_no_pending
check "CHANGE.md moves skills/a to skills/a2" listed "move skills/a -> skills/a2"
check "patchbook writes the intent from the edits" \
  grep -xF "intent (by patchbook): Renames skills/a to skills/a2. Edits skills/a/SKILL.md." .patchbook/changes/rename-skills-a-to-skills-a2/CHANGE.md
check "status notes patchbook's intent and how to replace it" notes_the_intent rename-skills-a-to-skills-a2
check "status agrees with build" status_agrees_with_build
unset PB_FAKE_MODEL PATCHBOOK_PROVIDER
check "intent has the model write it once the model answers" patchbook intent rename-skills-a-to-skills-a2
check "the model's intent replaces patchbook's" grep -qx "intent: .*" .patchbook/changes/rename-skills-a-to-skills-a2/CHANGE.md
check "status agrees with build after intent" status_agrees_with_build

names="alpha bravo charlie delta echo foxtrot golf hotel india juliet"
prompt_names_every_path() {
  local n
  for n in $names; do grep -q "^$n/SKILL\.md" "$SB/many-prompt.txt" || { echo "the prompt doesn't list $n/SKILL.md"; return 1; }; done
}

for n in $names; do
  mkdir -p "skills/$n"
  { printf -- '---\nname: %s\n---\n\n' "$n"; for i in $(seq 1 60); do echo "The $n skill, line $i: it handles $n work in its own way, step $i of the $n procedure."; done; } > "skills/$n/SKILL.md"
done
git add -A
check "the commit records the skills" git commit -qm "add ten skills"
cp "$SB/prompt.txt" "$SB/many-prompt.txt"
check "the intent prompt lists every path" prompt_names_every_path
expect_no_pending
check "status agrees with build" status_agrees_with_build

# Build into a folder

A user builds part of an upstream into a folder of their own repo with `patchbook init --output-to`. `patchbook build` writes the output from the pinned upstream plus the recorded changes, and refuses to overwrite hand edits that haven't been recorded. `patchbook upstream` reads the upstream at its pin.

## Sub-features

- `folder-init` starts a patchbook that follows an upstream folder and pins it, without building.
- `folder-build` writes the output folder from the pin and the changes.
- `folder-refuse` refuses to build over unrecorded hand edits and names the files.
- `folder-record-build` records a hand edit, then builds it into the output.
- `folder-force` discards unrecorded hand edits with `build --force`.
- `folder-upstream` lists and prints upstream files at the pin.

## How to get to it (user POV)

- Run `patchbook init --upstream <url> --output-from <folder> --output-to <folder>` in an existing repo.
- Run `patchbook build`, `patchbook build --force` and `patchbook record`.
- Run `patchbook upstream <name>` and `patchbook upstream <name> <path>`.
- Commit an edit to the output folder with `git commit`.

## Driving it with pb-sandbox

Preconditions:

- A fresh sandbox, sourced, with `doctor` all `ok`, in `$SB/work`.
- An upstream: `git init -q -b main lib && mkdir -p lib/skills/a && printf '# A\n\nPara one.\n' > lib/skills/a/SKILL.md && git -C lib add -A && git -C lib commit -qm start`.
- Our repo: `git init -q -b main repo && echo mine > repo/README.md && git -C repo add -A && git -C repo commit -qm start && cd repo`.

- **Init.** Run `rec pb init --upstream "$SB/work/lib" --output-from skills --output-to skills`. Exit 0, `lib: pinned <sha>` and `Next: patchbook build, then commit.`. No `skills/` folder exists yet.
- **Build.** Run `rec pb build`. It prints `built 1 files from lib <sha> with 0 edits`, and `skills/a/SKILL.md` reads `Para one.`. Commit without the hook: `git add -A && PATCHBOOK_HOOK=0 git commit -qm built`.
- **Refuse.** Hand-edit the output and build. Run `printf '# A\n\nPara uno.\n' > skills/a/SKILL.md`, then `rec pb build`. Exit 1, `these output files changed since the last build:` and `a/SKILL.md`. The file still reads `Para uno.`.
- **Record, then build.** Run `rec pb record spanish --intent "Spanish first paragraph."` (prints `file     a/SKILL.md`), then `rec pb build` (`with 1 edits`). `.patchbook/changes/spanish/CHANGE.md` has `- file skills/a/SKILL.md`, and `skills/a/SKILL.md` still reads `Para uno.`.
- **Upstream at the pin.** Run `rec pb upstream lib` (lists `skills/a/SKILL.md`) and `rec pb upstream lib skills/a/SKILL.md` (prints `Para one.`).
- **Hook in the folder layout.** Run `printf '# A\n\nPara two.\n' > skills/a/SKILL.md && git add -A`, then `rec git commit -qm two`. The hook prints `file     a/SKILL.md (in spanish)`, and `rec git show --stat --format=%s HEAD` includes `.patchbook/changes/spanish/ours/skills/a/SKILL.md.pb`.
- **Force.** Hand-edit again and run `rec pb build --force`. Exit 0, and `skills/a/SKILL.md` reads `Para two.` again.
- **Proof.** The transcript has each command, plus the `cat` of the output file after each build.

## Gotchas

- `init` pins but doesn't build. The output folder appears only after `build`.
- `status` reports unrecorded hand edits and deletions as problems and exits 1. After `record` captures them, status exits 0 unless another problem remains.
- The hook and `record` print output paths relative to the output folder (`a/SKILL.md`), while `CHANGE.md` and `upstream <name> <path>` use staged paths (`skills/a/SKILL.md`).
- `[output] to` isn't validated. Setting it to `.` and running `build --force` deletes `.patchbook/` (#11). Never do that outside a sandbox.

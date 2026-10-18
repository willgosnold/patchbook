# Fork and the commit hook

A user forks an upstream repo with `patchbook clone`, edits upstream's files in place, and commits as usual. The pre-commit hook moves the edits into the patchbook as a named change with an intent, rebuilds, and adds both to the same commit.

## Sub-features

- `fork-clone` forks an upstream with its history, pins it, and installs the pre-commit hook.
- `fork-hook-record` records a committed hand edit as a change with a model-written name and intent.
- `fork-hook-commit` puts the edit and its patchbook record in one commit, leaving a clean tree.
- `fork-status` reports every change as applying, with no problems.

## How to get to it (user POV)

- Run `patchbook clone <url> [dir]`.
- Edit a file, `git add` it, and run `git commit`.
- Run `patchbook status`.

## Driving it with pb-sandbox

Preconditions:

- A fresh sandbox, sourced, with `doctor` all `ok`, in `$SB/work`.
- An upstream: `git init -q -b main up && printf 'one\ntwo\n' > up/app.txt && git -C up add -A && git -C up commit -qm start`.

- **Fork.** Clone the upstream. Run `rec pb clone "$SB/work/up" fork`. Exit 0, and the output has `installed a pre-commit hook` and `pinned at <sha>`. `fork/.patchbook/config.toml` and `fork/.patchbook/upstream.lock` exist.
- **Edit and commit.** Change a line and commit only that file. Run `cd fork && printf 'one\nTWO\n' > app.txt && git add app.txt`, then `rec git commit -qm "shout two"`. Exit 0, and the hook prints `model-name: MODEL WROTE THIS.` and `file     app.txt`.
- **Record is in the commit.** Run `rec git show --stat --format=%s HEAD`. The commit `shout two` has `app.txt`, `.patchbook/series`, `.patchbook/build.lock` and `.patchbook/changes/model-name/` (`CHANGE.md`, `base/app.txt.pb`, `ours/app.txt.pb`).
- **The change reads right.** Run `rec cat .patchbook/changes/model-name/CHANGE.md`. It has `intent: MODEL WROTE THIS.` and `- file app.txt`.
- **Nothing left over.** Run `rec git status --short`. No output.
- **Status.** Run `rec pb status`. Exit 0 and `1 edits apply at up <sha>; no problems`.
- **Proof.** The transcript has every step above, and `model-calls.log` (copied at cleanup) has one `claude -p` call.

## Gotchas

- In a fork, every file outside `.patchbook/` is build output, so the hook records unstaged and untracked files too. That's open bug #1, so a stray file in the fork changes this journey's commit.
- The hook runs `patchbook` from `PATH`. Commit only from a shell with `$ENV` sourced, or the hook says `patchbook isn't installed` and records nothing.
- A hook manager that sets `core.hooksPath` (husky, Vite+) stops the hook from running at all (#33). Sandbox repos have none, so this journey can't show that.
- The hook asks the fake model whenever a commit needs a change name. Set `PB_FAKE_CHANGE`/`PB_FAKE_INTENT` on the `git commit` to get another name.

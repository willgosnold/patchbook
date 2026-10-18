# Record a change with its intent

A user moves edits made to the build output into the patchbook with `patchbook record`, naming the change and writing its intent, or leaves either to the model. `patchbook show` prints a change with its file edits as diffs.

## Sub-features

- `record-named` records new edits under a given name with a given intent, without calling the model.
- `record-model` names the change and writes its intent with the model when no name is given.
- `record-env-intent` uses `PATCHBOOK_INTENT` from a hooked `git commit` as the intent.
- `record-owner` folds an edit to a path that a change already owns into that change.
- `record-show` prints a change's intent and each edit, as a diff for `file` edits.

## How to get to it (user POV)

- Run `patchbook record <name> --intent "<intent>"`.
- Run `patchbook record` with no name.
- Commit with `PATCHBOOK_INTENT="<intent>" git commit`.
- Run `patchbook show <change>`.

## Driving it with pb-sandbox

Preconditions:

- A sandbox with the fork from [fork-and-hook.md](./fork-and-hook.md) committed, so `fork` has the change `model-name` owning `app.txt`, and the shell is in `$SB/work/fork`.

- **Named, new file.** Add a file and record it. Run `echo extra > extra.txt`, then `rec pb record add-extra --intent "Ship an extra file."`. Exit 0 and `add      extra.txt`.
- **Named change reads right.** Run `rec cat .patchbook/changes/add-extra/CHANGE.md`. It has `intent: Ship an extra file.` and `- add extra.txt`. `$SB/model-calls.log` has no new line.
- **Show an add.** Run `rec pb show add-extra`. It prints `add-extra: Ship an extra file.` and `add extra.txt (6 bytes)`.
- **Owned path.** Edit `app.txt` again and record it under a new name. Run `printf 'ONE\nTWO\n' > app.txt`, then `rec pb record shout-one --intent "Shout the first line."`. It prints `file     app.txt (in model-name)`, and `.patchbook/changes/shout-one/` doesn't exist.
- **Show a file edit.** Run `rec pb show model-name`. It prints `model-name: MODEL WROTE THIS.` and a diff from `upstream/app.txt` to `ours/app.txt` with `-one`/`-two` and `+ONE`/`+TWO`.
- **Model names it.** Add another file and record without a name. Run `echo more > more.txt` and `rec env PB_FAKE_CHANGE=add-more PB_FAKE_INTENT="Ship more." patchbook record`. A change `add-more` with `intent: Ship more.` exists, and `model-calls.log` has a new call.
- **Intent from the commit.** Commit what's recorded so far with `git add -A && PATCHBOOK_HOOK=0 git commit -qm recorded`. Then add a file and commit it with an intent, giving the fake model a fresh name: run `echo fourth > fourth.txt && git add -A`, then `rec env PATCHBOOK_INTENT="Mine." PB_FAKE_CHANGE=add-fourth git commit -qm fourth`. Expected: `.patchbook/changes/add-fourth/CHANGE.md` has `intent: Mine.`. Today it has `intent: MODEL WROTE THIS.` (#4).
- **Proof.** The transcript has each step and its `cat`. Check `model-calls.log` for which steps called the model.

## Gotchas

- `record-env-intent` and an unnamed `record --intent` currently fail: the model is still called and its intent replaces the given one, so `CHANGE.md` says `intent: MODEL WROTE THIS.` (#4). Report the journey as failing on #4 until it's fixed. Don't pass it by adding a name.
- When the model's name matches an existing change, the edit joins that change, and a `PATCHBOOK_INTENT` replaces that change's intent. The fake model always answers `model-name` unless `PB_FAKE_CHANGE` is set, so set it on every `record` or commit after the first, or the steps pile into `model-name`.
- One owner per path. Recording an edit to a path another change owns adds it to that change and ignores the new name, so an owned path can't test `record-named`.
- `record` prints `no hand edits to the output since the last build; nothing to record` and exits 0 when there's nothing to record. Exit 0 alone doesn't prove anything was recorded.
- `record` doesn't commit. Commit with `PATCHBOOK_HOOK=0 git commit` to keep the hook from recording a second time.

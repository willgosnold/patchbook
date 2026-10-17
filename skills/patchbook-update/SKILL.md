---
name: patchbook-update
description: Pull upstream into a repo that keeps its changes in a patchbook (.patchbook/), repair what broke from each change's intent, test, review, merge and deploy, and ask the user only when it can't decide. Use when a scheduled task or the user says to update a patchbook repo, or for /patchbook-update or $patchbook-update.
---

# Patchbook update

This repo keeps its changes to an upstream repo in `.patchbook/`. Read `.patchbook/config.toml` and the guide it names (`guide`) before you change anything. `patchbook --help` lists the commands. The `patchbook` repo's `DESIGN.md` explains the model.

Never edit the vendored copy or the build output by hand. Change the patchbook, then build.

## 1. Check

Run `uv tool upgrade patchbook` (ignore a failure if it wasn't installed with uv), then `patchbook check`.

- Exit 0: upstream hasn't moved. If a scheduled task started this thread, archive it with `t3_thread_organize` (`archive`) and stop. Otherwise say so and stop.
- Exit 10: continue.
- Anything else: report the error and stop, leaving the thread for the user.

## 2. Sync on a branch

1. The checkout must be on the main branch, clean, and up to date with `origin` (`git pull --ff-only`). If it isn't, stop and ask.
2. Create a branch, `patchbook/upstream-<short sha>`.
3. Run `patchbook sync` and commit everything it changed as "Sync upstream to <short sha>".
4. Read `.patchbook/last-sync.json` (what upstream changed and what merged on its own) and `patchbook status --json` (what broke).

## 3. Repair

Fix each problem from the change's intent and the guide. Keep upstream's new behaviour wherever the intent allows.

| Problem | What to do |
| --- | --- |
| conflict | Resolve the conflict markers in the change's `ours` copy so its intent holds on upstream's new text. |
| gone | Upstream moved or deleted the file. If it moved (`maybe` in the sync report), point the edit at the new path: copy the new upstream file to `base`, redo `ours` from the intent, and update `CHANGE.md`. If it was deleted and the intent no longer applies, retire the change. |
| orphan, missing, leak, check, placeholder | As the guide says. |
| `replaced_upstream_changed` | Upstream changed a file this repo replaces outright. Read upstream's change and carry over what the intent doesn't exclude. |

Also read the upstream changes in the sync report for new files or features the guide says to handle, even where no check fired.

To retire a change, remove it from `series` and its folder, and add it to `retired.md` with the reason.

Commit each change you repair on its own, as "Carry <change> to upstream <short sha>".

## 4. Build and test

Run `patchbook build` and commit the output. Then run the config's `[test]`: a `command` must exit 0, and an `instructions` file is a procedure to follow. Fix a failure if you can, with at most two attempts.

## 5. Review

Start a reviewer with `delegate_task`, on this thread's model and effort (omit `target`). Its brief holds:

- the guide's path;
- each repaired or retired change, with its intent;
- the upstream changes from the sync report;
- `git diff main...HEAD -- .patchbook`;
- the test results.

Ask it, per change: does the result meet the intent on upstream's new text, does it change anything beyond the intent, and did upstream add anything that should have been handled. It answers pass or fail, with reasons. On a fail, fix what it found and start a new review round, with the earlier findings in the brief. Stop after two rounds.

## 6. Merge, or ask

Ask the user instead of merging when:

- upstream removed or reworked something an intent depends on, and retiring the change would lose something the user wanted;
- meeting an intent needs a choice that the intents and the guide don't settle;
- the review fails twice;
- a test fails and you can't fix it.

To ask, push the branch, open a pull request and link it with `link_pull_request`, then end with one short message that names the decision. Leave the thread active.

Otherwise:

1. Merge to the main branch: `git checkout <main> && git merge --ff-only <branch>`. If main moved, rebase the branch first and build again.
2. Push the main branch, then delete the branch.
3. Run the config's `[deploy]` command from the repo root, and report its output.
4. Reply in a few lines: the upstream range, what merged on its own, what you repaired and how, what you retired, and the test, review and deploy results.
5. Settle the thread with `t3_thread_organize` (`settle`).

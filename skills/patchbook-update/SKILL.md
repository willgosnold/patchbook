---
name: patchbook-update
description: Pull upstreams into a repo that keeps its changes in a patchbook (.patchbook/), repair what broke from each change's intent, test and review, then merge and deploy only when the sync was clean or the test command passes, and otherwise open a pull request and ask. Use when a scheduled task or the user says to update a patchbook repo, or for /patchbook-update or $patchbook-update.
---

# Patchbook update

This repo keeps its changes to one or more upstream repos in `.patchbook/`. Read `.patchbook/config.toml` and the guide it names (`guide`) before you change anything. `patchbook --help` lists the commands. The `patchbook` repo's `DESIGN.md` explains the model.

Never edit the build output, or a vendored copy, by hand. Change the patchbook, then build. A pre-commit hook rebuilds on each commit once the patchbook has no problems, so a commit may include the rebuilt output. That's expected.

To read an upstream, use `patchbook upstream <name>`: `<name> <path>` prints a file at the pin, `--diff` shows what upstream changed in the last sync, and `--export <dir>` writes it all out for searching.

## 1. Check

First, upgrade patchbook the way it was installed, if you can tell: `npm install -g patchbook@latest` for an npm install, or rerun the install script for a script install. If you can't tell how it was installed, or the upgrade fails, carry on with the installed version. `patchbook --version` prints it.

Then run `patchbook check`.

- Exit 0: no upstream has moved. If a scheduled task started this thread, clean up (below) and archive the thread with `t3_thread_organize` (`archive`) as your last action. Otherwise say so and stop.
- Exit 10: continue. The JSON says which upstreams moved and which of their files changed.
- Anything else: report the error and stop, leaving the thread for the user.

## 2. Sync on this thread's branch

T3 gives each run its own worktree and branch. Work there.

1. Find the main branch and the main checkout. Shell variables don't last between commands, so note both values:
   - `MAIN_BRANCH=$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##')`
   - `MAIN_CHECKOUT=$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')`
2. Run `git fetch origin && git rebase origin/$MAIN_BRANCH`. The branch must have no commits of its own yet. If this thread is in the main checkout instead of a worktree, create a branch, `patchbook/upstream-<date>`, first.
3. Run `patchbook sync`. It moves every upstream that moved. Commit everything it changed as "Sync upstream <name> to <short sha>", naming each upstream.
4. Read `.patchbook/last-sync.json` (per upstream: what changed and what merged on its own) and `patchbook status --json` (what broke).

## 3. Repair

Fix each problem from the change's intent and the guide. Keep upstream's new behaviour wherever the intent allows. Paths are staged paths: an upstream that isn't mounted at the root has its files under its mount folder.

| Problem | What to do |
| --- | --- |
| conflict | Resolve the conflict markers in the change's `ours` copy so its intent holds on upstream's new text. |
| gone | Upstream moved or deleted the file. If it moved (`maybe` in the sync report), point the edit at the new path: copy the new upstream file to `base`, redo `ours` from the intent, and update `CHANGE.md`. If it was deleted and the intent no longer applies, retire the change. |
| orphan, missing, leak, check, placeholder | As the guide says. |
| `replaced_upstream_changed` | Upstream changed a file this repo replaces outright. Read upstream's change and carry over what the intent doesn't exclude. |

Also read the upstream changes in the sync report for new files or features the guide says to handle, even where no check fired.

To retire a change, remove it from `series` and its folder, and add it to `retired.md` with the reason.

Commit each change you repair on its own, as "Carry <change> to upstream <short sha>".

## 4. Test

Run `patchbook build`. The hook builds on each commit, so this usually changes nothing. If it changes files, commit them. Then run the config's `[test]`: a `command` must exit 0, and an `instructions` file is a procedure to follow. Fix a failure if you can, with at most two attempts.

## 5. Review

Start a reviewer with `delegate_task`. Call `orchestrator_capabilities` first. If it lists a provider other than `inheritedProviderInstanceId` with `canRunCrossProviderChildTask` true, set `target` to that provider and the strongest model it lists, with its reasoning option at `high` if it has one. Otherwise omit `target`, so the reviewer runs on this thread's model and effort. Its brief holds:

- the guide's path;
- each repaired or retired change, with its intent;
- the upstream changes from the sync report;
- `git diff origin/$MAIN_BRANCH...HEAD -- .patchbook`;
- the test results.

Ask it, per change: does the result meet the intent on upstream's new text, does it change anything beyond the intent, and did upstream add anything that should have been handled. It answers pass or fail, with reasons. On a fail, fix what it found and start a new review round, with the earlier findings in the brief. Stop after two rounds.

## 6. Merge, or ask

Merge only on one of these signals:

- **Clean.** After the sync, `patchbook status` exited 0 and the sync report had no `replaced_upstream_changed`, and every commit after the sync commit is build output from step 4. A repair, a retirement or a test fix voids it.
- **Tested.** The config's `[test]` has a `command`, and it exits 0 on the branch's last commit.

An `instructions` test and the review are not signals, since an agent grades both.

Ask the user instead of merging when neither signal holds, or when:

- upstream removed or reworked something an intent depends on, and retiring the change would lose something the user wanted;
- meeting an intent needs a choice that the intents and the guide don't settle;
- the review fails twice;
- a test fails and you can't fix it.

To ask, push the branch (`git push -u origin HEAD`), open a pull request against `$MAIN_BRANCH` and link it with `link_pull_request`, then end with one short message that names the decision. Keep the worktree, since the pull request needs it, and leave the thread active.

Otherwise:

1. Run `git fetch origin && git rebase origin/$MAIN_BRANCH`. If that brought in new commits, Clean no longer holds, so do step 4 again and merge only if Tested holds, or ask.
2. Push to the main branch: `git push origin HEAD:$MAIN_BRANCH`.
3. Fast-forward the main checkout, if it is on `$MAIN_BRANCH` and clean: `git -C "$MAIN_CHECKOUT" pull --ff-only`.
4. Run the config's `[deploy]` command from this worktree's root, and report its output.
5. Reply in a few lines: each upstream's range, what merged on its own, what you repaired and how, what you retired, and the test, review and deploy results.
6. Clean up (below), then settle the thread with `t3_thread_organize` (`settle`) as your last action.

## Clean up

Remove this run's worktree and branch, unless you stopped to ask:

```sh
HERE=$(git rev-parse --show-toplevel)
BRANCH=$(git branch --show-current)
MAIN_CHECKOUT=$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')
if [ "$HERE" != "$MAIN_CHECKOUT" ]; then
  cd "$MAIN_CHECKOUT" && git worktree remove --force "$HERE" && git branch -D "$BRANCH"
fi
```

---
name: patchbook-update
description: Pull upstreams into a repo that keeps its changes in a patchbook (.patchbook/), repair what broke from each change's intent, test and review, then merge and deploy only when the sync was clean or the test command passes, and otherwise ask, opening a pull request when there are commits to push. Use when a scheduled task or the user says to update a patchbook repo, or for /patchbook-update or $patchbook-update.
---

# Patchbook update

This repo keeps its changes to one or more upstream repos in `.patchbook/`. Read `.patchbook/config.toml` and the guide it names (`guide`) before you change anything. `patchbook --help` lists the commands. The `patchbook` repo's `DESIGN.md` explains the model.

Never edit the build output, or a vendored copy, by hand. Change the patchbook, then build.

Never commit `.patchbook/last-sync.json`. To stage everything, use `git add -A -- . ':!.patchbook/last-sync.json'`. To commit one thing, stage its paths. Make every commit with `PATCHBOOK_HOOK=0 git commit`, which skips patchbook's pre-commit hook: in a fork the hook records unstaged and untracked files and hand edits to the output into whatever commit runs.

To read an upstream, use `patchbook upstream <name>`: `<name> <path>` prints a file at the pin, `--diff` shows what upstream changed in the last sync, and `--export <dir>` writes it all out for searching. Export outside the worktree.

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
3. Run `patchbook sync`. It moves every upstream that moved, and prints `<name>: pinned <short sha>` for each one. If it exits non-zero, quote its message and ask (step 6), before any commit. Otherwise commit everything it changed except `.patchbook/last-sync.json` (`git add -A -- . ':!.patchbook/last-sync.json'`, then `PATCHBOOK_HOOK=0 git commit`) as "Sync upstream <name> to <short sha>", naming each upstream.
4. Read `.patchbook/last-sync.json` (per upstream: what changed and what merged on its own) and `patchbook status --json` (what broke). Here and in steps 3, 5 and 6, read only the reports of the upstreams `patchbook sync` printed `pinned` for. An upstream can move after step 1, so this list can be longer than `patchbook check`'s.

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

Commit each change you repair or retire on its own with `PATCHBOOK_HOOK=0 git commit`, as "Carry <change> to upstream <short sha>" or "Retire <change>". Handle each `replaced_upstream_changed` entry in such a commit, whose message names the file and says what you carried over, or what you left out and why. If you carried over nothing, commit with `PATCHBOOK_HOOK=0 git commit --allow-empty`.

## 4. Test

Before you build, run `git status --porcelain`. Delete anything you or a test wrote that doesn't belong in the repo, such as an export or notes, but keep `.patchbook/last-sync.json`. If it then lists a file in the build output (the config's `[output] to` folder, or in a fork everything outside `.patchbook/` and the vendored copies) or in a vendored copy (the folder an upstream's `vendor` names, wherever it is), that is a hand edit: don't commit it, and ask (step 6). Commit each other change or fix it lists, except `.patchbook/last-sync.json`, on its own with `PATCHBOOK_HOOK=0 git commit` and a message that says what it is. If you can't say what something is, ask (step 6).

Run `patchbook build`. Since no commit runs the hook, this is the run's only build. If it fails, quote its message and ask (step 6). If `git status --porcelain` then lists more than `.patchbook/last-sync.json`, commit it as one build commit (`git add -A -- . ':!.patchbook/last-sync.json'`, then `PATCHBOOK_HOOK=0 git commit`). It holds only what `patchbook build` wrote: output files and `.patchbook/build.lock`.

Then run the `[test]` from the config on `origin/$MAIN_BRANCH` (`git show origin/$MAIN_BRANCH:.patchbook/config.toml`), not the branch's copy, from the worktree's root: a `command` must exit 0, and an `instructions` file, also read from `origin/$MAIN_BRANCH` (`git show origin/$MAIN_BRANCH:<file>`), is a procedure to follow. If that `git show` fails, ask (step 6). After each test run, delete each file that `git ls-files --others --exclude-standard -- . ':!.patchbook/last-sync.json'` lists. The pre-build check left no other untracked file, and the build commit holds what the build wrote, so each one is the test's output. Keep `.patchbook/last-sync.json`, which `patchbook sync` wrote and steps 5 and 6 still read. Then, if `git status --porcelain --untracked-files=no` prints anything, ask (step 6), even if the test passed. Fix a failure if you can, with at most two attempts. A fix changes what the test checks, never the test, its scripts or its fixtures. If the only fix you can find changes one of those, ask (step 6). Commit each fix on its own with `PATCHBOOK_HOOK=0 git commit`, as "Fix test: <what>", then do step 4 again.

## 5. Review

Start a reviewer with `delegate_task`, `mode: "wait"` and `timeoutMs: 3600000`, and go on to step 6 only after it returns. If it returns `waitTimedOut` or `hasPendingQuestion`, or ends with no verdicts at all, stop it with `task_cancel` and count the round as a fail. Call `orchestrator_capabilities` first, and choose the reviewer's model from its `providers`:

- Take the first provider, other than `inheritedProviderInstanceId`, with `canRunCrossProviderChildTask` true.
- Of its models, take the one whose `label` has the highest version number, such as 6.1 in `GPT-6.1-Sol`. On a tie, or when no label has one, take the first listed.
- If that model has an `effort` or `reasoningEffort` option, set it to the highest of `max`, `xhigh` and `high` that the option lists.

Set `target` to the provider's `providerInstanceId`, the model's `id` (not its `label`) and that option. If the model lists none of `max`, `xhigh` and `high`, leave the option out. If no other provider qualifies, omit `target`, so the reviewer runs on this thread's model and effort. Its brief holds:

- the guide's path;
- each repaired or retired change, with its intent;
- the upstream changes from the sync report;
- `git diff origin/$MAIN_BRANCH...HEAD -- .patchbook`;
- the test results.

Ask it, per change: does the result meet the intent on upstream's new text, and does it change anything beyond the intent. Ask it once: did upstream add anything that should have been handled. It answers each pass or fail, with reasons, without asking questions. A change or question it gives no pass or fail counts as a fail. On a fail, fix what it found, commit the fix on its own with `PATCHBOOK_HOOK=0 git commit` as "Fix review: <what>", do step 4 again, and start a new review round, with the earlier findings in the brief. A timeout, a pending question or a missing verdict fails the round but finds nothing to fix, so it adds no commit: start the next round. Stop after two rounds.

## 6. Merge, or ask

Merge only when, on the commit you push, `patchbook status` exits 0, `patchbook build` exits 0 and `git status --porcelain --untracked-files=no` then prints nothing, and one of these signals holds:

- **Clean.** In `.patchbook/last-sync.json`, the report of each upstream `patchbook sync` printed `pinned` for has an empty `replaced_upstream_changed` list. Step 3 found nothing to handle, from a check or from reading upstream's changes. The only commit after the sync commit, if any, is step 4's build commit, and the rebase below brings in no commits. A repair, a retirement, a test fix or a review fix voids it.
- **Tested.** The `[test]` on `origin/$MAIN_BRANCH` has a `command`, and it exited 0 on the commit you push. After any later commit, a review fix included, do step 4 again.

An `instructions` test and the review are not signals, since an agent grades both.

Ask the user instead of merging when that doesn't hold, or when:

- `patchbook sync` exits non-zero;
- upstream removed or reworked something an intent depends on, and retiring the change would lose something the user wanted;
- meeting an intent needs a choice that the intents and the guide don't settle;
- the second review round returns any fail;
- a test fails and you can't fix it. A failing `instructions` test counts, even though a passing one is not a signal, and so does an `instructions` file you can't read from `origin/$MAIN_BRANCH`;
- a test leaves tracked files changed (`git status --porcelain --untracked-files=no` prints something), even if it passed;
- step 4's pre-build check lists a hand edit to the output or a vendored copy;
- a `replaced_upstream_changed` entry in the report of an upstream `patchbook sync` printed `pinned` for has no step 3 commit that names its file;
- the branch changes `[test]` in `.patchbook/config.toml` (see `git diff origin/$MAIN_BRANCH...HEAD -- .patchbook/config.toml`);
- the only fix you can find for a failing test changes the test, its scripts or its fixtures.

To ask, push the branch (`git push -u origin HEAD`), open a pull request against `$MAIN_BRANCH` and link it with `link_pull_request`, then end with one short message that names the decision. If the branch has no commits of its own, as after a failed sync, skip the push and the pull request. Keep the worktree, since the operator's answer needs what is in it, and leave the thread active.

Otherwise:

1. Run `git fetch origin && git rebase origin/$MAIN_BRANCH`. If the rebase fails, run `git rebase --abort` and ask. If it brought in new commits, Clean no longer holds, so do step 4 again and merge only if the condition above holds with Tested, or ask.
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

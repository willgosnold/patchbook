# QA journeys

Each scenario in `scenarios/` is a user journey that spans several commands, such as ship skills from a second upstream, rename one, let upstream change it, sync, and read `status`. The journeys come from dogfooding patchbook on a real fork, where the bugs that `bun test` missed showed up. A scenario runs the real CLI in a [verify-patchbook](../.agents/skills/verify-patchbook/SKILL.md) sandbox and checks what a user sees: exit codes, `CHANGE.md`, that `build` and `sync` succeed, that synced output has upstream's revision, that no change is left `pending`, and that `status` agrees with `build`.

The sandbox's fake model always replies in the shape patchbook asks for, so a bad reply from a real model can't show up in a fake run. To catch those, run the same scenarios with the real `claude` CLI several times and read the pass rate. To check what happens with no usable reply at all, a scenario sets `PB_FAKE_MODEL=fail`, so the fake fails like an offline CLI. In real runs, where the real CLI stands in for the fake, it sets `intent.provider` to `none` instead, so no model answers either.

The scenarios, and the issues they come from:

| Scenario | Journey | Issues |
| --- | --- | --- |
| `ship-upstream-skills` | Ship twelve skills from a second upstream, then upstream revises one. | #307, #319, #321 |
| `rename-then-upstream-edit` | `git mv` a skill and edit its name, then upstream edits the old file. | #308, #319, #320 |
| `license-into-folders` | Copy upstream's `LICENSE` into twelve shipped skill folders in one commit. | #319 |
| `edit-joins-change` | Reword a shipped skill, so the edit joins the change that shipped it. The fake model joins it. A real model chooses, and either choice passes. | #310 |
| `many-large-skills` | Add ten large skills in one commit, more than the 40,000 characters a prompt once held. | #309 |
| `copy-then-edit` | Copy a skill to a new folder and commit, then edit the copy. | #317 item 1 |
| `rename-that-grows` | `git mv` a skill and add more lines than it had. | #317 item 7 |
| `hand-deleted-output` | Delete an output by hand without recording it. | #317 item 5 |
| `model-fails` | `git mv` a skill and edit its name while the model fails, then have the model write the intent once it answers. | #320 |

## Run the scenarios

Run every scenario once with the fake model:

```sh
bun run qa
```

Run some of them by name:

```sh
bun run qa rename-then-upstream-edit license-into-folders
```

Run every scenario five times with the real `claude` CLI:

```sh
QA_MODEL=real bun run qa
```

Real runs call the paid model once or twice per run, with patchbook's default model and effort. Set `PATCHBOOK_MODEL` and `PATCHBOOK_EFFORT` to try others. `qa/run` refuses `QA_MODEL=real` when `CI` is set.

| Variable | Default | Meaning |
| --- | --- | --- |
| `QA_MODEL` | `fake` | `fake` for the sandbox's fake model, `real` for the `claude` CLI on `PATH` |
| `QA_RUNS` | 1 for fake, 5 for real | runs of each scenario |
| `QA_JOBS` | 4 | runs at once |
| `PATCHBOOK_CMD` | this checkout's `src/cli.ts` | the patchbook to drive, such as `dist/patchbook` or an older checkout |

## When to run them

- CI runs the fake model on every pull request.
- Before each release, run `QA_MODEL=real bun run qa` and compare the pass rates with the last release.
- When dogfooding finds a bug, add a scenario that fails on it. Tag the check with the issue (see below), so the suite stays green until the fix lands.

## Read the table

```
scenario                     pass   result
copy-then-edit               0/3    known #317, skills/c follows upstream (3)
edit-joins-change            3/3    all checks pass
hand-deleted-output          0/3    known #317, status agrees with build (3)
license-into-folders         3/3    all checks pass
many-large-skills            3/3    all checks pass
rename-that-grows            0/3    known #317, CHANGE.md moves skills/a to skills/a2 (3)
rename-then-upstream-edit    3/3    all checks pass
ship-upstream-skills         3/3    all checks pass
```

A run stops at its first failing check. `pass` counts the runs where every check passed. `result` names the check that stopped each run that didn't pass, with its count:

- `known #N` means the check is tagged with open issue #N in willgosnold/patchbook. It doesn't fail the suite.
- `FAIL` means an untagged check failed. `qa/run` exits 1.

`qa/run` deletes the sandbox and evidence of each run that passed. For every other run, it prints the evidence folder. That folder holds the run's log (`run.log`), every command and its output (`transcript.txt`), and the last prompt. In real runs, it also holds the model's replies (`replies.log`).

## Write a scenario

A scenario is a bash file that `qa/run` sources in a fresh sandbox, in the `fork` repo that `fixture` in `lib.sh` builds. That fork is the setup from #307. Upstream `up` builds `skills/` with `skills/a/SKILL.md`, and a second upstream, `extra`, is tracked at `extra/` with `skills/x/SKILL.md`.

Write each step a user takes as a plain command, and each thing they would check as a `check`:

```sh
git mv skills/a skills/a2
git add -A
check "the commit records the rename" git commit -qm "rename a to a2"
check "CHANGE.md moves skills/a to skills/a2" listed "move skills/a -> skills/a2"
```

`lib.sh` has the helpers:

- `check DESC CMD...` runs the command into the transcript and ends the run as a failure if it exits nonzero.
- `known ISSUE DESC CMD...` is a `check` that fails on `main` because of open issue `ISSUE`.
- `expect_no_pending` checks that no change is `pending` or has an empty intent. An intent patchbook wrote, on an `intent (by patchbook):` line, isn't empty.
- `listed EDIT...` checks that each edit is a line of some `CHANGE.md`.
- `status_agrees_with_build` checks that `status` says "no problems" exactly when `build` succeeds.
- `in_upstream NAME CMD...` runs the command in upstream `NAME` and commits the result.
- `sub FILE SED-EXPR` edits a file in place on both GNU and BSD `sed`.
- `real` is true in real runs.

Put a `known` check as late in the scenario as the journey allows, because the run stops there and the checks after it don't run. With the fake model, a `known` check that passes fails the run with `passes, so #N looks fixed`, so the PR that fixes an issue also changes its tags to `check`. Find them with `grep -rn 'known 3' qa/`.

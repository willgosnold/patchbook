# patchbook verification map

This directory is the maintained source for verifying what a patchbook user sees. Read this index before driving patchbook, then use the matching feature file as the recipe.

## Baseline preconditions

- A sandbox from `pb-sandbox new <label>`, with its `env.sh` sourced in the shell you drive from.
- `pb-sandbox doctor` prints only `ok` lines: `patchbook` is the sandbox shim and `claude` is the fake model.
- Upstreams are local git repos made in `$SB/work`. No recipe needs the network or a real model.
- Never drive a repo outside `$SB`, and never run patchbook in this checkout itself.

## Driving conventions

- Start every recipe from a fresh sandbox unless its preconditions say otherwise.
- Run each step whose result is proof through `rec`. Use plain commands for setup.
- Treat commands as literal. Keep quoted names, flags and file contents unchanged, because later steps assert exact output.
- `git commit` in a patchbook repo runs the pre-commit hook. Use `PATCHBOOK_HOOK=0 git commit` only where a recipe says so.
- The fake model answers `model-name` / `MODEL WROTE THIS.`. Set `PB_FAKE_CHANGE`, `PB_FAKE_INTENT`, `PB_FAKE_REPLY` or `PB_FAKE_MODEL=fail` on one command to change that.

## Proof and skip reporting

- CLI proof is the command, its combined output and its exit code, all in `$EVIDENCE/transcript.txt`.
- A command that writes the patchbook also needs a second view of what it wrote: `cat` the `CHANGE.md`, `series` or lock, and `git show --stat` after a commit.
- Record the feature file and the entry point with the evidence folder you report.
- A journey that fails at a known open issue is reported as failing, with the issue number. Don't weaken the journey to make it pass.
- Report an unreachable path with the command tried and the unmet precondition. Don't report it as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then has exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with pb-sandbox` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, commands, required state and observable proof.

## Features

- [Fork and the commit hook](./fork-and-hook.md) covers `clone`, hand edits recorded on `git commit`, and a clean `status`.
- [Record a change with its intent](./record.md) covers `record` with and without a name, `--intent`, `PATCHBOOK_INTENT`, the model fallback, and `show`.
- [Build into a folder](./folder-build.md) covers `init` for the folder layout, `build`, its refusal of unrecorded edits, `--force`, and `upstream`.
- [Keep up with upstream](./sync.md) covers `check`, `sync` with a clean merge and with a conflict, `upstream --diff`, and committing the sync.

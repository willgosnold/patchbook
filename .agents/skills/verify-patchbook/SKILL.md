---
name: verify-patchbook
description: Drive the patchbook CLI from this checkout in a disposable sandbox (its own git repos, store, config and a fake model) and capture a transcript as proof. Use to reproduce a patchbook bug, run an issue's repro script, or prove a change to clone, init, record, the pre-commit hook, build, status, check, sync or upstream works the way a user would see it.
---

# Verify patchbook

patchbook is a CLI. There is no server to start: each proof is a fresh sandbox with throwaway git repos, where you run `patchbook` the way a user would and record what it printed and what it left on disk. `bun test` proves the code; this proves the behavior a user sees.

The helper is `scripts/pb-sandbox` in this skill's folder. From the checkout root:

```sh
H=.agents/skills/verify-patchbook/scripts/pb-sandbox
```

## Launch

```sh
ENV=$($H new <label>)     # label: the issue or feature, e.g. issue-4 or sync
. "$ENV"                  # now in $SB/work, with pb, rec, $SB and $EVIDENCE defined
$H doctor
```

`new` makes `$TMPDIR/patchbook-verify/<label>-<time>-<pid>/` with:

- `bin/patchbook`, a shim that runs this checkout's `src/cli.ts` with an absolute bun path. Set `PATCHBOOK_CMD` before `new` to drive something else, such as a compiled `dist/patchbook`.
- `bin/claude`, a fake model. It answers `{"change": "model-name", "intent": "MODEL WROTE THIS.", "intents": {...}}`, with the same intent under every quoted name the prompt asks to rewrite, saves the prompt to `$SB/prompt.txt`, and logs each call to `$SB/model-calls.log`. Override per command with `PB_FAKE_CHANGE=` and `PB_FAKE_INTENT=`, set the whole reply with `PB_FAKE_REPLY=`, or make it fail like an offline CLI with `PB_FAKE_MODEL=fail`.
- `PATCHBOOK_HOME` (store) and `XDG_CONFIG_HOME` (user config) inside the sandbox, `GIT_CONFIG_GLOBAL=/dev/null`, a fixed git identity, `PATCHBOOK_SKILL=0` and `PATCHBOOK_PROVIDER=claude`.

Ready means `doctor` prints only `ok` lines. Every shell you drive from must source `$ENV` first. The env only lives in that shell, so in a tool that starts a fresh shell per command, start each command with `. "$ENV" &&`. Sourcing it also `cd`s to `$SB/work`.

The sandbox moves `XDG_CONFIG_HOME`, which hides mise's global config, so a bare `bun` inside it fails with `No version is set for shim: bun`. The shim already uses an absolute path. If you need `bun` itself in the sandbox, `export MISE_GLOBAL_CONFIG_FILE=$HOME/.config/mise/config.toml`.

**Repro scripts from the audit issues** (#1–#33) begin with a "Sandbox setup" block. Skip that block: source `$ENV`, run `cd "$SB"` (the setup block ends there, and its `"$SB/up"` paths expect it), then paste the rest unchanged. Its `pb`, `$SB`, fake model answer and env match. Wrap the lines that show the bug in `rec` so the transcript holds the before and after.

## Doctor

```sh
$H doctor
```

Read-only. It checks that `patchbook` and `claude` resolve to the sandbox's shim and fake, that the store and user config are inside the sandbox, that global git config is off, and that `patchbook --version` runs. Run it first, and again whenever output looks wrong. A `FAIL` on the `claude` line means a real model would be called: stop and re-source `$ENV`.

## Drive

Build upstreams as local git repos in `$SB/work`. Nothing needs the network. Then run patchbook through `rec`:

```sh
git init -q -b main up && printf 'one\ntwo\n' > up/app.txt && git -C up add -A && git -C up commit -qm start
rec pb clone "$SB/work/up" fork
cd fork
printf 'one\nTWO\n' > app.txt && git add app.txt
rec git commit -qm "shout two"
rec cat .patchbook/changes/model-name/CHANGE.md
```

`rec <command...>` runs the command in the current folder, prints its output, and appends the folder, command, combined stdout and stderr, and `[exit N]` to `$EVIDENCE/transcript.txt`. It returns the command's exit code. It runs in a subshell, so use a plain `cd` to move around. Use plain commands, without `rec`, for setup that isn't part of the proof.

The pre-commit hook runs on `git commit` in any sandbox repo patchbook started, because `patchbook` on `PATH` is the shim. `PATCHBOOK_HOOK=0 git commit` skips it once.

[features/README.md](features/README.md) maps each user-facing feature to a recipe. Read it before proving a feature, and cover every entry point the feature's file lists.

## Evidence

Each sandbox has an evidence folder at `${XDG_STATE_HOME:-~/.local/state}/patchbook-verify/<same id>/`, in `$EVIDENCE`:

- `run.txt`: the sandbox, the checkout and its commit (flagged when there are uncommitted changes), the patchbook command, and the time.
- `transcript.txt`: every `rec` call.
- `last-model-prompt.txt` and `model-calls.log`, copied at cleanup when the fake model was called.

Copy anything else worth keeping, such as a generated `CHANGE.md` or a `git show`, into `$EVIDENCE` before cleanup, or capture it with `rec cat`/`rec git show`.

Proof standards:

- Run the commands a user runs (`clone`, `init`, `record`, `git commit`, `build`, `sync`). Don't call `src/` functions, and don't write `.patchbook/` files by hand, unless the issue's repro does that to set up a state no command can reach.
- Capture the action and the state it left: the command's output and exit code, plus the files it wrote (`CHANGE.md`, `series`, `upstream.lock`, the output files) and what git committed (`git show --stat`).
- For a bug fix, run the same journey before and after the fix. The transcript shows the issue's "Actual" before and its "Expected" after.
- A green `bun test` is not this proof. Report both.
- The fake model is the only mock, and it stands where patchbook already calls an external CLI. Check `model-calls.log` when a claim depends on whether the model was called.

## Cleanup

```sh
$H clean "$SB"
```

It refuses any folder outside `$TMPDIR/patchbook-verify/` or without the sandbox's `env.sh`. It copies the model prompt and call log into the evidence folder, deletes the sandbox, and leaves the evidence folder in place. `$H list` shows the sandboxes and evidence folders that remain. Only delete an evidence folder once its proof has been reported.

Sandboxes are independent. Run as many as you like side by side, each with its own label, and clean only the ones you made.

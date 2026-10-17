# patchbook

Keep your own version of someone else's repo, with every change written down along with why you made it, so you can keep taking their updates without redoing your work by hand.

A build applies your changes to a pinned upstream commit. When upstream moves, an agent redoes the changes that broke from their intent, and asks you only when it can't decide. See [DESIGN.md](DESIGN.md) for the model.

## Install

Once per machine:

```sh
uv tool install git+ssh://git@github.com/willgosnold/patchbook
```

You also need git, Python 3.11 or newer, and the `claude` or `codex` CLI, which patchbook uses to write intents.

## Quick start

**1. Start.** To change a repo directly, fork it:

```sh
patchbook clone https://github.com/pingdotgg/t3code
```

Or, to build something from a repo into a folder of your own repo, as wstack does with pstack:

```sh
patchbook init --upstream <url> --path <folder> --output-to <folder>
```

Then install the update skill for agents, in the repo:

```sh
npx skills add willgosnold/patchbook --skill patchbook-update
```

**2. Change things.** Edit files the way you normally would, including the built output, then commit as usual.

A pre-commit hook moves your edits into the patchbook, rebuilds, and adds both to the commit. A model reads the edits, names the change and writes its intent: what the change does and why. The first time, patchbook asks whether to use Claude or Codex. To write the intent yourself, commit with `PATCHBOOK_INTENT="..." git commit`, or run `patchbook record <name> --intent "..."` first.

The intent matters most. It's how an agent redoes your change later, if upstream rewrites the code underneath it.

**3. Keep up with upstream.** Add a daily T3 scheduled task in the repo with the prompt "Use the patchbook-update skill." Most days nothing has changed and the run tidies up after itself. When upstream moves, it pulls the new version, redoes any change that broke from its intent, tests, reviews its own work, then merges and deploys. It only comes to you when it can't decide.

To update by hand instead:

```sh
patchbook sync && patchbook status && patchbook build
```

## Rules

- Edits to the build output are kept only once they're recorded. The hook does that on commit; `patchbook build --force` drops them instead.
- Every change has an intent.
- `patchbook status` lists what's broken, and `patchbook build` won't run until it's fixed.

## More

```sh
patchbook track <name> <url>        # follow another upstream
patchbook upstream <name> [path]    # read an upstream at its pin; --diff shows its last change
patchbook show <change>             # a change as a diff
patchbook provider [claude|codex]   # choose the model that writes intents
patchbook --help
```

Tests: `python3 -m unittest test_patchbook`.

Used by [wstack](https://github.com/willgosnold/wstack).

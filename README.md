# patchbook

Keep your own version of someone else's repo, with every change written down along with why you made it, so you can keep taking their updates without redoing your work by hand.

A build applies your changes to a pinned upstream commit. When upstream moves, an agent redoes the changes that broke from their intent. It merges on its own only when nothing needed redoing or handling, or your test command passes, and asks you otherwise. See [DESIGN.md](DESIGN.md) for the model.

## Install

With npm, which installs the binary for your platform:

```sh
npm install -g patchbook
```

Or download the binary from the latest [GitHub release](https://github.com/willgosnold/patchbook/releases) with the install script. It checks the checksum and installs to `~/.local/bin`:

```sh
curl -fsSL https://raw.githubusercontent.com/willgosnold/patchbook/main/install.sh | sh
```

Or build from source with [Bun](https://bun.sh), and put `dist/patchbook` on your PATH:

```sh
git clone git@github.com:willgosnold/patchbook.git
cd patchbook
bun install
bun run build
```

The binary carries its own runtime, so Bun and Node are needed only to build it or to install it with npm.

Patchbook runs git, and the `claude` or `codex` CLI to write intents, so you need git and one of those.

## Quick start

**1. Start.** To change a repo directly, fork it:

```sh
patchbook clone https://github.com/pingdotgg/t3code
```

Or, to build something from a repo into a folder of your own repo, as wstack does with pstack:

```sh
patchbook init --upstream <url> --path <folder> --output-to <folder>
```

Both install a pre-commit hook in the repo, unless `hook.enabled` is off (`patchbook config hook.enabled false`, or `PATCHBOOK_HOOK=0` in the environment), and write the `patchbook-update` skill for agents to `.agents/skills/patchbook-update/`, with a `.claude/skills` link for Claude Code.

If the repo runs its hooks through a hook manager, patchbook's hook has to run from there. For Vite+ (`.vite-hooks/pre-commit`) and husky (`.husky/pre-commit`), patchbook puts `patchbook hook run` first in the script, and in a fork records that edit as the change `patchbook-hook`. For lefthook, the pre-commit framework and any other `core.hooksPath`, it prints the lines to add, and `patchbook hook install` prints them again. For lefthook they are in the format of its config file, whether that is YAML, TOML or JSON. `patchbook status` warns while git runs no hook, or the hook it runs doesn't call patchbook, and `patchbook hook status` shows which hook git runs. In a new git worktree of a husky or Vite+ repo, git runs no hook until you run the manager's install (`npx husky`, `vp config`).

Patchbook runs first, so the manager's checks see the rebuilt output. A fixer that rewrites an output file after patchbook, such as `prettier --write` in `vp staged`, leaves the commit's output different from `build.lock`, and the next commit records that rewrite as a hand edit. With lefthook, patchbook must not run in parallel with other commands, because it stages files and runs `git update-index`.

What patchbook adds to a manager (the lines in a Vite+ or husky script, the command in a lefthook config, the entry in a pre-commit config) stops the commit when patchbook isn't installed, unlike the `.git/hooks` script. A teammate without patchbook is told to run `npm install -g patchbook`, and can skip the hook once with `PATCHBOOK_HOOK=0 git commit`, under every manager. In a repo without a `.patchbook/config.toml` it does nothing. If the lefthook or pre-commit config already has the `pre-commit:` or `repos:` key, patchbook prints only what goes under it, so paste that in rather than a second copy of the key.

**2. Change things.** Edit files the way you normally would, including the built output, then stage them and commit as usual.

With the hook installed and `hook.enabled` on, a pre-commit hook moves the edits you staged into the patchbook, rebuilds, and adds both to the commit. `patchbook hook status` says whether git runs it. A model reads the edits, names the change and writes its intent: what the change does and why. It uses Claude if it's installed, otherwise Codex; `patchbook config intent.provider codex` switches. To write the intent yourself, commit with `PATCHBOOK_INTENT="..." git commit`, or run `patchbook record <name> --intent "..."` and `git add .patchbook` first.

The intent matters most. It's how an agent redoes your change later, if upstream rewrites the code underneath it.

**3. Keep up with upstream.** Add a daily T3 scheduled task in the repo with the prompt "Use the patchbook-update skill." Most days nothing has changed and the run tidies up after itself. When upstream moves, it pulls the new version, redoes any change that broke from its intent, tests, and has a second agent review the work. It merges and deploys on its own only when nothing is left broken and either the update needed no repair or other handling, or your test command passes on the result. Otherwise it asks you, opening a pull request when it has commits to push.

To update by hand instead:

```sh
patchbook sync && patchbook status && patchbook build
```

## Rules

- Edits to the build output are kept only once they're recorded. The hook does that on commit; `patchbook build --force` drops them instead.
- Every change has an intent.
- A change name is lowercase letters, digits and dashes, starting with a letter or digit. If a change has any other name, an edit path that isn't a clean path inside the tree (`../x`, `/x`, `./x`, `a//b`), or an edit that writes into `.patchbook` or `.git`, the hook refuses the commit and leaves everything as it was. Any other problem that `status` reports only skips the build, with a warning. The build's own safety checks still stop a commit.
- `patchbook status` lists what's broken, and `patchbook build` won't run until it's fixed.
- In a fork, take upstream's updates with `patchbook sync`, never by merging or pulling the `upstream` remote (`git merge upstream/main`, `git pull upstream`, or a bare `git pull` on a branch `clone` made). A git merge brings in upstream's files without moving the pin, so the next commit records upstream's changes as your own edits. The hook and `patchbook build` stop when commits of `upstream/<branch>` (`upstream/main` by default) newer than the pin are already in your history. Undo the merge, or run `patchbook sync`, stage what it changes and commit again (or run `patchbook build` if you have nothing to commit; if that refuses over unrecorded edits to the output, `patchbook build --force` drops them). Squash merges and cherry-picks aren't detected.
- After merging branches that each recorded changes, `.patchbook/series` and `.patchbook/build.lock` can conflict. Resolve `series` by keeping both lines, take either side of `build.lock`, then run `patchbook build` to regenerate the lock. Two changes that edit the same file can't be merged by rebuilding.
- Commits that skip the hook (`--no-verify`, the GitHub web UI, tools that don't run hooks) leave the output and `build.lock` out of step. The next hooked commit records the difference as hand edits, in a change you can read with `patchbook show`.

## More

```sh
patchbook track <name> <url>        # follow another upstream
patchbook upstream <name> [path]    # read an upstream at its pin; --diff shows its last change
patchbook show <change>             # a change as a diff
patchbook config [name] [value]     # settings: yours, or the project's with --project
patchbook skill install             # write this patchbook's update skill into the repo
patchbook --help
```

Tests: `bun test`. Typecheck: `bun run typecheck`.

Used by [wstack](https://github.com/willgosnold/wstack).

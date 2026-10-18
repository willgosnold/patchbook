# patchbook

Keep your own version of someone else's repo, with every change written down along with why you made it, so you can keep taking their updates without redoing your work by hand.

A build applies your changes to a pinned upstream commit. When upstream moves, an agent redoes the changes that broke from their intent, and asks you only when it can't decide. See [DESIGN.md](DESIGN.md) for the model.

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

Both install a pre-commit hook in the repo, and write the `patchbook-update` skill for agents to `.agents/skills/patchbook-update/`, with a `.claude/skills` link for Claude Code.

**2. Change things.** Edit files the way you normally would, including the built output, then commit as usual.

A pre-commit hook moves your edits into the patchbook, rebuilds, and adds both to the commit. A model reads the edits, names the change and writes its intent: what the change does and why. It uses Claude if it's installed, otherwise Codex; `patchbook config intent.provider codex` switches. To write the intent yourself, commit with `PATCHBOOK_INTENT="..." git commit`, or run `patchbook record <name> --intent "..."` first.

The intent matters most. It's how an agent redoes your change later, if upstream rewrites the code underneath it.

**3. Keep up with upstream.** Add a daily T3 scheduled task in the repo with the prompt "Use the patchbook-update skill." Most days nothing has changed and the run tidies up after itself. When upstream moves, it pulls the new version, redoes any change that broke from its intent, tests, reviews its own work, then merges and deploys. It only comes to you when it can't decide.

To update by hand instead:

```sh
patchbook sync && patchbook status && patchbook build
```

## Rules

- Edits to the build output are kept only once they're recorded. The hook does that on commit; `patchbook build --force` drops them instead.
- Every change has an intent.
- A change name is lowercase letters, digits and dashes, starting with a letter or digit. If a change has any other name, an edit path that isn't a clean path inside the tree (`../x`, `/x`, `./x`, `a//b`), or an edit that writes into `.patchbook` or `.git`, the hook refuses the commit and leaves everything as it was. Any other problem that `status` reports only skips the build, with a warning. The build's own safety checks still stop a commit.
- `patchbook status` lists what's broken, and `patchbook build` won't run until it's fixed.
- In a fork, take upstream's updates with `patchbook sync`, never by merging or pulling the `upstream` remote (`git merge upstream/main`, `git pull upstream`, or a bare `git pull` on a branch `clone` made). A git merge brings in upstream's files without moving the pin, so the next commit records upstream's changes as your own edits.

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

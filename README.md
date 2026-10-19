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

A fork can't follow an upstream that has a folder named `.PATCHBOOK`, `.patchbook.` or `.patchbook ` (case and trailing dots and spaces aside), because that is `.patchbook` on macOS and Windows. `clone`, `init` and `sync` refuse it and name the path.

Or, to build something from a repo into a folder of your own repo, as wstack does with pstack:

```sh
patchbook init --upstream <url> --path <folder> --output-to <folder>
```

Both install a pre-commit hook in the repo, unless `hook.enabled` is off (`patchbook config hook.enabled false`, or `PATCHBOOK_HOOK=0` in the environment), and write the `patchbook-update` skill for agents to `.agents/skills/patchbook-update/`, with a `.claude/skills` link for Claude Code.

If the repo runs its hooks through a hook manager, patchbook's hook has to run from there. For Vite+ (`.vite-hooks/pre-commit`) and husky (`.husky/pre-commit`), patchbook puts `patchbook hook run` first in the script, and in a fork records that edit as the change `patchbook-hook`. For lefthook, the pre-commit framework and any other `core.hooksPath`, it prints the lines to add, and `patchbook hook install` prints them again. For lefthook they are in the format of its config file, whether that is YAML, TOML or JSON. `patchbook status` warns while git runs no hook, or the hook it runs doesn't call patchbook, and `patchbook hook status` shows which hook git runs. In a new git worktree of a husky or Vite+ repo, git runs no hook until you run the manager's install (`npx husky`, `vp config`).

Patchbook runs first, so the manager's checks see the rebuilt output. A fixer that rewrites an output file after patchbook, such as `prettier --write` in `vp staged`, leaves the commit's output different from `build.lock`, and the next commit records that rewrite as a hand edit. With lefthook, patchbook must not run in parallel with other commands, because it stages files and runs `git update-index`.

What patchbook adds to a manager (the lines in a Vite+ or husky script, the command in a lefthook config, the entry in a pre-commit config) stops the commit when patchbook isn't installed, unlike the `.git/hooks` script. A teammate without patchbook is told to run `npm install -g patchbook`, and can skip the hook once with `PATCHBOOK_HOOK=0 git commit`, under every manager. In a repo without a `.patchbook/config.toml` it does nothing. If the lefthook or pre-commit config already has the `pre-commit:` or `repos:` key, patchbook prints only what goes under it, so paste that in rather than a second copy of the key.

**2. Change things.** Edit files the way you normally would, including the built output, then stage them and commit as usual.

With the hook installed and `hook.enabled` on, a pre-commit hook moves the edits you staged into the patchbook, rebuilds, and adds both to the commit. `patchbook hook status` says whether git runs it. A model reads the edits, names the change and writes its intent: what the change does and why. Claude runs with no tools or MCP servers, and codex read-only. A reply that isn't one JSON object, bare or in a code fence, counts as a failed call. It uses Claude if it's installed, otherwise Codex; `patchbook config intent.provider codex` switches. To write the intent yourself, commit with `PATCHBOOK_INTENT="..." git commit`, or run `patchbook record <name> --intent "..."` and `git add .patchbook` first. If the model is missing, offline or slower than `intent.timeout` (60 seconds), the commit still goes through: the edits are recorded with an empty intent, `patchbook status` reports it and `patchbook build` refuses until `patchbook intent` fills it. `patchbook config intent.provider none` turns the model off.

The intent matters most. It's how an agent redoes your change later, if upstream rewrites the code underneath it.

**3. Keep up with upstream.** Have an agent run "Use the patchbook-update skill." in the repo every day, from T3 Code, cron or CI ([Scheduled updates](#scheduled-updates)). Most days nothing has changed and the run tidies up after itself. When upstream moves, it pulls the new version, redoes any change that broke from its intent, tests, and has a second agent review the work. It merges and deploys on its own only when nothing is left broken and either the update needed no repair or other handling, or your test command passes on the result. Otherwise it asks you, opening a pull request when it has commits to push.

To update by hand instead:

```sh
patchbook sync && patchbook status && patchbook build
```

## Scheduled updates

The `patchbook-update` skill runs in any agent that reads `.agents/skills/` or `.claude/skills/`. It uses T3 Code's thread, review and pull request tools when the agent has them. Without them, it makes its own worktree, reviews with the agent's own subagent tool or in a second pass of its own, and opens a pull request with `gh` when it can. It never waits for an answer: when it needs you, it pushes its branch, opens a pull request if it can, and stops. Its last line says how the run ended: `patchbook-update: up to date`, `patchbook-update: merged`, `patchbook-update: needs you: <the decision>` or `patchbook-update: failed: <the error>`.

Choose a scheduler:

- **T3 Code.** Add a daily scheduled task in the project with the prompt "Use the patchbook-update skill."
- **cron, with Claude Code or Codex.** Run the script below every day.
- **CI, with no agent.** Run the second script below from a scheduled job. It never merges. When upstream moves, it opens a pull request for you or an agent to finish.

An unattended agent has to commit, push and run your test command with no one to approve each step, so the script turns permission prompts off. Run it only on a machine and in a repo where you accept that.

`patchbook-update.sh` runs the skill and exits 1 unless the run ended up to date or merged:

```sh
#!/bin/sh
cd /path/to/repo || exit 1
out=$(claude -p "Use the patchbook-update skill." --permission-mode bypassPermissions)
printf '%s\n' "$out"
case $(printf '%s\n' "$out" | tail -n 1) in
  "patchbook-update: up to date" | "patchbook-update: merged") exit 0 ;;
  *) exit 1 ;;
esac
```

With Codex, replace the `claude` line with `out=$(codex exec --dangerously-bypass-approvals-and-sandbox "Use the patchbook-update skill." < /dev/null)`. Then add it to your crontab with `crontab -e`. cron starts with a short `PATH`, so set one that finds `patchbook`, `git`, `gh` and the agent:

```
PATH=/home/you/.local/bin:/usr/local/bin:/usr/bin:/bin
17 6 * * * /path/to/patchbook-update.sh >> /home/you/patchbook-update.log 2>&1
```

Without an agent, nothing can repair a change or decide to merge, but a job can still take upstream's update and hand it to you. `patchbook-sync-pr.sh` does that on a new branch, and opens a pull request with `gh`:

```sh
#!/bin/sh
set -e
code=0
patchbook check > /dev/null || code=$?
[ "$code" = 0 ] && exit 0
[ "$code" = 10 ] || exit "$code"
branch=patchbook/upstream-$(date -u +%Y%m%d-%H%M%S)
git switch -c "$branch"
patchbook sync
git add -A -- . ':!.patchbook/last-sync.json'
git diff --cached --quiet && exit 0
PATCHBOOK_HOOK=0 git commit -q -m "Sync upstream"
if body=$(patchbook status 2>&1) && body=$(patchbook build 2>&1); then
  git add -A -- . ':!.patchbook/last-sync.json'
  git diff --cached --quiet || PATCHBOOK_HOOK=0 git commit -q -m "Build"
fi
git push -u origin "$branch"
gh pr create --title "Sync upstream" --body "$body"
```

It needs a full clone (in GitHub Actions, `actions/checkout` with `fetch-depth: 0`), a git identity, `patchbook` installed, and `GH_TOKEN` set for `gh`. The pull request's body is what `patchbook build` printed when the update built. Otherwise it is what `patchbook status` or `patchbook build` printed when it stopped: the problems that you or an agent must repair before merging.

## Rules

- Edits to the build output are kept only once they're recorded. The hook does that on commit; `patchbook build --force` drops them instead.
- Every change has an intent.
- A change name is lowercase letters, digits and dashes, starting with a letter or digit. If a change has any other name, an edit path that isn't a clean path inside the tree (`../x`, `/x`, `./x`, `a//b`, `a\b`), or an edit that writes into `.patchbook` or `.git`, the hook refuses the commit and leaves everything as it was. Any other problem that `status` reports only skips the build, with a warning. The build's own safety checks still stop a commit.
- `patchbook status` lists what's broken, and `patchbook build` won't run until it's fixed.
- In a fork, take upstream's updates with `patchbook sync`, never by merging or pulling the `upstream` remote (`git merge upstream/main`, `git pull upstream`, or a bare `git pull` on a branch `clone` made). A git merge brings in upstream's files without moving the pin, so the next commit records upstream's changes as your own edits. The hook and `patchbook build` stop when commits of `upstream/<branch>` (`upstream/main` by default) newer than the pin are already in your history. Undo the merge, or run `patchbook sync`, stage what it changes and commit again (or run `patchbook build` if you have nothing to commit; if that refuses over unrecorded edits to the output, `patchbook build --force` drops them). Squash merges and cherry-picks aren't detected.
- After merging branches that each recorded changes, `.patchbook/series` and `.patchbook/build.lock` can conflict. Resolve `series` by keeping both lines, take either side of `build.lock`, then run `patchbook build` to regenerate the lock. Two changes that edit the same file can't be merged by rebuilding.
- Commits that skip the hook (`--no-verify`, the GitHub web UI, tools that don't run hooks) leave the output and `build.lock` out of step. The next hooked commit records the difference as hand edits, in a change you can read with `patchbook show`.

## More

```sh
patchbook track <name> <url>        # follow another upstream
patchbook upstream <name> [path]    # read an upstream at its pin; --diff shows its last change
patchbook show <change>             # a change as a diff
patchbook intent [change]           # fill the empty intents record left when the model failed
patchbook config [name] [value]     # settings: yours, or the project's with --project
patchbook skill install             # write this patchbook's update skill into the repo
patchbook --help
```

Tests: `bun test`. Typecheck: `bun run typecheck`.

Used by [wstack](https://github.com/willgosnold/wstack).

# Patchbook design

A patchbook holds your changes to someone else's repo, each with its intent, so you can keep pulling from upstream. A build applies the changes to a pinned upstream commit. When upstream moves, the tool reports which changes still apply and which broke, and an agent redoes each broken change from its intent. You are asked only when upstream makes an intent impossible or turns it into a real choice.

First user: [wstack](https://github.com/willgosnold/wstack), which rewrites Lauren Tan's pstack skills for T3 Code. Planned: a kiro-cli provider in a fork of T3 Code.

## Layouts

A repo uses one of two layouts.

- **folder.** The build writes its output to a folder of the repo. Use it when you ship something derived from upstream. wstack builds `skills/` from pstack.
- **fork.** The repo is upstream plus a `.patchbook/` folder. The build writes the patched tree over the repo root, leaving `.patchbook/` and any vendored copies alone. Upstream's files in the tree are build output. To change them, edit them in place, then run `patchbook record` to move the edit into the patchbook.

## Several upstreams

A patchbook can follow any number of upstreams. Each has a name and a mount, the folder of the staged tree its files appear under. One upstream may mount at the root. In a fork, that is the fork's own upstream. Every path in an edit, a block entry, or a check is a staged path, so `move extra/skills/tool -> skills/tool` ships one skill from an upstream mounted at `extra`.

`patchbook track <name> <url>` follows another upstream. `check` reports each one, and `sync` moves every pin, or one with `sync <name>`.

## The upstream store

A repo holds only what it changed. Each upstream lives once per user, in the store (`~/.local/share/patchbook/upstreams/`, or `$PATCHBOOK_HOME/upstreams/`), as a git repo with each pinned commit fetched and referenced, so `git gc` keeps it. A commit that `check` only looks at gets no reference and gc prunes it. `check` references the pin when the store has it and never fetches it just for that. A read of a pin that cannot write its reference, such as one in a read-only store, warns and goes on. `sync` fails, before it rewrites the vendored copy or any change file, and leaves no reference for a commit that did not become the pin. Every repo that follows the same upstream shares it. A fork's own upstream is the fork's history, so it needs no store.

The store is data, not a cache: it is the only local copy of the unchanged upstream files. If it is lost, the tool fetches each pin again by commit. That fails only if upstream deleted the commit, which is the case for keeping a vendored copy: set `vendor = "<folder>"` on an upstream, and sync keeps a byte-for-byte copy in the repo, which the build checks against the pin.

`patchbook upstream <name>` reads an upstream at its pin. It lists the files, prints one (`upstream <name> <path>`), writes them all to a folder (`--export <dir>`), or shows what upstream changed in the last sync (`--diff`).

## Files

```
patchbook/
  config.toml            upstreams, layout, output, checks, test, deploy
  upstream.lock          each upstream's pinned commit and tree hash
  series                 change names, in the order the build applies them
  changes/<name>/
    CHANGE.md            the intent and the list of edits
    base/<path>.pb       the upstream file the change was made against
    ours/<path>.pb       our full version of that file
  blocks/<path>.entries  paragraph edits, for prose
  retired.md             changes dropped, and why
  hooks.ts               optional project code: placeholders, custom checks, final steps
```

Every stored copy ends in `.pb`. Without the suffix, tools that find files by name would treat stored copies as real ones. A test runner would run a stored `foo.test.ts`, and the `skills` CLI would install a stored `SKILL.md`.

## Changes

A change has a name, an intent, and one or more edits. The intent says what the change is for and how to tell whether it still applies. Reviewers judge the result against the intent, not line by line.

The paths in this example are illustrative.

```
# kiro-provider

intent: Add Kiro CLI as a T3 provider, with the same model picker and session handling as the Codex provider.

edits:
- add apps/server/src/provider/kiro/index.ts
- file apps/server/src/provider/registry.ts
- file packages/contracts/src/provider.ts
```

Edit kinds:

| Edit | Stores | Use |
| --- | --- | --- |
| `file <path>` | base and ours | Changing an upstream file. |
| `add <path>` | ours | A file upstream doesn't have. |
| `replace <path>` | ours | Our version wins outright, with no merge. For binaries and full rewrites. |
| `delete <path>` | nothing | A file or folder we don't want. |
| `move <from> -> <to>` | nothing | A file or folder at another path. |
| `copy <from> -> <to>` | nothing | Like move, keeping the original. |

Block entries are the paragraph-level form of `file`, and the better fit for prose. Each entry swaps one exact upstream paragraph for ours and carries its own intent. The format is wstack's current one: an entry is keyed by the paragraph's hash and stores the upstream text, the patched text, a kind (`translation`, `policy`, or `keep`), and the intent.

Changes store states, not diffs. This follows the changesets in [Anthropic's in-house source control](https://www.anthropic.com/engineering/redesigning-source-control), which in turn credits Meta's Mononoke: a changeset lists the changed files and points to their full contents, and diffs are computed when someone needs one (`patchbook show <name>`). Because a `file` edit keeps both base and ours, an upstream update is a 3-way merge with all three versions. A reworded or moved line still merges, where a stored diff would fail to apply. Recording intent per change follows Debian's patch headers ([DEP-3](https://dep-team.pages.debian.net/deps/dep3/)).

One owner per path: a path has at most one `file` edit or one set of block entries. If two intents need the same file, they share a change.

## Build

1. Stage upstream at the pin.
2. Apply content edits on upstream paths: block entries, then `file` edits in series order. A `file` edit whose base differs from the staged upstream file is **stale**, since sync should have merged it.
3. Apply structural edits in series order: add, replace, delete, move, copy.
4. Run the hooks: fill placeholders, then `finish(out)`.
5. Run the checks on the output.
6. Write the output: the configured folder (folder layout), or the repo root (fork).

The build fails on any problem and writes nothing. A build at an unchanged pin leaves `git status` clean.

## Checks

A check is a pattern the output must not contain, limited to some files:

```toml
[[check]]
name = "cursor-terms"
files = ["**/*.md"]
pattern = '\bCursor\b|\bTask\b|subagent_type'
```

A pattern is a JavaScript regular expression, compiled with the `u` flag. `\b` and `\w` are ASCII-only, so `\w` doesn't match `é`. Use `\p{L}` to match any letter.

An upstream block that matches a check and has no entry is **missing**. Output that matches is a **leak**. The `check` hook (below) covers anything a pattern can't express. wstack uses it to require `$name` beside `/name`, and each skill's `name` to equal its folder.

## Hooks

`.patchbook/hooks.ts` is optional project code. It exports functions named for the hooks below, and patchbook calls each one by name. The `Hooks` type in `src/api.ts` has their signatures. With patchbook installed from npm as a dev dependency, a hook file can check itself against it with `import type { Hooks } from "patchbook"`.

| Hook | Called | Returns |
| --- | --- | --- |
| `placeholder(kind, name)` | For each `{{kind:name}}` in the output, for a `kind` that has a `[placeholders.<kind>]` table. | The text to put there, or null to look it up in that table's `file`. |
| `blockTerms(path, block, outputs)` | For each upstream paragraph, with its output path and the set of all output paths. | Terms in the paragraph that need an entry, as if a `[[check]]` pattern had matched them. |
| `finish(out)` | After placeholders, before the checks. | Nothing. It changes `out`, a map from path to `{ data, mode }`, in place. |
| `check(outputs)` | After the `[[check]]` patterns. | A list of `{ problem: "check", file, detail }`. |

An export with any other name is an error, with a suggestion if the name is close to a hook (`blockterms` gets "did you mean `blockTerms`?"). Patchbook also checks what each hook returns, and fails with a message when it's the wrong shape.

Hooks run on Bun, inside the `patchbook` binary, so running one needs no separate Bun or Node install. A hook can import built-ins and the packages the repo has in `node_modules`, and no others.

Patchbook doesn't read a `hooks.py` from the Python version. It stops and asks you to port the file. The hooks keep their names, except `block_terms`, which is now `blockTerms`.

## Sync

- `patchbook check` compares each upstream's head with its pin. It exits 0 when all are up to date and 10 when any has moved, and prints JSON.
- `patchbook sync [name] [ref]` fetches each upstream (or the named one, at a ref) into the store, and updates its pin and its vendored copy, if it keeps one. Then it carries every change on that upstream's files forward:
  - **file edits**: `git merge-file` with base, ours, and the new upstream file. A clean merge updates ours and sets base to the new upstream file. A conflict leaves markers in ours and reports **conflict**. A file upstream deleted or moved reports **gone**, with likely new paths.
  - **block entries**: an entry whose paragraph changed reports **orphan**, with the nearest new paragraphs.
- `patchbook status [--json]` lists the problems, what sync merged on its own, and how much upstream changed in each file we touch.
- `patchbook record [change] [--intent ...]` takes the output files edited by hand since the last build (per `build.lock`) and moves each edit into the patchbook. In a file with block entries, each changed paragraph updates its entry, or gets a new `policy` entry; a new paragraph joins the one before it, and a paragraph put back as upstream had it loses its entry. Other edits become `file`, `add` or `delete` edits based on the pinned upstream. An edit to a file that a change already owns goes to that change. For the other edits, a model reads their diff and writes the intent if you didn't. Without a change name, the model also picks one: an existing change the edits serve, or a new name.
- A pre-commit hook does `record` and `build` on each commit, and stages what they change, so the usual loop is: edit, commit. The hook is a short script that runs `patchbook hook run` from `PATH`, so upgrading patchbook upgrades the hook. If `patchbook` isn't on `PATH`, it says so and lets the commit through. Every patchbook command installs it in its repo if it's missing, so a fresh clone gets it on first use, and `patchbook hook install` installs it by hand. It leaves another tool's pre-commit hook alone. If the patchbook has problems, it records but doesn't build. `PATCHBOOK_HOOK=0 git commit` skips it once, and `PATCHBOOK_INTENT="..."` gives the intent instead of the model.
- Intents are written by Claude Haiku 5.5 at medium effort through the `claude` CLI, or GPT-6-Luna at high effort through `codex`: Claude if it's installed, unless the settings choose.

## Settings

Each setting can be set in three places, and the most specific wins: an env var, for one command; the project's `.patchbook/config.toml`, shared with everyone who works on the repo; and the user's `~/.config/patchbook/config.toml`. `patchbook config` lists every setting, its value, and where the value came from. `patchbook config <name> <value>` sets one in the user config, `--project` sets it in the project's, and `--unset` removes it.

| Setting | Env var | Default |
| --- | --- | --- |
| `intent.provider` | `PATCHBOOK_PROVIDER` | `claude` if installed, otherwise `codex` |
| `intent.model` | `PATCHBOOK_MODEL` | the provider's |
| `intent.effort` | `PATCHBOOK_EFFORT` | the provider's |
| `hook.enabled` | `PATCHBOOK_HOOK` | `true` |
| `start.install_skill` | `PATCHBOOK_SKILL` | `true` |
| `start.agents` | | `["claude-code", "codex"]` |
| `store.path` (user only) | `PATCHBOOK_HOME` | `~/.local/share/patchbook` |

A model or effort set beside a different provider belongs to that provider, so it's skipped when another layer picks a different one.

Problem kinds: missing, orphan, conflict, gone, stale, invalid, placeholder, leak, check.

## The update skill

This repo ships a `patchbook-update` skill, built into the `patchbook` binary. `patchbook clone` and `init` write it to `.agents/skills/patchbook-update/`, which Codex reads, and link `.claude/skills/patchbook-update` to it for Claude Code (`start.agents` chooses the agents). In a fork, `clone` records it as the `patchbook-update-skill` change, since anything not upstream is a change. Each adapted repo has a daily T3 scheduled task that starts a fresh thread with "Use the patchbook-update skill." The skill:

1. Upgrades patchbook the way it was installed, if it can tell, then runs `patchbook check`. If no upstream has moved, it removes its worktree, archives the thread, and stops.
2. Works on the branch of the worktree T3 made for the thread, rebased onto `origin/main`. Runs `patchbook sync` and commits the sync on its own.
3. Resolves each problem from the change's intent and the repo's guide (`guide` in the config). One commit per change.
4. Builds, then runs the config's `test`, which is a command or an instruction file for the agent.
5. Starts a review in a fresh subagent on the same model. The reviewer gets each intent, the upstream change, and our result, and says per change whether the result meets the intent. At most two rounds.
6. Pushes its branch to `main`, runs the config's `deploy`, removes its worktree, and settles the thread with a short summary.

It stops and asks instead of merging when:

- upstream removed or reworked something an intent depends on;
- meeting an intent needs a choice the intents and the guide don't settle;
- the review rejects a change twice;
- a test fails and it can't fix it.

Then it opens a pull request without merging, keeps its worktree for the pull request, and leaves the thread in your inbox with the question.

## Config

wstack's, as an example:

```toml
layout = "folder"
guide = ".patchbook/patch.md"

[[upstream]]
name = "pstack"
remote = "https://github.com/cursor/plugins.git"
path = "pstack"
branch = "main"
mount = ""              # at the root of the staged tree

[output]
from = "skills"         # the staged folder that ships
to = "skills"

[placeholders.model]    # filled by hooks.ts from models.json

[placeholders.snippet]
file = ".patchbook/snippets.md"
format = "sections"

[[check]]
name = "cursor-terms"
files = ["**/*.md"]
pattern = '''...'''

[test]
instructions = ".patchbook/testing.md"

[deploy]
command = "tools/update-projects.sh"
```

## Tool

TypeScript on Bun, shipped as one compiled binary, `patchbook`. The binary carries the Bun runtime, so running it needs no Bun, Node, or package manager. It has no npm dependencies at run time.

It depends on git, which it uses for merges (`git merge-file`) and the store, and on the `claude` or `codex` CLI to write intents. A repo's `hooks.ts` runs on the binary's Bun.

`patchbook --version` prints the version. The release build sets it with `bun build --define`, and a build from source reports the `version` in `package.json`.

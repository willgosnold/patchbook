# Patchbook design

A patchbook holds your changes to someone else's repo, each with its intent, so you can keep pulling from upstream. A build applies the changes to a pinned upstream commit. When upstream moves, the tool reports which changes still apply and which broke, and an agent redoes each broken change from its intent. You are asked only when upstream makes an intent impossible or turns it into a real choice.

First user: [wstack](https://github.com/willgosnold/wstack), which rewrites Lauren Tan's pstack skills for T3 Code. Planned: a kiro-cli provider in a fork of T3 Code.

## Layouts

A repo uses one of two layouts.

- **vendor.** The repo holds a byte-for-byte copy of upstream in a folder, and the build writes its output to another folder. Use it when you ship something derived from upstream. wstack copies pstack into `vendor/pstack/` and builds `skills/`.
- **fork.** The repo is upstream plus a `patchbook/` folder. The build writes the patched tree over the repo root, leaving `patchbook/` and any paths the config marks as your own. Upstream's files in the tree are build output. To change them, edit them in place, then run `patchbook record` to move the edit into the patchbook.

## Files

```
patchbook/
  config.toml            upstream, layout, output, checks, test, deploy
  upstream.lock          the pinned commit and tree hash
  series                 change names, in the order the build applies them
  changes/<name>/
    CHANGE.md            the intent and the list of edits
    base/<path>.pb       the upstream file the change was made against
    ours/<path>.pb       our full version of that file
  blocks/<path>.entries  paragraph edits, for prose
  retired.md             changes dropped, and why
  hooks.py               optional project code: placeholders, custom checks, final steps
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
4. Run the hooks: fill placeholders, then `finish(output)`.
5. Run the checks on the output.
6. Write the output: the configured folder (vendor), or the repo root (fork).

The build fails on any problem and writes nothing. A build at an unchanged pin leaves `git status` clean.

## Checks

A check is a pattern the output must not contain, limited to some files:

```toml
[[check]]
name = "cursor-terms"
files = ["**/*.md"]
pattern = '\bCursor\b|\bTask\b|subagent_type'
```

An upstream block that matches a check and has no entry is **missing**. Output that matches is a **leak**. `hooks.py` can define `check(output)` for anything a pattern can't express. wstack uses it to require `$name` beside `/name`, and each skill's `name` to equal its folder.

## Sync

- `patchbook check` compares upstream's head with the pin. It exits 0 when up to date and 10 when upstream has moved, and prints JSON.
- `patchbook sync [ref]` fetches the ref and updates the pin and, in the vendor layout, the vendored copy. Then it carries every change forward:
  - **file edits**: `git merge-file` with base, ours, and the new upstream file. A clean merge updates ours and sets base to the new upstream file. A conflict leaves markers in ours and reports **conflict**. A file upstream deleted or moved reports **gone**, with likely new paths.
  - **block entries**: an entry whose paragraph changed reports **orphan**, with the nearest new paragraphs.
- `patchbook status [--json]` lists the problems, what sync merged on its own, and how much upstream changed in each file we touch.
- `patchbook record [change]` compares the working output with a fresh build and moves each difference into a change, as `file` or `add` edits based on the pinned upstream. A new change needs an intent.

Problem kinds: missing, orphan, conflict, gone, stale, invalid, placeholder, leak, check.

## The update skill

This repo ships a `patchbook-update` skill (`npx skills add willgosnold/patchbook`). Each adapted repo has a daily T3 scheduled task that starts a fresh thread with "Use the patchbook-update skill." The skill:

1. Runs `patchbook check`. If upstream hasn't moved, it archives the thread and stops.
2. Makes a branch, runs `patchbook sync`, and commits the sync on its own.
3. Resolves each problem from the change's intent and the repo's guide (`guide` in the config). One commit per change.
4. Builds, then runs the config's `test`, which is a command or an instruction file for the agent.
5. Starts a review in a fresh subagent on the same model. The reviewer gets each intent, the upstream change, and our result, and says per change whether the result meets the intent. At most two rounds.
6. Merges to the main branch, pushes, runs the config's `deploy`, and settles the thread with a short summary.

It stops and asks instead of merging when:

- upstream removed or reworked something an intent depends on;
- meeting an intent needs a choice the intents and the guide don't settle;
- the review rejects a change twice;
- a test fails and it can't fix it.

Then it opens a pull request without merging, and leaves the thread in your inbox with the question.

## Config

wstack's, as an example:

```toml
layout = "vendor"
guide = "patchbook/patch.md"

[upstream]
remote = "https://github.com/cursor/plugins.git"
path = "pstack"
branch = "main"
vendor = "vendor/pstack"

[output]
from = "skills"      # the staged folder that ships
to = "skills"

[placeholders]
model = { file = "models.json" }
snippet = { file = "patchbook/snippets.md" }

[[check]]
name = "cursor-terms"
files = ["**/*.md"]
pattern = '...'

[test]
instructions = "patchbook/testing.md"

[deploy]
command = "tools/update-projects.sh"
```

## Tool

One Python file, Python 3.11 or newer (for `tomllib`), plus git. No other dependencies. Install with `uv tool install git+ssh://git@github.com/willgosnold/patchbook`.

## Moving wstack onto it

- `patchbook/entries/` becomes `patchbook/blocks/`.
- The block entries on scripts (`check-plan.mjs`, `check-plan.test.ts`, `worktree-audit.sh`) become `file` edits.
- The four steps hardcoded in `tools/wstack.py` become config and edits:
  - the `pstack` support skill becomes `add skills/pstack/SKILL.md`, `move agents -> skills/pstack/agents`, and `copy LICENSE -> skills/pstack/LICENSE`;
  - the `name` renames become block entries;
  - the `.gitignore` files become `add` edits;
  - shipping only `skills/` becomes `[output]`.
- The Cursor-term list becomes a check, and the `/name` rule a hook.
- The sandbox checks become `patchbook/testing.md`.
- Updating projects becomes `tools/update-projects.sh`.

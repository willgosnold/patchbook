# Patchbook design

A patchbook holds your changes to someone else's repo, each with its intent, so you can keep pulling from upstream. A build applies the changes to a pinned upstream commit. When upstream moves, the tool reports which changes still apply and which broke, and an agent redoes each broken change from its intent. You are asked only when upstream makes an intent impossible or turns it into a real choice.

First user: [wstack](https://github.com/willgosnold/wstack), which rewrites Lauren Tan's pstack skills for T3 Code. Planned: a kiro-cli provider in a fork of T3 Code.

## Layouts

A repo uses one of two layouts.

- **folder.** The build writes its output to a folder of the repo. Use it when you ship something derived from upstream. wstack builds `skills/` from pstack. `[output] to` is rejected when it is the repo root, outside the repo, at or inside `.patchbook` or `.git`, a file, a link or under one (a link to the repo root included), or at or inside a vendor folder, and so is any output folder with a part at any depth that git reads as `.git`. That is `.git` in any letter case, or a name Windows or a Mac reads as `.git`, such as `.git.`, `.git `, `GIT~1`, or a name that is `.git` once the invisible characters a Mac ignores are taken out. git refuses to stage most of these names, and `git fsck` warns about all of them on every platform. A mount of `.git/x` or `GIT~1/x` is rejected the same way. A link above the repo (macOS `/var`) is allowed, and an absolute `to` is turned into its physical repo-relative folder when the config is read. A vendor folder inside `to` is allowed: the build leaves it alone. Only an edit under `from` is judged, since only those reach the output, so `copy skills/hello/SKILL.md -> .patchbook/config.toml` gives `no problems` and builds nothing. With `from = "skills"` and `to = "out"`, `skills/.patchbook/x.md` builds to `out/.patchbook/x.md`, while `skills/.git/x` is refused.
- **fork.** The repo is upstream plus a `.patchbook/` folder. The build writes the patched tree over the repo root, leaving `.patchbook/` and any vendored copies alone. A vendored copy must match upstream exactly, so no build output may land in one. A config is rejected when a vendor folder is, holds, or sits inside the folder its own upstream builds into (for the root upstream, the whole repo), or holds another upstream's output folder, and so is a vendor folder that equals, holds or sits inside another upstream's vendor folder, and a mount at or inside `.patchbook`, or with a part git reads as `.git`, as in the folder layout. A mount is normalised when the config is read, so `./lib` and `x/../lib` mean `lib`, and a mount that is absolute or climbs out with `..` is rejected. `track` and `init` check this before they write the config. A vendor folder inside another upstream's folder is allowed: the build, `check` and `sync` leave that upstream's files out of it, and say how many once per command. A change that adds, copies or moves a file into a vendored copy, into the repo's own `.patchbook` in any letter case, or to a path with a part git reads as `.git` (the rule for mounts) is reported `invalid`. A `.patchbook` or `.git` destination makes the build refuse it and the hook refuse the commit, and a vendored-copy destination makes the build refuse it while the hook warns and commits. Both layouts judge an edit by where its file lands, and in the folder layout only an edit under `from` lands anywhere. A `./.patchbook/x` or `.//.patchbook/x` spelling is not matched by this rule either. It is an unsafe edit path (see Trust), so `status` reports it as `invalid` and the hook refuses the commit with the unsafe-path message. If the root upstream has a `.patchbook/` of its own, `clone` removes it, and the build leaves it out. `check` and `sync` leave it out of the files they report and carry. An upstream mounted at a folder keeps its `.patchbook/` as ordinary files, in the build, in `check` and `sync`, and in a vendored copy. Patchbook never reads upstream's config, so a folder upstream vendors for itself is built like any other. Upstream's files in the tree are build output. To change them, edit them in place, then run `patchbook record` to move the edit into the patchbook.

## Several upstreams

A patchbook can follow any number of upstreams. Each has a name and a mount, the folder of the staged tree its files appear under. One upstream may mount at the root. In a fork, that is the fork's own upstream. Every path in an edit, a block entry, or a check is a staged path, so `move extra/skills/tool -> skills/tool` ships one skill from an upstream mounted at `extra`.

`patchbook track <name> <url>` follows another upstream. `check` reports each one, and `sync` moves every pin, or one with `sync <name>`.

## The upstream store

A repo holds only what it changed. Each upstream lives once per user, in the store (`~/.local/share/patchbook/upstreams/`, or `$PATCHBOOK_HOME/upstreams/`), as a git repo with each pinned commit fetched and referenced, so `git gc` keeps it. A commit that `check` only looks at gets no reference and gc prunes it. `check` references the pin when the store has it and never fetches it just for that. A read of a pin that cannot write its reference, such as one in a read-only store, warns and goes on. `sync` keeps the new commit before it rewrites the vendored copy, so a reference it cannot write fails it with the copy as it was, and any failure after that removes the reference again, unless the commit was kept before, so no reference is left for a commit that did not become the pin. A failure after the copy is rewritten, such as a vendored copy that does not hash to upstream's tree or a change file that cannot be written, can leave the copy out of step with `upstream.lock` until a retried `sync` succeeds (issue #45). Every repo that follows the same upstream shares it.

A fork's own upstream lives in the fork's repo instead. A sync doesn't put the new pin in the fork's history, so each pin is fetched into the repo from the upstream's `remote` and referenced under `refs/pins/`. A push leaves those references out, so each clone of the fork fetches the pin the first time a command needs it, which needs read access to upstream. A clone that has a pin keeps it if upstream goes away. A new clone can't build once upstream deletes the pinned commit, and a fork can't keep a vendored copy of its own upstream.

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

## Trust

`.patchbook/hooks.ts` runs on every command that opens the book, including `status`, `check` and the pre-commit hook. `--version`, `--help` and `hook install` don't open it. Nothing sandboxes it. Anyone who can change the book repo itself, through a pull request, a merge or a pull, runs code on your machine at your next command. Patchbook itself never reads upstream's `.patchbook/`. `clone` removes it, and the build, `check` and `sync` ignore it. A `git pull` or merge from upstream does bring it in, and its `hooks.ts` then runs at your next command, so review it as you would code. Read a change to `hooks.ts` as you would a change to a build script, and before you run any command in a repo you just fetched.

The rest of `.patchbook/` is data, and patchbook checks the names and paths in it by how they are spelled.

- **Change names.** One rule applies wherever a name is made or read: `[a-z0-9][a-z0-9-]*`. `record <name>`, a name a model chooses, a line of `series`, a folder of `changes/` and the name `show` is given all follow it, and an empty name given to `record` means no name. A name in `series`, or a folder in `changes/` that has a `CHANGE.md`, that breaks the rule is reported as `invalid` and not read, and `show` says there is no such change. `record` refuses before it writes anything while such a name is in the book. There is no compatibility rule for older names. Rename a bad one to lowercase letters, digits and dashes, in `series` and in `changes/`.
- **Edit paths.** A path in an edit of a `CHANGE.md` must be a clean path inside the tree. An absolute path, or one with an empty, `.` or `..` segment (`./x`, `a//b`, `a/../b`), is reported as `invalid`, so `status`, `build` and the hook all see it, and the edit is not applied. A trailing slash is ignored, so `add new.md//` is read as `new.md`. A command that rewrites a `CHANGE.md` keeps such a line as written.
- **The hook.** A bad change name or an unsafe edit path makes the pre-commit hook refuse the commit, before it records, builds or stages anything. The working tree, the index and `.patchbook/` stay as they were, so a hand edit in the output is not lost. The refusal names the problem and how to fix it, and `PATCHBOOK_HOOK=0` skips the hook once. Any other problem that `status` reports only skips the build, with a warning. The build's own safety checks still stop a commit. A change whose file really goes outside the output through a link makes the hook fail and leaves everything as it was, while `status` reports no problems.
- **Block entries.** Their file names come from the files under `blocks/`, so they can't be spelled with such a path.

Patchbook does not check for links inside `.patchbook/`. A link in `blocks/` is read and written through, and a link at `changes/<name>/ours` is copied into the output as a link by `build`, while `show` reports the length of the link's target path, not the size of the file it points to. A link there can make patchbook read or write outside the repo. Issue #93 tracks links inside `.patchbook/`. This is why a change to `.patchbook/` needs the same review as a change to `hooks.ts`.

## Sync

- `patchbook check` compares each upstream's head with its pin. It exits 0 when all are up to date and 10 when any has moved, and prints JSON.
- `patchbook sync [name] [ref]` fetches each upstream (or the named one, at a ref) into the store, and updates its pin and its vendored copy, if it keeps one. Then it carries every change on that upstream's files forward:
  - **file edits**: `git merge-file` with base, ours, and the new upstream file. A clean merge updates ours and sets base to the new upstream file. A conflict leaves markers in ours and reports **conflict**. A file upstream deleted or moved reports **gone**, with likely new paths.
  - **block entries**: an entry whose paragraph changed reports **orphan**, with the nearest new paragraphs.
- `patchbook status [--json]` lists the problems, what sync merged on its own, and how much upstream changed in each file we touch.
- `patchbook record [change] [--intent ...]` takes the output files edited by hand since the last build (per `build.lock`) and moves each edit into the patchbook. In a file with block entries, each changed paragraph updates its entry, or gets a new `policy` entry; a new paragraph joins the one before it, and a paragraph put back as upstream had it loses its entry. Other edits become `file`, `add` or `delete` edits based on the pinned upstream. An edit to a file that a change already owns goes to that change. For the other edits, a model reads their diff and writes the intent if you didn't. Without a change name, the model also picks one: an existing change the edits serve, or a new name. If you give an intent but no name, the model isn't called: the change is named from the intent's first four words, dropping any that would take the name past 40 characters. Any intent is kept on one line, with each run of whitespace a single space, and a blank intent counts as none.
- A pre-commit hook does `record` and `build` on each commit, and stages what they change, so the usual loop is: edit, commit. The hook is a short script that runs `patchbook hook run` from `PATH`, so upgrading patchbook upgrades the hook. If `patchbook` isn't on `PATH`, it says so and lets the commit through. Every patchbook command installs it in its repo if it's missing, so a fresh clone gets it on first use, and `patchbook hook install` installs it by hand. It leaves another tool's pre-commit hook alone. If the patchbook has problems, it records but doesn't build, and says so. Three things are the exception. They are a change whose output lands in `.patchbook` or at a part git reads as `.git`, an edit path that isn't a clean path inside the tree, and a change name outside `[a-z0-9][a-z0-9-]*`. The hook refuses the commit before it records, builds or stages anything, and names the problem. It does the same for a new file you add by hand in the output at a path that lands in `.patchbook` in another letter case, or at a part git reads as `.git`, such as `.PATCHBOOK/x.md` on a case-sensitive filesystem or `a/.GIT/y`. The book's own `.patchbook/` folder is the book, not output, and commits normally. Any other problem that `status` reports, a destination in a vendored copy included, only skips the build with a warning. The build's own safety checks still stop a commit. A change whose file really goes outside the output through a link makes the hook fail and leaves everything as it was, while `status` reports no problems. `PATCHBOOK_HOOK=0 git commit` skips it once, and `PATCHBOOK_INTENT="..."` gives the intent instead of the model.
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

This repo ships a `patchbook-update` skill, built into the `patchbook` binary. `patchbook clone` and `init` write it to `.agents/skills/patchbook-update/`, which Codex reads, and link `.claude/skills/patchbook-update` to it for Claude Code (`start.agents` chooses the agents). In a fork, `clone` and `init` record it as the `patchbook-update-skill` change, since anything not upstream is a change. `patchbook skill install` writes this binary's copy into an existing repo, and in a fork records it in the same change, leaving any other waiting edits for `patchbook record`. It refuses to replace a skill file or link that differs from the shipped copy unless HEAD holds the same bytes up to `\r\n` line endings, in a file with no NUL byte, so a customization is committed first. A file may differ from HEAD's blob only in line endings (`\r\n` against `\n`), which covers `eol` and every `core.autocrlf` mode, and a link's target must match exactly. No git conversion runs in the comparison, so a path whose clean filter or `working-tree-encoding` rewrites bytes other than line endings is refused even when committed, and a filter cannot hide disk text from it. An uncommitted edit, an untracked or ignored file HEAD lacks, and an edit hidden with `--skip-worktree` or `--assume-unchanged` are all refused. A file HEAD holds with the same content is kept even when git ignores it. When a path is refused, `clone` and `init` write nothing at any skill path and finish with a note instead of an error. It never writes through a symlink on the way to a skill path, and refuses when one is there, except a `.claude/skills` link to `.agents/skills`, which already is the skill folder. Each adapted repo has a daily T3 scheduled task that starts a fresh thread with "Use the patchbook-update skill." The skill:

1. Upgrades patchbook the way it was installed, if it can tell, then runs `patchbook check`. If no upstream has moved, it removes its worktree, archives the thread, and stops.
2. Works on the branch of the worktree T3 made for the thread, rebased onto `origin/main`. Runs `patchbook sync`, asks before any commit if it fails, ends the run as step 1 does if it pinned nothing, and commits the sync on its own. From then on it reads only the reports of the upstreams `patchbook sync` pinned, which can include one that moved after `patchbook check`. It takes only the problems from `patchbook status --json`, not its copy of the reports, and uses `patchbook upstream --diff` only for an upstream the sync pinned. Every commit it makes skips the pre-commit hook (`PATCHBOOK_HOOK=0`), since in a fork the hook records unstaged and untracked files and hand edits to the output into whatever commit runs.
3. Resolves each problem from the change's intent and the repo's guide (`guide` in the config). One commit per change.
4. Deletes scratch files it or a test wrote, and asks if a file in the output or a vendored copy was edited by hand. Then commits each other change left in the worktree on its own, never `.patchbook/last-sync.json`, or asks if it can't tell what one is. Builds, the run's only build, and commits what the build wrote. Then runs the `test` from the config on `origin/main`, which is a command or an instruction file for the agent, and asks if it can't read that file there. After each test run it deletes every untracked file that isn't ignored, except `.patchbook/last-sync.json`, since only the test can have left one. It makes at most two attempts to fix a failing test, each changing what the test checks, never the test, its scripts or its fixtures. It commits each test fix on its own, then builds and tests again.
5. Starts a review in a fresh subagent, on another provider's model when T3 can run one, otherwise on the same model. The reviewer gets each intent, the upstream change, and our result, and says per change whether the result meets the intent, and once whether upstream added anything that should have been handled. A change or question with no verdict counts as a fail. It waits up to an hour for the verdict before step 6, and a review that times out or stops on a question counts as a fail. Such a fail finds nothing to fix, so it commits nothing before the next round. It commits each review fix on its own, then builds and tests again. At most two rounds.
6. If, on the commit it pushes, `patchbook status` and `patchbook build` exit 0 and `git status --porcelain --untracked-files=no` prints nothing after the build, and the sync was clean or the test command on `origin/main` exited 0, pushes its branch to `main`, runs the config's `deploy`, removes its worktree, and settles the thread with a short summary. The sync was clean when the report of each upstream `patchbook sync` pinned has an empty `replaced_upstream_changed`, step 3 found nothing to handle, nothing came after the sync commit but files the build wrote, and the rebase brought in no commits.

It stops and asks instead of merging when:

- the condition in step 6 doesn't hold;
- `patchbook sync` fails;
- upstream removed or reworked something an intent depends on, and retiring the change would lose something the user wanted;
- meeting an intent needs a choice the intents and the guide don't settle;
- the second review round returns any fail;
- a test fails and it can't fix it, an instruction-file test included, or it can't read the instruction file on `origin/main`;
- a test leaves tracked files changed, even if it passed;
- step 4 finds a hand edit to the output or a vendored copy;
- a `replaced_upstream_changed` entry in the report of an upstream `patchbook sync` pinned has no step 3 commit that names its file;
- the branch changes the config's `test`;
- the only fix for a failing test changes the test, its scripts or its fixtures;
- the final rebase fails, which it aborts.

Then it keeps its worktree, opens a pull request without merging if it has committed anything, and leaves the thread in your inbox with the question.

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

TypeScript on Bun, shipped as one compiled binary, `patchbook`. The binary carries the Bun runtime, and `bun build --compile` bundles the npm dependencies into it, so running it needs no Bun, Node, or package manager.

It depends on git, which it uses for merges (`git merge-file`) and the store, and on the `claude` or `codex` CLI to write intents. A repo's `hooks.ts` runs on the binary's Bun.

`patchbook --version` prints the version. The release build sets it with `bun build --define`, and a build from source reports the `version` in `package.json`.

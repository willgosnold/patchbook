# Patchbook design

A patchbook holds your changes to someone else's repo, each with its intent, so you can keep pulling from upstream. A build applies the changes to a pinned upstream commit. When upstream moves, the tool reports which changes still apply and which broke, and an agent redoes each broken change from its intent. You are asked only when upstream makes an intent impossible or turns it into a real choice.

First user: [wstack](https://github.com/willgosnold/wstack), which rewrites Lauren Tan's pstack skills for T3 Code. Planned: a kiro-cli provider in a fork of T3 Code.

## Layouts

A repo uses one of two layouts.

- **folder.** The build writes its output to a folder of the repo. Use it when you ship something derived from upstream. wstack builds `skills/` from pstack. `[output] to` is rejected when it is the repo root, outside the repo, at or inside `.patchbook` (in any letter case, or with the trailing dots and spaces Windows drops, as in `.PATCHBOOK` or `.patchbook.`) or `.git`, a file, a link or under one (a link to the repo root included), or at or inside a vendor folder, and so is any output folder with a part at any depth that git reads as `.git`. That is `.git` in any letter case, or a name Windows or a Mac reads as `.git`, such as `.git.`, `.git `, `GIT~1`, or a name that is `.git` once the invisible characters a Mac ignores are taken out. git refuses to stage most of these names, and `git fsck` warns about all of them on every platform. A mount of `.git/x` or `GIT~1/x` is rejected the same way. A link above the repo (macOS `/var`) is allowed, and an absolute `to` is turned into its physical repo-relative folder when the config is read. A vendored copy must match upstream exactly, so no build output may land in one. A config is rejected when a vendor folder is, holds, or sits inside the folder its own upstream builds into (for the root upstream, all of `to`), or holds another upstream's output folder, and so is a vendor folder that equals, holds or sits inside another upstream's vendor folder. `init --output-from skills --output-to skills --vendor skills/vendored` is refused for that reason, and `track` and `init` check this before they write the config. A vendor folder inside another upstream's output folder is allowed, such as a tracked upstream's copy inside the root upstream's `to`: the build, `check` and `sync` leave the files of the upstream that builds there out of it, say how many once per command, and the copy stays as the pin has it through a build and a hook commit. Only an edit under `from` is judged, since only those reach the output, so `copy skills/hello/SKILL.md -> .patchbook/config.toml` gives `no problems` and builds nothing. With `from = "skills"` and `to = "out"`, `skills/.patchbook/x.md` builds to `out/.patchbook/x.md`, while `skills/.git/x` is refused.
- **fork.** The repo is upstream plus a `.patchbook/` folder. The build writes the patched tree over the repo root, leaving `.patchbook/` and any vendored copies alone. A vendored copy must match upstream exactly, so no build output may land in one. A config is rejected when a vendor folder is, holds, or sits inside the folder its own upstream builds into (for the root upstream, the whole repo), or holds another upstream's output folder, and so is a vendor folder that equals, holds or sits inside another upstream's vendor folder, and a mount at or inside `.patchbook`, or with a part git reads as `.git`, as in the folder layout. A mount is normalised when the config is read, so `./lib` and `x/../lib` mean `lib`, and a mount that is absolute or climbs out with `..` is rejected. `track` and `init` check this before they write the config. `init --vendor` is refused in the fork layout, because the root upstream builds into the whole repo and no vendor folder can pass these checks. Use `track --vendor` for another upstream. A vendor folder inside another upstream's folder is allowed: the build, `check` and `sync` leave that upstream's files out of it, and say how many once per command. A change that adds, copies or moves a file into a vendored copy, into the repo's own `.patchbook` in any letter case or with trailing dots or spaces, or to a path with a part git reads as `.git` (the rule for mounts) is reported `invalid`. A `.patchbook` or `.git` destination makes the build refuse it and the hook refuse the commit, and a vendored-copy destination makes the build refuse it while the hook warns and commits. Both layouts judge an edit by where its file lands, and in the folder layout only an edit under `from` lands anywhere. A `./.patchbook/x` or `.//.patchbook/x` spelling is not matched by this rule either. It is an unsafe edit path (see Trust), so `status` reports it as `invalid` and the hook refuses the commit with the unsafe-path message. If the root upstream has a `.patchbook/` of its own, `clone` removes it, and the build leaves it out. `check` and `sync` leave it out of the files they report and carry. An upstream with a folder that only reads as it on macOS and Windows (`.PATCHBOOK/`, `.patchbook./`, `.patchbook /`) is refused: `clone`, `init`, `sync`, `check` and the build stop and name the upstream path, since on those systems that folder is the fork's own `.patchbook/`, and on others the patchbook can't carry it. `clone` and `init` write nothing, and `sync` moves no pin. `record` and the hook refuse a hand edit under such a folder too, naming the path, so a file there is never dropped without a word. An upstream mounted at a folder keeps its `.patchbook/` as ordinary files, in the build, in `check` and `sync`, and in a vendored copy. Patchbook never reads upstream's config, so a folder upstream vendors for itself is built like any other. Upstream's files in the tree are build output. To change them, edit them in place, then run `patchbook record` to move the edit into the patchbook.

## Several upstreams

A patchbook can follow any number of upstreams. Each has a name and a mount, the folder of the staged tree its files appear under. One upstream may mount at the root. In a fork, that is the fork's own upstream. Every path in an edit, a block entry, or a check is a staged path, so `move extra/skills/tool -> skills/tool` ships one skill from an upstream mounted at `extra`.

`patchbook track <name> <url>` follows another upstream. `check` reports each one, and `sync` moves every pin, or one with `sync <name>`.

## The upstream store

A repo holds only what it changed. Each upstream lives once per user, in the store (`~/.local/share/patchbook/upstreams/`, or `$PATCHBOOK_HOME/upstreams/`), as a git repo with each pinned commit fetched and referenced, so `git gc` keeps it. A commit that `check` only looks at gets no reference and gc prunes it. `check` references the pin when the store has it and never fetches it just for that. A read of a pin that cannot write its reference, such as one in a read-only store, warns and goes on. `sync` keeps the new commit before it rewrites the vendored copy, so a reference it cannot write fails it with the copy as it was, and any failure after that removes the reference again, unless the commit was kept before, so no reference is left for a commit that did not become the pin. A sync that fails, such as one whose new vendored copy does not hash to upstream's tree or one that cannot write a change file, leaves the vendored copy, the change files, `last-sync.json` and `upstream.lock` as they were, and removes any folder it made for a first vendored copy. It moves the old copy into `.patchbook/sync-<name>/`, which git ignores, with each file it will write over, checks the new copy where it will stay, and writes the lock last. A sync that is killed leaves that folder behind. The next `sync` or `track` first finishes or undoes every upstream's folder, since each one saves `last-sync.json`, and a folder it can do neither with stops it and is left for the user. Once a sync is finished or undone, deleting its folder is best effort. A part it can't delete, such as a read-only folder in the old copy, moves into `left/` inside the folder, where git still ignores it and the next sync does not trip over it. While the upstream is tracked, every later `sync` or `track` tries the delete again, and each `sync` of that upstream warns until it is gone. A part it can neither delete nor move would be taken for the next sync's own, so a sync of that upstream with something to write stops before it starts and names the part. Every repo that follows the same upstream shares it.

A fork's own upstream lives in the fork's repo instead. A sync doesn't put the new pin in the fork's history, so each pin is fetched into the repo from the upstream's `remote` and referenced under `refs/pins/`. A push leaves those references out, so each clone of the fork fetches the pin the first time a command needs it, which needs read access to upstream. A clone that has a pin keeps it if upstream goes away. A new clone can't build once upstream deletes the pinned commit, and a fork can't keep a vendored copy of its own upstream.

The store is data, not a cache: it is the only local copy of the unchanged upstream files. If it is lost, the tool fetches each pin again by commit. That fails only if upstream deleted the commit, which is the case for keeping a vendored copy: set `vendor = "<folder>"` on an upstream, and sync keeps a byte-for-byte copy in the repo, which the build checks against the pin. Every sync replaces that folder, so a config is rejected when the vendor folder is the repo root, is outside the repo (`..`, a sibling, an absolute path elsewhere, or a path behind a link that leads out or leads nowhere), or is at or inside `.patchbook` in any letter case, or has a part git reads as `.git`. It is also refused when the folder holds a `.git` anywhere inside it, under any name git reads as `.git` and as a file or a folder, such as a repo of its own or a linked worktree. `git mktree` can store a `.git` in an upstream tree, so `track` and `sync` first refuse an upstream with a path that has a part git reads as `.git`, whether or not it has a vendor folder (Trust says what an upstream without one gets). The message names the upstream and the path, and the refusal comes before the journal and before any write, so no sync is left half done and other upstreams keep syncing. Past that, patchbook treats any `.git` in the copy as the user's, and a sync would move it away and delete it. A folder in the copy that the check can't list is refused too, by name, since it might hold one. The message says to make it readable, move it out of the folder, or change `vendor`. `init` and `track` check all of this before they write the config, and `sync` checks the folder at the start, so a refusal writes and moves nothing for that upstream. `sync` with no name pins the upstreams before the refused one first. Only those three check for a `.git`. `status` and `build` fail on a nested repo with no commit with git's own error. With a commit they crash with `EISDIR` at `readDisk`, as they did before this check. A killed sync's folder that names such a vendor folder is left for the user, never deleted or renamed onto, and so is one whose vendor folder now holds a `.git` or a folder that can't be listed, because finishing the sync would delete it. The message says to move the `.git` out and sync again. Recovery trusts a killed sync's record only for a vendor folder that passes the config's own vendor rules and is the one `config.toml` sets for that upstream, since it deletes and rewrites the folder the record names; any other folder leaves the sync where it is, with nothing changed, and the message names the record's folder and the config's. Recovery refuses the same way, and names the part, when a journal left on disk holds anything in `before/` but saved change files and the report, is itself a link that leads out, or would have recovery read its `pin`, `lock`, `before/` or report, or write a file back, through a path that leads outside the repo or into `.git`, so a killed sync whose `upstream.lock`, `last-sync.json` or `.patchbook/changes` is a link out of the repo is now left for the user, while a sync that fails as it runs still puts back its own journal. `sync` checks again right before it takes the copy, and once more in `old/` after the copy moved there. A repo found in `old/` goes back with the copy, the sync leaves no journal and no pin change, and it refuses with the same message. Recovery checks again directly before it deletes the copy, and when that refuses the journal stays. What is left is the gap between a check and the filesystem call that follows it, with no git call between. A `.git` made in that gap is still lost. A copy that is empty or missing fails that check with a message that names `sync` and the `vendor` line of the config. So does a copy that is a file or a link, and one that a `.gitignore` rule hides whole, where the message names the rule. The pre-commit hook replaces whatever the index holds under the vendor folder with the pin's tree, such as the removal left by `git mv`, what a killed `sync` staged, or a file at the vendor path. The pin is the one the `upstream.lock` in the index names, read through a staged link as the build reads it. A `sync` that was not staged leaves `upstream.lock` with changes that aren't in the commit, so the hook stops the commit and the new copy never reaches it. If the index holds no lock, or none for that upstream, the hook leaves that folder alone. The hook takes the copy from the pin and never reads the working tree to stage, so a commit that runs the pre-commit hook never records a vendored copy that differs from the pin. `git merge` and a `git cherry-pick` without `-n` do not run that hook. The hook touches nothing outside the folder, except that in the folder layout a file staged at a parent of the folder, such as `vendor` for `vendor/extra`, gives way to the copy. In the fork layout the copy takes that file's place too, but the hook first records the file as a hand edit, as it does any staged output file, so the next `build` refuses to write it over the folder. The hook puts the pinned copy back into the index, so `git rm --cached -r` on it is undone, and it says so: for each upstream whose folder it changes, it prints a line on stderr that names the folder and says the hook staged the pinned copy in place of what the index held. When that leaves nothing to commit, because the index matched HEAD after the replacement and did not before it, the hook refuses the commit with exit 1, leaves the index as it was and says so, since git decided the commit was not empty before the hook ran. For a staged removal of the copy, the refusal says to delete the upstream's `vendor` line to stop vendoring it. `git commit --allow-empty` on an index that already matched HEAD is not refused, and with a staged removal of the copy it is refused like any other commit. Before it changes the index, the hook checks that each pin tree is in the repo. When one is missing, or the `upstream.lock` in the index can't be parsed, it refuses with exit 1 and a message that names the vendor folder and the tree, or the lock, and leaves the index alone. Any other failure in the step puts the index back as it was. The hook skips this step only in a partial commit, where `git commit <path>` runs it on `next-index-<pid>.lock` in the git dir, so that commit records only that path. Any other index file, such as one set with `GIT_INDEX_FILE`, gets the same replacement as the default index.

`patchbook upstream <name>` reads an upstream at its pin. It lists the files, prints one (`upstream <name> <path>`), writes them all to a folder (`--export <dir>`), or shows what upstream changed in the last sync (`--diff`). It takes at most one of `--diff`, `--since` and `--export`, and `--export` takes no `<path>`. `--export` writes the files as upstream has them, so it first refuses an upstream with a path that has a part git reads as `.git` (the message is Trust's, ending "so it can't be exported into <dir>"), and refuses a `<dir>` that already exists and isn't empty, a file or the repo root included, so it never writes over a file. Both refusals come before any write, with exit 1. A new or empty folder works.

## Files

```
patchbook/
  config.toml            upstreams, layout, output, checks, test, deploy
  upstream.lock          each upstream's pinned commit and tree hash
  build.lock             each built file's mode and blob id, as of the last build
  series                 change names, in the order the build applies them
  changes/<name>/
    CHANGE.md            the intent and the list of edits
    base/<path>.pb       the upstream file the change was made against
    ours/<path>.pb       our full version of that file
  blocks/<path>.entries  paragraph edits, for prose
  retired.md             changes dropped, and why
  last-sync.json         the last sync's report for each upstream; ignored by git, so it stays in the checkout that synced (see Sync)
  .gitignore             written by `sync`: ignores `last-sync.json` and itself, so it is never untracked either
  sync-<name>/           ignored by git: what a sync writes over, so a failed or killed sync is undone; a kill or a failed delete leaves it for a later sync (see The upstream store)
  hooks.ts               optional project code: placeholders, custom checks, final steps
```

`build.lock` has one line for each built file, `<mode> <blob id> <path>`, with git's own mode names (`100644`, `100755`, `120000`). A file is a hand edit when its content differs from its line, or its mode does and the bit is yours (see [The executable bit](#the-executable-bit)). A line with no mode, from a lock written before modes were kept, stands for the mode the build writes for that path, and the next build rewrites the lock.

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

A file can hold the same paragraph more than once. An entry headed `=== entry <hash> 2 of 3 between <span>` patches only the second of three identical paragraphs. `<span>` hashes the paragraphs from the identical one before it, or the file's start, to the identical one after it, or the file's end. `blocks` shows that key for a repeated paragraph. An entry with no occurrence patches every paragraph with that text that has no entry of its own, so an entries file from before occurrences builds as it did. `record` writes an occurrence entry when you edit one of several identical paragraphs, and `scaffold` writes one plain entry for each distinct paragraph. If upstream changes the number of identical paragraphs, each occurrence entry for that text reports orphan. So does one whose span upstream changes, as when it moves one of the identical paragraphs, so an entry never patches a paragraph other than the one it was recorded on. A block's hash and text leave out the CR at the end of each line. Patchbook reads an entries file back without CRs, so entries for a CRLF file match. A patched block keeps the line ends of the block it replaces. A CRLF file's frontmatter is a block only when every line of it ends in CR.

Changes store states, not diffs. This follows the changesets in [Anthropic's in-house source control](https://www.anthropic.com/engineering/redesigning-source-control), which in turn credits Meta's Mononoke: a changeset lists the changed files and points to their full contents, and diffs are computed when someone needs one (`patchbook show <name>`). Because a `file` edit keeps both base and ours, an upstream update is a 3-way merge with all three versions. A reworded or moved line still merges, where a stored diff would fail to apply. Recording intent per change follows Debian's patch headers ([DEP-3](https://dep-team.pages.debian.net/deps/dep3/)).

One owner per path: a path has at most one `file` edit or one set of block entries. If two intents need the same file, they share a change.

### The executable bit

A change's `.pb` copy holds the mode its output builds with. An output built from a copy follows upstream's mode when upstream has the path, and takes the copy's mode when it doesn't (an `add`) or once the copy's mode differs from its `base` copy's. So a copy whose mode differs from upstream's gets a `base` copy at upstream's mode. A book from before modes were kept has no such `base` copy on a `replace`, and `base` and `ours` copies of a `file` edit both at 644, so it builds as it did.

`record`, the pre-commit hook and `hook install` record an output's mode by one rule: the bit is yours when git would commit it as you set it. Under `core.fileMode=true` every bit is. Under `false`, only an index mode that `git add` alone wouldn't give is: one that differs from HEAD's, or from 644 for a new path, as `git update-index --chmod` stages. A read of the working tree takes the index's mode, as `git add -A` would. A bit that isn't yours stands for the build's mode: it is never recorded and never makes a hand edit. A link, or a change between a link and a file, is always yours.

Under `core.fileMode=false`, `git add` keeps an entry's mode and gives a new one 644, so the hook stages the modes the patchbook decided, keeping each entry's bytes. They are the modes of the copies it wrote, of the copy behind each output whose bit you chose in the commit, and of the outputs whose mode comes from upstream. `build --commit` stages the last kind too. Neither takes a mode from a copy it only read back from disk, so a checkout without an executable bit keeps the index's modes. Under `false` a new path can't be recorded as 644 against a 755 build, since git gives it 644 either way. That needs `core.fileMode=true`.

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
| `blockTerms(path, block, outputs)` | For each upstream paragraph, with its output path and the set of all output paths. | An array, or another iterable, of the terms in the paragraph that need an entry, as if a `[[check]]` pattern had matched them. A string is refused, not read as its characters. |
| `finish(out)` | After placeholders, before the checks. | Nothing. It changes `out`, a map from path to `{ data, mode }`, in place. |
| `check(outputs)` | After the `[[check]]` patterns. | A list of `{ problem: "check", file, detail }`. |

An export with any other name is an error, with a suggestion if the name is close to a hook (`blockterms` gets "did you mean `blockTerms`?"). Patchbook also checks what each hook returns, and fails with a message when it's the wrong shape.

Hooks run on Bun, inside the `patchbook` binary, so running one needs no separate Bun or Node install. A hook can import built-ins and the packages the repo has in `node_modules`, and no others. Patchbook reads `hooks.ts` and no other hooks file. A `hooks.js` in `.patchbook/` is a file it doesn't know about, and `init` and `status` go on without it.

## Trust

`.patchbook/hooks.ts` runs on every command that opens the book, including `status`, `check` and the pre-commit hook. `--version`, `--help` and `hook install` don't open it. Nothing sandboxes it. Anyone who can change the book repo itself, through a pull request, a merge or a pull, runs code on your machine at your next command. Patchbook itself never reads upstream's `.patchbook/`. `clone` removes it, and the build, `check` and `sync` ignore it. A `git pull` or merge from upstream does bring it in, and its `hooks.ts` then runs at your next command, so review it as you would code. Read a change to `hooks.ts` as you would a change to a build script, and before you run any command in a repo you just fetched.

The rest of `.patchbook/` is data, and patchbook checks the names and paths in it by how they are spelled.

- **Change names.** One rule applies wherever a name is made or read: `[a-z0-9][a-z0-9-]*`. `record <name>`, a name a model chooses, a line of `series`, a folder of `changes/` and the name `show` is given all follow it, and an empty name given to `record` means no name. A name in `series`, or a folder in `changes/` that has a `CHANGE.md`, that breaks the rule is reported as `invalid` and not read, and `show` says there is no such change. `record` refuses before it writes anything while such a name is in the book. There is no compatibility rule for older names. Rename a bad one to lowercase letters, digits and dashes, in `series` and in `changes/`.
- **Edit paths.** A path in an edit of a `CHANGE.md` must be a clean path inside the tree. An absolute path, one with an empty, `.` or `..` segment (`./x`, `a//b`, `a/../b`), one that ends in a slash (`new.md/`) or one with a backslash is reported as `invalid`, so `status`, `build` and the hook all see it, and the edit is not applied. A command that rewrites a `CHANGE.md` keeps such a line as written.
- **Vendor folders.** Every sync replaces the folder a `vendor` line names, so a config is rejected when that folder is the repo root, is outside the repo, is in `.patchbook` in any letter case or has a part git reads as `.git`, and `init`, `track` and `sync` also refuse one that holds a `.git` or a folder they can't list (see The upstream store). They also refuse one that holds a file that isn't upstream's, and name it: `init` and `track` refuse any file of the folder that isn't byte for byte a file of the tree they pin, and `sync` any file at a path the pinned tree doesn't have, one that git ignores included, so a replace never deletes the user's files. A regular file at the vendor path is the user's too, so `sync` refuses it as `track` does. Undoing a killed sync refuses a file in the copy that the killed sync's own copy lacks, and leaves the journal. A path the pinned tree has is upstream's even when its bytes differ, since the hook already refuses that edit and `sync` is how it is put right. They check before anything is moved, pinned or written, so a refusal changes nothing and the user moves the files out and runs the command again.
- **The hook.** A bad change name or an unsafe edit path makes the pre-commit hook refuse the commit, before it records, builds or stages anything. The working tree, the index and `.patchbook/` stay as they were, so a hand edit in the output is not lost. The refusal names the problem and how to fix it, and `PATCHBOOK_HOOK=0` skips the hook once. Any other problem that `status` reports only skips the build, with a warning. The build's own safety checks still stop a commit. So does a staged hand edit the hook can't record, one the patchbook wouldn't build into the staged file, and then the hook leaves everything as it was. A change whose file really goes outside the output through a link makes the hook fail and leaves everything as it was, while `status` reports no problems.
- **Upstream paths.** `git mktree` can store a `.git` in an upstream's tree, and a build would write it into your tree as a repo config that upstream controls, such as `core.fsmonitor`. So any path of an upstream with a part git reads as `.git` (the spellings the folder layout lists, such as `.git/config`, `GIT~1/config` or `.git./config`) is refused wherever the build would write it. The message is `upstream <name> holds <path>, which git reads as .git, …`, it ends `Nothing was changed.`, and the exit code is 1. Every command that builds or lists the staged tree stops with it before it writes: `build`, `status`, `scaffold`, `record`, `blocks` and the pre-commit hook, which refuses the commit. `check` and `sync` refuse the tree they would pin, so no pin can move to a commit the next build refuses, and `track` and `init --output-to` do the same through their first sync, which runs before they write the config, so a refused `track` or `init` writes no config. A pin made before this check is refused by the commands above and not by `check` or `sync` while upstream stays at it, and the old tree is never refused, so a sync to a commit without the path works. `upstream <name> --export <dir>` refuses the same paths with the same message, ending `so it can't be exported into <dir>. Nothing was changed.`, since it would write the repo config into `<dir>`, and `--export .` at a repo root would replace the repo's own `.git/config`. A path of an upstream that a vendor folder holds is not built, and the vendor rule in The upstream store judges it instead. A path with a part named `..`, `.` or nothing, which `git mktree` can store, is refused wherever patchbook reads an upstream's tree to pin, build or export it, with `upstream <name> holds <path>, which has a part named "..", so a write could land outside the folder it belongs in. Nothing was changed.` and exit 1. That covers `track`, `sync`, `check`, `build`, the hook, `upstream --export` and `init`, which refuses the merge base it would pin in a fork, and nothing is written outside the folder a command owns.
- **Block entries.** Their file names come from the files under `blocks/`, so they can't be spelled with such a path.

Patchbook would follow a link inside `.patchbook/` out of the repo, or into another part of the patchbook, while a review shows only the link. So every command that reads or writes `blocks/`, `changes/`, `series` or `build.lock` refuses before it reads or writes any of them when one of them is a link, or a link sits inside `blocks/` or `changes/`. The one link allowed is a recorded symlink: a `.pb` copy in a change's `base` or `ours`, which the record replaces. No copy may sit under one. Every command that opens the book refuses a `.patchbook` that is a link, and a `[placeholders.<kind>] file` whose real path is outside the repo. `init`, `sync`, `track` and `config --project` write `config.toml`, `upstream.lock`, `last-sync.json`, `retired.md` or a sync journal (`sync-<name>`), so they refuse a link at any of them before they write anything. `init` also refuses a link in the data. A path patchbook builds under `.patchbook/` refuses a link in any folder above it, wherever the link sits, so `sync` puts back the copies in a journal's `before/` only after it has checked every path, and a link in the way stops it before it writes any. Other commands, the hook included, read `config.toml`, `upstream.lock` and `hooks.ts` through a link. Review such a link as you would a change to `hooks.ts`.

## Sync

- `patchbook check` compares each upstream's head with its pin. It exits 0 when all are up to date and 10 when any has moved, and prints JSON. A fork's upstream moved only if a file outside upstream's own `.patchbook/` changed, so a commit that touches nothing else exits 0. `sync` still pins such a commit when asked, since the pin is the raw commit and tree, and it reports no changed files for it.
- `patchbook sync [name] [ref]` fetches each upstream (or the named one, at a ref) into the store, and updates its pin and its vendored copy, if it keeps one. Then it carries every change on that upstream's files forward:
  - **file edits**: `git merge-file` with base, ours, and the new upstream file. A clean merge updates ours and sets base to the new upstream file. Upstream's mode moves into both copies, unless the change set a mode of its own on ours. A conflict leaves markers in ours and reports **conflict**. A clean merge can still put an edit of a repeated paragraph on another copy than the one ours edits, once upstream moves what lies around that copy. So sync tells the copies apart as occurrence entries do (see Changes), and when the merge edits other copies than ours does, or leaves out ours's edit of a copy, it reports **conflict** instead. An edit counts for the paragraph on each side of it too, since an insert there may be meant for that copy. Upstream making the same edit to a copy also leaves ours's edit out, so that is a conflict as well. Ours then holds our text and upstream's between markers wherever the two differ, and sync names the file on stderr. The count of copies is part of what tells them apart, so a change upstream to that count is a conflict too. When ours adds or removes copies of a repeated paragraph and the merge doesn't add or remove as many, it reports **conflict** too, since `git merge-file` keeps one copy where both sides insert the same paragraph in one place. A file upstream deleted or moved reports **gone**, with likely new paths.
  - **block entries**: an entry whose paragraph changed reports **orphan**, with the nearest new paragraphs.
- When upstream still matches the pin, `sync` hashes the vendored copy. If the copy does not match the pin, such as one that is empty, missing, edited by hand, half written, or a symlink in place of the folder, `sync` writes it again and says so. A symlink is moved into the folder with the old copy, never followed, and comes back as a link if the rewrite fails or is killed. As in a sync that moves the pin, the old copy waits in `.patchbook/sync-<name>/` until the new one checks out. It leaves the change files, `last-sync.json` and the lock alone. A failed or killed rewrite puts the copy back as it was, and the next `sync` writes it again. If the lock has changed since a kill, the folder is left for the user, as for a killed sync that moves the pin.
- **`last-sync.json` is ignored, not committed.** It holds each upstream's latest report (`{version: 1, upstreams: {<name>: {from, to, ...}}}`, see JSON output), kept across runs, so it is state of one checkout. Every `sync` that ends with the file on disk, even one with nothing to do, makes sure `.patchbook/.gitignore` lists `last-sync.json` and `.gitignore`, appending what is missing and leaving the bytes already there as they are. Writing the rules is best effort: if the file can't be read or written, `sync` prints a `patchbook:` warning that `last-sync.json` stays untracked, and its own result and exit code are unchanged. A repo made before this gets the ignore on its next sync, with no step for the user. The file ignores itself, so while neither file is tracked a sync leaves nothing untracked and `git add -A` adds neither; a repo that committed either one sees it modified. Why ignored:
  - A report says what one sync did. Committed, a daily update in a fresh worktree would read last week's entry for an upstream that has not moved since, with nothing to tell it from today's, and each sync commit would carry a report that goes stale at the next one.
  - Its readers cope without it. `status --json` shows `lastSync: null` and `upstream <name> --diff` asks for `--since <commit>`. The update skill reads it right after its own `sync`, in the same worktree.
  - The sync journal already treats it as local state: it saves the file and puts it back when a sync fails, and keeps its own folder out of git the same way.
  - A repo that already committed the file keeps it tracked, since an ignore does not untrack a file. `git rm --cached .patchbook/last-sync.json` ends that, and sync does not run it for the user.
- `patchbook status [--json]` lists the problems, what sync merged on its own, and how much upstream changed in each file we touch.
- `patchbook record [change] [--intent ...]` takes the output files in the working tree edited by hand since the last build (per `build.lock`) and moves each edit into the patchbook. In a file with block entries, each changed paragraph updates its entry, or gets a new `policy` entry; a new paragraph joins the one before it, and a paragraph put back as upstream had it loses its entry. If an edited paragraph's entry uses a placeholder with an empty value, it records none of that file's paragraph edits and says so, since the edit can't show where that placeholder goes; edit that entry by hand. Other edits become `file`, `add` or `delete` edits based on the pinned upstream. A mode change is recorded too, as `chmod +x` on an upstream file with no other edit, or beside a content edit, by the rule in [The executable bit](#the-executable-bit). A file with block entries holds no mode, so a mode change there is skipped, with a reason that says how to set it in a `finish` hook, and its content edits still record. An edit to a file a change already owns goes to that change and keeps its intent. A given intent is for the change being recorded. When no edit goes to that change and no block entry needs it, `record` says the intent wasn't used, and names the changes the edits went to. Naming a change that exists with `--intent` still sets its intent, so then it says nothing. For the other edits, a model reads their diff and writes the intent if you didn't. If the model call fails, whether the CLI is missing or can't start, it exits non-zero, it takes longer than `intent.timeout` or its reply has no usable name and intent, or `intent.provider` is `none`, `record` still records. An edit that needs a change name goes to a new change called `pending` (`pending-2`, ... if that's taken) unless you named one, and a new block entry gets an empty intent. An empty intent is a pending intent: `status` reports it as a missing intent and `build` refuses until it's filled. `record` prints one `pending` note with the failure's first line and the command that fills it, and exits 0. An edit that needs no name or intent, and a given `--intent`, never call the model. A timeout kills the model and everything it started. When the model picks a change whose intent is empty, its intent fills that one. Without a change name, the model also picks one: an existing change the edits serve, or a new name. If you give an intent but no name, the model isn't called: the change is named from the intent's first four words, dropping any that would take the name past 40 characters. Any intent is kept on one line, with each run of whitespace a single space, and a blank intent counts as none. A name given to `record` must follow the change-name rule (see Change names), and `record` refuses before it writes while `series` holds a name that breaks it. Anything under `changes/` that `series` doesn't list is a stray, and `record` never writes into one: `record <name>` refuses a stray name before it writes, and a name from an intent or the model takes the next free suffix (`-2`, `-3`, ...) instead. Deleting the output of a `replace` takes the `replace` and its copy out of the change that owns it and records a `delete` of the path in the change being recorded, as does deleting an output that a `move` or `copy` made or a copy another output is still built from, and a change left with no edits stays, with its intent and an empty `edits:` list. A failed record leaves the patchbook as it was, though not for a write through a symlink inside `.patchbook` (#169): `record` puts `.patchbook` back to what it was before its first write and prints no note of what it saved, so the same command run again records the same edits with the same `--intent`. If a file can't be put back, `record` names it on stderr.
- `record` writes an edit to an output as a `replace` of that output when its source also builds another output still on disk, as a `copy` does. An edit to the source would change the other output too. This holds for a file that a change owns or that has block entries, so the edit doesn't go to the owner. When `record` replaces every output of a file with block entries, it deletes the entries file. Each `add`, `delete` or `replace` that `record` writes goes at the end of its change, so no change later in the series may have a structural edit on the same path, on a folder above it or on a path under it. A later `file` edit doesn't count, since the build applies content edits before structural ones. An `add` or `replace` also can't go into a change that already keeps its own copy of the path. `record <name>` refuses a change that breaks either rule before it writes, and names the file and the change to use. `record` offers the model only the changes that can take the edits, and a reply that names another change starts a new one.
- `patchbook intent [change] [--intent ...]` fills empty intents. With a change name it fills that change, with `--intent` or else with a model that reads the change's edits. With no name it fills every change and every block entry with an empty intent through the model. `--intent` needs a change name: with none, the command exits 1 and writes nothing, since one intent would land on unrelated changes. The model is asked once per change and once per file of block entries. If it fails, the command exits 1 and writes nothing. It never touches an intent that isn't empty, and it never renames a change, so a `pending` change keeps its name.
- A pre-commit hook does `record` and `build` on each commit, and stages what they change, so the usual loop is: edit, stage, commit. It records what is staged, not the working tree, so unstaged changes and untracked files stay out of the commit, and `git commit <path>` records only that path. The build reads the patchbook on disk, so the commit stops if a patchbook file it reads (`blocks/`, `changes/`, `series`, `build.lock`, `config.toml`, `upstream.lock`, `hooks.ts`, or a `[placeholders.<kind>] file` outside the output) has changes that aren't in the commit. It stops too on a placeholder file in the output whose unstaged changes the last build didn't write. A staged output file is the build's when it matches its entry in HEAD's `build.lock` or the index's, and a hand edit otherwise. A staged file that matches neither, while its working copy matches the last build and the commit changes the patchbook, may be an older build's output, so the hook stops. Its message gives a `git add` that commits the last build and a `git checkout` that records the staged copy. The hook writes the build to disk wherever the disk differs, except over unstaged work that matches neither the index nor the last build: it leaves that alone, and stops if the build would stage that file. It also stops on a file removed from the index but kept on disk, as `git rm --cached` does. Output that git ignores goes to disk but not into the commit, as with `build --commit`. A mode you stage is recorded by the rule in [The executable bit](#the-executable-bit). The hook is a short script that runs `patchbook hook run` from `PATH`, so upgrading patchbook upgrades the hook. If `patchbook` isn't on `PATH`, it says so and lets the commit through. While git runs hooks from `.git/hooks`, `clone`, `init`, `record`, `build`, `sync` and `track` install it in the repo if it's missing, so a fresh clone gets it on first use. They skip a patchbook that sits in another git repo than the one you're in. A file is patchbook's own only when its text is exactly one patchbook writes: the current script, or the one from before it checked for `.patchbook/config.toml`, which they rewrite to the current one. A hook that differs by a byte, with lines added or with the paths of another install written into it, is another tool's. If the file is patchbook's own and isn't executable, they make it executable again; another tool's file they leave alone, and `hook install` says git ignores it. `clone` says the hook records only when it does, and otherwise names the setting that turned it off. `status`, `check`, `show`, `upstream` and `config` never write a hook, and nothing installs one while `hook.enabled` is off. `patchbook hook install` installs it by hand. A hook manager moves the hook git runs. Vite+ and husky set `core.hooksPath` to their own folder, and lefthook and the pre-commit framework put their dispatcher in `.git/hooks`. So `clone`, `init` and `hook install` find the hook git will run. In a Vite+ (`.vite-hooks/pre-commit`) or husky (`.husky/pre-commit`) script, they put lines first that call `patchbook hook run`, and in a fork record that edit as the change `patchbook-hook`. For lefthook, the pre-commit framework and any other hook, they print the lines to add. For lefthook they print them in the format of its config file (`lefthook.yml`, `.yaml`, `.toml`, `.json` or `.jsonc`, also under a leading dot or in `.config/`), and for the pre-commit framework as an entry. Where the config already has the `pre-commit` or `repos` key, they print only what goes under it, and say where; in lefthook's YAML and JSON they go one level deeper if `commands` is there too. The lefthook command and the pre-commit entry run the same guarded lines as a script, through `sh`. They never edit a config file, and never write into the `_` dispatcher folder that Vite+ and husky point git at, or into another tool's hooks folder. They don't write through a symlink either; a script reached through a link gets the lines printed. What patchbook adds to a manager stops the commit when `patchbook` isn't on `PATH`, because a commit that skips recording leaves the output and `build.lock` out of step. That holds for the lines in a script, the lefthook command and the pre-commit entry alike. They say how to install patchbook and how to skip the hook once, and `PATCHBOOK_HOOK=0` skips under every manager. They do nothing in a repo without a patchbook, so they are safe in a hooks folder every repo shares. When it puts the lines in a script, patchbook inserts them as bytes, so the rest of the file is as it was, including bytes that aren't UTF-8. `patchbook hook install` stops with an error in a git repo that sits inside another repo's patchbook, because it would install the other repo's hook. `patchbook status` warns on stderr when git runs no hook, or the hook it runs doesn't call patchbook. A manager that hasn't installed its hook in this checkout, as in a new git worktree before `npm install`, leaves git running nothing, and the warning names the manager's install command (`npx husky`, `vp config`). `patchbook hook status` prints the same facts on stdout: whether `hook.enabled` is on and where that setting came from, the file git runs, and whether it calls patchbook. It never writes. A failed hook run puts the patchbook and the output back as it found them, so the retry records from scratch; like every command that reads the patchbook, the hook stops before it writes anything on a link in `blocks/`, `changes/`, `series` or `build.lock` other than a recorded symlink (see Trust). A linked `config.toml` or `upstream.lock` is fine once the link is staged or committed, since the hook never writes them. If the patchbook has problems, it records but doesn't build, and says so. Three things are the exception. They are a change whose output lands in `.patchbook` or at a part git reads as `.git`, an edit path that isn't a clean path inside the tree (a backslash makes it unclean, so `record` also refuses a hand edit to a file whose name has one), and a change name outside `[a-z0-9][a-z0-9-]*`. The hook refuses the commit before it records, builds or stages anything, and names the problem. It does the same for a new file you add by hand in the output at a path that lands in `.patchbook` in another letter case, or at a part git reads as `.git`, such as `.PATCHBOOK/x.md` on a case-sensitive filesystem or `a/.GIT/y`. The book's own `.patchbook/` folder is the book, not output, and commits normally. Any other problem that `status` reports, a destination in a vendored copy included, only skips the build with a warning. The build's own safety checks still stop a commit. A change whose file really goes outside the output through a link makes the hook fail and leaves everything as it was, while `status` reports no problems. `PATCHBOOK_HOOK=0 git commit` skips it once, and `PATCHBOOK_INTENT="..."` gives the intent instead of the model.
- Intents are written by Claude Haiku 5.5 at medium effort through the `claude` CLI, or GPT-6-Luna at high effort through `codex`: Claude if it's installed, unless the settings choose. The model runs as a plain completion that only reads the diff. `claude` gets no tools, no MCP servers, no slash commands and no saved session (`--tools ""`, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence`). It still reads the user's settings, because a login or a Bedrock or Vertex setup can live there, so there is no `--bare`. `codex` runs `-s read-only` and `--ephemeral`. It still loads the user's MCP servers, since `-c mcp_servers={}` doesn't clear them. A reply is usable only when the whole reply, trimmed, is one JSON object `{"change": ..., "intent": ...}`, or is exactly one code fence (```` ```json ```` or ```` ``` ````) holding one. Prose around the object, two objects, an object followed by more text and an array are all unusable, and an unusable reply is a failed model call: the intent stays pending.

## Lines and whitespace

A line ends after each `\n`, as in git. A `\r` before the `\n` stays in the line, and nothing else ends one, so a lone `\r`, a form feed or U+2028 is part of the line around it. A last line with no `\n` is still a line. Git cuts the lines of every diff patchbook prints (see Diffs), and `record` cuts a file at the same places when it matches lines.

Whitespace is what JavaScript's `\s` and `trim()` match: spaces, tabs, line ends, a no-break space and the other Unicode spaces, and a BOM. `\x1c` to `\x1f` and U+0085 are text. A line of only whitespace is blank and ends a paragraph, and patchbook trims whitespace from the intent of a `CHANGE.md`, the fields of a block entry, the lines of `series` and a list setting.

Patchbook never trims a path. A path that starts or ends with a space or a BOM names a different file from the one without it, as in git. An edit line of a `CHANGE.md` starts in its first column with `- `, then the kind, then one space, then the path. A line with whitespace before its `- ` is refused. `move` and `copy` take a second path after ` -> `.

A path in an edit line is bare or in double quotes. A bare path is taken as written. It runs to the first ` -> `, or to the end of the line for the last path of the line. A path that starts with a double quote is a quoted path. Inside the quotes the escapes are git's: `\"`, `\\`, `\t`, `\n`, and `\ooo` for a byte as three octal digits. Patchbook writes `\ooo` for each UTF-8 byte of any other control character, and reads the bytes back as UTF-8. It also reads `\a`, `\b`, `\f`, `\r` and `\v`.

Patchbook writes a path bare only when it reads that bare text back as the same path in the same place: a single path, or the source or destination of a `move` or `copy`. Otherwise it writes the path in double quotes. The writer keeps no rules of its own. `editText` runs the reader's own path reader on the bare text, with the ` -> ` that follows a source, and quotes the path when the reader refuses that text or reads a different path from it. So a single path or a source that holds ` -> ` is quoted, and so is a source that ends in ` ->`. A destination that holds ` -> ` is bare, because a destination runs to the end of the line. `record` writes every edit line this way, so a change it saves reads back as the same edits.

Patchbook refuses a bare path that starts or ends with whitespace (what `\s` matches, a BOM included) or holds a control character, with the file, the line and the path in quotes to write instead. So patchbook writes a line end or a tab in a path as an escape, and no edit line it writes holds a raw control character. Patchbook also refuses a quoted path that is not closed, has text after its closing quote, has an escape not listed here, is not UTF-8 or holds a NUL.

A path, bare or quoted, must be a path inside the tree: not absolute, with no empty, `.` or `..` segment and no slash at the end. Patchbook does not strip a slash to make it one, so `moved /` is refused and not read as `moved `. An edit with such a path is invalid. `status` lists it, `build` builds nothing, the pre-commit hook refuses the commit, and `record` keeps the line as written.

Where patchbook reads git's output, it takes off only the `\n` git ends a value with, and splits at the tab, space or newline git puts there, not at any whitespace. It splits `-z` output at the NULs and cuts nothing else. When patchbook cuts text short for a model or a message, such as a diff past 40000 characters or the last 500 characters of a model's errors, it cuts by code point, so no character is split in half.

## Ordering

Patchbook sorts paths and names by code point. That is the order of their UTF-8 bytes, which git sorts paths in, and it is the same in every locale: `Z` comes before `a`, and `é` after `z`. It compares whole paths, so `a-b/x` comes before `a/b`, as `git ls-files` lists them. `build.lock`, the upstreams in `upstream.lock`, the files `upstream` lists and the paths `check` and `sync` report all follow this order.

## Diffs

Every diff patchbook prints or gives a model is git's: `patchbook show`, the diff a model reads to write an intent, and the diff of a recorded paragraph. `upstream --diff` is the one exception: it runs `git diff` in your repo with your config (#245). For the others, patchbook writes the two sides to files in a new temporary folder and runs `git diff --no-index --text` on them there. It gives git an environment with only `PATH`, that folder as `HOME`, no system config or attributes, and a ceiling at the folder's parent, so git finds no repository. So no config file, no `.gitattributes`, no `GIT_DIFF_OPTS` and no `GIT_DIR` from the pre-commit hook changes a diff, and the same two texts give the same diff on every machine with the same git version. It is git's default diff, with three lines of context and git's default algorithm. A `diff.algorithm` set for your own `git diff` doesn't apply.

Everything from the first `@@` is git's output, byte for byte when the text is UTF-8; any other byte shows as U+FFFD: the hunk ranges, the function name git prints after `@@`, and `\ No newline at end of file`. Patchbook writes the two lines above it, `--- <from>` and `+++ <to>`. They name `upstream/<path>` and `ours/<path>` for `show`, `built/<path>` and `disk/<path>` for a file edit a model reads, `upstream/<path>` and `disk/<path>` for a paragraph edit a model reads, and `/dev/null` for a side that doesn't exist. Two equal sides give no diff. Git reads both sides as text, so it never prints `Binary files differ`. For a file that isn't text, the diff for a model says `binary file <path> added`, `deleted` or `changed` and asks git for nothing. Each diff spawns one git. With the temporary folder and its two files, a diff of 20 to 3000 lines takes 3 to 6 ms.

## Matching and similarity

Patchbook compares two texts as two lists. `record` compares the lines of a file, cut at each `\n`, to cut an edit into paragraphs. Similarity compares the code points of two texts. Two elements match when they are the same string. None is left out: a blank line, a `}` or a space counts like any other element, however often it appears and however long the text is.

A matching pairs elements of the old list with equal elements of the new one, in order. Patchbook takes a matching with the most pairs, a longest common subsequence. When several have the most, it pairs the elements both lists start with, then the elements they end with among the rest. Between those, it takes the pairs that come earliest. Of two such matchings, it takes the one whose first different pair has the earlier old element, or on the same old element the earlier new one. Each stretch between two pairs is one edit. `record` gives the edit to the paragraphs whose lines it touches, or, when it touches none, to the paragraph before it, or the paragraph after it when none comes before.

The similarity of two texts is twice the pairs in the matching of their code points, over the code points of both texts. Two empty texts have similarity 1. `similarity()` in `src/lib/match.ts` makes the number, and it is the one place patchbook rounds it (`status` shows it as a percent, which changes no digit): to hundredths, with a half rounded up, worked out on the counts. So 0.575 is 0.58, where `Math.round(r * 100) / 100` gives 0.57, because 0.575 isn't exact in binary. Patchbook compares only this rounded number, and on a tie the candidate it found first comes first. It uses the number three times:

- An orphan's nearest new blocks are the two most similar blocks with a similarity of at least 0.4.
- An export in `hooks.ts` that isn't a hook gets `did you mean` the most similar hook if that hook's similarity is at least 0.6, and the list of hooks otherwise.
- A file edit whose file upstream no longer has lists the three added paths with the most similar names.

Matching takes time in proportion to the two lengths multiplied together, after the shared start and end, divided by 32. Similarity keeps one row of bits. Pairing lines keeps a row for each old line, n × m / 8 bytes for n old and m new lines between the shared start and end, so 1 MB for 3000 lines each and 50 MB for 20,000. A 3000-line file rewritten end to end pairs in about 5 ms, and 300 paragraphs of 3000 code points each take about 0.6 s to score against one.

## Command line

Patchbook reads its command line with its own parser, `parseArgv` in `src/lib/args.ts`, which has no dependency. Each command declares its arguments and options once, in `PROGRAM` in `src/cli.ts`, and that declaration is also its help.

- A command line is `patchbook <command>`, then the command's arguments and options in any order. Before the command, patchbook takes only `-h`, `--help` and `--version`.
- An option is matched by its whole name, such as `--branch`. A prefix such as `--bra` is an unknown option. `-h` is the only short form.
- An option that takes a value reads it from `--name=value`, or from the next argument when that argument is a lone `-` or does not start with `-`. Any other value that starts with `-`, a word with a space or a negative number included, needs the `=` form, as in `--upstream=-x`.
- After `--`, every argument is an argument, so `patchbook blocks -- -notes.md` names a file that starts with `-`. A lone `-` is always an argument.
- `-h` or `--help` anywhere before `--` prints help and exits 0, whatever else is on the line. It is the command's help when the first argument is a command, and the list of commands otherwise.

Patchbook refuses an unknown command or option, an option without its value, a value given to an option that takes none (`--force=yes`), an option given twice, two options or arguments the command says can't go together (`upstream --diff --export <dir>`), an argument the command does not take, a missing argument or required option, and a word outside an argument's choices. It reports the first problem it finds, reading from the left, on stderr, and exits 2:

```
patchbook sync: unknown option "--forse"
Run `patchbook sync --help` for its arguments and options.
```

Help text does not wrap to the terminal. A test keeps every help line within 80 columns.

## Messages

- A command that fails prints `patchbook: ` and the reason on stderr, and exits 1. A usage error starts with `patchbook <command>: ` instead (`patchbook: ` when no command was found, as in `patchbook: unknown command "frob"`) and exits 2.
- A name, path or value that a message quotes from the command line, a file or another program is in double quotes, written by `quote` in `src/lib/text.ts`. It is `JSON.stringify`'s text, so the quotes show a space at either end, and a quote or a backslash inside is escaped. Every control character (`\p{Cc}`, DEL and U+0080 to U+009F included), every format character (`\p{Cf}`, such as U+202E) and every lone surrogate is escaped too, as JSON writes it (`\n`, `\t`) or else as `\uXXXX`, or `\u{X…}` above U+FFFF, so a value can't move the cursor or reorder the text after it: `layout must be folder or fork, not "folders"`. Many messages still print such a value bare, as in `no change called shout`; #247 tracks quoting them.
- Patchbook's own names are bare: its commands, options, settings and problem kinds, and the choices of an argument. A command, an identifier or syntax to type is in backticks: ``Run `patchbook status` ``, ``did you mean `blockTerms`?``.
- A change or a block entry with no intent shows as `(no intent yet)` in `show`, in the `orphan` lines of `status` and in the list of changes the model gets. Patchbook never prints `None` for it.
- A file patchbook writes leaves a missing intent empty. `CHANGE.md` gets the line `intent:` with nothing after it, and a block entry gets an empty `intent:` field. The readers take an empty intent as none, and `status` reports the change or the entry as `invalid`, `it has no intent`.

## JSON files and output

Patchbook writes four JSON documents. `.patchbook/upstream.lock` is committed with the repo. `.patchbook/last-sync.json` is a report that `patchbook sync` writes and nobody commits. `patchbook check` and `patchbook status --json` print the other two. `UpstreamLock`, `LastSync`, `CheckJson` and `StatusJson` in `src/api.ts` are their types, and the code that writes each document is typed against its type. With patchbook installed from npm, `import type { CheckJson } from "patchbook"` gets the same types. Patchbook also reads two JSON texts that it doesn't write: a placeholder file with `format = "json"`, and the reply of the model that writes an intent.

**Writing.** Patchbook writes each document with `JSON.stringify(value, null, 2)` and a newline at the end. Text outside ASCII is written as UTF-8, not as `\u` escapes, except that every control character is a `\u` escape, so none reaches a terminal raw. Keys come in the order the tables below list them. Each list of upstreams is a list of objects with `name` first, never an object keyed by upstream name, because JavaScript puts a key such as `2` in front of the other keys of an object, whatever order it was added in. Writing a number that isn't finite fails, so a `NaN` never becomes `null`.

**Reading.** Patchbook reads JSON with `JSON.parse` and then checks the shape of what it got, in `src/lib/shape.ts`, the only place in `src/` that calls `JSON.parse`. It refuses text that isn't JSON, which includes `NaN` and `Infinity`. It also refuses a field that is missing or has the wrong type, an upstream named twice, a commit or tree that isn't 40 or 64 lowercase hex digits, and a count that isn't a whole number from 0, such as `1e400`. The message names the file and the field, as in `.patchbook/upstream.lock: upstreams[1].tree is missing.` A reader ignores keys it doesn't know.

**Versions.** Each document patchbook writes has its own integer `version`, the first key. `upstream.lock` is version 1. `last-sync.json`, `check` and `status --json` are version 2. A version goes up when a field is removed or renamed, changes type, or means something else. A new field leaves it alone, so a reader ignores keys it doesn't know. So does a new `problem` kind, or a new prefix in `files`, so a reader treats a value it doesn't know as unknown and does not fail. Patchbook reads only the version it writes, and it has no code that converts an older file. It refuses a file with no version, or with another version, and says which, as in `.patchbook/last-sync.json is version 1, and this patchbook reads version 2.` To fix an `upstream.lock` from before version 1, which is an object keyed by upstream name, rewrite it by hand as the version 1 example below shows. To fix a `last-sync.json`, delete it. It only reports past syncs, and the next sync writes a new one.

### `.patchbook/upstream.lock`

Written by `clone`, `init`, `track` and `sync`, and committed. It has an entry for each upstream in the config that has a pin, sorted by name. An entry for a name that is no longer in the config is still checked when patchbook reads the file, and is left out the next time patchbook writes it.

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `1` | |
| `upstreams[].name` | string | The upstream's name in `config.toml`. |
| `upstreams[].commit` | string | The pinned commit. |
| `upstreams[].tree` | string | The pinned commit's tree hash. |

```json
{
  "version": 1,
  "upstreams": [
    {
      "name": "pstack",
      "commit": "101b274b3f1c2b3e8a5d6c7f8e9a0b1c2d3e4f50",
      "tree": "54ac5261f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5"
    }
  ]
}
```

### `patchbook check`

Printed on stdout. Exit 0 if no upstream moved, 10 if any did. It has an entry for each upstream in the config, in config order.

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `2` | |
| `moved` | boolean | Any upstream moved. |
| `upstreams[].name` | string | The upstream's name. |
| `upstreams[].pinned` | string or null | The pinned commit, null when nothing is pinned. |
| `upstreams[].head` | string | The commit at the head of the upstream's branch. |
| `upstreams[].moved` | boolean | The head's files differ from the pin's. A new commit with the same files is not a move, and in a fork neither is one that changes only upstream's own `.patchbook/`. |
| `upstreams[].files` | string list | Empty unless `moved`. Otherwise `added <path>`, `changed <path>` or `deleted <path>` for each file that differs, sorted by path. Paths include the upstream's mount. Files the build leaves out aren't listed. |

### `patchbook status --json`

Printed on stdout. Exit 0 if `problems` is empty, 1 if not. Plain `patchbook status` doesn't read `last-sync.json`. `status --json` does, so it stops on a `last-sync.json` it can't read.

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `2` | |
| `upstreams` | list | The entries of `upstream.lock` for the upstreams in the config: `{name, commit, tree}`, sorted by name. |
| `applied` | integer | The number of edits that apply at the pins. |
| `problems` | list | The problems, as below. |
| `lastSync` | object or null | The document in `last-sync.json`, or null if there is none. |

A problem always has `problem`, its kind, first. The other fields depend on the kind. A location is one of these sets of fields:

| Location | Fields | Meaning |
| --- | --- | --- |
| file | `file` | A path in the patchbook, in upstream or in the output. |
| edit | `file`, `edit` | `file` is `changes/<change>` and `edit` is the edit as `CHANGE.md` writes it. |
| change | `file`, `change` | `file` is a path in upstream that the named change edits. |
| output | `file`, `output` | `file` is the upstream path, or `changes/<change>` for a file the change adds. `output` is where it lands in the output folder. |
| block | `file`, `output`, `line`, `hash` | A paragraph of the upstream file `file`, from its 1-based `line`, with its `hash`. |

| `problem` | Fields after `problem` | Meaning |
| --- | --- | --- |
| `invalid` | any location, `detail` | Something in the patchbook is malformed, or an edit can't apply. |
| `gone` | edit or change, `detail` | The file an edit names isn't in upstream. |
| `stale` | change, `detail` | The change's base differs from upstream at the pin. Run `sync`. |
| `conflict` | file or change, `detail` | Conflict markers in our copy, or in the output. |
| `placeholder` | output or block, `detail` | A `{{kind:name}}` that neither the `placeholder` hook nor the placeholder source gives a value. |
| `leak` | output with `line`, or block, then `terms` | Text that a `[[check]]` pattern or `blockTerms` flags is still in the output. Without `hash`, `line` is the 1-based line in the output where the paragraph starts. `terms` is a string list. |
| `missing` | block, `terms`, `upstream` | A paragraph that needs an entry. `upstream` is its text. |
| `orphan` | `file`, `hash`, `occurrence`, `kind`, `rules`, `intent`, `upstream`, `patched`, `nearest` | An entry whose paragraph changed upstream. Only an entry that patches one occurrence of its paragraph has `occurrence`, as `{nth, of}`. `kind` is `translation`, `policy` or `keep`. `nearest` is a list of `{line, hash, similarity}`, where `similarity` is a number from 0.4 to 1, as below. |
| `check` | file, `detail` | A problem the repo's `check` hook reports. A hook may return any kind. |

**Similarity.** A nearest block's `similarity` says how much of its text matches the entry's old paragraph, rounded to hundredths, as Matching and similarity defines it. `nearest` lists the two most similar paragraphs whose similarity is at least 0.4, most similar first, and on a tie in the order patchbook found them. `status` shows the same number as a percent, as in `nearest new blocks: line 7 [3f2a9c1b0d4e] 90%`, and so it shows a `similarity` that a `check` hook returns.

### `.patchbook/last-sync.json`

Written by `patchbook sync`. It has an entry for each upstream in the config that a sync has moved, in config order. Each entry is the report of the latest sync that moved that upstream, so entries can come from different runs. A sync killed after it writes the report and before it moves the pin leaves an entry for a move `upstream.lock` does not hold, until the next `sync` puts the report back. An upstream no sync has moved has no entry.

`sync` reads the file before it moves anything, and stops on a file it can't read, so it never drops the reports of the other upstreams. It writes the file after each upstream it moves, before it moves that upstream's pin, and keeps the entries of the upstreams it did not move. It drops the entry of an upstream no longer in the config, even on a sync that moves nothing. `upstream <name> --diff` reads it to find the earlier pin, and stops on a file it can't read, as `status --json` does. To keep only one run's moves, a reader keeps the entries whose `from` is the upstream's pin before that run and whose `to` is its pin in `upstream.lock` after it.

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `2` | |
| `upstreams[].name` | string | The upstream's name. |
| `upstreams[].from` | string or null | The commit pinned before that sync, null when nothing was pinned before that sync. |
| `upstreams[].to` | string | The commit that sync pinned, unless that sync was killed before it moved the pin. Compare it with `upstream.lock` to tell. |
| `upstreams[].upstream` | string list | The files upstream changed, as `files` in `check`. |
| `upstreams[].merged` | list | `{change, path}` for each file edit that merged without conflict. |
| `upstreams[].conflicts` | list | `{change, path, count}` for a text file with `count` conflicts in our copy, or `{change, path, detail}` for a binary file. |
| `upstreams[].gone` | list | `{change, path, maybe}` for a file edit whose file upstream no longer has. `maybe` is up to three added paths with similar names, most similar first. |
| `upstreams[].replacedUpstreamChanged` | string list | `<change>: <path>` for each `replace` edit whose file changed upstream. |

### Placeholder files

For a `[placeholders.<kind>]` table with `format = "json"`, the default, patchbook reads its `file` as one JSON object. Each key is a placeholder's name, and its value is a string, or a list of strings that patchbook joins with `, `. A key that starts with `_` is a comment, whatever its value. Patchbook refuses any other value, such as a number, `true` or `null`, and names the file and the key: `.patchbook/strings.json: "enabled" must be a string or a list of strings, not true.`

### The model's reply

The model that writes an intent replies with `{"change": "<name>", "intent": "<intent>"}`. Patchbook reads the text from the first `{` to the last `}` of the reply as JSON. `record` stops if the reply has no object, if the object isn't JSON, if `change` or `intent` is missing or isn't a string, if `change` breaks the change-name rule, or if `intent` is blank. Its message says which, as in `claude's reply: intent is missing.`, then quotes the first 500 characters of the reply and asks for a name and `--intent`.

## Settings

Each setting can be set in three places, and the most specific wins: an env var, for one command; the project's `.patchbook/config.toml`, shared with everyone who works on the repo; and the user's `~/.config/patchbook/config.toml`. `patchbook config` lists every setting, its value, and where the value came from. `patchbook config <name> <value>` sets one in the user config, `--project` sets it in the project's, and `--unset` removes it.

| Setting | Env var | Default |
| --- | --- | --- |
| `intent.provider` | `PATCHBOOK_PROVIDER` | `claude` if installed, otherwise `codex`. `none` turns the model off, so `record` leaves intents empty |
| `intent.model` | `PATCHBOOK_MODEL` | the provider's |
| `intent.effort` | `PATCHBOOK_EFFORT` | the provider's |
| `intent.timeout` | `PATCHBOOK_INTENT_TIMEOUT` | `60` (seconds to wait for the model before leaving the intent empty) |
| `hook.enabled` | `PATCHBOOK_HOOK` | `true` |
| `start.install_skill` | `PATCHBOOK_SKILL` | `true` |
| `start.agents` | | `["claude-code", "codex"]` |
| `store.path` (user only) | `PATCHBOOK_HOME` | `~/.local/share/patchbook` |

A model or effort set beside a different provider belongs to that provider, so it's skipped when another layer picks a different one.

Problem kinds: missing, orphan, conflict, gone, stale, invalid, placeholder, leak, check.

## The update skill

This repo ships a `patchbook-update` skill, built into the `patchbook` binary. `patchbook clone` and `init` write it to `.agents/skills/patchbook-update/`, which Codex reads, and link `.claude/skills/patchbook-update` to it for Claude Code (`start.agents` chooses the agents). In a fork, `clone` and `init` record it as the `patchbook-update-skill` change, since anything not upstream is a change. `patchbook skill install` writes this binary's copy into an existing repo, and in a fork records it in the same change, leaving any other waiting edits for `patchbook record`. It refuses to replace a skill file or link that differs from the shipped copy unless HEAD holds the same bytes up to `\r\n` line endings, in a file with no NUL byte, so a customization is committed first. A file may differ from HEAD's blob only in line endings (`\r\n` against `\n`), which covers `eol` and every `core.autocrlf` mode, and a link's target must match exactly. No git conversion runs in the comparison, so a path whose clean filter or `working-tree-encoding` rewrites bytes other than line endings is refused even when committed, and a filter cannot hide disk text from it. An uncommitted edit, an untracked or ignored file HEAD lacks, and an edit hidden with `--skip-worktree` or `--assume-unchanged` are all refused. A file HEAD holds with the same content is kept even when git ignores it. When a path is refused because it holds a customization, `clone` and `init` write nothing at any skill path and finish with a note instead of an error. A folder at a skill path is a broken layout, not a customization. `clone`, `init` and `skill install` share one check and one message for it: the skill is not installed, the message names the folder and says to move it, and the command exits 1. `clone` and `init` first finish everything else, so the repo is a complete patchbook without the skill, and `patchbook skill install` writes the skill once the folder is gone. In a fork whose upstream holds the folder, `skill install` also refuses until the folder's removal is recorded, by a commit or `patchbook record`. When a write fails (a read-only folder, a file where a folder should go), `clone` and `init` print what they couldn't do and where, with the system's reason and no errno code, and finish. It never writes through a symlink on the way to a skill path, and refuses when one is there, except a `.claude/skills` link to `.agents/skills`, which already is the skill folder. Each adapted repo runs "Use the patchbook-update skill." every day from a scheduler: a T3 Code scheduled task, cron with `claude -p` or `codex exec`, or a CI job. The skill tells what the agent offers from the tools it has: T3's thread tools, a subagent tool and pull request linking. Where a tool is missing, or it can't tell, it takes the path without that tool. It never waits for an answer, and it ends every run with a line a scheduler can read: `patchbook-update: up to date`, `merged`, `needs you: <the decision>` or `failed: <the error>`. A repo with no agent can run `patchbook check` and `sync` from a job that opens a pull request for a person, which the README shows. The skill:

1. Upgrades patchbook the way it was installed, if it can tell, then runs `patchbook check`. If no upstream has moved, it archives the thread when it has thread tools, and stops.
2. Makes its own worktree and branch from `origin/main` on every run, T3 included, outside the repo under `~/.cache/patchbook/worktrees/`. It never works in or removes the checkout it starts in, even a linked worktree, so the run never changes or removes a checkout someone uses. Runs `patchbook sync`, asks before any commit if it fails, removes its worktree and ends the run as step 1 does if it pinned nothing, and commits the sync on its own. From then on it reads only the reports of the upstreams `patchbook sync` pinned, which can include one that moved after `patchbook check`. It takes only the problems from `patchbook status --json`, not its copy of the reports, and uses `patchbook upstream --diff` only for an upstream the sync pinned. Every commit it makes skips the pre-commit hook (`PATCHBOOK_HOOK=0`), since in a fork the hook records unstaged and untracked files and hand edits to the output into whatever commit runs.
3. Resolves each problem from the change's intent and the repo's guide (`guide` in the config). One commit per change.
4. Deletes scratch files it or a test wrote, and asks if a file in the output or a vendored copy was edited by hand. Then commits each other change left in the worktree on its own, never `.patchbook/last-sync.json`, or asks if it can't tell what one is. Builds, the run's only build, and commits what the build wrote. Then runs the `test` from the config on `origin/main`, which is a command or an instruction file for the agent, and asks if it can't read that file there. After each test run it deletes every untracked file that isn't ignored, except `.patchbook/last-sync.json`, since only the test can have left one. It makes at most two attempts to fix a failing test, each changing what the test checks, never the test, its scripts or its fixtures. It commits each test fix on its own, then builds and tests again.
5. Starts a review in a fresh subagent. With T3's `delegate_task` it runs on another provider's model when T3 can run one, otherwise on the same model. With another agent's subagent tool it runs on that agent's model. With no subagent tool, the skill reviews the work itself in a separate pass. The reviewer gets each intent, the upstream change, and our result, and says per change whether the result meets the intent, and once whether upstream added anything that should have been handled. A change or question with no verdict counts as a fail. It waits up to an hour for the verdict before step 6, and a review that times out or stops on a question counts as a fail. Such a fail finds nothing to fix, so it commits nothing before the next round. It commits each review fix on its own, then builds and tests again. At most two rounds.
6. If, on the commit it pushes, `patchbook status` and `patchbook build` exit 0 and `git status --porcelain --untracked-files=no` prints nothing after the build, and the sync was clean or the test command on `origin/main` exited 0, pushes its branch to `main`, runs the config's `deploy`, removes the worktree and branch it made (without `--force`, keeping them if git refuses), and ends with a short summary, reporting a failed deploy as a failure, settling the thread when it has thread tools. The sync was clean when the report of each upstream `patchbook sync` pinned has an empty `replacedUpstreamChanged`, step 3 found nothing to handle, nothing came after the sync commit but files the build wrote, and the rebase brought in no commits.

It stops and asks instead of merging when:

- the condition in step 6 doesn't hold;
- `patchbook sync` fails;
- upstream removed or reworked something an intent depends on, and retiring the change would lose something the user wanted;
- meeting an intent needs a choice the intents and the guide don't settle;
- the second review round returns any fail;
- a test fails and it can't fix it, an instruction-file test included, or it can't read the instruction file on `origin/main`;
- a test leaves tracked files changed, even if it passed;
- step 4 finds a hand edit to the output or a vendored copy;
- a `replacedUpstreamChanged` entry in the report of an upstream `patchbook sync` pinned has no step 3 commit that names its file;
- the branch changes the config's `test`;
- the only fix for a failing test changes the test, its scripts or its fixtures;
- the final rebase fails, which it aborts.

Then it keeps its worktree and, if it has committed anything, pushes its branch and opens a pull request with `gh` when it can, linked to the thread in T3. It never waits for the answer. It ends with `patchbook-update: needs you: <the decision>`, which in T3 leaves the thread active, in your inbox.

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

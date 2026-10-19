# Patchbook design

A patchbook holds your changes to someone else's repo, each with its intent, so you can keep pulling from upstream. A build applies the changes to a pinned upstream commit. When upstream moves, the tool reports which changes still apply and which broke, and an agent redoes each broken change from its intent. You are asked only when upstream makes an intent impossible or turns it into a real choice.

First user: [wstack](https://github.com/willgosnold/wstack), which rewrites Lauren Tan's pstack skills for T3 Code. Planned: a kiro-cli provider in a fork of T3 Code.

## Layouts

A repo uses one of two layouts.

- **folder.** The build writes its output to a folder of the repo. Use it when you ship something derived from upstream. wstack builds `skills/` from pstack. `[output] to` is rejected when it is the repo root, outside the repo, at or inside `.patchbook` or `.git`, a file, a link or under one (a link to the repo root included), or at or inside a vendor folder, and so is any output folder with a part at any depth that git reads as `.git`. That is `.git` in any letter case, or a name Windows or a Mac reads as `.git`, such as `.git.`, `.git `, `GIT~1`, or a name that is `.git` once the invisible characters a Mac ignores are taken out. git refuses to stage most of these names, and `git fsck` warns about all of them on every platform. A mount of `.git/x` or `GIT~1/x` is rejected the same way. A link above the repo (macOS `/var`) is allowed, and an absolute `to` is turned into its physical repo-relative folder when the config is read. A vendored copy must match upstream exactly, so no build output may land in one. A config is rejected when a vendor folder is, holds, or sits inside the folder its own upstream builds into (for the root upstream, all of `to`), or holds another upstream's output folder, and so is a vendor folder that equals, holds or sits inside another upstream's vendor folder. `init --output-from skills --output-to skills --vendor skills/vendored` is refused for that reason, and `track` and `init` check this before they write the config. A vendor folder inside another upstream's output folder is allowed, such as a tracked upstream's copy inside the root upstream's `to`: the build, `check` and `sync` leave the files of the upstream that builds there out of it, say how many once per command, and the copy stays as the pin has it through a build and a hook commit. Only an edit under `from` is judged, since only those reach the output, so `copy skills/hello/SKILL.md -> .patchbook/config.toml` gives `no problems` and builds nothing. With `from = "skills"` and `to = "out"`, `skills/.patchbook/x.md` builds to `out/.patchbook/x.md`, while `skills/.git/x` is refused.
- **fork.** The repo is upstream plus a `.patchbook/` folder. The build writes the patched tree over the repo root, leaving `.patchbook/` and any vendored copies alone. A vendored copy must match upstream exactly, so no build output may land in one. A config is rejected when a vendor folder is, holds, or sits inside the folder its own upstream builds into (for the root upstream, the whole repo), or holds another upstream's output folder, and so is a vendor folder that equals, holds or sits inside another upstream's vendor folder, and a mount at or inside `.patchbook`, or with a part git reads as `.git`, as in the folder layout. A mount is normalised when the config is read, so `./lib` and `x/../lib` mean `lib`, and a mount that is absolute or climbs out with `..` is rejected. `track` and `init` check this before they write the config. `init --vendor` is refused in the fork layout, because the root upstream builds into the whole repo and no vendor folder can pass these checks. Use `track --vendor` for another upstream. A vendor folder inside another upstream's folder is allowed: the build, `check` and `sync` leave that upstream's files out of it, and say how many once per command. A change that adds, copies or moves a file into a vendored copy, into the repo's own `.patchbook` in any letter case, or to a path with a part git reads as `.git` (the rule for mounts) is reported `invalid`. A `.patchbook` or `.git` destination makes the build refuse it and the hook refuse the commit, and a vendored-copy destination makes the build refuse it while the hook warns and commits. Both layouts judge an edit by where its file lands, and in the folder layout only an edit under `from` lands anywhere. A `./.patchbook/x` or `.//.patchbook/x` spelling is not matched by this rule either. It is an unsafe edit path (see Trust), so `status` reports it as `invalid` and the hook refuses the commit with the unsafe-path message. If the root upstream has a `.patchbook/` of its own, `clone` removes it, and the build leaves it out. `check` and `sync` leave it out of the files they report and carry. An upstream mounted at a folder keeps its `.patchbook/` as ordinary files, in the build, in `check` and `sync`, and in a vendored copy. Patchbook never reads upstream's config, so a folder upstream vendors for itself is built like any other. Upstream's files in the tree are build output. To change them, edit them in place, then run `patchbook record` to move the edit into the patchbook.

## Several upstreams

A patchbook can follow any number of upstreams. Each has a name and a mount, the folder of the staged tree its files appear under. One upstream may mount at the root. In a fork, that is the fork's own upstream. Every path in an edit, a block entry, or a check is a staged path, so `move extra/skills/tool -> skills/tool` ships one skill from an upstream mounted at `extra`.

`patchbook track <name> <url>` follows another upstream. `check` reports each one, and `sync` moves every pin, or one with `sync <name>`.

## The upstream store

A repo holds only what it changed. Each upstream lives once per user, in the store (`~/.local/share/patchbook/upstreams/`, or `$PATCHBOOK_HOME/upstreams/`), as a git repo with each pinned commit fetched and referenced, so `git gc` keeps it. A commit that `check` only looks at gets no reference and gc prunes it. `check` references the pin when the store has it and never fetches it just for that. A read of a pin that cannot write its reference, such as one in a read-only store, warns and goes on. `sync` keeps the new commit before it rewrites the vendored copy, so a reference it cannot write fails it with the copy as it was, and any failure after that removes the reference again, unless the commit was kept before, so no reference is left for a commit that did not become the pin. A sync that fails, such as one whose new vendored copy does not hash to upstream's tree or one that cannot write a change file, leaves the vendored copy, the change files, `last-sync.json` and `upstream.lock` as they were, and removes any folder it made for a first vendored copy. It moves the old copy into `.patchbook/sync-<name>/`, which git ignores, with each file it will write over, checks the new copy where it will stay, and writes the lock last. A sync that is killed leaves that folder behind. The next `sync` or `track` first finishes or undoes every upstream's folder, since each one saves `last-sync.json`, and a folder it can do neither with stops it and is left for the user. Once a sync is finished or undone, deleting its folder is best effort. A part it can't delete, such as a read-only folder in the old copy, moves into `left/` inside the folder, where git still ignores it and the next sync does not trip over it. While the upstream is tracked, every later `sync` or `track` tries the delete again, and each `sync` of that upstream warns until it is gone. A part it can neither delete nor move would be taken for the next sync's own, so a sync of that upstream with something to write stops before it starts and names the part. Every repo that follows the same upstream shares it.

A fork's own upstream lives in the fork's repo instead. A sync doesn't put the new pin in the fork's history, so each pin is fetched into the repo from the upstream's `remote` and referenced under `refs/pins/`. A push leaves those references out, so each clone of the fork fetches the pin the first time a command needs it, which needs read access to upstream. A clone that has a pin keeps it if upstream goes away. A new clone can't build once upstream deletes the pinned commit, and a fork can't keep a vendored copy of its own upstream.

The store is data, not a cache: it is the only local copy of the unchanged upstream files. If it is lost, the tool fetches each pin again by commit. That fails only if upstream deleted the commit, which is the case for keeping a vendored copy: set `vendor = "<folder>"` on an upstream, and sync keeps a byte-for-byte copy in the repo, which the build checks against the pin. Every sync replaces that folder, so a config is rejected when the vendor folder is the repo root, is outside the repo (`..`, a sibling, an absolute path elsewhere, or a path behind a link that leads out or leads nowhere), or is at or inside `.patchbook` in any letter case, or has a part git reads as `.git`. It is also refused when the folder holds a `.git` anywhere inside it, under any name git reads as `.git` and as a file or a folder, such as a repo of its own or a linked worktree. `git mktree` can store a `.git` in an upstream tree, so `track` and `sync` first refuse an upstream with a path that has a part git reads as `.git`. The message names the upstream and the path, and the refusal comes before the journal and before any write, so no sync is left half done and other upstreams keep syncing. Past that, patchbook treats any `.git` in the copy as the user's, and a sync would move it away and delete it. A folder in the copy that the check can't list is refused too, by name, since it might hold one. The message says to make it readable, move it out of the folder, or change `vendor`. `init` and `track` check all of this before they write the config, and `sync` checks the folder at the start, so a refusal writes and moves nothing for that upstream. `sync` with no name pins the upstreams before the refused one first. Only those three check for a `.git`. `status` and `build` fail on a nested repo with no commit with git's own error. With a commit they crash with `EISDIR` at `readDisk`, as they did before this check. A killed sync's folder that names such a vendor folder is left for the user, never deleted or renamed onto, and so is one whose vendor folder now holds a `.git` or a folder that can't be listed, because finishing the sync would delete it. The message says to move the `.git` out and sync again. `sync` checks again right before it takes the copy, and once more in `old/` after the copy moved there. A repo found in `old/` goes back with the copy, the sync leaves no journal and no pin change, and it refuses with the same message. Recovery checks again directly before it deletes the copy, and when that refuses the journal stays. What is left is the gap between a check and the filesystem call that follows it, with no git call between. A `.git` made in that gap is still lost. A copy that is empty or missing fails that check with a message that names `sync` and the `vendor` line of the config. So does a copy that is a file or a link, and one that a `.gitignore` rule hides whole, where the message names the rule. The pre-commit hook replaces whatever the index holds under the vendor folder with the pin's tree, such as the removal left by `git mv`, what a killed `sync` staged, or a file at the vendor path. The pin is the one the `upstream.lock` in the index names, read through a staged link as the build reads it. A `sync` that was not staged leaves `upstream.lock`, or the file in the repo that a staged link there points to, with changes that aren't in the commit, so the hook stops the commit and the new copy never reaches it. If the index holds no lock, or none for that upstream, the hook leaves that folder alone. The hook takes the copy from the pin and never reads the working tree to stage, so a commit that runs the pre-commit hook never records a vendored copy that differs from the pin. `git merge` and a `git cherry-pick` without `-n` do not run that hook. The hook touches nothing outside the folder, except that in the folder layout a file staged at a parent of the folder, such as `vendor` for `vendor/extra`, gives way to the copy. In the fork layout the copy takes that file's place too, but the hook first records the file as a hand edit, as it does any staged output file, so the next `build` refuses to write it over the folder. The hook puts the pinned copy back into the index, so `git rm --cached -r` on it is undone, and it says so: for each upstream whose folder it changes, it prints a line on stderr that names the folder and says the hook staged the pinned copy in place of what the index held. When that leaves nothing to commit, because the index matched HEAD after the replacement and did not before it, the hook refuses the commit with exit 1, leaves the index as it was and says so, since git decided the commit was not empty before the hook ran. For a staged removal of the copy, the refusal says to delete the upstream's `vendor` line to stop vendoring it. `git commit --allow-empty` on an index that already matched HEAD is not refused, and with a staged removal of the copy it is refused like any other commit. Before it changes the index, the hook checks that each pin tree is in the repo. When one is missing, or the `upstream.lock` in the index can't be parsed, it refuses with exit 1 and a message that names the vendor folder and the tree, or the lock, and leaves the index alone. Any other failure in the step puts the index back as it was. The hook skips this step only in a partial commit, where `git commit <path>` runs it on `next-index-<pid>.lock` in the git dir, so that commit records only that path. Any other index file, such as one set with `GIT_INDEX_FILE`, gets the same replacement as the default index.

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
  last-sync.json         the last sync's report for each upstream; ignored by git, so it stays in the checkout that synced (see Sync)
  .gitignore             written by `sync`: ignores `last-sync.json` and itself, so it is never untracked either
  sync-<name>/           ignored by git: what a sync writes over, so a failed or killed sync is undone; a kill or a failed delete leaves it for a later sync (see The upstream store)
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
- **Vendor folders.** Every sync replaces the folder a `vendor` line names, so a config is rejected when that folder is the repo root, is outside the repo, is in `.patchbook` in any letter case or has a part git reads as `.git`, and `init`, `track` and `sync` also refuse one that holds a `.git` or a folder they can't list (see The upstream store).
- **The hook.** A bad change name or an unsafe edit path makes the pre-commit hook refuse the commit, before it records, builds or stages anything. The working tree, the index and `.patchbook/` stay as they were, so a hand edit in the output is not lost. The refusal names the problem and how to fix it, and `PATCHBOOK_HOOK=0` skips the hook once. Any other problem that `status` reports only skips the build, with a warning. The build's own safety checks still stop a commit. A change whose file really goes outside the output through a link makes the hook fail and leaves everything as it was, while `status` reports no problems.
- **Block entries.** Their file names come from the files under `blocks/`, so they can't be spelled with such a path.

Patchbook does not check for links inside `.patchbook/`. A link in `blocks/` is read and written through, and a link at `changes/<name>/ours` is copied into the output as a link by `build`, while `show` reports the length of the link's target path, not the size of the file it points to. A link there can make patchbook read or write outside the repo. Issue #93 tracks links inside `.patchbook/`. This is why a change to `.patchbook/` needs the same review as a change to `hooks.ts`.

## Sync

- `patchbook check` compares each upstream's head with its pin. It exits 0 when all are up to date and 10 when any has moved, and prints JSON. A fork's upstream moved only if a file outside upstream's own `.patchbook/` changed, so a commit that touches nothing else exits 0. `sync` still pins such a commit when asked, since the pin is the raw commit and tree, and it reports no changed files for it.
- `patchbook sync [name] [ref]` fetches each upstream (or the named one, at a ref) into the store, and updates its pin and its vendored copy, if it keeps one. Then it carries every change on that upstream's files forward:
  - **file edits**: `git merge-file` with base, ours, and the new upstream file. A clean merge updates ours and sets base to the new upstream file. A conflict leaves markers in ours and reports **conflict**. A file upstream deleted or moved reports **gone**, with likely new paths.
  - **block entries**: an entry whose paragraph changed reports **orphan**, with the nearest new paragraphs.
- When upstream still matches the pin, `sync` hashes the vendored copy. If the copy does not match the pin, such as one that is empty, missing, edited by hand, half written, or a file or a symlink in place of the folder, `sync` writes it again and says so. A symlink is moved into the folder with the old copy, never followed, and comes back as a link if the rewrite fails or is killed. As in a sync that moves the pin, the old copy waits in `.patchbook/sync-<name>/` until the new one checks out. It leaves the change files, `last-sync.json` and the lock alone. A failed or killed rewrite puts the copy back as it was, and the next `sync` writes it again. If the lock has changed since a kill, the folder is left for the user, as for a killed sync that moves the pin.
- **`last-sync.json` is ignored, not committed.** It holds each upstream's latest report (`{version: 1, upstreams: {<name>: {from, to, ...}}}`, see JSON output), kept across runs, so it is state of one checkout. Every `sync` that ends with the file on disk, even one with nothing to do, makes sure `.patchbook/.gitignore` lists `last-sync.json` and `.gitignore`, appending what is missing and leaving the bytes already there as they are. Writing the rules is best effort: if the file can't be read or written, `sync` prints a `patchbook:` warning that `last-sync.json` stays untracked, and its own result and exit code are unchanged. A repo made before this gets the ignore on its next sync, with no step for the user. The file ignores itself, so while neither file is tracked a sync leaves nothing untracked and `git add -A` adds neither; a repo that committed either one sees it modified. Why ignored:
  - A report says what one sync did. Committed, a daily update in a fresh worktree would read last week's entry for an upstream that has not moved since, with nothing to tell it from today's, and each sync commit would carry a report that goes stale at the next one.
  - Its readers cope without it. `status --json` shows `last_sync: null` and `upstream <name> --diff` asks for `--since <commit>`. The update skill reads it right after its own `sync`, in the same worktree.
  - The sync journal already treats it as local state: it saves the file and puts it back when a sync fails, and keeps its own folder out of git the same way.
  - A repo that already committed the file keeps it tracked, since an ignore does not untrack a file. `git rm --cached .patchbook/last-sync.json` ends that, and sync does not run it for the user.
- `patchbook status [--json]` lists the problems, what sync merged on its own, and how much upstream changed in each file we touch.
- `patchbook record [change] [--intent ...]` takes the output files in the working tree edited by hand since the last build (per `build.lock`) and moves each edit into the patchbook. In a file with block entries, each changed paragraph updates its entry, or gets a new `policy` entry; a new paragraph joins the one before it, and a paragraph put back as upstream had it loses its entry. Other edits become `file`, `add` or `delete` edits based on the pinned upstream. An edit to a file that a change already owns goes to that change. For the other edits, a model reads their diff and writes the intent if you didn't. Without a change name, the model also picks one: an existing change the edits serve, or a new name. If you give an intent but no name, the model isn't called: the change is named from the intent's first four words, dropping any that would take the name past 40 characters. Any intent is kept on one line, with each run of whitespace a single space, and a blank intent counts as none.
- A pre-commit hook does `record` and `build` on each commit, and stages what they change, so the usual loop is: edit, stage, commit. It records what is staged, not the working tree, so unstaged changes and untracked files stay out of the commit, and `git commit <path>` records only that path. The build reads the patchbook on disk, so the commit stops if a patchbook file it reads (`blocks/`, `changes/`, `series`, `build.lock`, `config.toml`, `upstream.lock`, `hooks.ts`, or a `[placeholders.<kind>] file` outside the output) has changes that aren't in the commit. It stops too on a placeholder file in the output whose unstaged changes the last build didn't write. A staged output file is the build's when it matches its entry in HEAD's `build.lock` or the index's, and a hand edit otherwise. A staged file that matches neither, while its working copy matches the last build and the commit changes the patchbook, may be an older build's output, so the hook stops. Its message gives a `git add` that commits the last build and a `git checkout` that records the staged copy. The hook writes the build to disk wherever the disk differs, except over unstaged work that matches neither the index nor the last build: it leaves that alone, and stops if the build would stage that file. It also stops on a file removed from the index but kept on disk, as `git rm --cached` does. Output that git ignores goes to disk but not into the commit, as with `build --commit`. The patchbook can't record a file edit's executable bit, so a mode you stage is committed as staged, and the build's mode goes only to disk. Under `core.fileMode=false` the hook ignores the executable bit, as git does. The hook is a short script that runs `patchbook hook run` from `PATH`, so upgrading patchbook upgrades the hook. If `patchbook` isn't on `PATH`, it says so and lets the commit through. While git runs hooks from `.git/hooks`, `clone`, `init`, `record`, `build`, `sync` and `track` install it in the repo if it's missing, so a fresh clone gets it on first use. They skip a patchbook that sits in another git repo than the one you're in. If the file is patchbook's own and isn't executable, they make it executable again; another tool's file they leave alone, and `hook install` says git ignores it. `clone` says the hook records only when it does, and otherwise names the setting that turned it off. `status`, `check`, `show`, `upstream` and `config` never write a hook, and nothing installs one while `hook.enabled` is off. `patchbook hook install` installs it by hand. A hook manager moves the hook git runs. Vite+ and husky set `core.hooksPath` to their own folder, and lefthook and the pre-commit framework put their dispatcher in `.git/hooks`. So `clone`, `init` and `hook install` find the hook git will run. In a Vite+ (`.vite-hooks/pre-commit`) or husky (`.husky/pre-commit`) script, they put lines first that call `patchbook hook run`, and in a fork record that edit as the change `patchbook-hook`. For lefthook, the pre-commit framework and any other hook, they print the lines to add. For lefthook they print them in the format of its config file (`lefthook.yml`, `.yaml`, `.toml`, `.json` or `.jsonc`, also under a leading dot or in `.config/`), and for the pre-commit framework as an entry. Where the config already has the `pre-commit` or `repos` key, they print only what goes under it, and say where; in lefthook's YAML and JSON they go one level deeper if `commands` is there too. The lefthook command and the pre-commit entry run the same guarded lines as a script, through `sh`. They never edit a config file, and never write into the `_` dispatcher folder that Vite+ and husky point git at, or into another tool's hooks folder. They don't write through a symlink either; a script reached through a link gets the lines printed. What patchbook adds to a manager stops the commit when `patchbook` isn't on `PATH`, because a commit that skips recording leaves the output and `build.lock` out of step. That holds for the lines in a script, the lefthook command and the pre-commit entry alike. They say how to install patchbook and how to skip the hook once, and `PATCHBOOK_HOOK=0` skips under every manager. They do nothing in a repo without a patchbook, so they are safe in a hooks folder every repo shares. When it puts the lines in a script, patchbook inserts them as bytes, so the rest of the file is as it was, including bytes that aren't UTF-8. `patchbook hook install` stops with an error in a git repo that sits inside another repo's patchbook, because it would install the other repo's hook. `patchbook status` warns on stderr when git runs no hook, or the hook it runs doesn't call patchbook. A manager that hasn't installed its hook in this checkout, as in a new git worktree before `npm install`, leaves git running nothing, and the warning names the manager's install command (`npx husky`, `vp config`). `patchbook hook status` prints the same facts on stdout: whether `hook.enabled` is on and where that setting came from, the file git runs, and whether it calls patchbook. It never writes. A failed hook run puts the patchbook and the output back as it found them, so the retry records from scratch; the hook stops before it writes anything if `blocks`, `changes`, `series` or `build.lock` in the patchbook is a link, or a link sits in `blocks/` or `changes/` other than a recorded symlink (a `.pb` copy in a change's `base` or `ours` that links to a file, which the record replaces). A linked `config.toml` or `upstream.lock` is fine once the link is staged or committed, since the hook never writes them. If the patchbook has problems, it records but doesn't build, and says so. Three things are the exception. They are a change whose output lands in `.patchbook` or at a part git reads as `.git`, an edit path that isn't a clean path inside the tree, and a change name outside `[a-z0-9][a-z0-9-]*`. The hook refuses the commit before it records, builds or stages anything, and names the problem. It does the same for a new file you add by hand in the output at a path that lands in `.patchbook` in another letter case, or at a part git reads as `.git`, such as `.PATCHBOOK/x.md` on a case-sensitive filesystem or `a/.GIT/y`. The book's own `.patchbook/` folder is the book, not output, and commits normally. Any other problem that `status` reports, a destination in a vendored copy included, only skips the build with a warning. The build's own safety checks still stop a commit. A change whose file really goes outside the output through a link makes the hook fail and leaves everything as it was, while `status` reports no problems. `PATCHBOOK_HOOK=0 git commit` skips it once, and `PATCHBOOK_INTENT="..."` gives the intent instead of the model.
- Intents are written by Claude Haiku 5.5 at medium effort through the `claude` CLI, or GPT-6-Luna at high effort through `codex`: Claude if it's installed, unless the settings choose.

## JSON output

The update skill and other agents read three JSON documents: what `patchbook check` prints, what `patchbook status --json` prints, and `.patchbook/last-sync.json`, which `patchbook sync` writes. `CheckJson`, `StatusJson` and `LastSync` in `src/api.ts` are their types. The code that writes `check` and `last-sync.json` is typed against them. So is `status --json`, except `upstreams` and `last_sync`, which it copies from the files as they are. With patchbook installed from npm, `import type { CheckJson } from "patchbook"` gets the same types.

**Versions.** Each document has its own integer `version`, the first key. All three are 1. A version goes up when a field is removed or renamed, changes type, or means something else. A new field leaves it alone, so a reader ignores keys it doesn't know. So does a new `problem` kind, or a new prefix in `files`, so a reader treats a value it doesn't know as unknown and does not fail. A `last-sync.json` with no `version` was written before the field existed. It has the version 1 shape, and patchbook reads it as it reads a new one. `status --json` shows `last_sync` as the file has it, so for an older file `last_sync` has no `version` either.

In the tables, `<name>` is an upstream's name.

### `patchbook check`

Printed on stdout. Exit 0 if no upstream moved, 10 if any did.

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `1` | |
| `moved` | boolean | Any upstream moved. |
| `upstreams.<name>.pinned` | string or null | The pinned commit, null when nothing is pinned. |
| `upstreams.<name>.head` | string | The commit at the head of the upstream's branch. |
| `upstreams.<name>.moved` | boolean | The head's files differ from the pin's. A new commit with the same files is not a move, and in a fork neither is one that changes only upstream's own `.patchbook/`. |
| `upstreams.<name>.files` | string list | Empty unless `moved`. Otherwise `added <path>`, `changed <path>` or `deleted <path>` for each file that differs, sorted by path. Paths include the upstream's mount. Files the build leaves out aren't listed. |

### `patchbook status --json`

Printed on stdout. Exit 0 if `problems` is empty, 1 if not.

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `1` | |
| `upstreams.<name>.commit` | string | The pinned commit, from `upstream.lock` as the file has it. |
| `upstreams.<name>.tree` | string | The pinned commit's tree hash. |
| `applied` | integer | The number of edits that apply at the pins. |
| `problems` | list | The problems, as below. |
| `last_sync` | object or null | `last-sync.json` as the file has it, or null if there is none. |

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
| `orphan` | `file`, `hash`, `kind`, `rules`, `intent`, `upstream`, `patched`, `nearest` | An entry whose paragraph changed upstream. `kind` is `translation`, `policy` or `keep`. `nearest` is a list of `{line, hash, similarity}`, where `similarity` is a number from 0.4 to 1. |
| `check` | file, `detail` | A problem the repo's `check` hook reports. A hook may return any kind. |

### `.patchbook/last-sync.json`

Written by `patchbook sync`. It has an entry for each upstream in the config that a sync has moved, in config order. Each entry is the report of the latest sync that moved that upstream, so entries can come from different runs. A sync killed after it writes the report and before it moves the pin leaves an entry for a move `upstream.lock` does not hold, until the next `sync` puts the report back. An upstream no sync has moved has no entry.

`sync` writes the file after each upstream it moves, before it moves that upstream's pin, and keeps the entries of the upstreams it did not move. It drops the entry of an upstream no longer in the config, even on a sync that moves nothing. A file that does not parse counts as empty, and the next sync that writes replaces it. To keep only one run's moves, a reader keeps the entries whose `from` is the upstream's pin before that run and whose `to` is its pin in `upstream.lock` after it.

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `1` | |
| `upstreams.<name>.from` | string or null | The commit pinned before that sync, null when nothing was pinned before that sync. |
| `upstreams.<name>.to` | string | The commit that sync pinned, unless that sync was killed before it moved the pin. Compare it with `upstream.lock` to tell. |
| `upstreams.<name>.upstream` | string list | The files upstream changed, as `files` in `check`. |
| `upstreams.<name>.merged` | list | `{change, path}` for each file edit that merged without conflict. |
| `upstreams.<name>.conflicts` | list | `{change, path, count}` for a text file with `count` conflicts in our copy, or `{change, path, detail}` for a binary file. |
| `upstreams.<name>.gone` | list | `{change, path, maybe}` for a file edit whose file upstream no longer has. `maybe` is up to three added paths with similar names, most similar first. |
| `upstreams.<name>.replaced_upstream_changed` | string list | `<change>: <path>` for each `replace` edit whose file changed upstream. |

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

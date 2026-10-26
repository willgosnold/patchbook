# Changelog

The hand-written part of each release's notes. GitHub's generated notes list the pull requests. This file says what a user needs to know. Paste a release's section at the top of its GitHub release notes.

## Unreleased

### A failed track can be retried, and a missing change copy gets a message

When `patchbook track` failed after its sync, such as when `.patchbook/config.toml` couldn't be written, it left the new upstream's pin in `upstream.lock` and its vendored copy behind. Running it again with another URL was then refused, because the vendored copy it left behind was in the way. Now a failed track puts the lock, the vendored copy and the config back as they were, and the same name can be tracked again.

`patchbook sync` used to stop with a stack trace when a change's `base/<file>.pb` or `ours/<file>.pb` was missing. Now it fails with a `patchbook:` message that names each change, file and missing copy, both copies when both are gone, and changes nothing. Restore the copies, or remove the edit from the change, and sync again (#10).

### An edited copy keeps following upstream

Copy an upstream file, commit so `record` writes `copy skills/a -> skills/b`, then edit `skills/b/SKILL.md` and commit. `record` and the commit hook used to write `replace skills/b/SKILL.md`, a frozen copy, so `skills/b` missed every later upstream change to `skills/a`, and `status` said nothing. Now they write `file skills/b/SKILL.md`, a file edit on the copy's own path whose base is upstream's `skills/a/SKILL.md`. `sync` merges upstream's changes to `skills/a` into it. An upstream change that overlaps your edit is a conflict, which `sync` reports and `status`, `build` and the commit hook refuse, as for any file edit. `skills/a` still builds from upstream, without your edit. An edited rename of a file that a copy still builds from is now `move` plus a `file` edit on the new path, where it was `delete` plus `add`. Once a copy has its own file edit, an edit to its source is a `file` edit as well, where it was a `replace`. Deleting the edited copy takes its file edit out of the change and records a `delete`. A copy recorded as a `replace` before this release stays one (#317).

### A partial commit can't move the upstream pin without its vendored copy

`git commit -- note.txt .patchbook/upstream.lock` after a `patchbook sync` used to commit the new pin and leave the vendored copy at the old one, and a clone's `status` then failed with `vendor/extra (tree ...) differs from the pin`. The hook now refuses that commit before it records or builds anything, and names the upstream, the lock and the vendor folder. Add the lock and the folder to the paths you name, or run `git add` on the lock, and on the file it points to when it is a link, and make a full commit, where the hook stages the pinned copy. When the lock is a link to a file in the repo, name that file too. When git doesn't know a path yet, such as the folder of a first vendoring, the message says to `git add` it first, since `git commit -- <path>` fails on a path git doesn't know. A refused commit leaves HEAD, your index and your working files as they were. A partial commit that doesn't move the pin, such as one that only names `note.txt`, is not refused by this check, including when HEAD's lock is a link that leads out of the repo. A copy that differs from the pin still gets the message that it differs from the pin. The message for an unstaged `upstream.lock` gives the same advice. It names the lock, the file a linked lock points to, the copies, and any other unstaged build input, where it said that naming the lock alone was enough (#227).

### Resolve change conflicts before committing

After a conflicted `patchbook sync`, the commit hook now refuses the commit and names the change's `ours/<file>.pb` to resolve. Previously it warned and committed the conflict markers. The check covers every change, including a copy hidden by a later edit, and patched paragraph entries. Resolve the markers in the named file, stage it, and commit again. A refused commit leaves HEAD, the index and the working files unchanged. If recording staged output would introduce markers, the hook restores that recording, refuses the commit and names the staged file to fix (#276).

Markers that upstream itself holds don't stop a commit. For a copy that the last sync reported as conflicted in `.patchbook/last-sync.json`, the hook refuses while the copy holds a conflict block, from a `<<<<<<<` line through the next `>>>>>>>` line, that its base copy holds fewer times. So it catches the conflict even when upstream's file holds marker text of its own. That holds only until the sync is committed, meaning HEAD's `upstream.lock` pins the report's `to` commit for that upstream. Once you have resolved the copy and committed, a later edit inside upstream's literal block commits as before. For any other copy, or for every copy when `last-sync.json` is missing or can't be read, it refuses only when the copy holds more marker lines than its base copy. A HEAD with no commit, no `upstream.lock`, an `upstream.lock` that is a link or doesn't parse, or no entry for that upstream pins nothing, so a listed copy gets the block rule. It refuses a paragraph entry whose patched text holds more marker lines than its upstream text.

### A failed model call no longer leaves new paragraph entries without an intent

When the model failed, `record` and the commit hook wrote a new paragraph entry with an empty intent. `status` reported the entry as a problem, and `build` refused until you ran `patchbook intent`. Now patchbook writes the entry's intent from the paragraph edit and labels it `intent (by patchbook):` in the entries file, as it does for a change, so the build goes ahead:

```
$ PATCHBOOK_PROVIDER=none patchbook record
entry    dup.md [79aeaf7ba450] added
entry    dup.md [230d8358dc8e] added
intent   by patchbook for dup.md [79aeaf7ba450], dup.md [230d8358dc8e] (intent.provider is none). To replace them, run `patchbook intent` or edit their lines to `intent: <yours>`
$ patchbook status
note      dup.md [79aeaf7ba450]: patchbook wrote its intent from the paragraph edit. To replace it, run `patchbook intent` or edit its line to `intent: <yours>`
note      dup.md [230d8358dc8e]: patchbook wrote its intent from the paragraph edit. To replace it, run `patchbook intent` or edit its line to `intent: <yours>`
4 edits apply at up 123ec94; no problems
```

The intent names the start of upstream's paragraph and says whether the edit rewrote or deleted it, as in `Rewrites the paragraph that starts "body" in dup.md.`, so descriptions can coincide, as when paragraphs of one file start alike, and the hash in each entry's label tells the paragraphs apart. `patchbook intent` replaces it through the model, or you can rewrite the line as `intent: ...`. A later record that edits the same paragraph with no model writes it again, unless you give an intent with `--intent` or `PATCHBOOK_INTENT`, which replaces it as it fills an empty one. An entry whose intent someone wrote keeps its intent. An entry that already has an empty intent still keeps it empty after a failed model call (#349) (#331).

### Hook manager lines paste into your existing config

`patchbook hook install` prints the lines to add to a lefthook or pre-commit config. Pasted as printed, they broke some configs: a four-space lefthook YAML, pre-commit's own `sample-config` layout with items at column 0, and lefthook JSON where another hook holds the `commands` all failed to validate. It now reads the config, writes the lines in its indent, and says where they go: at the end of the file, directly below a line, or as the first member of a JSON object with its comma. Patchbook also runs first in lefthook when another command has priority 1 or the hook uses `jobs`. The `post-merge`, `post-checkout` and `post-rewrite` lines for lefthook and pre-commit are now a command or a hook in the config, not shell to paste into a script. Patchbook recognizes its own hook, whatever the entry is named, when it is the lines it printed or a bare `patchbook hook run` that nothing skips or limits to some files. In lefthook the bare call may end in `|| exit 1` or `|| true`. In pre-commit the hook must run at the commit stage, set on the hook or inherited from `default_stages`, and have no `args`, which pre-commit adds to the entry and patchbook rejects. Text that only mentions the call, such as an `echo`, gets the lines printed, and so does an unrelated entry named `patchbook`, which is named in the by-hand merge instead of leaving you with nothing. The pre-commit entry has `stages: [commit]` so it records on a commit and not after a merge. That spelling works on every pre-commit version, but pre-commit 4 warns on each commit that `commit` is a deprecated stage name. From pre-commit 3.2 you can silence the warning by writing `stages: [pre-commit]`, which pre-commit 3.1 and older reject (#126).

### Skip checkout builds when the inputs stay the same

The post-checkout hook now compares the old and new commits before it rebuilds. It skips the build when `.patchbook` and configured placeholder files are unchanged, including placeholder files inside the output. Missing revisions, custom build hooks, vendored upstreams and linked inputs still trigger a build. Existing patchbook-owned checkout hooks and hook-manager snippets are upgraded when hooks are installed (#338).

### Branches that each record a change merge without a conflict

Two branches that each recorded a change conflicted in `.patchbook/series` and `.patchbook/build.lock`, even when the changes touched unrelated files, because every record and build writes both files. `init` and `clone` now write `.patchbook/.gitattributes`, which tells git to merge `series` and `build.lock` with its built-in `union` driver, so a merge keeps both sides' lines and needs no git config. `build` adds the file to a fork that lacks it, and the next commit stages it. After the merge, run `patchbook build`: the unioned `build.lock` can list a path twice until it rewrites the lock (#334).

```
$ git merge b2
Auto-merging .patchbook/build.lock
Auto-merging .patchbook/series
Merge made by the 'ort' strategy.
```

### A conflicted `build.lock` or `series` is reported

`status` said "no problems" when only `build.lock` had conflict markers, because every marker line was read as a lock entry (`<<<<<<< HEAD` as a path `HEAD`, `=======` as an empty path), and `build` read the same lock without a word. A marker is no longer an entry. `status` reports it, and `build` rewrites the lock:

```
$ patchbook status
conflict  build.lock: has merge conflict markers; run `patchbook build` to rewrite it
```

In `series`, `status` reports one conflict instead of an invalid change name for each marker line, and `build` and the commit hook refuse until you keep both sides' names:

```
conflict  series: has a merge conflict; keep both sides' change names, then run `patchbook build`
```

(#334)

### A plain `git pull`, `git checkout` or `git rebase` rebuilds the output

Patchbook installed only a pre-commit hook. After a pull, a branch checkout or a rebase brought in changed `.patchbook` data, the built files stayed as they were until the next commit or `patchbook build`, and `status` said nothing. Now `clone`, `init`, `build` and `hook install` also install `post-merge`, `post-checkout` and `post-rewrite` hooks that run `patchbook hook build`. It rebuilds the output and `build.lock`, quietly unless a file changed. `post-checkout` builds for a branch checkout, not `git checkout -- <file>`, and `post-rewrite` for a rebase, not an amend. `PATCHBOOK_HOOK=0 git pull` skips them once, and `hook.enabled` turns them off. Husky and Vite+ get the lines in their `post-*` scripts, and lefthook, the pre-commit framework or a hook of your own get the lines to add, as for pre-commit. Git ignores a post hook's exit code, so a build that can't run, such as one that finds problems or hand edits it won't overwrite, says why and leaves the git command done (part 1 of #303).

```
$ git pull
patchbook: rebuilt 1 file from extra a86baa4, up 3635d41
```

`status` also notes an output that is behind the patchbook, which covers a commit, a sync or a merge that skipped the hooks:

```
$ patchbook status
note      the output is behind the patchbook: skills/x/SKILL.md differs from a build. Run `patchbook build`.
2 edits apply at extra a86baa4, up 3635d41; no problems
```

## 0.0.3

### A new change gets its intent instead of going to `pending`

When a record started a new change, the model had to put the intent under the name it had just chosen for the change. It often put it under the changed paths instead, as on a rename or a commit that touched many files. `record` then couldn't use the reply, put the edits in a change called `pending` with an empty intent, and `build` refused until you ran `patchbook intent`. Now the reply has its own field for the new change's intent, so the model has no key to guess. Replaying real prompts, a one-file rename went from 10 of 10 replies unusable to 0 of 10 (#319).

### The model sees a rename or a copy as one

The intent for a recorded `move` was written from a diff that showed the new path as an added file, listed twice, and never named the old path. A `copy` showed as a whole new file. So the intent described a new skill instead of the rename or where the files came from. Now the model sees the edit line, such as `move skills/a -> skills/a2` or `copy extra/skills/x -> skills/x`, and only what you changed in the file, diffed against the moved file (#320).

### Status and build count every edit

`status` and `build` printed `<n> edits apply`, and `status --json` reported `applied`, but the count left out `add`, `replace`, `delete`, `move` and `copy` edits. A change that vendored a skill with a `copy` edit reported 0. Now the count includes every edit that applies, once, however many outputs it reaches, and a later edit that deletes, replaces or moves its file doesn't undo it: a block entry in a file that a `copy` also writes elsewhere is one edit. A `copy` or `move` of a folder is one edit, as `CHANGE.md` lists it (#321).

### Record names the change and writes its intent when the model can't

When the model failed, as with a reply patchbook can't use, a timeout, no `claude` or `codex` CLI, or `intent.provider = none`, `record` and the commit hook put the edits in a change called `pending` with an empty intent. `status` reported it as a problem, and `build` and the hook's build refused until you ran `patchbook intent`. Now patchbook names the change from its edits and writes an intent that says what they do, so the build goes ahead:

```
$ PATCHBOOK_PROVIDER=none git commit -qm "rename a"
rename-skills-a-to-skills-a2: Renames skills/a to skills/a2. Edits skills/a/SKILL.md.
move     skills/a -> skills/a2
file     a2/SKILL.md
intent   by patchbook for rename-skills-a-to-skills-a2 (intent.provider is none). To replace it, run `patchbook intent rename-skills-a-to-skills-a2` or edit its line to `intent: <yours>`
```

`CHANGE.md` labels that line `intent (by patchbook):`, and `status` lists the change as a note, not a problem. To replace the intent, run `patchbook intent <name>`, or rewrite the line as `intent: ...`. While the model fails, the edits always go to a new change or the one you name, never to an existing change the model would have picked. A new block entry still gets an empty intent, and `build` refuses until `patchbook intent` fills it. A `pending` change that 0.0.1 recorded keeps its name, and its intent stays empty until you fill it or a later record adds to that change.

## 0.0.2

### Record writes a copy for a file copied from upstream

When you copied a file from an upstream into the output, such as a skill from a second upstream tracked at `extra/`, `record` and the commit hook wrote an `add` edit with a frozen copy of the file. The file then never changed with upstream, and `status` reported no problems. Now a new file that builds exactly as an upstream file builds is recorded as a `copy` edit, so `sync` and `build` bring in upstream's changes to it. If you copy a whole folder into a new folder, the edit copies the folder, and a file upstream adds to it later ships too (#307).

```
$ git commit -m "ship x"
ship-extra-s-x: Ship extra's x skill.
copy     extra/skills/x -> skills/x
```

A copy you edit before it is recorded, as when you copy a file and edit it in the same commit, is still recorded as an `add`.

Changes recorded with 0.0.1 keep their `add` lines, so those files still don't follow upstream. To redo one, move the file out of the output and run `patchbook record`, which removes the `add` line and its copy. Then move the file back and run `patchbook record <change>`, which writes a `copy` edit into that change.

### Record writes a move for a renamed file

When you renamed an output file or folder with `git mv`, `record` and the commit hook wrote a `delete` of the old path and an `add` of the new one, with a frozen copy. The renamed file then never changed with upstream, and `status` reported no problems. Now a rename is recorded as a `move` edit, so `sync` and `build` bring in upstream's changes to the renamed file. If you also edited the file, as when you change the `name:` line of a renamed skill, the edit is recorded after the move as a `file` edit or as block entries, and `sync` merges upstream's changes into it (#308).

```
$ git mv skills/a skills/a2
$ sed -i 's/^name: a$/name: a2/' skills/a2/SKILL.md
$ git commit -am "rename a"
ship-a-as-a2: Ship a as a2.
move     skills/a -> skills/a2
file     a2/SKILL.md
```

A rename is still recorded as a `delete` and an `add` when the old and new versions keep, in order, less than half of the non-blank lines of the longer one, or when its edit can't be recorded on the moved file, as in a file whose copy uses placeholders. Renames recorded with 0.0.1 keep their `delete` and `add` lines.

### Intents cover every file in a large record

The model was given the diff cut at 40,000 characters, with no list of paths, so on a large record it never saw the later files and the intent named only the first ones. Now the prompt lists every changed path first, and each file's diff gets its own share of the budget. A long record loses detail in its diffs, never whole files (#309).

### An edit that joins an existing change rewrites its intent

When an edit went to a file an existing change or block entry already owned, the change kept its old intent, which then no longer described it. Now `record` rewrites that intent from the change's whole diff, in the same single model call it already makes. If you gave the intent yourself (`--intent` or `PATCHBOOK_INTENT`), or no model answers, the old intent stays and `record` prints a line naming it:

```
intent   may be stale: <change> (<why>)
```

(#310)

`record` also no longer writes two blank lines after an entry with an empty patched side (#311).

## 0.0.1

The first release.

Install it with `npm install -g @patchbook/cli`. The command it installs is `patchbook`. The package is scoped because npm refused the plain name `patchbook` as too close to an existing package.

### Patchbook checks your config when it loads it

Some configs would build once and then break `status`, `build` or the next commit, so patchbook refuses them when it loads the config. The message names the folder and says what to change. If `init`, `clone` or `track` fails, it writes nothing.

- A `vendor` folder that is its upstream's output folder, holds that output, or sits inside it. The same applies to a `vendor` folder that holds another upstream's output, or holds or sits inside another upstream's `vendor` folder.
- A `mount` at or inside `.patchbook` or `.git`, a `mount` given as an absolute path, or one whose `..` climbs out of the repo. Mounts are normalised, so `./lib` and `x/../lib` both mean `lib`.
- An `[output] to` that is any of these: the repo root; outside the repo; inside `.patchbook`; holding or inside a vendored copy; a link; under a link inside the repo; under a file; or containing a `.git` segment in any case.

If you see one of these messages, change the named `vendor`, `mount` or `[output] to` in `.patchbook/config.toml` as it says, then run `patchbook build`.

### Sync reports a conflict instead of guessing where a paragraph goes

`git merge-file` can misplace a `file` edit once upstream moves paragraphs around. This happens when a file holds the same paragraph more than once, and when the fork deleted a paragraph that upstream then moved. In these cases `sync` reports a **conflict** rather than a clean merge, and `status` and `build` refuse until you resolve it:

- an edit to one copy of a paragraph that the merge would put on another copy or leave out;
- a copy the fork deleted that the merge would bring back;
- a copy the fork inserted that the merge would drop because upstream moved another copy to the same spot;
- a paragraph the fork deleted from any file that the merge would bring back because upstream moved it.

Sync names the file on stderr, and `.patchbook/changes/<change>/ours/<file>.pb` holds both texts between conflict markers. Edit it so the file reads as you mean it, then run `patchbook build`. Sometimes the merge sync refuses would have been right. Sync refuses rather than guess (#286, #294).

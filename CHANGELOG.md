# Changelog

The hand-written part of each release's notes. GitHub's generated notes list the pull requests. This file says what a user needs to know. Paste a release's section at the top of its GitHub release notes.

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

### Status and build count every edit

`status` and `build` printed `<n> edits apply`, and `status --json` reported `applied`, but the count left out `add`, `replace`, `delete`, `move` and `copy` edits. A change that vendored a skill with a `copy` edit reported 0. Now the count includes every edit that applies. A `copy` or `move` of a folder is one edit, as `CHANGE.md` lists it (#321).

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

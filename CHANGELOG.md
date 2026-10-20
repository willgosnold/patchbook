# Changelog

The hand-written part of each release's notes. GitHub's generated notes list the pull requests. This file says what a user needs to know. Paste a release's section at the top of its GitHub release notes.

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

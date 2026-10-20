# Changelog

The hand-written part of each release's notes. GitHub's generated notes list the pull requests, and this says what a user must do differently. Paste a release's section at the top of its GitHub release notes.

## 0.0.1

The npm package is `@patchbook/cli`, since npm refused the name `patchbook` as too close to an existing package. Install it with `npm install -g @patchbook/cli`. The command it installs is still `patchbook`.

### Configs patchbook now refuses

These configs used to load, build once, and then break `status`, `build` or the next commit. Patchbook now refuses them when it loads the config, with a message that names the folder and what to change. A failed `init`, `clone` or `track` writes nothing. (#42, #43, #54)

- A `vendor` folder that is the folder its own upstream builds into, holds it, or sits inside it. The same goes for one that holds another upstream's output, or that holds or sits inside another upstream's `vendor` folder.
- A `mount` at or inside `.patchbook` or `.git`, an absolute `mount`, or one whose `..` climbs out of the repo. Mounts are now normalised, so `./lib` and `x/../lib` mean `lib`.
- An `[output] to` that is the repo root, outside the repo, inside `.patchbook`, holding or inside a vendored copy, a link, under a link inside the repo, under a file, or containing a `.git` segment in any case.

If `patchbook status` fails after upgrading with one of these messages, change the named `vendor`, `mount` or `[output] to` in `.patchbook/config.toml` as the message says, then run `patchbook build`.

### Sync no longer guesses which copy of a repeated paragraph an edit is for

A file can hold the same paragraph more than once. `git merge-file` can put a `file` edit of one copy on another copy once upstream moves things around, or drop it, and earlier versions reported that merge as clean. Now `sync` reports a **conflict** instead, and `status` and `build` refuse until it is resolved. (#283, #290)

- An edit of a copy that the merge would put on another copy or leave out. (#283)
- A copy the fork deleted, which the merge would bring back. (#283)
- A copy the fork inserted, which the merge would drop because upstream moved another copy to the same spot. (#290)

Sync names the file on stderr, and `.patchbook/changes/<change>/ours/<file>.pb` holds both texts between conflict markers. Resolve them with the edit on the copy you mean, then run `patchbook build`. Some of these conflicts are merges that would have been right. Sync refuses rather than guess (#286, #294).

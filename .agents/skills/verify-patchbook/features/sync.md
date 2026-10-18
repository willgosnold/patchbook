# Keep up with upstream

A user checks whether upstream moved, moves the pin with `patchbook sync`, which carries each change forward with a 3-way merge, and builds and commits the result. A change that can't merge is reported as a conflict, and the build refuses until it's fixed.

## Sub-features

- `sync-check` reports whether each upstream moved, as JSON, and exits 10 when one did.
- `sync-clean` moves the pin and merges our changes into upstream's new version.
- `sync-conflict` reports a change that can't merge, and `status` and `build` refuse.
- `sync-diff` shows what upstream changed in the last sync.
- `sync-commit` commits the moved pin and the rebuilt output, after which `check` reports nothing moved.

## How to get to it (user POV)

- Run `patchbook check`.
- Run `patchbook sync`, then `patchbook status` and `patchbook build`.
- Run `patchbook upstream <name> --diff`.
- Commit the sync with `git commit`. The `patchbook-update` skill runs the same steps on a schedule.

## Driving it with pb-sandbox

Preconditions:

- A fresh sandbox, sourced, with `doctor` all `ok`, in `$SB/work`.
- A fork with one change far from upstream's next edit: `git init -q -b main up && printf 'a\nb\nc\nd\ne\n' > up/app.txt && git -C up add -A && git -C up commit -qm start`, then `pb clone "$SB/work/up" fork && cd fork && printf 'a\nb\nc\nd\nE\n' > app.txt && git commit -qam "shout e"`.
- Upstream moves: `printf 'A\nb\nc\nd\ne\n' > ../up/app.txt && git -C ../up commit -qam move`.

- **Check.** Run `rec pb check`. Exit 10, and JSON with `"moved": true` and `"files": ["changed app.txt"]`.
- **Sync, clean merge.** Run `rec pb sync`. Exit 0 and `1 upstream files changed, 1 of ours merged cleanly, 0 conflicts, 0 gone.`.
- **Status and build.** Run `rec pb status` (`no problems`) and `rec pb build` (`built 1 files`). Run `rec cat app.txt`. It reads `A b c d E`: upstream's edit and ours together.
- **What upstream changed.** Run `rec pb upstream up --diff`. It shows `-a` and `+A`. Run `rec cat .patchbook/last-sync.json`. `merged` lists `model-name` and `app.txt`.
- **Commit.** Run `rec git commit -qam "Sync upstream"`, then `rec git show --stat --format=%s HEAD`. It has `.patchbook/upstream.lock`, the change's `base` and `ours` copies, and `app.txt`. Then `rec pb check` exits 0 with `"moved": false`.
- **Conflict.** In a second fork whose change edits a line next to upstream's edit (an upstream of `one\ntwo\n`, our edit `ONE\nTWO\n`, then upstream to `zero\none\ntwo\n`), run `rec pb sync`. It prints `0 of ours merged cleanly, 1 conflicts`. `rec pb status` and `rec pb build` exit 1 with `conflict  app.txt: ours has conflict markers`, and `app.txt` is unchanged.
- **Proof.** The transcript has both syncs, the merged `app.txt`, `last-sync.json` and the commit.

## Gotchas

- `check` exits 10 when upstream moved. That's not a failure, so don't stop on a non-zero exit there.
- `.patchbook/last-sync.json` is left untracked. `git commit -a` doesn't add it, which is fine.
- A fresh clone of the fork can't read upstream after the first sync and commit, because the pin isn't in the fork's history (#2). The sandbox's single checkout hides this. Cloning the fork into a second folder shows it.

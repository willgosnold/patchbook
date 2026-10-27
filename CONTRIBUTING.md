# Contributing

Thanks for wanting to help with patchbook. One person maintains it, so this guide is mostly about saving your time and mine. Read it before you open an issue or a pull request.

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Ask before you build

A pull request can go straight in for:

- a typo or a wrong sentence in the docs,
- a bug you can reproduce, with a fix that changes nothing else.

Anything else needs an issue first, and a reply from me agreeing to the direction, before you write the code. That covers new commands and flags, changes to what a command does or prints, and new settings. It also covers anything that touches the files patchbook writes into a user's repo. A PR that skips this step may be closed, even if the code is good, because I may want to solve the problem another way or not at all.

[DESIGN.md](DESIGN.md) describes how patchbook works and what it promises. A proposal that fits that model is much more likely to land than one that changes it.

## What counts as a breaking change

Users commit patchbook's files to their repos and script against its output, so these are public, even before 1.0:

- the commands, their flags and their exit codes,
- the files under `.patchbook/`: `config.toml`, `upstream.lock`, `build.lock`, `series`, `last-sync.json` and the `changes/` folders,
- the JSON that `check` and `status --json` print, which has its own version number (see JSON output in DESIGN.md),
- the hook script patchbook installs and the lines it adds to a hook manager's config,
- the types in `src/api.ts`, which ship to npm as `api.d.ts`.

A change to any of them needs an issue first, and a way for existing repos to keep working.

## Set up

You need [Bun](https://bun.sh) 1.4.3, the version CI uses, and git.

```sh
git clone git@github.com:willgosnold/patchbook.git
cd patchbook
bun install
bun run typecheck
bun test
```

CI also builds the binary and runs the end-to-end tests against it. Run the same check before you open a PR that changes how the binary starts, reads its version or runs a hook:

```sh
bun run build
PATCHBOOK_CMD="$PWD/dist/patchbook" bun test test/e2e/*.test.ts
```

## Tests

Every fix and feature needs a test. CLI behaviour goes in a file under `test/e2e/` named for its area, which builds throwaway repos and runs the real command against them. Shared setup lives in `test/e2e-fixtures.ts`. CI runs the files whose names start with `fork` and `vendor` as their own jobs and every other file together, so a new file needs no CI change. Pure functions go in `test/units.test.ts`.

For a bug fix, the best PR has two commits. The first adds a test that fails on `main`, and the second makes it pass. That lets a reviewer check the test catches the bug.

`qa/` runs user journeys that span several commands, with a fake model or the real `claude` CLI. If you found a bug by using patchbook, add a scenario for it there. [qa/README.md](qa/README.md) says how to run and write them.

## Pull requests

- Solve one problem per PR. A second fix, or a cleanup the fix didn't need, goes in its own PR.
- Write the title as a conventional commit in plain words, such as `fix(sync): keep the vendored copy when a sync fails`. The types in use are `fix`, `feat`, `docs`, `test`, `refactor`, `build`, `ci` and `chore`. PRs are squash merged, so the title becomes the commit message on `main` and the line in the release notes. Your branch's commit messages don't need to follow this.
- Fill in the PR template. Say what was wrong, what you changed, and what you ran to check it, with the output you saw. "Tests pass" on its own doesn't say whether the change works.
- Update README.md or DESIGN.md when the change alters what a user sees or what patchbook promises.
- Open the PR as a draft if it isn't ready for review.
- Don't bump the version in `package.json`. Releases are cut from tags.

CI runs the typecheck, the tests and the build on Ubuntu for every PR. Pushes to `main` run them on macOS as well.

## Using AI tools

Patchbook is built with coding agents, and you're welcome to use them too. The rules are the same for a PR an agent wrote as for one you typed:

- You are the author. Read the diff, run it, and be ready to answer questions about it without pasting them into an agent.
- Name the model and tool that wrote the code, either with a `Co-Authored-By` line in a commit or at the end of the PR description.
- Check what an agent writes into an issue or PR description before you post it. A long report that nobody checked costs more review time than it saves.

## Issues

Ask how to do something in [Discussions](https://github.com/willgosnold/patchbook/discussions/categories/q-a), and use issues for bugs, wrong docs and proposals.

- Search open and closed issues first.
- Check that the bug happens on the latest release (`patchbook --version`).
- For a bug, give the commands that reproduce it in a new repo and what each one printed. The bug form asks for the rest.
- Remove tokens, passwords and private URLs from any output you paste. Git remote URLs can hold credentials.

Report security problems privately. See [SECURITY.md](SECURITY.md).

## What to expect

Either I or my agent will aim to reply within 48 hours. I may ask for changes, rewrite part of a PR before merging it, or close it if it doesn't fit the project. If that happens, I'll say why.

## License

Patchbook is MIT licensed. By opening a PR you agree to license your contribution under the same terms.

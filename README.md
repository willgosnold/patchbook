# patchbook

Patchbook lets you keep your own version of someone else's repo. You change their code however you like, and patchbook writes down each change and why you made it. Then you can keep taking their updates without redoing your work by hand.

It's for anyone who customizes a project they don't own. That might be a fork with features of your own, or a folder of your repo built from another repo's files.

## Why use it

- **A plain fork drifts.** Each upstream release means a merge by hand, and remembering why every change was there.
- **Each change keeps its reason.** Patchbook stores your changes one by one, each with its *intent*, so you can always see how your version differs and why.
- **Updates carry your work forward.** When upstream moves, your changes are re-applied for you. When upstream rewrote the code under a change, an agent redoes it from its intent, or asks you.

## Install

```sh
npm install -g @patchbook/cli
```

The command it installs is `patchbook`. You can also get the binary from the latest [GitHub release](https://github.com/willgosnold/patchbook/releases) with the install script:

```sh
curl -fsSL https://raw.githubusercontent.com/willgosnold/patchbook/main/install.sh | sh
```

Patchbook needs git, and the `claude` or `codex` CLI to write intents.

## Quick start

1. **Start a patchbook.** Fork a repo with its history:

   ```sh
   patchbook clone https://github.com/pingdotgg/t3code
   ```

   Or build part of another repo into a folder of your own:

   ```sh
   patchbook init --upstream <url> --path <folder> --output-to <folder>
   ```

   By default, either one installs a pre-commit hook, hooks that rebuild after a pull, a branch checkout or a rebase, and the `patchbook-update` skill for agents.

2. **Make your changes.** Edit files as usual, stage them and `git commit`. The hook records each edit as a change, and a model writes its intent. To write it yourself, commit with `PATCHBOOK_INTENT="..." git commit`.

3. **Take upstream's updates.** Run these in order, then commit what they changed:

   ```sh
   patchbook check    # has upstream moved? exits 10 if so
   patchbook sync     # move to upstream's latest and carry every change forward
   patchbook status   # list anything that needs fixing
   patchbook build    # write the result
   ```

   Or let an agent do this every day, as [Scheduled updates](#scheduled-updates) shows.

To look at a change, run `patchbook show <change>`. To see your settings, run `patchbook config`.

## Scheduled updates

Ask an agent in the repo to "Use the patchbook-update skill." every day, from T3 Code, cron or CI. It syncs, repairs what broke, tests, and has a second agent review the work. It merges on its own only when nothing is left broken and the update needed no repair or your tests pass. Otherwise it asks you, with a pull request when it has commits to push. [Scheduled updates](DESIGN.md#scheduled-updates) in DESIGN.md has ready-made cron and CI scripts.

## How it works

You edit the code you took from upstream, in place, the way you always would. When you commit, patchbook's hook saves each edit you staged as a change in the `.patchbook/` folder, and rebuilds your version from upstream plus your changes. A model reads the change and writes down what it does and why.

Patchbook pins the upstream commit your changes apply to. `patchbook sync` moves the pin to upstream's latest commit and re-applies each change. A change that still fits is carried over on its own. One that upstream's update broke is flagged as a conflict, so you or an agent can redo it from its intent. When patchbook can't tell where an edit belongs, it reports a conflict rather than guess.

That's why the intent matters most. It's how your change gets redone later, if upstream rewrites the code underneath it.

## Learn more

- [DESIGN.md](DESIGN.md) explains how patchbook works, in full. Good places to start:
  - [Layouts](DESIGN.md#layouts), for forks and folder builds.
  - [Working with git](DESIGN.md#working-with-git), for merging branches that each record a change, hook managers and commits that skip the hook.
  - [Settings](DESIGN.md#settings) and [Config](DESIGN.md#config).
  - [The update skill](DESIGN.md#the-update-skill).
  - [Tool](DESIGN.md#tool), for building from source and running the tests.
- [CHANGELOG.md](CHANGELOG.md) lists what changed in each release.
- `patchbook --help` lists every command, and `patchbook <command> --help` shows its options.
- To contribute, read [CONTRIBUTING.md](CONTRIBUTING.md). To report a security issue, see [SECURITY.md](SECURITY.md).

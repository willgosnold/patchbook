# patchbook

Keep your changes to someone else's repo, each with its intent, and keep pulling from upstream. A build applies the changes to a pinned upstream commit. When upstream moves, an agent redoes the changes that broke from their intent, and asks you only when it can't decide.

See [DESIGN.md](DESIGN.md) for the model.

## Install

```sh
uv tool install git+ssh://git@github.com/willgosnold/patchbook      # the CLI
npx skills add willgosnold/patchbook --skill patchbook-update       # in each adapted repo, for agents
```

## Start

```sh
patchbook clone <upstream url> [dir]                     # fork a repo, keeping its history
patchbook init --upstream <url> --vendor vendor/<name> \
  --output-from <folder> --output-to <folder>            # or vendor it into an existing repo
```

Then change things, `patchbook record <change> --intent '...'`, and `patchbook build`. To keep up with upstream, a daily T3 scheduled task in the repo runs: "Use the patchbook-update skill."

Tests: `python3 -m unittest test_patchbook`.

Used by [wstack](https://github.com/willgosnold/wstack).

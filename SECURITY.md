# Security policy

## Reporting a vulnerability

Report it privately through [GitHub's vulnerability reporting](https://github.com/willgosnold/patchbook/security/advisories/new). Don't open a public issue, pull request or discussion about it.

Include the patchbook version (`patchbook --version`), your OS, and the steps or a script that shows the problem. I'll reply within a week and keep you updated until it's fixed. Once a fix is released, I'll publish the advisory and credit you, unless you'd rather not be named.

## Supported versions

Only the latest release gets security fixes. Patchbook is before 1.0, so a fix ships as a new release rather than a patch to an older one.

## What counts

Patchbook runs git, writes files into your repo, installs a git hook, runs a repo's `hooks.ts`, and sends your edits to the `claude` or `codex` CLI. Report anything that lets an upstream repo, a patchbook or a config file make patchbook do something the user didn't ask for, such as:

- writing outside the repo, or into `.git`,
- running code from an upstream,
- leaking credentials from a git remote URL or the environment,
- getting past one of the refusals listed under Trust in [DESIGN.md](DESIGN.md).

A repo's own `hooks.ts` runs with your permissions by design. That alone is not a vulnerability.

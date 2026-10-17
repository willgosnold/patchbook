---
name: setup-pstack
description: Configure which models pstack uses per role and at what reasoning budget. Detects your available models and writes a project models file that overrides the defaults. Use for /setup-pstack or $setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack

Write `.agents/pstack-models.md` in the project's main checkout (`"$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.agents/pstack-models.md"`, which may not exist). It sets pstack's model per role and overrides the defaults.

## Steps

### 1. Detect available models

Call `orchestrator_capabilities`. Each entry in `providers` lists a provider instance's models and each model's effort options (`effort`, or `reasoningEffort` for `codex`). That is the dependable source. A provider whose `canRunChildTask` is false can't run a role, so leave it out. If you cannot detect any, ask the user to paste the models they have access to. Never write a real model you have not confirmed is available. The alias `inherit-parent` is always valid even though it is not a detected model.

### 2. Load current state

The defaults are the role entries listed in step 5 below. If that file already exists, read it and treat its `# budget:` line and its role entries as the current choices. Otherwise start from those defaults. A line whose role is not in step 5, such as `how critics`, is from a retired role. Drop it.

### 3. Budget, map, and confirm

**(a) Ask for a budget.** Ask in plain text, then end the turn. Offer these four options with these exact labels, and name the current budget when the file records one. With no models file, name the budget whose effort matches the defaults in step 5.

- `unlimited — max reasoning`
- `large — xhigh reasoning`
- `medium — high reasoning`
- `small — medium reasoning`

**(b) Apply it.** Build the working table from the defaults, and on a re-run keep any role you changed by model, list, or alias (`inherit-parent`). `unlimited`, `large`, `medium`, and `small` set the effort of every real entry, panel entries included, to `max`, `xhigh`, `high`, or `medium`, on the ladder `max` > `xhigh` > `high` > `medium` > `low`. Ignore effort options off that ladder. If the model doesn't offer that effort, use the highest effort it offers below it, else mark the role as needing a choice. `inherit-parent` does not change. So under `unlimited`, a model whose efforts stop at `xhigh` runs at `xhigh`.

**(c) Show the roles and confirm.** Show every role with its entries, marking any real entry not in the detected set as needing a choice. Also list each line step 2 dropped. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent` (this role runs on the parent chat model) as the options. Ask in plain text, then end the turn. For panel roles (arena runners, architect runners, interrogate reviewers) the value is a list, and one subagent runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena selects one value from it whose model family differs from the parent's when possible. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.

### 4. Validate

Every real entry written must be a detected model with an effort that model offers. `inherit-parent` always passes. If a chosen real entry is not available, stop and ask again.

### 5. Write the models file

Write that file with a `# budget:` line holding the chosen label and its target effort, and one line per role, using the role names below. Create `.agents/` if it is missing. Overwrite the whole file so re-runs stay idempotent. Shape:

```
# pstack model configuration. One line per role. Delete a line to fall back to the default.
# Entry: <provider>/<model> <effort>. `inherit-parent` runs the role on the parent's model (omit `target`). Alias entries in a panel list still count toward its fan-out.
# budget: <label> (<effort>)
<role>: <entry>, <entry>, ...
```

The roles, in this order, with their defaults:

- `feature, refactoring`: `claudeAgent/claude-sonnet-5-5 high`
- `bug-fix`: `claudeAgent/claude-sonnet-5-5 high`
- `perf-issue`: `claudeAgent/claude-haiku-5-5 xhigh`
- `hillclimb`: `claudeAgent/claude-sonnet-5-5 high`
- `judgment and prose`: `claudeAgent/claude-opus-5-5 high`
- `hardest tasks`: `claudeAgent/claude-opus-5-5 xhigh`
- `how explorer`: `claudeAgent/claude-haiku-5-5 xhigh`
- `how explainer`: `claudeAgent/claude-opus-5-5 high`
- `why investigators`: `claudeAgent/claude-haiku-5-5 xhigh`
- `why synthesizer`: `claudeAgent/claude-opus-5-5 high`
- `reflect tooling`: `claudeAgent/claude-haiku-5-5 xhigh`
- `reflect judgment, divergent, synthesizer`: `claudeAgent/claude-opus-5-5 high`
- `arena runners`: `claudeAgent/claude-opus-5-5 high`, `codex/gpt-6.1-sol xhigh`
- `arena cross-judge pool`: `claudeAgent/claude-opus-5-5 high`
- `swarm workers`: `claudeAgent/claude-haiku-5-5 xhigh`
- `architect runners`: `claudeAgent/claude-opus-5-5 high`, `codex/gpt-6.1-sol xhigh`
- `interrogate reviewers`: `claudeAgent/claude-opus-5-5 high`, `codex/gpt-6.1-sol xhigh`

### 6. Confirm

Tell the user the file was written and that skills read it at each spawn. Re-running this skill updates it. Tell the user to commit the file if worktrees and other people should see it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with the **create-verification-skill** skill." On yes, run the **create-verification-skill** skill (resolves wherever pstack is installed: workspace, user, or plugin). On no, move on without pushing.

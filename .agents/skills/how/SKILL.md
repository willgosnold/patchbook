---
name: how
description: "Use for \"how does X work\", code walkthroughs before changing something, and placement / ownership / layering questions (\"where should this live\", \"which package owns this\", \"is this the right layer\"). Explains subsystem architecture, runtime flow, onboarding mental models. Use why for motivation."
disable-model-invocation: true
---

# How

Explore the codebase to answer "how does X work?" questions. Produce architectural explanations at the level of a senior engineer onboarding onto a subsystem, enough to build a working mental model, not so much that it reads like annotated source code.

Every spawn is a `delegate_task` child with the whole brief in `task`, its own `clientRequestId`, and no `isolation`. Each brief says "Do not edit, create, commit, or push files.", and you run `git status` afterward. Explorers use the `how explorer` line in `.agents/pstack-models.md` in the project's main checkout (`"$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.agents/pstack-models.md"`, which may not exist), else `claudeAgent/claude-haiku-5-5 xhigh`, and every explainer uses the `how explainer` line, else `claudeAgent/claude-opus-5-5 high`. A role line is `<role>: <entry>, <entry>, ...`, and a panel role runs one subagent per entry. An entry `<provider>/<model> <effort>` becomes `target: {providerInstanceId: <provider>, model: <model>, options: {effort: <effort>}}`, with `reasoningEffort` instead of `effort` for `codex`. `inherit-parent` means omit `target`. The effort is a ceiling: lower it for routine work, never raise it, and never set `fastMode`.

## 1. Assess complexity

If the scope is ambiguous, state your interpretation and explore. The user can redirect.

- **Simple** (a single module, a small utility, a narrow question such as "how does function X work"): no explorers. Spawn one explainer that explores and explains in one pass, built from `references/explainer-prompt.md` without the explorer-findings section. Go to step 4.
- **Complex** (a subsystem spanning multiple files or services, a cross-cutting feature, a full architectural overview): go to step 2.

When in doubt, take the simple path.

## 2. Explore (complex only)

Decompose the question into 2 to 4 angles, each a distinct slice of the subsystem. Spawn all explorers in a single message, each with `references/explorer-prompt.md` and its angle filled in.

## 3. Synthesize (complex only)

Once all explorers have returned, spawn one explainer with `references/explainer-prompt.md` and every explorer's findings filled in.

## 4. Present

Present the explainer's output. Light edits for clarity or context from the conversation are fine. Do not substantially rewrite it.

## Output format

The explanation uses the sections defined in `references/explainer-prompt.md`, dropping any that do not apply: Overview, Key Concepts, How It Works, Where Things Live, Gotchas.

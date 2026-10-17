---
name: arena
description: "Spawn N parallel candidates at the same task, pick a base, graft the strongest parts of the losers into it. Use for /arena or $arena, 'arena this', 'throw it in the arena', or when one attempt at a non-trivial artifact would lock in the wrong shape."
disable-model-invocation: true
---

# Arena

Open a step list with one entry per phase (Frame, Fan out, Cross-judge, Pick, Graft, Verify) before launching anything, and keep it current at each phase. Codex keeps it with `update_plan`. Claude Code keeps it in the reply.

## Phase A: Frame

Every candidate gets the same prompt, so the prompt is the contract.

1. State the artifact each candidate is producing.
2. Derive the rubric, 3-6 concrete gradeable criteria for what success looks like on *this* task. It is the picker's tool in Phase D. Candidates only see the task.
3. Pick the runners. Use the `arena runners` line in `.agents/pstack-models.md` in the project's main checkout (`"$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.agents/pstack-models.md"`, which may not exist), else `claudeAgent/claude-opus-5-5 high`, `codex/gpt-6.1-sol xhigh`, one runner per entry. A role line is `<role>: <entry>, <entry>, ...`, and a panel role runs one subagent per entry. An entry `<provider>/<model> <effort>` becomes `target: {providerInstanceId: <provider>, model: <model>, options: {effort: <effort>}}`, with `reasoningEffort` instead of `effort` for `codex`. `inherit-parent` means omit `target`. The effort is a ceiling: lower it for routine work, never raise it, and never set `fastMode`. Spawn more runners when the arena covers multiple design directions. Use the same model N times when the work is generation-bound rather than judgment-sensitive.
4. Give each candidate its own output location (a git worktree where possible, otherwise `/tmp/arena-<slug>/candidate-<n>/`), per the **separate-before-serializing-shared-state** principle skill.

## Phase B: Fan out

Spawn all N subagents in one message: N `delegate_task` calls with `mode: "async"`, each with its own `clientRequestId` and, when its output location is a worktree, `isolation: "worktree"`. A worktree starts from the parent's current local commit without uncommitted edits, so commit the shared grounding first or give it by absolute path. Each `task` holds the whole brief: the task, the path to the shared grounding, its own output path, and instructions to produce the artifact and a short rationale naming the alternatives it considered and what it rejected. Keep each `taskId` and `childThreadId`. Each completion wakes this thread, so end the turn instead of polling.

If a candidate produces no output, proceed with N-1 and note the dropout.

## Phase C: Cross-judge

After all Phase B candidates complete, choose one entry from the `arena cross-judge pool` line in `.agents/pstack-models.md` in the project's main checkout (`"$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.agents/pstack-models.md"`, which may not exist), else from `claudeAgent/claude-opus-5-5 high`. Prefer a different model family from the parent's. Spawn one judge subagent on that entry with `delegate_task`, `mode: "async"`, and no `isolation`. Its brief says "Do not edit, create, commit, or push files.", and you run `git status` afterward. It sees the rubric and the candidates by path label, scores each criterion, and recommends a base with rationale. It runs in parallel with your reading in Phase D. Don't spawn it while candidates are still writing.

## Phase D: Pick a base

Read every candidate end to end before picking. Score each against the rubric criterion by criterion, not on holistic feel, and compare with the cross-judge. Agreement on the base confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous. Read both rationales before deciding.

Pick the base a future maintainer can extend most easily without breaking invariants. When two feel tied, prefer the cleaner boundary or smaller API, per the Laziness Protocol.

## Phase E: Graft

Walk each losing candidate once more for what is worth porting into the base, usually one or two things per candidate, not most of it. Fold each graft in by hand, per the **redesign-from-first-principles** principle skill, so the result stays coherent under one mental model. Don't paste mechanically.

If the candidates converge on one shape, that is strong agreement. Note it and ship the consensus shape. No graft is needed. If they wildly diverge, Phase A was under-specified. Reframe and re-run rather than averaging the divergence.

## Phase F: Verify

Verify the synthesized artifact like any other output, per the **prove-it-works** principle skill. If verification finds a problem the arena missed, either Phase A was wrong (re-frame and re-run) or a candidate caught it and you missed the graft (go back to Phase E). Don't paper over it.

## Outputs

One synthesized artifact, with a short synthesis note alongside naming the base and why, the cross-judge's verdict, each graft with its source candidate, what was rejected and why, any convergence or dropouts, and the verification result.

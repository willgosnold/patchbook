---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm or $swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

## Start

Open a step list with one entry per phase before launching anything. Codex keeps it with `update_plan`; Claude Code keeps it in the reply and updates it at each phase.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
4. Pick the worker model from the `swarm workers` line in `.agents/pstack-models.md` in the project's main checkout (`"$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.agents/pstack-models.md"`, which may not exist), else `claudeAgent/claude-haiku-5-5 xhigh`. A role line is `<role>: <entry>, <entry>, ...`, and a panel role runs one subagent per entry. An entry `<provider>/<model> <effort>` becomes `target: {providerInstanceId: <provider>, model: <model>, options: {effort: <effort>}}`, with `reasoningEffort` instead of `effort` for `codex`. `inherit-parent` means omit `target`. The effort is a ceiling: lower it for routine work, never raise it, and never set `fastMode`. For a model race, name each arm's model up front. Pick each subagent's effort for the job within that ceiling, per the Subagents section of the **poteto-mode** skill.
5. Give each worker its own writable output when it writes. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the method (sample count, what one sample is, order). The worker records both in its result.

## Phase B: Fan out

Spawn all N workers in one message: N `delegate_task` calls, each with its whole brief in `task`, its own `clientRequestId`, `mode: "async"`, and the step 4 model. Keep each returned `taskId` and `childThreadId`. A worker that writes gets `isolation: "worktree"`, a checkout of your current local commit, so commit first. A worker that only reads gets no `isolation` and keeps scratch copies in `/tmp`. Each completion wakes this thread, so end the turn instead of polling.

When a worker must start from a non-default pushed branch, its brief tells it to check out that branch first.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. Drop a result that does not record the SHAs and method its brief names, and respawn that worker once. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.

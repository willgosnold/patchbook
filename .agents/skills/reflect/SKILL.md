---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "/reflect" ("$reflect" in Codex). Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

Before fanning out, find this conversation's transcript: call `orchestrator_capabilities` once, and it returns this thread's ID as `parentThreadId`. Do not search other threads for it. That crosses workspace boundaries and reads private chats from unrelated projects.

The transcript is read with `t3_thread_read` and `threadId: <parentThreadId>`, paging with `afterPosition`, and `view: "activity"` shows tool calls. A subagent's chat is its own `childThreadId`. If the thread can't be read, pass a tight digest of the session instead.

## 2. Spawn three reviewers in parallel

One message, three `delegate_task` calls, each with its whole brief in `task` and its own `clientRequestId`. Never set `runtimeMode`. Reviewers need MCP access to look up the tickets, chat threads, and observability traces the transcript references.

Each reviewer and the synthesizer name a role line and a default. Take each one's model from that line in `.agents/pstack-models.md` in the project's main checkout (`"$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.agents/pstack-models.md"`, which may not exist), else from its default. A role line is `<role>: <entry>, <entry>, ...`, and a panel role runs one subagent per entry. An entry `<provider>/<model> <effort>` becomes `target: {providerInstanceId: <provider>, model: <model>, options: {effort: <effort>}}`, with `reasoningEffort` instead of `effort` for `codex`. `inherit-parent` means omit `target`. The effort is a ceiling: lower it for routine work, never raise it, and never set `fastMode`. Pick each subagent's effort for the job within that ceiling, per the Subagents section of the **poteto-mode** skill.

| Lens | Role line | Default | Prompt template |
|---|---|---|---|
| Judgment | `reflect judgment, divergent, synthesizer` | `claudeAgent/claude-opus-5-5 high` | `references/judgment-reviewer.md` |
| Tooling | `reflect tooling` | `claudeAgent/claude-haiku-5-5 xhigh` | `references/tooling-reviewer.md` |
| Divergent | `reflect judgment, divergent, synthesizer` | `claudeAgent/claude-opus-5-5 high` | `references/divergent-reviewer.md` |

Pass each template verbatim as the `task`, substituting the transcript or digest where marked. For the transcript path, write "T3 thread `<parentThreadId>` (read it with `t3_thread_read`, paging with `afterPosition`; `view: "activity"` shows tool calls)". Reviewers return findings as their task result. Each completion wakes this thread, so end the turn until all three have returned.

## 3. Synthesize

One `delegate_task` call, with its own `clientRequestId` and its model from the `reflect judgment, divergent, synthesizer` line (default `claudeAgent/claude-opus-5-5 high`). Never set `runtimeMode`. It spot-verifies citations through MCP. Pass `references/synthesizer.md` verbatim as the `task`, with each reviewer's full output inlined where marked. It returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the **encode-lessons-in-structure** principle skill.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

File each Backlog item to your team's devex or backlog tracker without waiting. Only the Accepted list waits for approval.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does it directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to the `skill-creator` skill, if it is installed, and run its draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): hand to `skill-creator` and run its description-optimization loop.
- `new skill via skill-creator: <kebab-name>`: hand creation to `skill-creator`. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.

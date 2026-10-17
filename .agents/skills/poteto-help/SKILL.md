---
name: poteto-help
description: Guides users through pstack setup, /poteto-mode or $poteto-mode, and picking the skill, playbook, or principle for a task. Type /poteto-help or $poteto-help with a question.
disable-model-invocation: true
---

# Poteto help

Answer the user's question about pstack, hand them a prompt they can send, and link the file the answer came from. For a help question, don't start the work. The user asked how, and a pstack run spends real tokens, so let them send the prompt.

A message that asks for work, such as "use pstack to fix this bug", is not a help question. Read [`poteto-mode`](../poteto-mode/SKILL.md) and do the work under it.

This file maps questions to the skills and guide pages that hold the answers. Those files own the details. Read the file you route to before you quote it, and trust it when it disagrees with this map. The links here point into the installed plugin, which the user may not be able to open, so give the user the file's public copy: `https://github.com/cursor/plugins/blob/main/pstack/` followed by its path.

## Find out what they need

Infer the need from the message and the conversation. A named situation, such as "which skill reviews a PR?", goes straight to its section. If the need is still unclear, ask one multiple-choice question with these options, then answer only the section they pick:

- Get set up
- Start a task with `/poteto-mode` (`$poteto-mode` in Codex)
- Pick a skill for a situation
- Fix a run that went wrong
- Make pstack my own

Check the state that changes the answer, and mention it only when it does:

- No `.agents/pstack-models.md` in the project's main checkout (`"$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.agents/pstack-models.md"`, which may not exist) means the **setup-pstack** skill hasn't run for this project, so every role uses its default model.
- No `verify-*` skill or other app harness in the project means agents have no scripted way to drive the app. Mention `/create-verification-skill` (`$create-verification-skill` in Codex) when the question is about proving a change works.

When the models file is missing and it matters, ask whether the user wants to pick a model for each role and a reasoning budget now. It matters when the user is new, the question is about setup or cost, or the answer depends on which models run. Ask at most once per chat. If the need is also unclear, ask both questions together. Offer two choices:

- Now: give them `/setup-pstack` (`$setup-pstack` in Codex) to type, and answer their question too.
- Later: answer their question, and add one line saying every role keeps its default model until they run `/setup-pstack`.

## Get set up

1. Install every pstack skill into the project's `.agents/skills/` with the `skills` CLI. They read each other, so take them all.
2. Run [`/setup-pstack`](../setup-pstack/SKILL.md) (`$setup-pstack` in Codex). It asks for a reasoning budget, maps a model to each role, and writes `.agents/pstack-models.md` in the project's main checkout (`"$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.agents/pstack-models.md"`, which may not exist). Skills read it at each spawn.
3. Start a real task with `/poteto-mode` (`$poteto-mode` in Codex), a goal, and a check that can pass or fail.

Installing changes nothing until the user invokes a skill. Only the **setup-pstack** skill loads from the user's words. Offer to word their first prompt with them, per [`references/prompting.md`](references/prompting.md).

If cost is the worry, say where the tokens go and how to spend fewer. pstack spends extra tokens on subagents and review panels. Rerun `/setup-pstack` (`$setup-pstack` in Codex) and pick a smaller budget or cheaper models. A role set to `inherit-parent` runs on the chat's model, which saves tokens when the chat runs on a cheaper model. A shorter panel list runs fewer subagents, one for each entry. Save `/poteto-mode` (`$poteto-mode` in Codex) for work that needs rigor.

pstack is built for T3 Code, running Claude Code or Codex. Its skills use the Agent Skills format, so other tools can read them. But most workflow skills, including **poteto-mode**, **how**, **why**, and **teach**, spawn T3 child tasks with per-role models, and scheduled tasks are a T3 feature, so those parts may not work there.

## Start a task with `/poteto-mode` (`$poteto-mode` in Codex)

The **poteto-mode** skill matches the task to a playbook, copies the playbook's steps into a visible step list (`update_plan` in Codex, the reply in Claude Code), and runs the other skills as the steps need them. A step it skips stays in the list as `skip: <reason>`. A good prompt states the goal and how to tell it's done. It doesn't list skills, because a hand-written sequence tends to drop or reorder steps the playbook would keep. Read [`references/prompting.md`](references/prompting.md) before you help word one.

Whether the **poteto-mode** skill stays on depends on how the user starts it:

- Enter on `/poteto-mode` (`$poteto-mode` in Codex) attaches the skill to one message. It fades as the chat moves on.
- To keep it on, start each new task with `/poteto-mode`.

Mid-chat, "new task" makes the mode match a fresh playbook. The **poteto-mode** skill already uses `poteto-agent` for the subagents its playbook steps spawn. To get the same style from a subagent of your own, start its brief with "Read `<abs>/pstack/agents/poteto-agent.md` and act as that agent. The poteto-mode skill is at `<abs>/poteto-mode/SKILL.md`.", where `<abs>` is the absolute path of the folder that holds the pstack skills (resolve `..` from this skill's folder).

## Pick a skill

The default answer is `/poteto-mode` (`$poteto-mode` in Codex), which runs most of the others when its steps need them. Name a skill directly when the user wants more or less of something than the playbook gives. Read the skill before you recommend it, and give one example prompt.

In Codex, start with `$` instead of `/`.

| The user wants to | Skill |
|---|---|
| Do any non-trivial task with rigor | [`/poteto-mode`](../poteto-mode/SKILL.md) |
| Check that the agent understood their goal and the problem before it starts | [`/in-your-own-words`](../in-your-own-words/SKILL.md) |
| Aim a task higher before starting: more expert, more outcome-focused, not overspecified | [`/sharpen`](../sharpen/SKILL.md) |
| Know how code works now, or where new code should live | [`/how`](../how/SKILL.md) |
| Know why code is shaped this way, or where a number came from | [`/why`](../why/SKILL.md) |
| Understand a change or subsystem, explained plainly | [`/teach`](../teach/SKILL.md) |
| Catch up on their own recent work on a topic | [`/recall`](../recall/SKILL.md) |
| Catch up on what changed in this chat since their last message, in a few plain sentences and small visuals, with enough context to decide each action item | [`/ketchup`](../ketchup/SKILL.md) |
| Know what a small diff could break outside itself | [`/blast-radius`](../blast-radius/SKILL.md) |
| Settle types and module shape before code that crosses a function boundary | [`/architect`](../architect/SKILL.md) |
| Get several attempts at one brief, merged into the best one | [`/arena`](../arena/SKILL.md) |
| Run parallel checks over slices, or race workers | [`/swarm`](../swarm/SKILL.md) |
| Have different models review a diff and try to break it | [`/interrogate`](../interrogate/SKILL.md) |
| Fix a bug test-first when a cheap local test exists | [`/tdd`](../tdd/SKILL.md) |
| Apply TypeScript rules to `.ts` or `.tsx` work | [`/typescript-best-practices`](../typescript-best-practices/SKILL.md) |
| Strip comments before review, using a reviewer that didn't write them | [`/no-comments`](../no-comments/SKILL.md) |
| Clean AI tells out of prose | [`/unslop`](../unslop/SKILL.md) |
| Write docs, an RFC, a README, a PR description, or a commit message to a standard | [`/technical-writing`](../technical-writing/SKILL.md) |
| Hear the last reply again in plain words | [`/bro`](../bro/SKILL.md) |
| Give agents a scripted way to drive the app and prove behavior | [`/create-verification-skill`](../create-verification-skill/SKILL.md) |
| Bring a verification skill and its feature map back in line with the app | [`/maintain-verification-skill`](../maintain-verification-skill/SKILL.md) |
| Vet a performance number before reporting or acting on it | [`/benchmark-checklist`](../benchmark-checklist/SKILL.md) |
| Run a large or cross-cutting change, or one to review after stepping away | [`/figure-it-out`](../figure-it-out/SKILL.md) |
| Keep a decision log during a run, and review it afterward | [`/show-me-your-work`](../show-me-your-work/SKILL.md) |
| Pick a model for each role and a reasoning budget | [`/setup-pstack`](../setup-pstack/SKILL.md) |
| Turn their own working habits into a personal mode skill | [`/automate-me`](../automate-me/SKILL.md) |
| Turn what a finished task taught into skill edits | [`/reflect`](../reflect/SKILL.md) |
| Stop agents from repeating the same mistakes in this repo | [`/correct`](../correct/SKILL.md) |
| Build a page whose buttons wake an agent thread over a webhook | [`/make-bot-ui`](../make-bot-ui/SKILL.md) |
| Find their way around pstack | `/poteto-help` |

If a skill directory next to this one is missing from the table, read its frontmatter and route by its description. The `principle-*` directories are covered under principles below.

Close calls:

- **how** explains what the code does. **why** explains the reasons. **teach** runs one or both and explains the result plainly.
- **arena** gives every worker the same brief and merges the best parts. **swarm** splits work into slices or a race and returns one report.
- **architect** implements right after it settles the design. Add "with checkpoint" to review the design before it writes code.
- **interrogate** reviews the diff. **blast-radius** looks for breakage outside the diff and proves the one fact that makes the change safe.
- **recall** rebuilds context across recent chats. **ketchup** covers only this chat since the user's last message. Resuming one specific chat or branch is the Session pickup playbook.
- **figure-it-out** designs one rigorous run. The Orchestrate playbook runs a program that spans days and many PRs. The Autonomous run playbook drives one task to a finish condition.

Not in pstack:

- `/deslop` ships separately, if it is installed. To drive the app, agents use the project's own verification skill, T3's `preview_*` tools for a UI, or the shell for a CLI.
- Repeating work on a timer uses T3's scheduled tasks (`schedule_task`), not a pstack skill.
- pstack has no `/orchestrate` skill. Orchestrate is a playbook in the **poteto-mode** skill. If the slash menu shows `/orchestrate`, another plugin provides it.

## Playbooks and principles

Playbooks are step lists inside the **poteto-mode** skill, not skills, so they have no slash command. Inside **poteto-mode**, describing the task picks one, and these phrases name one directly:

- "babysit this pr" or "check on pr 123" runs Babysit. It drives the PR to merge-ready and stops there. It doesn't merge unless the user asks to merge, land, or ship.
- "land the stack" runs Shipping.
- "take over this branch" runs Session pickup.
- "pause safely" runs Pause safely.
- "full autopilot on this queue" runs Autopilot-full. "stack them, don't ship" runs Autopilot-stack.
- "run the eval playbook" runs Eval.

Without the **poteto-mode** skill, a phrase such as "babysit this pr" can start another installed skill for the same job instead. The Playbooks section of [`poteto-mode`](../poteto-mode/SKILL.md) lists every playbook and when it applies.

pstack has no planning skill. T3's plan mode works alongside it. For work that spans phases or stacked PRs, asking `/poteto-mode` (`$poteto-mode` in Codex) for a plan runs the [Multi-phase plan playbook](../poteto-mode/playbooks/multi-phase-plan.md), which writes the plan and doesn't implement it. For a design question, the Prototype playbook or the **architect** skill settles it in code first.

Principles are one-rule skills that the **poteto-mode** skill reads and cites in its replies. The user rarely invokes one. They steer with the names instead, as in "apply prove it works. show me the real output." Typing `/principle-<name>` (`$principle-<name>` in Codex) still loads one on demand.

## Fix a run that went wrong

| Symptom | Fix |
|---|---|
| The mode stopped applying after a few turns | It was attached to one message and faded. Start each task with `/poteto-mode` (`$poteto-mode` in Codex). |
| A question got treated as the next step of the last task | Say "new task", or say the turn doesn't need the mode. |
| A new model choice had no effect | Skills read the models file `/setup-pstack` (`$setup-pstack` in Codex) writes at each spawn. Check the role's line in it. |
| Runs cost more than expected | See the cost paragraph under Get set up. |
| A skill didn't load on its own | Only `/setup-pstack` loads from the user's words. The others load when the user types them or when `/poteto-mode` runs them, and it doesn't run every skill. |
| Parallel agents overwrote each other | Give each agent that writes its own worktree (`isolation: "worktree"`). |
| An overnight run moved but finished nothing | Looping until done needs a check that can pass or fail, not a duration. |
| The reply claims success from a green build | Ask for the real command, flow, stored value, or profile. That's the prove-it-works principle. |

For a run that drifts, [`references/prompting.md`](references/prompting.md) has one-line steers.

## Make pstack my own

- [`/automate-me`](../automate-me/SKILL.md) (`$automate-me` in Codex) drafts a personal mode skill from the user's own history, to use alongside `/poteto-mode` (`$poteto-mode` in Codex).
- [`/reflect`](../reflect/SKILL.md) (`$reflect` in Codex) after a session turns its lessons into skill edits the user approves.
- `/poteto-mode write a skill for <workflow>` runs the authoring playbook. The eval playbook tests a skill change blind.
- Fix a misbehaving skill in its own PR, not inside the feature work where it went wrong.

## Reply

Lead with the answer. Give at most one example prompt in a code block, adapted from [`references/recipes.md`](references/recipes.md) when one fits, then the link to that file. Keep it short unless the user asked for the whole map.

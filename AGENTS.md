# Agent rules

Rules for every agent working in this repo, including subagents, reviewers and verifiers. They override a playbook's defaults.

| Rule | Enforced by |
| --- | --- |
| Review scope: findings about the PR's own change block it, and the rest get an issue | Nothing. It's a judgment call, so every reviewer and verifier brief carries it. |

## Review scope

When you review or verify a PR, a finding about the code the PR adds or changes blocks the merge and gets fixed in the PR. That includes:

1. The PR doesn't fix what its issue asks for.
2. It's a breaking regression: something that works on `main` fails at the PR's head.
3. There's a clearly better way to do what the PR does, such as simpler, safer, or a better fit with the code around it. Name the alternative and what it gains. A difference of taste isn't a finding.

Anything else is out of scope, and the PR doesn't change for it.

- If an out-of-scope note is correct, such as a defect in code the PR doesn't touch, or one that `main` already has, open an issue for it and link the review comment that found it.
- If a note is wrong, cosmetic wording, or intended behavior, drop it with a one-line reason in the review report.
- When you brief a reviewer or verifier, include this rule, so it marks each finding as blocking or a note.

# Agent rules

Rules for every agent working in this repo, including subagents, reviewers and verifiers. They override a playbook's defaults.

| Rule | Enforced by |
| --- | --- |
| Review scope: only in-scope findings and regressions block a PR | Nothing. It's a judgment call, so every reviewer and verifier brief carries it. |

## Review scope

When you review or verify a PR, a finding blocks the merge only if one of these holds:

1. The PR doesn't fix what its issue asks for.
2. It's a breaking regression: something that works on `main` fails at the PR's head.

Everything else is a note, and the PR doesn't change for it.

- If a note is correct but out of scope, open an issue for it and link the review comment that found it. Don't fix it in the PR.
- If a note is wrong, cosmetic wording, or intended behavior, drop it with a one-line reason in the review report.
- A defect that `main` already has is out of scope, even when the PR's docs describe the behavior it breaks. File it.
- When you brief a reviewer or verifier, include this rule, so it marks each finding as blocking or a note.

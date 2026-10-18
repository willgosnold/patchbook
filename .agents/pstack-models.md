# pstack model configuration. One line per role. Delete a line to fall back to the default.
# Entry: <provider>/<model> <effort>. `inherit-parent` runs the role on the parent's model (omit `target`). Alias entries in a panel list still count toward its fan-out.
# budget: defaults (high, with xhigh where the defaults set it)
feature, refactoring: claudeAgent/claude-sonnet-5-5 high
bug-fix: claudeAgent/claude-sonnet-5-5 high
perf-issue: claudeAgent/claude-haiku-5-5 xhigh
hillclimb: claudeAgent/claude-sonnet-5-5 high
judgment and prose: claudeAgent/claude-opus-5-5 high
hardest tasks: claudeAgent/claude-opus-5-5 xhigh
how explorer: claudeAgent/claude-haiku-5-5 xhigh
how explainer: claudeAgent/claude-opus-5-5 high
why investigators: claudeAgent/claude-haiku-5-5 xhigh
why synthesizer: claudeAgent/claude-opus-5-5 high
reflect tooling: claudeAgent/claude-haiku-5-5 xhigh
reflect judgment, divergent, synthesizer: claudeAgent/claude-opus-5-5 high
arena runners: claudeAgent/claude-opus-5-5 high, codex/gpt-6.1-sol xhigh
arena cross-judge pool: claudeAgent/claude-opus-5-5 high
swarm workers: claudeAgent/claude-haiku-5-5 xhigh
architect runners: claudeAgent/claude-opus-5-5 high, codex/gpt-6.1-sol xhigh
interrogate reviewers: claudeAgent/claude-opus-5-5 high, codex/gpt-6.1-sol xhigh

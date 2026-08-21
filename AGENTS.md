# AGENTS.md

Read [AGENT_GUIDELINES.md](AGENT_GUIDELINES.md) before starting any task in this repository. It holds the instructions shared by every agent working here. The section below is Codex-only and does not apply to other agents.

## Final Response Changed Files
After each task, include a `Changed files` section in the final response with a clickable link to every file the agent changed during that task. Include implementation files, documentation, release fragments, generated files, tests, configuration, and repository instruction files; do not omit non-code changes. Use absolute workspace paths in Markdown links, with an optional line number when it helps identify the relevant change. If the task did not change any files, state `Changed files: none`.
Before writing the final response, check the line count of every changed code file, excluding generated and vendored artifacts, against nearby files and the component's normal organization. If any changed code file is unusually large, explicitly tell the user which file and its line count, explain that its size may increase maintenance risk, and recommend a focused refactor; do not perform that broader refactor unless it is already within the requested scope.

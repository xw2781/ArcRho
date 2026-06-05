# AGENTS.md

This is the ArcRho monorepo root. Use one Git repository here for all ArcRho components.

## Repository Layout
- `frontend/`: current ArcRho desktop/web UI, Electron host, backend service code currently bundled with the frontend app, docs, release fragments, and frontend-specific agent rules.
- `data-engine/`: ArcRho data-engine component.
- `tools/`: repository-level automation, including commit/push helpers for agents.

## Mandatory Read Before Editing
Before changing files under `frontend/`, read `frontend/AGENTS.md`.

## Bug Fix Cleanup Review
When fixing a bug, remove clearly obsolete code in the touched area. Ask before broader cleanup or cleanup with behavior risk.

## Commit Workflow
Before creating a commit, follow `tools/agent_commit_workflow.md`. Agents must summarize repository changes in 1 to 7 logical groups, provide best-practice suggestions when applicable, and ask for the user's final review and explicit approval before staging or committing.

## Python Runtime Preference
Always prefer Python 3.10 for this repository. When validating Python code, running scripts, installing dependencies, or creating virtual environments, use a Python 3.10 interpreter unless the user explicitly asks for another version or a toolchain requires a different runtime.

## Validation Runtime Limit
No validation command should run for more than 120 seconds by default. Use targeted fast checks first, and put tests, docs checks, syntax checks, and smoke checks behind a timeout of 120 seconds or less. If a broader validation is expected to exceed 120 seconds, ask before running it and explain why the longer run is needed. When a validation times out, stop it and report the timeout instead of retrying indefinitely.

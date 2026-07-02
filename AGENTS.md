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

## Data Migration and JSON Contract Consistency
When changing dataset sidecar JSON or reserving-class `index.json` formats, structures, or field names, keep the migration script and frontend-generated JSON in sync. Coordinate updates to `python-api/migration/resq_data_migration.py` with the frontend app code that writes dataset sidecars or per-reserving-class `index.json` files. In the current phase, do not add legacy-format compatibility unless explicitly requested; prefer a clean, coordinated refactor across all producers and consumers of the JSON contract.
If a user asks to revise the JSON structure emitted by `python-api/migration/resq_data_migration.py`, treat that as a cross-component JSON contract change and proactively update the corresponding frontend JSON writers/readers in the same task unless the user explicitly scopes the request to migration-only exploration.
Use the ResQ API examples in `python-api/migration/references` when migration tasks need ResQ API behavior guidance.
The user macro `C:\Users\xwei.PRCINS\Documents\ArcRho\macros\import_from_resq.py` is currently the primary runnable ResQ import/migration entrypoint. When changing ResQ migration behavior in this repository, keep that macro's behavior in sync with `python-api/migration/resq_data_migration.py`; if editing the user macro is blocked by filesystem permissions, clearly report the required matching change.

## Agent Project Data Access
Agents may view on-disk metadata JSON files under `E:\ArcRho Server\projects` only for project `NJ_Annual_Prod_202605_Fake` by default.
Do not read metadata JSON files on disk for any other ArcRho Server project unless the user gives explicit permission for that project in the current session.
If a user references another ArcRho Server project without giving session-specific permission to read its on-disk metadata JSON files, ask for that permission or ask the user to provide the needed excerpts directly in the chat.
When inspecting sidecars, method JSON, dataset JSON, or related migration/refactor issues and the request does not explicitly specify a reserving-class data path, use `E:\ArcRho Server\projects\NJ_Annual_Prod_202605_Fake\data\PRNJ - PA_%5C_PA_%5C_All States_%5C_Direct Group_%5C_COL` as the default ArcRho Server data folder.
This restriction applies to agent tool use and analysis only; it does not change runnable scripts that a human may execute, such as `python-api/resq_data_migration.py`.

## Commit Workflow
Before creating a commit, follow `tools/agent_commit_workflow.md`. Agents must summarize repository changes in 1 to 7 logical groups and provide best-practice suggestions when applicable. If the user explicitly asks the agent to create a commit, treat that request as approval to stage and commit the current stated scope without asking for another approval prompt. When changes are wide across the repo, span multiple components, or include distinct themes, create multiple commits by logical group instead of one large commit. Do not push unless the user separately approves a push.

## Python Runtime Preference
Always prefer Python 3.10 for this repository. When validating Python code, running scripts, installing dependencies, or creating virtual environments, use a Python 3.10 interpreter unless the user explicitly asks for another version or a toolchain requires a different runtime.

## Node Runtime Preference
The frontend includes a bundled portable Node runtime. When validating or running Node/npm commands for this repository, prefer `frontend\node-portable\node.exe` and `frontend\node-portable\npm.cmd` instead of plain `node` or `npm`, because Node is not expected to be installed globally or available on `PATH` in the agent environment. Do not report "Node is not installed in this environment" unless the bundled portable runtime is also missing or fails.

## Validation Runtime Limit
No validation command should run for more than 120 seconds by default. Use targeted fast checks first, and put tests, docs checks, syntax checks, and smoke checks behind a timeout of 120 seconds or less. If a broader validation is expected to exceed 120 seconds, ask before running it and explain why the longer run is needed. When a validation times out, stop it and report the timeout instead of retrying indefinitely.
Validation commands must not write files to the C drive. If temporary files are needed, write them only inside the current repository folder.

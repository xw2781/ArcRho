# AGENTS.md

This is the ArcRho monorepo root. Use one Git repository here for all ArcRho components.

## Repository Layout
- `frontend/`: current ArcRho desktop/web UI, Electron host, backend service code currently bundled with the frontend app, docs, release fragments, and frontend-specific agent rules.
- `python-api/`: Python API, ResQ migration scripts, migration references, and macro source files.
- `data-engine/`: ArcRho data-engine component.
- `tools/`: repository-level automation, including commit/push helpers for agents.

## Project Terms and Abbreviations
- **DSV (Dataset Viewer):** the frontend workspace for viewing and editing datasets under `frontend/ui/dataset_viewer`.
- **DFM (Development Factor Method):** the frontend workspace for creating and reviewing development factor methods under `frontend/ui/method_pages/dfm`.
- **BF (Bornhuetter Ferguson):** the frontend workspace for Bornhuetter Ferguson methods under `frontend/ui/method_pages/bornhuetter_ferguson`.
- **RS (Result Selection):** the frontend workspace for result selection methods under `frontend/ui/method_pages/result_selection`.
- **PI (Project Instance):** the frontend workspace for browsing and working within a project instance under `frontend/ui/project_instance`.
- **PS (Project Settings):** the frontend workspace for configuring project settings under `frontend/ui/project_settings`.

## Mandatory Read Before Editing
Before changing files under `frontend/`, read `frontend/FRONTEND_AGENT_GUIDELINES.md`.

## Single Source of Truth (MUST)
For every code, configuration, schema, data-contract, automation, documentation, and test change, identify the authoritative owner of each default, constant, enum, validation rule, field definition, path rule, mapping, template, and business rule before editing.
- Define each value or rule in one canonical location. Consumers must import, read, derive, generate from, or delegate to that source instead of copying the implementation or literal value.
- Do not create synchronized-by-convention copies across files, components, languages, runtime layers, configuration, tests, or documentation. Explicit runtime overrides and values genuinely computed from runtime state are allowed, but they must be clearly modeled as overrides or derived values rather than competing defaults.
- When direct reuse across languages or build boundaries is impractical, keep one canonical machine-readable source and generate the required adapters or artifacts. Document and validate the generation path so drift is detected automatically.
- Tests may assert canonical behavior and fixed contract expectations, but test fixtures and expected values must not become a second runtime source of truth. Generated documentation and inventories must be rebuilt from their canonical sources rather than edited independently.
- When touching an area that already duplicates a source of truth, consolidate the duplication within the safe scope of the task and remove obsolete copies. Ask before cleanup that would broaden behavior or compatibility risk.

## Excel Add-in Build and Release
After making changes under `excel-addin/`, automatically run the non-interactive build and release scripts unless the user explicitly asks not to build or release:
- Step 1: `powershell -NoProfile -ExecutionPolicy Bypass -File "E:\XWSpace\Repos\ArcRho\excel-addin\tools\build_xlam.ps1"`
- Step 2: `powershell -NoProfile -ExecutionPolicy Bypass -File "E:\XWSpace\Repos\ArcRho\excel-addin\tools\release_xlam.ps1"`
Treat this as pre-approved by the repository instructions for Excel add-in changes, but still follow environment requirements for sandbox escalation because the scripts update the beta add-in and release add-in outside the repository. Do not use `Step 1+2 - Build and Release ArcRho.bat` for agent validation because its interactive prompt can hang in agent terminals. If either direct script is blocked, fails, or times out, report that clearly.

## Bug Fix Verification and Cleanup
Before changing code for a bug fix, review the relevant code and verify that its current logic can explain the bug or unexpected behavior reported by the user. If the reported behavior cannot be traced to the code, or if any material detail is uncertain, stop and ask the user for more details or clarification until the issue is clear. Do not make assumptions or guesses when deciding on code changes.
When fixing a bug, remove clearly obsolete code in the touched area. Ask before broader cleanup or cleanup with behavior risk.

## ArcRho JSON Contract Skill
Use `$arcrho-json-contract` when refining dataset JSON sidecars/sidercars, reserving-class `index.json`, data storage formats, JSON field names or structures, ResQ migration behavior, or `python-api/migration/resq_data_migration.py` output.

## ArcRho Macro Source
Treat `python-api/macros` as the source of truth for ArcRho macro files maintained in this repository.
Follow the macro metadata, versioning, release-note, and backup rules in `python-api/macros/README.md` whenever adding or changing a macro.
When adding or editing a macro, update the file in `python-api/macros` first, then copy all active macro files from that folder to `C:\Users\xwei.PRCINS\Documents\ArcRho\macros`.

## Agent Project Data Access
Agents may view on-disk metadata JSON files under `E:\ArcRho Server\projects` only for project `NJ_Annual_Prod_202605_Fake` by default.
Do not read metadata JSON files on disk for any other ArcRho Server project unless the user gives explicit permission for that project in the current session.
If a user references another ArcRho Server project without giving session-specific permission to read its on-disk metadata JSON files, ask for that permission or ask the user to provide the needed excerpts directly in the chat.
When inspecting sidecars, method JSON, dataset JSON, or related migration/refactor issues and the request does not explicitly specify a reserving-class data path, use `E:\ArcRho Server\projects\NJ_Annual_Prod_202605_Fake\data\PRNJ - PA_%5C_PA_%5C_All States_%5C_Direct Group_%5C_COL` as the default ArcRho Server data folder.
This restriction applies to agent tool use and analysis only; it does not change runnable scripts that a human may execute, such as `python-api/resq_data_migration.py`.

## Python Runtime Preference
Always prefer Python 3.10 for this repository. When validating Python code, running scripts, installing dependencies, or creating virtual environments, use a Python 3.10 interpreter unless the user explicitly asks for another version or a toolchain requires a different runtime.

## Node Runtime Preference
The frontend includes a bundled portable Node runtime. When validating or running Node/npm commands for this repository, prefer `frontend\node-portable\node.exe` and `frontend\node-portable\npm.cmd` instead of plain `node` or `npm`, because Node is not expected to be installed globally or available on `PATH` in the agent environment. Do not report "Node is not installed in this environment" unless the bundled portable runtime is also missing or fails.

## Validation Runtime Limit
No validation command should run for more than 60 seconds by default. Use targeted fast checks first, and put tests, docs checks, syntax checks, and smoke checks behind a timeout of 60 seconds or less. If a broader validation is expected to exceed 60 seconds, ask before running it and explain why the longer run is needed. When a validation times out, stop it and report the timeout instead of retrying indefinitely.
Validation commands must not write files to the C drive. If temporary files are needed, write them only inside the current repository folder.

## Final Response Changed Files
After each task, include a `Changed files` section in the final response with a clickable link to every file the agent changed during that task. Include implementation files, documentation, release fragments, generated files, tests, configuration, and repository instruction files; do not omit non-code changes. Use absolute workspace paths in Markdown links, with an optional line number when it helps identify the relevant change. If the task did not change any files, state `Changed files: none`.

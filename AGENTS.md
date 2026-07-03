# AGENTS.md

This is the ArcRho monorepo root. Use one Git repository here for all ArcRho components.

## Repository Layout
- `frontend/`: current ArcRho desktop/web UI, Electron host, backend service code currently bundled with the frontend app, docs, release fragments, and frontend-specific agent rules.
- `python-api/`: Python API, ResQ migration scripts, migration references, and macro source files.
- `data-engine/`: ArcRho data-engine component.
- `tools/`: repository-level automation, including commit/push helpers for agents.

## Mandatory Read Before Editing
Before changing files under `frontend/`, read `frontend/AGENTS.md`.

## Excel Add-in Build and Release
After making changes under `excel-addin/`, automatically run the non-interactive build and release scripts unless the user explicitly asks not to build or release:
- Step 1: `powershell -NoProfile -ExecutionPolicy Bypass -File "E:\XWSpace\Repos\ArcRho\excel-addin\tools\build_xlam.ps1"`
- Step 2: `powershell -NoProfile -ExecutionPolicy Bypass -File "E:\XWSpace\Repos\ArcRho\excel-addin\tools\release_xlam.ps1"`
Treat this as pre-approved by the repository instructions for Excel add-in changes, but still follow environment requirements for sandbox escalation because the scripts update the beta add-in and release add-in outside the repository. Do not use `Step 1+2 - Build and Release ArcRho.bat` for agent validation because its interactive prompt can hang in agent terminals. If either direct script is blocked, fails, or times out, report that clearly.

## Bug Fix Cleanup Review
When fixing a bug, remove clearly obsolete code in the touched area. Ask before broader cleanup or cleanup with behavior risk.

## ArcRho JSON Contract Skill
Use `$arcrho-json-contract` when refining dataset JSON sidecars/sidercars, reserving-class `index.json`, data storage formats, JSON field names or structures, ResQ migration behavior, or `python-api/migration/resq_data_migration.py` output.

## ArcRho Macro Source
Treat `python-api/migration/macro-source` as the source of truth for ArcRho macro files maintained in this repository.
When adding or editing a macro, update the file in `python-api/migration/macro-source` first, then copy all macro files from that folder to `C:\Users\xwei.PRCINS\Documents\ArcRho\macros`.

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

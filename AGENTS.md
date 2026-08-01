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
- **Dev PC:** the development machine that hosts this repository, builds the app, and publishes macros to the shared macro library.
- **Client PC:** a user machine that runs the installed ArcRho desktop app and reaches the ArcRho Server workspace (`E:\ArcRho Server`) as a mapped or UNC network drive; it loads shared macros from the library into its own local `Documents\ArcRho\macros`.

## Mandatory Read Before Editing
Before changing files under `frontend/`, read `frontend/FRONTEND_AGENT_GUIDELINES.md`.

## Agent Project Data Access (MUST)
Agents may view on-disk metadata JSON files under `E:\ArcRho Server\projects` only for project `NJ_Annual_Prod_202605_Fake` by default.

Do not read metadata JSON files on disk for any other ArcRho Server project unless the user gives explicit permission for that project in the current session. If a user references another project without giving session-specific permission, ask for permission or ask the user to provide the needed excerpts directly in the chat.

This restriction applies to agent tool use and analysis only; it does not change runnable scripts that a human may execute, such as `python-api/resq_data_migration.py`.

## Single Source of Truth (MUST)
Before changing code, configuration, schemas, data contracts, automation, documentation, or tests, identify the canonical owner of every value and rule.
- Define each value or rule once. Consumers must import, read, derive, generate from, or delegate to that source; clearly model legitimate runtime overrides and derived values.
- When direct reuse across languages or build boundaries is impractical, use one canonical machine-readable source and generate validated adapters or artifacts so drift is detected.
- Tests may assert canonical behavior, but fixtures, expected values, generated documentation, and inventories must not become competing sources of truth.
- When the touched area already contains duplication, consolidate it within the task's safe scope and remove obsolete copies. Ask before cleanup that broadens behavior or compatibility risk.

## Persisted JSON Producer Parity (MUST)
When more than one ArcRho component can create the same persisted JSON file, all producers must emit the exact same full parsed payload for the same logical inputs.
- Keep one canonical owner for the schema, version, field projection, inclusion/omission rules, defaults, normalization, timestamp representation, and deterministic list ordering. Frontend, Python API, migration, macro, and other producers must import, generate from, or delegate to that owner; producer-specific enrichment is forbidden.
- Keep reserving-class `index.json` a minimal scalar summary of logical dataset instances. Do not copy arrays or nested sidecar/method details into it. In particular, `origin_labels`, dependency graphs, audit logs, and other detail payloads remain in their owning sidecar or method JSON.
- Persist only location-independent, reserving-class-owned data in `index.json`. Do not persist producer-local drive letters, UNC aliases, absolute folder paths, or rebuild-time enrichment from project/global JSON. Resolve machine-local paths and other presentation-only values in the API response or consumer instead.
- Reading a valid current `index.json` must return it without scanning sidecars/methods and without rewriting or enriching the file. Rebuild only when the index is missing, invalid, explicitly refreshed, made stale by a durable mutation, or uses an outdated canonical version/schema.
- A transient permission/network read failure during rebuild must abort and preserve the last valid index; it must never be converted into and persist a degraded but schema-valid payload.
- Coordinate any `index.json` contract or build-logic change across the bundled frontend app server, the public Python API, `python-api/migration/resq_data_migration.py`, its migration modules, and the mirrored macro under `python-api/macros`.
- Every such change must include an exact full-payload cross-producer parity test, including path-alias independence, and a test proving that a valid current index is served without a sidecar scan or rewrite.

## Network-Drive Project Data I/O (MUST)
When designing or maintaining a frontend feature, including its bundled app-server code, assume ArcRho project JSON and related metadata may live on a mapped or UNC network drive.
- Do not read or write multiple independent small files sequentially in a per-file awaited loop. Every network filesystem operation can add a full round trip.
- For reads, enumerate folders once, deduplicate paths, reuse request-scoped configuration/index snapshots, and use bounded parallel I/O or a batch/aggregate read. Do not reload the same JSON, index, or configuration once per dataset, method, precedent, or dependent.
- For writes, coalesce updates and avoid rewriting unchanged files. Preserve correctness by serializing writes per target or protected folder, using the existing lock and atomic temporary-file replacement patterns; do not use unsafe unbounded parallel writes.
- If a true data dependency requires sequential I/O, document that dependency in the implementation and minimize the number of network operations.
- Add focused coverage for bounded concurrency, deterministic result ordering, write atomicity, and failure handling whenever this rule changes an I/O workflow.

## Conditional Instruction Entry Points

| Read only this file when triggered | Trigger words |
| --- | --- |
| [User Preference Storage Scopes](agent-instructions/user-preference-storage-scopes.md) | `preference`, `preferences`, `user setting`, `settings storage`, `AppData`, `localStorage`, `project-user`, `shared preference`, `workspace_paths.json` |
| [Excel Add-in Build and Release](agent-instructions/excel-addin-build-and-release.md) | `excel-addin/`, `Excel add-in`, `.xlam`, `VBA add-in`, `build_xlam`, `release_xlam` |
| [Agent Project Data Access](agent-instructions/agent-project-data-access.md) | `ArcRho Server project data`, `project metadata JSON`, `sidecar`, `method JSON`, `dataset JSON`, `reserving-class data path`, `resq_data_migration.py`, `E:\ArcRho Server\projects` |

## Bug Fix Verification and Cleanup
Before changing code for a bug fix, review the relevant code and verify that its current logic can explain the bug or unexpected behavior reported by the user. If the reported behavior cannot be traced to the code, or if any material detail is uncertain, stop and ask the user for more details or clarification until the issue is clear. Do not make assumptions or guesses when deciding on code changes.
When fixing a bug, remove clearly obsolete code in the touched area. Ask before broader cleanup or cleanup with behavior risk.

## ArcRho JSON Contract Skill
Use `$arcrho-json-contract` when refining dataset JSON sidecars/sidercars, reserving-class `index.json`, data storage formats, JSON field names or structures, ResQ migration behavior, or `python-api/migration/resq_data_migration.py` output.

## ArcRho Macro Source
Treat `python-api/macros` as the source of truth for ArcRho macro files maintained in this repository.
Follow the macro metadata, versioning, release-note, and backup rules in `python-api/macros/README.md` whenever adding or changing a macro.
When adding or editing a macro, update the file in `python-api/macros` first, then copy all active macro files from that folder to `C:\Users\xwei.PRCINS\Documents\ArcRho\macros`.
After adding or editing any active macro, also publish the active macros to the official shared macro library (`E:\ArcRho Server\shared\macros`) by running `python publish_macro_library.py` from `python-api/macros`.

## Python Runtime Preference
Always prefer Python 3.10 for this repository. When validating Python code, running scripts, installing dependencies, or creating virtual environments, use a Python 3.10 interpreter unless the user explicitly asks for another version or a toolchain requires a different runtime.

## ArcRho Bridge Deployment Authorization
The user pre-authorizes agents to stop and restart only the live ArcRho Bridge supervisor and its child worker when deploying a verified ArcRho Bridge update. Do not stop ResQ, ArcRho Engine, or other services under this authorization. Continue to request any platform-required sandbox escalation, but do not request separate conversational confirmation for this specific Bridge restart.

## Node Runtime Preference
The frontend includes a bundled portable Node runtime. When validating or running Node/npm commands for this repository, prefer `frontend\node-portable\node.exe` and `frontend\node-portable\npm.cmd` instead of plain `node` or `npm`, because Node is not expected to be installed globally or available on `PATH` in the agent environment. Do not report "Node is not installed in this environment" unless the bundled portable runtime is also missing or fails.

## Validation Runtime Limit
No validation command should run for more than 60 seconds by default. Use targeted fast checks first, and put tests, docs checks, syntax checks, and smoke checks behind a timeout of 60 seconds or less. If a broader validation is expected to exceed 60 seconds, ask before running it and explain why the longer run is needed. When a validation times out, stop it and report the timeout instead of retrying indefinitely.
Validation commands must not write files to the C drive. If temporary files are needed, write them only inside the current repository folder.

## Final Response Changed Files
After each task, include a `Changed files` section in the final response with a clickable link to every file the agent changed during that task. Include implementation files, documentation, release fragments, generated files, tests, configuration, and repository instruction files; do not omit non-code changes. Use absolute workspace paths in Markdown links, with an optional line number when it helps identify the relevant change. If the task did not change any files, state `Changed files: none`.
Before writing the final response, check the line count of every changed code file, excluding generated and vendored artifacts, against nearby files and the component's normal organization. If any changed code file is unusually large, explicitly tell the user which file and its line count, explain that its size may increase maintenance risk, and recommend a focused refactor; do not perform that broader refactor unless it is already within the requested scope.

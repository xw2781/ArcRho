# AGENTS.md

This is the ArcRho monorepo root. Use one Git repository here for all ArcRho components.

## Repository Layout
- `frontend/`: current ArcRho desktop/web UI, Electron host, backend service code currently bundled with the frontend app, docs, release fragments, and frontend-specific agent rules.
- `python-api/`: Python API, ResQ migration scripts, migration references, and macro source files.
- `data-engine/`: ArcRho data-engine component.
- `tools/`: repository-level automation, including commit/push helpers for agents.
- `agent-memory/`: tracked Claude Code project memories; see [Agent Memory](#agent-memory).

## Project Terms and Abbreviations
- **DSV (Dataset Viewer):** the frontend workspace for viewing and editing datasets under `frontend/ui/dataset_viewer`.
- **DFM (Development Factor Method):** the frontend workspace for creating and reviewing development factor methods under `frontend/ui/method_pages/dfm`.
- **BF (Bornhuetter Ferguson):** the frontend workspace for Bornhuetter Ferguson methods under `frontend/ui/method_pages/bornhuetter_ferguson`.
- **CC (Cape Cod):** the frontend workspace for Cape Cod methods under `frontend/ui/method_pages/cape_cod`.
- **RS (Result Selection):** the frontend workspace for result selection methods under `frontend/ui/method_pages/result_selection`.
- **PI (Project Instance):** the frontend workspace for browsing and working within a project instance under `frontend/ui/project_instance`.
- **PS (Project Settings):** the frontend workspace for configuring project settings under `frontend/ui/project_settings`.
- **Dev PC:** the development machine that hosts this repository, builds the app, and publishes macros to the shared macro library.
- **Client PC:** a user machine that runs the installed ArcRho desktop app and reaches the ArcRho Server workspace (`E:\ArcRho Server`) as a mapped or UNC network drive; it loads shared macros from the library into its own local `Documents\ArcRho\macros`.

## Mandatory Read Before Editing
Before changing files under `frontend/`, read `frontend/FRONTEND_AGENT_GUIDELINES.md`.

## Agent Memory
Claude Code project memories are tracked in this repository under `agent-memory/`, with `agent-memory/MEMORY.md` as the index. They are reviewed and committed to `main` like any other documentation, so a hard-won debugging technique survives a machine rebuild and reaches every clone.

The agent harness derives its memory directory from the repository's absolute path (`%USERPROFILE%\.claude\projects\<slug>\memory`) and offers no setting to move it. Run `tools/link_agent_memory.ps1` once per machine and per clone path to make that directory a junction pointing at `agent-memory/`; memory writes then land in the working tree. The script is idempotent, needs no elevation, and refuses to replace a non-empty real memory directory without `-Force`. Restart Claude Code afterwards so the index is loaded at session start.

Because these notes are now shared across machines, a memory that depends on one workstation's layout — installed interpreters, drive letters, a bundled `node-portable`, a count of tests already failing at HEAD — must say so in its own text instead of being written as a universal fact.

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
- Detect a durable mutation by listing the reserving-class instance folders once and comparing that listing against the persisted `folder_signature`. A staleness check must not open sidecar or method payloads. Because that check runs before the index lock is taken, a rebuild it triggers must enumerate the folder again inside the lock rather than reuse the unlocked listing, so a payload and the `folder_signature` written beside it always describe the same observation. Enumeration must keep the size and modification time the directory listing already returned; do not re-stat each enumerated path.
- A transient permission/network read failure during rebuild must abort and preserve the last valid index; it must never be converted into and persist a degraded but schema-valid payload.
- Coordinate any `index.json` contract or build-logic change across the bundled frontend app server, the public Python API, `python-api/migration/resq_data_migration.py`, its migration modules, and the mirrored macro under `python-api/macros`.
- Every such change must include an exact full-payload cross-producer parity test, including path-alias independence, and a test proving that a valid current index is served without a sidecar scan or rewrite.

## Persisted JSON Text Format (MUST)
`arcrho_api/io.py` owns the on-disk text of every persisted ArcRho JSON file. `format_json_for_save` produces the layout and `persisted_json_text` produces the complete document, including its single trailing newline.
- A two-dimensional array — a triangle, a vector of vectors, a table of rows — must be written one row per line. `json.dumps(..., indent=2)` puts one scalar per line, which turns a 40x40 triangle into roughly 1,900 lines a human cannot review and doubles the bytes a network-drive read pays for. This applies to every 2D array, not to a named list of keys; a writer must not decide per field which arrays are compact.
- Every producer of persisted project, reserving-class, method, sidecar, index, or project-data cache JSON must call `persisted_json_text` rather than `json.dump`/`json.dumps` with an `indent`. That includes the bundled app server, the public Python API, `python-api/migration/`, macros, and the bridge. A payload with no 2D array renders byte-identical to the previous `indent=2` text, so there is no reason for a persisted-JSON writer to opt out.
- Only a component that genuinely cannot import `arcrho_api` — currently the frozen Bridge, which loads it from its data bundle rather than its import graph — may keep a copy, and only behind a test that pins the copy to the canonical text byte for byte.
- Revisions, digests, and unchanged-file comparisons must not depend on this layout. Hash the canonical projection with `separators=(",", ":")` as `dfm_contract` does, so reformatting a file can never shift a stored revision.
- Transient runtime files that are not ArcRho project data — bridge heartbeats, engine request envelopes, editor scratch state — are outside this rule.

## Generated Dataset Import Parity (MUST)
When ResQ migration encounters a single-instance Dataset Type with `Generated=true`, the migration must reproduce the frontend generation path rather than copy the ResQ object's values or presentation metadata.
- Submit the same ArcRho Engine request contract used by the frontend and publish only the completed Engine CSV.
- Build the persisted engine sidecar through the same canonical contract as the frontend runtime. Do not copy ResQ origin/development labels, counts, formulas, users, or timestamps into an engine-owned sidecar.
- Keep Dataset Type formulas and project header labels in their canonical project configuration/header sources. Cached dataset reads must hydrate them before the first grid render; do not synthesize generic `12, 24, ...` labels for an engine dataset.
- Add an exact full-payload cross-producer test for the frontend and migration engine-sidecar writers, including path-alias independence, plus a cached-load test proving formula and development-label hydration matches a force rebuild.

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
The user pre-authorizes agents to rebuild, redeploy, and restart the ArcRho Bridge whenever a task changes code the Bridge bundles. Do not stop ResQ or other services under this authorization; stopping ArcRho Engine instances is covered by the separate ArcRho Engine Deployment Authorization below. Continue to request any platform-required sandbox escalation, but do not request separate conversational confirmation for the Bridge rebuild, deploy, or restart.

The Bridge ships a frozen copy of its bundled sources, so a change to those sources has no effect on the running Bridge until it is rebuilt. `data-engine/src/arcrho_bridge/bundled_sources.py` owns the bundle list; read its `BUNDLED_SOURCES`, `CANONICAL_MODULE_ROOT`, and `CANONICAL_HIDDEN_IMPORTS` rather than trusting a copy of that list. At the time of writing it bundles `data-engine/src/arcrho_bridge/`, `python-api/migration/`, `python-api/src/`, and `frontend/app_server/`, so many changes that look unrelated to the Bridge still require a rebuild.

Rebuild once per task, after the change is verified and before reporting the task complete; do not rebuild after each individual edit. Skip the rebuild when a task changed only tests, docs, or files outside the bundle, and say so.

Run `python data-engine/src/arcrho_bridge/build_exe.py` with a Python 3.10 interpreter. That single command builds, stops the live Bridge through `apps.bridge.kill_all`, swaps the deployed app folder atomically with rollback, and releases the orchestrator to relaunch, so no separate stop or restart step is needed. This command may run to completion without asking.

Never deploy a change that has not passed its checks; a broken Bridge blocks every ResQ import. If the build fails, or the live Bridge does not stop within the script's timeout, the script aborts and leaves the deployed Bridge untouched. Report that outcome plainly and do not retry blindly. State in the final response whether the Bridge was rebuilt and redeployed, or why it was not.

## ArcRho Admin Control Deployment Authorization
The user pre-authorizes agents to shut down, rebuild, redeploy, and reopen ArcRho Admin Control whenever a task changes the Admin Control app. Do not request separate conversational confirmation for this workflow; continue to request any platform-required sandbox escalation. The Admin Control app source and packaging inputs are under `data-engine/src/arcrho_admin/` and the executable is deployed to `E:\ArcRho Server\apps\ArcRho Admin Control\`.

After a verified change to the Admin Control app, rebuild once per task before reporting completion:
1. Shut down the running Admin Control server through `POST http://127.0.0.1:28766/api/shutdown` and wait for the process/listener to exit. If the server is not responding but its process remains, terminate only the identified `ArcRho Admin Control.exe` process so the deployment folder can be replaced.
2. Run `py -3.10 data-engine/src/arcrho_admin/build_exe.py`. This packages the current source and atomically deploys `ArcRho Admin Control.exe` to the configured server apps folder.
3. Launch `E:\ArcRho Server\apps\ArcRho Admin Control\ArcRho Admin Control.exe` with a hidden process window so it reopens the local Admin Control browser UI.
4. Verify `GET http://127.0.0.1:28766/api/health` returns `{"ok": true}` and confirm the deployed process is running.

Do not rebuild for changes limited to Admin Control tests, docs, release fragments, or unrelated files. Never deploy a change that has not passed its checks. If the build or relaunch fails, report the failure plainly and do not retry blindly. State in the final response whether Admin Control was rebuilt, redeployed, and reopened, or why it was not.

## ArcRho Engine Deployment Authorization
The user pre-authorizes agents to stop running ArcRho Engine instances and to rebuild, redeploy, and relaunch the ArcRho Engine whenever a task changes code the Engine bundles. Do not stop ResQ, the Bridge, or other services under this authorization. Continue to request any platform-required sandbox escalation, but do not request separate conversational confirmation for the Engine stop, rebuild, deploy, or relaunch.

The Engine ships a frozen copy of its bundled sources, so a change to those sources has no effect on running instances until the Engine is rebuilt. `data-engine/src/arcrho_engine/build_exe.py` owns the bundle; read its `ENGINE_BUNDLED_SOURCES` (from `data-engine/src/arcrho_engine/bundled_sources.py`), `--paths`, and hidden imports rather than trusting a copy of that list. At the time of writing it bundles `data-engine/src/arcrho_engine/`, `python-api/src/`, and `frontend/app_server/`, so many changes that look unrelated to the Engine still require a rebuild.

Run `python data-engine/src/arcrho_engine/build_exe.py` with a Python 3.10 interpreter. That single command builds, stops every live Engine instance through `apps.engine.kill_all`, swaps the deployed app folder atomically with rollback, and restores the kill switch so the orchestrator relaunches instances up to `apps.orchestrator.max_workers`. After the deploy, verify fresh heartbeat files appear under `E:\ArcRho Server\runtime\instances\arcrho_engine\`; if the orchestrator is not running, start `E:\ArcRho Server\apps\ArcRho Engine\ArcRho Engine.exe` manually. This command may run to completion without asking.

Stopping the Engine pauses every pending calculation, dependent-propagation, and project-duplication job until instances return, so rebuild once per task, after the change is verified and before reporting the task complete; skip the rebuild when a task changed only tests, docs, or files outside the bundle, and say so. Never deploy a change that has not passed its checks. If the build fails, or live instances do not stop within the script's timeout (an instance finishing a long durable job delays shutdown), the script aborts and leaves the deployed Engine untouched; report that outcome plainly and do not retry blindly. State in the final response whether the Engine was rebuilt, redeployed, and its instances relaunched, or why not.

## Node Runtime Preference
The frontend includes a bundled portable Node runtime. When validating or running Node/npm commands for this repository, prefer `frontend\node-portable\node.exe` and `frontend\node-portable\npm.cmd` instead of plain `node` or `npm`, because Node is not expected to be installed globally or available on `PATH` in the agent environment. Do not report "Node is not installed in this environment" unless the bundled portable runtime is also missing or fails.

## Validation Runtime
Validation commands must not write files to the C drive. If temporary files are needed, write them only inside the current repository folder.

## Final Response Changed Files
After each task, include a `Changed files` section in the final response with a clickable link to every file the agent changed during that task. Include implementation files, documentation, release fragments, generated files, tests, configuration, and repository instruction files; do not omit non-code changes. Use absolute workspace paths in Markdown links, with an optional line number when it helps identify the relevant change. If the task did not change any files, state `Changed files: none`.
Before writing the final response, check the line count of every changed code file, excluding generated and vendored artifacts, against nearby files and the component's normal organization. If any changed code file is unusually large, explicitly tell the user which file and its line count, explain that its size may increase maintenance risk, and recommend a focused refactor; do not perform that broader refactor unless it is already within the requested scope.

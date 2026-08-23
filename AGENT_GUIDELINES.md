# ArcRho Agent Guidelines

These instructions apply to every code agent working in this repository, regardless of which agent tool is running. Both [AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md) redirect here; agent-specific rules stay in those files.

This is the ArcRho monorepo root. Use one Git repository here for all ArcRho components.

## Repository Layout
- `frontend/`: current ArcRho desktop/web UI, Electron host, backend service code currently bundled with the frontend app, docs, release fragments, and frontend-specific agent rules.
- `python-api/`: Python API, ResQ migration scripts, migration references, and macro source files.
- `data-engine/`: ArcRho data-engine component.
- `tools/`: repository-level automation, including commit/push helpers for agents and `svg_icon_preview.py`, which collects every SVG in the repository into one browser gallery (run it directly, or double-click `tools/preview_svg_icons.bat`).
- `agent-memory/`: tracked Claude Code project memories; see [Agent Memory](#agent-memory).

## Project Terms and Abbreviations
- **DSV (Dataset Viewer):** the frontend workspace for viewing and editing datasets under `frontend/ui/dataset_viewer`.
- **DFM (Development Factor Method):** the frontend workspace for creating and reviewing development factor methods under `frontend/ui/method_pages/dfm`.
- **BF (Bornhuetter Ferguson):** the frontend workspace for Bornhuetter Ferguson methods under `frontend/ui/method_pages/bornhuetter_ferguson`.
- **CC (Cape Cod):** the frontend workspace for Cape Cod methods under `frontend/ui/method_pages/cape_cod`.
- **RS (Result Selection):** the frontend workspace for result selection methods under `frontend/ui/method_pages/result_selection`.
- **PI (Project Instance):** the frontend workspace for browsing and working within a project instance under `frontend/ui/project_instance`.
- **PS (Project Settings):** the frontend workspace for configuring project settings under `frontend/ui/project_settings`.
- **Server PC:** the shared machine that physically holds `E:\ArcRho Server` — the project workspace, the deployed server components, and the shared macro library — runs the server-side build listener, and is the machine with ResQ installed. Currently `NE7SASWPN02`. Older notes and commit messages call it the "Dev PC"; that name predates development moving onto a client machine, so prefer "Server PC" in new writing.
- **Client PC:** a user machine that runs the ArcRho desktop app and reaches the ArcRho Server workspace (`E:\ArcRho Server`) as a mapped or UNC network drive; it loads shared macros from the library into its own local `Documents\ArcRho\macros`. Development happens on one of these: the developer's workstation `L-H2MQ6280FVP` holds this repository's working clone and runs the frontend app in dev mode, and maps `\\NE7SASWPN02\E` as drive `E:`, so `E:\ArcRho Server` resolves there exactly as it does on the Server PC.

## Mandatory Read Before Editing
Before changing files under `frontend/`, read `frontend/FRONTEND_AGENT_GUIDELINES.md`.

## Agent Memory
Claude Code project memories are tracked in this repository under `agent-memory/`, with `agent-memory/MEMORY.md` as the index. They are reviewed and committed to `main` like any other documentation, so a hard-won debugging technique survives a machine rebuild and reaches every clone.

The agent harness derives its memory directory from the repository's absolute path (`%USERPROFILE%\.claude\projects\<slug>\memory`) and offers no setting to move it. Run `tools/link_agent_memory.ps1` once per machine and per clone path to make that directory a junction pointing at `agent-memory/`; memory writes then land in the working tree. The script is idempotent, needs no elevation, and refuses to replace a non-empty real memory directory without `-Force`. Restart Claude Code afterwards so the index is loaded at session start.

**Setting up a new clone is two steps, and skipping either one silently loses memories.** Run `tools/link_agent_memory.ps1`, then restart. Without the junction the harness writes into a real directory outside the tree, nothing commits it, and that machine's memories never reach anyone else — a divergence that is invisible until an agent gives a wrong answer from a stale index.

Committing memories is automatic and is the one exception to the push rule below. The `Stop` hook in `.claude/settings.json` runs `tools/sync_agent_memory.sh`, which commits and pushes `agent-memory/` — and only `agent-memory/` — at the end of each turn. It uses the pathspec form of `git commit`, so work staged elsewhere is never swept in, and it does nothing during a rebase, merge, cherry-pick, or on a detached HEAD. A rejected push leaves the commit local for the next run to carry. Do not commit `agent-memory/` by hand as part of another change; let the hook own it, so a memory edit never rides along in an unrelated commit.

`.claude/settings.json` is tracked for this reason: a hook that exists on only one machine cannot keep two machines in sync. Keep machine-specific paths out of it — resolve the repository root at runtime with `git rev-parse --show-toplevel`. Per-machine overrides belong in `.claude/settings.local.json`, which stays ignored.

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

## Minimal Diff and Approval-Gated Patterns (MUST)
Prefer the minimum-diff solution: implement the goal in its small, direct form. Do not inflate a simple implementation with validations, defensive checks, or try/except handling for situations that rarely occur in practice. The same restraint applies to docs and comments: do not describe rare cases.
Do not add SHA-256 (or other hash/checksum) validation or legacy fallback logic without the user's explicit approval. If the required task has no alternative solution, stop and ask the user for approval first, explaining why that validation or fallback must be used.

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
- Only a component that genuinely cannot import `arcrho_api` may keep a copy, and only behind a test that pins the copy to the canonical text byte for byte. There are two: the frozen Bridge, which loads `arcrho_api` from its data bundle rather than its import graph (`arcrho_bridge/bridge_utils.py`, pinned by `data-engine/tests/test_bridge_json_parity.py`), and the Electron host (`frontend/electron/persisted_json_text.js`, pinned by `frontend/tests/test_host_json_text_parity.py`). The host copy serves only files the host writes on its own — templates, notebooks, undo steps, ArcBot exchange copies; persisted project data is never written from JavaScript, which cannot tell `1` from `1.0`, so a renderer saves a method or sidecar through an app-server route.
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
| [Component Deployment Authorization](agent-instructions/component-deployment-authorization.md) | `rebuild`, `redeploy`, `deploy.py`, `build_exe.py`, `build_manager.bat`, `bundled_sources`, `kill_all`, `heartbeat`, `Bridge`, `Engine`, `Gateway`, `Orchestrator`, `Admin Control`, `Launcher` |
| [SVG Icon Management](agent-instructions/svg-icon-management.md) | `svg`, `.svg`, `icon`, `icons`, `iconography`, `glyph`, `sprite`, `symbol`, `cursor image`, `logo`, `artwork`, `viewBox`, `currentColor`, `mask-image`, `icon folder`, `shared/icons`, `file-icons`, `tab-type-icons` |
| [ResQ API Reference Material](agent-instructions/resq-api-reference.md) | `ResQ COM`, `ResQ API`, `ResQ scripting`, `ResQ help manual`, `ResQToolBox`, `ResQ object hierarchy`, `ResQ migration`, `reserve review notebook`, `ConnectByName`, `GetDFMMethod`, `AddMethod` |

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

## Component Build and Deploy (MUST)
Every frozen server component — Bridge, Engine, Gateway, Orchestrator, Admin Control, Launcher — is rebuilt and redeployed through `data-engine/deploy.py`, which asks the ArcRho Build Listener on the server machine to do the work. Do not run a component's `build_exe.py` from a client machine unless the listener is unavailable: a client deploy pushes the frozen build across the workspace share, measured on 2026-08-17 at 0.18 MB/s of writes against that same share's 50 MB/s reads, so five of every six minutes was transfer rather than build.

```
python data-engine/deploy.py            # every component the change made stale
python data-engine/deploy.py bridge engine
python data-engine/deploy.py --stale    # report freshness, build nothing
python data-engine/deploy.py --ref main # build a pushed ref instead of local source
```

- **Do not work out which components are stale by hand.** With no arguments the CLI derives that from each component's bundled source roots, which is the only reliable answer — an edit under `frontend/app_server/` makes the Bridge, the Engine **and** the Gateway stale, and reasoning about it by memory has already caused a missed Gateway deploy.
- **Uncommitted work deploys.** The CLI sends a patch of the affected trees against the newest commit the server can resolve, so a rebuild required before a change is committed works normally. Do not commit or push merely to deploy.
- **Check what the payload contains before accepting a deploy.** A working-tree deploy ships the state of the whole tree under the affected roots, so a colleague's or another agent's half-finished edits in the same clone go to the server too. The CLI prints the changed and new files for that reason: if the list contains work that is not yours, stop and ask rather than deploying it. `--ref` builds a pushed ref instead and never carries local state.
- **Exit codes are the result**: `0` success, `1` the build or deploy failed, `2` a usage or precondition problem, `3` no listener is running. Report a non-zero result plainly and do not retry blindly.
- **The one human step**: on exit code `3`, ask the user to run `data-engine\build_manager.bat` on the ArcRho Server machine and turn on "Listen for build requests". Relay the CLI's message; do not attempt to start it remotely.
- Rebuild once per task, after the change is verified and before reporting the task complete. Skip it when a task changed only tests, docs, release fragments, or files outside every bundle, and say so.
- State in the final response which components were rebuilt and redeployed, or why none were.

The user pre-authorizes these rebuilds and the component restarts they cause, so do not ask for conversational confirmation; read [Component Deployment Authorization](agent-instructions/component-deployment-authorization.md) before a rebuild for how far that reaches, what each component's downtime costs, what to verify afterwards, and the slower fallback for when no listener is running. `data-engine/build_manager.bat` remains the direct interface for a human at the server.

## Node Runtime Preference
The frontend includes a bundled portable Node runtime. When validating or running Node/npm commands for this repository, prefer `frontend\node-portable\node.exe` and `frontend\node-portable\npm.cmd` instead of plain `node` or `npm`, because Node is not expected to be installed globally or available on `PATH` in the agent environment. Do not report "Node is not installed in this environment" unless the bundled portable runtime is also missing or fails.

## Validation Runtime
Validation commands must not write files to the C drive. If temporary files are needed, write them only inside the current repository folder.

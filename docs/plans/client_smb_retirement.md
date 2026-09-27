# Client SMB Retirement: Every Client PC Read and Write Through the Gateway

Status: Audited 2026-09-26 and broken into 20 session-sized steps; the dead SMB code the audit found (workbook routes, the unused dataset list and diagonal routes, the unused Project Instance folder watcher) was removed the same day; the three decisions were settled the same day as recommended, and the Snowflake config path moved off the share; step 1 of 20 done 2026-09-26 (ResQ bridge apply is a hosted save; its Engine and Gateway deploy is step 6); step 2 in progress; production deploys wait for the user.
Last updated: 2026-09-26
Related: [hosted_workspace_http_transport.md](hosted_workspace_http_transport.md) (the transport this plan finishes; its Phase 3 notifications and Phase 4 small writes are folded in here), [hosted_save_http_transport.md](hosted_save_http_transport.md) (its "Retiring the SMB transport" item is steps 18 and 19 here)

**How this ships.** Most steps change both sides: a Gateway (and sometimes Engine) deploy that adds a registered kind, which is additive and cannot affect a user on the released app, then a frontend release that makes the client use it. Each deploy step deploys only additive server work. The steps that change behaviour for users — a Gateway outage stops the app instead of falling back to the share — reach users only with a frontend release (decision 1 allows it).

**Production deploys wait for the user (2026-09-26).** The user asked for no rush on production deploys and app releases. Deploy steps 6, 12 and 17 deploy to the local test root and check there; the production deploy and the frontend release run only when the user asks.

## Progress

Plain-language tracking. The agent that finishes a step ticks its box, fills in the date, and leaves one short line on what a user would notice. Nothing technical goes here.

| # | Step | Done | Date | Est. | Actual | What changed for the user |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | Applying a ResQ bridge change saves on the server like any other save | [x] | 2026-09-26 | 50 min | 8 min | "Update local from ResQ" in a DFM now saves on the server, under the same protection as the page's own Save. |
| 2 | Bootstrap refresh, dataset notes and new empty datasets save on the server | [ ] | | 60 min | | In progress 2026-09-26 |
| 3 | Audit log entries from two PCs can no longer overwrite each other | [ ] | | 45 min | | |
| 4 | ArcBot edits go through the normal save instead of writing files directly | [ ] | | 70 min | | |
| 5 | Editing a method file by hand no longer writes around the save | [ ] | | 35 min | | |
| 6 | Deploy the server side of steps 1-3 | [ ] | | 20 min | | |
| 7 | Project configuration pages load from the server | [ ] | | 70 min | | |
| 8 | Reserving-class pickers and filters load and save through the server | [ ] | | 70 min | | |
| 9 | Dataset and method side panels load from the server | [ ] | | 65 min | | |
| 10 | "Changed by someone else" alerts stop firing on your own saves | [ ] | | 55 min | | |
| 11 | Calculations hand back their results directly instead of via the shared drive | [ ] | | 60 min | | |
| 12 | Deploy the server side of steps 7-11 | [ ] | | 20 min | | |
| 13 | Project folder create, rename, delete and settings saves run on the server | [ ] | | 75 min | | |
| 14 | Dataset-type changes and project copies are submitted and tracked through the server | [ ] | | 60 min | | |
| 15 | Field mapping, source profile and reserving-class refresh run on the server | [ ] | | 70 min | | |
| 16 | Shared macros, ArcBot prompts and the ResQ import request go through the server | [ ] | | 60 min | | |
| 17 | Deploy the server side of steps 13-16 | [ ] | | 20 min | | |
| 18 | The app stops falling back to the shared drive when the server is unreachable | [ ] | | 75 min | | |
| 19 | Old shared-drive save path and leftover dead code removed | [ ] | | 55 min | | |
| 20 | Signing up to the server no longer needs the shared drive | [ ] | | 90 min | | |

Overall: 1 of 20 steps done. Estimated 1,125 min, actual so far 8 min.

## How agents work this plan

- Take the first unticked step in the Progress table. One step is one context (a session or one workflow subagent), one commit.
- Note the clock before the first file is read and again at the commit, keeping the two parts apart: time spent reading and editing, and time spent running tests, checks and deploys.
- Read the sections between here and the Plan before starting, then only the files the step names. Do not read ahead into later steps.
- A step is done when its "Done when" list holds, its tests pass, and the commit is in. In that same commit: tick the Progress row, write the date, the actual minutes and the one-line user note, update the "Overall" count and actual total, append the actual to the step's `Estimate:` line, and update the `Status:` line at the top and this plan's row in the [plans index](README.md).
- If a step turns out to need a decision that is not in "Open decisions", stop, record the question there, commit that note alone, and report it rather than guessing.
- Do not start a step while the previous one is uncommitted.

## Why

`AGENT_GUIDELINES.md` ("Server-Hosted Project Data I/O") makes HTTP through the Gateway the only client transport for project data and SMB the transport being retired. On 2026-09-26 an audit of the whole frontend (app server routes and services, Electron host, renderer, installer) found the client still reaches the share in three ways:

1. **Gateway-first with an SMB fallback.** Registered reads and mutations fall back to the mapped drive when the Gateway is disabled, unreachable, has not advertised the kind, or rejects the request before acting — including a rejected credential, which is therefore hidden behind an SMB read ([workspace_read_client.py](../../frontend/app_server/services/workspace_read_client.py), [workspace_mutation_client.py](../../frontend/app_server/services/workspace_mutation_client.py)). Engine calculations fall back to a request file on the share ([engine_calculation_service.py](../../frontend/app_server/services/engine_calculation_service.py)). Hosted saves fall back to the share only when the Gateway has not advertised the kind ([engine_hosted_save_service.py](../../frontend/app_server/services/engine_hosted_save_service.py)); with every user on the latest version that path is unreachable.
2. **SMB only.** Of 79 endpoints in the dataset and method routers, 31 have no Gateway path at all; nearly all project-settings, dataset-type, field-mapping, source-table, reserving-class, audit-log, user-preference and macro-library endpoints are the same.
3. **Writes that skip the hosted save.** These write project data without the Engine's reserving-class lease, and some skip the dependent walk:
   - ArcBot's edit mode writes method JSON straight onto the share and its revert copies a backup back ([arcbot_host.js](../../frontend/electron/arcbot_host.js), `applyArcBotJsonEdit`, `revertLatestArcBotEdit`).
   - "Open DFM JSON" opens the method file in an Arcode editor that saves it straight to the share ([dfm_tabs_orchestrator.js](../../frontend/ui/method_pages/dfm/dfm_tabs_orchestrator.js), [editor_framework.js](../../frontend/ui/arcode/shared/editor_framework.js)).
   - Applying a ResQ bridge patch runs a full DFM save inside the client app server ([dfm_rpc_bridge_service.py](../../frontend/app_server/services/dfm_rpc_bridge_service.py), `apply_remote_to_local`).
   - Bootstrap, BF and Cape Cod refresh, the dataset grid patch, dataset notes and create-empty all write under an in-process lock only.
   - A rules save falls back to a direct project-wide save when its Engine job answers 503 ([project_settings_data_processing_rules.js](../../frontend/ui/project_settings/project_settings_data_processing_rules.js), `saveRulesDirectly`).
   - The audit log is read, changed and rewritten under a lock that covers one process, so two PCs lose each other's entries ([audit_service.py](../../frontend/app_server/services/audit_service.py)).

SMB also answers wrongly, not only slowly: file times read over the share can be seconds stale after a server write, which already raises false "changed by someone else" alerts and hides terminal job statuses (memories `smb-stat-metadata-alternation`, `propagation-status-smb-cache-lag`, `bridge-heartbeat-false-negative`).

### What genuinely needs the client machine or the share

These stay, and each step that touches one records the reason in code and in the domain doc:

- **Gateway sign-up**, until step 20: the client learns the Gateway URL and its secret by reading and writing `config\arcrho_gateway.json` on the share ([hosted_save_enrollment.py](../../python-api/src/arcrho_api/hosted_save_enrollment.py)). That file holds every user's secret and any client can read it.
- **First-run discovery of the server folder** in setup and the installer, until the client stores a Gateway URL instead of a share root.
- **Excel**: workbook reads, the Excel add-in install from the share, opening a workbook in Excel. Kept by the user's decision on 2026-09-26.
- **Sources only this PC can read**: a SQL Server import runs as the user's own Windows login, and a CSV source may sit on a drive only the client has. The read must stay on the client; only the master-table write moves to the Gateway (decision 3).
- **Handing a path to another program**: open in Explorer, show in folder, open in Excel.
- **A file picked on this PC**: reserving-class types import from a local file.

### Already done (2026-09-26)

Removed with no behaviour change: the `/book/*` workbook routes and their service and schemas, `GET /datasets`, `GET /dataset/{ds_id}/diagonal`, and the Electron `project-instance-index-watch-*` handlers with their preload entries. None had a caller.

## Decisions

All three were decided by the user on 2026-09-26, each as recommended.

1. **The app may stop working while the Gateway is down.** Step 18 retires the fallback without waiting for TLS. The fallback does not protect confidentiality — the same data already crosses the LAN in cleartext whenever the Gateway is up — while it hides credential failures and serves stale answers. TLS stays its own item in [hosted_save_http_transport.md](hosted_save_http_transport.md).
2. **ArcBot's edits go through the page's save.** Step 4: ArcBot hands the edited JSON to the open page, which applies it as unsaved changes and saves through its normal hosted save, so ArcBot never writes a project file. Its backup and revert work on the page's undo instead of files on the share. No "replace this method JSON" save kind is added.
3. **Client-only import sources upload to the Gateway.** Step 15b: the SQL Server import and a client-only CSV are still read on the client, and the rows are uploaded to a new Gateway operation that writes the master table, so the client never writes the share.

Two smaller questions: "Open DFM JSON" becomes read-only (step 5, recommended, not yet confirmed; the step may still take the editable route it describes). The developer's fixed Snowflake config path under `E:\XWSpace` moved to the user's own settings folder on 2026-09-26 (done ahead of step 19).

## Open decisions

None.

## Rough size

Estimated 1,125 minutes of agent time across 20 steps: 720 minutes of code edit and 405 minutes of test, validation and deploy. Three deploy steps carry most of the validation time that is not test runs.

## Plan

Steps 1-3 are independent of each other; 4 and 5 are independent of 1-3. Steps 7-11 are independent of each other. Steps 13-16 are independent of each other. Every deploy step follows the group before it. Step 18 needs every earlier step. Step 19 follows 18. Step 20 is independent of everything but the last deploy.

**Test locally first.** Every step is checked against the private server on the developer PC before production sees it: `py -3.10 tools/local_server.py deploy` builds the Engine and Gateway from the working tree into `C:\Arco Server`, and `launch-app` opens the dev app against it (see [local_server_root_and_server_switcher.md](local_server_root_and_server_switcher.md)). Each deploy step runs that first and deploys to production only after the check passes. The local root does not reach the share at all, so a feature that still quietly reads over SMB shows up there as reading `C:\Arco Server` — use the client read-latency log's `transport` field, not the result, to tell the two apart.

Every new registered kind added by this plan is called with `gateway_required=True` from the start: this plan adds no new SMB fallback. Server processes (`ARCRHO_RUNTIME_SERVER_ROOT` set) keep running the service locally, as today.

### Step 1 — ResQ bridge apply becomes a hosted save

**Goal.** "Apply" in the DFM ResQ bridge runs on the Engine under the reserving-class lease instead of saving from the client.

**Read first.** [dfm_rpc_bridge_service.py](../../frontend/app_server/services/dfm_rpc_bridge_service.py) `apply_remote_to_local`; [dfm_rpc_bridge_router.py](../../frontend/app_server/api/dfm_rpc_bridge_router.py); [arcrho_engine_save_contract.py](../../python-api/src/arcrho_engine_save_contract.py) `SAVE_JOB_KINDS`; memory `adding-a-hosted-save-kind`; [completed/hosted_rpc_bridge_transport.md](completed/hosted_rpc_bridge_transport.md) (why apply was deferred).

**Do.**
- [x] Add a `dfm_rpc_bridge_apply` save kind whose function is the existing apply, plus its `save_propagation_roots`.
- [x] Route `POST /dfm/rpc-bridge/apply` through `run_hosted_save`.
- [x] Update [dfm_rpc_bridge.md](../../frontend/docs/app_server/domains/dfm_rpc_bridge.md).

**Tests.** `frontend/tests/test_dfm_rpc_bridge_*`: apply goes through the hosted save and never calls the in-process DFM save on a client; `test_save_plan_service` covers the new roots function.

**Done when.** The apply route has no path that writes the DFM JSON from the client process.

Estimate: code edit 30 min, test/validation 20 min, total 50 min. Actual: code edit 2 min, test/validation 6 min, total 8 min (the existing hosted-save recipe made it one table entry, one wrapper and one route; checked end to end on the local root).

### Step 2 — Bootstrap refresh, dataset notes and empty-dataset create become hosted saves

**Goal.** Three client-side writes move onto the Engine; two refresh routes nothing calls are deleted.

**Read first.** [bootstrap_router.py](../../frontend/app_server/api/bootstrap_router.py) refresh route; [dataset_router.py](../../frontend/app_server/api/dataset_router.py) notes, create-empty and patch routes; [bornhuetter_ferguson_router.py](../../frontend/app_server/api/bornhuetter_ferguson_router.py) and [cape_cod_router.py](../../frontend/app_server/api/cape_cod_router.py) refresh routes; memory `adding-a-hosted-save-kind`.

**Do.**
- [ ] Confirm no caller of `POST /bornhuetter-ferguson/refresh` and `POST /cape-cod/refresh` (the 2026-09-26 audit found none) and delete both routes.
- [ ] Make Bootstrap refresh, dataset notes save and create-empty dataset save kinds.
- [ ] Check whether `POST /dataset/{ds_id}/patch` is reachable from a visible control (it is wired through `dataset_run_controller.js` and a hidden Save button). If not reachable, delete it with its client function; if reachable, record that in this step and add it to step 9 instead of guessing.

**Tests.** Hosted-save routing tests for each new kind; route tests that the deleted routes are gone.

**Done when.** None of these routes writes a sidecar, CSV or method JSON from the client process.

Estimate: code edit 40 min, test/validation 20 min, total 60 min.

### Step 3 — Audit log append runs on the server

**Goal.** Project audit log reads and appends go through the Gateway, under one server-side lock.

**Read first.** [audit_service.py](../../frontend/app_server/services/audit_service.py); [audit_log_router.py](../../frontend/app_server/api/audit_log_router.py); [arcrho_workspace_mutation_contract.py](../../python-api/src/arcrho_workspace_mutation_contract.py); memory `adding-a-hosted-workspace-read`.

**Do.**
- [ ] Register an audit-log read kind and an append mutation kind. An append must be idempotent to use the mutation transport: carry a client-generated entry id and skip an id already present.
- [ ] Route the two audit-log endpoints and `safe_append_project_audit_log` callers on a Client PC through them.

**Tests.** Duplicate append with the same id writes once; client routes use the Gateway and refuse when it is unavailable.

**Done when.** No client code path rewrites `audit_log.json` over the share.

Estimate: code edit 30 min, test/validation 15 min, total 45 min.

### Step 4 — ArcBot edits go through the page's save

**Goal.** ArcBot never writes a project file; its edits land through the same save the user would press. Follows decision 2.

**Read first.** [arcbot_host.js](../../frontend/electron/arcbot_host.js) `applyArcBotJsonEdit`, `revertLatestArcBotEdit`, `validateArcBotJsonTarget`, and the staging functions that copy the method JSON and CSVs; the renderer side that receives ArcBot results ([ui/ai-assistant/index.js](../../frontend/ui/ai-assistant/index.js)).

**Do.**
- [ ] Implement decision 2.
- [ ] Stage the method JSON and CSVs from hosted reads rather than share copies, or record here which ones still lack a read kind and leave them for step 16.

**Tests.** Node tests: an edit targeting a project file never calls the host file writers; revert restores through the page.

**Done when.** No ArcBot code path writes under the workspace root.

Estimate: code edit 50 min, test/validation 20 min, total 70 min.

### Step 5 — "Open DFM JSON" becomes read-only

**Goal.** The Arcode window opened from a DFM shows the method JSON without saving it back over the share.

**Read first.** [dfm_tabs_orchestrator.js](../../frontend/ui/method_pages/dfm/dfm_tabs_orchestrator.js) "Open DFM JSON"; [editor_framework.js](../../frontend/ui/arcode/shared/editor_framework.js) open, revision check and save.

**Do.**
- [ ] Load the content through the hosted DFM load and open it read-only (recommended answer; if the user prefers editable, route the save through the DFM hosted save instead).
- [ ] Bump the `?v=` stamps of every edited module and update the tests that pin them (memory `theme-css-version-pins`, `frontend-node-test-suite`).

**Tests.** Node test that the window opened from a DFM cannot save to a file path.

**Done when.** No DFM-originated Arcode window writes a method file.

Estimate: code edit 20 min, test/validation 15 min, total 35 min.

### Step 6 — Deploy the server side of steps 1-3

**Goal.** The Engine and Gateway advertise the new save, read and mutation kinds.

**Read first.** `AGENT_GUIDELINES.md` "Component Build and Deploy"; [component-deployment-authorization.md](../../agent-instructions/component-deployment-authorization.md).

**Do.**
- [ ] `python server-components/deploy.py` with no arguments; check the payload lists only this plan's work.
- [ ] Check `/api/capabilities` lists the new kinds.

**Tests.** None beyond the capability check.

**Done when.** The capability list carries every kind steps 1-3 added.

Estimate: code edit 0 min, test/validation 20 min, total 20 min.

### Step 7 — Project configuration reads

**Goal.** Project Settings pages read their configuration through the Gateway.

**Read first.** [project_settings_router.py](../../frontend/app_server/api/project_settings_router.py) GET routes; [dataset_types_router.py](../../frontend/app_server/api/dataset_types_router.py) `GET /dataset_types`; [field_mapping_router.py](../../frontend/app_server/api/field_mapping_router.py) GET; [source_table_router.py](../../frontend/app_server/api/source_table_router.py) `GET /source_table`, `GET /file_status` (JSON part only), `GET /connections`; [arcrho_router.py](../../frontend/app_server/api/arcrho_router.py) `GET /arcrho/projects`; [dataset_router.py](../../frontend/app_server/api/dataset_router.py) number-format defaults GET; [user_identity_router.py](../../frontend/app_server/api/user_identity_router.py); memory `adding-a-hosted-workspace-read`.

**Do.**
- [ ] Register a read kind per route above, each a service function returning the route's exact current response. The registered `project_dataset_types` kind returns a different shape than `GET /dataset_types`, so that route gets its own function.
- [ ] Keep the local stat of an external CSV in `/file_status` on the client (it may name a drive only this PC has); move only its project-JSON reads.
- [ ] Rewrite `data_processing_rules` GET and validate so a read never copies the master table or rebuilds `data_processing_values.json`; that write belongs to the source refresh job.

**Tests.** Per-kind transport tests (Gateway used, refused when unavailable); a response-shape parity test per route.

**Done when.** None of these routes opens a file under the workspace root on a Client PC.

Estimate: code edit 50 min, test/validation 20 min, total 70 min.

### Step 8 — Reserving-class reads and per-user preferences

**Goal.** Reserving-class pickers, path trees, filters and hidden paths load and save through the Gateway.

**Read first.** [reserving_class_router.py](../../frontend/app_server/api/reserving_class_router.py); [reserving_class_service.py](../../frontend/app_server/services/reserving_class_service.py) path-tree children and types refresh; [project_user_preferences_service.py](../../frontend/app_server/services/project_user_preferences_service.py).

**Do.**
- [ ] Read kinds for combinations, path tree and the reserving-class types; the path-tree children GET must stop refreshing values and rewriting caches on a read (the source refresh job owns that write).
- [ ] Mutation kinds for hidden paths, filter spec and project user preferences, with the login taken from the signed request, never from the payload.
- [ ] `GET /reserving_class_types` stops writing the JSON and workbook on a read.

**Tests.** Transport tests; a test that a GET writes nothing.

**Done when.** No reserving-class or user-preference route touches the share from a Client PC, and no GET in this router writes.

Estimate: code edit 50 min, test/validation 20 min, total 70 min.

### Step 9 — Dataset and method side reads

**Goal.** The dataset sidecar panel, dependents preview, DFM dataset references and pattern reads come from the Gateway.

**Read first.** [dataset_router.py](../../frontend/app_server/api/dataset_router.py) `POST /dataset/sidecar/load`, `POST /dataset/calculated/preview`; [dfm_method_router.py](../../frontend/app_server/api/dfm_method_router.py) dataset-references resolve; [dfm_method_index_router.py](../../frontend/app_server/api/dfm_method_index_router.py) percent-developed curve, development pattern and index refresh.

**Do.**
- [ ] Read kinds for sidecar load, calculated preview, dataset-references resolve, percent-developed curve and development pattern.
- [ ] The method-index refresh becomes a mutation kind (it rewrites `index.json`); it runs on every DFM open today.
- [ ] If step 2 recorded the grid patch as reachable, make it a hosted save kind here.

**Tests.** Transport tests per kind.

**Done when.** None of these routes opens project files from a Client PC.

Estimate: code edit 45 min, test/validation 20 min, total 65 min.

### Step 10 — Change detection through the Gateway

**Goal.** The "changed by someone else" watch and the Project Instance table watch ask the server, which reads its own disk and is never stale.

**Read first.** [object_change_watch_service.py](../../frontend/app_server/services/object_change_watch_service.py); [object_change_watch.js](../../frontend/ui/shared/services/object_change_watch.js); `GET /datasets/cached/index-signature` in [dataset_router.py](../../frontend/app_server/api/dataset_router.py); business-logic contract rule 15 on the stale-stat comparison.

**Do.**
- [ ] Read kinds for fingerprint, attribution and index signature. A Gateway failure answers "unknown" quietly (no alert, no error), as hosted-save progress does.
- [ ] Keep the `updated_at` comparison rule; note in the contract that the server-side stat is authoritative.

**Tests.** Transport tests; the unknown answer never raises an alert.

**Done when.** No watch polls the share.

Estimate: code edit 35 min, test/validation 20 min, total 55 min.

### Step 11 — Calculations answer with their data

**Goal.** A hosted calculation returns its result in the reply, so the client stops waiting for a CSV to appear on its drive and reading it there.

**Read first.** [engine_calculation_service.py](../../frontend/app_server/services/engine_calculation_service.py) hosted branch and `wait_for_file`; [arcrho_runtime_service.py](../../frontend/app_server/services/arcrho_runtime_service.py) `/arcrho/headers` and the header cache clear; [arcrho_engine_calculation_contract.py](../../python-api/src/arcrho_engine_calculation_contract.py); business-logic contract rule 18.

**Do.**
- [ ] The hosted exchange returns the CSV body; the client stops calling `wait_for_file` after a hosted success.
- [ ] Headers become a read kind returning the labels; the header cache clear becomes a mutation kind.
- [ ] Update contract rule 18.

**Tests.** Hosted exchange test with no client-side file read; headers transport test.

**Done when.** A hosted calculation on a Client PC performs no share I/O.

Estimate: code edit 40 min, test/validation 20 min, total 60 min.

### Step 12 — Deploy the server side of steps 7-11

**Goal.** The Gateway (and Engine, for step 11) advertise every kind steps 7-11 added.

**Read first.** As step 6.

**Do.**
- [ ] `python server-components/deploy.py`; check the capability list.

**Tests.** Capability check.

**Done when.** Every kind from steps 7-11 is advertised.

Estimate: code edit 0 min, test/validation 20 min, total 20 min.

### Step 13 — Project folder and settings writes on the server

**Goal.** Creating, renaming and deleting a project folder, saving the project registry and general settings, and clearing the generated cache run on the Gateway.

**Read first.** [project_settings_service.py](../../frontend/app_server/services/project_settings_service.py); [arcrho_workspace_mutation_contract.py](../../python-api/src/arcrho_workspace_mutation_contract.py) (only idempotent kinds may register); business-logic contract rule 19.

**Do.**
- [ ] Give the mutation transport a request-id receipt so a non-idempotent write (rename, create, delete) replays its stored outcome instead of running twice. Record the receipt rule in contract rule 19.
- [ ] Register the six writes; replace the registry's mtime conflict check with a revision the server owns.

**Tests.** Replay returns the first outcome; a rename is never applied twice; transport tests.

**Done when.** No Project Settings write touches the share from a Client PC.

Estimate: code edit 55 min, test/validation 20 min, total 75 min.

### Step 14 — Dataset-type change job and project duplication through the Gateway

**Goal.** Both Engine jobs are submitted, polled and cancelled over HTTP.

**Read first.** [dataset_types_change_service.py](../../frontend/app_server/services/dataset_types_change_service.py); [project_settings_service.py](../../frontend/app_server/services/project_settings_service.py) duplication submit, status and cancel; business-logic contract rules 14 and 20.

**Do.**
- [ ] Mutation kinds for both submits and the duplication cancel (both are already keyed by request id); read kinds for both statuses.
- [ ] Move the dataset-types direct write (the no-job branch of `POST /dataset_types`) to a mutation kind.

**Tests.** Transport tests; a replayed submit returns the existing job.

**Done when.** Neither job's request or status file is touched from a Client PC.

Estimate: code edit 40 min, test/validation 20 min, total 60 min.

### Step 15 — Field mapping, source profile and reserving-class refresh on the server

**Goal.** The remaining Project Settings data writes run on the Gateway or the Engine. Part b follows decision 3.

**Read first.** [field_mapping_service.py](../../frontend/app_server/services/field_mapping_service.py); [source_table_service.py](../../frontend/app_server/services/source_table_service.py) profile, connections, import and refresh; [source_refresh_service.py](../../frontend/app_server/services/source_refresh_service.py) plan; `POST /reserving_class_values/refresh`, `POST /reserving_class_types` and `POST /table_summary/refresh`.

**Do.**
- [ ] a. Mutation kinds for the field mapping save, source profile save and connection list; the reserving-class values refresh and table-summary refresh become the source refresh job where the source is server-readable. The refresh plan's drive-letter-to-UNC translation stays on the client and is sent as data.
- [ ] b. Implement decision 3 for the SQL Server import and a client-only CSV.

**Tests.** Transport tests; the client-only source case per decision 3.

**Done when.** The only share writes left in Project Settings are the ones decision 3 keeps, each documented.

Estimate: code edit 50 min, test/validation 20 min, total 70 min.

### Step 16 — Macro library, ArcBot prompts and the ResQ import request

**Goal.** The last share reads for supporting files, and the macro that still drops a request file, go through the Gateway.

**Read first.** [macro_library_service.py](../../frontend/app_server/services/macro_library_service.py); ArcBot prompt and instruction loaders in [arcbot_host.js](../../frontend/electron/arcbot_host.js); [import_resq_reserving_class.py](../../python-api/macros/import_resq_reserving_class.py) `publish_import_request`; memories `scripts-save-through-gateway-client`, `shared-macro-library-deploy`, `macro-must-not-depend-on-app-arcrho-api`.

**Do.**
- [ ] Read kinds for the macro library listing and file text; the install and sync write only to local Documents.
- [ ] ArcBot reads its prompt and instructions through the app server's hosted read; it stops seeding files onto the share.
- [ ] The import macros publish through the Gateway client, the way the ResQ sync request already does; publish the macros.

**Tests.** Transport tests; macro test that the publish uses the Gateway.

**Done when.** None of these reads or publishes touches the share from a Client PC.

Estimate: code edit 40 min, test/validation 20 min, total 60 min.

### Step 17 — Deploy the server side of steps 13-16

**Goal.** Every kind steps 13-16 added is advertised.

**Read first.** As step 6.

**Do.**
- [ ] `python server-components/deploy.py`; check the capability list; publish the macro library if step 16 did not.

**Tests.** Capability check.

**Done when.** Every kind from steps 13-16 is advertised.

Estimate: code edit 0 min, test/validation 20 min, total 20 min.

### Step 18 — Remove the SMB fallback from the transports

**Goal.** A Client PC reads and writes only through the Gateway; an unavailable Gateway is reported, never worked around. Follows decision 1.

**Read first.** [workspace_read_client.py](../../frontend/app_server/services/workspace_read_client.py) `run_workspace_read`; [workspace_mutation_client.py](../../frontend/app_server/services/workspace_mutation_client.py); [engine_calculation_service.py](../../frontend/app_server/services/engine_calculation_service.py) `_select_transport`; [resq_sync_queue_service.py](../../frontend/app_server/services/resq_sync_queue_service.py); [project_settings_data_processing_rules.js](../../frontend/ui/project_settings/project_settings_data_processing_rules.js) `saveRulesDirectly`; business-logic contract rules 16-19.

**Do.**
- [ ] Both transports run `local` only in a server process; on a Client PC every failure is an error. A rejected credential reports "sign in to the server again" rather than a generic failure. Remove the now-redundant `gateway_required` arguments.
- [ ] Engine calculations and every job submit/status (rules, source refresh, ResQ sync, import backup, DFM bridge) lose their request-file branch on a Client PC.
- [ ] Delete the rules-save fallback to a direct save; a 503 shows the Engine-unavailable message.
- [ ] Rewrite contract rules 16-19 and the domain docs that describe the fallback.

**Tests.** Transport-selection tests for each failure class on a Client PC and in a server process.

**Done when.** No client code path reaches `run local()` on a Client PC; the frontend suites pass.

Estimate: code edit 50 min, test/validation 25 min, total 75 min.

### Step 19 — Remove the old SMB save path and leftover dead code

**Goal.** Delete what steps 1-18 left unreachable.

**Read first.** [engine_hosted_save_service.py](../../frontend/app_server/services/engine_hosted_save_service.py) `_run_hosted_job_impl` and its helpers; [test_engine_hosted_saves.py](../../frontend/tests/test_engine_hosted_saves.py); [dfm_persistence.js](../../frontend/ui/method_pages/dfm/dfm_persistence.js) the method-file watcher block; [snowflake_service.py](../../frontend/app_server/services/snowflake_service.py) `SNOWFLAKE_CONFIG_IMPORT_PATH`.

**Do.**
- [ ] Delete the hosted-save request-file branch; a kind the Gateway does not advertise is a 503 that says the server needs updating. Move the tests that used the branch onto the HTTP path. Update contract rules 15-16 and [hosted_save_http_transport.md](hosted_save_http_transport.md).
- [ ] Delete the DFM method-file watcher and its external-change highlight helper, bumping module stamps.
- [x] Move the Snowflake config path to local settings (done 2026-09-26: it is `snowflake_config.txt` in the per-user settings folder).
- [ ] Delete client-only SMB softeners that nothing uses any more (check `class_folder_scan_cache` and `file_read_cache` callers first; server processes still use them).

**Tests.** The suites that covered the deleted code, rewritten or removed.

**Done when.** No request file is written by client code.

Estimate: code edit 35 min, test/validation 20 min, total 55 min.

### Step 20 — Gateway sign-up without the share

**Goal.** A new PC gets its Gateway credential over HTTP, and no client can read another user's secret.

**Read first.** [hosted_save_enrollment.py](../../python-api/src/arcrho_api/hosted_save_enrollment.py); [hosted_save_enrollment_service.py](../../frontend/app_server/services/hosted_save_enrollment_service.py); [arcrho_hosted_save_http_contract.py](../../python-api/src/arcrho_hosted_save_http_contract.py); the Gateway's routes in `server-components/src/arcrho_gateway/main.py`; [hosted_workspace_http_transport.md](hosted_workspace_http_transport.md) "Authentication Posture".

**Do.**
- [ ] A Gateway enrollment route authenticated by Windows (Negotiate), which mints or returns only the caller's secret; the client stores the Gateway URL, supplied by the installer, instead of discovering it from the share.
- [ ] The client stops reading `config\arcrho_gateway.json`; the shared file becomes server-only.
- [ ] Deploy the Gateway, then check a fresh enrollment from the Client PC. The Client PC check is the user's time if it needs a new Windows profile.

**Tests.** Enrollment route tests; client enrollment test with no share access.

**Done when.** A Client PC with no share access enrolls and saves.

Estimate: code edit 60 min, test/validation 30 min, total 90 min.

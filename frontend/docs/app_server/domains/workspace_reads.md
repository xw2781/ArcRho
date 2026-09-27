# App Server Domain: Workspace Reads (Server-Hosted Transport)

## Purpose
<!-- MANUAL:BEGIN -->
Run the expensive workspace reads a Client PC performs — the reserving-class dataset/method index, a cached-dataset load, a method-window load, and the Project Settings table summary — on the ArcRho Server host over HTTP instead of over the mapped drive. This is a transport, not a domain of its own: the canonical `app_server` service function still owns each read, and it runs unchanged either locally or inside the machine-wide ArcRho Gateway, which freezes the same `frontend/app_server` and `python-api/src` trees the Engine does.
<!-- MANUAL:END -->

## Entry Points
<!-- MANUAL:BEGIN -->
No new browser-facing route. These existing routes select the transport per request through `workspace_read_client.run_workspace_read`:

| Route | Read kind | Service |
| --- | --- | --- |
| `GET /datasets/cached`, `GET /dfm/method-index` | `dataset_index` | `dataset_service.list_cached_dataset_names` / `dataset_instance_index_service.get_index` |
| `POST /dataset/cache/load` | `dataset_cache_load` | `dataset_service.load_cached_dataset_values` |
| `GET /dataset/{ds_id}` | `dataset_grid_load` | `dataset_service.get_dataset` |
| `POST /dfm/method/load` | `dfm_method_load` | `dfm_service.load_dfm_method` |
| `POST /result-selection/load` | `result_selection_load` | `result_selection_service.load_result_selection` |
| `POST /bornhuetter-ferguson/load` | `bornhuetter_ferguson_load` | `bornhuetter_ferguson_service.load_bornhuetter_ferguson_method` |
| `POST /cape-cod/load` | `cape_cod_load` | `cape_cod_service.load_cape_cod_method` |
| `POST /bootstrap/load` | `bootstrap_load` | `bootstrap_service.load_bootstrap_method` |
| `POST /bootstrap/simulate` | `bootstrap_simulate` | `bootstrap_service.simulate_bootstrap_method` |
| `POST /stochastic-consolidation/load` | `stochastic_consolidation_load` | `stochastic_consolidation_service.load_stochastic_consolidation_method` |
| `POST /stochastic-consolidation/consolidate` | `stochastic_consolidation_consolidate` | `stochastic_consolidation_service.consolidate_stochastic_consolidation_method` |
| `POST /stochastic-consolidation/segments/candidates` | `stochastic_consolidation_candidates` | `stochastic_consolidation_service.list_stochastic_consolidation_candidates` |
| `POST /excel_links/list` | `excel_link_listing` | `excel_link_service.list_reserving_class_excel_links` |
| `POST /excel_links/check` | `excel_link_value_check` | `excel_link_service.check_reserving_class_excel_link_values` |
| `POST /excel/read_cells_batch` | `excel_cell_values` | `excel_service.excel_read_cells_batch` |
| `GET /datasets/dependency-graph` | `dataset_dependency_graph` | `dataset_dependency_graph_service.build_reserving_class_dependency_graph` |
| `GET /reserving_class_paths_with_data` | `reserving_classes_with_data` | `reserving_class_service.list_reserving_classes_with_data` |
| `GET /table_summary` | `table_summary` | `table_summary_service.get_table_summary` |
| `POST /dfm/rpc-bridge/compare` | `dfm_rpc_bridge_compare` | `dfm_rpc_bridge_service.hosted_compare` |
| (no route; the ResQ import and sync macros call `run_workspace_read` directly through `arcrho_api.bridge_liveness.observe_bridge_liveness`) | `bridge_worker_liveness` | `bridge_liveness_service.get_bridge_worker_liveness` |
| `GET /server/status` (only for a server folder that is not on a fixed disk of this PC) | `server_component_status` | `server_component_status_service.get_server_component_status` |
| `GET /audit_log` | `project_audit_log` | `audit_service.read_audit_log` |
| `GET /project_settings` | `project_settings_sources` | `project_settings_service.list_project_settings_sources` |
| `GET /project_settings/{source}/folders` | `project_folders` | `project_settings_service.get_project_folders` |
| `GET /project_settings/{source}` | `project_registry` | `project_settings_service.get_project_settings` |
| `GET /arcrho/projects` | `project_names` | `arcrho_runtime_service.arcrho_projects` |
| `GET /general_settings` | `general_settings` | `project_settings_service.get_general_settings` |
| `GET /dataset_types` | `dataset_types_table` | `dataset_types_service.get_dataset_types_table` |
| `GET /field_mapping` | `field_mapping` | `field_mapping_service.get_field_mapping` |
| `GET /source_table`, `GET /source_table/file_status` | `source_table_settings` | `source_table_service.read_source_table_settings` (the client adds its own `driver_available` and stats the external CSV itself) |
| `GET /source_table/connections` | `mssql_connections` | `source_table_service.load_mssql_connections` |
| `GET /dataset/number-format-defaults` | `dataset_number_format_defaults` | `dataset_number_format_service.get_preferences` |
| `GET /app/user-identity` | `user_identity` | `user_identity_service.get_current_identity` (under the signed user's acting identity) |
| `GET /data_processing_rules` | `data_processing_rules` | `data_processing_rules_service.read_data_processing_rules` |
| `POST /data_processing_rules/validate` | `data_processing_rules_validate` | `data_processing_rules_service.check_data_processing_rules` |
| `GET /reserving_class_combinations` | `reserving_class_combinations` | `reserving_class_service.read_reserving_class_combinations` |
| `GET /reserving_class_path_tree` | `reserving_class_path_tree` | `reserving_class_service.read_reserving_class_path_tree` |
| `GET /reserving_class_path_tree/children` | `reserving_class_path_tree_children` | `reserving_class_service.read_reserving_class_path_tree_children` (writes nothing) |
| `GET /reserving_class_types` | `reserving_class_types` | `reserving_class_service.read_reserving_class_types` (writes nothing) |
| `GET /reserving_class_hidden_paths` | `reserving_class_hidden_paths` | `reserving_class_service.read_hidden_paths` (the signed user's file) |
| `GET /reserving_class_filter_spec` | `reserving_class_filter_spec` | `reserving_class_service.read_filter_spec` (the signed user's file) |
| `GET /project-user-preferences` | `project_user_preferences` | `project_user_preferences_service.get_preferences` (the signed user's file) |

The project configuration reads from `project_settings_sources` down were added by step 7 of [client_smb_retirement.md](../../../../docs/plans/client_smb_retirement.md). Each is called with `gateway_required=True`, so a Client PC answers `503` rather than reading the share, and each service returns the route's whole answer, refusals included, so the two transports answer alike.

The reserving-class and project-user-preference reads from `reserving_class_combinations` down were added by step 8, on the same terms; step 8 also made the existing `reserving_classes_with_data` read Gateway-required.

Gateway side: `POST /api/workspace-reads` on the Gateway (`arcrho_workspace_read_contract.WORKSPACE_READ_PATH`), authenticated with the same per-user HMAC headers as hosted saves. `GET /api/capabilities` advertises `workspace_read_kinds`.
<!-- MANUAL:END -->

## Key Files
<!-- MANUAL:BEGIN -->
- `python-api/src/arcrho_workspace_read_contract.py` - The canonical `WORKSPACE_READ_KINDS` registry (kind → service module, function, required/optional keyword arguments), request validation, route path, timeout, and the `X-ArcRho-Workspace-Root` response header name.
- `app_server/services/workspace_read_client.py` - Client transport selection, capability probe cache (`cached_gateway_capabilities`), request signing and posting (`post_signed_json`, `GatewayTransportFailure` with its `accepted` flag), server-root path rebasing, local fallback, and the read-latency record. The Engine calculation transport ([`engine_calculations`](engine_calculations.md)) reuses these helpers.
- `app_server/services/client_save_latency_log_service.py` - `append_client_read_latency` writes `%LOCALAPPDATA%\ArcRho\logs\client_read_latency.jsonl` (rotated like the save log).
- `server-components/src/arcrho_gateway/workspace_reads.py` - Server-side executor: authenticates, validates against the registry, imports the bundled service, runs it under `acting_identity`, and maps a service `HTTPException` to the same status.
- `server-components/src/arcrho_gateway/main.py` - Route dispatch and the capability field.
- `server-components/src/arcrho_gateway/build_exe.py` - Bundles `ENGINE_BUNDLED_SOURCES` and every registered service module into the gateway executable.
- The routers listed above - Each passes only the registry's arguments and supplies its local service call.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Transport selection, per request: a process running with `ARCRHO_RUNTIME_SERVER_ROOT` set (Engine, Bridge, Gateway) always reads locally so the gateway can never route a read back to itself; otherwise the local `%APPDATA%\ArcRho\arcrho_gateway.json` credential must be enabled, and the gateway's `/api/capabilities` (cached 30 s on success, 10 s on failure) must list the read kind. Any other outcome runs the service locally over the mapped drive exactly as before.
- Server identity: every capability probe (`hosted_save_http_client.probe_gateway`, behind `cached_gateway_capabilities` and the hosted-save probe) compares the Gateway's `server_id` with the `server_id` in the active root's `config\config.json`. They must be equal; both missing is the one agreement allowed without an id (a server whose Gateway predates ids). Anything else raises `GatewayServerMismatch` (409, "signed in to a different server than the folder it is pointed at"), which is never treated as an unreachable Gateway, so the read, mutation, save or calculation is refused rather than run over the share. A found root id is kept for the process lifetime because it is written once; a missing one is re-read after 30 s. Server processes skip the check.
- Fallback rule: reads are pure functions of the workspace, so — unlike hosted saves — a gateway-layer failure (unreachable, authentication refused, an older gateway without the route, an invalid response) falls back to the local path. A refusal raised by the hosted service itself (404 method not found, 409 legacy pair, 423 lock, …) is recognized by the `X-ArcRho-Workspace-Root` header the gateway sets whenever the read ran, and passes through with the same status the local path would have raised. A gateway timeout (`WORKSPACE_READ_TIMEOUT_SECONDS`, 120 s) surfaces as `504` rather than doubling the wait locally.
- Dependency Graph (`dataset_dependency_graph`) opts into `gateway_required=True`: Client PCs surface a disabled, unsupported, or failed Gateway read without visiting the workspace over SMB. Server processes retain the canonical local service. This required transport takes precedence over the general fallback rules above.
- Path rebasing: the gateway answers with the server's workspace root in `X-ArcRho-Workspace-Root`; the client rewrites every string in the payload that starts with that root onto its own `config.get_root_path()`, so `folder_paths`, the cached CSV `path`, `sidecar_path`, and the master table path look exactly as a local read would have produced them. Nothing else in the payload is touched.
- Per-process state: `POST /dataset/cache/load` registers the returned dataset `id` → rebased CSV path in this process through `dataset_service.register_dataset_handle`, so the id-addressed grid read and patch routes keep working after a remote load. The `id` itself is the server-side hash and is only a handle. `GET /dataset/{ds_id}` (`dataset_grid_load`) resolves that handle on the server only when the Gateway process registered it itself (a hosted cached load or a hosted dataset run — see [`engine_calculations`](engine_calculations.md)); an answer without a dataset `id` means the Gateway does not know the handle (for example after a Gateway restart), and the route resolves it locally rather than reporting 404.
- Identity: the request carries the enrolled `UserName` and the client's resolved display name; the gateway binds `user_identity_service.acting_identity` around the read so a load that performs a one-time on-disk upgrade (legacy DFM/RS) stamps the opening user, not the gateway's service profile.
- No idempotency receipt: reads keep no receipt and no request-ID replay; a lost response is simply retried by the caller.
- Bridge liveness (`bridge_worker_liveness`): the ResQ macros poll this once per second while a Bridge request runs. It answers with every worker heartbeat's age and usability, plus the polled request's status payload and the age of its status file, all measured on the server host — over the mapped drive Windows serves those timestamps from a cache that can lag a heartbeat written every second by about ten seconds, which is why a Client PC's own reading is not trusted. The rule that turns the looks into a verdict lives in `arcrho_api.bridge_liveness`: a live heartbeat or a status file touched within the six-second window is life, and only thirty seconds of consecutive silent looks (`BRIDGE_SILENCE_LIMIT_SEC`) abandon the wait. The local fallback of this read is the same look over the drive. The sync and export macros poll their request's status through this same look, and publish the request through the `resq_sync_request_publish` hosted mutation, so inside the app the sync queue is never touched over the drive; the import macro's request publication is the one queue write still made from the client.
- Component status (`server_component_status`): the Server tab's panel. It is Gateway-required: a server whose folder is on a fixed disk of this PC is read straight from disk by `server_profile_service.server_component_status` without asking the Gateway (so a stopped Gateway still shows), and any other server is asked through its Gateway only. A Gateway that does not answer, or one too old to advertise the kind, gives an `answering: false` payload with a plain `detail` and no rows; nothing is ever read over the share. The heartbeat and stop-switch rules are `arcrho_server_component_status`, shared with Admin Control.
- Diagnostics: one record per read in `client_read_latency.jsonl` with `read_kind`, `transport` (`http_gateway` or `smb`), `reason` when local (`gateway_disabled`, `gateway_unreachable`, `kind_not_advertised`, `gateway_rejected:<code>`, `server_process`, `gateway_config_invalid`), `total_ms`, `remote_ms`, `http_status`, `response_bytes`, and the logical project/class/object names — never payload data. Engine calculation requests append to the same file with `read_kind: engine_calculation`.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Move another read to the server: add one `WorkspaceReadKind` entry naming the service function and its keyword arguments, then wrap the route's service call in `workspace_read_client.run_workspace_read(...)`. `test_workspace_reads.py` fails if the registry names an argument the function lacks or omits one it requires; the gateway build validates the import graph and bundles the module automatically. Rebuild and redeploy the gateway.
2. A read that registers process-local state (like the dataset handle registry) must supply a `finalize` hook so the client process adopts that state from a remote payload.
3. Machine-local values that are not paths (a driver-availability flag, the process account) must not be exposed through this transport; keep such reads local or split the machine-local part out. A machine-local *answer* is different from a machine-local value: `excel_link_listing` deliberately reports whether the server host can open each linked workbook, and `excel_link_value_check` and `excel_cell_values` open them there to read the linked cells, because that host is the one every retarget and refresh reads workbooks on, so the server's view is the truth the user needs and a Client PC's would mislead. `excel_cell_values` is also the one registered kind that names no project or reserving class: each item carries the workbook path it asks about, and the read touches no workspace file.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- The gateway is one process for the whole fleet. Its `ThreadingHTTPServer` gives every connection a thread but has no concurrency cap yet; a burst of loads competes with hosted saves in the same process. See `docs/plans/hosted_workspace_http_transport.md` for the bounded-server foundation work.
- A read whose service refusal text embeds a server path is redacted (`[path]`) on the wire, so the client sees slightly less detail than a local refusal would show.
- Rebasing matches on the server root string; a payload string that merely mentions the root (a note) is rebased too. That is harmless and arguably desirable, but it is not a typed field list.
- The pilot transport is plain HTTP with HMAC; full dataset and method payloads now travel unencrypted on the internal network. TLS is the first gate before broader rollout (see the plan's Authentication Posture).
<!-- MANUAL:END -->

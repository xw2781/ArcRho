# App Server Domain: DFM RPC Bridge

## Purpose
<!-- MANUAL:BEGIN -->
DFM RPC bridge routes create request files for remote data-engine DFM method sync, compare local and returned remote DFM JSON `last modified` timestamps, apply newer remote JSON locally through an explicit component sync list, finalize keeping local JSON without sending a `SyncDFM` request, and send confirmed `SyncDFM` write-back requests to the RPC server through `arcrho_bridge`.
<!-- MANUAL:END -->

## Entry Points
<!-- MANUAL:BEGIN -->
Routes:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/dfm/rpc-bridge/sync` | Write `Function = DFM` request, wait up to the requested timeout for remote DFM JSON, and return comparison metadata plus local/remote JSON snapshots. |
| `POST` | `/dfm/rpc-bridge/compare` | Compare current local and remote DFM JSON file metadata without sending a request, returning the same snapshot fields. |
| `POST` | `/dfm/rpc-bridge/apply` | Apply the remote DFM JSON over the local DFM JSON after `Update Local DFM` using the explicit component sync list, preserving local-only components such as labels and analysis snapshots, returning missing RPC component names for the UI result message, writing the merged method with the row-compact DFM method JSON formatter, return payload for frontend reload, and delete the remote RPC JSON. |
| `POST` | `/dfm/rpc-bridge/keep-local` | Keep the local DFM JSON unchanged after `Keep Using Local` and delete the remote RPC JSON without writing a `SyncDFM` request. |
| `POST` | `/dfm/rpc-bridge/cleanup` | Delete temporary remote DFM JSON and `SyncDFM` status JSON for the current project/reserving-class/method after the sync dialog is dismissed or a pending sync returns after dismissal. |
| `POST` | `/dfm/rpc-bridge/update-remote` | Require explicit RPC server write confirmation, write `Function = SyncDFM` request with the local method JSON path, wait for the `SyncDFM...json` status response, return pass/fail message, and delete the stale remote RPC JSON. |
<!-- MANUAL:END -->

## Key Files
<!-- MANUAL:BEGIN -->
- `app_server/api/dfm_rpc_bridge_router.py` - Thin API routes.
- `app_server/schemas/dfm_rpc_bridge.py` - Request schemas.
- `app_server/services/dfm_rpc_bridge_service.py` - Path resolution, request-file writes, wait/compare/apply/update-remote behavior.
- `ui/dfm/dfm_rpc_bridge_client.js` - Frontend route calls and sync flow.
- `ui/dfm/dfm_rpc_bridge_dialog.js` - Floating comparison/status UI.
- `ui/dfm/dfm_rpc_bridge_pathbar.js` - DFM path-bar Sync button.
<!-- MANUAL:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Before writing each `Function = DFM` request, the app server deletes any existing returned DFM JSON and `SyncDFM` status JSON for that project/reserving-class/method from `projects/<project>/data/<ReservingClassFolder>/methods/tmp_rpc`, so the sync comparison can only use a fresh RPC bridge response. `Function = DFM` request files contain Details page fields plus `DataPath`, where `DataPath` points to the expected returned remote DFM method JSON under that RPC temp folder.
- `Function = SyncDFM` request files contain the same Details page fields plus `DataPath`, where `DataPath` points to an expected `SyncDFM...json` status file. They also include `MethodJsonPath` for the local DFM JSON to write into the RPC server and `RPCServerWriteConfirmed = true`; the app-server route rejects update-remote requests without this explicit confirmation.
- Request files are flat JSON `request-*.json` payloads with native booleans/numbers. Temporary `.tmp` files are atomically renamed to `.json`, and `arcrho_bridge` scans JSON requests only.
- `SyncDFM` status JSON must include fields that let the frontend report final result, for example `ok`, `status`, and `message`.
- `arcrho_bridge` handles confirmed `SyncDFM` requests by reading `MethodJsonPath`, writing excluded ratio cells, User Entry average-formula values with `SetUserRatios`, selected average formula indexes with `SetSelectedRatios`, and notes to the RPC server DFM method, calling `Save()`, and writing the status JSON to `DataPath`. ResQ exposes DFM cell notes as a read-side `CellNotes` string, so RPC bridge imports them into returned DFM JSON and local apply syncs them, while remote write-back leaves existing ResQ cell notes unchanged until a safe per-cell setter is available.
- Compare responses include snapshots read from canonical grouped local and remote DFM JSON files: `method metadata`.`last modified`, `ratio triangle`.`excluded` dimensions/excluded count/full preview with `0`/`1`/`2` values preserved, preview `origin_labels` and `development_labels` for ratio-cell tooltips, `average formulas`.`label` plus `average formulas`.`selected` dimensions/selected count/full preview for formula-selection diffs, cell-note entries, and notes preview.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Local DFM method JSON path: `projects/<project>/data/<ReservingClassFolder>/methods/DFM@<Name>.json`.
- Remote DFM method JSON path: `projects/<project>/data/<ReservingClassFolder>/methods/tmp_rpc/DFM@<Name>.json`.
- Remote update status JSON path: `projects/<project>/data/<ReservingClassFolder>/methods/tmp_rpc/SyncDFM@<Name>.json`.
- `<ReservingClassFolder>` and `<Name>` use the shared reversible `_%XX_` filename escaping rule for Windows-invalid filename characters.
- Applying the remote version writes the canonical GUI-tab grouped DFM method JSON with the same row-compact layout used by normal DFM saves, so any 2D array remains one child row per JSON line, including `ratio triangle`.`excluded`, `average formulas`.`selected`, input data triangle values, `ratio triangle`.`ratio values`, `average formulas`.`values`, and extra or nested 2D arrays when present.
- Applying the remote version is driven by an explicit component list matching the current grouped RPC JSON shape. Synced RPC components include Details fields, `ratio triangle`.`excluded`, average formula labels/settings/selected values, `ratios tab`.`cell notes`, Results ratio-basis settings, notes, and `method metadata`.`last modified`.
- Local-only or active-page-owned components are explicitly preserved when local values exist: Data-tab labels, Ratios-tab labels, input data triangle values, input data triangle CSV path, ratio values, and ultimate vector. `average formulas`.`values` merges by row so populated RPC rows update local values while empty RPC rows preserve local rows.
- The apply response includes `sync_report.missing_components`; the frontend result dialog lists required RPC component paths that were absent from the returned RPC JSON. `results tab`.`ultimate vector csv path` is optional for RPC sync and is not listed when absent.
- JSON request files are kept for audit/debug. Returned RPC bridge JSON files are deleted before each new sync request, after the user completes the final action, closes the sync review window without choosing an action, or closes the window while a pending sync later returns.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Change DFM request-file contract: update schema/service, frontend client payloads, and this domain doc.
2. Change comparison actions: update `dfm_rpc_bridge_dialog.js`, `dfm_rpc_bridge_client.js`, and route behavior.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Request and return-path filename rules must match data-engine expectations exactly.
- Timestamp comparison uses the canonical `last modified` value inside each DFM JSON file.
- Sync waits are intentionally short; timeout handling must remain clear to users.
<!-- MANUAL:END -->

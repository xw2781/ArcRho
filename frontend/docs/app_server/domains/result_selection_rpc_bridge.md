# App Server Domain: Result Selection RPC Bridge

## Purpose
<!-- MANUAL:BEGIN -->
Result Selection RPC bridge routes create request files for remote ResQ Result Selection sync, compare local `RS@...json` and returned remote `RS@...json` timestamps, apply returned ResQ JSON locally, and send confirmed `SyncResultSelection` write-back requests through the shared RPC bridge request folder.
<!-- MANUAL:END -->

## Entry Points
<!-- MANUAL:BEGIN -->
Routes:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/result-selection/rpc-bridge/sync` | Write `Function = ResultSelection` request, wait up to the requested timeout for remote Result Selection JSON, and return comparison metadata plus local/remote Method tab snapshots. |
| `POST` | `/result-selection/rpc-bridge/compare` | Compare current local and remote Result Selection JSON file metadata without sending a request, returning the same snapshot fields. |
| `POST` | `/result-selection/rpc-bridge/apply` | Apply the remote Result Selection JSON over the local `RS@...json`, return the payload for frontend reload, and delete the remote RPC JSON. |
| `POST` | `/result-selection/rpc-bridge/keep-local` | Keep the local Result Selection JSON unchanged and delete the remote RPC JSON without writing a `SyncResultSelection` request. |
| `POST` | `/result-selection/rpc-bridge/cleanup` | Delete temporary remote Result Selection JSON and `SyncResultSelection` status JSON for the current project/reserving-class/method after the sync dialog is dismissed or a pending sync returns after dismissal. |
| `POST` | `/result-selection/rpc-bridge/update-remote` | Require explicit RPC server write confirmation, write `Function = SyncResultSelection` request with the local method JSON path, wait for the status response, return pass/fail message, and delete the stale remote RPC JSON. |
<!-- MANUAL:END -->

## Key Files
<!-- MANUAL:BEGIN -->
- `app_server/api/result_selection_rpc_bridge_router.py` - Thin API routes.
- `app_server/schemas/result_selection_rpc_bridge.py` - Request schemas.
- `app_server/services/result_selection_rpc_bridge_service.py` - Path resolution, request-file writes, wait/compare/apply/update-remote behavior.
- `ui/result_selection/result_selection_rpc_bridge_client.js` - Frontend route calls and sync flow.
- `ui/result_selection/result_selection_rpc_bridge_dialog.js` - Floating comparison/status UI.
- `ui/result_selection/result_selection_main.js` - Method toolbar Sync button wiring.
<!-- MANUAL:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Before writing each `Function = ResultSelection` request, the app server deletes any existing returned Result Selection JSON and `SyncResultSelection` status JSON for that project/reserving-class/method from `projects/<project>/data/<ReservingClassFolder>/methods/tmp_rpc`, so the comparison uses a fresh RPC bridge response. `DataPath` points to the expected returned remote `RS@<Name>.json`.
- `Function = SyncResultSelection` request files include `MethodJsonPath` for the local Result Selection JSON to write into the RPC server and `RPCServerWriteConfirmed = true`; the app-server route rejects update-remote requests without this explicit confirmation.
- Request files are flat JSON `request-*.json` payloads with native booleans/numbers. Temporary `.tmp` files are atomically renamed to `.json`, matching the DFM RPC bridge request pattern.
- `SyncResultSelection` status JSON should include fields that let the frontend report final result, for example `ok`, `status`, and `message`.
- `arcrho_bridge` handles `Function = ResultSelection` requests by smart-matching the requested ArcRho method/output name to ResQ Result Selection names without renaming ResQ instances, then exporting Method tab data into grouped `RS@<Name>.json`, using ResQ `OriginCount` for row count and including loaded source values, source weights, the derived `calculated_ultimate`, explicit `ultimate_overrides`, final `selected_ultimate`, notes, and `method_metadata.last_modified`; persisted numeric method arrays are rounded to at most six decimal places. It handles confirmed `Function = SyncResultSelection` requests by reading `MethodJsonPath`, writing matching source weights from `loaded_datasets` with `SetWeights`, clearing and reapplying only explicit ultimate overrides with `SetUltimates`, updating notes and Origin Length, calling `Save()`, and writing the status JSON to `DataPath`.
- Compare responses include snapshots read from canonical grouped Result Selection JSON files: `method_metadata.last_modified`, Details name/output/origin length, Method source count, selected positive-weight count, `loaded_datasets` rows with selected counts, selected ultimate preview, and notes preview.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Local Result Selection method JSON path: `projects/<project>/data/<ReservingClassFolder>/methods/RS@<Name>.json`.
- Remote Result Selection method JSON path: `projects/<project>/data/<ReservingClassFolder>/methods/tmp_rpc/RS@<Name>.json`.
- Remote update status JSON path: `projects/<project>/data/<ReservingClassFolder>/methods/tmp_rpc/SyncResultSelection@<Name>.json`.
- `<ReservingClassFolder>` and `<Name>` use the shared reversible `_%XX_` filename escaping rule for Windows-invalid filename characters.
- Applying the remote version writes the returned grouped Result Selection JSON to the local method path. The frontend then reloads that payload and saves Result Selection outputs so the generated vector CSV and sidecar remain aligned with the chosen Method tab version.
- JSON request files are kept for audit/debug. Returned RPC bridge JSON files are deleted before each new sync request, after the user completes the final action, closes the sync review window without choosing an action, or closes the window while a pending sync later returns.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Change Result Selection request-file contract: update schema/service, frontend client payloads, external bridge worker, and this domain doc.
2. Change comparison preview fields: update `result_selection_rpc_bridge_service.py`, `result_selection_rpc_bridge_dialog.js`, and this domain doc.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Request and return-path filename rules must match the external RPC bridge worker exactly.
- Timestamp comparison uses `method_metadata.last_modified` inside each Result Selection JSON file. If an external bridge omits that field, comparison can still show both files but may not reliably identify the newer version.
- Sync waits are intentionally short; timeout handling must remain clear to users.
<!-- MANUAL:END -->

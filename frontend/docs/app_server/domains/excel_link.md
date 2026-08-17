# App Server Domain: excel_link

## Purpose
<!-- MANUAL:BEGIN -->
Reserving-class Excel link inventory and workbook retargeting for the Project Instance Excel Link Manager.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.excel_link.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/excel_links/list` | `excel_links_list` | `ExcelLinkListRequest` | [`app_server/schemas/excel_link.py`](../../../app_server/schemas/excel_link.py) | `excel_link_service.list_reserving_class_excel_links`, `excel_link_service.resolve_workbook_stats`, `excel_link_service.scan_reserving_class_excel_links`, `workspace_read_client.run_workspace_read` |
| `POST` | `/excel_links/retarget` | `excel_links_retarget` | `ExcelLinkRetargetRequest` | [`app_server/schemas/excel_link.py`](../../../app_server/schemas/excel_link.py) | `excel_link_service.retarget_reserving_class_workbook` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.excel_link.key_files -->
- [`app_server/api/excel_link_router.py`](../../../app_server/api/excel_link_router.py) - Reserving-class Excel link list/retarget routes.
- [`app_server/services/excel_link_service.py`](../../../app_server/services/excel_link_service.py) - Excel link scan, workbook grouping, and reference retargeting.
- [`app_server/schemas/excel_link.py`](../../../app_server/schemas/excel_link.py) - Excel link request payload schemas.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Called by the Project Instance Excel Link Manager, which runs as a nested pi-window page (`ui/project_instance/excel_links_window.html`) pinned to one reserving class. See [`docs/ui/project_instance.md`](../../ui/project_instance.md).
- `/excel_links/list` scans the selected reserving class's dataset sidecars (`external_links`) and v2 DFM method JSONs (Ratios User Entry `inputs`) with bounded parallel reads, groups references by workbook path (case/separator-insensitive), and reports per-workbook usage counts plus file existence/mtime via the excel domain's batched stat helper. Unreadable files are returned in `errors` instead of being silently dropped.
- That listing is split across two machines. The scan — every sidecar and method JSON in the class, ~140 files and the whole cost of this load from a Client PC — is the registered `excel_link_scan` [workspace read](workspace_reads.md) and runs on the ArcRho Server host when the gateway offers it. Resolving each linked workbook's existence stays in the calling process, because linked workbooks live on other file servers reached through drive letters the Client PC maps and the server host may not; hosting that half would report every such workbook as missing. `scan_reserving_class_excel_links` and `resolve_workbook_stats` are the two halves, `list_reserving_class_excel_links` composes them locally, and `excel_link_router._load_listing` composes the hosted form.
- `/excel_links/retarget` repoints every reference from one workbook to a picked replacement across all datasets and DFM methods in the reserving class, re-scanning each file under the reserving-class I/O lock, then returns per-file results plus the refreshed workbook inventory in the same response so the client pays one round trip. The rewrite itself is always local — it writes, and a value refresh opens the picked workbook through the caller's drive mappings — but the trailing inventory comes from the same hosted loader the route injects as `listing`.
- With `refresh_values: true`, the retarget also recalculates affected values: it requires a live Engine up front, reads every mapped cell (including other-workbook references inside affected DFM formulas) in one deduplicated COM batch, and commits changed values through `save_dataset_sidecar` / `save_dfm_method` so audit entries, review statuses, output publication, and Engine dependent propagation behave exactly like a normal save. Value rules mirror the client Links-tab refresh: dataset links accept any finite number, store blank cells as null, and stay per-link atomic on failures; DFM cells require a finite result greater than zero rounded to six decimals, standalone ranges spill literal values into non-anchor User Entry cells, and a formula mixing Excel and dataset references reports a per-cell error to be refreshed from the DFM Links tab. Files whose values did not change (or whose reads failed) keep the metadata-only reference rewrite.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- By default retargeting rewrites reference text only; stored values keep their current snapshots, so refresh from the Dataset/DFM Links tabs stays the explicit way to read the new workbook. The opt-in `refresh_values` mode is the exception documented above.
- Dataset sidecar rewrites preserve `updated_at`, `audit_log`, targets, and status fields, so dependent review statuses do not flip for a path-only change; the sidecar file is replaced atomically under its write lock.
- DFM rewrites patch `inputs`/`display inputs` through the canonical `dfm_contract.apply_owned_patch` (Excel-linked values stay frozen, revisions recomputed, `last modified` stamped), assert the publication revision is unchanged, and replace only the method JSON. Output CSVs and the output sidecar are untouched, and no propagation job is submitted. A concurrent edit that would change the publication aborts that file with a per-file error.
- Legacy v1 DFM method files are ignored by both scan and retarget; they surface only after their one-time v2 upgrade.
- After any rewrite the reserving-class `index.json` is rebuilt once; open Dataset windows learn about the on-disk change through the existing object-change fingerprint watch.
- The new workbook must exist at retarget time; picking the already-linked workbook is a no-op success.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Add link source kinds (other method types): extend the scan/rewrite pair in `excel_link_service.py` and keep the reference syntax mirrored with `ui/shared/integrations/excel_reference.js`.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- The Python reference parser must stay in sync with the canonical frontend Excel-reference syntax.
- Retargeting changes saved files that open Dataset/DFM windows may hold in memory; their change-watch alert and DFM owned-revision conflicts are the guardrails.
<!-- MANUAL:END -->

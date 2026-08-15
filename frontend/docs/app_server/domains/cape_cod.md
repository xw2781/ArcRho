# App Server Domain: Cape Cod

## Purpose
<!-- MANUAL:BEGIN -->
Own the self-contained Cape Cod v1 contract, aggregate two-file load (plus the derived as-if ultimates triangle), revision-aware transactional save, and eager refresh after managed precedent updates.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.cape_cod.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/cape-cod/load` | `load_cape_cod` | `CapeCodIdentityRequest` | [`app_server/schemas/cape_cod.py`](../../../app_server/schemas/cape_cod.py) | `cape_cod_service.load_cape_cod_method`, `workspace_read_client.run_workspace_read` |
| `POST` | `/cape-cod/refresh` | `refresh_cape_cod` | `CapeCodIdentityRequest` | [`app_server/schemas/cape_cod.py`](../../../app_server/schemas/cape_cod.py) | `cape_cod_service.refresh_cape_cod_method` |
| `POST` | `/cape-cod/save` | `save_cape_cod` | `CapeCodSaveRequest` | [`app_server/schemas/cape_cod.py`](../../../app_server/schemas/cape_cod.py) | `engine_hosted_save_service.run_hosted_save` |
| `POST` | `/cape-cod/save/plan` | `plan_cape_cod_save` | `CapeCodSaveRequest` | [`app_server/schemas/cape_cod.py`](../../../app_server/schemas/cape_cod.py) | `engine_hosted_save_service.run_hosted_save_plan` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.cape_cod.key_files -->
- [`app_server/api/cape_cod_router.py`](../../../app_server/api/cape_cod_router.py) - Aggregate Cape Cod load/save/refresh routes.
- [`app_server/services/cape_cod_service.py`](../../../app_server/services/cape_cod_service.py) - V1 contract persistence, transactional publication, and eager dependency refresh.
- [`app_server/schemas/cape_cod.py`](../../../app_server/schemas/cape_cod.py) - Cape Cod identity and revision-aware save request models.
- [`ui/method_pages/cape_cod/cape_cod_main.js`](../../../ui/method_pages/cape_cod/cape_cod_main.js) - Cape Cod page state and aggregate persistence flow.
- [`ui/method_pages/cape_cod/cape_cod_json_contract.js`](../../../ui/method_pages/cape_cod/cape_cod_json_contract.js) - Canonical browser-side v1 payload builder.
- [`ui/method_pages/cape_cod/cape_cod_method_api.js`](../../../ui/method_pages/cape_cod/cape_cod_method_api.js) - Aggregate Cape Cod transport adapter.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- A valid v1 load performs exactly two bounded parallel JSON reads: `methods/CC@<Name>.json` and `sidecars/<Name>.json`, plus one read of the latest-triangle source needed to build the derived `ultimates_triangle` response field (returned as `null` when the triangle is unavailable or irregular, never failing the load).
- Save compares Cape Cod-owned and derived revisions separately. Submitted parameter edits (trend/decay/scaling/overrides/details) can rebase over a concurrent automatic source refresh, while a conflicting owned edit is rejected. Every explicit Save acknowledges the output as Current and starts downstream propagation.
- Publication serializes within the reserving class, stages changed method/CSV/sidecar files, rolls back on failure, and writes the sidecar last.
- Managed source saves follow registered reverse edges and refresh only affected Cape Cod source snapshots via the shared refresh waves (`include_cape_cod` guard prevents recursion). Refreshed outputs remain Review Needed until their own explicit Save.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- `POST /cape-cod/load` is the `cape_cod_load` Server-hosted workspace read: when the Save Gateway advertises it, the method JSON and sidecar are read on the server host and returned verbatim; otherwise the service runs locally. See [`workspace_reads`](workspace_reads.md).
- The only supported marker is `arcrho-cape-cod-method-by-tab-v1`.
- Method JSON owns source names and embedded value snapshots (Latest diagonal, Exposure, Prior Ultimate), the owned parameters (trend rate, auto fit, decay, scaling, alternative calculation, trend factor overrides), origin labels, every derived Method-tab column, timestamps, and deterministic owned/derived/publication revisions. When Auto Fit is on the trend rate is derived (refit on every recalculation) and overrides are cleared.
- All calculations live in `python-api/src/arcrho_api/cape_cod_contract.py`; the service never computes values itself. Derived columns are validated on save to match the embedded snapshots exactly.
- The output sidecar owns Notes, Audit Log, status, `Precedents` (Latest, Exposure, Prior Ultimate), and `Dependents`. The reserving-class `index.json` remains a minimal scalar inventory.
- The ultimates triangle is derived display state computed on demand from the latest triangle and current method parameters; it is never persisted.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Direct out-of-band source edits do not publish a dependency event; use a managed ArcRho save or explicit repair.
- Source refresh maps rows onto the persisted method origin axis; a geometry change that cannot fit that axis retains the prior publication and leaves the branch Review Needed.
- A failed dependent branch does not roll back the already-committed upstream save.
<!-- MANUAL:END -->

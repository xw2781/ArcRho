# App Server Domain: arcrho

## Purpose
<!-- MANUAL:BEGIN -->
ArcRho calculations/precheck domain.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.arcrho.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/arcrho/headers` | `arcrho_headers` | `ArcRhoHeadersRequest` | [`app_server/schemas/arcrho.py`](../../../app_server/schemas/arcrho.py) | `arcrho_runtime_service.arcrho_headers` |
| `POST` | `/arcrho/headers/cache/clear` | `clear_arcrho_headers_cache` | `ArcRhoHeadersCacheClearRequest` | [`app_server/schemas/arcrho.py`](../../../app_server/schemas/arcrho.py) | `arcrho_runtime_service.clear_arcrho_headers_cache` |
| `GET` | `/arcrho/projects` | `arcrho_projects` | - | - | `arcrho_runtime_service.arcrho_projects` |
| `POST` | `/arcrho/tri` | `arcrho_tri` | `ArcRhoTriRequest` | [`app_server/schemas/arcrho.py`](../../../app_server/schemas/arcrho.py) | `arcrho_runtime_service.run_arcrho_tri` |
| `POST` | `/arcrho/tri/precheck` | `arcrho_tri_precheck` | `ArcRhoTriRequest` | [`app_server/schemas/arcrho.py`](../../../app_server/schemas/arcrho.py) | - |
| `POST` | `/arcrho/tri/refresh` | `arcrho_tri_refresh` | `ArcRhoTriRequest` | [`app_server/schemas/arcrho.py`](../../../app_server/schemas/arcrho.py) | `arcrho_runtime_service.run_arcrho_tri` |
| `POST` | `/arcrho/vec` | `arcrho_vec` | `ArcRhoVecRequest` | [`app_server/schemas/arcrho.py`](../../../app_server/schemas/arcrho.py) | `arcrho_runtime_service.run_arcrho_tri` |
| `POST` | `/arcrho/vec/precheck` | `arcrho_vec_precheck` | `ArcRhoVecRequest` | [`app_server/schemas/arcrho.py`](../../../app_server/schemas/arcrho.py) | - |
| `POST` | `/arcrho/vec/refresh` | `arcrho_vec_refresh` | `ArcRhoVecRequest` | [`app_server/schemas/arcrho.py`](../../../app_server/schemas/arcrho.py) | `arcrho_runtime_service.run_arcrho_tri` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.arcrho.key_files -->
- [`app_server/api/arcrho_router.py`](../../../app_server/api/arcrho_router.py) - ArcRho tri/precheck/header endpoints.
- [`app_server/services/arcrho_runtime_service.py`](../../../app_server/services/arcrho_runtime_service.py) - ArcRho processing and project listing.
- [`app_server/schemas/arcrho.py`](../../../app_server/schemas/arcrho.py) - ArcRho request schemas.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Called by dataset/workflow actions requiring ArcRho processing.
- Result Selection can request engine-generated source triangles or vectors at a selected origin length without updating the source sidecar by passing `WriteSidecar: false`.
- Project Instance Temporary view reuses a valid canonical cache read-only when possible; otherwise it writes generated or derived CSV output to the selected reserving-class `datasets/.temporary-view/` folder. These retained temporary-view caches persist after the UI closes and never create a sidecar or an `index.json` entry or trigger an index rebuild.
- ArcRho runtime requests are published as flat JSON `request-*.json` files under the configured requests directory. Temporary `.tmp` files are atomically renamed to `.json`, and data-engine workers process JSON requests only.
- Includes a cache-maintenance endpoint used by Project Settings reload to clear project-scoped `ArcRhoHeaders*.csv` files; Dataset `Clear Cache & Reload` can pass current Origin Length and Development Length so matching origin, development-column, and calendar-column header caches are cleared.
- Header requests validate that the project's `general_settings.json` contains a valid `origin_start_date` before reading or generating a cache. A header cache older than General Settings is deleted and regenerated, and a generation timeout returns an explicit retry/data-engine message instead of an empty label list.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Integrates headers/project listing plus triangle and vector execution endpoints. Vector requests use `/arcrho/vec*` and map `PeriodLength` to both origin and development length for the shared engine handler.
- Manages ArcRho request-result CSV caches under each project `data/<ReservingClassFolder>` folder; supports targeted ArcRhoHeaders cache clearing under the project `data` tree.
- ArcRhoTri writes generated `<DatasetName>@<OriginLength>@<DevelopmentLength>@<cum|inc>@<dev|cal>.csv` caches under `data/<ReservingClassFolder>/datasets`, while ArcRhoVec writes `<DatasetName>@<PeriodLength>.csv` vector caches. Both use a base `sidecars/<DatasetName>.json` metadata sidecar by default; the sidecar records `source_kind: "engine"` and the current Windows login user in `user` and `modified_by`. Triangle sidecars record origin/development lengths plus Cumulative/Calendar values; vector sidecars record `period_length`. Requests with `WriteSidecar: false` alone still materialize or reuse the canonical length-scoped CSV cache and return a registered `ds_id`/`data_path` without changing source sidecars or recalculating dependents. Temporary-view requests reuse a valid canonical cache read-only or place generated and derived CSVs in `data/<ReservingClassFolder>/datasets/.temporary-view/`; these retained caches persist after the UI closes and never create a sidecar or `index.json` entry or trigger an index rebuild.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Add new ArcRho operation: keep precheck/execute contracts explicit.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Long-running computations need robust error messaging.
<!-- MANUAL:END -->

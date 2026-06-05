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
| `POST` | `/arcrho/tri/precheck` | `arcrho_tri_precheck` | `ArcRhoTriRequest` | [`app_server/schemas/arcrho.py`](../../../app_server/schemas/arcrho.py) | `arcrho_runtime_service.arcrho_tri_cache_matches` |
| `POST` | `/arcrho/tri/refresh` | `arcrho_tri_refresh` | `ArcRhoTriRequest` | [`app_server/schemas/arcrho.py`](../../../app_server/schemas/arcrho.py) | `arcrho_runtime_service.run_arcrho_tri` |
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
- ArcRho runtime requests are published as flat JSON `request-*.json` files under the configured requests directory. Temporary `.tmp` files are atomically renamed to `.json`, and data-engine workers process JSON requests only.
- Includes a cache-maintenance endpoint used by Project Settings reload to clear project-scoped generated `ArcRhoHeaders*.csv` files; Dataset `Clear Cache & Reload` can pass current Origin Length and Development Length so matching origin, development-column, and calendar-column header caches are cleared.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Integrates headers/project listing and tri execution endpoints.
- Manages ArcRho request-result CSV caches under each project `data/generated` folder; supports targeted ArcRhoHeaders cache clearing without touching `data/manual`.
- ArcRhoTri writes generated `<DatasetName>@<OriginLength>@<DevelopmentLength>@<cum|inc>@<dev|cal>.csv` caches plus a base `<DatasetName>.json` metadata sidecar under `data/generated/<ReservingClassFolder>`; the sidecar records the current Windows login user in `user` and `modified_by` and stores the latest generated Cumulative/Calendar values.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Add new ArcRho operation: keep precheck/execute contracts explicit.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Long-running computations need robust error messaging.
<!-- MANUAL:END -->

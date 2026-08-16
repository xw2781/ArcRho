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
| `POST` | `/arcrho/tri` | `arcrho_tri` | `ArcRhoTriRequest` | [`app_server/schemas/arcrho.py`](../../../app_server/schemas/arcrho.py) | - |
| `POST` | `/arcrho/tri/precheck` | `arcrho_tri_precheck` | `ArcRhoTriRequest` | [`app_server/schemas/arcrho.py`](../../../app_server/schemas/arcrho.py) | - |
| `POST` | `/arcrho/tri/refresh` | `arcrho_tri_refresh` | `ArcRhoTriRequest` | [`app_server/schemas/arcrho.py`](../../../app_server/schemas/arcrho.py) | - |
| `POST` | `/arcrho/vec` | `arcrho_vec` | `ArcRhoVecRequest` | [`app_server/schemas/arcrho.py`](../../../app_server/schemas/arcrho.py) | - |
| `POST` | `/arcrho/vec/precheck` | `arcrho_vec_precheck` | `ArcRhoVecRequest` | [`app_server/schemas/arcrho.py`](../../../app_server/schemas/arcrho.py) | - |
| `POST` | `/arcrho/vec/refresh` | `arcrho_vec_refresh` | `ArcRhoVecRequest` | [`app_server/schemas/arcrho.py`](../../../app_server/schemas/arcrho.py) | - |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.arcrho.key_files -->
- [`app_server/api/arcrho_router.py`](../../../app_server/api/arcrho_router.py) - ArcRho tri/precheck/header endpoints.
- [`app_server/services/arcrho_runtime_service.py`](../../../app_server/services/arcrho_runtime_service.py) - ArcRho processing and project listing.
- [`app_server/services/engine_calculation_service.py`](../../../app_server/services/engine_calculation_service.py) - Engine request publish-and-wait exchange and its Gateway transport.
- [`app_server/schemas/arcrho.py`](../../../app_server/schemas/arcrho.py) - ArcRho request schemas.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Called by dataset/workflow actions requiring ArcRho processing.
- Result Selection can request engine-generated source triangles or vectors at a selected origin length without updating the source sidecar by passing `WriteSidecar: false`.
- Project Instance Temporary view reuses a valid canonical cache read-only when possible; otherwise it writes generated or derived CSV output to the selected reserving-class `datasets/.temporary-view/` folder. These retained temporary-view caches persist after the UI closes and never create a sidecar or an `index.json` entry or trigger an index rebuild.
- ArcRho runtime requests are published as flat JSON `request-*.json` files under the configured requests directory. Temporary `.tmp` files are atomically renamed to `.json`, and data-engine workers process JSON requests only. The `/arcrho/tri*` and `/arcrho/vec*` routes are the `dataset_run` / `dataset_precheck` Server-hosted engine-calculation operations: when the output CSV is on a network drive and the Gateway advertises them, the whole `run_arcrho_tri` / `arcrho_precheck` route — cache validation, the Engine exchange, the sidecar write, the dependent enqueue, and the index refresh — runs on the server host over `POST /api/engine-calculations`, the response is returned verbatim with rebased paths, and the dataset handle is registered locally; otherwise the same service function runs here. Every remaining request site goes through `engine_calculation_service.run_engine_calculation`, which hosts only the publish-and-wait exchange under the same rules and then waits for the finished CSV to become visible on this drive. See [`engine_calculations`](engine_calculations.md).
- The ResQ reserving-class migration uses this same shared request-folder contract for generated datasets. It requires a fresh `runtime/instances/arcrho_engine` heartbeat before connecting to ResQ, publishes generated requests as a batch for the existing worker pool, and never starts or imports a private backend engine. Its optional `RequestId`/`StatusPath` fields let status-aware workers report `processing`, `success`, or `error` atomically; legacy workers remain CSV-compatible, while status-aware failures are never finalized as canonical datasets.
- When waiting for a request-result file, the app server uses file-event watching for local drives and direct polling for UNC or mapped Windows network drives. This avoids SMB file-notification stalls while preserving the configured request timeout. Network polling starts fast and backs off to a capped interval, and each network poll first writes and removes a uniquely named probe file in the result directory so the Windows SMB redirector's cached "file not found" answer (`FileNotFoundCacheLifetime`) cannot hide a result the engine has already written; a probe write failure silently falls back to plain polling.
- `config.ENGINE_REQUEST_TIMEOUT_SEC` is the single owner of the engine file-exchange wait budget. The `/arcrho/tri*`, `/arcrho/vec*`, and `/arcrho/headers` schema defaults and server-side header/dependency waits read it, and frontend callers do not send their own `timeout_sec` override.
- Includes a cache-maintenance endpoint used by Project Settings reload to clear project-scoped `ArcRhoHeaders*.csv` files; Dataset `Clear Cache & Reload` can pass current Origin Length and Development Length so matching origin, development-column, and calendar-column header caches are cleared.
- Header requests validate that the project's `general_settings.json` contains a valid `origin_start_date` before reading or generating a cache. A header cache older than General Settings is deleted and regenerated, and a generation timeout returns an explicit retry/data-engine message instead of an empty label list.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Integrates headers/project listing plus triangle and vector execution endpoints. Vector requests use `/arcrho/vec*` and map `PeriodLength` to both origin and development length for the shared engine handler.
- Manages ArcRho request-result CSV caches under each project `data/<ReservingClassFolder>` folder; supports targeted ArcRhoHeaders cache clearing under the project `data` tree.
- ArcRhoTri writes generated `<DatasetName>@<OriginLength>@<DevelopmentLength>@<cum|inc>@<dev|cal>.csv` caches under `data/<ReservingClassFolder>/datasets`, while ArcRhoVec writes `<DatasetName>@<PeriodLength>.csv` vector caches. Both use a base `sidecars/<DatasetName>.json` metadata sidecar by default; the sidecar records `source_kind: "engine"`, current processing provenance per CSV filename, and the saving account's configured full name in `user` and `modified_by`. Engine cache variants without the current configuration hash are rejected, including variants created before the provenance contract; regenerating one period/mode variant does not validate stale sibling variants. `source_kind: "input"` and ResQ-import snapshots remain reusable without that hash. Triangle sidecars record origin/development lengths plus Cumulative/Calendar values; vector sidecars record `period_length`. Requests with `WriteSidecar: false` still materialize or reuse the canonical length-scoped CSV cache and return a registered `ds_id`/`data_path` without changing source sidecars. When one of those background requests writes or derives a cache, it atomically records the per-CSV processing provenance and a size, modification-time, and SHA-256 content fingerprint in the reserving-class technical cache directory, so later background loads can reuse only that exact file while the processing configuration remains current. Cache validation reads the current processing configuration once per request; an indeterminate network read returns a retryable error and leaves the existing CSV untouched. The `/precheck` routes are advisory: they validate identity, processing configuration, and stored size/modification time without rereading full CSV contents. The following execute request remains authoritative, performs SHA-256 validation before reuse, and therefore still rejects same-size content replacements whose modification time was restored. Such background reads do not rebuild `index.json` or eagerly recalculate unrelated dependents. App-calculated sidecars record each precedent's exact source path, format, and full content fingerprint. Exact-cache validation checks the current formula and direct-precedent graph, recursively validates calculated and engine inputs, and rejects same-stat content replacements; a stale requested chain is refreshed upstream-first without recalculating unrelated downstream outputs. Recalculation preserves the recorded dataset instance/format and exact DFM method identity instead of rescanning to a different matching source; when a project moves or its drive mapping changes, recorded DFM filenames are resolved only inside the current reserving-class method and dataset roots. Unreadable Dataset Type configuration returns an error and leaves existing calculated caches unchanged rather than treating the contract as empty. A request for an app-calculated Dataset Type still materializes its generated/app-calculated inputs with the same reserving-class and period settings before evaluating the requested output; genuinely unavailable inputs and dependency cycles remain explicit failures. Temporary-view requests reuse a valid canonical cache read-only or place generated and derived CSVs in `data/<ReservingClassFolder>/datasets/.temporary-view/`; these retained caches persist after the UI closes, never create a sidecar or an `index.json` entry or a technical provenance record, and are removed when Data Processing Rules change so an old generated preview is not reused. Because dependent propagation is a single locked Engine-hosted job (business-logic contract rule 15), app-calculated cache validation takes a trusted fast path before the per-precedent walk: when the opened object's own sidecar status is current and the reserving class's persisted `index.json` is valid with a `folder_signature` matching a fresh three-listing scan, the cache is accepted without validating its ancestry (the formula/precedent-name drift check against the current Dataset Type contract still runs first, since config drift does not move the folder signature). A review-needed status, a moved signature, a missing or invalid index, or any read error falls back to the previous deep per-precedent fingerprint validation.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Add new ArcRho operation: keep precheck/execute contracts explicit.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Long-running computations need robust error messaging.
<!-- MANUAL:END -->

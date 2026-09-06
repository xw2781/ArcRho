# App Server Domain: Bornhuetter Ferguson

## Purpose
<!-- MANUAL:BEGIN -->
Own the self-contained BF v3 contract, aggregate two-file load, revision-aware transactional save, and eager refresh after managed precedent updates.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.bornhuetter_ferguson.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/bornhuetter-ferguson/load` | `load_bornhuetter_ferguson` | `BornhuetterFergusonIdentityRequest` | [`app_server/schemas/bornhuetter_ferguson.py`](../../../app_server/schemas/bornhuetter_ferguson.py) | `bornhuetter_ferguson_service.load_bornhuetter_ferguson_method`, `workspace_read_client.run_workspace_read` |
| `POST` | `/bornhuetter-ferguson/refresh` | `refresh_bornhuetter_ferguson` | `BornhuetterFergusonIdentityRequest` | [`app_server/schemas/bornhuetter_ferguson.py`](../../../app_server/schemas/bornhuetter_ferguson.py) | `bornhuetter_ferguson_service.refresh_bornhuetter_ferguson_method` |
| `POST` | `/bornhuetter-ferguson/save` | `save_bornhuetter_ferguson` | `BornhuetterFergusonSaveRequest` | [`app_server/schemas/bornhuetter_ferguson.py`](../../../app_server/schemas/bornhuetter_ferguson.py) | `engine_hosted_save_service.run_hosted_save` |
| `POST` | `/bornhuetter-ferguson/save/plan` | `plan_bornhuetter_ferguson_save` | `BornhuetterFergusonSaveRequest` | [`app_server/schemas/bornhuetter_ferguson.py`](../../../app_server/schemas/bornhuetter_ferguson.py) | `engine_hosted_save_service.run_hosted_save_plan` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.bornhuetter_ferguson.key_files -->
- [`app_server/api/bornhuetter_ferguson_router.py`](../../../app_server/api/bornhuetter_ferguson_router.py) - Aggregate BF load/save/refresh routes.
- [`app_server/services/bornhuetter_ferguson_service.py`](../../../app_server/services/bornhuetter_ferguson_service.py) - V3 contract persistence, transactional publication, and eager dependency refresh.
- [`app_server/schemas/bornhuetter_ferguson.py`](../../../app_server/schemas/bornhuetter_ferguson.py) - BF identity and revision-aware save request models.
- [`ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_main.js`](../../../ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_main.js) - BF page state and aggregate persistence flow.
- [`ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_json_contract.js`](../../../ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_json_contract.js) - Canonical browser-side v3 payload builder.
- [`ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_method_api.js`](../../../ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_method_api.js) - Aggregate BF transport adapter.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- A valid v3 load performs exactly two bounded parallel JSON reads: `methods/BF@<Name>.json` and `sidecars/<Name>.json`. Pair checks use those payloads only; the route does not enumerate folders or read `index.json`, Dataset Types, project headers, source JSON/CSV files, or graph neighbors.
- Earlier BF formats are rejected without reading their registered Latest, DFM, or Prior sources; re-importing from ResQ is the supported path to a canonical v3 publication.
- Save compares BF-owned and BF-derived revisions separately. Submitted row weights and display settings can rebase over a concurrent automatic source refresh, while a conflicting owned edit is rejected. Every explicit Save acknowledges the BF output as Current and starts downstream propagation even when the publication values are unchanged. Save trusts the self-contained source snapshots already embedded in a valid v3 method instead of reopening precedents to validate duplicate label metadata. Readable review-needed precedents are returned through `unreviewed_precedents` and `unreviewed_precedent_count` without blocking the save.
- Publication serializes within the reserving class, stages changed method/CSV/sidecar files, rolls replacements and reverse dependency edges back on failure, and writes the sidecar last. A committed BF save is not rolled back when a later downstream cascade or index rebuild reports a warning.
- Managed source saves follow registered reverse edges and refresh only affected BF source snapshots. Refreshed BF outputs are fed back through calculated, DFM, Result Selection, and further BF traversal. After the refresh wave, reachable method-backed outputs remain Review Needed until their own explicit Save; Refresh alone does not clear the alert. Failed branches retain their last valid publication and block only their descendants, with refresh failure reported separately from status.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- `POST /bornhuetter-ferguson/load` is the `bornhuetter_ferguson_load` Server-hosted workspace read: when the Gateway advertises it, the method JSON and sidecar are read on the server host and returned verbatim; otherwise the service runs locally. See [`workspace_reads`](workspace_reads.md).
- The only supported marker is `arcrho-bornhuetter-ferguson-method-by-tab-v3`.
- A precedent is read at its stored period, not its displayed one, and a precedent stored finer than the method's `origin_length` is brought to it through `precedent_cache_service.precedent_source`: an Engine-generated prior vector is rebuilt at the method's period, a hand-entered one is rolled up in memory from its own CSV, and only a coarser precedent is refused with `422 … uses N-month origins; expected M`.
- Method JSON owns source names and values, prior weights, origin labels, Percentage Developed, Selected Prior, New Ultimate, weight display options, formatting precision, timestamps, and deterministic owned/derived/publication revisions.
- The output sidecar owns Notes, Audit Log, status, `Precedents`, and `Dependents`. An automatic refresh that rewrites the method stamps the sidecar's `updated_at`/`modified_by` and appends an `Auto Refresh` audit record even when the published output is unchanged; output CSVs are rewritten only when the publication changes. The reserving-class `index.json` remains a minimal scalar inventory and does not copy BF arrays or graph details.
- Source reads during refresh are bounded and request-cached. Current opens and ordinary Saves never validate embedded values against source files. A Review Needed BF returns to Current through explicit Save using its last durably refreshed snapshots; any readable method-backed precedents that still need their own review are reported as a non-blocking warning.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Direct out-of-band source edits do not publish a dependency event; use a managed ArcRho save or explicit repair.
- Source refresh maps CSV rows onto the BF method's persisted origin axis and does not depend on duplicate precedent-sidecar label arrays. A row-count or period-geometry change that cannot fit that axis retains the prior BF publication and leaves the branch Review Needed.
- A failed dependent branch does not roll back the already-committed upstream dataset or method save.
<!-- MANUAL:END -->

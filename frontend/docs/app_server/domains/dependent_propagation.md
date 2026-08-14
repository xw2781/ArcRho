# App Server Domain: dependent_propagation

## Purpose
<!-- MANUAL:BEGIN -->
Engine-hosted dependent propagation job domain: saves write only the saved object, then enqueue one durable `ArcRhoRefreshDependents` job that ArcRho Engine executes on the server host.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.dependent_propagation.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/dependent_propagation/refresh_dependents` | `submit_refresh_dependents_job` | `RefreshDependentsJobRequest` | [`app_server/schemas/dependent_propagation.py`](../../../app_server/schemas/dependent_propagation.py) | `dependent_propagation_service.submit_dependent_propagation_job` |
| `GET` | `/dependent_propagation/refresh_dependents/status/{request_id}` | `get_refresh_dependents_job_status` | `str` | - | `dependent_propagation_service.get_dependent_propagation_status` |
| `GET` | `/dependent_propagation/reserving_class_busy` | `get_reserving_class_busy` | `str` | - | `dependent_propagation_service.get_reserving_class_busy` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.dependent_propagation.key_files -->
- [`app_server/api/dependent_propagation_router.py`](../../../app_server/api/dependent_propagation_router.py) - Submit/status routes for Engine propagation jobs.
- [`app_server/services/dependent_propagation_service.py`](../../../app_server/services/dependent_propagation_service.py) - Job submission, heartbeat preflight, status validation.
- [`app_server/schemas/dependent_propagation.py`](../../../app_server/schemas/dependent_propagation.py) - Typed propagation job submit/status models.
- [`ui/shared/services/dependent_propagation_job.js`](../../../ui/shared/services/dependent_propagation_job.js) - Shared UI poller for propagation job progress.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Canonical contract module `python-api/src/arcrho_dependent_propagation_contract.py` owns the request/status schemas, `requests/dependent_propagation/` folder layout, reserving-class lease (5 s heartbeat, 300 s stale takeover), the status-heartbeat/staleness parameters (5 s republish, 45 s processing stale, 180 s queued stale), the live-Engine heartbeat preflight (fresh `runtime/instances/arcrho_engine/*.json` mtime within 60 s), and the `find_reserving_class_propagation_hold` write-hold probe (one lock-file stat plus a scan of the normally empty queued-requests folder).
- Engine worker `data-engine/src/arcrho_engine/dependent_propagation.py` claims the reserving-class lease, drains and merges queued requests for the same class (`merged_into` statuses), runs the canonical `calculated_dataset_service.recalculate_dependents` walk with per-tier progress, republishes the current `processing` status (primary and merged ids) every 5 s so remote pollers can tell a live slow walk from a dead worker, and retains the request file until a validated terminal status exists.
- Every save flow (DFM, Result Selection, Bornhuetter Ferguson, Cape Cod, Bootstrap, dataset sidecar/grid saves, runtime cache writes, dataset-type formula changes) preflights `require_reserving_class_writable(project, reserving_class)` before writing anything: no live Engine refuses the save with 503, and an active hold on the class (fresh lease heartbeat or a young queued request without terminal status) refuses it with 423 so one user's walk cannot race another user's edits in the same class. Unsaved work stays in the editor either way. The Excel workbook retarget preflights once and wraps its nested per-file saves in `suspended_reserving_class_hold_check()` so its own first enqueue does not refuse the rest; the coalescing merge remains the backstop for saves the non-atomic gate lets through together.
- Saves are Engine-hosted (`engine_hosted_save_service` client-side, `arcrho_engine/save_jobs.py` engine-side, contract `arcrho_engine_save_contract`): the endpoint publishes `queued`, drops the request in the requests root (instant watchdog pickup), and polls to a terminal status; the Engine claims by delete, holds the reserving-class lease, runs the canonical service save with the walk inline, and returns the full response through a result file. `trackSavePropagation` resolves a `status: "completed"` payload immediately (no polling); the saving window then shows a ~2 s auto-dismissing notice listing `propagation.refreshed_datasets` before the explicit Save command closes it. Only refresh/patch flows still enqueue `ArcRhoRefreshDependents` jobs and poll them. Project Instance polls `GET /dependent_propagation/reserving_class_busy` (~5 s) to quietly pause class-mutating actions while the class is held; there is no banner above the dataset table.
- Server-host in-process producers (ResQ migration, public Python API) keep walking in-process but hold the same reserving-class lease.
- Because the job is the sole propagation writer, the dataset open fast path trusts sidecar status + index folder signature (see the arcrho domain), and open windows watch their object for job or other-user rewrites through the object_change_watch domain's stat-only fingerprint endpoint.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Transient runtime files under `<server-root>/requests/dependent_propagation/{requests,statuses,locks}`; statuses follow the project-duplication retention policy (retained, no automatic pruning).
- Save responses carry `propagation: {job_id, status: "queued"}`, or `{status: "unchanged"}` for no-op saves whose publication revision did not change.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Change the job contract: update the canonical contract module first, then the Engine worker, app-server service, UI poller, and tests together.
2. Add a propagation-triggering save flow: preflight the Engine, mark the first reachable method tier review-needed (`refresh_method_statuses_for_dependents(..., direct_only=True)` — the Engine job re-marks the full closure on claim), then `enqueue_save_propagation`; never run the walk or the deep closure marking inline on a client.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Failed jobs are not auto-retried: downstream methods stay Review Needed until the next save or manual refresh re-enqueues a walk.
- A failed job raises no warning status line in the UI (owner decision, 2026-08-07): the dataset table's review-needed flags are the failure surface. `trackSavePropagation` fires `onComplete` at any terminal outcome (`result` null on failure) so the table refresh always runs after the walk finalized downstream statuses. The save popup treats the null resolution as "not clean" and leaves the window open instead of closing it.
- A plain filesystem cannot atomically fence the stale-lease takeover race; the generous thresholds make it acceptable (same residual gap as project duplication). The same non-atomicity applies to the reserving-class write hold: two saves may pass the preflight together, and the Engine's claim-time merge keeps that safe.
- The write hold is freshness-bounded on purpose: a dead worker's lease stops being renewed and the hold clears after 45 s; an abandoned queued request stops holding after 180 s. Clients never delete locks — only the Engine's stale takeover reclaims them.
- The UI poller treats a `processing` status whose signature stops moving for 45 s (or a `queued` one for 180 s) as stalled; the popup closes with the window left open.
<!-- MANUAL:END -->

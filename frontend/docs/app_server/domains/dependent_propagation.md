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
- Canonical contract module `python-api/src/arcrho_dependent_propagation_contract.py` owns the request/status schemas, `requests/dependent_propagation/` folder layout, reserving-class lease (5 s heartbeat, 300 s stale takeover), and the live-Engine heartbeat preflight (fresh `runtime/instances/arcrho_engine/*.json` mtime within 60 s).
- Engine worker `data-engine/src/arcrho_engine/dependent_propagation.py` claims the reserving-class lease, drains and merges queued requests for the same class (`merged_into` statuses), runs the canonical `calculated_dataset_service.recalculate_dependents` walk with per-tier progress, and retains the request file until a validated terminal status exists.
- Every save flow (DFM, Result Selection, Bornhuetter Ferguson, Cape Cod, Bootstrap, dataset sidecar/grid saves, runtime cache writes, dataset-type formula changes) preflights `require_engine_available()` before writing anything; no live Engine blocks the save with a message box and unsaved work stays in the editor.
- Server-host in-process producers (ResQ migration, public Python API) keep walking in-process but hold the same reserving-class lease.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Transient runtime files under `<server-root>/requests/dependent_propagation/{requests,statuses,locks}`; statuses follow the project-duplication retention policy (retained, no automatic pruning).
- Save responses carry `propagation: {job_id, status: "queued"}`, or `{status: "unchanged"}` for no-op saves whose publication revision did not change.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Change the job contract: update the canonical contract module first, then the Engine worker, app-server service, UI poller, and tests together.
2. Add a propagation-triggering save flow: preflight the Engine, mark reachable downstream review-needed, then `enqueue_save_propagation`; never run the walk inline on a client.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Failed jobs are not auto-retried: downstream methods stay Review Needed until the next save or manual refresh re-enqueues a walk.
- A plain filesystem cannot atomically fence the stale-lease takeover race; the generous thresholds make it acceptable (same residual gap as project duplication).
<!-- MANUAL:END -->

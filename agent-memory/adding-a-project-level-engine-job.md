---
name: adding-a-project-level-engine-job
description: "Recipe for moving a project-level Project Settings save (no reserving class) onto the Engine as a durable job with a progress window: clone the dataset-types-change pattern (contract + Engine worker + app_server job service + mutation/read kinds + JS poll loop), first done 2026-09-05 for the Data Processing Rules save"
metadata: 
  node_type: memory
  type: project
  originSessionId: 165eb20d-b84b-40d9-8227-5d441104e6ee
  modified: 2026-09-05T16:39:44.434Z
---

The hosted-save recipe in [[adding-a-hosted-save-kind]] needs a reserving-class path and a class
lease, so it does not fit a save that belongs to the whole project (Dataset Types, Data Processing
Rules). Those become **durable Engine jobs** modelled on `arcrho_dataset_types_change_contract`;
the Data Processing Rules save was moved this way on 2026-09-05 after a Client PC save measured
443 s because it opened all 2,152 sidecars over SMB (~0.2 s each) to count stale caches.

Pieces, all cloned from the dataset-types job:
1. `python-api/src/arcrho_<x>_job_contract.py` — Function name, request/status shapes,
   `requests/<x>/{requests,statuses}` paths, `find_queued_<x>` probe, `<X>_SERVICE_MODULES` (the
   Engine build probe imports it). The status may embed the save route's whole response as
   `result` plus a `status_code`, so the client needs no re-read and keeps its 409/400 handling.
2. `server-components/src/arcrho_engine/<x>_jobs.py` — `process_durable_<x>_request` under
   `acquire_project_scope_lease` (the lease is the cross-instance claim arbiter), a 5 s status
   heartbeat, `configure_canonical_runtime`, `acting_identity(UserName)` around the service call.
   Register in `arcrho_engine/main.py`: contract import, `_DurableJobDispatcher`, `process_file`
   branch, `shutdown`, and the `process_existing_requests` subfolder scan (subfolder queues are
   only picked up by that 5 s rescan, never by the watchdog). Add the contract to both
   `build_exe.py` hidden-import lists and the Engine's probe/contract-file checks.
3. `frontend/app_server/services/<x>_job_service.py` — `submit_*` (preflight with
   `dependent_propagation_service.require_project_scope_writable`, write queued status then
   request file, idempotent by request id) and `get_*_status`. Register the submit as a
   `WORKSPACE_MUTATION_KINDS` entry and the status as a `WORKSPACE_READ_KINDS` entry so both hops
   are Gateway HTTP from a Client PC; the router calls `run_workspace_mutation` / `run_workspace_read`
   with a `local=` fallback. **Mutation-kind gotcha:** the required-arg check is
   `str(value or "").strip()`, so an int 0 or an empty list reads as missing — list such args as
   optional and let the job contract validate them.
4. The service itself gains a `progress(stage, completed, total, label)` callback and stamps the
   user via `user_identity_service.get_windows_login_name()` (env `USERNAME` would name the
   Engine's service account).
5. JS: a `<x>_job.js` poll loop (750 ms, 45 s/180 s stale rules) and the feature drives the shell
   window with `arcrho:project-settings-progress` open/update/close messages through the
   coordinator's `publishShellProgress`; a 503 from the job route means no Engine, so fall back to
   the direct route. Bump the feature's `?v=` in `project_settings.js`.

Then deploy bridge + engine + gateway (see [[remote-component-deploy]]); the dev app server only
forwards the job, so nothing is live until the Engine and Gateway carry the new contract.

Pre-existing on this Client PC: `frontend/tests/test_dataset_types_change_jobs.py` has 4 errors at
HEAD ("dataset_types_change_plan requires: renames") because the live Gateway is enabled here, and
`project_settings_module_split.test.mjs` fails its version-pin test at HEAD. Related:
[[adding-a-hosted-workspace-read]], [[pi-path-load-smb-cost]].

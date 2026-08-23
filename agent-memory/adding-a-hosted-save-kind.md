---
name: adding-a-hosted-save-kind
description: "Recipe for moving a page's save onto the Engine: one SAVE_JOB_KINDS entry plus a save_propagation_roots function; everything else (Engine hidden imports, Gateway advertised kinds, plan resolver) derives from that table, then rebuild bridge+engine+gateway"
metadata: 
  node_type: memory
  type: project
  originSessionId: f1b5ac2c-bfc2-45e9-860b-c9f3d512455e
  modified: 2026-08-23T21:14:10.789Z
---

The save-side companion to [[adding-a-hosted-workspace-read]]. Moving a page's save off the share is
two edits plus a rebuild:

1. `python-api/src/arcrho_engine_save_contract.py` — add `"<kind>": ("<x>_service", "<save_fn>")` to
   `SAVE_JOB_KINDS`. Everything else derives from this one dict: `HTTP_SAVE_KINDS` (what the Gateway
   advertises), the Engine's and Gateway's `--hidden-import` lists, the build-time import probe, and
   `save_plan_service.resolve_save_roots`. There is no second table to update.
2. `frontend/app_server/services/<x>_service.py` — the save function, plus a
   `save_propagation_roots(*args, **kwargs)` with the **same signature**, returning
   `[(dataset_name, dataset_type)]`. `test_save_plan_service` fails without it.
3. `frontend/app_server/api/<x>_router.py` — replace the direct service call with
   `engine_hosted_save_service.run_hosted_save(kind, project, reserving_class, **projection)`, where
   the projection is `{"args": [...], "kwargs": {...}}` shared with the roots resolver.
4. `python data-engine/deploy.py` — an edit under `frontend/app_server/` or `python-api/src/` makes
   bridge, engine **and** gateway stale.

Notes that cost time to rediscover:
- **`args[2]` is the log label.** `engine_hosted_save_service._save_object_name` reads `args[2]` when
  it is a Mapping and takes `details_tab.name` / `dataset_name` / `method_name` from it. Pass the
  method payload third (as Cape Cod does) or hosted-save logs show a blank object name.
- **The Engine suspends the hold check and runs the walk inline.** `save_jobs.py` wraps the call in
  `suspended_reserving_class_hold_check()` + `inline_engine_propagation()`, so a
  `require_reserving_class_writable` inside the save is a no-op there (it still guards the
  client-side preflight) and the response comes back `status: "completed"` with no polling.
- **A save may compose another save.** Calling `dataset_service.save_dataset_sidecar` from inside
  another hosted save works: `reserving_class_io_lock` is a re-entrant per-thread RLock.
- **Verify without the UI:** `GET http://<server>:28767/api/capabilities` → `allowed_save_kinds`.
  Per-save timings land in `%LOCALAPPDATA%\ArcRho\logs\client_save_latency.jsonl`
  (`transport`, `total_ms`, `phase_ms`).

Measured 2026-08-23 adding `berquist_sherman_method` (which had been the last method type still
writing its files from the Client PC): the un-hosted route cost ~1.0 s just to read the two existing
files and decide they had changed, ~2.0 s with the writes; the hosted `dataset_sidecar` commits it
replaced ran 0.7–3.0 s end to end for strictly more work. Related: [[pi-path-load-smb-cost]],
[[remote-component-deploy]], [[build-listener-request-read-race]].

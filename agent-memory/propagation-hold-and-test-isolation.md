---
name: propagation-hold-and-test-isolation
description: "Reserving-class write hold (423) design constants, and the rule that any service test running a save must use tests/dependent_propagation_workspace_stub.py or it enqueues real jobs on E:\\ and 423s itself"
metadata:
  node_type: memory
  type: project
  originSessionId: 8f6adbfd-3d23-474b-97e5-2d75d83f3519
  modified: 2026-08-13T20:18:05.878Z
---

Since 2026-08-13, every propagation-triggering save preflights `require_reserving_class_writable(project, rc)` (503 no engine, 423 class held). Canonical probe: `find_reserving_class_propagation_hold` in `arcrho_dependent_propagation_contract.py`. Constants there: status heartbeat 5s (engine republishes `processing` for primary + merged ids), processing stale 45s, queued stale 180s; the JS poller (`dependent_propagation_job.js`) mirrors 45s/180s. Clients never delete locks — only engine stale takeover (300s) reclaims them.

Saves are Engine-hosted (owner decision 2026-08-13 evening, replacing the same-day live-update popup): the six save endpoints route through `engine_hosted_save_service.run_hosted_save` → `ArcRhoHostedSave` request in the requests ROOT (instant watchdog pickup; NOT the durable subfolder queue) → `arcrho_engine/save_jobs.py` claims by delete, holds the class lease, runs the canonical service save with `inline_engine_propagation()` + `suspended_reserving_class_hold_check()`, publishes result+status under `requests/save_jobs/`. The save response's `propagation` is `{status:"completed", ok, refreshed_datasets:[...]}`; `trackSavePropagation` resolves it instantly; windows show a ~2 s `showSavedDependentsNotice` toast then close. The grid PATCH endpoint stays client-side (depends on in-process `config.DATASETS`), as do refresh flows (still enqueue durable jobs). Only the enqueue path marks the first method tier (`direct_only=True`); the durable Engine job re-marks the full closure on claim. PI has NO busy banner — the busy poll only pauses class-mutating actions quietly. Frontend service test suites that import `dependent_propagation_workspace_stub` by bare name must run as direct scripts (`python tests/test_x.py`), not as `-m unittest tests.test_x`. `data_tab_persistence_controller.js` over-1,000-lines and the DFM `dfm_method_api.js` multi-stamp check fail `frontend_controller_modularity.test.mjs` at HEAD already (pre-existing).

**Why:** one user's dependent walk must not race another user's edits in the same reserving class; freshness windows guarantee a dead worker releases the hold by itself.

**How to apply:**
- Any *frontend* unit test that calls a save function (`save_dfm_method`, `save_dataset_sidecar`, `save_*_method`, `retarget_reserving_class_workbook`, ...) must put `IsolatedPropagationWorkspace()` from `tests/dependent_propagation_workspace_stub.py` in its patchers (or setUp/tearDown). Without it the save writes real queue files onto `E:\ArcRho Server\requests\dependent_propagation\` and the next save in the suite reads them as a hold → flaky 423s that depend on live engine cleanup timing.
- A single request that runs several nested saves for one class must preflight once and wrap the nested saves in `dependent_propagation_service.suspended_reserving_class_hold_check()` (see the Excel retarget), or its own first enqueue 423s the rest.
- The save popup awaits `trackSavePropagation` (null result = not clean → window stays open); only the explicit Save command closes the window, via each page's `requestConfirmedClose`-style helper. See [[frontend-node-test-suite]] and [[bridge-restart-after-deploy]] for running tests and redeploying.

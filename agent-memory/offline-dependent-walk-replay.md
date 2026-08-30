---
name: offline-dependent-walk-replay
description: "Replaying a dependent walk offline WRITES TO THE LIVE CLASS unless the three per-project dir helpers are patched; mocking config.load_workspace_paths alone does not redirect project data (it did on 2026-08-30 and stamped the live NJ HOL class)"
metadata:
  node_type: memory
  type: feedback
  originSessionId: a6f90213-cbce-468a-b2ce-e215fcde55b6
  modified: 2026-08-30T15:37:45.652Z
---

Mocking `app_server.config.load_workspace_paths` at a scratch root does NOT redirect project
data: `get_project_dataset_cache_dir` / `get_project_method_data_dir` /
`get_project_dataset_sidecar_dir` resolve through the project map and still point at
`E:\ArcRho Server\projects\...`. On 2026-08-30 four "scratch" replays of
`calculated_dataset_service.recalculate_dependents` ran against the live NJ HOL class:
they appended audit rows by the Windows user `xwei`, moved `updated_at`/`modified_by` on
F 91, F 92 and Severity, and refreshed G 91 (method, CSV, sidecar). The walk is idempotent on
consistent state, so nothing looked wrong until `find "<class>" -newermt "<start>"` on the
live folder showed mtimes matching the replay times.

**Why:** the only earlier symptom was subtle — a perturbed scratch input produced exactly the
same walk output as the untouched one, because reads and writes were both hitting E:.

**How to apply:**
- Isolate the way `frontend/tests/test_result_selection_service.py` does: patch the three
  `config.get_project_*_dir` helpers at the scratch folders and use
  `tests/dependent_propagation_workspace_stub.py` for the hold/queue; then PROBE the resolved
  paths with a no-walk script before running anything that writes.
- Take a byte copy of the class folder first and keep it: audit rows and stamps are not
  otherwise recoverable. After a replay, run `find` with `-newermt` on the live folder.
- Restoring live files is a live-data overwrite the harness blocks; hand the user the
  pristine/current pairs and the copy command instead.
- A post-save copy is already consistent, so it cannot reproduce a stale-state walk failure
  on its own. Prefer reading the Gateway receipt:
  `E:\ArcRho Server\runtime\arcrho_gateway\receipts\<request id>.json` holds the whole save
  response, and since 2026-08-30 the "Downstream refresh failed after <method> publication"
  reason carries the nested walk reasons (see [[result-selection-unchanged-dependent-block]]).
- Scratchpad paths overflow MAX_PATH for dataset CSVs; use a short root such as
  `C:\Users\XWEI~1.PRC\AppData\Local\Temp\2\rw`. Related: [[dfm-offline-recompute-repro]],
  [[propagation-hold-and-test-isolation]].

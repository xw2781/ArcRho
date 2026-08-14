---
name: dfm-offline-recompute-repro
description: "Reproduce DFM propagation refresh decisions offline by importing arcrho_api.dfm_contract directly against live method JSON — read-only, no service stubs needed"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4d63ae91-5618-44a2-8e6d-8997a14c6104
  modified: 2026-08-14T21:58:27.692Z
---

To diagnose why an Engine propagation walk did or did not update a DFM method, skip the app_server services entirely: add `python-api/src` to `sys.path`, load the live method JSON from `E:\ArcRho Server\projects\...`, then call `normalize_dfm_method(payload, require_complete=True)` and `recalculate_dfm_method(...)` with hand-built `dataset_reference_values` (token `match` text → float read from the referenced dataset CSV). This mirrors `dfm_service._refresh_one` without locks, writes, or job enqueues (see [[propagation-hold-and-test-isolation]]). Monkeypatching `_safe_arithmetic` / `_evaluate_internal_formula` with print-spies pinpoints exactly where an evaluation silently falls back to the stored value — the contract keeps stored values on any evaluation failure by design, so the walk reports "success" and the only surface is a Review Needed flag.

Found and fixed this way (2026-08-14): `_evaluate_internal_formula` strips a leading `=` with `text[1:]`, leaving a leading space; `ast.parse(..., mode="eval")` raises IndentationError on leading whitespace, so every UI-authored user-entry formula stored as `= expr` (space after `=`) silently failed server-side re-evaluation. Fixed by stripping in `_safe_arithmetic` (`python-api/src/arcrho_api/dfm_contract.py`); regression test `test_formulas_with_whitespace_after_equals_still_re_evaluate` in `python-api/tests/test_dfm_contract.py`.

Related design fact: after a successful walk, `_recalculate_dependents_impl`'s finalize step re-marks the whole reachable method closure Review Needed on purpose (`refresh_method_statuses_for_dependents` marks unconditionally, it does not compute staleness) — a status-2 badge on a method after propagation means "review the auto-recomputed values", not that the refresh failed.

Useful timestamps for correlation: `E:\ArcRho Server\runtime\logs\hosted_saves.log` (per-save claim/success lines) and `requests/dependent_propagation/statuses/*.json` (job terminal status; folder is huge — filter by mtime with os.scandir, don't `ls -t` it over SMB).

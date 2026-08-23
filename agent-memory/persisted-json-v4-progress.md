---
name: persisted-json-v4-progress
description: "Where the persisted JSON contract v4 work stands (steps 1-3 committed, step 4 applied and green but uncommitted) and how to finish it"
metadata:
  node_type: memory
  type: project
  originSessionId: 54e67477-d0c1-4c16-a51e-f1b17a4e537e
  modified: 2026-08-23T01:23:54.864Z
---

Persisted JSON contract v4 (`docs/plans/persisted_json_contract_v4.md`) is implemented step by step, one commit per step. As of 2026-08-23: steps 1-3 are committed on `main` (c2ed598, 2de7263, cdcea68); **step 4 (rename / drop fields / delete legacy readers) is applied in the working tree, its test fallout is cleared, but it is NOT committed** — the plan's Step 4 checklist and "Handoff" section say exactly what is done and what is left.

**Why:** step 4 is one breaking commit touching ~190 files; the plan requires `/code-review ultra` (user-triggered) before the commit, and a deploy.py run from this clone would ship the uncommitted tree to the server (see [[remote-component-deploy]]).

**How to apply:**
- Left in step 4: run `tmp_data/json_contract_v4_samples/generate_samples.py` then `check_samples.py` (needs the server share — it was offline, `NE7SASWPN02` not answering, when they were last tried) and refresh that folder's README size table; then the user runs `/code-review ultra`; then commit step 4 as one commit. Publishing the bumped export macro (1.1.0) to the shared library is also blocked until the share returns (Step 7 republishes anyway).
- Two decisions taken in step 4 that later steps must respect: a timestamp with no zone is a wall-clock reading in the machine's own zone (ResQ's `Modified`), so the Step 6 converter must run on the Server PC; and a calculated cache's freshness evidence (formula + per-dependency path/fingerprint) lives in the per-CSV `.arcrho-cache-provenance/` record, not the sidecar, so every existing calculated cache recalculates once after conversion.
- `git stash` is the only way back to step 3 — do not do that casually.
- Test baselines (known failures, not ours): frontend Python 3 (`test_dataset_number_format_defaults`, `test_engine_dataset_sidecar_contract` username mismatch, `test_result_selection_cross_producer_contract`) — plus 7 "workspace root is unavailable" errors whenever the E: share is down (method-service saves that bypass the workspace stub); Node 9 (see [[frontend-node-test-suite]]); python-api 1 (`test_validate_engine_resq_parity`) plus 3 macro-import tests that fail only in a full-suite run.
- Related: [[python-test-runner]], [[propagation-hold-and-test-isolation]].

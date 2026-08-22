---
name: persisted-json-v4-progress
description: "Where the persisted JSON contract v4 work stands (steps 1-3 committed, step 4 mid-flight and uncommitted) and how to resume it"
metadata: 
  node_type: memory
  type: project
  originSessionId: 54e67477-d0c1-4c16-a51e-f1b17a4e537e
  modified: 2026-08-22T22:28:33.252Z
---

Persisted JSON contract v4 (`docs/plans/persisted_json_contract_v4.md`) is being implemented step by step, one commit per step. As of 2026-08-22: steps 1-3 are committed on `main` (c2ed598 fingerprints, 2de7263 one writer per file, cdcea68 audit policy + sidecar core); **step 4 (rename / drop fields / delete legacy readers) is applied in the working tree but NOT committed** — the plan's "Handoff" section lists exactly what is done and the test fallout still to clear.

**Why:** step 4 is one breaking commit touching ~180 files; committing it half-green would leave `main` unable to open any workspace, and a deploy.py run from this clone would ship the uncommitted tree to the server (see [[remote-component-deploy]]).

**How to apply:**
- Read the plan's Handoff section first; do not re-run the one-shot rename scripts (they lived in a session scratchpad and are gone) — the renames are already in the tree.
- `git diff --stat` shows the step-4 tree; `git stash` is the only way back to step 3 — do not do that casually.
- Test baselines before step 4 (known failures, not ours): frontend Python 3 (`test_dataset_number_format_defaults`, `test_engine_dataset_sidecar_contract` username mismatch, `test_result_selection_cross_producer_contract`) plus timing flakes (`test_class_folder_scan_cache`, gateway tests); Node 9 (see [[frontend-node-test-suite]]); python-api 1 (`test_validate_engine_resq_parity`) plus 3 macro-import tests that fail only when suites run concurrently.
- Related: [[python-test-runner]], [[propagation-hold-and-test-isolation]].

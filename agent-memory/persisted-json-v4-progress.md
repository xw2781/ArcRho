---
name: persisted-json-v4-progress
description: "Where the persisted JSON contract v4 work stands (steps 1-5 committed; step 6 writes the conversion script) and the facts the converter must respect"
metadata:
  node_type: memory
  type: project
  originSessionId: 54e67477-d0c1-4c16-a51e-f1b17a4e537e
  modified: 2026-08-23T04:43:50.933Z
---

Persisted JSON contract v4 (`docs/plans/persisted_json_contract_v4.md`) is implemented step by step, one commit per step. As of 2026-08-23: **steps 1-5 are committed on `main`** — c2ed598, 2de7263, cdcea68 (1-3), `d432ae8` (step 4: rename / drop fields / delete legacy readers), `fcbfaeb` (step 5: docs, release fragment, upgrade tests), `55e3375` (plan). Next is step 6, the conversion script `tools/migrate_persisted_json_v4.py`.

`/code-review ultra` on steps 4-5 was **deferred, not done** — it is user-triggered, so the user chose to commit first and let findings become a follow-up commit. Offer it before step 6 starts.

**Facts step 6 must respect** (all measured on `NJ_Annual_Prod_202605_Fake`, 2026-08-23; the plan's Step 4 checklist has the detail):

- **Convert methods before sidecars, per reserving class.** A sidecar's `publication_revision` must be taken from the converted method via `upgrade_dataset_sidecar(..., publication_revision=...)`. Shortening the stored value is not enough: step 1 made the hash vocabulary spelling-independent, so a v4 method computes a *different* number, and a sidecar left holding the old one reports every method as saved but never republished. Pair by the method's `details_tab.output_dataset` against the sidecar's `dataset_name`, case-insensitively.
- **Four BF method files cannot be converted and must not stop the run.** They are stamped `arcrho-bornhuetter-ferguson-method-by-tab-v2`, which the app stopped opening when BF v3 landed in `ea69b4c`, and three of them hold the only copy of real actuarial commentary. `upgrade_method` raises `UnsupportedMethodFormatError` for the stamps in `UNCONVERTIBLE_METHOD_FORMATS` (BF v2, DFM v1): rescue the text with `stranded_method_notes`, put it in the output sidecar with `sidecar_with_method_notes`, leave the method file alone, and name it in the report. Any other unknown stamp is a stop, not a skip.
- A timestamp with no zone is a wall-clock reading in the writing machine's own zone (ResQ's `Modified`), so **run the converter on the Server PC**.
- A calculated cache's freshness evidence lives in the per-CSV `.arcrho-cache-provenance/` record, not the sidecar, so every existing calculated cache recalculates once after conversion.

**Already proved, so step 6 does not have to re-derive it:** 554 of 554 convertible methods convert and are fixed points (write with `persisted_json_text`, read back, normalize again, byte-identical), and 2,079 of 2,079 sidecars convert and pass `validate_sidecar_core`. The sweep scripts are worth re-creating; walking the share takes ~25 minutes per pass.

Test baselines (known failures, not ours): python-api 4 (`test_validate_engine_resq_parity` plus 3 macro-import tests that fail only in a full-suite run); Node 9 of 913 (see [[frontend-node-test-suite]]); frontend Python 3 of 802 (`test_dataset_number_format_defaults`, `test_engine_dataset_sidecar_contract` username mismatch, `test_result_selection_cross_producer_contract`) plus 7 "workspace root is unavailable" errors whenever the E: share is down; data-engine 434 clean, with `test_project_duplication` and the gateway tests flaking under concurrency. Also flaky: `test_release_workflow.test_version_metadata_snapshot_restores_byte_exact_files` errors with WinError 5 in a full-suite run and passes alone.

Related: [[python-test-runner]], [[propagation-hold-and-test-isolation]], [[remote-component-deploy]], [[shared-macro-library-deploy]].

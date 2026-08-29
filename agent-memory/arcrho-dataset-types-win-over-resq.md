---
name: arcrho-dataset-types-win-over-resq
description: "When ArcRho's dataset_types.json and ResQ disagree on whether a dataset type is calculated, ArcRho's library wins; ResQ's Calculated flag/Formula never decides a sidecar's source_kind"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ad37e3d5-0f03-4637-a4c1-e271df1e05b2
  modified: 2026-08-29T23:48:12.713Z
---

User decision (2026-08-29): **when the two sources disagree on a dataset type, always use ArcRho's own dataset-types library, not ResQ's.** The `81 - Prior Qtr Indicated` / `82 - Prior Qtr Selected` vectors (and `F 31 - Claim Count * Severity`, `G 42 - Prior for BF Paid`, `P 06 ...`) are calculated in ResQ from a formula ArcRho does not have (`"D 91 - Current Qtr Indicated - Feb 2026"`, a prior-quarter lookup), but ArcRho's library lists them as plain inputs, so in ArcRho they are editable manual inputs, not generated datasets.

**Why:** the migration's vector writer used to stamp `source_kind: calculated` whenever ResQ reported a Formula, without copying the formula. The sidecar then had no precedents and nothing could regenerate it, and the Data tab refused every edit with "Generated datasets are read-only." — the dataset was frozen at its last ResQ import.

**How to apply:** `resq_migration.catalog._is_calculated_dataset_type` is the one rule (calculated + not generated + has formula in `dataset_types.json`); `write_vector_export` and `sync_session.collect_resq_inventory` both use it. ResQ's `Calculated` flag only blocks ArcRho-to-ResQ write-back (ResQ would recompute over the write). The 138 already-imported sidecars in `NJ_Annual_Prod_202605_Fake` were re-stamped to `input` on 2026-08-29 with their original `updated_at` kept (scratch script, backups in the session scratchpad). The Bridge runs a frozen copy of the migration folder, so until the change is committed and the Bridge redeployed (`deploy.py --ref <sha> bridge` — the shared tree held other sessions' work), a ResQ import through the Bridge re-stamps them as calculated again. Related: [[remote-component-deploy]], [[resq-com-probe]].

---
name: excel-rebuild-of-method-results
description: "2026-09-14 — the add-in's Calculate Workbook (force_refresh) sent a Result Selection output to the Engine, which wrote its \"data processing configuration error\" text over the RS output CSV; only engine/calculated records are rebuildable now, every other source_kind is served as published"
metadata: 
  node_type: memory
  type: project
  originSessionId: 30262bed-91c4-428a-8a4c-4776dc5800b2
  modified: 2026-09-14T15:57:11.242Z
---

On 2026-09-14 an `=ArcRhoVec(...)` cell for `C 92 - Current Qtr Selected` (a Result Selection output in `PRNJ - PA\PA\All States\Direct Group\COL`, project NJ_Annual_Prod_202605_Fake) showed `(data processing configuration error: Dataset type [...] is not defined ...)` after Calculate Workbook, and `D 92` showed `does not resolve to any numeric source columns`. Ordinary recalculation had worked because it reads the stored CSV.

**Why:** `arcrho_runtime_service.run_arcrho_tri` only dropped `force_refresh` for `source_kind == "input"`. A method result (`result_selection`, `dfm`, `bornhuetter_ferguson`, ...) kept the flag, so the route deleted the RS output CSV (`datasets/<name>@12.csv`, the same file the sidecar's `csv_file` names) and asked the Engine, which cannot build a type with no source formula and writes its error message into the output path. The stored figures were gone until the RS method republished them. C 92's type is also spelled `C 92 -  Current Qtr Selected` (double space) in dataset_types.json while the add-in normalises to one space, hence "not defined" rather than "does not resolve".

**How to apply:** `_stored_source_kind` + `_is_read_only_source_kind` (only `engine` and `calculated` can be produced again) gate both the forced rebuild and the fall-through Engine request in `run_arcrho_tri` and `_run_temporary_arcrho_tri`; the Engine's `_get_dataset_info` matches types through `dataset_type_key` (see [[resq-double-space-type-names]]). Tests: `test_arcrho_router_hosted_operations.HostedDatasetCsvTests`, `test_engine_dataset_type_lookup`. A CSV under `datasets/` that starts with `(data processing configuration error` is a clobbered method output: republish it from the method page (save/refresh the RS), it is not recoverable from the Engine. Related: [[hosted-save-fix-needs-engine-deploy]] (Engine + Gateway must be redeployed for this to be live).

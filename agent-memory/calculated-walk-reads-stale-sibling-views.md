---
name: calculated-walk-reads-stale-sibling-views
description: "2026-09-21: the calculated-dataset walk reads an existing @<period> sibling file of an Engine precedent as-is (no provenance check), so after a source-table refresh F 63 = P 06 x stale Earned Premium@3 until someone opens the premium window; refresh regenerates a vector at 12 months"
metadata:
  type: project
---

Diagnosed 2026-09-21 in `NJ_Annual_Prod_2026 Q3-Aug` NY BI Total from logs, sidecars and
cache-provenance records only. F 63 (quarterly vector) was rewritten by every walk
but held stale values until the user re-ran the Earned Premium and Remaining Budget
Premium windows at 14:44 UTC.

- `calculated_dataset_service._candidate_csvs` gives +3 to any vector file named
  `@<target period>`, so `Earned Premium@3.csv` beats the sidecar-named `@12` copy,
  `_engine_cache_at_target_shape` then says "already at shape" and the file is read
  as it stands. Nothing validates it: the run path (`arcrho_runtime_service`) checks
  runtime provenance whose processing hash includes the source-table signature, the
  walk does not. The F 63 provenance record's `dependencies` list proves which files
  the walk read.
- The 2026-09-18 18:49 UTC PS refresh (`psrefresh_...` in source_table_refresh.log,
  import=True) regenerated only each vector's sidecar-named file; the `@3` views kept
  pre-import values. `_regeneration_request` in
  `server-components/src/arcrho_engine/source_table_refresh.py` reads
  `origin_length`, which a vector sidecar lacks, so a vector is regenerated at 12
  regardless of its `period_length`.
- Same class of problem for inputs: a target period of 6 picks `P 06 ...@6.csv` from
  the 2026-09-10 import over the sidecar-named `@3` copy.

**How to apply:** for an `engine` or `input` precedent the walk must take the
sidecar-named copy (`_is_stale_input_variant` is the runtime rule) and then
materialize (engine) or roll up (input); never trust an `@n` sibling. Related:
[[engine-stored-lengths-are-source-granularity]], [[vector-sibling-views-ambiguous-dependency]].

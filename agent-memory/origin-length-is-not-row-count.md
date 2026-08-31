---
name: origin-length-is-not-row-count
description: "origin_length/development_length/PeriodLength mean months per period (12 = annual), NEVER the number of rows/columns; row count comes from origin_count / len(origin_labels) / ResQ .OriginCount"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 79c5ab8a-ba76-4684-957e-389a2b88bfdf
  modified: 2026-08-31T17:59:11.033Z
---

`origin_length`, `development_length`, and ResQ's `PeriodLength` hold the number of **months in one origin/development period** — 12 for annual, 3 for quarterly. They are period *granularity*, not a cell count. Agents have repeatedly misused them as the row/column count of a vector or triangle (the user flagged this on 2026-08-31 as a recurring mistake).

**Why:** The names sound like lengths of an axis, and for a 12-row annual vector the two numbers can coincide, so the bug hides until a vector has a different row count. Concrete instance: the ResQ import translated instance formulas into in-cell links spanning `[1:12]` when the vector had only 10 rows — `write_vector_export` passed the period length into `_translated_instance_formula_links` (fixed 2026-08-31 in `python-api/migration/resq_migration/extractors.py` via `_vector_payload_row_count`).

**How to apply:** For actual cell counts always use `origin_count` / `development_count`, `len(origin_labels)` / `len(development_labels)`, or ResQ's `.OriginCount` on the COM object. The period granularity is only right for things that genuinely mean months-per-period: the `@N` suffix in dataset cache CSV names and the 3/6/12-month aggregation variants. When reviewing code that ranges over a vector, check which of the two the bound really is. Related: [[instance-formula-import-design]], [[resq-com-probe]].

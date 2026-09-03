---
name: growth-and-cutoff-adjustment-rules
description: "How the reserve review's growth and accounting cutoff adjustments map onto ArcRho DFM User Entry formulas, and where the authoritative factors live"
metadata: 
  node_type: memory
  type: project
  originSessionId: e19aba1f-83e7-4e89-b7de-2d5e11586c35
  modified: 2026-09-01T00:21:37.704Z
---

The quarterly reserve review adjusts the first few LDF columns of a DFM by a growth factor and an accounting cutoff. Established 2026-08-31 by reading the production ResQ project "NJ_Annual_Prod_2026 Q2-May" against the workbooks.

- **The factors come from [[reserve-review-inputs-workbook]].** Its per-segment sheets carry a **Factor block, columns G/H/I** (Incurred / Counts / Paid) that is **already the compounded ratio** `(1+raw[n])/(1+raw[n-1])` — never rebuild it as `1+raw`. `E:\ResQ\Automations\Reserve Review\ResQ Path.xlsx` lists the 12 reserving classes and says which are annual and which quarterly.
- **In ArcRho** those series live as four reserving-class vectors: `Accounting Cutoff`, `Growth Adjustment--Counts`, `Growth Adjustment--Incurred`, `Growth Adjustment--Paid` (double hyphen), one row per origin period, created by [[reserve-review-input-vectors-script]].
- **Development period n reads row `[-n]`** of those vectors, with no arithmetic. Since 2026-09-03 a negative vector index counts back from the project's Development End Date (or the last non-empty row when the data stops earlier), so `[-1]` lands on the valuation period even when the rows after it are filled — the Engine no longer blanks a vector's rows past that date, because budget/planned inputs live there. Before that date the boundary was the last non-empty cell alone. At most the first three columns ever carry an adjustment.
- **The basis comes from the method's input triangle**: `Claim Counts--*` → Counts, `*--Paid` / `*--Received` → Paid, `*--Incurred` → Incurred, `Severity--*` → Incurred ÷ Counts with no cutoff (both diagonals stop at the same accounting month), and anything `as % of` another basis takes no adjustment because the growth cancels.
- **Mixed period bases inside one reserving class are normal, not an oddity.** Every quarterly class holds more annual instances than quarterly ones (NY BI Total: 71 annual / 37 quarterly of 108; Penn+CT BI Total also has 2 monthly), and some annual classes carry a stray quarterly instance. The four adjustment vectors take one basis per class, so a quarterly class's annual-origin methods — NY BI Total's F 12/F 13/F 22/G 11/H 02/H 12 — have no row at their own step: reading `[-n]` there steps a quarter where the method steps a year. Check that the resolved row label is one of the method's own origin labels before adjusting.
- **The base average row behind an imported User Entry value** is only recorded in the method notes, as `Selected average factor: "Simple - 2" (2.8539)`. Those notes live in the **output dataset sidecar**, not the method JSON. See [[resq-benchmark-row-imports-as-user-entry]].

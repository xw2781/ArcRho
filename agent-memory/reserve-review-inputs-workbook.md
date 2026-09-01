---
name: reserve-review-inputs-workbook
description: "Inputs.xlsx is the authoritative reserve-review source workbook, not the Inputs_v2.xlsx sitting beside it; the two disagree on real numbers"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4caf9ebc-9947-41d8-8ad0-cac856d8c1d1
  modified: 2026-09-01T00:07:13.092Z
---

For the quarterly reserve review, `E:\Actuarial\Reserve Review\<YYYY>Q<n>\Inputs.xlsx` is the authoritative source of the accounting cutoff and the growth adjustment factors. The `Inputs_v2.xlsx`, `Inputs - Copy.xlsx`, and `Growth Adjustment and Accounting Cutoff*.xlsx` files in the same folder are not. Confirmed by the user 2026-08-31 when a second agent session had built a DFM macro against v2.

**Why:** the two workbooks are not the same data in a different layout — they disagree on values that reach published methods. Measured on the 2026Q2 pair:

| | Inputs.xlsx | Inputs_v2.xlsx |
| --- | --- | --- |
| Annual Accounting Cutoff 2025 | 1.0 | 1.056 |
| Quarterly Accounting Cutoff 2026 Q1 | 1.0 | 1.0267 |
| NY BI Incurred factor 2026 Q1 | 1.00959112 | 1.00954592 |

The factor gap is not rounding on display: `Inputs.xlsx` compounds its chain from raw growth already cut to 4dp, so it lands on a different number by the 5th decimal.

**How to apply:** read `Inputs.xlsx` and say so; if anyone cites a figure that does not match, check which workbook it came from before assuming a bug. The layouts differ too — `Inputs.xlsx` has four header rows with the segment name in A2 and "Adjustment Factors" in F2, while v2 has one header row with the segment in A1 and "Factor" in F1 — so pointing a reader at v2 is not a path change. Match rows by period label rather than a fixed offset and the header difference is the only structural blocker. See [[reserve-review-input-vectors-script]].

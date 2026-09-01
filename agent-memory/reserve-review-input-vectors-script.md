---
name: reserve-review-input-vectors-script
description: "tools/create_reserve_review_input_datasets.py builds the four Inputs.xlsx-linked vectors per reserving class, one period basis per class — which does not cover the annual methods living inside a quarterly class"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4caf9ebc-9947-41d8-8ad0-cac856d8c1d1
  modified: 2026-09-01T00:22:15.583Z
---

`tools/create_reserve_review_input_datasets.py` (added 2026-08-31) creates Accounting Cutoff and Growth Adjustment--Incurred/--Counts/--Paid in every reserving class listed in `E:\ResQ\Automations\Reserve Review\ResQ Path.xlsx`, each linked to [[reserve-review-inputs-workbook]] with an in-cell formula over the "Adjustment Factors" block (columns G/H/I, carried verbatim — they are already compounded ratios, not 1+raw). It drives the running desktop app over HTTP, never overwrites an existing instance, and validates the ones it finds instead.

**Why the limitation matters:** the script takes one period basis per class from ResQ Path's third column, but a reserving class routinely holds both bases at once. Measured in `NJ_Annual_Prod_202605_Fake` on 2026-08-31, every quarterly class is mixed — NY BI Total has 71 annual instances against 37 quarterly, Penn+CT BI Total 70/38/2 — and even the annual classes carry a stray quarterly instance. So in a quarterly class the four vectors are quarterly, and the annual-origin methods beside them (F 12, F 22, G 11, H 02, H 12 and friends) have no series they can reference at the same step.

**How to apply:** do not assume one vector set per class serves every method in it. A consumer must check that the row a relative index resolves to is one of the method's own origin labels. If an annual companion series is ever wanted inside a quarterly class, a second instance of the same dataset type under a different name is supported — 12 such pairs already exist in that project, e.g. two instances of type `F 00 - Ultimate Net Loss`. The user has not decided whether to build them. See [[mixed-origin-length-precedents]] for the refresh-failure face of the same root cause.

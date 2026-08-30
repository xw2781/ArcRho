---
name: percentage-developed-from-dfm-factors
description: "BF and Cape Cod read Percentage Developed from the DFM's selected development factors (1/CDF at each origin's development age), not Latest ÷ Ultimate — changed 2026-08-30"
metadata: 
  node_type: memory
  type: project
  originSessionId: d59114a0-3543-4f37-8aac-b62e95746bfb
  modified: 2026-08-30T19:06:01.235Z
---

Until 2026-08-30 both Bornhuetter Ferguson and Cape Cod back-derived Percentage Developed as `Latest ÷ ultimate`. That is undefined when an origin's latest observation is zero (the newest year of a paid triangle), and drifts above 100% when the Latest triangle is not the one the DFM was built on. It now comes from `arcrho_api.dfm_contract.dfm_percent_developed_vector` — one over the cumulative development factor at each origin's own development age — read from the DFM **method** JSON while the graph edge stays on the dataset the DFM publishes, the way Bootstrap already reads its DFM precedent.

**Why:** the percentage is a property of the selected factors alone, so it stays meaningful for an origin whose latest, and therefore whose ultimate, is zero.

**How to apply:**
- The vector is an embedded source snapshot (`percentage_developed` on BF, `prior_ultimate_percentage_developed` on Cape Cod), covered by that precedent's source revision, not a calculated column. A refresh needs the DFM method file beside its output sidecar.
- `GET /dfm/development-pattern?project_name=&reserving_class=&dataset_name=` serves it to open windows; a dirty DFM previews it on `arcrho:dependency-source-preview` as `percentageDeveloped`.
- A Cape Cod prior ultimate with no DFM behind it has no pattern and still falls back to the ratio — the only remaining fallback.
- A ResQ import cannot reach the ArcRho DFM, so `extractors._resq_percentage_developed` copies `PercentageDevelopedValues(i)` (i = 1..origin count) straight off the ResQ BF / Cape Cod object — under ResQ's DFM-factor settings (type 2/3) that is already the factor pattern (G 41's zero-latest 2026 reads 1.46% in ResQ), and it lands as the BF `percentage_developed` / Cape Cod `prior_ultimate_percentage_developed` snapshot. Until 2026-08-30 the import divided Latest by the imported ultimate instead, which is why an import kept showing the old figures after the app fix; the post-import dependent walk stops at BF/CC, so nothing corrected them afterwards. Ratio (BF) / no pattern (CC) remain only as the fallback for a method without the property, and strict extraction refuses such a method. Verified via a read-only COM probe on the Server PC with `C:\Program Files\Python310\python.exe` (has pywin32); `rc.BFMethods().Item(name)` returned None for every name, iterate `Item(i)` and match `OutputVector.Name` instead.
- Saved methods keep old figures until recalculated; `tools/restate_percentage_developed.py --project X --apply` restates a project (45 methods restated in NJ_Annual_Prod_2026 Q2-May Test on 2026-08-30).

Related: [[bulk-method-restatement-hold]], [[mixed-origin-length-precedents]], [[hosted-save-fix-needs-engine-deploy]]

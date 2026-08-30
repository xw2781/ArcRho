---
name: percentage-developed-from-dfm-factors
description: BF and Cape Cod read Percentage Developed from the DFM's selected development factors (1/CDF at each origin's development age), not Latest ÷ Ultimate — changed 2026-08-30
metadata:
  type: project
---

Until 2026-08-30 both Bornhuetter Ferguson and Cape Cod back-derived Percentage Developed as `Latest ÷ ultimate`. That is undefined when an origin's latest observation is zero (the newest year of a paid triangle), and drifts above 100% when the Latest triangle is not the one the DFM was built on. It now comes from `arcrho_api.dfm_contract.dfm_percent_developed_vector` — one over the cumulative development factor at each origin's own development age — read from the DFM **method** JSON while the graph edge stays on the dataset the DFM publishes, the way Bootstrap already reads its DFM precedent.

**Why:** the percentage is a property of the selected factors alone, so it stays meaningful for an origin whose latest, and therefore whose ultimate, is zero.

**How to apply:**
- The vector is an embedded source snapshot (`percentage_developed` on BF, `prior_ultimate_percentage_developed` on Cape Cod), covered by that precedent's source revision, not a calculated column. A refresh needs the DFM method file beside its output sidecar.
- `GET /dfm/development-pattern?project_name=&reserving_class=&dataset_name=` serves it to open windows; a dirty DFM previews it on `arcrho:dependency-source-preview` as `percentageDeveloped`.
- A Cape Cod prior ultimate with no DFM behind it has no pattern and still falls back to the ratio — the only remaining fallback.
- A ResQ import cannot reach the ArcRho DFM, so `extractors._imported_percentage_developed` lands the ratio ResQ itself shows and the first refresh replaces it.
- Saved methods keep old figures until recalculated; `tools/restate_percentage_developed.py --project X --apply` restates a project (45 methods restated in NJ_Annual_Prod_2026 Q2-May Test on 2026-08-30).

Related: [[bulk-method-restatement-hold]], [[mixed-origin-length-precedents]], [[hosted-save-fix-needs-engine-deploy]]

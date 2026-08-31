---
name: instance-formula-import-design
description: "Agreed design (2026-08-31) for ResQ instance formulas: import translates them to in-cell formula links; ArcRho-linked cells join the dependency chain with auto-recalc; Excel links stay manual; 81/82 stay hardcoded until cross-project links; delete becomes cascade-with-confirm"
metadata: 
  node_type: memory
  type: project
  originSessionId: d511dbf6-2709-4c0e-8cd6-0f920620fee8
  modified: 2026-08-31T15:28:34.356Z
---

Design decisions agreed with the user on 2026-08-31 (session following [[resq-formula-belongs-to-type]]):

1. **Import translation layer.** The ResQ RC import translates a dataset instance's own ResQ formula into ArcRho in-cell formula links (`formula_links` in the sidecar) when the ArcRho dataset type has no formula, every referenced dataset exists in the same RC, and the type stays an editable input. Fallback when a reference cannot resolve (e.g. frozen `- Feb 2026` prior-quarter snapshots): import hardcoded values as today, optionally record the ResQ formula in notes. Canonical formula text must match `dataset_formula_link_service` / `dataset_formula.js` so later saves validate.
2. **Links join the dependency chain.** Datasets whose cells are driven by ArcRho dataset links (internal_links / formula_links with dataset refs) get instance-level precedent/dependent edges and auto-recalc in the dependent propagation walk — this closes the staleness gap (today link values are client-evaluated snapshots refreshed only from the Links tab). Excel-linked values stay manual-refresh only; formulas mixing Excel refs stay manual. Needs a server-side evaluator (the type-formula AST evaluator in `calculated_dataset_service` is the model), edge derivation in the graph writers and the Engine walk, cycle guarding, and Engine+Gateway+Bridge redeploys.
3. **81/82 Prior Qtr vectors** stay hardcoded imported values ([[arcrho-dataset-types-win-over-resq]]); they will later move to a planned cross-project links feature.
4. **Cascade delete.** Deleting a dataset instance should list the full downstream closure and offer to delete the whole chain instead of refusing. The server already allows chain deletes: `_surviving_dependents` ignores dependents included in the same request, the 409 refusal returns structured `blocked_datasets`, and `_cached_delete_targets` covers method JSONs too — so this is mostly closure computation + a confirm dialog, plus a propagation-hold preflight.

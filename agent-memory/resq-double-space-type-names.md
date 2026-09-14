---
name: resq-double-space-type-names
description: "ResQ spells some dataset type names with a doubled space (\"C 92 -  Current Qtr Selected\"); 8 of 250 types in NJ_Annual_Prod_202605_Fake carry one, instances/sidecars/index are single-spaced, production workbooks use both; since 2026-09-14 the Engine and the app server match names on the whitespace-collapsed, case-folded key, and the user wants every type name normalised eventually"
metadata: 
  node_type: memory
  type: project
  originSessionId: 30262bed-91c4-428a-8a4c-4776dc5800b2
  modified: 2026-09-14T15:57:30.394Z
---

ResQ carries doubled spaces inside some dataset type names and the ResQ import copies them into `dataset_types.json` verbatim. In NJ_Annual_Prod_202605_Fake (checked 2026-09-14) 8 of 250 types have one: `C 92 -  Current Qtr Selected`, `C 91 -  Current Qtr Indicated`, `C 82 -  Prior Qtr Selected`, `C 81 -  Prior Qtr Indicated`, `E1 61 -  Expected % * Ultimate Gross Loss`, `E 23 - Recd/Paid Loss  * Ultimate Gross Loss`, `E2 23  Subr/Paid Loss DFM * Ultimate Gross Loss`, `E2 25  Subr/Paid Loss DFM * Ultimate Gross Loss`. The stored dataset instances, sidecars, class `index.json`, and file names are single-spaced (`sanitize_dataset_file_name` collapses whitespace), and the Excel add-in's `NormalizeDatasetName` collapses the request before sending, so an exact-text lookup of the type table missed these ("Dataset type [...] is not defined for project").

**Why:** production workbooks still ask with the old double-spaced names and will for a transition period; the user's stated end goal (2026-09-14) is to normalise every type name so no double space remains anywhere, which is a data migration (dataset_types.json rows, formulas quoting the names, sidecars' `dataset_type`, method JSON references) and has not been done yet.

**How to apply:** match dataset/type names through `arcrho_api.dataset_type_contract.dataset_type_key` (strip, strip quotes, collapse inner whitespace, casefold); the Engine ships a pinned mirror `data_processing.dataset_type_key` used by `_dataset_type_row` (exact spelling wins, then key match), and the app server compares sidecar names with `helpers._canon_dataset_name` in `_cache_payload_name_matches`. Do not "fix" a double-spaced type name by hand in one file — the migration has to touch every reference at once. See [[excel-rebuild-of-method-results]] for the incident that surfaced it.

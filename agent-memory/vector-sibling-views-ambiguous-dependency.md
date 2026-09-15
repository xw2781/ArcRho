---
name: vector-sibling-views-ambiguous-dependency
description: "A calculated formula called a vector precedent \"Ambiguous dependency\" whenever stale @3/@6 view files sat beside its own copy; fixed 2026-09-15 by letting the sidecar's csv_file break the tie"
metadata:
  type: project
---

`calculated_dataset_service._candidate_csvs` scored every CSV whose name or
sidecar matched the dependency, kept all of them tied at the best score, and
the caller turned a tie into `Ambiguous dependency: <name>`. A vector defeats
that scoring completely:

- Its `@3`, `@6`, `@12` files all resolve to **one** sidecar, so the name
  points contribute identically.
- A vector states its period under `period_length`/`stored_period_length`, and
  the scoring only compared `origin_length`/`development_length`, which a
  vector sidecar does not carry. Every tie-breaking point was therefore 0.

So three views tied and F 63 could never refresh in `NJ_Annual_Prod_2026
Q3-Aug` (NY BI Total, NY MP+PIP, MA BI Total, Penn+CT BI Total) — the save's
walk reached it every time and declined. The same classes in
`NJ_Annual_Prod_202605_Fake` reproduce it exactly.

**Fix (2026-09-15, Engine + Gateway deployed):** a tie is now broken by the
sidecar's own `csv_file`, the rule `arcrho_runtime_service._vector_cache_candidates`
already states — a sidecar names the one real copy and the sibling `@n` files
are coarser views an older release wrote down. `_component_at_target_shape`
rolls the chosen file up to the formula's shape afterwards, so picking the
`@3` store and reading it at 12 is correct.

**How to apply:**
- "Ambiguous dependency" in a walk means two files tied, not that the data is
  wrong. List the class's `datasets/` folder first: sibling `@n` names beside
  one sidecar are the usual cause.
- Reproduce offline by calling `_candidate_csvs` directly; it needs no writes.

Related: [[refresh-problem-diagnosis-logs]], [[linked-origin-is-the-stored-origin]],
[[engine-stored-lengths-are-source-granularity]], [[hosted-save-fix-needs-engine-deploy]]

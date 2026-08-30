---
name: mixed-origin-length-precedents
description: Some BF/CC methods in the NJ_Annual_Prod projects point at precedents whose origin length differs from the method's, so they cannot refresh at all — pre-existing, not caused by whatever you just changed
metadata:
  type: project
---

BF and Cape Cod refuse a precedent whose sidecar `period_length` differs from the method's `origin_length` (`"... uses 3-month origins; expected 12"`). In `NJ_Annual_Prod_2026 Q2-May Test` on 2026-08-30, 26 of 82 BF/CC methods were in this state — quarterly DFMs feeding annual methods and annual datasets feeding quarterly ones — and none of them can be refreshed or resaved until the mismatch is resolved in the data.

**Why:** the guard fires in `_read_source_snapshot_from_sidecar` before any calculation, so these look like failures of whatever change you are testing. They are not. The DFM publishes aggregated `@3/@6/@12` CSV variants, which is why the method could be created, but the refresh path never adopted that aggregation.

**How to apply:** before blaming a change for these 422s, run the same check against a HEAD worktree — they reproduce identically. If per-origin aggregation is ever wanted, note that a percentage developed can only be aggregated by weighting with the DFM's own latest and ultimate per bucket; there is no latest-free aggregate.

Related: [[bulk-method-restatement-hold]], [[python-test-runner]]

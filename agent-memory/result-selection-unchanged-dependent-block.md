---
name: result-selection-unchanged-dependent-block
description: "2026-08-30 fix — a status-only Result Selection refresh no longer marks its DFM/calculated dependents as failed precedents; deployed 2026-08-30, and the NJ HOL G 41 - BF Paid blank 2026 value is gone now that percentage developed comes from the DFM factors"
metadata: 
  node_type: memory
  type: project
  originSessionId: 30df69f8-4482-4ed3-b4f5-746ece922b8a
  modified: 2026-08-30T15:37:00.324Z
---

Fixed on 2026-08-30 (uncommitted, deployed the same day): `result_selection_service.refresh_dependents`
blocked every non-Result-Selection dependent (a DFM or calculated output) of an output it had
only status-refreshed, so a later fan-in such as G 91 (loads G 12 DFM + G 23 calculated + F 91)
was refused with "Precedent refresh failed: G 12, G 23". That surfaced to the user as the
useless "Downstream refresh failed after BF publication." on every save of the NJ HOL adjusted
incurred triangle. The four method services now append the nested walk reasons to that message
via `calculated_dataset_service.cascade_failure_reasons`.

**Why:** the walk's reasons were flattened away by the save job (only the top `reason` reaches
the client and hosted_saves.log), which cost a full replay to diagnose.

**How to apply:**
- The fix runs on the Engine's bundled app_server copy. Engine + Gateway were deployed from
  the working tree on 2026-08-30 (`a5ccedf7+edits`), carrying this change along with the
  percentage-developed one, so it is live.
- The second, real data problem behind it is RESOLVED. `G 41 - BF Paid` published a blank 2026
  ultimate because its percentage developed for 2026 was None -- the old `Latest / DFM Ultimate`
  derivation divides by zero whenever an origin's latest paid is 0. Percentage developed now
  comes from the DFM's selected development factors, so 2026 reads 1.36% and G 41 publishes
  328 for 2026, ten values. See [[percentage-developed-from-dfm-factors]].
- Replaying this walk offline is dangerous: see [[offline-dependent-walk-replay]].

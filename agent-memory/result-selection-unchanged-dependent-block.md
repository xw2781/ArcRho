---
name: result-selection-unchanged-dependent-block
description: "2026-08-30 fix — a status-only Result Selection refresh no longer marks its DFM/calculated dependents as failed precedents; Engine+Gateway deploy still pending, and NJ HOL G 41 - BF Paid has a blank 2026 value that will fail G 92 once the walk gets that far"
metadata: 
  node_type: memory
  type: project
  originSessionId: 30df69f8-4482-4ed3-b4f5-746ece922b8a
  modified: 2026-08-30T15:37:00.324Z
---

Fixed on 2026-08-30 (uncommitted, NOT yet deployed): `result_selection_service.refresh_dependents`
blocked every non-Result-Selection dependent (a DFM or calculated output) of an output it had
only status-refreshed, so a later fan-in such as G 91 (loads G 12 DFM + G 23 calculated + F 91)
was refused with "Precedent refresh failed: G 12, G 23". That surfaced to the user as the
useless "Downstream refresh failed after BF publication." on every save of the NJ HOL adjusted
incurred triangle. The four method services now append the nested walk reasons to that message
via `calculated_dataset_service.cascade_failure_reasons`.

**Why:** the walk's reasons were flattened away by the save job (only the top `reason` reaches
the client and hosted_saves.log), which cost a full replay to diagnose.

**How to apply:**
- The fix runs on the Engine's bundled app_server copy: redeploy Engine + Gateway
  (`server-components/deploy.py`) before expecting the save to succeed; the tree held another
  session's uncommitted dataset-viewer work on 2026-08-30 so the deploy was left for the user.
- Second, real data problem behind it in project `NJ_Annual_Prod_2026 Q2-May Test`, class
  `HPPREF\HO+DF\NJ\Legacy\HOL`: `G 41 - BF Paid` publishes a blank 2026 ultimate (its
  percentage developed for 2026 is None), G 91 weights G 41 at 100% for 2026, so a refreshed
  G 91 has 9 values and G 92 fails "Source 'G 91' returned 9 values; expected 10". The user
  needs to fix the G 41 / G 43 setup or the G 91 weights; the code fix does not do that.
- Replaying this walk offline is dangerous: see [[offline-dependent-walk-replay]].

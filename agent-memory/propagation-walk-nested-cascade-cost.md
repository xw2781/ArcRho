---
name: propagation-walk-nested-cascade-cost
description: "Why a full-chain save took 11 s — 26 objects rewritten 54 times because method waves re-enter recalculate_dependents per method; the D 91 subtree ran three times; audit_log event_dates give the exact sequence (2026-09-16, Q3-Aug COL)"
metadata: 
  node_type: memory
  type: project
  originSessionId: c285c750-0eae-4979-9d1d-2bdc8582e924
  modified: 2026-09-16T13:06:02.622Z
---

Diagnosis of "saving C 42a takes 11-12 s" after the full-chain commit (849b20f9), traced 2026-09-16 on
`NJ_Annual_Prod_2026 Q3-Aug` / COL (the user granted that project's metadata for the session).

- `hosted_saves.log` gives the wave split per save (`bornhuetter_ferguson 11.4s`); wave marks are top-level only, so a
  wave's figure includes every cascade it nested.
- Every domain's `refresh_dependents` re-enters `calculated_dataset_service.recalculate_dependents` **per refreshed
  method** (`_refresh_downstream_domains`), RS per RS method too. In that save 26 objects were rewritten 54 times at
  ~0.2 s each: the D 91 Result Selection and its 13 descendants (6 calculated, D 92, 6 RS) ran three full passes, each
  ~3 s — triggered by C 92's nested B&S cascade, by D 31 in the RS loop, and by the B&S wave of C 41's cascade after
  D 18 changed. Only the last pass carried final inputs. The B&S method itself costs ~0.2 s, not the 6.7 s gap the
  file mtimes suggest (mtimes keep only the last write).
- Each nested walk called `get_index(refresh=False)`; the walk's own writes move the folder signature, so that read
  rebuilt the whole index every time. Fixed 2026-09-16: `_existing_dataset_keys_snapshot` (context-local, opened by the
  outermost `recalculate_dependents`) answers nested walks from one read. Deployed to Engine + Bridge.
- The Saved notice and the log's `walk refreshed N` name only top-level buckets; since 2026-09-16 the notice shows
  `review_flagged_datasets` (OK -> Needs Review flips recorded in `method_review_service.refreshed_status`).
- Neither `hosted_saves.log` nor `gateway.log` names the project; COL exists in four projects — ask.

**How to apply:** for a per-object trace, list sidecar `audit_log` `event_date`s inside the save's window with a
`py -3.10` script — that shows repeats, which mtimes cannot. The remaining fix is one dependency-ordered pass over
the closure so each object is refreshed once (~26 x 0.2 s here instead of 54). Related: [[dfm-save-propagation-profile]],
[[agent-share-listing-blocked-use-python]].

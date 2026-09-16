---
name: propagation-walk-nested-cascade-cost
description: "Why a full-chain save takes 4-12 s — every method refresh runs its own nested recalculate_dependents, each nested walk rebuilds the class index, and the popup/log name only top-level waves (2026-09-16 diagnosis)"
metadata: 
  node_type: memory
  type: project
  originSessionId: c285c750-0eae-4979-9d1d-2bdc8582e924
  modified: 2026-09-16T12:56:47.516Z
---

Diagnosis of "saving C 42a takes 11-12 s" after the full-chain commit (849b20f9), 2026-09-16.

- `hosted_saves.log` gives the split per save (`stages: ... bornhuetter_ferguson 11.4s ...`); the stage marks are
  top-level only, because nested walks get no progress callback, so a wave's figure includes everything it cascaded.
- Every domain's `refresh_dependents` (RS, BF, CC, BS, Bootstrap) calls `calculated_dataset_service.recalculate_dependents`
  again **per refreshed method** (`_refresh_downstream_domains`), and RS does the same per RS method; each nested walk
  runs dfm/linked/calculated/RS/BS stages, and the RS wave starts with `_assert_acyclic_dependency_subgraph` over the
  whole downstream closure. Objects downstream of two refreshed methods are recalculated once per path.
- Each nested walk calls `_existing_downstream_keys` -> `get_index(refresh=False)`; the walk's own writes move the
  folder signature, so that read rebuilds the whole class index every time (the same ~0.2 s the final `index` stage shows).
- Measured on the fake COL class (file mtimes, 11:40Z D 42 save): BF + 5 RS methods rewritten in 1.4 s, ~0.2 s per
  method including its nested walk. The popup said "1 dependent dataset was updated" — `_collect_refreshed_dataset_names`
  reads only the top-level `*_updates.updated` buckets, so nested rewrites are invisible there and in the log's
  `walk refreshed N` line.
- Neither `hosted_saves.log` nor `gateway.log` names the project; a class name alone (COL) matched four projects.

**How to apply:** for a per-object trace, list the class folder's sidecars/methods/datasets by mtime with a Python
script (a metadata read the fake project allows). Speed-ups that keep the behaviour: a walk-scoped snapshot of existing
dataset names instead of `get_index` per nested walk; batching a wave's cascades per frontier; ultimately one
topologically ordered pass over the closure so each node is refreshed once. Related: [[dfm-save-propagation-profile]],
[[agent-share-listing-blocked-use-python]].

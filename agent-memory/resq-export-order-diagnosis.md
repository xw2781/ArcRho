---
name: resq-export-order-diagnosis
description: "How to see the real ResQ export/sync write order and replay the dependency walk offline against a live reserving class, without ResQ"
metadata: 
  node_type: memory
  type: project
  originSessionId: e218eb77-10cd-4390-b631-e879bc7658a2
  modified: 2026-08-28T15:22:29.031Z
---

The Bridge's per-request status JSON under `E:\ArcRho Server\requests\RPC bridge\resq_reserving_class_sync\statuses\<request_id>.json` lists every item in the order it was written, with its outcome and ResQ's message — read it before trusting a "the order looks right" argument. The walk can be replayed offline (no ResQ, no COM) by importing `resq_data_migration` plus `resq_migration.sync_session`, calling `build_runtime(migration, None)`, `_apply_runtime_scope`, `collect_arcrho_inventory`, `_export_rows`, `_reserving_class_edges`, and `_dependency_ordered_rows`, then checking that every row sits after its transitive row ancestors.

**Why:** On 2026-08-28 the export of the fake project's COL class saved `C 91` before `C 52` because `C 91` reaches `C 52` only through the calculated vector `C 62`, which never becomes an export row; the B&S Settlement Rate method's link to `C 92` pulled `C 91` forward and ResQ marked it "Needs Review". Fixed the same day by ordering rows with the whole-class sidecar graph (`_reserving_class_edges`), which the ripple walk already used.

**How to apply:** For any "ResQ shows Needs Review after export/sync" report, compare the status file's order against the sidecar `precedents` on disk, following calculated datasets, before changing the writers. Related: [[bridge-worker-claim-identity]], [[bridge-heartbeat-false-negative]].

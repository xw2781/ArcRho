---
name: refresh-problem-diagnosis-logs
description: "A rules save or source refresh shows only its first problem; the full per-class reason list, the project name, and each class's timing are in the Engine's runtime logs on E:\\, and the fake project has the same HOL class for sidecar inspection"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4ab85a25-6856-4e6d-b29b-8f237331a011
  modified: 2026-09-06T13:02:09.022Z
---

When a Data Processing Rules save or a source-table refresh ends with "N problem(s) during the refresh; first: <class>: <method>: ...", the client status carries only that first line. The whole list is on the server:

- `E:\ArcRho Server\runtime\logs\source_table_refresh.log` has one "<class> dependent refresh reported errors: a | b | c" line per class, every reason pipe-separated.
- `E:\ArcRho Server\runtime\logs\data_processing_rules_jobs.log` has the job's `start project='...' revision=... rules=...` line, which is the only place the project name appears, plus per-class "took Ns" timing.
- A Result Selection reason of "Precedent refresh failed: <DFM>" where that DFM is absent from the list means the RS walk blocked a DFM it reached from a root, not that the DFM failed (fixed 2026-09-06 with `unchanged_precedent_names`).

The live project is usually one the agent may not open (`NJ_Annual_Prod_2026 Q3-Aug` on 2026-09-06); `NJ_Annual_Prod_202605_Fake` carries the same `HPPREF\HO+DF\NJ\Legacy\HOL` class with the same method graph, so read sidecars there.

Still failing in that project's walks after the 2026-09-06 fix, all pre-existing: BF "new_ultimate does not match the embedded source snapshots" (F 40/F 41/D 41 and variants), Cape Cod "precedent 'Total Earned Exposure' uses 1-month origins; expected 12" (F 53/D 53), "F 63 ...: Ambiguous dependency: P 06 ..." in the NY and Penn+CT BI Total / MP+PIP classes, and "Source 'C 41 - BF Reported ex CWOP' returned 39 values; expected 40" in Penn+CT BI Total. See [[mixed-origin-length-precedents]] and [[result-selection-unchanged-dependent-block]].

**Why:** the user asked "check the issue" from the one-line status; without the logs the investigation starts from the wrong method.

**How to apply:** tail both logs first, take the project from the start line, then reason from the fake project's sidecars before touching code.

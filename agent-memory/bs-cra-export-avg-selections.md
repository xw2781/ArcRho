---
name: bs-cra-export-avg-selections
description: "2026-09-02 the Export macro writes a B&S CRA method's Avg. Selections (both grids, user values + per-column selection) via SetUser/SetSelected AvgInflation/AvgCaseReserves; the case-reserve setter names were inferred by symmetry and still need the user's confirmation"
metadata: 
  node_type: memory
  type: project
  originSessionId: 724fab46-5187-42a3-9706-ff5e6410502c
  modified: 2026-09-02T20:06:00.317Z
---

Since Export macro v2.8.0 (2026-09-02) a B&S Case Reserve Adequacy method is no longer save-only: the exporter writes `SetUserAvgInflation(dev, value)` then `SetSelectedAvgInflation(dev, code)` for every development column, and the same for `SetUserAvgCaseReserves` / `SetSelectedAvgCaseReserves`, then Notes, then Save. Codes come from inverting `BS_CRA_INFLATION_TYPES` / `BS_CRA_AVERAGE_CASE_RESERVE_TYPES` in `resq_migration.extractors` (inflation `user` = 4, case reserves `user` = 3). B&S Settlement Rate, BF, and Cape Cod stay save-only (`_SAVE_ONLY_METHOD_CODES`), and the review offers CRA rows for export through `_EXPORT_PHASE_METHOD_KINDS` in sync_session.

**Why:** The inflation setters are confirmed by `ResQToolBox2.BS.set_user_avg_inflation`; the case-reserve setters were inferred from the reader names (`SelectedAvgCaseReserves`, `UserAvgCaseReserves`) because the decompiled manual index has no entry for them. A formula in a User Value cell needs no special handling: the method JSON already stores the evaluated number, with the text only in `*_inputs`.

**How to apply:** If a CRA export fails with a COM "unknown name" on the case-reserve setter, ask the user for the real name rather than searching the share (a recursive grep of the decompiled manual takes minutes). The Sync macro's field-level apply still refuses BS CRA; only the Export macro writes it. Related: [[resq-com-probe]], [[resq-benchmark-row-imports-as-user-entry]].

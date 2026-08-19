---
name: pi-path-load-smb-cost
description: "Measured cost of the PI 'Loading reserving class paths' task: flat ~220ms per SMB file read, 21 round trips, and gateway HTTP measured 3.8x faster"
metadata: 
  node_type: memory
  type: project
  originSessionId: a39fcd98-7bf9-469e-a00d-746dc966dda8
  modified: 2026-08-16T14:43:17.144Z
---

2026-08-16 profile of the Project Instance "Loading reserving class paths..." overlay, run from the Client PC (L-H2MQ6280FVP) against `E:\ArcRho Server`, project `NJ_Annual_Prod_202605_Fake`.

**Re-measured 2026-08-19, same PC and share: the constants move a lot day to day.** An `open()+read()` of a 4.7 KB method JSON cost **582 ms** median (a 0.2 KB file, 415 ms) against the ~220 ms below; a create + exists + rename + delete cycle for a small request file cost **982 ms**; one `wait_for_file` poll iteration (visibility probe write + delete + exists) cost **647 ms**. `os.stat` was 0.2 ms where a directory listing had just warmed the attribute cache, so stat costs depend on what ran before them. Treat every absolute number here as a same-day reading and re-measure before quoting one; the *ratios* between transports have held.

**Share latency is per-operation, not per-byte.** On this PC an `open()+read()` of a project JSON costs ~220 ms whether the file is 2.5 KB or 31 KB; an `os.stat` costs ~35 ms; the same read on local C: is 0.5 ms. Optimising these paths means cutting round trips — shrinking payloads buys nothing. Do not reason about network-drive cost from file size.

**The paths task is not on the gateway.** `WORKSPACE_READ_KINDS` in `python-api/src/arcrho_workspace_read_contract.py` holds the only 8 hosted read kinds; the reserving-class picker's four requests (`/project-user-preferences`, `/reserving_class_combinations`, `/reserving_class_types`, `/reserving_class_filter_spec`) all read the mapped drive directly and never appear in the client read-latency log, which logs only registered reads. Measured: 21 share ops, ~2.4–2.7 s critical path (serial pref read + parallel pair + serial filter-spec read), 85–95 % of each step's wall time inside share I/O.

**Redundancy found:** `preferences.json` is read 3x per task (once by step 1, twice by step 4 — `get_filter_spec_for_project` calls `_read_reserving_class_tree_filter_spec` and `_read_reserving_class_tree_preferences`, each re-reading the file with no cache). `GET /reserving_class_types` calls `refresh_reserving_class_types_json`, touching `reserving_class_types.json` 5x, `reserving_class_values.json` 2x and stat-ing the `.xlsx` — 12 of the 21 ops, ~1.2 s — and it writes JSON+XLSX whenever the merge differs.

**Gateway vs SMB, same read, this PC:** `dataset_index` for one reserving class measured 104 ms median over the gateway vs 398 ms median over SMB (~3.8x). Gateway capability probe round trip ~63 ms — cheaper than a single share file read.

Profiling technique (no sandbox copy needed, unlike [[dfm-save-propagation-profile]]): put `frontend` and `python-api/src` on `PYTHONPATH` and import `app_server` directly — it resolves the real workspace root from `workspace_paths.json`. Call the route functions via `importlib.import_module("app_server.api.<name>_router")`, because `app_server/api/__init__.py` re-exports each module's `APIRouter` under the module's own name and shadows the module. Import `pathlib` before patching `os.stat`. Stub `save_reserving_class_types_payload` to keep the profile read-only. Python 3.10 on this machine has fastapi/pandas/openpyxl available; no venv needed.

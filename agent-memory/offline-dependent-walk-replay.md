---
name: offline-dependent-walk-replay
description: "Replay a save's dependent walk offline against a scratch copy of one reserving class (mock config.load_workspace_paths); scratchpad paths overflow MAX_PATH for dataset CSVs so use a short junction; an already-consistent copy cannot reproduce a stale-state failure"
metadata: 
  node_type: memory
  type: project
  originSessionId: a6f90213-cbce-468a-b2ce-e215fcde55b6
  modified: 2026-08-30T00:53:57.358Z
---

To replay `calculated_dataset_service.recalculate_dependents` offline (2026-08-29): copy the project's root JSON files plus `data/<class>` into a scratch workspace, then in the harness `mock.patch.object(app_server.config, "load_workspace_paths", return_value={"workspace_root": <root>, "paths": {"projects_dir": "projects", "requests_dir": "requests"}}).start()` before importing the services. `C:\Program Files\Python310\python.exe` with `frontend`, `python-api/src`, `server-components/src` on `sys.path` runs it; each stage bucket returns `updated` / `status_refreshed` / `skipped` / `errors`, so print all four — a DFM that only re-stamped status is in `status_refreshed`, not `skipped`.

**Why:** the harness scratchpad path is ~150 chars, and `...\datasets\Net Loss--Incurred Adjusted_%2A_ - B&S ...@12@12@cum@dev.csv` pushes the full path past MAX_PATH (260). Python then reports `FileNotFoundError` on a file that `os.listdir`, Bash and PowerShell all see — a silent, confusing failure. A junction such as `C:\Users\xwei.PRCINS\AppData\Local\Temp\2\arw -> <scratchpad>\ws` (PowerShell `New-Item -ItemType Junction`) keeps the data in the scratchpad with short paths.

**How to apply:** a copy taken after the save is already consistent (every method's `*_source_revision` matches), so the replay reports `ok: True` with nothing updated and cannot reproduce a failure the live walk hit on stale dependents. Bumping a CSV cell, re-stamping the root sidecar's `updated_at`, or setting a method's `latest_source_revision` to a bogus value only re-stamps statuses — it did not make the DFM recompute — so to see the real reason, make it visible instead: since 2026-08-29 the refresh dialog shows the inline walk's `message` and `refreshed_datasets`, and `hosted_saves.log` records `walk FAILED: <reason>` for dataset sidecar saves (the Engine used to look for `calculated_updates` only under `data`). Related: [[dfm-offline-recompute-repro]], [[propagation-hold-and-test-isolation]].

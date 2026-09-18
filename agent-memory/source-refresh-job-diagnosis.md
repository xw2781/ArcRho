---
name: source-refresh-job-diagnosis
description: "Where a Source Data import/refresh job's full result lives (statuses folder + source_table_refresh.log), and that 'claim missed (project busy)' lines are the other four Engine workers polling, not a fault"
metadata: 
  node_type: memory
  type: project
  originSessionId: b57a7bf3-d4ed-45fb-9519-94df29d8d69e
  modified: 2026-09-18T19:03:42.776Z
---

A Source Data import (Import Settings > Next) runs as an Engine `psrefresh_*` job. To check one after the fact:

- `E:\ArcRho Server\requests\source_table_refresh\statuses\<request_id>.json` keeps the terminal status: row/column counts, classes refreshed, datasets regenerated, methods updated, and the full `failures` list (the client shows only the first).
- `E:\ArcRho Server\runtime\logs\source_table_refresh.log` has the `start project=... import=... dataset_types=... class_types=...` scope line, per-class timing, the pipe-separated dependent reasons, and the real traceback under a `raised:` line when the status only says "The source table refresh failed."
- `claim missed (project busy)` repeated every second for the same request id is the Orchestrator's other Engine workers (`apps.orchestrator.max_workers` = 5 on 2026-09-18) retrying the request file, which is removed only when the job ends. Harmless noise.
- `423: Source table file is locked: <source csv>` names the source CSV but the traceback shows the failing step is the swap of the project's `source\master_table.csv`; something had that file open. A retry minutes later succeeded on 2026-09-18.

**Why:** on 2026-09-18 the user asked "check the log" after an import whose dialog showed only the first Cape Cod problem; the DFM geometry failures and the locked-file retry were only visible here.

**How to apply:** read the status file and the log's `start` line first to learn the job's real scope (dataset types x class types) before judging what did or did not refresh. See [[refresh-problem-diagnosis-logs]] and [[mixed-origin-length-precedents]].

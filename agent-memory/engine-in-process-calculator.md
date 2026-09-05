---
name: engine-in-process-calculator
description: "2026-09-05 source refresh \"dependent refresh reported errors\" was quarterly methods in an annual class whose 3-month precedent request files no Engine claimed; the Engine now runs its own jobs' calculations in-process and job messages carry the walk's first real reason"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3e972a37-752d-43d1-979f-b53bc7cf99fa
  modified: 2026-09-05T19:43:46.984Z
---

**What happened (2026-09-05, NJ_Annual_Prod_2026 Q3-Aug).** The Import Settings refresh
ended with "PRNJ - PA\PA\MA\Direct Group\BI Total: the dependent refresh reported errors"
although the CSV import and all 120 engine-dataset regenerations succeeded. BI Total and
MP+PIP hold quarterly (origin 3) methods over annual (12) class datasets, so the dependent
walk asks `precedent_cache_service.materialize_engine_source` to rebuild each precedent at
3 months. On the Engine that meant `run_engine_calculation` -> `publish_and_wait`: a loose
`requests/request-<time>.json` the Engine itself (or one of the other four instances) had to
claim, with `config.ENGINE_REQUEST_TIMEOUT_SEC = 15`. Four of those files were never claimed by
any of the five running Engines (they sat until the Orchestrator's 5-minute sweep), each cost
the full 15 s, and the DFMs needing them failed. When read over the share the files showed
stray bytes after the JSON; the Engine silently skips a request it cannot parse. Not
re-verified (files swept), so treat as the leading explanation only.

**What changed (deployed bridge+engine+gateway the same day, build-260905-153958-721):**
- `engine_calculation_service.set_in_process_calculator` / `calculate_in_process`: the
  Engine registers `RequestHandler.calculate_in_process` at warm-up, so a durable job on the
  Engine runs ArcRhoTri/Vec/Headers in-process under the legacy `_processing_lock` instead of
  posting a request file to itself. Outcome `transport="in_process"`, failure status
  `engine_error` with the exception text. Nothing else registers it (Gateway, Bridge, client
  app server still use request files).
- `dependent_propagation.dependent_refresh_failure_reasons/_message`: source refresh and
  dataset-type change failures now read `"<class>: <first cascade reason> (+N more)"` and log
  every reason to `source_table_refresh.log` / `dataset_types_change.log`.
- `_method_update_count` reads the waves' `updated` bucket (it read `refreshed`, so
  `methods_updated` was always 0).
- The Engine logs an unreadable loose request once per file to
  `runtime\logs\engine_requests.log` (`ENGINE_REQUEST_LOG_FILENAME`) instead of skipping it
  silently; a `FileNotFoundError` (claimed by another Engine) stays silent.

**How to apply:** if a refresh reports errors again, read the class line in
`source_table_refresh.log` for the real reason first. `engine_requests.log` appearing means a
request file on the share could not be parsed; capture the file before the sweep removes it.
The "(in-process calculator registered)" line goes only to the Engine console, so the proof
it is live is a refresh whose 3-month precedents build without new loose request files.
Related: [[mixed-origin-length-precedents]], [[origin-length-is-not-row-count]],
[[remote-component-deploy]], [[adding-a-project-level-engine-job]].

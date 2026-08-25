# Engine-Hosted Dependent Propagation Plan

Version: v1.0
Last updated: 2026-08-06

## Summary

Move the "update all dependents" cascade that runs after every dataset or method
save from the client PC's bundled app server to the ArcRho Engine on the server
host, as a durable long-running job. The client save writes only the saved
object itself, enqueues one propagation job, and returns; the Engine — running
where `E:\ArcRho Server` is a local drive — refreshes every downstream dataset
instance and method object (app-calculated datasets, DFM, Result Selection,
Bornhuetter Ferguson, Cape Cod, Bootstrap), finalizes method review statuses,
and rebuilds the reserving-class `index.json`.

"Dataset" throughout this plan means dataset instances **and** all method
objects; the propagation walk covers both in one pass.

## Why (measured 2026-08-06)

Profiled `save_dfm_method` end-to-end against a sandbox copy of
`NJ_Annual_Prod_202605_Fake` HOL (35 methods, 122 sidecars), counting every
filesystem operation per phase with injected per-operation latency:

| phase | network file ops | share |
| --- | --- | --- |
| save core (method JSON + sidecar) | ~30 | ~20% |
| dependent walk + index rebuild | ~130 | ~80% |

That ~80% is the floor: it was measured with every downstream method blocked, so
nothing recalculated. Injected latency scales the request linearly: 0.4 s at
0 ms/op, 1.6 s at 10 ms, 4.2 s at 30 ms. On the client's real project the
cascade actually recalculates tier by tier, and Result Selection refreshes can
materialize engine-source precedents (`_materialize_engine_source` →
`run_arcrho_tri`, 15 s budget each) whose completion the client detects by
polling the network share with probe writes. Those engine round trips plus
hundreds of small-file round trips at VPN/SMB latency are the observed
minute-long saves. Client version note: verify whether a given install actually
contains the 2026-08-05 dependency-scan fix (`_read_json_files_bulk`) before
re-diagnosing; the fix reduces round trips but cannot change where they happen.

Running the same canonical code on the server host converts every one of those
round trips to local-disk operations and sub-second engine watch-folder
detection.

## Settled Decisions

1. **The Bridge is out of scope as a host.** It is ResQ-migration support, gated
   on a ResQ Enterprise window, and will be retired. Its PyInstaller recipe for
   bundling `frontend/app_server` (`arcrho_bridge/bundled_sources.py`,
   `build_exe.py`) is reused for the Engine build; the Bridge itself gains no
   feature.
2. **The Engine hosts the job.** ~5 instances already run on the server host;
   the project-duplication job framework (durable queue, background job thread,
   status files, leases) is the template and, where practical, shared code.
3. **No client-side fallback.** The client-side propagation driver is removed,
   not kept as a compat path. There is exactly one implementation of the
   cascade: the canonical `calculated_dataset_service.recalculate_dependents`,
   invoked only inside the Engine. If no live Engine heartbeat exists, the save
   is **blocked** with a message box ("The ArcRho Engine service is not
   available…"); unsaved work stays in the editor window. Saving without
   propagation is forbidden because it would strand the reserving class stale
   and require a separate repair path — duplicated logic this plan explicitly
   avoids.
4. **All propagation call sites migrate in phase 1**: DFM, Result Selection,
   BF, Cape Cod, Bootstrap method saves, dataset sidecar/grid saves in
   `dataset_service`, cache-write propagation in `arcrho_runtime_service`, and
   the manual refresh endpoints (`refresh_dfm_method` and the per-method
   `refresh_dependents` routes). Enumerate call sites by searching for
   `recalculate_dependents` callers; none may remain after phase 1.
5. **Open windows get a change alert.** When another user or an automation
   process (including the propagation job itself) updates the object a user has
   open, the window shows: "The dataset is updated by another user or external
   automation process since last opened, please close and reopen to view the
   updated values."
6. **Reserving-class lease lock.** One lock per affected reserving-class folder
   so only one Engine instance propagates a segment at a time; leases have a
   heartbeat and a stale-takeover timeout so a dead instance cannot hold a lock
   forever.

## Job Contract

New canonical contract module `python-api/src/arcrho_dependent_propagation_contract.py`
(stdlib-only, importable by the frozen Engine and the app server — the exact
pattern of `arcrho_project_duplication_contract.py`). Single source of truth for
the envelope schema, folder layout, status payload, validation, and lease
parameters.

- Request: `requests/dependent_propagation/requests/<RequestId>.json`

  ```json
  {
    "Function": "ArcRhoRefreshDependents",
    "ContractVersion": 1,
    "RequestId": "<client-generated token>",
    "ProjectName": "<logical project name>",
    "Path": "<reserving class path, e.g. HPPREF\\HO+DF\\NJ\\Legacy\\HOL>",
    "ChangedRoots": [
      {"dataset_name": "<name>", "dataset_type": "<type>"}
    ],
    "UserName": "<windows login>"
  }
  ```

  Path-free by construction: no `DataPath`, `StatusPath`, `ServerRoot`, or any
  absolute path; extra fields are rejected (same allow-list validation style as
  project duplication). The worker derives all paths from its own server root.
- Status: `requests/dependent_propagation/statuses/<RequestId>.json` — derived
  from `RequestId`, never caller-supplied:

  ```json
  {
    "contract_version": 1,
    "status": "queued|processing|success|error",
    "updated_at": "<iso8601 utc>",
    "request_id": "<id>",
    "progress": {"stage": "<tier label>", "completed": 0, "total": 0, "label": "<dataset>"},
    "message": "<error text when status=error>"
  }
  ```

- Locks: `requests/dependent_propagation/locks/<sha256(project + path)>.lock` —
  exclusive-create (`open("x")`), heartbeat via `os.utime` every 5 s, stale
  takeover after 300 s (reuse duplication's lease helpers; extract them to the
  shared contract layer rather than copying). Known residual gap, accepted as
  for duplication: a plain filesystem cannot atomically fence the
  check-and-unlink race on a stale lease; the generous thresholds make it
  acceptable.
- The queue lives in a **subfolder** because the orchestrator garbage-collects
  loose files in `requests/` older than 5 minutes.
- Request/status/lock files are transient runtime files, outside the persisted
  ArcRho JSON text-format rule (like bridge heartbeats and engine request
  envelopes).
- Status-file retention follows the project-duplication cleanup policy so the
  statuses folder does not grow without bound.

### Coalescing

Duplicate work from concurrent users is suppressed at claim time: when a worker
claims a job for a reserving class, it drains all other queued requests for the
same `(ProjectName, Path)` and merges their `ChangedRoots` into one walk, then
marks the drained requests' statuses as completed by the merged run (status
gains a `merged_into: <request_id>` field). Requests arriving mid-run queue
normally and run next; the lease serializes them.

## Engine Changes (`server-components/src/arcrho_engine/`)

- `requirements.txt`: add `fastapi` and `pydantic` (already proven in the Bridge
  bundle for the same reason — `app_server` services raise `HTTPException`).
  numpy/pandas are already present.
- `build_exe.py`: bundle `frontend/app_server` + `python-api/src` the way
  `arcrho_bridge/build_exe.py` does (`--paths` + hidden imports + build-time
  import probe that fails the build if the app_server import graph breaks).
- `main.py`: register `ArcRhoRefreshDependents` in the durable-job framework
  used by `ArcRhoDuplicateProject`: dedicated background thread so long
  propagations never block the calculation queue, queue rescan on the existing
  5 s cycle, request file retained until a validated terminal status exists.
- Job handler: set the runtime server root (as `resq_import_runner.
  configure_canonical_runtime` does), acquire the reserving-class lease, run
  `calculated_dataset_service.recalculate_dependents(project, path, roots …,
  rebuild_index=True)`, publish progress per tier, write terminal status,
  release the lease.
- Engine-source materialization inside the walk keeps using the normal
  `requests/` calculation queue; on the server host a sibling instance picks it
  up from local disk in well under a second.

## App Server Changes (`frontend/app_server/`)

- New submit/status endpoints mirroring the duplication pair:
  `POST …/refresh_dependents` → 202 + `job_id`;
  `GET …/refresh_dependents/status/{request_id}` → validated status payload.
- Submission preflights live Engine heartbeats
  (`runtime/instances/…`); no live instance → the save endpoint returns the
  engine-unavailable error **before** writing anything, and the UI shows the
  message box. Implementation note: verify what heartbeat files Engine
  instances publish today (the Bridge worker's 6 s-staleness heartbeat under
  `runtime/instances/` is the reference); if Engine instances do not yet
  publish an equivalent, adding one is part of phase 1.
- Every save flow (decision 4) replaces its inline
  `recalculate_dependents(...)` call with: write the saved object + sidecar →
  submit the job → return `job_id` in the response. The response keeps its
  shape; `propagation` becomes `{"job_id": …, "status": "queued"}`.
- **No-op saves submit no job**: when the save leaves the publication revision
  unchanged (today's `publication_changed` check in `save_dfm_method`, and the
  analogous checks in the other method services), skip job submission entirely
  and return `propagation: {"status": "unchanged"}`. Today the walk runs
  unconditionally on every save; this is wasted work wherever it runs.
- Delete the client-side propagation entry points once all call sites are
  migrated (no feature flag left behind; the dev PC runs the same path as
  clients).
- Downstream sidecars are marked review-needed by the save itself (existing
  behavior) so statuses are honest while the job runs; the job clears them as
  it refreshes each tier.

## Frontend UI Changes (`frontend/ui/`)

- **Job progress**: one shared poller modeled on
  `project_settings_duplicate_job.js` (750 ms interval, retry/stale rules).
  Method pages and the dataset window show "Updating dependents…" from the
  status file's progress stage and refresh the Project Instance dataset table on
  completion. Save itself completes in seconds regardless of chain size.
- **Engine unavailable**: message box on save when submission is refused:
  "The ArcRho Engine service is not available. Please try again later or
  contact the administrator." The window stays open with unsaved work intact.
- **Change alert in open windows** (decision 5): on open, remember the object's
  fingerprint (sidecar/method `mtime_ns` + revision fields); poll it on an
  interval (single stat round trip; reuse the Project Instance index-watch and
  DFM freshness-check patterns). On mismatch, show the alert message box once.
  One mechanism covers both another user's edit and the propagation job
  refreshing the viewed object. Expected detection latency is the poll interval
  plus SMB attribute-cache lag (seconds, not instant); acceptable for an
  advisory prompt.

## Read-Path Simplification (after the job is the sole propagation writer)

Today an open of a calculated object recursively fingerprint-validates its
precedent chain because sidecar `status` cannot be trusted — any client could
die mid-cascade. Once propagation is a single locked, journaled server-side
job, `status: 0` plus the reserving-class folder-signature check (three
directory listings) becomes trustworthy evidence of currency. Change the open
fast path to: trust the opened object's own sidecar status + index folder
signature; fall back to deep per-precedent fingerprint validation only when the
status is not current or the signature moved. Opening a downstream object then
costs a couple of reads for the object itself, not a walk of its ancestry, and
triggers no recalculation and no engine request.

While a job is running or after it failed, an opened downstream object shows
its last-published values with the review-needed status; the client never
starts its own cascade.

## Phasing

1. **Phase 1** — contract module + Engine job type + app server submit/status +
   all save call sites migrated + client-side driver removed + engine-unavailable
   block + job progress UI. *(Implemented and deployed 2026-08-06.)*
2. **Phase 2** — change alert in open windows; read-path trust optimization.
   *(Implemented 2026-08-06: `/object_change/fingerprint` stat endpoint +
   `ui/shared/services/object_change_watch.js` poller wired into the Dataset
   Viewer, DFM, BF, Cape Cod, and Result Selection windows; trusted open fast
   path in `arcrho_runtime_service._calculated_dependencies_match` gated on
   sidecar status + index folder signature. Berquist-Sherman pages, which save
   only through the dataset sidecar endpoints, and Bootstrap, which has no UI
   page, are not watched.)*
3. Each phase ends with the standard docs/index/release-fragment updates. Note
   the Bridge bundles `frontend/app_server`, so phase 1's app-server changes
   require a Bridge rebuild (`server-components/src/arcrho_bridge/build_exe.py`) even
   though the Bridge gains no feature.

## Testing

- Contract tests: exact-payload validation (allow-list, forbidden path fields),
  status transitions, lease acquire/renew/stale-takeover, coalescing merge —
  modeled on `frontend/tests/test_project_duplication_jobs.py`, which already
  imports app server and Engine modules in one process.
- Engine tests: job claim/retention, single-thread serialization per class,
  progress publication, request retained until terminal status.
- App server tests: save → 202 + queued job; save refused when no heartbeat;
  response-shape compatibility for `propagation`/`calculated_updates` consumers.
- Cross-producer parity: unchanged — the job calls the same canonical services;
  add one test asserting the Engine-run walk writes byte-identical sidecar and
  index payloads to a direct in-process walk for the same inputs.
- UI tests: poller states (success, error, stale, engine-gone), alert fires on
  fingerprint change and not on self-save.

## Concurrency and Failure Policies (confirmed by owner, 2026-08-06)

1. **Saving into a class whose propagation job is running is allowed.** The
   lease serializes Engine instances only; a client may write its method JSON +
   sidecar during an active walk. Every individual file write is already atomic
   (temp + `os.replace`), the save marks its downstream review-needed, and the
   follow-up job it enqueues re-walks and self-heals any interleaving. Client
   saves must NOT take the cross-machine lease — a dying client PC would strand
   it.
2. **Non-client producers run in-process under the lease.** The Bridge ResQ
   import, `resq_data_migration.py`, and the public Python API — processes on
   the server host — keep invoking the canonical walk in-process (their I/O is
   local) but must acquire the same reserving-class lease through a helper
   exported by the contract module. Anything running on a client PC must
   enqueue a job like the app does. One implementation; batch imports never
   depend on Engine availability mid-run.
3. **Failed jobs are not auto-retried.** A failed propagation leaves downstream
   statuses review-needed (visible in Project Instance), the status file
   carries the error, and the next save or a manual refresh re-enqueues the
   walk.

## Out of Scope

- Bridge feature work (retiring module).
- Push-style notification infrastructure (polling is sufficient).
- Cross-project propagation (jobs are scoped to one reserving class; a save
  only ever affects its own class today).

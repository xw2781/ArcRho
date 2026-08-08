# App Server Domain: object_change_watch

## Purpose
<!-- MANUAL:BEGIN -->
Open-window change-watch domain: a dataset window or method page polls a stat-only fingerprint of the object it opened and shows a one-time advisory alert when another user or an automation process (including the Engine dependent-propagation job) rewrites it.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.object_change_watch.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/object_change/fingerprint` | `get_object_change_fingerprint` | `ObjectChangeFingerprintRequest` | [`app_server/schemas/object_change_watch.py`](../../../app_server/schemas/object_change_watch.py) | `object_change_watch_service.object_change_fingerprint` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.object_change_watch.key_files -->
- [`app_server/api/object_change_watch_router.py`](../../../app_server/api/object_change_watch_router.py) - Stat-only object fingerprint route.
- [`app_server/services/object_change_watch_service.py`](../../../app_server/services/object_change_watch_service.py) - Dataset/method fingerprint resolution and tokens.
- [`app_server/schemas/object_change_watch.py`](../../../app_server/schemas/object_change_watch.py) - Typed fingerprint request/response models.
- [`ui/shared/services/object_change_watch.js`](../../../ui/shared/services/object_change_watch.js) - Shared open-window change-watch poller.
- [`ui/shared/tabs/data/data_tab_change_watch_port.js`](../../../ui/shared/tabs/data/data_tab_change_watch_port.js) - Data-tab host port for save/run boundaries.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- `POST /object_change/fingerprint` stats the watched files only — the dataset sidecar for `kind: "dataset"`, the canonical `<PREFIX>@<name>.json` method file (plus the output sidecar when `output_dataset` is given) for `kind: "method"` — and returns `{files, token}`; it never reads a payload.
- `dataset_sidecar_status_service.method_json_path` is the single owner of the method-type-to-filename-prefix rule; every method service path builder delegates to it.
- The shared UI poller `ui/shared/services/object_change_watch.js` compares tokens on an interval (default 5 s), fires `onChange` once, and exposes `pause`/`resume`/`rebase` so self-saves are never reported. The Data tab reports save/run boundaries through `ui/shared/tabs/data/data_tab_change_watch_port.js` for the Dataset Viewer host.
- The one-time alert (`showObjectUpdatedAlert`) offers a Refresh Now action that reloads the window in place; a dirty window blocks the reload and explains why.
- Same-app dependent-propagation jobs never raise the alert: saves attach the queued `propagationJobId` to their dependency-source `cleared` message, Project Instance defers the downstream preview clear until the job's terminal status (`waitForDependentPropagationOutcome`), and its `arcrho:dependent-propagation-started`/`-finished` scope broadcasts pause every matching window's watch (`wireSamePropagationScopePause`, with a failsafe resume timer) until the refreshed values are reloaded.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Stateless: each request is one or two `os.stat` calls; the baseline token lives in the open window.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Watch a new object kind: extend the service's kind dispatch and give the page a poller via `createObjectChangeWatch`/`createMethodObjectChangeWatchController`, pausing around its save flow.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- The alert is advisory: detection latency is the poll interval plus SMB attribute-cache lag, and a change landing between open and the first poll baseline is not reported.
<!-- MANUAL:END -->

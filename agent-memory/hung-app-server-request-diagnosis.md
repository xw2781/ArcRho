---
name: hung-app-server-request-diagnosis
description: uvicorn logs an access line only when a response is sent, so a request still running leaves no log line at all — the signature of a hung app-server handler
metadata:
  type: project
---

The packaged desktop app's bundled app server writes uvicorn's access log to `%APPDATA%\arcrho-electron\logs\arcrho-server-*.log`, one file per launch, and **uvicorn emits an access line only after the response is sent**. A handler that is still running therefore leaves *no* trace in that log at all — not a slow line, not an error, nothing.

**Why:** that inverts the usual reading. "The endpoint is missing from the log" looks like "the client never called it", when it can equally mean "the call is still in flight". On 2026-08-19 `POST /dataset_types` appeared **zero times across 69 log files**, which read as a dead client — while the handler had in fact run, written `dataset_types.json` and `dataset_types.xlsx`, and then hung for over ten minutes in a per-sidecar walk over the share.

**How to apply:** when an endpoint is absent from the log, corroborate with side effects before concluding it was never called.
- Compare file mtimes against the session's start time (`electron-main-*.log` line 1 has `startup begin`). A written file with no access line for its route is a hung handler, full stop.
- Check the effect that happens *after* the slow step: a project `audit_log.json` that never gained the entry its route appends is the same evidence from the other end.
- `Get-Process -Id <pid>` thread states (`(Get-Process -Id N).Threads | Group-Object ThreadState,WaitReason`) will show a thread in `Wait, Executive` — suggestive of blocking I/O, not proof.
- The app the user is running is the packaged build from `%LOCALAPPDATA%\Programs\ArcRho\resources`, not the working tree. Diff `resources\arcrho_server\_internal\ui\...` against `frontend/ui/...` before assuming the running code is the code you are reading; `data-engine/deploy.py` does not rebuild it, only Bridge/Engine/Gateway/Orchestrator/Admin/Launcher.

Client-side, the matching failure is silent: a `fetch` with no timeout never settles, so a single-flight guard keyed on "a save is in flight" stays latched forever. See [[arcrho-dev-ui-cache-restart]] and [[propagation-status-smb-cache-lag]].

---
name: build-listener-request-read-race
description: "deploy.py can fail instantly with \"The build request could not be read: [Errno 13] Permission denied\" on the request JSON; it is a watcher/atomic-write race on the share, not a bad payload, and one plain retry succeeds"
metadata: 
  node_type: memory
  type: project
  originSessionId: 641a11c5-47ea-42b1-86a4-76a9de665146
  modified: 2026-08-23T18:16:31.328Z
---

Seen 2026-08-23 on the Client PC: `python server-components/deploy.py` queued the build, the listener (buildbot clone, live heartbeat) claimed it within a second, and its whole log was one line — `ERROR: The build request could not be read: [Errno 13] Permission denied: 'E:\ArcRho Server\requests\builds\requests\build-...json'`. The listener's `_read_request` does a single `path.read_text()` with no retry, while the client publishes the request through an atomic temp-file rename over SMB; the listener's folder watcher fired while the rename was still settling.

**Why:** the payload was fine (the identical retry built all three components), so this must not be read as a contract or permission problem, and the guideline's "do not retry blindly" does not apply — the cause is known and transient.

**How to apply:** when a deploy fails with exactly this message and an otherwise empty build log, rerun `deploy.py` once. If it happens twice, the fix belongs in `server-components/src/arcrho_build_listener.py` `_read_request` (retry a `PermissionError` for a second or two). Related: [[remote-component-deploy]].

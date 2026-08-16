---
name: gateway-deploy-swap-lock
description: Gateway build from the Client PC can fail at the atomic folder swap with WinError 5; the rollback keeps the old Gateway serving and a stale .ArcRho Gateway.new is left behind
metadata: 
  node_type: memory
  type: project
  originSessionId: a39fcd98-7bf9-469e-a00d-746dc966dda8
  modified: 2026-08-16T16:37:07.197Z
---

2026-08-16, building the Gateway from the Client PC (`python data-engine/src/arcrho_gateway/build_exe.py`, `ARCRHO_DEPLOY_ROOT` unset so it used the UNC `\\NE7SASWPN02\E\ArcRho Server`): PyInstaller succeeded, then `deploy_exe()` failed at `temporary.rename(DEPLOY_APP_DIR)` with `PermissionError: [WinError 5] Access is denied`. This is the swap step, not the build.

What the failure leaves behind — verify all of it before deciding anything:

- **The old Gateway keeps serving.** `deploy_exe`'s `except` restores `.ArcRho Gateway.old` back to `ArcRho Gateway` when the forward rename fails, so the deployed folder is intact at its previous timestamp. Confirmed live: heartbeat under `E:\ArcRho Server\runtime\instances\arcrho_gateway\` was 3.5 s fresh and `GET <client_url>/api/health` returned `{"ok":true}`. A failed deploy is therefore *safe*, just ineffective — the frozen bundle stays at the old revision.
- **The kill switch is restored.** The `gateway_stopped()` context manager exits before the exception propagates; its "…is not a local disk; the server's Orchestrator restarts the Gateway" line printing in the failure output is the evidence that the restore ran.
- **A full `.ArcRho Gateway.new` staging copy is orphaned** in `E:\ArcRho Server\apps\`. Harmless — the next `deploy_exe` starts with `_remove_tree(temporary)` — but it is a whole PyInstaller dist sitting on the share.

**The failure is transient — an unchanged retry of the same command succeeded** (2026-08-16, ~1 h later: swap clean, deployed folder restamped, staging folders consumed, heartbeat fresh, `/api/health` `{"ok":true}`, and a hosted `dataset_index` read served over HTTP at 101 ms median without falling back to SMB). So the cause is a lock race rather than permissions: `wait_for_shutdown()` waits for the heartbeat file to disappear, which is not the same as Windows releasing the executable's handles, and the server's Orchestrator restarts the Gateway as soon as the kill switch clears. Deploying from the Client PC normally works (see [[client-pc-primary-workstation]]). Retry once before investigating — but AGENTS.md says report a failed deploy plainly and do not retry blindly, so surface the failure and let the user call it. A durable fix would be a short bounded retry with backoff around the rename in `deploy_exe`.

Beware the wrapper exit code: the background task reported "exited with code 0" while the traceback showed the `PermissionError`. Read the output tail, not the exit status, to decide whether a Gateway deploy actually succeeded.

Note that the Gateway bundles `ENGINE_BUNDLED_SOURCES`, which includes `frontend/app_server` — so an app-server service edit makes the Bridge, the Engine **and** the Gateway stale, three rebuilds rather than two. Related: [[bridge-restart-after-deploy]], [[pi-path-load-smb-cost]].

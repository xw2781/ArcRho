---
name: gateway-deploy-swap-lock
description: "Component deploys now stage into a persistent .<App>.slot (robocopy delta, manifest-driven) while live and swap with three retried renames; the old .new/.old copy-and-swap could fail with WinError 5 and left orphans — history and what to expect from the new scheme"
metadata: 
  node_type: memory
  type: project
  originSessionId: a39fcd98-7bf9-469e-a00d-746dc966dda8
  modified: 2026-08-16T16:37:07.197Z
---

2026-08-16, building the Gateway from the Client PC (`python server-components/src/arcrho_gateway/build_exe.py`, `ARCRHO_DEPLOY_ROOT` unset so it used the UNC `\\NE7SASWPN02\E\ArcRho Server`): PyInstaller succeeded, then `deploy_exe()` failed at `temporary.rename(DEPLOY_APP_DIR)` with `PermissionError: [WinError 5] Access is denied`. This is the swap step, not the build.

What the failure leaves behind — verify all of it before deciding anything:

- **The old Gateway keeps serving.** `deploy_exe`'s `except` restores `.ArcRho Gateway.old` back to `ArcRho Gateway` when the forward rename fails, so the deployed folder is intact at its previous timestamp. Confirmed live: heartbeat under `E:\ArcRho Server\runtime\instances\arcrho_gateway\` was 3.5 s fresh and `GET <client_url>/api/health` returned `{"ok":true}`. A failed deploy is therefore *safe*, just ineffective — the frozen bundle stays at the old revision.
- **The kill switch is restored.** The `gateway_stopped()` context manager exits before the exception propagates; its "…is not a local disk; the server's Orchestrator restarts the Gateway" line printing in the failure output is the evidence that the restore ran.
- **A full `.ArcRho Gateway.new` staging copy is orphaned** in `E:\ArcRho Server\apps\`. Harmless — the next `deploy_exe` starts with `_remove_tree(temporary)` — but it is a whole PyInstaller dist sitting on the share.

**The failure is transient — an unchanged retry of the same command succeeded** (2026-08-16, ~1 h later: swap clean, deployed folder restamped, staging folders consumed, heartbeat fresh, `/api/health` `{"ok":true}`, and a hosted `dataset_index` read served over HTTP at 101 ms median without falling back to SMB). So the cause is a lock race rather than permissions: `wait_for_shutdown()` waits for the heartbeat file to disappear, which is not the same as Windows releasing the executable's handles, and the server's Orchestrator restarts the Gateway as soon as the kill switch clears. Deploying from the Client PC normally works (see [[client-pc-primary-workstation]]). Retry once before investigating — but AGENTS.md says report a failed deploy plainly and do not retry blindly, so surface the failure and let the user call it. A durable fix would be a short bounded retry with backoff around the rename in `deploy_exe`.

Beware the wrapper exit code: the background task reported "exited with code 0" while the traceback showed the `PermissionError`. Read the output tail, not the exit status, to decide whether a Gateway deploy actually succeeded.

Note that the Gateway bundles `ENGINE_BUNDLED_SOURCES`, which includes `frontend/app_server` — so an app-server service edit makes the Bridge, the Engine **and** the Gateway stale, three rebuilds rather than two. Since 2026-08-17 you no longer have to track that by hand, and should not run these builds from a client at all: see [[remote-component-deploy]]. Related: [[bridge-restart-after-deploy]], [[pi-path-load-smb-cost]].

2026-08-16 (later): a Gateway deploy from this Client PC with `ARCRHO_DEPLOY_ROOT="E:\ArcRho Server"` (the mapped letter, not the UNC form) swapped cleanly on the first try — the script still reported the deploy root as `\NE7SASWPN02\E\ArcRho Server` and left the relaunch to the server Orchestrator; heartbeat reappeared ~2 min after `Build finished`.

**Superseded 2026-08-16 (later the same day):** `server-components/src/build_runtime.py` now owns the deploy for every
`build_exe.py` (`stage_deploy` + `swap_deploy`; see `server-components/architectures.md` "Component build deployment").
The build is robocopy-mirrored (`/MIR /MT:32`) into a persistent `apps\.<App Name>.slot` *while the component is
still running*, using a `.arcrho-deploy-manifest.json` inside the folder to restore deployed timestamps on
byte-identical files so only changed files transfer; the stopped window is three renames (live→`.prev`,
slot→live, `.prev`→slot) each wrapped in `rename_with_retry` (8×5 s on WinError 5) — the durable fix this note
asked for. Observed from the Client PC: the first Gateway deploy under the new scheme still copied all 1653
files ("(1653 of 1653 files changed)" — no manifest yet), the swap succeeded, and the Orchestrator relaunched
the Gateway within a minute; deltas start once a slot with a manifest exists (2 warm-up deploys). Do not delete
`.slot` folders or their manifest. Legacy `.ArcRho <App>.new` / `.old` orphans from the old scheme are not
swept by the new code — remove them by hand once (`build_runtime.remove_tree_with_retry`).

**The Bridge swap can refuse repeatedly and then succeed unchanged — and the live sessions are not the cause.** 2026-08-19: two deploys an hour apart both logged `Rename busy (ArcRho Bridge -> .ArcRho Bridge.prev)` through all 8 retries at 5 s and failed with `WinError 5`; a third, with the same command and two ResQ sessions still live, swapped with no retry line at all. The tempting explanation — bridges run one per interactive ResQ session, so a user's process holds the folder — is wrong, and `build_exe.py` disproves it: `bridge_stopped()` sets `apps.bridge.kill_all` and `wait_for_bridge_shutdown()` blocks until every `bridge` and `bridge_worker` heartbeat file is gone (60 s budget, abort otherwise), and `stop_worker` terminates then kills with a 2 s wait each. Reaching the rename at all proves the bridge processes had already exited, so the holder was something else on the server — an Explorer window, a scanner, or a handle Windows had not yet released. Treat it exactly like the Gateway case above: a failed swap is safe (previous build keeps serving, kill switch restored, no orphaned `.prev`/`.slot`), and an unchanged retry later is the remedy.

Related: [[remote-component-deploy]], [[bridge-restart-after-deploy]]


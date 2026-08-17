---
name: remote-component-deploy
description: Components are rebuilt through data-engine/deploy.py, which queues a request for the server-side Build Listener; running build_exe.py from a client is the slow fallback
metadata:
  node_type: memory
  type: project
---

Since 2026-08-17, component rebuilds go through `python data-engine/deploy.py` (no arguments = every stale component). It queues a request under `E:\ArcRho Server\requests\builds` and the **ArcRho Build Listener** — the "Listen for build requests" toggle in `data-engine\build_manager.bat` on the server — runs the same `build_exe.py` locally, streaming its log back. Exit codes: `0` ok, `1` build failed, `2` usage/precondition, `3` no listener running (relay the CLI's message asking a human to start it; nothing else in the flow needs a person).

**Why:** a deploy from a client is dominated by writing the frozen build across the share. Measured 2026-08-17 on this Client PC: the same share **reads at 50 MB/s but the deploy's writes ran at 0.18 MB/s**, so ~5 of each ~6-minute deploy was transfer, not build. Metadata is not the problem — enumerating all 1,667 deployed files took 1.2 s (0.7 ms/file). Do not re-derive this; measure only if the numbers stop matching.

**How to apply:** never hand-pick which components to rebuild — `deploy.py` derives staleness from each component's bundled source roots, and `arcrho_build_components.py` is now the single owner of that rule for both the GUI and the CLI. An `frontend/app_server/` edit makes Bridge, Engine **and** Gateway stale; picking by memory already caused a missed Gateway deploy. Uncommitted work deploys fine: the request carries a patch of the affected trees against the newest commit the server can resolve, plus untracked files, so there is no reason to commit or push just to deploy.

Gotchas: the listener **resets its own clone** on every request, so nothing may be edited there, and it should be restarted after a change to its own modules (its heartbeat reports the commit it started from). Anyone who can write the queue folder can run repository code on the server — the guards are the share ACLs plus the listener's optional user allowlist.

**A working-tree deploy ships everyone's edits**, not just yours: this clone is worked in by more than one session at a time (seen 2026-08-17, an in-flight SQL Server/Arcode feature under `frontend/app_server` while an unrelated task was finishing). The CLI prints the changed and new files for that reason — read the list, and if it contains work that is not yours, stop rather than deploying it. `--stale` reads the same shared tree, so it can report components stale because of somebody else's work in progress.

Related: [[gateway-deploy-swap-lock]], [[bridge-restart-after-deploy]], [[client-pc-primary-workstation]], [[pi-path-load-smb-cost]]

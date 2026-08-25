---
name: bridge-restart-after-deploy
description: "After build_exe.py deploys the Bridge, check apps.bridge.auto_create_instance; when true the orchestrator relaunches it, when false start the exe manually"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0a5616ae-9d5a-4766-a011-883e2b0109cc
  modified: 2026-08-07T04:23:09.052Z
---

Whether the Bridge comes back after `server-components/src/arcrho_bridge/build_exe.py` depends on `apps.bridge.auto_create_instance` in `E:\ArcRho Server\config\config.json`. It was false on 2026-08-04 but true again on 2026-08-07 — check the live value, don't assume.

**Why:** The orchestrator loop only spawns Bridge instances when `auto_create_instance` is true (`server-components/src/arcrho_orchestrator/main.py`). Since 2026-08-07 the model is one Bridge per user session: the orchestrator counts/limits only its own user's bridge heartbeats, and the Bridge supervisor exits at startup if a fresh same-user heartbeat exists.

**How to apply:** After a Bridge rebuild/deploy, wait ~20s for a heartbeat under `E:\ArcRho Server\runtime\instances\arcrho_bridge\`; if none appears (or auto_create_instance is false), start it directly: `Start-Process "E:\ArcRho Server\apps\ArcRho Bridge\ArcRho Bridge.exe"`. See also [[resq-com-probe]].

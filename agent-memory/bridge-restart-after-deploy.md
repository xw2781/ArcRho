---
name: bridge-restart-after-deploy
description: "After build_exe.py deploys the Bridge, check apps.bridge.auto_create_instance; when true the orchestrator relaunches it, when false start the exe manually"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0a5616ae-9d5a-4766-a011-883e2b0109cc
  modified: 2026-08-27T14:52:38.695Z
---

Whether the Bridge comes back after `server-components/src/arcrho_bridge/build_exe.py` depends on `apps.bridge.auto_create_instance` in `E:\ArcRho Server\config\config.json`. It was false on 2026-08-04 but true again on 2026-08-07 — check the live value, don't assume.

**Why:** The orchestrator loop only spawns Bridge instances when `auto_create_instance` is true (`server-components/src/arcrho_orchestrator/main.py`). Since 2026-08-07 the model is one Bridge per user session: the orchestrator counts/limits only its own user's bridge heartbeats, and the Bridge supervisor exits at startup if a fresh same-user heartbeat exists.

**How to apply:** After a Bridge rebuild/deploy, wait ~20s for a heartbeat under `E:\ArcRho Server\runtime\instances\arcrho_bridge\`; if none appears (or auto_create_instance is false), start it directly: `Start-Process "E:\ArcRho Server\apps\ArcRho Bridge\ArcRho Bridge.exe"`. See also [[resq-com-probe]].

**Other users' sessions may or may not come back — check, don't assume either way.** A `server-components/deploy.py bridge` run kills every live Bridge on the server (`apps.bridge.kill_all` flips true then false). On 2026-08-25 a deploy left JZhang's `arcrho_bridge_worker` heartbeat gone while xwei's reappeared within 20s; on 2026-08-27 (Bridge 1.3.3, deployed by ref from the buildbot clone) both xwei's and JZhang's Bridge *and* worker heartbeats reappeared within 20s with no one doing anything. Record the bridge and worker heartbeat names before the deploy, list them again ~20s after, and only tell a user to relaunch their ArcRho session if their pair is missing.

**2026-09-06: a Bridge started by hand from Admin Control does not survive a deploy.** The deploy only stops Bridges (kill_all true, then false); nothing relaunches them except the Orchestrator running in each user's own server session, which is also what `deploy.py` relies on. On 2026-09-06 the server (`query user /server:NE7SASWPN02`) had 26 signed-in sessions but only jhou's Orchestrator heartbeat, so after the 09:01 Bridge 1.4.2 deploy only jhou's Bridge came back and xwei's (started from Admin Control at 08:37) stayed down. Check `runtime\instancesrcrho_orchestrator\` before blaming the Bridge: a user without an Orchestrator heartbeat needs one started in their own RDP session (Admin Control "start orchestrator", the Launcher, or the exe) — it cannot be started from the Client PC or another user's session. Remote `tasklist /S` needs credentials the Client PC does not have.

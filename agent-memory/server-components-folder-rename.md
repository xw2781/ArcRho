---
name: server-components-folder-rename
description: data-engine/ was renamed to server-components/ on 2026-08-25; the server-side build listener must be restarted from the new folder before the next deploy
metadata: 
  node_type: memory
  type: project
  originSessionId: 7b01be8b-9594-4b09-aaf2-56419c4df111
  modified: 2026-08-25T15:45:02.791Z
---

On 2026-08-25 the repo folder `data-engine/` became `server-components/` (Engine, Orchestrator, Bridge, Launcher, Admin Control, Gateway, build listener/manager, server installer). Every tracked path reference and the `DATA_ENGINE_*` test anchors were rewritten in the same commit; archived release notes and macro backups keep the old name on purpose.

**Why:** The folder had outgrown its name — only a third of it was the Engine — and the Gateway could not be carved out because it imports Engine modules and shares the one component/deploy table.

**How to apply:** Until the ArcRho Build Listener on the Server PC is restarted from `E:\XWSpace\Repos\ArcRho-buildbot\server-components\build_manager.bat`, `server-components/deploy.py` cannot succeed: the running listener still resolves its build scripts under the old `data-engine\src` path, which the rename commit removes from its clone. The local venvs moved with the folder and still work (build scripts drive them through their own `python.exe`); only the stale `activate` / `pip.exe` wrappers embed the old path and nothing in the repo uses them. See [[remote-component-deploy]].

The buildbot clone's remotes are `origin` (GitHub) and `worktree` (`E:\XWSpace\Repos\ArcRho`, the Server PC's own working clone — not the Client PC clone), so a commit must be pushed to GitHub or pulled into that server clone before the listener can resolve it. Git refuses to run against the buildbot clone over the share ("dubious ownership"); read its `.git/config` and `.git/HEAD` as plain files instead. The listener's reset is `git clean -fd` without `-x`, so its ignored `venvs\` and `builds\` survive a checkout and just need moving under the new folder name. Bring-up order on the Server PC: fetch + detach onto `origin/main`, move `venvs`/`builds`, start `server-components\build_manager.bat`, then deploy from the client (every component rebuilds once).

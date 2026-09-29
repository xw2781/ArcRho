---
name: build-listener-down-local-build
description: "When deploy.py exits 3 on the Server PC, run each component's build_exe.py locally with ARCRHO_DEPLOY_ROOT; ~2 min each, creates 1.8 GB of venvs/builds to delete afterwards"
metadata:
  node_type: memory
  type: reference
  originSessionId: a67cea08-d868-4db6-946c-c248084098c5
  modified: 2026-09-29T16:28:26.038Z
---

On 2026-09-29 `deploy.py` exited 3 (no Build Listener) while the session ran on the Server PC
NE7SASWPN02 itself. The documented fallback worked and costs no share transfer there:

```
cd server-components/src/arcrho_engine   (then arcrho_gateway, arcrho_bridge)
ARCRHO_DEPLOY_ROOT='E:\ArcRho Server' py -3.10 build_exe.py
```

`py -3.10` has PyInstaller 6.20. The first build creates `server-components/venvs/<component>`
(~3 min); each build then takes ~2 min including the slot swap and restart. It deploys the whole
working tree, so check `git status` for others' edits first. Afterwards `deploy.py --stale`
reports every component up to date. Delete `server-components/builds` and `venvs` (542 MB +
1.3 GB) when done; this clone normally has neither. Related: [[remote-component-deploy]],
[[hosted-save-fix-needs-engine-deploy]].

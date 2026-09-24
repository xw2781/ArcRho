---
name: arco-is-the-app-name
description: "Arco" / "Arco Workspace" is the ArcRho desktop app's product name; GUI-test UI edits by closing and reopening the project tab or window, no restart
metadata:
  type: reference
---

The ArcRho desktop app shows itself as **Arco Workspace** (window title, About box, update
prompts; renamed in commit 545c449d). When the user says "test it in Arco" they mean the running
ArcRho desktop app, usually the dev instance started from this clone
(`frontend\node_modules\electron\dist\electron.exe .`), found with
`agent_screen_control.ps1 windows -Window Arco`.

To load `frontend/ui` edits into that running app without a restart (2026-09-23): close and
reopen the method window to reload a method page, and close and reopen the Project Instance
tab (Project Explorer, double-click the project) to reload Project Instance modules. `/ui/*` is
served no-cache, so a fresh iframe document picks up the edit. See [[arcrho-dev-ui-cache-restart]]
and [[desktop-input-control-works]].

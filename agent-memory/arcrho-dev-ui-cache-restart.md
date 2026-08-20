---
name: arcrho-dev-ui-cache-restart
description: "In dev, the in-app ArcRho restart cannot pick up frontend/ui changes - ARCRHO_UI_VERSION is pinned for the supervisor's lifetime"
metadata: 
  node_type: memory
  type: project
  originSessionId: 65357351-b081-4660-97de-09268c8952fc
  modified: 2026-08-20T00:00:00.000Z
---

In dev mode, `POST /app/restart_electron` (and the in-app Restart action) **cannot** pick up changes
to anything under `frontend/ui/`. `start_electron.bat` mints `ARCRHO_UI_VERSION` **once** as a
timestamp, and `electron_shell.py` copies that env for every supervised relaunch. The main window
loads `/ui/?v=<ARCRHO_UI_VERSION>`, so `index.html` is served from Chromium's cache on every
restart - along with the whole module graph it references.

To pick up UI changes you must **fully stop and relaunch the supervisor** (`electron_shell.py`), not
just restart Electron.

Separately, ArcRho modules are cache-busted by hand-maintained `?v=` query strings. Editing a module
is not enough - you must bump its `?v=` in **every importer**, and bump `ui_shell.js?v=` in
`ui/index.html` when anything in the shell graph changes. Otherwise the browser keeps serving the
cached copy and the edit silently has no effect.

A module served under two different `?v=` strings is **two module instances** with separate
top-level state, so a per-session cache in one of them is invisible to the other. That makes
the bump transitive: rewriting an importer changes that file too, so its own importers must be
bumped as well, all the way to the page entry (`dfm.html` -> `dfm_main.js`, which forwards its
own `?v=` to `dfm_tabs_orchestrator.js`). Run it to a fixpoint rather than one level deep.
`tests/frontend_controller_modularity.test.mjs` enforces the single-URL half of this
("DFM runtime imports never load one module under multiple version URLs"), and
`tests/color_theme.test.mjs` pins the entry stamps, so both need updating in the same change.

The bundled **app server** has the same trap for Python. Unpackaged, `backend_lifecycle.js` spawns
`app_shell.py` from source, so `frontend/app_server/` edits need the app process to actually restart -
rebuilding the Bridge/Engine does **not** affect it (they carry their own frozen copies). Symptom seen
2026-08-08: after a `SUMMARY_VERSION` bump the old in-memory server kept writing the previous version's
`table_summary.json` long after the edit, so the feature looked broken in the UI. Check the payload's
version field on disk before blaming the code - a cache file newer than your edit can still have been
written by stale code.

Related: [[arcrho-launch-electron-detached]]

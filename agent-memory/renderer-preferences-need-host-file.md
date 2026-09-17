---
name: renderer-preferences-need-host-file
description: Browser localStorage is not durable for an ArcRho renderer preference; keep one under %APPDATA%\ArcRho\prefs through the Electron host instead
metadata: 
  node_type: memory
  type: project
  originSessionId: 466ba7ce-546a-42e1-91de-8a94ec48931e
  modified: 2026-09-17T17:47:14.032Z
---

A preference kept in the renderer's `localStorage` is lost in three ordinary situations: File > Restart and Clear Cache & Reload call `session.clearStorageData()` with no filter, and when backend port 28765 is busy the app starts on a random free port (seen 2026-09-16, port 57456), which is a different origin with empty storage. The notes panel size (`ui/shared/tabs/notes/notes_tab.js`) moved to `%APPDATA%\ArcRho\prefs\notes_panel_prefs.json` on 2026-09-17 for this reason; the notes font size (`arcrho.notes.font-size`) and the default window tabs (`arcrho_default_window_tabs`) still live in `localStorage` and share the weakness.

**Why:** the symptom is "sometimes the app forgets my setting", which looks like a save bug in the feature when the store itself was wiped.

**How to apply:** store a durable local-user preference in its own whole-file JSON under the prefs folder through `preferencesFileHandlers` in `frontend/electron/main.js` plus a pair of `ADAHost` methods in `preload.js`. A page inside a Project Instance iframe has no `window.ADAHost`; reach the bridge through `window.top.ADAHost` (see `notesHostApi`). Related: [[dev-ui-cache-restart]] for what a restart clears.

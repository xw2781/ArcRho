---
name: theme-css-version-pins
description: Several frontend tests pin exact ?v= stamps (theme sheets in color_theme.test.mjs, shell modules in review_table.test.mjs); bumping a stamp requires updating its pins
metadata: 
  node_type: memory
  type: project
  originSessionId: a91eeb85-901d-42b8-af80-9ab0494903cf
  modified: 2026-08-19T14:56:30.414Z
---

`frontend/tests/color_theme.test.mjs` pins exact `?v=` stamps for the shared theme sheets: the `THEMED_DOCUMENTS` ordering test pins `high_contrast.css?v=...` (one shared stamp across all runtime documents), the splash test pins splash.html's `light/dark/high_contrast` stamps, the DFM dark test pins dfm.html's `dark.css?v=`, and the "cache-version chains" test pins page-entry module stamps (e.g. `dataset_viewer_main.js?v=`).

`frontend/tests/review_table.test.mjs` pins shell-module stamps the same way: its "shell UI automation wires asynchronous review-table..." test asserts `ui_automation.js?v=<stamp>` in **every** consumer (`ui_shell.js`, `shell_messages.js`, `update_progress.js`) plus `ui_shell.js?v=`, `review_table.css?v=`, and `pi_table.css?v=` in `ui/index.html`. Editing `ui/shell/ui_automation.js` therefore means bumping three importers and that pin together (hit 2026-08-19).

**Why:** the suite enforces that a changed owner module is actually reachable through current cache-busting chains, so stale `?v=` stamps (or stale test pins) fail it.

**How to apply:** when editing `dark.css`/`high_contrast.css`, bump the `?v=` in all ~20 importer HTML files to one shared new stamp (PowerShell regex replace works) and update the matching pins in `color_theme.test.mjs` in the same change. The same "cache-version chains" test also pins Arcode editor module stamps (`code-editor/index.js`, `notebook-editor/core.js`, `snowflake-console/index.js`), so bumping one of those needs its pin updated too. Confirmed accurate 2026-08-16.

Some pins in that list go stale on their own (`dataset_viewer_main.js` was pinned at `20260814b` while HEAD served `20260816a`), so check a failure against `git show HEAD:<file>` before assuming your change caused it. Related: [[arcrho-dev-ui-cache-restart]], [[frontend-node-test-suite]].

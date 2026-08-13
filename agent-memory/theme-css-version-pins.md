---
name: theme-css-version-pins
description: Bumping themes/dark.css or high_contrast.css ?v= stamps requires updating pinned stamps in color_theme.test.mjs
metadata: 
  node_type: memory
  type: project
  originSessionId: a91eeb85-901d-42b8-af80-9ab0494903cf
  modified: 2026-08-12T00:11:51.346Z
---

`frontend/tests/color_theme.test.mjs` pins exact `?v=` stamps for the shared theme sheets: the `THEMED_DOCUMENTS` ordering test pins `high_contrast.css?v=...` (one shared stamp across all runtime documents), the splash test pins splash.html's `light/dark/high_contrast` stamps, the DFM dark test pins dfm.html's `dark.css?v=`, and the "cache-version chains" test pins page-entry module stamps (e.g. `dataset_viewer_main.js?v=`).

**Why:** the suite enforces that a changed theme/chart owner is actually reachable through current cache-busting chains, so stale `?v=` stamps (or stale test pins) fail it.

**How to apply:** when editing `dark.css`/`high_contrast.css`, bump the `?v=` in all ~20 importer HTML files to one shared new stamp (PowerShell regex replace works) and update the matching pins in `color_theme.test.mjs` in the same change. Related: [[arcrho-dev-ui-cache-restart]], [[frontend-node-test-suite]].

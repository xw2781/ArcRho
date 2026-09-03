---
name: electron-ui-screenshot-check
description: "How to render a CSS/markup mock-up to PNG with the repo's bundled Electron for a visual check without launching the app (clear ELECTRON_RUN_AS_NODE, app-dir with package.json)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 620f207d-9366-4da9-864b-84aa8281437e
  modified: 2026-09-03T21:20:13.361Z
---

To eyeball a UI change without launching ArcRho, write a mock-up HTML in the scratchpad that links the real stylesheets by relative `file://` path, plus a tiny Electron main script (`BrowserWindow` → `loadFile` → `webContents.capturePage()` → `toPNG`) and a `package.json` with `"main": "main.js"`, then run from the repo root:

```
env -u ELECTRON_RUN_AS_NODE ./frontend/node_modules/electron/dist/electron.exe <app-dir> <page.html> <out.png>
```

Then Read the PNG. Used 2026-09-01 to verify the Flight Deck draw toolbar icons and states.

The same harness can exercise a real ES module, not just CSS: have `main.js` start a tiny
`http.createServer` that maps `/ui/*` onto `frontend/ui/*` and everything else onto the app dir,
`loadURL` the mock over that port, and the mock's `<script type="module">` can then import the
module under test by its site-absolute `/ui/...` path (a `file://` load cannot resolve those).
Drive it with synthetic `MouseEvent`/`KeyboardEvent` dispatches, stub
`navigator.clipboard.writeText` to capture copies, park the results on `window.__results`, and poll
for them with `executeJavaScript` before `capturePage`. Used 2026-09-03 to verify the Berquist
Sherman cell-selection module (drag, TSV copy, row/column select, two-grid exclusivity, context
menu, Escape) against the real shared spreadsheet controller and stylesheets.

**Why:** Claude Code's shell exports `ELECTRON_RUN_AS_NODE=1`, so the bundled `electron.exe` starts as plain Node and `require("electron")` fails with "Cannot find module 'electron'". Passing a script path instead of an app directory fails the same way. There is no cairosvg, ImageMagick, or rsvg on the Client PC, so this is the only local rasterizer. Mask-image icons resolve off disk because the icon stylesheets use relative `url()`s (see [[frontend-node-test-suite]] for the sibling node-portable note).

**How to apply:** Reach for this whenever a task changes icons, toolbar chrome, or states that a test cannot judge; the icon rules require a preview before claiming a set looks right.

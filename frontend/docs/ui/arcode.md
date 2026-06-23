# Frontend: Arcode

## Purpose
<!-- MANUAL:BEGIN -->
Canonical Arcode workspace for opening notebooks and code files in a dedicated tabbed coding app.
ArcRho embeds the Arcode launch path, and the same source can be packaged as the standalone Arcode product.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN frontend.arcode.entry_points -->
- `ui/arcode/main.html`: external scripts `/ui/arcode/main.js?v=20260622a`; inline imports _none_.
- `ui/arcode/notebook-editor/index.html`: external scripts `/ui/arcode/notebook-editor/cells.js?v=20260620a`, `/ui/arcode/notebook-editor/core.js?v=20260620a`, `/ui/arcode/notebook-editor/execution.js?v=20260620a`, `/ui/arcode/notebook-editor/index.js?v=20260620a`, `/ui/arcode/notebook-editor/notebook-io.js?v=20260620a`, `/ui/arcode/notebook-editor/panels.js?v=20260620a`, `/ui/arcode/notebook-editor/shortcuts.js?v=20260620a`, `/ui/arcode/shared/editor_shared.js?v=20260620a`, `/ui/arcode/shared/zoom_bridge.js?v=20260614a`, `/ui/libs/monaco-editor/min/vs/loader.js`; inline imports _none_.
- `ui/arcode/code-editor/index.html`: external scripts `/ui/arcode/code-editor/index.js?v=20260621b`, `/ui/arcode/shared/editor_shared.js?v=20260620a`, `/ui/arcode/shared/zoom_bridge.js?v=20260614a`, `/ui/libs/monaco-editor/min/vs/loader.js`; inline imports _none_.

Detected `fetch(...)` targets in key JS files:
- `${window.location.origin}${path}`
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN frontend.arcode.key_files -->
- [`ui/arcode/main.html`](../../ui/arcode/main.html) - Arcode workspace app frame and menus.
- [`ui/arcode/main.js`](../../ui/arcode/main.js) - Arcode shell, tabs, explorer, file opening, and command routing.
- [`ui/arcode/main.css`](../../ui/arcode/main.css) - Arcode workspace and tab shell styling.
- [`ui/arcode/notebook-editor/index.html`](../../ui/arcode/notebook-editor/index.html) - Arcode notebook editor page layout.
- [`ui/arcode/notebook-editor/core.js`](../../ui/arcode/notebook-editor/core.js) - Notebook state, cell model, and command-mode helpers.
- [`ui/arcode/notebook-editor/cells.js`](../../ui/arcode/notebook-editor/cells.js) - Cell rendering, selection, markdown, and drag/drop behavior.
- [`ui/arcode/notebook-editor/execution.js`](../../ui/arcode/notebook-editor/execution.js) - Notebook cell execution, streaming output, and cancellation handling.
- [`ui/arcode/notebook-editor/shortcuts.js`](../../ui/arcode/notebook-editor/shortcuts.js) - Notebook keyboard shortcut parsing, customization, and persistence.
- [`ui/arcode/notebook-editor/panels.js`](../../ui/arcode/notebook-editor/panels.js) - Notebook sidebar, TOC, and variables panels.
- [`ui/arcode/notebook-editor/notebook-io.js`](../../ui/arcode/notebook-editor/notebook-io.js) - Notebook save/open and `.ipynb` import/export helpers.
- [`ui/arcode/code-editor/index.html`](../../ui/arcode/code-editor/index.html) - Plain code/text editor page layout.
- [`ui/arcode/code-editor/index.js`](../../ui/arcode/code-editor/index.js) - Plain text-file open/save, dirty state, Python run output, and output panel controls.
- [`ui/arcode/shared/editor_shared.js`](../../ui/arcode/shared/editor_shared.js) - Shared Arcode editor host bridge, path, tab message, revision, and scripting session helpers.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Loads as `/ui/arcode/main.html` in Electron app mode `ARCRHO_APP_MODE=arcode` or in a secondary Arcode window launched from ArcRho.
- Uses the same custom app-frame structure as ArcRho, including `win10-borders` and `win11-frame` body classes from the Electron Windows-version bridge.
- Hosts each open notebook as an isolated `ui/arcode/notebook-editor/` iframe with a tab-scoped scripting instance id.
- Hosts plain code/text files such as `.py`, `.r`, `.sql`, `.js`, `.ts`, `.json`, `.md`, `.txt`, `.css`, and `.html` as isolated `ui/arcode/code-editor/` iframes with Monaco syntax highlighting inside the shared Arcode workspace explorer layout.
- Routes `.ipynb` and `.arcnb` to the notebook editor, Snowflake-style `.sql` files whose name contains `snowflake` or ends in `.sf.sql` to the Snowflake SQL editor, and other supported script/text files to the code editor.
- Opens `.json` files in the code editor with Monaco JSON syntax highlighting and a Format command for valid JSON.
- Hosts Snowflake SQL files whose name contains `snowflake` or ends in `.sf.sql` in an isolated `ui/arcode/snowflake-console/` iframe with a Monaco SQL editor, connection status strip, Run/Test/Save controls, and a results grid.
- Shows recent files in the File > Recent Files submenu; the home content area does not duplicate the recent-file list.
- Shows home create cards grouped under Scripting, Data & Query, and Other; file-template cards create timestamped local files in the selected workspace folder, Snowflake files open in the Snowflake SQL editor, and the Terminal card opens a desktop terminal in the selected workspace folder through the Electron host bridge.
- Shows a resizable file explorer in the Arcode workspace sidebar on Home and generic code editor tabs, stores the preferred sidebar width, exposes a manual refresh button, and watches visible workspace folders through the Electron host so folder listings refresh automatically when files are created, renamed, deleted, or otherwise changed on disk.
- Shows file-location, file-path copy, and close actions in the tab context menu.
- Sends save/open/view commands to the active editor iframe using existing `arcode:scripting-*` messages and receives `arcode:update-active-tab-title`, `arcode:scripting-dirty`, and `arcode:status` responses.
- Uses the scripting HTTP API for execution, notebooks, preferences, variables in notebook panels, and object inspection. ArcRho extends the same service with macro endpoints for the main app only.
- Uses the shared `ui/ai-assistant/` widget through the Arcode adapter, which keeps `arcode:*` context, replacement, and `arcode_ai_assistant_*` UI storage separate from ArcRho. Plain SQL editor tabs and Snowflake SQL tabs answer ArcBot context requests and can apply accepted SQL Format Validation replacements to either the full document or the selected SQL range through `arcode:assistant-replace-text`.
- ArcRho shell scripting launch actions open the desktop Arcode window through `openArcodeWindow`; browser fallback opens `/ui/arcode/main.html` directly.
- Clear Cache & Reload stores a one-shot Arcode restore payload in the Electron host, clears Electron cache/storage, reloads the requesting Arcode window with a fresh timestamped UI URL, and restores the previously open Arcode tabs and active tab after boot.
- The Arcode shell uses the same 10px left/right workspace gutter, flush compact menu bar, flush unclipped status bar with native resize indicator, bordered main frame, and status-bar zoom slider styling as the ArcRho main shell.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Stores Arcode recent files, the last selected workspace folder, and the preferred file-explorer width in the local Arcode user settings JSON, `%APPDATA%\Arcode\user_settings.json`, with browser local storage used only as a non-Electron fallback.
- Stores Snowflake connection profiles in `%APPDATA%\Arcode\snowflake_connections.json`; if that file is missing, the app-server can seed `my_example_connection` from `E:\XWSpace\Snowflake Config.txt` when present.
- Leaves notebook cell persistence, output persistence, and notebook shortcut preferences inside the Arcode notebook-editor modules.
- Leaves plain code/text persistence, autosave, disk conflict checks, formatting, Python run output, output panel layout, and text-file dirty state inside the Arcode code-editor modules.
- Shares Arcode editor host bridge, path, tab message, revision comparison, and scripting session helpers through `ui/arcode/shared/editor_shared.js`.
- Uses Electron host dialogs for opening and saving files, parented to the requesting Arcode window.
- Standalone Arcode mode stores scripts under `Documents\Arcode\scripts` by default and uses `%APPDATA%\Arcode` for Arcode settings.
- Clear Cache & Reload preserves open tab paths and clean untitled tabs through the host one-shot restore payload because browser storage is intentionally cleared; dirty tabs still use the normal close confirmation before reload.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Change Arcode shell/tab behavior: update `ui/arcode/main.js` and this doc together.
2. Change notebook behavior: update `ui/arcode/notebook-editor/` modules and this doc together.
3. Change plain code editor behavior: update `ui/arcode/code-editor/` modules and this doc together.
4. Change shared editor bridge behavior: update `ui/arcode/shared/editor_shared.js`, both editor consumers when applicable, and this doc together.
5. Change Arcode assistant behavior: update the shared `ui/ai-assistant/` widget and the Arcode adapter together.
6. Change Electron launch behavior: update `electron/main.js`, `electron/preload.js`, package scripts, and architecture notes together.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Arcode is the source of truth for scripting UI; avoid adding new scripting UI behavior under `ui/scripting_console`.
- ArcRho macros depend on ArcRho-only scripting macro endpoints; keep those outside the standalone Arcode route surface.
- Standalone Arcode uses its own default backend port and slim server bundle so it can run beside ArcRho.
<!-- MANUAL:END -->

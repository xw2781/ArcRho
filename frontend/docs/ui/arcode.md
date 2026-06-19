# Frontend: Arcode

## Purpose
<!-- MANUAL:BEGIN -->
Canonical Arcode workspace for opening notebooks and code files in a dedicated tabbed coding app.
ArcRho embeds the Arcode launch path, and the same source can be packaged as the standalone Arcode product.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN frontend.arcode.entry_points -->
- `ui/arcode/main.html`: external scripts `/ui/arcode/main.js?v=20260616a`; inline imports _none_.
- `ui/arcode/scripting-console/index.html`: external scripts `/ui/arcode/scripting-console/cells.js`, `/ui/arcode/scripting-console/core.js`, `/ui/arcode/scripting-console/execution.js`, `/ui/arcode/scripting-console/index.js?v=20260614a`, `/ui/arcode/scripting-console/notebook-io.js`, `/ui/arcode/scripting-console/panels.js`, `/ui/arcode/scripting-console/shortcuts.js`, `/ui/arcode/shared/zoom_bridge.js?v=20260614a`, `/ui/libs/monaco-editor/min/vs/loader.js`; inline imports _none_.

Detected `fetch(...)` targets in key JS files:
- `${API_BASE}${path}`
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN frontend.arcode.key_files -->
- [`ui/arcode/main.html`](../../ui/arcode/main.html) - Arcode workspace app frame and menus.
- [`ui/arcode/main.js`](../../ui/arcode/main.js) - Arcode shell, tabs, explorer, file opening, and command routing.
- [`ui/arcode/main.css`](../../ui/arcode/main.css) - Arcode workspace and scripting-console styling.
- [`ui/arcode/scripting-console/index.html`](../../ui/arcode/scripting-console/index.html) - Arcode notebook/code editor page layout.
- [`ui/arcode/scripting-console/core.js`](../../ui/arcode/scripting-console/core.js) - Notebook state, cell model, and command-mode helpers.
- [`ui/arcode/scripting-console/cells.js`](../../ui/arcode/scripting-console/cells.js) - Cell rendering, selection, markdown, and drag/drop behavior.
- [`ui/arcode/scripting-console/execution.js`](../../ui/arcode/scripting-console/execution.js) - Code execution, streaming output, and cancellation handling.
- [`ui/arcode/scripting-console/shortcuts.js`](../../ui/arcode/scripting-console/shortcuts.js) - Keyboard shortcut parsing, customization, and persistence.
- [`ui/arcode/scripting-console/panels.js`](../../ui/arcode/scripting-console/panels.js) - Sidebar, TOC, variables, and API reference panels.
- [`ui/arcode/scripting-console/notebook-io.js`](../../ui/arcode/scripting-console/notebook-io.js) - Notebook save/open and `.ipynb` import/export helpers.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Loads as `/ui/arcode/main.html` in Electron app mode `ARCRHO_APP_MODE=arcode` or in a secondary Arcode window launched from ArcRho.
- Uses the same custom app-frame structure as ArcRho, including `win10-borders` and `win11-frame` body classes from the Electron Windows-version bridge.
- Hosts each open file as an isolated `ui/arcode/scripting-console/` iframe with a tab-scoped scripting instance id.
- Hosts Snowflake SQL files whose name contains `snowflake` or ends in `.sf.sql` in an isolated `ui/arcode/snowflake-console/` iframe with a Monaco SQL editor, connection status strip, Run/Test/Save controls, and a results grid.
- Shows recent files in the File > Recent Files submenu; the home content area does not duplicate the recent-file list.
- Shows home create cards for Python Script, Notebook, SQL Server, and Snowflake; each card creates a timestamped local file in the selected workspace folder, with Snowflake files opened in the Snowflake SQL editor.
- Sends scripting commands to the active iframe using `arcode:scripting-*` messages and receives `arcode:update-active-tab-title`, `arcode:scripting-dirty`, and `arcode:status` responses.
- Uses the scripting HTTP API for execution, variables, notebooks, preferences, and object inspection. ArcRho extends the same service with macro endpoints for the main app only.
- Uses the shared `ui/ai-assistant/` widget through the Arcode adapter, which keeps `arcode:*` notebook context messages and `arcode_ai_assistant_*` UI storage separate from ArcRho.
- ArcRho shell scripting launch actions open the desktop Arcode window through `openArcodeWindow`; browser fallback opens `/ui/arcode/main.html` directly.
- Clear Cache & Reload stores a one-shot Arcode restore payload in the Electron host, clears Electron cache/storage, reloads the requesting Arcode window with a fresh timestamped UI URL, and restores the previously open Arcode tabs and active tab after boot.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Stores Arcode recent files and the last selected workspace folder in the local Arcode user settings JSON, `%APPDATA%\Arcode\user_settings.json`, with browser local storage used only as a non-Electron fallback.
- Stores Snowflake connection profiles in `%APPDATA%\Arcode\snowflake_connections.json`; if that file is missing, the app-server can seed `my_example_connection` from `E:\XWSpace\Snowflake Config.txt` when present.
- Leaves notebook persistence, execution, autosave, disk conflict checks, and shortcut preferences inside the Arcode scripting-console modules.
- Uses Electron host dialogs for opening and saving files, parented to the requesting Arcode window.
- Standalone Arcode mode stores scripts under `Documents\Arcode\scripts` by default and uses `%APPDATA%\Arcode` for Arcode settings.
- Clear Cache & Reload preserves open tab paths and clean untitled tabs through the host one-shot restore payload because browser storage is intentionally cleared; dirty tabs still use the normal close confirmation before reload.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Change Arcode shell/tab behavior: update `ui/arcode/main.js` and this doc together.
2. Change notebook/editor behavior: update `ui/arcode/scripting-console/` modules and this doc together.
3. Change Arcode assistant behavior: update the shared `ui/ai-assistant/` widget and the Arcode adapter together.
4. Change Electron launch behavior: update `electron/main.js`, `electron/preload.js`, package scripts, and architecture notes together.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Arcode is the source of truth for scripting UI; avoid adding new scripting UI behavior under `ui/scripting_console`.
- ArcRho macros depend on ArcRho-only scripting macro endpoints; keep those outside the standalone Arcode route surface.
- Standalone Arcode uses its own default backend port and slim server bundle so it can run beside ArcRho.
<!-- MANUAL:END -->

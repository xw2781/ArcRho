# Frontend: Arcode

## Purpose
<!-- MANUAL:BEGIN -->
Canonical Arcode workspace for opening notebooks and code files in a dedicated tabbed coding app.
ArcRho embeds the Arcode launch path, and the same source can be packaged as the standalone Arcode product.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN frontend.arcode.entry_points -->
- `ui/arcode/main.html`: external scripts `/ui/arcode/main.js?v=20260817a`, `/ui/shared/services/color_theme.js?v=20260811a`; inline imports _none_.
- `ui/arcode/notebook-editor/index.html`: external scripts `/ui/arcode/notebook-editor/cells.js?v=20260726a`, `/ui/arcode/notebook-editor/core.js?v=20260816b`, `/ui/arcode/notebook-editor/execution.js?v=20260620a`, `/ui/arcode/notebook-editor/index.js?v=20260726a`, `/ui/arcode/notebook-editor/notebook-io.js?v=20260816b`, `/ui/arcode/notebook-editor/panels.js?v=20260620a`, `/ui/arcode/notebook-editor/shortcuts.js?v=20260620a`, `/ui/arcode/shared/editor_shared.js?v=20260620a`, `/ui/arcode/shared/zoom_bridge.js?v=20260614a`, `/ui/libs/monaco-editor/min/vs/loader.js`, `/ui/shared/services/color_theme.js?v=20260811a`; inline imports _none_.
- `ui/arcode/code-editor/index.html`: external scripts `/ui/arcode/code-editor/index.js?v=20260816c`, `/ui/arcode/shared/editor_shared.js?v=20260620a`, `/ui/arcode/shared/zoom_bridge.js?v=20260614a`, `/ui/libs/monaco-editor/min/vs/loader.js`, `/ui/shared/services/color_theme.js?v=20260811a`; inline imports _none_.

Detected `fetch(...)` targets in key JS files:
- `${API_BASE}${path}`
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
- [`ui/arcode/code-editor/index.js`](../../ui/arcode/code-editor/index.js) - Plain text-file open/save, parser-backed SQL formatting, Python run output, and output panel controls.
- [`ui/arcode/shared/sql_console.js`](../../ui/arcode/shared/sql_console.js) - Shared SQL console runtime: editor, connection picker, results grid, format, and ArcBot bridge.
- [`ui/arcode/shared/sql_console.css`](../../ui/arcode/shared/sql_console.css) - Shared SQL console toolbar, meta bar, editor, and results styling.
- [`ui/arcode/snowflake-console/index.html`](../../ui/arcode/snowflake-console/index.html) - Snowflake connection, formatting, and query toolbar layout.
- [`ui/arcode/snowflake-console/index.js`](../../ui/arcode/snowflake-console/index.js) - Snowflake engine descriptor for the shared SQL console.
- [`ui/arcode/sql-server-console/index.html`](../../ui/arcode/sql-server-console/index.html) - SQL Server toolbar, meta bar, and connection manager dialog layout.
- [`ui/arcode/sql-server-console/index.js`](../../ui/arcode/sql-server-console/index.js) - SQL Server engine descriptor for the shared SQL console.
- [`ui/arcode/sql-server-console/connections.js`](../../ui/arcode/sql-server-console/connections.js) - SQL Server connection profile add, edit, rename, default, and remove behavior.
- [`ui/arcode/shared/editor_shared.js`](../../ui/arcode/shared/editor_shared.js) - Shared Arcode editor host bridge, path, tab message, revision, and scripting session helpers.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Loads as `/ui/arcode/main.html` in Electron app mode `ARCRHO_APP_MODE=arcode` or in a secondary Arcode window launched from ArcRho.
- Packaged standalone mode uses `ui/arcode/splash.html` for startup branding. Its Windows executable, installer, uninstaller, and installer-header icons are generated during packaging from the canonical `icons/icon_wing_geo_v8.svg` asset.
- Uses the same custom app-frame structure as ArcRho, including `win10-borders` and `win11-frame` body classes from the Electron Windows-version bridge.
- Hosts each open notebook as an isolated `ui/arcode/notebook-editor/` iframe with a tab-scoped scripting instance id.
- Hosts plain code/text files such as `.py`, `.r`, `.sql`, `.js`, `.ts`, `.json`, `.md`, `.txt`, `.css`, and `.html` as isolated `ui/arcode/code-editor/` iframes with Monaco syntax highlighting inside the shared Arcode workspace explorer layout.
- Routes `.ipynb` and `.arcnb` to the notebook editor, Snowflake-style `.sql` files whose name contains `snowflake` or ends in `.sf.sql` to the Snowflake SQL console, SQL Server-style `.sql` files whose name contains `sql_server`, `sqlserver`, or `mssql` or ends in `.ms.sql` to the SQL Server console, and other supported script/text files to the code editor. A `.sql` file names its engine because the extension alone cannot; an unmarked `.sql` file stays in the plain code editor with Format only.
- Opens `.json` files in the code editor with Monaco JSON syntax highlighting and a Format command for valid JSON. For `.sql` files, the same command requests a parser-backed T-SQL preview, verifies the source is still current, and applies only a safe result through the editor undo stack.
- Hosts both SQL consoles on one shared runtime, `ui/arcode/shared/sql_console.js`: a Monaco SQL editor, a connection picker, a connection meta bar, Run/Test/Save/Format controls, and a results grid. Each console page supplies only an engine descriptor - its routes, its wording, and the profile fields its meta bar shows - so the editor, the stale-safe Format flow, and the ArcBot replacement contract exist once. Run and Test stay disabled until a connection is selected, and Format uses the shared parser-backed preview service with the console's own dialect.
- Hosts Snowflake files in an isolated `ui/arcode/snowflake-console/` iframe. Snowflake profiles are picked here, not edited here; the console reads them from the app server.
- Hosts SQL Server files in an isolated `ui/arcode/sql-server-console/` iframe, which adds a Connections command. Its dialog lists the saved profiles and adds, edits, renames, sets the default for, and removes them through the `/sqlserver/connections` routes. A profile holds a connection name, server, database, and authentication mode; queries run as the signed-in Windows account, so the dialog never asks for a credential and only Windows authentication is offered. Test runs a one-row identity query, and Run executes the batch and shows its first result set.
- Sends `arcode:sql-console-open-path` to a SQL console iframe when its tab loads with a file path, replacing the Snowflake-only message name.
- Shows recent files in the File > Recent Files submenu; the home content area does not duplicate the recent-file list.
- Shows home create cards grouped under Scripting, Data & Query, and Other; file-template cards create timestamped local files in the selected workspace folder, the Snowflake and SQL Server cards create files whose names route them to their console, and the Terminal card opens a desktop terminal in the selected workspace folder through the Electron host bridge.
- Shows a resizable file explorer in the Arcode workspace sidebar on Home and generic code editor tabs, stores the preferred sidebar width, exposes manual add-folder and refresh buttons, and watches visible workspace folders through the Electron host so folder listings refresh automatically when files are created, renamed, deleted, or otherwise changed on disk. The explorer header shows a generic "Workspace" title next to those actions; the workspace root row names the active folder, so the header title never duplicates it.
- Separates the explorer from the editor with a single hairline seam rather than a gutter: the resizer is the seam itself, widened only by an invisible grab lane, so an open editor's toolbar, output panel, and panel header all terminate against a visible left border. The notebook editor's side-panel handle uses the same seam.
- Manages the explorer workspace roots from the sidebar: the header add button runs the same folder picker as File > Add Workspace Folder, and each root row exposes a remove control that drops that root, its expansion state, and its cached listings from the explorer, promotes the next root to active when the removed one was active, and stops its folder watchers. Removing a root is an explorer-only action; it never deletes anything on disk and leaves open tabs from that folder untouched.
- Resolves folder and common file-type artwork through the shared `ui/shared/file-icons/` package, which is also consumed by the ArcRho File Explorer tab; the resolver, JSON mapping, and SVG assets in that package are the single source of truth for both surfaces. The standalone Arcode server mounts `ui/shared`, and its PyInstaller specification bundles that canonical shared root alongside the Arcode UI.
- Shows file-location, file-path copy, and close actions in the tab context menu.
- The View menu includes a Show/Hide AI Bot Icon action that controls the Arcode ArcBot launcher without clearing assistant history.
- Sends save/open/view commands to the active editor iframe using existing `arcode:scripting-*` messages and receives `arcode:update-active-tab-title`, `arcode:scripting-dirty`, and `arcode:status` responses.
- Uses the scripting HTTP API for execution, notebooks, preferences, variables in notebook panels, and object inspection. The plain Python editor has one full-file `Run` action (Ctrl+Enter): source with an `<arcrho-macro>` metadata block or top-level `run_macro(...)` entry point is sent to `/scripting/run-in-arcrho`, while other Python source runs in Arcode's local session. `Run Selection` and Ctrl+Shift+Enter remain local.
- Automatically routed ArcRho macros do not need to be registered in the Macro panel, but the ArcRho desktop app must be open. DFM macros use the active DFM's live context; UI-only/API scripts may run without a DFM and receive `active_dfm=None`. In the embedded Arcode window the full ArcRho server handles the request directly; standalone Arcode exposes the same same-origin route and proxies it to the verified ArcRho app, resolving the target through `ARCRHO_DESKTOP_APP_URL` when set and otherwise through the `arcrho_api` resolution chain (`ARCRHO_APP_URL`/`ARCRHO_HOST`/`ARCRHO_PORT` env, then the per-user `%APPDATA%\ArcRho\app_endpoint.json` discovery file, then the default `http://127.0.0.1:28765`).
- The standalone Arcode server bundle includes the first-party `arcrho_api` package and common scripting dependencies, so editor code can `import arcrho_api` and use the bridge without a separately installed Python interpreter or wheel.
- Uses the shared `ui/ai-assistant/` widget through the Arcode adapter, which keeps `arcode:*` context, replacement, and `arcode_ai_assistant_*` UI storage separate from ArcRho. Plain SQL editor tabs and SQL Server console tabs declare the T-SQL dialect and Snowflake tabs declare the Snowflake dialect when answering ArcBot context requests; accepted SQL Format Validation replacements still apply to either the full document or selected SQL range through the stale-safe `arcode:assistant-replace-text` contract.
- ArcRho shell scripting launch actions open the desktop Arcode window through `openArcodeWindow`; browser fallback opens `/ui/arcode/main.html` directly.
- Clear Cache & Reload stores a one-shot Arcode restore payload in the Electron host, clears Electron cache/storage, reloads the requesting Arcode window with a fresh timestamped UI URL, and restores the previously open Arcode tabs and active tab after boot.
- The Arcode shell uses the same 10px left/right workspace gutter, flush compact menu bar, flush unclipped status bar with native resize indicator, bordered main frame, and status-bar zoom slider styling as the ArcRho main shell.
- `ui/arcode/shared/chrome.css` owns the chrome tokens shared by the shell, code editor, notebook editor, and both SQL consoles: seam width and grab lane, surfaces, borders, text, accent and danger colors, control radius and height, toolbar and panel-header heights, and transition duration. Each document maps its local variables onto those tokens, and Dark overrides the tokens once instead of restyling each surface.
- Editor command strips carry actions only. The tab bar names the open file and the shell status bar reports state, so the code editor, notebook editor, and SQL consoles no longer repeat a file name or status label in their toolbars, and notebook messages post to the shell status bar instead of a toolbar label. Command buttons are flat until hover, with the tinted primary treatment reserved for Run, Run All, and dialog confirmations; disk-conflict banners and dialog footers keep framed buttons.
- Output panel actions belong to the panel header: Clear Output is an icon action beside the run timing in the code editor's Output header rather than a toolbar button.
- The code editor toolbar holds only editor commands: Run, Run Selection, Stop, Restart, and Format. Save and Save As stay in the File menu and on Ctrl+S and Ctrl+Shift+S, which reach the editor through the existing `arcode:scripting-save` and `arcode:scripting-save-as` messages; saving remains an explicit user action with no autosave.
- In Dark mode, Arcode shares ArcRho's raised titlebar-control surfaces, restrained accent hover for minimize/maximize, danger hover for close, foreground-following SVG icon strokes, and a Home card hover/focus border with a subtle lift.
- Settings > Color Theme exposes the same Light, Dark, and High Contrast choices as ArcRho; the Arcode topbar has no separate theme-toggle icon. High Contrast keeps the Light palette and changes spreadsheet-framework fonts to pure black. The shared theme service applies the selected palette immediately, relays it to existing notebook/code/SQL console iframes, updates Monaco globally with `vs` or `vs-dark`, and synchronizes other same-origin ArcRho/Arcode windows without reloading editor state. Electron mirrors the renderer-computed background only as a startup paint hint so the next splash and hidden window pre-paint match the selected palette.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Stores Arcode recent files, the last selected workspace folder, and the preferred file-explorer width in the local Arcode user settings JSON, `%APPDATA%\Arcode\user_settings.json`, with browser local storage used only as a non-Electron fallback.
- Uses the shared browser-owned `arcrho_color_theme` key for frontend color theme selection so ArcRho and Arcode have one preference source rather than competing app-specific copies. The value is restricted to `light`, `dark`, or `high-contrast`, defaults to Light, and is intentionally cleared by Clear Cache & Reload.
- Stores Snowflake connection profiles in `%APPDATA%\Arcode\snowflake_connections.json`; if that file is missing, the app-server can seed `my_example_connection` from `E:\XWSpace\Snowflake Config.txt` when present.
- Stores SQL Server connection profiles in `%APPDATA%\Arcode\sql_server_connections.json` (the ArcRho per-user config folder in embedded mode), owned by `app_server/services/sql_server_service.py`. The file holds a name, server, database, authentication mode, and which profile is the default - never a credential. It is per user and unrelated to the ArcRho Server's shared server/database history that Project Settings Source Data records.
- Leaves notebook cell persistence, output persistence, and notebook shortcut preferences inside the Arcode notebook-editor modules.
- Saved code and notebook files are written only through explicit Save actions; dirty state and close confirmation remain active between edits.
- Leaves plain code/text persistence, disk conflict checks, formatting, Python run output, output panel layout, and text-file dirty state inside the Arcode code-editor modules.
- Shares Arcode editor host bridge, path, tab message, revision comparison, and scripting session helpers through `ui/arcode/shared/editor_shared.js`.
- Uses Electron host dialogs for opening and saving files, parented to the requesting Arcode window.
- Standalone Arcode mode stores scripts under `Documents\Arcode\scripts` by default and uses `%APPDATA%\Arcode` for Arcode settings.
- Stores ArcBot launcher visibility per app through the shared assistant UI settings, with Arcode local storage as the browser fallback.
- ArcRho macro runs use live in-memory DFM state captured from the ArcRho window; Arcode does not persist a duplicate active-project or active-dataset context file.
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
7. Change Arcode theme behavior: update the shared theme service and Light/Dark/High Contrast stylesheets, then verify all three Monaco owners still resolve the shared initial theme and respond to live changes.
8. Change explorer file icons: update `ui/shared/file-icons/` and verify both the Arcode sidebar and ArcRho File Explorer fallbacks.
9. Change Arcode chrome (seams, toolbars, panel headers, command buttons): update the tokens in `ui/arcode/shared/chrome.css` and their Dark overrides in `ui/shared/styles/themes/dark.css`; do not reintroduce per-surface color literals in `main.css`, `code-editor.css`, `notebook-editor.css`, `shared/sql_console.css`, or `sql-server-console.css`.
10. Change SQL console behavior shared by both engines: update `ui/arcode/shared/sql_console.js` and `ui/arcode/shared/sql_console.css`, and verify both console pages.
11. Change SQL Server connection profiles: update `sql_server_service`, `ui/arcode/sql-server-console/connections.js`, the `sql_server` domain doc, and this doc together.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Arcode is the source of truth for scripting UI; avoid adding new scripting UI behavior under `ui/scripting_console`.
- Server-side scripting is split by domain: session/script execution stays in `app_server/services/scripting_service.py`, the macro engine (metadata, storage, task wrappers, source execution, ArcRho bridge) lives in `app_server/services/scripting_macro_service.py`, notebook persistence in `app_server/services/scripting_notebook_service.py`, and scripting/local-project preferences in `app_server/services/scripting_preferences_service.py`. The macro engine imports the shared cancellation/timeout toolkit from `scripting_service`; keep that toolkit single-sourced there.
- Standalone Arcode uses its own default backend port and slim server bundle so it can run beside ArcRho; its `/scripting/run-in-arcrho` route must remain a local-only proxy and must verify that the resolved ArcRho endpoint (default port 28765, or the per-user discovered fallback port) reports `app: arcrho` before forwarding source.
- Arbitrary third-party packages imported by scripts must be included in the frozen Arcode/ArcRho server bundles. The bridge makes the script's saved parent folder temporarily importable for sibling modules, but it does not install dependencies at runtime.
- A macro result is rejected when the captured DFM closes or its substantive live content changes during execution, so users must rerun against the new live state instead of applying a stale payload. Validation uses a stable canonical fingerprint: generated `last modified` metadata, object-key order, and dirty-status-only changes do not create false conflicts.
- A SQL Server console query is not read-only and runs with autocommit, so a statement can change any data the user's own Windows account may change. It also opens and closes its own connection per run, so temporary tables, `USE`, and session settings never carry over to the next Run.
- SQL Server support depends on `pyodbc` and a Microsoft ODBC driver being present in the runtime. Both are optional at packaging time; when either is missing, the console reports which one to install instead of failing to start.
- Source execution is limited to 120 seconds without a macro activity heartbeat. Long-running imports can extend that window by calling the injected `report_macro_activity()` helper while runaway source loops still time out. Maintained macros can use the injected `run_trusted_macro_call()` helper to suspend expensive per-line tracing only around trusted service code; those paths must call `check_macro_cancelled()` or report activity at cooperative checkpoints so cancellation and inactivity protection remain effective. No-op/inspection scripts return output without reapplying or dirtying an unchanged DFM, and an expired result review cannot apply later.
<!-- MANUAL:END -->

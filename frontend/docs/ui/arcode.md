# Frontend: Arcode

## Purpose
<!-- MANUAL:BEGIN -->
Canonical Arcode workspace for opening notebooks and code files in a dedicated tabbed coding app.
ArcRho embeds the Arcode launch path, and the same source can be packaged as the standalone Arcode product.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN frontend.arcode.entry_points -->
- `ui/arcode/main.html`: external scripts `/ui/arcode/main.js?v=20260731a`, `/ui/shared/services/color_theme.js?v=20260724a`; inline imports _none_.
- `ui/arcode/notebook-editor/index.html`: external scripts `/ui/arcode/notebook-editor/cells.js?v=20260726a`, `/ui/arcode/notebook-editor/core.js?v=20260726a`, `/ui/arcode/notebook-editor/execution.js?v=20260620a`, `/ui/arcode/notebook-editor/index.js?v=20260726a`, `/ui/arcode/notebook-editor/notebook-io.js?v=20260726a`, `/ui/arcode/notebook-editor/panels.js?v=20260620a`, `/ui/arcode/notebook-editor/shortcuts.js?v=20260620a`, `/ui/arcode/shared/editor_shared.js?v=20260620a`, `/ui/arcode/shared/zoom_bridge.js?v=20260614a`, `/ui/libs/monaco-editor/min/vs/loader.js`, `/ui/shared/services/color_theme.js?v=20260724a`; inline imports _none_.
- `ui/arcode/code-editor/index.html`: external scripts `/ui/arcode/code-editor/index.js?v=20260726b`, `/ui/arcode/shared/editor_shared.js?v=20260620a`, `/ui/arcode/shared/zoom_bridge.js?v=20260614a`, `/ui/libs/monaco-editor/min/vs/loader.js`, `/ui/shared/services/color_theme.js?v=20260724a`; inline imports _none_.

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
- [`ui/arcode/snowflake-console/index.html`](../../ui/arcode/snowflake-console/index.html) - Snowflake connection, formatting, and query toolbar layout.
- [`ui/arcode/snowflake-console/index.js`](../../ui/arcode/snowflake-console/index.js) - Snowflake editor context, parser-backed formatting, connection, and query behavior.
- [`ui/arcode/shared/editor_shared.js`](../../ui/arcode/shared/editor_shared.js) - Shared Arcode editor host bridge, path, tab message, revision, and scripting session helpers.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Loads as `/ui/arcode/main.html` in Electron app mode `ARCRHO_APP_MODE=arcode` or in a secondary Arcode window launched from ArcRho.
- Packaged standalone mode uses `ui/arcode/splash.html` for startup branding. Its Windows executable, installer, uninstaller, and installer-header icons are generated during packaging from the canonical `icons/icon_wing_geo_v8.svg` asset.
- Uses the same custom app-frame structure as ArcRho, including `win10-borders` and `win11-frame` body classes from the Electron Windows-version bridge.
- Hosts each open notebook as an isolated `ui/arcode/notebook-editor/` iframe with a tab-scoped scripting instance id.
- Hosts plain code/text files such as `.py`, `.r`, `.sql`, `.js`, `.ts`, `.json`, `.md`, `.txt`, `.css`, and `.html` as isolated `ui/arcode/code-editor/` iframes with Monaco syntax highlighting inside the shared Arcode workspace explorer layout.
- Routes `.ipynb` and `.arcnb` to the notebook editor, Snowflake-style `.sql` files whose name contains `snowflake` or ends in `.sf.sql` to the Snowflake SQL editor, and other supported script/text files to the code editor.
- Opens `.json` files in the code editor with Monaco JSON syntax highlighting and a Format command for valid JSON. For `.sql` files, the same command requests a parser-backed T-SQL preview, verifies the source is still current, and applies only a safe result through the editor undo stack.
- Hosts Snowflake SQL files whose name contains `snowflake` or ends in `.sf.sql` in an isolated `ui/arcode/snowflake-console/` iframe with a Monaco SQL editor, connection status strip, Run/Test/Save/Format controls, and a results grid. Snowflake Format uses the shared parser-backed preview service with the Snowflake dialect and refuses stale or unsafe replacements.
- Shows recent files in the File > Recent Files submenu; the home content area does not duplicate the recent-file list.
- Shows home create cards grouped under Scripting, Data & Query, and Other; file-template cards create timestamped local files in the selected workspace folder, Snowflake files open in the Snowflake SQL editor, and the Terminal card opens a desktop terminal in the selected workspace folder through the Electron host bridge.
- Shows a resizable file explorer in the Arcode workspace sidebar on Home and generic code editor tabs, stores the preferred sidebar width, exposes a manual refresh button, and watches visible workspace folders through the Electron host so folder listings refresh automatically when files are created, renamed, deleted, or otherwise changed on disk.
- Resolves folder and common file-type artwork through the shared `ui/shared/file-icons/` package, which is also consumed by the ArcRho File Explorer tab; the resolver, JSON mapping, and SVG assets in that package are the single source of truth for both surfaces. The standalone Arcode server mounts `ui/shared`, and its PyInstaller specification bundles that canonical shared root alongside the Arcode UI.
- Shows file-location, file-path copy, and close actions in the tab context menu.
- The View menu includes a Show/Hide AI Bot Icon action that controls the Arcode ArcBot launcher without clearing assistant history.
- Sends save/open/view commands to the active editor iframe using existing `arcode:scripting-*` messages and receives `arcode:update-active-tab-title`, `arcode:scripting-dirty`, and `arcode:status` responses.
- Uses the scripting HTTP API for execution, notebooks, preferences, variables in notebook panels, and object inspection. The plain Python editor has one full-file `Run` action (Ctrl+Enter): source with an `<arcrho-macro>` metadata block or top-level `run_macro(...)` entry point is sent to `/scripting/run-in-arcrho`, while other Python source runs in Arcode's local session. `Run Selection` and Ctrl+Shift+Enter remain local.
- Automatically routed ArcRho macros do not need to be registered in the Macro panel, but the ArcRho desktop app must be open. DFM macros use the active DFM's live context; UI-only/API scripts may run without a DFM and receive `active_dfm=None`. In the embedded Arcode window the full ArcRho server handles the request directly; standalone Arcode exposes the same same-origin route and proxies it to the verified ArcRho app, resolving the target through `ARCRHO_DESKTOP_APP_URL` when set and otherwise through the `arcrho_api` resolution chain (`ARCRHO_APP_URL`/`ARCRHO_HOST`/`ARCRHO_PORT` env, then the per-user `%APPDATA%\ArcRho\app_endpoint.json` discovery file, then the default `http://127.0.0.1:28765`).
- The standalone Arcode server bundle includes the first-party `arcrho_api` package and common scripting dependencies, so editor code can `import arcrho_api` and use the bridge without a separately installed Python interpreter or wheel.
- Uses the shared `ui/ai-assistant/` widget through the Arcode adapter, which keeps `arcode:*` context, replacement, and `arcode_ai_assistant_*` UI storage separate from ArcRho. Plain SQL editor tabs declare the T-SQL dialect and Snowflake tabs declare the Snowflake dialect when answering ArcBot context requests; accepted SQL Format Validation replacements still apply to either the full document or selected SQL range through the stale-safe `arcode:assistant-replace-text` contract.
- ArcRho shell scripting launch actions open the desktop Arcode window through `openArcodeWindow`; browser fallback opens `/ui/arcode/main.html` directly.
- Clear Cache & Reload stores a one-shot Arcode restore payload in the Electron host, clears Electron cache/storage, reloads the requesting Arcode window with a fresh timestamped UI URL, and restores the previously open Arcode tabs and active tab after boot.
- The Arcode shell uses the same 10px left/right workspace gutter, flush compact menu bar, flush unclipped status bar with native resize indicator, bordered main frame, and status-bar zoom slider styling as the ArcRho main shell.
- In Dark mode, Arcode shares ArcRho's raised titlebar-control surfaces, restrained accent hover for minimize/maximize, danger hover for close, foreground-following SVG icon strokes, and a Home card hover/focus border with a subtle lift.
- Settings > Color Theme exposes the same Light and Dark choices as ArcRho; the Arcode topbar has no separate theme-toggle icon. The shared theme service applies the selected palette immediately, relays it to existing notebook/code/Snowflake iframes, updates Monaco globally with `vs` or `vs-dark`, and synchronizes other same-origin ArcRho/Arcode windows without reloading editor state. Electron mirrors the renderer-computed background only as a startup paint hint so the next splash and hidden window pre-paint match the selected palette.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Stores Arcode recent files, the last selected workspace folder, and the preferred file-explorer width in the local Arcode user settings JSON, `%APPDATA%\Arcode\user_settings.json`, with browser local storage used only as a non-Electron fallback.
- Uses the shared browser-owned `arcrho_color_theme` key for frontend color theme selection so ArcRho and Arcode have one preference source rather than competing app-specific copies. The value is restricted to `light` or `dark`, defaults to Light, and is intentionally cleared by Clear Cache & Reload.
- Stores Snowflake connection profiles in `%APPDATA%\Arcode\snowflake_connections.json`; if that file is missing, the app-server can seed `my_example_connection` from `E:\XWSpace\Snowflake Config.txt` when present.
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
7. Change Arcode theme behavior: update the shared theme service and Light/Dark stylesheets, then verify all three Monaco owners still resolve the shared initial theme and respond to live changes.
8. Change explorer file icons: update `ui/shared/file-icons/` and verify both the Arcode sidebar and ArcRho File Explorer fallbacks.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Arcode is the source of truth for scripting UI; avoid adding new scripting UI behavior under `ui/scripting_console`.
- Server-side scripting is split by domain: session/script execution stays in `app_server/services/scripting_service.py`, the macro engine (metadata, storage, task wrappers, source execution, ArcRho bridge) lives in `app_server/services/scripting_macro_service.py`, notebook persistence in `app_server/services/scripting_notebook_service.py`, and scripting/local-project preferences in `app_server/services/scripting_preferences_service.py`. The macro engine imports the shared cancellation/timeout toolkit from `scripting_service`; keep that toolkit single-sourced there.
- Standalone Arcode uses its own default backend port and slim server bundle so it can run beside ArcRho; its `/scripting/run-in-arcrho` route must remain a local-only proxy and must verify that the resolved ArcRho endpoint (default port 28765, or the per-user discovered fallback port) reports `app: arcrho` before forwarding source.
- Arbitrary third-party packages imported by scripts must be included in the frozen Arcode/ArcRho server bundles. The bridge makes the script's saved parent folder temporarily importable for sibling modules, but it does not install dependencies at runtime.
- A macro result is rejected when the captured DFM closes or its substantive live content changes during execution, so users must rerun against the new live state instead of applying a stale payload. Validation uses a stable canonical fingerprint: generated `last modified` metadata, object-key order, and dirty-status-only changes do not create false conflicts.
- Source execution is limited to 120 seconds without a macro activity heartbeat. Long-running imports can extend that window by calling the injected `report_macro_activity()` helper while runaway source loops still time out. Maintained macros can use the injected `run_trusted_macro_call()` helper to suspend expensive per-line tracing only around trusted service code; those paths must call `check_macro_cancelled()` or report activity at cooperative checkpoints so cancellation and inactivity protection remain effective. No-op/inspection scripts return output without reapplying or dirtying an unchanged DFM, and an expired result review cannot apply later.
<!-- MANUAL:END -->

# Frontend: Scripting Console

## Purpose
<!-- MANUAL:BEGIN -->
Notebook-style scripting workspace for code, markdown, raw cells, execution output, and sidebar panels.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN frontend.scripting_console.entry_points -->
- `ui/scripting_console/scripting_console.html`: external scripts `/ui/libs/monaco-editor/min/vs/loader.js`, `/ui/scripting_console/scripting_console.js?v=20260521a`, `/ui/scripting_console/scripting_console_cells.js`, `/ui/scripting_console/scripting_console_core.js`, `/ui/scripting_console/scripting_console_execution.js`, `/ui/scripting_console/scripting_console_notebook_io.js`, `/ui/scripting_console/scripting_console_panels.js`, `/ui/scripting_console/scripting_console_shortcuts.js`, `/ui/shared/zoom_bridge.js?v=20260521a`; inline imports _none_.

Detected `fetch(...)` targets in key JS files:
- `${API_BASE}${path}`

Detected `arcrho:*` message types in key JS files:
- `arcrho:assistant-context-result`
- `arcrho:hotkey`
- `arcrho:scripting-dirty`
- `arcrho:status`
- `arcrho:update-active-tab-title`
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN frontend.scripting_console.key_files -->
- [`ui/scripting_console/scripting_console.html`](../../ui/scripting_console/scripting_console.html) - Notebook-style scripting console page layout.
- [`ui/scripting_console/scripting_console.js`](../../ui/scripting_console/scripting_console.js) - Scripting console bootstrap and shell integration.
- [`ui/scripting_console/scripting_console_core.js`](../../ui/scripting_console/scripting_console_core.js) - Notebook state, cell model, and command-mode helpers.
- [`ui/scripting_console/scripting_console_cells.js`](../../ui/scripting_console/scripting_console_cells.js) - Cell rendering, selection, markdown, and drag/drop behavior.
- [`ui/scripting_console/scripting_console_execution.js`](../../ui/scripting_console/scripting_console_execution.js) - Code execution, streaming output, and cancellation handling.
- [`ui/scripting_console/scripting_console_shortcuts.js`](../../ui/scripting_console/scripting_console_shortcuts.js) - Keyboard shortcut parsing, customization, and persistence.
- [`ui/scripting_console/scripting_console_panels.js`](../../ui/scripting_console/scripting_console_panels.js) - Sidebar, TOC, variables, and API reference panels.
- [`ui/scripting_console/scripting_console_notebook_io.js`](../../ui/scripting_console/scripting_console_notebook_io.js) - Notebook save/open and `.ipynb` import/export helpers.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Called from shell as a legacy scripting tab iframe and from Arcode as one iframe per open code/notebook tab.
- Uses `/scripting/*` app-server routes for execution, variables, preferences, and notebook persistence.
- In the desktop app, File > Open Notebook (Ctrl+O) uses the Electron host file picker and can load `.ipynb`, legacy `.arcnb`, or `.py` scripting files from any folder. Browser sessions fall back to the in-app saved-notebooks list under the scripting directory.
- Python scripts load as a single editable code cell. Desktop file-backed scripts save back to the original `.py` path through the host text-file bridge; scripts opened through the app-server fallback are loaded from `Documents\ArcRho\scripts`.
- The shell Macro window opens user macros from `Documents\ArcRho\scripts` in fresh scripting tabs for editing, using the app-server scripting loader when the desktop file bridge is unavailable. The Macro splitter context menu can also delete selected user-created macros from this folder after confirmation.
- In the desktop app, scripting tabs also accept shell-forwarded `arcrho:scripting-open-path` messages created by File Explorer drops and load the provided `.ipynb`, `.arcnb`, or `.py` path through the same disk-backed open flow.
- The notebook toolbar is rendered inside the main notebook column above the cells pane, so it stays the same width as the cell workspace when the sidebar is visible. The notebook title lives in the shell tab only; right-clicking a scripting tab exposes `Rename Notebook`, `Open File Location`, and `Copy File Path` when a saved file path is available. Rename changes the active file in place for desktop file-backed notebooks or changes the pending filename for unsaved notebooks, and saved scripting tabs show their full path in a styled shell tooltip after a two-second still tab/titlebar hover.
- Imported `.ipynb` outputs render saved `image/png` plots and sanitized `text/html` rich display data, so notebook plots and HTML tables appear in the output area instead of being reported as unsupported rich output.
- File-backed notebooks track a disk revision token. Clean tabs auto-reload external disk edits, dirty tabs pause autosave and show a conflict banner with Reload, Save Copy, and Overwrite actions.
- Responds to ArcBot active-context requests with the current notebook path, dirty/file state, autosave state, and JSON-backed notebook payload so ArcBot can use the active scripting tab as default app context.
- Sends `arcrho:*` status and command messages to/from the shell.
- In Arcode, those same `arcrho:*` title, dirty, status, command, and ArcBot context messages are consumed by the Arcode shell instead of the ArcRho shell.
- Imports the shared 20px `ui/shared/scrollbars.css` WebKit scrollbar treatment so notebook, output, sidebar, and dialog scroll areas match the Dataset/DFM scrollbar style.
- Code-cell output panes include a bottom-right resize handle for per-cell output height adjustments during the current notebook session.
- The sidebar contains Table of Contents and Variables panels. Clicking either panel header collapses or expands that section. The TOC header includes a persisted three-mode heading-number control: no numbers, numbers from the first heading, or numbers from the second heading while treating the first heading as an unnumbered notebook title. Visible heading numbers are mirrored into rendered markdown headings. The main vertical resize handle has an expanded pointer target without a wider visible rail, can be dragged to resize/collapse the sidebar, and can be double-clicked to collapse or expand it.
- TOC header jumps scroll only the notebook cell pane, preserving the containing shell and tab host scroll position.
- Code-cell editors expand to their full content height so long cells remain visible without an internal editor scrollbar.
- In code-cell edit mode, `Tab` indents and `Shift+Tab` outdents through Monaco. The scripting introspection tooltip uses `Ctrl+Shift+Space` so it does not block code outdent.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Stores per-tab draft notebook state with tab-scoped browser storage keys.
- Saves notebooks as `.ipynb` files under the user scripting directory by default; opened desktop files save back to their current disk path unless the user chooses Save Copy. Opened `.py` scripts save as plain UTF-8 text. Code-cell text outputs, imported `image/png` outputs, imported sanitized `text/html` outputs, and execution counts are persisted in the `.ipynb` `outputs`/`execution_count` fields and restored on open; unsupported rich outputs are preserved in saved JSON when present but shown as an unsupported-output note in the current UI.
- Tracks clean/dirty state against the last loaded or saved notebook snapshot and notifies the shell with the scripting tab instance so notebook tabs use the same dirty indicator and close confirmation as DFM tabs.
- In the desktop app, the last successfully opened or saved absolute `.ipynb` path is stored under user AppData and loaded automatically when a new scripting page starts without a tab-local draft or explicit dropped/opened path. The same AppData preference tracks up to five recent `.ipynb` files for the shell File > Recent ... submenu.
- Persists keyboard shortcut preferences under APPDATA with browser storage fallback, including command-mode cell actions such as clearing the current cell output.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Change notebook model or persistence: update core state, notebook I/O, app-server scripting routes if needed, and docs together.
2. Change cell behavior or shortcuts: update cells/core/shortcuts modules and verify command/edit mode interactions.
3. Change sidebar or visual layout: update panels/cells/html together and keep INDEX.md as a short pointer only.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Keyboard handling is sensitive to edit mode, command mode, IME/composition, and Monaco focus.
- Multi-cell selection, queueing, markdown folding, and drag/drop share state and can regress each other.
- Long feature notes should stay in this module doc or release fragments, not in `docs/ui/INDEX.md`.
<!-- MANUAL:END -->

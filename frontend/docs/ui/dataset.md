# Frontend: Dataset

## Purpose
<!-- MANUAL:BEGIN -->
Dataset editing and analysis page used inside shell tabs.
It owns the Dataset workflow across Details, Data, Chart, Notes, and Audit Log views, with `Data` as the default tab.
The page validates Project Name, Reserving Class, and Dataset Type before running ArcRhoTri, renders/caches the resulting triangle data, and publishes status/history updates back to the shell.
Dataset Notes uses the shared notes editor behavior: detected file paths render as underlined links when not editing, known file extensions stop the path token before trailing prose, and right-clicking a rendered path opens a small menu with `Open File`, `Copy File Path`, and `Open as Read-Only` for Excel workbooks.
Implementation details should stay in the generated entrypoint/key-file sections or the focused behavior sections below, not in this overview.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN frontend.dataset.entry_points -->
- `ui/dataset/dataset_viewer.html`: external scripts _none_; inline imports `/ui/dataset/dataset_main.js?v=20260607b`, `/ui/dataset/dataset_shared.js?v=20260607a`.

Detected `fetch(...)` targets in key JS files:
- `${config.API_BASE}/dataset/${dsId}/patch`
- `${config.API_BASE}/dataset/${dsId}?start_year=${encodeURIComponent(startYear)}`
- `${config.API_BASE}/dataset/notes/load`
- `${config.API_BASE}/dataset/notes/save`
- `${config.API_BASE}/dataset/sidecar/load`
- `${config.API_BASE}/dataset/sidecar/save`
- `${config.API_BASE}/excel/active_selection`
- `${config.API_BASE}/excel/open_workbook`
- `${config.API_BASE}/excel/read_cell`
- `${config.API_BASE}/excel/read_cells_batch`
- `${config.API_BASE}/excel/wait_for_enter`
- `/arcrho/tri/precheck`

Detected `arcrho:*` message types in key JS files:
- `arcrho:browsing-history-updated`
- `arcrho:close-active-tab`
- `arcrho:close-shell-menus`
- `arcrho:dataset-close-confirmed`
- `arcrho:dataset-dirty`
- `arcrho:dataset-settings-changed`
- `arcrho:hotkey`
- `arcrho:status`
- `arcrho:update-active-tab-title`
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN frontend.dataset.key_files -->
- [`ui/dataset/dataset_viewer.html`](../../ui/dataset/dataset_viewer.html) - Dataset page HTML entrypoint.
- [`ui/dataset/dataset_main.js`](../../ui/dataset/dataset_main.js) - Dataset grid, calculations, and API calls.
- [`ui/dataset/dataset_shared.js`](../../ui/dataset/dataset_shared.js) - Shared dataset markup helpers.
- [`ui/dataset/dataset_shared.css`](../../ui/dataset/dataset_shared.css) - Shared dataset/DFM visual styles.
- [`ui/shared/api.js`](../../ui/shared/api.js) - Client wrappers for dataset endpoints.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Calls app-server dataset/arcrho endpoints plus valid-value list endpoints (`/dataset_types`, `/reserving_class_*`, `/arcrho/projects`).
- Uses `/project-user-preferences` to persist and restore the shared project-specific last Reserving Class path plus the Dataset Viewer Dataset Name in `projects/<project>/users/<windows-login>/preferences.json`.
- Sends status/hotkey/close signals to parent shell.
- Publishes dataset input updates and browsing-history updates to shell via `arcrho:dataset-settings-changed` and `arcrho:browsing-history-updated`.
- Publishes `arcrho:dataset-dirty` while saved sidecar settings or Notes have unsaved changes, then uses `arcrho:dataset-close-confirmed` after the user chooses Save or discard during close.
- Dataset/DFM shared styles import the reusable 20px `ui/shared/scrollbars.css` WebKit scrollbar treatment that is also used by shell and scripting pages.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Uses in-page mutable state for active dataset and selection.
- Reads and caches valid value lists via `valid_value_list_provider.js` for:
  - project names from project map
  - dataset names by project
  - reserving class paths by project
- Reserving-class path normalization preserves literal `/` characters inside a class name; only `\` is treated as the segment delimiter for validation/history keys.
- Dataset-side reserving path list loading does not auto-crawl `/reserving_class_path_tree/children`; child-path hydration is opt-in to avoid background request storms.
- Caches reserving-class type names from `/reserving_class_types` and validates input paths by segment membership in the Name column.
- Reserving-class tree view toggle preferences (auto-expand/auto-close/double-click), picker window sizing/favorite paths, favorite nicknames, favorite folders, and hidden path list are stored per project/user in `projects/<project>/users/<windows-login>/preferences.json`. The favorite path context menu can rename a favorite or revert a custom nickname back to the original raw path label.
- Reserving-class tree favorites appear in a collapsible `Favorite` section above the collapsible `All Paths` tree. New favorite rows display the full raw path until renamed; after rename, only the custom favorite name is shown. Favorite rows include the same value-type icon and level label treatment as source rows plus a slashed-star remove button. When no favorites exist, the empty state instructs users to click the star beside an All Paths entry. Selecting a favorite applies its raw path to the Reserving Class input and follows the same single-click or double-click selection preference as source tree paths. Right-click actions can rename inline, remove from Favorite, or reveal the favorite in the source tree. The Favorite section supports custom folders: users can add folders from the section header, delete or rename folders inline from the folder context menu, and drag favorite rows into a folder or back to the root Favorite list.
- Reserving-class tree hide removes the hidden node in place with a short collapse animation instead of rebuilding the full tree. The tree toolbar includes an eye button next to the filter button, and the tree node right-click menu also includes `Hidden Paths...`; both open a small live-updating window listing hidden paths with multi-select `Unhide Selected` and `Unhide All` actions. Full tree refreshes, such as unhide actions, preserve the current tree scroll offset and expanded paths, then swap in the refreshed tree after it is laid out so the visible area remains stable instead of jumping back to the top or visibly flickering.
- Dataset Type picker preferences (`Double Click to Select`, `Close Window after Selection`) are also stored per project/user so they copy with project duplication.
- On project switch, current Reserving Class input is revalidated against the new project's reserving-class type names; valid paths are retained and invalid paths are cleared.
- When Origin Length changes, Development Length is automatically adjusted only if the current pair breaks the required relationship (`Origin Length >= Development Length` and `Origin Length = Development Length * integer`). Editing Development Length directly does not trigger this automatic rewrite.
- New standalone Dataset tabs read the last selected Project Name from `%APPDATA%\ArcRho\local_project_prefs.json` first, then load that project's `lastReservingClassPath` and `datasetViewer.datasetName` from `projects/<project>/users/<windows-login>/preferences.json` to restore the last Reserving Class and Dataset Name for that project. The project tree picker also reads the same local preference file and shows a blue virtual `Recent Projects` folder above the real project folders with the last three picker-selected project names.
- Stores the project-specific last Reserving Class under shared `lastReservingClassPath` and Dataset Name under `datasetViewer.datasetName`, then reuses them after a project is selected when no query/workflow values override the inputs.
- Workflow-embedded Dataset pages can bind Project and Reserving Class inputs to Global Control defaults, displaying `Default Project (<project>)` and `Default Path (<path>)` while resolving backend requests to the current default values.
- Persists last-viewed dataset inputs globally, including Cumulative, Transposed, and Development/Calendar mode, and restores them when opening a new Dataset tab.
- On Dataset page open, loads the base generated dataset sidecar `<DatasetName>.json` for the selected project/reserving-class/dataset and applies its saved `origin_length` and `development_length` before loading the triangle. If the saved lengths differ, the page disables the visual link toggle so both saved values are preserved.
- The Details tab contains a Project/Reserving Class frame above the Name/Dataset Type/Formula metadata frame, and the read-only Formula box expands vertically for wrapped formulas.
- Stores latest browsing history entries via `browsing_history.js` (project + reserving class + dataset).
- Rejects invalid typed values on change/Enter and blocks ArcRhoTri requests until all 3 inputs are valid.
- On Dataset page open, bypasses the browser-side header-label cache once and refreshes origin/development-or-calendar labels for the selected project, mode, and period lengths before the Data grid renders; normal dataset reloads also refresh labels before applying them to the model.
- `Clear Cache & Reload` clears the ArcRhoHeaders CSV caches for the currently selected Origin Length and Development Length, including development and calendar column-label variants, before refreshing those labels.
- Dataset grid cells support rectangular drag selection, copy, and Excel-style paste. The cell context menu shows `Copy value` and `Export data`; `Copy value` copies the selected rectangle as tab-separated text, or the top-left selected cell when multiple separate ranges are selected. Pasting tab-separated text writes into editable dataset cells from the active/top-left selected cell and marks those values for the normal CSV patch save path.
- The Data tab Transposed checkbox is a client-side display mode, matching Excel add-in behavior: it reuses the current ArcRhoTri CSV cache and flips rendered rows/columns, totals, chart data, and copied selections without sending a new data-engine request.
- ArcRhoTri generated dataset files are written under `projects/<project>/data/generated/<ReservingClassFolder>/<DatasetName>@<OriginLength>@<DevelopmentLength>@<cum|inc>@<dev|cal>.csv` with one base `<DatasetName>.json` sidecar that records the Windows login user in `user` and `modified_by`; project, reserving-class, and dataset file components use the shared reversible `_%XX_` filename escaping rule used by DFM, the app server, and Excel add-in request paths. For example, `/` becomes `_%2F_` before the dataset page checks or requests a CSV cache file.
- The Dataset page Save/Cancel row uses a reserved bottom frame across all Dataset tabs, matching the DFM page pattern so large Data tables scroll above the buttons instead of underneath them. Save writes the Details `Name` as the instance name, the selected Dataset Type, current Origin Length, Development Length, Cumulative, and Calendar values, and dirty Notes; Cancel or close opens a Dataset-owned confirmation box where the default Yes action discards unsaved changes, while Cancel or closing the box returns to the unsaved page. CSV filenames still distinguish cumulative, incremental, development-view, and calendar-view variants.
- Dataset Viewer query parameters accept explicit origin/development lengths, an initial tab, a Project Instance draft mode, an explicit `ds` cache id, and read-only/generated flags. Draft launches from Project Instance open on Details, honor the provided project, reserving-class path, dataset type, and lengths, but skip the initial auto-run so the user can manually generate the cached dataset instance. In draft mode, Details `Name` defaults to the selected Dataset Type but remains editable as an independent instance name. Dataset `Name` values must be unique within the selected reserving-class path; when the name already exists, the Details tab shows a floating warning tooltip beside the Name field and blocks Save and generation until the name changes. Read-only/generated launches disable manual CSV patch saves and reject grid paste edits.
- Right-clicking a Dataset page tab temporarily moves that live tab page into a draggable, resizable floating window inside the Dataset page, using the same shared tab pop-out behavior as DFM. The floated tab keeps its original controls, event handlers, and data state because the actual tab DOM is moved rather than cloned. Pop-out and dock use short fade/scale transitions. Floating titlebars support double-click maximize/restore and drag-from-maximized restore to the previous window size. Closing the floating window, right-clicking its titlebar, or right-clicking the grey popped tab button docks the tab back into the normal tab area. The Chart tab redraws after pop-out, dock, focus, and resize so the canvas fits the floating window.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Add a new app-server call: update fetch call and API wrappers.
2. Change table behavior: update `dataset_main.js` render + patch flow together.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Formula or patch changes can cause silent data drift.
- Endpoint mismatches break runtime flows without compile-time safety.
<!-- MANUAL:END -->

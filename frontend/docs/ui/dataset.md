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
- `ui/dataset/dataset_viewer.html`: external scripts _none_; inline imports `/ui/dataset/dataset_main.js?v=20260706e`, `/ui/dataset/dataset_shared.js?v=20260706a`.

Detected `fetch(...)` targets in key JS files:
- `${config.API_BASE}/dataset/${dsId}/patch`
- `${config.API_BASE}/dataset/${dsId}?start_year=${encodeURIComponent(startYear)}`
- `${config.API_BASE}/dataset/calculated/preview`
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
- `/arcrho/vec/precheck`

Detected `arcrho:*` message types in key JS files:
- `arcrho:browsing-history-updated`
- `arcrho:close-active-tab`
- `arcrho:close-shell-menus`
- `arcrho:dataset-close-confirm-request`
- `arcrho:dataset-dirty`
- `arcrho:dataset-settings-changed`
- `arcrho:dependency-source-cleared`
- `arcrho:dependency-source-preview`
- `arcrho:hotkey`
- `arcrho:project-instance-open-dependent-dataset`
- `arcrho:project-instance-refresh-datasets`
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
- Sends status/hotkey/close signals to parent shell, and consumes `arcrho:dataset-save` from shell or Project Instance hosts to run the same save flow as the Dataset Save button.
- Publishes dataset input updates and browsing-history updates to shell via `arcrho:dataset-settings-changed` and `arcrho:browsing-history-updated`.
- Publishes `arcrho:calculated-datasets-updated` after a save/run recalculates dependent datasets, and consumes the same shell-broadcast report from Dataset or DFM saves; open Dataset tabs/windows auto-reload when their current project, reserving class, and dataset name match an updated calculated output. Tabs with unsaved grid/settings/Notes edits show a status warning instead of reloading.
- Publishes `arcrho:dataset-dirty` while saved sidecar settings or Notes have unsaved changes, then uses `arcrho:dataset-close-confirmed` after the user chooses Save or discard during close.
- Dataset/DFM shared styles import the reusable 20px `ui/shared/scrollbars.css` WebKit scrollbar treatment that is also used by shell and scripting pages.
- In the Data tab, transposed datasets show totals as a single right-side `Total` column instead of repeating totals across a footer row under each origin column.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Uses in-page mutable state for active dataset and selection.
- Reads and caches valid value lists via `valid_value_list_provider.js` for:
  - project names from the project index
  - dataset names by project
  - reserving class paths by project
- Reserving-class path normalization preserves literal `/` characters inside a class name; only `\` is treated as the segment delimiter for validation/history keys.
- Dataset-side reserving path list loading does not auto-crawl `/reserving_class_path_tree/children`; child-path hydration is opt-in to avoid background request storms.
- Caches reserving-class type names from `/reserving_class_types` and validates input paths by segment membership in the Name column.
- Reserving-class tree view toggle preferences (auto-expand/auto-close), picker window sizing/favorite paths, favorite nicknames, favorite folders, and hidden path list are stored per project/user in `projects/<project>/users/<windows-login>/preferences.json`. Final reserving-class paths are always selected with a single click. The favorite path context menu can rename a favorite or revert a custom nickname back to the original raw path label.
- Reserving-class tree favorites appear in a collapsible `Favorite` section above the collapsible `All Paths` tree. New favorite rows display the full raw path until renamed; after rename, only the custom favorite name is shown. Favorite rows include the same value-type icon and level label treatment as source rows plus a slashed-star remove button. When no favorites exist, the empty state instructs users to click the star beside an All Paths entry. Selecting a favorite applies its raw path to the Reserving Class input with the same single-click behavior as source tree paths. Right-click actions can copy the raw path, rename inline, remove from Favorite, or reveal the favorite in the source tree. The Favorite section supports custom folders: users can add folders from the section header, delete or rename folders inline from the folder context menu, and drag favorite rows into a folder or back to the root Favorite list.
- Reserving-class tree hide removes the hidden node in place with a short collapse animation instead of rebuilding the full tree. The tree toolbar includes an eye button next to the filter button, and the tree node right-click menu also includes `Hidden Paths...`; both open a small live-updating window listing hidden paths with multi-select `Unhide Selected` and `Unhide All` actions. Full tree refreshes, such as unhide actions, preserve the current tree scroll offset and expanded paths, then swap in the refreshed tree after it is laid out so the visible area remains stable instead of jumping back to the top or visibly flickering.
- Dataset Type picker preferences (`Double Click to Select`, `Close Window after Selection`) are also stored per project/user so they copy with project duplication.
- On project switch, current Reserving Class input is revalidated against the new project's reserving-class type names; valid paths are retained and invalid paths are cleared.
- Origin Length and Development Length are independent controls. When either length changes, the other length is adjusted only if the current pair breaks the required relationship (`Origin Length >= Development Length` and `Origin Length = Development Length * integer`).
- New standalone Dataset tabs read the last selected Project Name from `%APPDATA%\ArcRho\local_project_prefs.json` first, then load that project's `lastReservingClassPath` and `datasetViewer.datasetName` from `projects/<project>/users/<windows-login>/preferences.json` to restore the last Reserving Class and Dataset Name for that project. The project tree picker also reads the same local preference file and shows a blue virtual `Recent Projects` folder above the real project folders with the last three picker-selected project names.
- Stores the project-specific last Reserving Class under shared `lastReservingClassPath` and Dataset Name under `datasetViewer.datasetName`, then reuses them after a project is selected when no query/workflow values override the inputs.
- Workflow-embedded Dataset pages can bind Project and Reserving Class inputs to Global Control defaults, displaying `Default Project (<project>)` and `Default Path (<path>)` while resolving backend requests to the current default values.
- Persists last-viewed dataset inputs globally, including Cumulative, Transposed, and Development/Calendar mode, and restores them when opening a new Dataset tab.
- On Dataset page open, loads the base generated dataset sidecar `<DatasetName>.json` for the selected project/reserving-class/dataset and applies its saved `origin_length`, `development_length`, cumulative, transposed, calendar, `decimal_places`, and `number_format` Data-tab settings before loading the triangle.
- The Details tab contains a Project/Reserving Class frame above the aligned Name, Dataset Type, Formula, Precedents, and Dependents fields. Details inputs and graph boxes fill the available panel width and resize with the window. The Formula field renders recognized formula components as clickable dataset chips and formula operators as compact tokens using the same rich token style as the Reserving Class Type formula editor; empty Formula, Precedents, and Dependents boxes stay blank, with empty Formula shown as a compact grey one-line box. Component chips ask the Project Instance host to open the related dataset or, when the component is backed by a DFM, Result Selection, or Bornhuetter Ferguson method, the related method window for the same reserving-class path. The Precedents field is populated directly from the sidecar `Precedents` graph so it can show sources not present in the formula text; method-backed precedent chips open the related method window. The Dependents field is populated from the sidecar graph with matching dataset chips; hovering a precedent or dependent shows its formula with the same rich token formatting in an app-styled tooltip prefixed by an `=` token, and formula tooltips shrink to the widest wrapped row when the content hits the maximum width. Clicking a dependent dataset name opens that related dataset.
- Stores latest browsing history entries via `browsing_history.js` (project + reserving class + dataset).
- Rejects invalid typed values on change/Enter and blocks ArcRhoTri requests until all 3 inputs are valid.
- On Dataset page open, bypasses the browser-side header-label cache once and refreshes origin/development-or-calendar labels for the selected project, mode, and period lengths before the Data grid renders; normal dataset reloads also refresh labels before applying them to the model.
- `Clear Cache & Reload` clears the ArcRhoHeaders CSV caches for the currently selected Origin Length and Development Length, including development and calendar column-label variants, before refreshing those labels.
- The Data tab prevents invalid period-length combinations before refreshing a dataset triangle: Development Length cannot exceed Origin Length, so increasing Development Length above Origin Length automatically raises Origin Length to the same valid value; reducing Origin Length still lowers Development Length to a valid divisor when needed.
- Double-clicking the Data tab hides or shows the Data controls above the grid, letting the table use the extra vertical space without changing dataset settings or cached data.
- Dataset Type dependency validation and run/load actions use the matching route for the selected Data Format: Triangle rows check and load triangle caches, and Vector rows check and load ArcRhoVec period caches. Imported non-generated Vector datasets therefore open from their existing `<DatasetName>@<PeriodLength>.csv` cache instead of being blocked by the generated-triangle dependency guard or overwritten through the triangle route.
- Dataset grid cells support rectangular drag selection, copy, direct numeric entry, and Excel-style paste. Editable data cells render formatted display values until the user starts typing a number; the inline editor then opens only for the active/top-left selected cell, honors the active Dataset number format, and preserves the current grid column widths. Escape exits edit mode and restores the value and dirty-state entry from before that edit began. Clicking a cell only highlights/selects it, and Delete sets the selected editable range to `0`. Pasting tab-separated text into a cell input distributes values across the editable grid from that cell, while normal paste starts from the active/top-left selected cell. The grid uses native scrolling without idle row/column snapping, so wheel and trackpad scrolling can stop with partial cells visible; visible scrollbar tracks/corners use a light grey fill inside the table frame, and scrollbar thumbs brighten only while scrolling or when the pointer is over a scrollbar lane, then fade to a quieter idle state. The cell context menu shows `Copy value` and `Export data`; `Copy value` copies the selected rectangle as tab-separated text, or the top-left selected cell when multiple separate ranges are selected. Pasted and typed values mark editable manual input datasets dirty for the visible Dataset Save action, which writes the current grid to the length/mode-scoped CSV.
- The Data tab Transposed checkbox is a client-side display mode, matching Excel add-in behavior: it reuses the current ArcRhoTri CSV cache and flips rendered rows/columns, totals, chart data, and copied selections without sending a new data-engine request.
- ArcRhoTri dataset files are written under `projects/<project>/data/<ReservingClassFolder>/datasets/<DatasetName>@<OriginLength>@<DevelopmentLength>@<cum|inc>@<dev|cal>.csv`; ArcRhoVec cache files use `<DatasetName>@<PeriodLength>.csv`. Engine datasets share one base `sidecars/<DatasetName>.json` sidecar that records `source_kind: "engine"`, saved Data-tab settings including `transposed`, and the Windows login user in `user` and `modified_by`; vector sidecars store their single granularity as `period_length` instead of triangle-only origin/development mode fields. Project, reserving-class, and dataset file components use the shared reversible `_%XX_` filename escaping rule used by DFM, the app server, and Excel add-in request paths. For example, `/` becomes `_%2F_` before the dataset page checks or requests a CSV cache file.
- When the selected Dataset Name resolves to a manual input sidecar (`source_kind: "input"`), Dataset Viewer treats the Name as the cached instance identity rather than a Dataset Type to regenerate. It loads exact manual caches, can derive coarser period requests from finer cumulative caches, and reports a clear local-cache error instead of sending an engine request when a requested finer/detail shape cannot be derived from the available manual cache.
- The Dataset page Save/Cancel row uses a reserved bottom frame across all Dataset tabs, matching the DFM page pattern so large Data tables scroll above the buttons instead of underneath them. Save writes the Details `Name` as the instance name, the selected Dataset Type, current Origin Length, Development Length, Cumulative, Transposed, Calendar, Decimal Places, and Number Format values, and dirty Notes; for Project Instance non-generated drafts and existing manual input datasets, Save also writes the current Data grid values to the backing CSV and stores that file name in the sidecar. Cancel closes the Dataset window; when dirty, it first opens the same close confirmation where the default Yes action discards unsaved changes, while Cancel or closing the box returns to the unsaved page. When hosted by the shell, dirty close requests first use a compact shell-level floating confirmation so the prompt stays above shell pop-out tabs; the Dataset-owned in-frame box remains the fallback when no host answers. CSV filenames still distinguish cumulative, incremental, development-view, and calendar-view variants.
- While hosted in Project Instance, dirty manual Dataset grid values publish `arcrho:dependency-source-preview` messages with both latest-diagonal/vector values and full matrix values. Dirty DFM output vectors publish the same preview contract. Open dependent Result Selection windows use the vector values, while DFM input-triangle windows and matching Dataset Viewer windows can render the temporary in-memory table without marking themselves dirty. Project Instance also requests in-memory app-calculated previews for downstream calculated Dataset Types and publishes target-specific preview messages so open calculated Dataset windows, and Result Selection method sources that reference them, can update before the upstream source is saved. Save, Cancel, or close-without-save publishes `arcrho:dependency-source-cleared`, so dependents reload the source from persisted disk data.
- The Data tab Number Format field is editable and offers preset suggestions for `0,000`, `0.0%`, `0,000.00`, and `0`; changing it marks dataset settings dirty, immediately refreshes the grid/chart display, and persists as sidecar `number_format` on Save. Number Format and Decimal Places use the shared filled-caret dropdown/stepper arrow style, with muted arrows at rest and stronger arrows on hover, focus, or open. Decimal Places remains the source of truth for fractional digits, so changing Decimal Places rewrites the visible format pattern (for example, `0,000.00` becomes `0,000.0` when Decimal Places changes to `1`) and persists as sidecar `decimal_places`.
- The Audit Log tab renders the dataset sidecar `audit_log` entries newest first, with Event Date displayed as `M/D/YYYY h:mm:ss AM`. Dataset sidecar inserts, metadata saves, grid value patch saves, ArcRhoTri sidecar creation, and calculated dataset recalculation append records capped at 50 entries with `event_date`, `action`, `change_info`, and `user`; `change_info` is blank for `Insert` and `Values` for `Update`.
- When Dataset saves, grid patch saves, or ArcRhoTri refreshes trigger calculated-dataset updates, the Dataset page shows a compact modal report with the ordered recalculation chain, decoded reserving-class paths, and skipped/error details.
- Dataset Viewer query parameters accept explicit origin/development lengths, an initial tab, a Project Instance draft mode, an optional `data_format`, an explicit `ds` cache id, and a read-only flag. Draft launches from Project Instance open on Details, honor the provided project, reserving-class path, dataset type, data format, and lengths, but skip the initial auto-run and build an editable zero-filled Data-tab placeholder from the current project origin/development labels. Triangle drafts use the standard triangular mask, while Vector drafts use the server-matching one-column vector shape. Saving a draft persists the placeholder grid to the length/mode-scoped CSV, records the returned `ds_id`, and keeps later grid edits attached to that CSV-backed cache. Manual input Triangle/Vector datasets keep Cumulative and Development/Calendar mode locked; if any stored cell is non-zero, the Origin Length and Development Length controls cannot be lowered below the saved lengths until all cells are set to `0`. In draft mode, Details `Name` defaults to the selected Dataset Type but remains editable as an independent instance name. Draft Dataset `Name` values must be unique within the selected reserving-class path; when the name already exists, the Details tab shows a floating warning tooltip beside the Name field and blocks Save and generation until the name changes. Existing dataset launches do not show the draft duplicate-name warning for their own name. Read-only launches disable manual CSV patch saves and reject grid paste edits. Loaded sidecars are editable only when `source_kind: "input"`; other source kinds such as `engine`, `calculated`, `dfm`, `result_selection`, or `bornhuetter_ferguson` force the grid into read-only mode.
- Right-clicking a Dataset page tab temporarily moves that live tab page into a draggable, resizable floating window inside the Dataset page, using the same shared tab pop-out behavior as DFM. The floated tab keeps its original controls, event handlers, and data state because the actual tab DOM is moved rather than cloned. Pop-out and dock use short fade/scale transitions. Floating titlebars support double-click maximize/restore and drag-from-maximized restore to the previous window size. Closing the floating window, right-clicking its titlebar, or right-clicking the grey popped tab button docks the tab back into the normal tab area. The Chart tab redraws after pop-out, dock, focus, and resize so the canvas fits the floating window; in the normal docked tab, the chart panel also stretches with the tab area and redraws when that panel size changes.
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

# Frontend: Project Instance

## Purpose
<!-- MANUAL:BEGIN -->
Project instance workspace for browsing one project's reserving-class paths and dataset types.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN frontend.project_instance.entry_points -->
- `ui/project_instance/project_instance.html`: external scripts `/ui/project_instance/project_instance.js?v=20260607b`; inline imports _none_.

Detected `fetch(...)` targets in key JS files:
- `/datasets/cached/delete`
- `/reserving_class_combinations?project_name=${encodeURIComponent(projectName)}`
- `/reserving_class_filter_spec`
- `/reserving_class_filter_spec?project_name=${encodeURIComponent(projectName)}`
- `/reserving_class_hidden_paths`
- `/reserving_class_hidden_paths?project_name=${encodeURIComponent(projectName)}`
- `/reserving_class_types?project_name=${encodeURIComponent(projectName)}`

Detected `arcrho:*` message types in key JS files:
- `arcrho:dfm-request-state`
- `arcrho:dfm-tab-activated`
- `arcrho:project-instance-dfm-active-state`
- `arcrho:project-instance-dirty`
- `arcrho:project-instance-state`
- `arcrho:set-zoom`
- `arcrho:status`
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN frontend.project_instance.key_files -->
- [`ui/project_instance/project_instance.html`](../../ui/project_instance/project_instance.html) - Project instance tab layout.
- [`ui/project_instance/project_instance.js`](../../ui/project_instance/project_instance.js) - Project instance path selector, dataset table, and in-tab dataset viewer windows.
- [`ui/dataset/dataset_viewer.html`](../../ui/dataset/dataset_viewer.html) - Reused dataset viewer page for floating dataset windows.
- [`ui/dataset/dataset_types_source.js`](../../ui/dataset/dataset_types_source.js) - Shared dataset type payload loader and normalizer.
- [`ui/shared/reserving_class_lazy_picker.js`](../../ui/shared/reserving_class_lazy_picker.js) - Shared reserving-class lookup, filter, shortcut, and favorite-folder picker.
- [`ui/shared/path_tree_picker.js`](../../ui/shared/path_tree_picker.js) - Shared path tree body renderer used by the embedded reserving-class picker.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Opened by shell as a `project_instance` iframe tab after Project Settings posts `arcrho:open-project-instance`.
- Calls shared dataset-types and reserving-class picker helpers.
- Embeds the same lazy reserving-class picker body used by Dataset/DFM/Workflow, so the project instance left panel loads the same hierarchy, filters, hidden-path preferences, Shortcut section, favorites, and user-defined favorite folders.
- The embedded reserving-class path tree uses tight horizontal padding with a small left inset and does not reserve two-sided scrollbar gutters, so more path text fits in the left panel.
- Project instance loading shows one centered page-level loading card with the same blue sweep spinner style used by Dataset loading while the reserving-class path tree and dataset table load.
- Embeds the existing Dataset Viewer page in draggable in-tab windows.
- Double-clicking a dataset that already has an open or hidden floating window activates or restores the existing window instead of creating a duplicate for the same selected path and dataset.
- New floating dataset windows default to about 80% of the project-instance frame and reuse the most recent floating dataset window size for subsequent dataset windows in the same project instance page.
- Floating Dataset and DFM window titlebars highlight the active top window. Titlebars show only the dataset/DFM name when the window belongs to the currently selected reserving-class path, and fall back to the full reserving-class path plus dataset/DFM name when the left-panel selection moves to a different path; hovering the titlebar text does not show a native browser tooltip. Minimized toolbar tabs use the dataset name.
- Floating dataset window titlebars include shell-matching minimize, maximize/restore, and close icon buttons; minimize sends the window into the toolbar hidden-tab strip.
- Dataset viewer windows follow the shell's existing Windows 11 frame flag, using rounded frame corners on Windows 11 and square corners otherwise.
- Dataset viewer windows can be resized from all corners and edges, with the southeast handle using the same dotted resize glyph as the main shell and shell floating tabs.
- Double-clicking a floating dataset window titlebar toggles maximize/restore within the project-instance frame; dragging a maximized titlebar restores the prior size under the pointer before moving.
- Dataset viewer windows are clamped below the project-instance toolbar; they may be dragged partially off the left, right, or bottom edge as long as a side grab area and the titlebar remain reachable.
- `Ctrl+W` closes the active floating dataset window, including when keyboard focus is inside the embedded Dataset Viewer iframe or when the shell/Electron close-tab shortcut reaches the parent shell first; the project instance tab closes only when no floating dataset window can consume the shortcut.
- The toolbar includes a hidden-tab collection area to the right of the selected path; dragging a floating dataset window titlebar anywhere above the main project-instance layout highlights the dragged window, shows a release-to-minimize banner, and hides the window with a slower dock-style minimize animation that moves to its minimized toolbar tab. Hidden windows appear as large-radius minimized tabs on the toolbar that show dataset names only plus a styled hover tooltip with the full window title, and hovering or clicking the hidden-tabs button opens a wider content-fitting dropdown that lists full hidden window titles with a one-second hover grace period, per-item close controls, Resume all tabs, Close all tabs, and a matching restore animation that starts from the matching minimized tab.
- Dataset viewer windows add a transparent parent-page drag shield during move/resize so embedded iframes do not interrupt fast mouse movement.
- The project instance toolbar is compact, shows only the currently selected reserving-class path, omits the duplicate selected path above the tree, and sizes the path label to its content with a capped width so minimized toolbar tabs get the remaining space.
- The left and right panel title bars are omitted so the reserving-class tree and dataset table start directly below the toolbar.
- The dataset table has a compact transparent toolbar above the scroll area with an eye icon toggle for cached dataset view, and cached dataset view is active by default. The cached eye aligns with the table inset below, stays separate from normal table column filters, and is not represented as a table filter chip. When active, the page filters to dataset names with cached `.csv` files or `.json` metadata sidecars for the selected reserving-class path, and the cached dataset count in the toolbar reflects the currently visible cached dataset rows after matching to defined dataset types and applying table filters.
- Normal table column filters show compact active-filter chips in the dataset toolbar. Each chip displays the column label plus up to two selected values, such as `Method Type: DFM` or `Method Type: DFM, BF...`; hovering the chip shows the full selected value list in an app-styled tooltip. Clicking the `x` on the left side of a chip or right-clicking the chip clears that column's filter.
- The dataset table `Method Type` column reads method metadata from the selected reserving-class folder's cached `dataset_instance_index.json` `files` entries, matching rows by `dataset_name`; datasets missing from the cache display `None`.
- The dataset table `Last Modified`, `Created`, and `User` columns read from the selected reserving-class folder's cached `.csv`/`.json` file metadata. File timestamps come from the cached files on disk, and user values come from the sidecar `user`/`modified_by` Windows-login fields when present.
- Double-clicking a dataset table row whose `Method Type` is `DFM` opens a floating DFM window inside the Project Instance frame on its Ratios page, initialized with the current project, selected reserving-class path, and dataset name instead of opening the in-tab Dataset Viewer window or a main shell tab; it also records the selected DFM method/output name in project-user `dfmObject` preferences.
- Floating Dataset and DFM windows inside Project Instance follow the main shell corner convention: 4px by default and 8px when the page is running with the Windows 11 frame style.
- Floating DFM windows mirror standalone DFM save/dirty behavior: DFM dirty-state messages show a dirty dot on the floating titlebar and minimized tab, mark the containing Project Instance shell tab dirty while any floating DFM is dirty, closing a dirty DFM window asks for confirmation, and shell Save / Save As plus Ctrl+S / Ctrl+Shift+S route to the active floating DFM window.
- Floating DFM windows publish their active DFM state to the shell and forward standalone DFM commands, so shell Edit/Help menu actions, ratio hotkeys, DFM JSON opening, and macro context/apply requests target the active Project Instance DFM window the same way they target a standalone DFM tab.
- Project Instance publishes `arcrho:project-instance-state` snapshots to the shell when the selected path or nested floating Dataset/DFM windows change. The snapshot includes selected path, nested window kind/name/title, hidden/active/maximized/dirty flags, DFM subtab, and restore rectangles so Browsing History can restore Project Instance pages after Clear Cache & Reload.
- Project Instance watches the selected reserving-class `data/generated` and `data/manual` cache folders for signature changes while the page is open. The initial cached dataset table load shares its `/datasets/cached` response with the watcher baseline instead of starting a second folder scan for the same path. When disk changes add or remove unique cached instance names, it leaves the right-panel dataset table unchanged and shows a dataset-toolbar alert; clicking that alert reloads the Project Instance page. Content-only edits that keep the same instance names update the watch baseline without prompting.
- Right-clicking dataset table header cells opens a context menu with `Group by ...` choices for `Data Format` and `Category` plus a placeholder `Reset Columns` option; choosing grouping fields creates nested compact collapsible group headers inside the same table instead of rendering separate grouped tables. Top-level group headers show record counts as low-contrast circular badges, while subgroup headers omit counts. Every table header still supports per-column filter dropdowns, drag-to-reorder column labels, and drag-to-resize header edges; dragging a column shows a thin blue insertion line at the target location. Per-column filters match the Project Settings Dataset Types table: no checked values means the filter is not applied, checked values narrow results, and selecting all values is treated as unfiltered. Each filter dropdown includes `Clear All` to uncheck every value for that column. Resizing a column changes only that column and updates the total table width instead of redistributing space across other columns.
- Dataset table initial column widths are measured from the loaded header and cell contents, with each startup width capped at `460px` so a single long value cannot create an oversized column; manual resize can still expand a column beyond the startup cap.
- Right-clicking a dataset table group header opens `Collapse all` and `Expand all` actions for group headers at the same grouping level as the clicked header.
- Clicking a dataset table row keeps that exact row highlighted, including rows whose dataset names differ only by special characters. Clicking the only highlighted row again removes it from the selection, while clicking one row inside a multi-selection narrows selection to that row. `Ctrl`/`Cmd` click toggles individual rows, `Shift` click selects the visible range from the last anchor row, Up/Down arrow keys move a focused row selection to the previous or next visible dataset, and Enter opens the focused selected dataset. The app status bar shows the selected item count when more than one row is selected. Right-clicking a row opens a row menu that can view the right-clicked dataset or first highlighted dataset, shows an Add placeholder, and can delete cached files related to all highlighted datasets after a custom confirmation dialog.
- Dataset table renders precompute row cell values, filter option lists, and active filter selections once per render before grouping and sorting, keeping filter/group changes responsive on larger project dataset lists.
- Dataset table headers remain opaque while scrolling, so row contents do not show through sticky header cells.
- Dataset table body cells wrap long text and clamp display to two lines per cell, without row-hover fill or browser tooltips over row values.
- Clicking a dataset table column label sorts rows by that column, toggles ascending/descending order, and shows an up/down SVG sort indicator on the active sorted column.
- The left reserving-class panel defaults to 400px and has a draggable splitter constrained to 200px-600px; collapse/expand is animated, live drag updates are frame-throttled with transitions disabled for responsiveness, dragging the panel to 200px or smaller collapses it, and double-clicking the splitter toggles collapse/expand.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Uses the shell-persisted project name/folder/table path as tab inputs.
- Loads the project's last selected reserving-class path from project-user preferences when the tab opens; if no last path exists, it selects the first Shortcut item when available, otherwise leaving the path empty.
- Keeps the selected reserving-class path in page memory, saves user selections back to project-user preferences, and passes it into new floating Dataset Viewer and DFM windows. Opening a floating DFM window also updates the shared project-user DFM object defaults with the selected method/output name without waiting for the DFM method to be saved.
- Saves the right-panel dataset table layout in the same project-user preferences JSON under `projectInstance.datasetTable`, including column order, manual column widths, column filter selections, grouping fields, collapsed group rows, and sort state. Cleared/no-op filters are saved as empty arrays so stale saved filter values do not return after reload. The cached-dataset eye toggle is page-local and remains active by default instead of being saved as a normal table filter. When the current project/user has no saved `projectInstance` object yet, the preference API supplies the default `projectInstance` settings from the configured default preferences JSON before the page loads.
- Changing the selected reserving-class path refreshes the server-side `dataset_instance_index.json` lookup for logical cached dataset names, minimal table metadata, and method types for the new generated/manual folders while preserving existing table column filters and grouping.
- Method type lookup is derived from the same selected-path `dataset_instance_index.json` payload as cached dataset names and metadata, so Project Instance does not issue a second method-index request during path selection.
- Floating DFM window dirty state is tracked by DFM iframe `arcrho:dfm-dirty` messages keyed by the DFM `inst`; Project Instance sends aggregate `arcrho:project-instance-dirty` messages to the shell and consumes shell-level DFM save commands before forwarding them to the active floating DFM iframe.
- Floating DFM window active state is tracked by DFM iframe edit/history/tab messages and reported to the shell with `arcrho:project-instance-dfm-active-state`; Project Instance forwards `arcrho:assistant-context-request` and `arcrho:dfm-apply-method-payload` to the active nested DFM iframe so macros can use the same active-context contract for standalone and nested DFM pages.
- Project Instance consumes `arcrho:project-instance-restore-state` from the shell after the page boots. Restore selects the saved reserving-class path, recreates saved nested Dataset and DFM windows, reapplies window rectangles/maximized/hidden state, and raises the saved active visible window.
- Active-path disk-change detection compares the cached folder signature for the selected path at an interval, then compares the unique cached instance-name set before deciding whether page content is stale enough to prompt for reload.
- Left and right panels own their scroll areas so overflowing path trees and dataset tables scroll inside the project instance tab frame.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Change project instance launch behavior: update Project Settings sender and shell message/tab routing together.
2. Change dataset-window behavior: update `project_instance.js` while preserving the reused Dataset Viewer page contract.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Nested dataset iframes post messages to the project instance page before reaching the shell.
- Dataset viewer query parameters must remain compatible with normal top-level dataset tabs.
<!-- MANUAL:END -->

# Frontend: Project Settings

## Purpose
<!-- MANUAL:BEGIN -->
Project settings workspace (folders, mappings, dataset types, reserving class types).
Source Data tab derives origin/development date boundary inputs from table summary + field mapping.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN frontend.project_settings.entry_points -->
- `ui/project_settings/project_settings.html`: external scripts `/ui/project_settings/project_settings.js?v=20260521a`; inline imports _none_.

Detected `fetch(...)` targets in key JS files:
- `/arcrho/headers/cache/clear`
- `/field_mapping?project_name=${encodeURIComponent(name)}`
- `/general_settings`
- `/general_settings?project_name=${encodeURIComponent(name)}`
- `/project_settings/${DEFAULT_SOURCE}`
- `/project_settings/${DEFAULT_SOURCE}/create_project_folder`
- `/project_settings/${DEFAULT_SOURCE}/delete_project_folder`
- `/project_settings/${DEFAULT_SOURCE}/duplicate_project_folder`
- `/project_settings/${DEFAULT_SOURCE}/folders`
- `/project_settings/${DEFAULT_SOURCE}/generated_dataset_cache/clear`
- `/project_settings/${DEFAULT_SOURCE}/open_project_folder`
- `/project_settings/${DEFAULT_SOURCE}/rename_project_folder`
- `/project_settings/${sourceKey}`
- `/project_settings/${sourceKey}/folders`
- `/table_summary/refresh`
- `/table_summary?${q.toString()}`

Detected `arcrho:*` message types in key JS files:
- `arcrho:close-active-tab`
- `arcrho:close-shell-menus`
- `arcrho:hotkey`
- `arcrho:open-project`
- `arcrho:open-project-instance`
- `arcrho:project-settings-ribbon-changed`
- `arcrho:status`
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN frontend.project_settings.key_files -->
- [`ui/project_settings/project_settings.html`](../../ui/project_settings/project_settings.html) - Project settings workspace and panels.
- [`ui/project_settings/project_settings.js`](../../ui/project_settings/project_settings.js) - Project settings coordinator and API calls.
- [`ui/project_settings/project_settings_field_mapping.js`](../../ui/project_settings/project_settings_field_mapping.js) - Field mapping feature module.
- [`ui/project_settings/project_settings_dataset_types.js`](../../ui/project_settings/project_settings_dataset_types.js) - Dataset types feature module.
- [`ui/project_settings/project_settings_reserving_class_types.js`](../../ui/project_settings/project_settings_reserving_class_types.js) - Reserving class types feature module.
- [`ui/project_settings/project_settings_audit.js`](../../ui/project_settings/project_settings_audit.js) - Audit log UI helper.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Calls `/project_settings/*`, `/table_summary*`, `/field_mapping`, `/general_settings`, `/arcrho/headers/cache/clear`, and related endpoints.
- Uses `POST /project_settings/{source}/open_project_folder` from the detail header action to open the selected project's folder in the OS file explorer.
- Posts `arcrho:open-project-instance` when the project tree's `View project contents in a new tab` action is clicked for a project.
- Folder tree "Create New Project" action calls `POST /project_settings/{source}/create_project_folder` before saving the updated project index.
- Dataset Types pane persists changes through `POST /dataset_types` (debounced auto-save).
- Posts title/status events to shell.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Reads/writes the project registry through `projects/index.json`. Project rows use `Project Name` for the project folder/name, virtual folder placement is stored as each project's `folder` value, and source CSV paths are projected from each project's `field_mapping.json` `table_path`.
- Project tree rows reveal a red open-corner `View project contents in a new tab` icon button on row hover or keyboard focus, opening the selected project as a top-level project instance tab.
- Project tree folder expand/collapse state is saved in `%APPDATA%\ArcRho\local_project_prefs.json` under `projectExplorer.expandedFolders` and restored when Project Settings opens.
- `Project Settings` ribbon page includes an `Open Folder` action button with folder icon styling and disabled-state feedback while the request is in flight.
- Coordinates feature modules for mapping/type editors.
- Dataset Types row mutations (add/edit/delete) update in-memory state and schedule per-project debounced save.
- Dataset Types pane now reuses shared dataset-types helpers (`dataset_types_source.js`, `dataset_types_view_model.js`) for `/dataset_types` payload normalization, Name-search token/match semantics, `Data Format`/`Category`/`Calculated` filter option-building, shared filter label/key generation, and active-filter state checks, to stay aligned with the reusable dataset picker while preserving the existing Project Settings UI behavior.
- Field Mapping `Dataset Type` cells use a modern floating suggestion dropdown and typed entry; typing filters suggestions, deleting all text is allowed, empty input shows all available options, dropdown arrow click forces full-option view regardless of current text, any input text change re-applies filtering, the dropdown always opens below the active input, and only dataset types with empty `Formula` are available for selection.
- Field Mapping `Level` cells auto-fill when `Significances` changes to `Reserving Class` using `max(other Level values) + 1`; level cells also support mouse-wheel +/- integer adjustment with a minimum of `1`.
- After Field Mapping save succeeds, Project Settings automatically saves Dataset Types for the same project so `dataset_types.json` `Source` values are re-synced from rows where Field Mapping `Significance = Dataset` (`Field Name` mapped into each Dataset Type source chain).
- Dataset Types saves also refresh the persisted `Generated` flag in `dataset_types.json`/`dataset_types.xlsx`; the flag is `true` when all non-operator components of the saved `Source` are found in project `field_mapping.json` `field_name` values.
- Dataset Types formula saves update existing dataset sidecars with current formulas plus `Precedents`/`Dependents` graph metadata, then recalculate existing instances of changed calculated dataset types through their dependent chains. When a chain runs, Project Settings shows a compact refresh report listing recalculated dataset types, decoded reserving-class paths, and skipped reasons.
- Dataset Types editor blocks enabling `Calculated` when the dataset type name is already used by a field in Field Mapping for the same project.
- When the `Dataset Types` ribbon is active, shell `File` actions map to local export/import (`Save Dataset Types` / `Load Dataset Types`) using default folder `Documents\\ArcRho\\templates`; local load accepts both `.json` and `.xlsx` files.
- When the `Reserving Class Types` ribbon is active, shell `File` actions replace default Save/Save As with local export/import (`Save Reserving Class Types As...` / `Load Reserving Class Types From...`) using default folder `Documents\\ArcRho\\templates`; local load accepts both `.json` and `.xlsx` files and then schedules normal project auto-save.
- Local Dataset Types import uses an in-page custom dialog to choose merge vs overwrite (instead of browser `confirm`), except when imported rows are exactly identical to current UI rows (no prompt, no-op with status message). Merge keeps current behavior (update/add imported rows while preserving mapped-name rows). Overwrite removes existing rows not used by Field Mapping, then loads imported rows, and keeps mapped-name rows only when missing from imported content. For `.xlsx` local load, the app server converts workbook data to the same JSON payload structure before merge/overwrite is applied.
- Dataset Types save validation allows calculated formulas to save when their formula components are Dataset Type `Name` values, even if field-mapping source resolution is incomplete.
- Dataset Types table renders grouped by `Category`, supports Name-header keyword search (space-delimited terms) against the `Name` column, supports multi-select dropdown filtering on `Data Format`, `Category`, and `Calculated` headers (with `Calculated` options shown as `Yes`/`No`), and with no options selected a column filter is treated as not applied (all rows remain visible for that column), does not auto-resize column widths during filter changes, keeps header filter icons right-aligned near each column's right border, uses single-triangle sort indicators (`U+25B2`/`U+25BC`) in headers to match Reserving Class Types, allows per-column sort toggles that apply within each category group, and provides left-side subgroup header buttons to collapse/expand each category.
- Dataset Types error status shows an underlined `see more` action that opens a floating details window; details are formatted one error per line.
- Dataset Types table right-click menu includes `Copy` before `Edit`; `Copy` copies the clicked cell's displayed value to the clipboard, including `TRUE` / `FALSE` for the `Calculated` checkbox column, and uses compact row spacing like the reserving class types menu.
- Reserving Class Types save writes `reserving_class_types.json` and a same-folder mirror workbook `reserving_class_types.xlsx`.
- Reserving Class Types source-derived rows are now generated per `(Name, Level)` pair, so duplicate names across levels (for example `PA` at level 2 and level 3) appear in each corresponding level group.
- Reserving Class Types `Source` output always quotes each component separately (for example `"All States"` for one component, `"A" + "B"` for multi-component formulas), and quoted `Formula` / `EEX Formula` tokens remain atomic so operator auto-formatting does not insert spaces inside quoted names such as `"eSales - Teachers"` or `"Affinity/Referral Partners"`.
- Reserving Class Types formula validation is scoped to the row currently being edited: `Apply` checks only that row's `Formula` / `EEX Formula`, and project save/autosave still proceeds even if untouched legacy rows contain invalid references; formulas may reference any existing reserving class type name in the current table, including user-defined rows, but any referenced name containing `+`, `-`, `*`, or `/` must be wrapped in double quotes. When the edited row references a missing name or leaves an operator-bearing name unquoted, the editor shows a floating tooltip above the relevant formula input with a check-spacing/check-spelling hint instead of opening a separate popup window.
- Reserving Class Types editor shows a wider, resizable floating editor with auto-sizing Formula and EEX Formula frames that share the same review/edit token renderer and component drop handling; the EEX component tray starts hidden each time the editor opens. Each tray starts with selectable `+` and `-` operator chips styled like review-mode operators before available distinct names from the selected `Level`, uses light green for `+` and light yellow for `-` in both trays and formula review tokens, only one tray operator is active at a time per formula field, and the active operator remains selected for subsequent dragged/clicked components until the user chooses another operator or closes the editor. Calculated names with a non-empty Formula show the same stacked SVG marker used by the reserving-class picker, both formula fields have an edit mode for plain-text edits and a review mode that auto-fixes repeated/trailing operators before rendering, render known components as neutral no-fill pills, calculated components with the stacked SVG marker, unknown components with light red fill, and operators as larger SVG controls (`*` appears as `X`), components already present in the target formula are hidden from that field's tray, single-clicking a tray component appends it to the matching `Formula` or `EEX Formula` field while cleaning invalid adjacent operators and shows a short ghost-pill trajectory toward the formula review box, single-clicking a review-mode component pill removes that value with a short ghost-pill trajectory toward the matching component tray and rebalances operators, dragging a review-mode component pill outside its formula box also removes it, double-clicking either formula review box opens raw text editing, slash/dash-bearing names remain draggable/clickable as quoted tokens, component drags are blocked from dropping into non-matching editor fields, right-clicking either tray can replace the matching formula with either all selected-level components or only source-derived/imported components via `Select all Imported Items`, and `Escape` returns formula editing to review mode without closing the editor.
- Reserving Class Types table right-click menu includes `Copy` before `Edit`; `Copy` copies the exact displayed text from the clicked cell to the clipboard.
- Project Settings page imports the shared 20px `ui/shared/styles/scrollbars.css` WebKit scrollbar treatment used by Dataset/DFM, shell, and scripting pages.
- Project Settings right-click menus share a single `--project-settings-context-menu-font-size` control so project, folder, tree, Dataset Types, Reserving Class Types, and formula component context menus stay visually consistent.
- Dataset Types header auto-fit measures full header content (label plus sort/filter controls); all Dataset Types headers are kept single-line.
- Source Data date inputs are editable and saved per-project to `general_settings.json`.
- Source Data date inputs are normalized to plain integer strings (no commas, no trailing `.0`/`.00`) in UI and persisted JSON.
- Source Data date inputs display as `MMM YYYY` in UI, while persisted values remain canonical `YYYYMM`.
- Each Source Data date input has inline up/down month steppers to increment/decrement by one month.
- Single-click on `MMM` or `YYYY` highlights that segment; steppers and mouse wheel only adjust the highlighted segment (`MMM` = +/- month, `YYYY` = +/- year).
- Source Data date row uses compact label+input grouping so each label stays visually attached to its date control.
- `general_settings.json` stores `auto_generated`; derived writes set it `true`, user edits set it `false`.
- When `auto_generated` is `false`, table reload will not overwrite the 3 date values unless `project_name` in JSON mismatches the project folder name (stale duplicated settings).
- Source Data date inputs auto-derive from table summary + field mapping when values are missing, stale mismatch is detected, or reload is requested while `auto_generated=true`.
- Source Data table reload clears project-level `ArcRhoHeaders*.csv` cache files under the project `data` folder before refreshing table summary.
- Source Data table reload also clears generated dataset CSV caches under reserving-class `datasets` folders, preserving only CSVs whose `index.json` entry has `source_kind: input`; sidecars remain unchanged.
- Folder-node context menu supports `Create New Project`, prompts for a project name, creates an empty project folder with a `data` subfolder via the app server, then persists folder-tree mapping + blank project row with rollback on intermediate failures.
- Project creation, rename, and duplication keep the current project-index `mtime` in sync after intermediate folder-tree saves so the final project-row save does not trip the stale-file warning.
- Project creation creates `data`; project duplication shows a running progress indicator and copies the canonical `data` folder with all source project files.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Add settings source behavior: update source key logic + endpoint calls.
2. Update one feature pane: modify corresponding `project_settings_*` module.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Folder rename/duplicate/delete/create-project flows have rollback branches.
- Large settings payload edits can impact response timing.
- Reserving class type formula auto-formatting preserves quoted text verbatim; only operators outside quotes are normalized, so quoted names can safely contain `/`, `+`, `-`, `*`, `/`, and repeated spaces. Validation is strict for quoted components: the text inside `"..."` must match an existing reserving class type name exactly, including repeated spaces.
<!-- MANUAL:END -->



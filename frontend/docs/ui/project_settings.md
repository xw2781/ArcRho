# Frontend: Project Settings

## Purpose
<!-- MANUAL:BEGIN -->
Project settings workspace (folders, mappings, dataset types, reserving class types, and data-processing rules).
Source Data tab derives origin/development date boundary inputs from table summary + field mapping.
Source Data presents a quiet surface: file identity plus icon actions, one reserving-period band, and a column list whose detail lives in floating panels.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN frontend.project_settings.entry_points -->
- `ui/project_settings/project_settings.html`: external scripts `/ui/project_settings/project_settings.js?v=20260730split3`, `/ui/shared/services/color_theme.js?v=20260724a`; inline imports _none_.

Detected `fetch(...)` targets in key JS files:
- `/arcrho/headers/cache/clear`
- `/audit_log`
- `/audit_log?project_name=${encodeURIComponent(projectName)}&limit=2000`
- `/data_processing_rules`
- `/data_processing_rules/validate`
- `/data_processing_rules?project_name=${encodeURIComponent(name)}`
- `/dataset_types`
- `/dataset_types/import_local_file`
- `/field_mapping`
- `/field_mapping?project_name=${encodeURIComponent(name)}`
- `/field_mapping?project_name=${encodeURIComponent(projectName)}`
- `/field_mapping?project_name=${encoded}`
- `/general_settings`
- `/general_settings?project_name=${encodeURIComponent(name)}`
- `/project_settings/${DEFAULT_SOURCE}/generated_dataset_cache/clear`
- `/project_settings/${DEFAULT_SOURCE}/open_project_folder`
- `/project_settings/${defaultSource}`
- `/project_settings/${defaultSource}/${endpoint}`
- `/project_settings/${defaultSource}/folders`
- `/project_settings/${sourceKey}`
- `/project_settings/${sourceKey}/folders`
- `/reserving_class_types`
- `/reserving_class_types/import_local_file`
- `/reserving_class_types?project_name=${encodeURIComponent(projectName)}`
- `/reserving_class_types?project_name=${encoded}`
- `/reserving_class_values/refresh`
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
- [`ui/project_settings/project_settings.css`](../../ui/project_settings/project_settings.css) - Project settings shared shell and reusable feature styling.
- [`ui/project_settings/project_settings_summary.css`](../../ui/project_settings/project_settings_summary.css) - Source Data summary styling.
- [`ui/project_settings/project_settings_field_mapping.css`](../../ui/project_settings/project_settings_field_mapping.css) - Field Mapping styling.
- [`ui/project_settings/project_settings_dataset_types.css`](../../ui/project_settings/project_settings_dataset_types.css) - Dataset Types styling.
- [`ui/project_settings/project_settings_reserving_class_types.css`](../../ui/project_settings/project_settings_reserving_class_types.css) - Reserving Class Types styling.
- [`ui/project_settings/project_settings_data_processing_rules.css`](../../ui/project_settings/project_settings_data_processing_rules.css) - Data Processing Rules styling.
- [`ui/project_settings/project_settings.js`](../../ui/project_settings/project_settings.js) - Project settings coordinator and API calls.
- [`ui/project_settings/project_settings_project_map.js`](../../ui/project_settings/project_settings_project_map.js) - Project map document, folder structure, and tree data store.
- [`ui/project_settings/project_settings_tree_view.js`](../../ui/project_settings/project_settings_tree_view.js) - Project Explorer tree rendering, drag-and-drop, and view state.
- [`ui/project_settings/project_settings_project_ops.js`](../../ui/project_settings/project_settings_project_ops.js) - Project and virtual-folder create/rename/duplicate/delete flows.
- [`ui/project_settings/project_settings_general_settings.js`](../../ui/project_settings/project_settings_general_settings.js) - Boundary-month parsing and General Settings persistence.
- [`ui/project_settings/project_settings_table_columns.js`](../../ui/project_settings/project_settings_table_columns.js) - Shared table column sizing, resizing, and scroll activity.
- [`ui/project_settings/project_settings_source_data.js`](../../ui/project_settings/project_settings_source_data.js) - Source Data panel rendering and column distribution previews.
- [`ui/project_settings/project_settings_field_mapping.js`](../../ui/project_settings/project_settings_field_mapping.js) - Field mapping feature module.
- [`ui/project_settings/project_settings_dataset_types.js`](../../ui/project_settings/project_settings_dataset_types.js) - Dataset types feature module.
- [`ui/project_settings/project_settings_reserving_class_types.js`](../../ui/project_settings/project_settings_reserving_class_types.js) - Reserving class types feature module.
- [`ui/project_settings/project_settings_data_processing_rules.js`](../../ui/project_settings/project_settings_data_processing_rules.js) - Data-processing rule editor, validation, and persistence UI module.
- [`ui/project_settings/project_settings_audit.js`](../../ui/project_settings/project_settings_audit.js) - Audit log UI helper.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Calls `/project_settings/*`, `/table_summary*`, `/field_mapping`, `/general_settings`, `/arcrho/headers/cache/clear`, and related endpoints.
- Uses `POST /project_settings/{source}/open_project_folder` from the detail header action to open the selected project's folder in the OS file explorer.
- Posts `arcrho:open-project-instance` when the project tree's `View project contents in a new tab` action is clicked for a project.
- Folder tree "Create New Project" action calls `POST /project_settings/{source}/create_project_folder` before saving the updated project index.
- Dataset Types pane persists changes through `POST /dataset_types` (debounced auto-save).
- Data processing rules uses `GET /data_processing_rules`, `POST /data_processing_rules/validate`, and `POST /data_processing_rules` for project-scoped rule editing with optimistic revision checks.
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
- Reserving Class Types `Source` output always quotes each component separately (for example `"All States"` for one component, `"A" + "B"` for multi-component formulas), and quoted `Formula` tokens remain atomic so operator auto-formatting does not insert spaces inside quoted names such as `"eSales - Teachers"` or `"Affinity/Referral Partners"`.
- Reserving Class Types formula validation is scoped to the row currently being edited. `Apply` checks that row's normal `Formula`; formulas may reference any existing reserving class type name in the current table, but names containing `+`, `-`, `*`, or `/` must be wrapped in double quotes. The editor shows validation feedback next to the formula control.
- The Reserving Class Types editor has one Formula frame and component tray. Normal Formula `+`/`-` terms define signed base aggregation coefficients for every source measure. The retired `EEX Formula` column is ignored in legacy JSON so it cannot block Project Settings or dependent features; XLSX imports still require the explicit data-processing-rules migration.
- The Data processing rules ribbon page provides add/edit/duplicate/delete, enable/disable, drag reordering, server validation, and read-only JSON review. Rules use the standard resizable Project Settings table with Enabled, Name, Dataset type, Applies when, and Effect columns. Hovering a row reveals a compact grip at the left edge of its Enabled cell; dragging that grip above or below another rule saves the displayed order to `data_processing_rules.json`, while dragging elsewhere does not reorder it. The centered enabled switch does not shift when the overlaid grip appears and uses the same compact blue-active track as the rule editor. Right-clicking a row provides Edit, Duplicate, Enable/Disable, and Delete.
- The rule editor follows the approved `When` / `Then` sentence layout. `When` holds the single dataset type target plus requested-coverage conditions; each condition has a field, inline `Level n` badge, styled `is` / `is not` operator dropdown, and token list. One positive token saves as `equals`, several as `in`; one negative token saves as `not_equals`, several as `not_in`. `Then` uses a styled Keep only / Exclude dropdown over a unified condition list whose field control carries an inline `Level n` or `Raw field` badge. On save, the first positive values-list condition (preferring a reserving-class field) becomes `action.field`/`action.members` and remaining conditions become `row_conditions`, so the persisted v1 JSON schema remains unchanged. Loading a rule reverses that mapping.
- "Keep only" combined with extra row filters follows the engine mask `NOT(filter) OR member`: rows outside the filter pass through untouched, and both the editor hint and the effect summary state this. "Keep only" with more than one positive reserving-class values-list condition is rejected as ambiguous before save.
- Rule name is a labeled field at the top of the editor body, while the title bar keeps the window title, Enabled switch, and close action separate. Leaving the name blank freezes an auto-generated name at save time (dataset label + verb + members + requested-coverage values, for example `Earned premium - exclude BIR51, UMBIR51 for TOTAL PA`); the placeholder previews it live.
- Data processing rules saves use the loaded revision as `expected_revision`; stale editors reload the latest file after a `409` conflict. Server validation supplies source measures, raw fields, reserving-class fields/types, and dataset-aware source vocabularies. Then-clause suggestions narrow to complete mapped reserving-class combinations that occur for the selected dataset type and the other active conditions. Amber/red tokens and a nonblocking warning explain partial or currently absent source combinations; users may still type future values. `Validate all` refreshes those options after the source CSV or Field Mapping changes.
- Editing a data processing rule preserves the mapped reserving-class level for its action field, including when the same field name also appears in the generic source-field options, so name-only edits remain valid.
- Applying a data processing rule still validates the complete rules document before save. The editor groups failures into the current rule, other saved rules, and project-configuration errors so a failure elsewhere is not presented as though it belongs to the open rule; the full blocking result is also retained in the page status.
- The Data processing rules editor is a compact non-modal window inside the Project Settings page. Drag its title bar to reposition it (drags starting on the switch or buttons are ignored); movement and window resizes stay clamped to the page viewport, the body scrolls independently of fixed header/summary/action chrome, and the rule settings and condition rows reflow for narrow windows without overlapping. The `When` and `Then` chips stand alone without redundant `scope` or `action` captions.
- Data-processing rule field selectors and summaries preserve the exact Field Mapping field names, including capitalization and underscores such as `CO_CD`, `STATE_CD`, and `IBNRCAT`. Dataset selectors, rule-table labels, warnings, and editor summaries preserve the exact case and punctuation of the corresponding Project Settings Dataset Types table name while the saved rule continues using its source-measure key. Editor selects use trigger-aligned ArcRho listboxes with compact rows, selected checkmarks, restrained hover/focus states, viewport-aware placement, and Arrow/Home/End/Enter/Escape keyboard control instead of browser-native opened menus. Token suggestion menus use the same viewport-level placement so the editor's scrolling body, summary, and action bar do not clip them.
- Reserving Class Types table right-click menu includes `Copy` before `Edit`; `Copy` copies the exact displayed text from the clicked cell to the clipboard.
- Project Settings keeps one page-owned, PI-aligned WebKit scrollbar treatment for every scrollable surface, including the project tree, ribbon, tables, Source Data list and year picker, editor bodies, dropdown lists, dialogs, formula trays, and JSON review. Standard trays are 20px with 16px arrow buttons and 12px arrow glyphs. Tracks and corners use the themed pale tray, inset thumbs stay quiet until activity or hover, resizable surfaces retain a visible grip, and each standard tray shows one arrow at either end. The left project tree follows PI's side-panel exception: its 20px lane has a transparent track, corner, and thumb inset, no arrow buttons, and a thumb that strengthens only while scrolling or hovering the scrollbar lane or thumb.
- Project Settings table frames for Field Mapping, Reserving Class Types, Dataset Types, Data Processing Rules, and Audit Log use square continuous borders, 31px rows, opaque sticky headers, restrained row hover, and the same quiet activity-aware scrollbar treatment. The Source Data column list uses the same frame, header row, row rules, and scrollbar tray without being a `<table>`.
- Project Settings column resizing follows the Project Instance table pattern: every column has an explicit pixel width, dragging changes only the target column while the total table width grows or shrinks, widths remain stable across table rerenders, and double-clicking a resize handle restores that column's default width. Resize-handle clicks are contained so resizing a sortable table (including Reserving Class Types) does not toggle its sort. Source Data resizes `Column Name` and `Data Type` through CSS custom properties on its list frame; `Distribution` always absorbs the remaining width, so no dead space appears at any window size.
- Default widths for the resizable Project Settings tables are maintained in `app_server/default_preferences/project_settings_preferences.json`. The `summaryColumnsTable` entry keeps supplying the Source Data `Column Name` and `Data Type` defaults. Each table is keyed by its DOM table ID and each width by the visible column label; positive pixel values are applied when a project is selected and are also used by the resize handle's double-click reset. Reselect the project or reload Project Settings after editing the file. Missing tables, columns, invalid values, or a failed preference request fall back to the built-in table widths.
- Project Settings right-click menus share a single `--project-settings-context-menu-font-size` control so project, folder, tree, Dataset Types, Reserving Class Types, and formula component context menus stay visually consistent.
- Dataset Types header auto-fit measures full header content (label plus sort/filter controls); all Dataset Types headers are kept single-line.
- Source Data date inputs are editable and saved per-project to `general_settings.json`.
- Source Data date inputs are normalized to plain integer strings (no commas, no trailing `.0`/`.00`) in UI and persisted JSON.
- Source Data date inputs display as `MMM YYYY` in UI, while persisted values remain canonical `YYYYMM`.
- Each Source Data date input has a calendar action that opens one shared floating month picker aligned to the active input's left edge. Previous/next controls change the displayed year; clicking the year heading hides those arrows and opens a scrollable ascending year list from 50 years before the selected year through that selected year. Choosing a year restores the arrows and returns to the 12-month grid without committing until a month is selected. The picker remains open while the pointer is inside it. Selecting a month, clicking outside, or pressing Escape closes the picker.
- Direct typing remains available. Single-click on `MMM` or `YYYY` highlights that segment, and the mouse wheel adjusts only the highlighted segment (`MMM` = +/- month, `YYYY` = +/- year).
- Source Data date row uses compact label+input grouping with `Origin Period:` and `Development End:` labels. Each label and its input(s) sit in a wrap-atomic `sd-band-group`, so a narrow window wraps whole groups instead of separating a label from its input; groups are spaced by a 24px band `column-gap` rather than a label margin. The normal derived month-span text is suppressed, and an invalid origin range still reports that its start is after its end.
- Source Data shows the source file name without a decorative state dot, with a borderless circled-exclamation details icon immediately to its right. Loading and error feedback remains in the inline message area. Its responsive floating `Source Table` panel is up to 420px wide and shows the source folder with an inline copy action. The editable path input appears on click and commits on blur or Enter exactly as before. Reload, Browse, Copy path, and Open folder are grouped icon actions; the header Copy path action copies the full CSV path and Open folder uses the desktop host bridge.
- Row counts, column counts, file size, modified time, and cache freshness are no longer printed on the surface. The info icon opens a floating `Source Table` panel on hover and pins it on click; Escape or an outside click closes it.
- The Source Data column list shows `Column Name`, `Data Type`, and a `Distribution & Summary` column per row, plus an inline filter over column names and values. First-column row values and date-role labels use regular font weight, while the column header retains its header emphasis. Categorical columns render a proportional composition strip and numeric or date columns render a density area in a fixed-width mark lane, followed by an inline key-value summary: numeric and date columns show the raw `stats` min-max range, string and boolean columns show the distinct count plus the top value's share of filled rows, and other columns fall back to the `values` string. Numeric ranges use comma-grouped integers with no decimals unless the column's largest absolute bound is under 10 (then 4 decimals). Columns mapped as `Origin Date` or `Development Date` display data type `Date` (row and preview) and show their YYYYMM bounds as plain 6-digit integers without grouping. Null shares are not printed in the row cells; completeness and exact figures remain in the floating preview.
- The floating column preview opens only when a `Distribution & Summary` cell is clicked (no hover-open); it appears beside the click point with the distinct count or range, separate filled and null shares, the ranked values or histogram, and the sample values, and stays until Escape or a click outside the preview and its source cell closes it. Categorical previews render every ranked value as a bounded 0-100% meter whose blue fill and numeric label use the value's actual share of filled values. Numeric preview histogram bars sit in full-height hover cells that brighten on hover and expose the bar's bin range (from the distribution `edges`) as a tooltip, formatted with the same rules as the row summary. Enter or Space on a focused row opens the same preview anchored to the cell.
- `general_settings.json` stores `auto_generated`; derived writes set it `true`, user edits set it `false`.
- When `auto_generated` is `false`, table reload will not overwrite the 3 date values unless `project_name` in JSON mismatches the project folder name (stale duplicated settings).
- Source Data date inputs auto-derive from table summary + field mapping when values are missing, stale mismatch is detected, or reload is requested while `auto_generated=true`.
- Source Data table reload clears project-level `ArcRhoHeaders*.csv` cache files under the project `data` folder before refreshing table summary.
- Source Data table reload also clears generated dataset CSV caches under reserving-class `datasets` folders, preserving only CSVs whose canonical scalar `index.json` entry has `source_kind: input`; sidecars remain unchanged and each affected reserving-class index is rebuilt before the refresh completes.
- Folder-node context menu supports `Create New Project`, prompts for a project name, creates an empty project folder with a `data` subfolder via the app server, then persists folder-tree mapping + blank project row with rollback on intermediate failures.
- Project creation, rename, and duplication keep the current project-index `mtime` in sync after intermediate folder-tree saves so the final project-row save does not trip the stale-file warning.
- Project creation creates `data`; project duplication shows a running progress indicator and copies the canonical `data` folder with all source project files.
<!-- MANUAL:END -->

## Module Boundaries
<!-- MANUAL:BEGIN -->
`project_settings.js` is the page coordinator only: DOM lookups, feature composition, project selection, the Source Data table-summary load, dialogs, context menus, and the ribbon. Domain logic has one owner each:
- `project_settings_project_map.js` owns the project map document, its conflict-detection `mtime`, the derived folder/project tree, and every `/project_settings/{source}*` read and write. Conflict (`409`) and lock (`423`) handling lives here and nowhere else.
- `project_settings_tree_view.js` owns Project Explorer rendering, drag-and-drop, and view state only (expanded folders in session storage plus `local_project_prefs.json`, and the remembered selection snapshot).
- `project_settings_project_ops.js` owns project and virtual-folder create/rename/duplicate/delete, including the ordered write sequence (disk folder, then folder structure, then project map) and the reverse-order rollback when a later step fails.
- `project_settings_general_settings.js` owns boundary-month parsing (`YYYYMM` canonical form, `MMM YYYY` display, segment-aware stepping) plus the per-project General Settings cache and its `/general_settings` reads and writes.
- `project_settings_table_columns.js` owns the explicit-width column model shared by every Project Settings table: configured defaults, measurement, auto-fit, drag resizing, and the scroll-activity affordance.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Add settings source behavior: update source key logic + endpoint calls.
2. Update one feature pane: modify corresponding `project_settings_*` module.
3. Change how the project map is read or written: change `project_settings_project_map.js`; callers must go through its store API rather than calling the endpoints directly.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Folder rename/duplicate/delete/create-project flows have rollback branches.
- Large settings payload edits can impact response timing.
- Reserving class type formula auto-formatting preserves quoted text verbatim; only operators outside quotes are normalized, so quoted names can safely contain `/`, `+`, `-`, `*`, `/`, and repeated spaces. Validation is strict for quoted components: the text inside `"..."` must match an existing reserving class type name exactly, including repeated spaces.
<!-- MANUAL:END -->



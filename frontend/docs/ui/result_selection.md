# Frontend: Result Selection

## Purpose
<!-- MANUAL:BEGIN -->
Result Selection is a Project Instance method window for vector output datasets. It combines selected vector sources, and triangle sources through their latest diagonal values, into a row-level weighted selected ultimate vector.
<!-- MANUAL:END -->

## Entry Points
<!-- MANUAL:BEGIN -->
- [`ui/result_selection/result_selection.html`](../../ui/result_selection/result_selection.html) - Result Selection iframe page with Details, Method, Results, Validation, and Notes tabs.
- [`ui/result_selection/result_selection_main.js`](../../ui/result_selection/result_selection_main.js) - Result Selection state, dataset loading, grid calculation, persistence, and dirty-state wiring.
<!-- MANUAL:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Opens from Project Instance floating windows only in v1. The shell does not expose a standalone Result Selection tab.
- Project Instance creates a new Result Selection from `Add > Result Selection` on a vector dataset row whose Method Type is `None`; existing vector rows with Method Type `Result Selection` open this page for editing.
- The page posts generic nested-window dirty state through `arcrho:dataset-dirty`, consumes `arcrho:dataset-save`, and exposes `window.__arcrho_request_close` so Project Instance can ask before closing dirty windows; dirty close requests are handled by an in-page confirm dialog and then confirmed with `arcrho:dataset-close-confirmed`.
- Save writes `methods/RS@<ReservingClassFolder>@<Name>.json` using underscore JSON keys, writes the selected ultimate vector CSV under the reserving-class `datasets/` folder, saves a base dataset sidecar with `source_kind: "result_selection"` and `data_format: "Vector"`, and asks the Project Instance host to refresh the cached dataset table.
<!-- MANUAL:END -->

## Behavior
<!-- MANUAL:BEGIN -->
- Details contains Name, Output Type, an Origin Length selector limited to `12`, `6`, `3`, and `1`, one Ratio Basis selector, a Show Ratios as Percentages checkbox, and Statistic Decimal Places.
- Method is the main working tab. It displays one source-value column and one editable Weight column for each selected source dataset. `Show Weights` hides or shows Weight columns without changing the stored weights or calculation. `Toggle Weights Display` switches visible Weight cells between editable numeric weights and read-only effective row percentage weights.
- Method Weight edits synchronize source-cell calculation selection: entering `0` clears the paired source-value cell selection, and entering a positive weight selects it. Weight cells use grid-cell selection rather than a text-caret cursor; double-clicking a Weight cell toggles `0` to `1` and any non-zero weight to `0`. Editable Weight cells display one decimal place, with non-zero values blue and zero values muted gray. Highlighted Weight cell ranges accept typed numeric values, applying the typed value to every highlighted Weight cell. Pasting a tab/newline range into a Weight cell applies values across visible Weight columns and rows with the same selection sync.
- Method row labels use the same ArcRho origin-header lookup as the Dataset Data tab, keyed by the Details tab Origin Length; the grid uses DFM Ratios-style table font, fixed row, and cell sizing.
- Method row count follows the loaded origin labels for the selected Origin Length, so longer source vectors do not expand the Method grid beyond the selected annual, half-year, quarterly, or monthly header set.
- Method grid columns can be resized by dragging the right edge of each header; only the dragged column changes width while the total table width follows the column sum. Weight columns stay narrower than source-value columns but keep a minimum width that preserves the `Weight` header label, and source dataset headers wrap to at most two lines before truncating.
- Method source-value cells have two interaction states: double-click toggles a persisted pale-green selected state that gates whether the cell participates in `Selected Ultimate`, while single-click/drag creates a temporary highlight range across any Method grid columns. Clicking an origin-label cell toggles a full-row temporary highlight and clicking it again clears that row highlight. Highlighted selected source cells use stronger green, highlighted Weight cells use cyan, Selected Ultimate cells keep their yellow fill in both normal and highlighted states, and non-selected highlighted cells use blue; only the initial cell in a highlighted range shows the dashed border. Origin labels and dataset headers use normal weight at rest and become bold when their related row or column is highlighted. Right-clicking a highlighted range or pressing `Ctrl+C` copies tab-delimited visible values for Excel paste.
- Default sources are DFM output vectors from the same project, reserving-class path, and Category as the output vector. DFM input triangles and intermediate triangle records are not added by default.
- Users can manually add vector or triangle datasets from the same reserving-class path. Vector sources use their first CSV column; triangle sources use each row's latest available numeric diagonal value.
- `Selected Ultimate` is calculated per row as `sum(source_value * weight) / sum(weight)` over numeric source values with positive weights. If no positive weighted source values exist for a row, the selected ultimate is blank.
- When Ratio Basis is selected, the Method grid appends a ratio column after Selected Ultimate. The ratio is `Selected Ultimate / Ratio Basis` and respects the percentage and decimal settings.
- Saving Result Selection stores the Method tab origin labels in the output vector sidecar as `origin_labels`, alongside the generated vector CSV.
- Closing or canceling a dirty Result Selection shows one small in-page confirmation dialog, avoiding stacked browser or shell confirmation windows.
- Results and Validation tabs are present for v1 but intentionally render placeholders.
- Notes reuses the shared notes editor interactions for formatting, path highlighting, indentation, and dirty-state behavior while saving notes inside the Result Selection method JSON.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Result Selection loads cached dataset values through the app-server `/dataset/cache/load` endpoint so filesystem access remains server-side.
- The method JSON format marker is `arcrho-result-selection-method-by-tab-v1`; keys use underscores, for example `details_tab`, `method_tab`, `selected_ultimate`, and `method_metadata`.
- Project Instance's cached dataset index recognizes saved Result Selection method JSON files and reports their output vector rows with Method Type `Result Selection`.
<!-- MANUAL:END -->

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
- The page posts generic nested-window dirty state through `arcrho:dataset-dirty`, consumes `arcrho:dataset-save`, and exposes `window.__arcrho_request_close` so Project Instance can ask before closing dirty windows.
- Save writes `methods/RS@<ReservingClassFolder>@<Name>.json` using underscore JSON keys, writes the selected ultimate vector CSV under the reserving-class `datasets/` folder, saves a base dataset sidecar with `source_kind: "result_selection"` and `data_format: "Vector"`, and asks the Project Instance host to refresh the cached dataset table.
<!-- MANUAL:END -->

## Behavior
<!-- MANUAL:BEGIN -->
- Details contains Name, Output Type, Origin Length, one Ratio Basis selector, a Show Ratios as Percentages checkbox, and Statistic Decimal Places.
- Method is the main working tab. It displays one source-value column and one editable Weight column for each selected source dataset. `Show Weights` hides or shows Weight columns without changing the stored weights or calculation.
- Default sources are DFM output vectors from the same project, reserving-class path, and Category as the output vector. DFM input triangles and intermediate triangle records are not added by default.
- Users can manually add vector or triangle datasets from the same reserving-class path. Vector sources use their first CSV column; triangle sources use each row's latest available numeric diagonal value.
- `Selected Ultimate` is calculated per row as `sum(source_value * weight) / sum(weight)` over numeric source values with positive weights. If no positive weighted source values exist for a row, the selected ultimate is blank.
- When Ratio Basis is selected, the Method grid appends a ratio column after Selected Ultimate. The ratio is `Selected Ultimate / Ratio Basis` and respects the percentage and decimal settings.
- Results and Validation tabs are present for v1 but intentionally render placeholders.
- Notes reuses the shared notes editor interactions for formatting, path highlighting, indentation, and dirty-state behavior while saving notes inside the Result Selection method JSON.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Result Selection loads cached dataset values through the app-server `/dataset/cache/load` endpoint so filesystem access remains server-side.
- The method JSON format marker is `arcrho-result-selection-method-by-tab-v1`; keys use underscores, for example `details_tab`, `method_tab`, `selected_ultimate`, and `method_metadata`.
- Project Instance's cached dataset index recognizes saved Result Selection method JSON files and reports their output vector rows with Method Type `Result Selection`.
<!-- MANUAL:END -->

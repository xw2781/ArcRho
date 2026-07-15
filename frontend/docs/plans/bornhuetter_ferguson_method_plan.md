# Bornhuetter Ferguson Method V1 Plan

Version: v2.0
Last updated: 2026-07-09

## Summary

Add a new ArcRho method object type displayed and persisted exactly as `Bornhuetter Ferguson`.

The BF method page uses the shared tabbed-page framework and opens as a Project Instance iframe feature page with tabs in this order:

1. `Details`
2. `Method`
3. `Chart`
4. `Notes`
5. `Audit Log`

V2 produces the final output ultimate vector from one or more weighted prior vectors. It excludes Exposure and ResQ/RPC sync.

Reference assets:

```text
E:\XWSpace\ResQ API Doc\assets\BF Method
E:\XWSpace\ResQ API Doc\assets\BF Method\BF_Tab_Method_Data.xlsx
```

## Canonical Labels

- UI method type: `Bornhuetter Ferguson`
- JSON method type: `Bornhuetter Ferguson`
- Sidecar `method_type`: `Bornhuetter Ferguson`
- Source kind: `bornhuetter_ferguson`

Do not use `Bornhuetter-Ferguson`, `Bornhutter Ferguson`, or `BF Method` as the persisted method type label.

## Project Instance Integration

Project Instance supports BF as a sibling method object to DFM and Result Selection.

Required behavior:

- Row context menu includes `Add -> Bornhuetter Ferguson`.
- Eligible create source rows are vector rows with blank/`None` Method Type.
- BF creation opens the BF page on `Details`.
- View/double-click for `Method Type = Bornhuetter Ferguson` opens the BF page on `Method`.
- `Show as vector` remains available for BF output vector rows and opens the output in Dataset Viewer.
- Project Instance state snapshots preserve BF floating-window state and active BF tab.
- Help/open JSON resolution treats BF as a method JSON under `methods/BF@<Name>.json`.
- No BF Sync workflow appears in V2.

## Page Shape

Folder:

```text
frontend/ui/method_pages/bornhuetter_ferguson/
```

Core files:

```text
bornhuetter_ferguson.html
bornhuetter_ferguson_chart.js
bornhuetter_ferguson_main.js
```

Shared framework:

- `createTabbedPage`
- `applyTabbedPageSaveBar`
- `updateTabbedPageSaveControls`
- `requestTabbedPageWindowClose`
- `wireTabPopoutWindows`
- `mountNotesTab`
- Dataset picker/name picker helpers

The UI should use the ResQ BF layout as a functional reference, while following ArcRho's compact operational page style.

## Calculation Behavior

Inputs:

- Latest source: one actual triangle dataset.
- Percent developed source: one selected DFM output vector.
- Prior sources: one or more ultimate vectors with a non-negative weight for each origin row.

Latest values:

```text
Latest = latest diagonal values from the selected actual triangle, by origin
```

Percentage developed:

```text
Percentage Developed = Latest / DFM implied ultimate vector
```

Percentage Developed is blank when Latest is missing, DFM ultimate is missing, either value is non-numeric, or DFM ultimate is zero.

Prior selection:

```text
Selected Prior = SUM(Prior Ultimate * Weight) / SUM(Weight)
```

Only prior values with positive weights participate. Selected Prior is blank when no available prior source has a positive weight for that row. New prior sources default to weight `1.0` for every row.

Output:

```text
If Selected Prior is blank:
  New Ultimate = Latest
Otherwise:
  New Ultimate = ROUND(Latest + (1 - Percentage Developed) * Selected Prior, 0)
```

New Ultimate is blank when Latest is blank/non-numeric. When Selected Prior is available, New Ultimate is also blank if Percentage Developed is blank/non-numeric.

## Method Table

V2 Method table columns:

| Column | Behavior |
| --- | --- |
| Origin | Origin label for the selected origin length. |
| Latest | Latest actual triangle diagonal value. |
| Percentage Developed | `Latest / DFM Ultimate`, displayed as a percent. |
| Prior Ultimate | One dynamic column per selected prior vector. |
| Weight | One optional dynamic column per prior vector, shown when Show Weights is enabled. |
| Selected Prior | Weighted average of the available prior vectors. |
| New Ultimate | Latest when Selected Prior is blank; otherwise the rounded BF ultimate output. |

The Method toolbar contains Formatting controls only: Show Weights, Index/Effective % display mode, and decimal places. Prior and Weight cells reuse Result Selection selection, double-click toggle, keyboard entry, paste, Delete-to-zero, and highlight behavior.

## Chart

The Chart tab compares three ultimate-value series by origin period:

- DFM Implied Ultimate, reconstructed as `Latest / Percentage Developed`.
- Selected Prior.
- BF Ultimate, using the Method table's `New Ultimate` values.

The plot responds to window resizing, follows the Method decimal-place setting, leaves unavailable values as gaps, and shows the series, origin, and value when a point is hovered.

## Persistence

Method JSON file:

```text
methods/BF@<Name>.json
```

Dataset output:

```text
datasets/<Name>@<OriginLength>.csv
```

Save writes:

- BF v2 method JSON grouped by `details_tab`, `method_tab`, `chart_tab`, `notes_tab`, `audit_log_tab`, and `method_metadata`.
- `method_tab.prior_datasets` stores each prior source name, loaded values, and row weights; `method_tab.show_weights` stores column visibility and `details_tab.statistic_decimal_places` stores formatting precision.
- Native output vector CSV.
- Aggregated coarser-period vector CSV variants when the selected origin length can aggregate to 3, 6, or 12.
- Dataset sidecar metadata with:
  - `source_kind = "bornhuetter_ferguson"`
  - `method_type = "Bornhuetter Ferguson"`
  - `data_format = "Vector"`
  - `status = 0`
  - `origin_labels`
  - `csv_file`
  - `precedents` containing the Latest triangle, DFM source, and every Prior Ultimate source.

Project Instance refreshes the cached dataset table after a successful save.

## Deferred From V2

- Exposure input.
- ResQ/RPC sync.
- Live BF output preview publishing to downstream dependents.

## Test Plan

1. Create BF from an eligible Project Instance vector row.
2. Confirm tabs: `Details`, `Method`, `Chart`, `Notes`, `Audit Log`.
3. Confirm Method Type displays and persists as `Bornhuetter Ferguson`.
4. Select latest triangle, DFM source, and multiple prior vectors.
5. Show/hide Weight columns, switch Index/Effective % display, edit weights by double-click/typing/paste, and verify the decimal control.
6. Verify Method table values, weighted Selected Prior, and New Ultimate calculation:
   `New Ultimate = ROUND(Latest + (1 - Percentage Developed) * Selected Prior, 0)`.
7. Confirm the Chart tab plots DFM Implied Ultimate, Selected Prior, and BF Ultimate against the Method table origin labels.
8. Open a configured dependency in the same Project Instance, make unsaved edits, and confirm the BF Method table and Chart immediately use the live preview values; save or discard the dependency and confirm BF reloads the persisted source.
9. Save, close, and reopen.
10. Confirm method JSON restores prior sources, weights, formatting, Notes, Audit Log, and metadata.
11. Confirm native output vector CSV and aggregated vector CSV variants are written.
12. Confirm sidecar metadata has `method_type = "Bornhuetter Ferguson"` and all source precedents.
13. Confirm Project Instance refresh shows the BF output vector.
14. Confirm `Show as vector` opens the BF output vector.
15. Confirm no BF Sync workflow appears.

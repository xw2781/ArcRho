# Result Selection Method Plan

Version: v0.1
Last updated: 2026-06-17

---

## 1. Goal

Add a new method object type named **Result Selection** under `frontend/ui/result_selection/`.

Result Selection is a method page attached to a vector output dataset. It lets the user combine any number of vector datasets, plus triangle datasets using latest diagonal values only, into one selected ultimate vector by row-level weighted average. Each source dataset has a row-level `Weight` column vector; the selected ultimate calculation uses those row-specific weights.

The implementation should behave like a sibling to the existing DFM method object:

1. It opens in an isolated iframe feature page.
2. It owns Details, Method, and Notes tabs.
3. It has dirty-state, save, cancel, close-confirmation, and method JSON persistence semantics.
4. It can be created from the Project Instance dataset table by right-clicking an eligible vector dataset.

---

## 2. Existing System Context

Relevant current behavior:

1. `frontend/ui/dfm/` is the closest pattern for a method page. It is loaded as an iframe, owns tab state, posts `arcrho:*` dirty/status messages, and persists a grouped method JSON.
2. Project Instance dataset rows already expose `Name`, `Dataset Type Name`, `Data Format`, `Category`, and `Method Type`.
3. Project Instance already supports `Right click dataset -> Add -> DFM` through `project_instance_dataset_table.js` and opens DFM floating windows through `project_instance_windows.js`.
4. Cached dataset discovery comes from `/datasets/cached` and includes method metadata such as `method_type`.
5. DFM save writes a method JSON plus generated vector CSV/sidecar metadata. Result Selection should follow the same persistence discipline rather than writing ad hoc files directly from UI code.

---

## 3. Proposed User Workflow

### 3.1 Create From Project Instance

1. User opens a Project Instance page and selects a reserving class path.
2. User right-clicks a vector dataset row whose `Method Type` is empty, missing, or `None`.
3. The row context menu shows:

   ```text
   Add
     Dataset
     DFM
     Result Selection
     Berquist Sherman Method
   ```

4. User clicks `Result Selection`.
5. Project Instance opens a Result Selection floating window for the selected vector.
6. The Result Selection Details tab is prefilled:
   - `Name`: selected vector instance name.
   - `Output Type`: selected row's dataset type name.
   - `Origin Length`: `12` unless the selected dataset metadata provides a more specific origin length.
   - `Ratio Basis`: blank by default.
   - Project and reserving class path inherited from Project Instance.
7. The Method tab is initialized with default source datasets:
   - Include datasets in the same selected reserving class path.
   - Dataset `Category` must match the selected output vector row's `Category`.
   - Dataset `Method Type` must equal `DFM`.
   - Each default source dataset starts with `Weight = 0` for every origin row.

### 3.2 Open Existing Result Selection

When a dataset row has `Method Type = Result Selection`, double-clicking or selecting `View` should open the Result Selection method page instead of the generic dataset viewer.

If the user chooses `Show as vector` for a Result Selection output vector, open the dataset viewer read-only or normal vector view, matching the existing DFM vector behavior.

---

## 4. Result Selection Page

The page should live under:

```text
frontend/ui/result_selection/
```

Expected first files:

```text
result_selection.html
result_selection_main.js
result_selection_state.js
result_selection_details.js
result_selection_method_tab.js
result_selection_results_tab.js
result_selection_validation_tab.js
result_selection_notes_tab.js
result_selection_persistence.js
```

The page should be an iframe feature page like DFM. It should not collapse logic into the shell or Project Instance page.

### 4.1 UI Style And Tabs

The page should use the same dense desktop-method style shown in the legacy Result Selection screenshots:

1. Compact top tab strip.
2. Wide form rows on Details.
3. Spreadsheet-like Method grid with frozen row labels, dataset columns, editable weight columns, and a highlighted `Selected Ultimate` column.
4. DFM-style Save/Cancel behavior rather than legacy `Apply / OK / Cancel` buttons.

The page has these top-level tabs:

1. `Details`
2. `Method`
3. `Results`
4. `Validation`
5. `Notes`

For the initial implementation, real contents are required only for:

1. `Details`
2. `Method`
3. `Notes`

`Results` and `Validation` should exist as tabs but can render empty placeholder surfaces until their expected behavior is defined.

The shell and Project Instance code should treat these as Result Selection-specific tabs, not DFM tabs.

### 4.2 Details Tab

Fields:

| Field | Type | Behavior |
| --- | --- | --- |
| `Name` | text input | Vector instance name for the Result Selection output. Required before save. |
| `Output Type` | dataset picker/input | Vector dataset type. Required before save. |
| `Origin Length` | select/spinner | Defaults to `12`. Controls row labels in the Method tab. |
| `Ratio Basis` | dataset picker/input | Optional. Can be blank or select one dataset in the same reserving class path. |

For v1, support a single ratio basis only. Do not implement the legacy `One / Two / Three` ratio-basis tabs yet.

The Details tab can include ratio-display settings near the ratio basis, matching the screenshot style where practical:

1. `Basis` dataset selector.
2. `Show Ratios as Percentages` checkbox.
3. `Statistic Decimal Places` numeric input.

These settings affect the Method tab ratio column only. Ratio Basis does not change the selected ultimate calculation.

`Origin Length` label mapping should match DFM conventions:

| Origin Length | Row Label |
| ---: | --- |
| `12` | Accident Year |
| `6` | Accident Half-Year |
| `3` | Accident Quarter |
| `1` | Accident Month |
| other positive value | Accident Period |

### 4.3 Method Tab

The Method tab is the main working tab. It both manages source datasets and displays/calculates the final selected ultimate output.

Top controls:

1. `Show Weights` toggles the weight columns between visible and hidden. Hidden weight columns still exist, persist, and affect calculation.
2. Ratio display controls apply to the post-ultimate ratio column when a ratio basis is configured.
3. Ignore legacy `Show Details` and `Transposed` behavior for v1.

The Method body is a compact spreadsheet-like grid.

Left side:

1. First sticky column displays origin labels based on `Origin Length`.
2. Row count is based on the output vector, if available.
3. If no output vector values exist yet, row count should come from the longest selected source vector/latest diagonal.
4. If there are no source datasets yet, show an empty grid with the origin label column and `Selected Ultimate` column.

Source dataset columns:

1. User can add vector datasets from the same reserving class path.
2. User can add triangle datasets from the same reserving class path.
3. For vector datasets, use the vector values directly.
4. For triangle datasets, use latest diagonal only. For each origin row, pick the latest available numeric value in that triangle row.
5. Each added dataset creates two adjacent columns:
   - dataset value column
   - `Weight` input column
6. `Weight` is a row-level editable column vector for that source dataset.
7. `Weight` accepts positive numbers and zero.
8. Default `Weight` is `0` for each origin row.
9. Negative, blank, and non-numeric weights should be rejected or normalized to `0` with visible validation.
10. Dataset value columns are read-only.
11. Weight columns are editable and mark the method dirty.

Right side:

1. `Selected Ultimate` is sticky or visually anchored after all source/weight columns.
2. `Selected Ultimate` should be visually distinct from source columns, for example a pale yellow cell fill similar to the screenshot.
3. For each origin row:

   ```text
   Selected Ultimate(row) = sum(source_value_i(row) * weight_i(row)) / sum(weight_i(row) for source values that are numeric)
   ```

4. The implied percentage weight for each dataset is:

   ```text
   implied_percentage_weight_i(row) = weight_i(row) / sum(weight_i(row) for source values that are numeric)
   ```

5. The implied percentage weight does not need to be displayed in the UI, but it should be available as an internal calculation step, including for backend/result generation if that path owns the final vector calculation.
6. If the row has no positive weights, or no numeric weighted source values, `Selected Ultimate` is blank.
7. Source values that are blank or non-numeric are ignored for that row's numerator and denominator.
8. A source with `Weight = 0` contributes nothing.
9. If `Ratio Basis` is selected, render a ratio column after `Selected Ultimate`:

   ```text
   Ratio(row) = Selected Ultimate(row) / Ratio Basis(row)
   ```

10. If `Show Ratios as Percentages` is checked, display the ratio column as a percentage using `Statistic Decimal Places`.
11. If no ratio basis is selected, do not render the ratio column.

Dataset management controls:

1. Provide an add-source control that opens a dataset picker filtered to same reserving class path.
2. The picker should show data format, category, method type, and name.
3. Allow removing a source dataset column pair.
4. Reordering sources is optional for v1.

### 4.4 Notes Tab

Notes should match the DFM Notes tab behavior as closely as practical:

1. Same rich text/format toolbar behavior if reusable through shared notes utilities.
2. Same dirty-state behavior for user edits.
3. Same save/load persistence inside the Result Selection method JSON.

---

## 5. Persistence

Use a grouped method JSON shape similar to DFM, with a distinct format marker. Unlike existing DFM JSON, Result Selection should use underscores rather than spaces between words for JSON keys.

```json
{
  "json_format": "arcrho-result-selection-method-by-tab-v1",
  "details_tab": {
    "name": "",
    "output_type": "",
    "origin_length": 12,
    "ratio_basis": "",
    "show_ratios_as_percentages": true,
    "statistic_decimal_places": 1
  },
  "method_tab": {
    "origin_labels": [],
    "show_weights": true,
    "loaded_datasets": [
      {
        "name": "",
        "dataset_type": "",
        "data_format": "vector",
        "method_type": "",
        "category": "",
        "value_source": "vector",
        "values": [],
        "weights": []
      }
    ],
    "selected_ultimate": []
  },
  "results_tab": {},
  "validation_tab": {},
  "notes_tab": {
    "notes": ""
  },
  "method_metadata": {
    "last_modified": ""
  }
}
```

Local method filename:

```text
RS@<Name>.json
```

On save:

1. Persist method JSON.
2. Write/update the selected ultimate vector CSV.
3. Write/update dataset sidecar metadata so the Project Instance table reports:
   - `Method Type = Result Selection`
   - `Data Format = vector`
   - `Category` copied from output type or selected output vector metadata.
4. Refresh cached dataset metadata after successful save.
5. Mark the page clean only after method JSON and output vector persistence succeed.

---

## 6. Shell And Project Instance Integration

### 6.1 Shell

Result Selection v1 does not need standalone shell tabs. It should open only as a Project Instance floating content window, mirroring the embedded DFM-window workflow.

Shell work for v1 is limited to any existing Project Instance message routing needed for save/dirty/status forwarding. Do not add `openResultSelectionTab()` or plus-menu standalone Result Selection entries until a later request.

### 6.2 Project Instance

Project Instance should add:

1. `isResultSelectionDatasetRecord(record)`.
2. `openResultSelectionWindow(datasetName, options)`.
3. `buildResultSelectionViewerUrl(datasetName, inst, options)`.
4. Row context action `add-result-selection`.
5. Double-click/view routing for `Method Type = Result Selection`.
6. Hidden-window snapshot support with `kind = "result_selection"` or a compatible method-window kind.

Do not reuse DFM-specific state names such as `dfmTab` for Result Selection tabs. Use method-neutral names or Result Selection-specific names to avoid confusing shell menu behavior.

---

## 7. Dataset Eligibility Rules

### 7.1 Right-Click Add Eligibility

Show and enable `Add -> Result Selection` only when:

1. A single row is the row context target.
2. `Data Format = vector`.
3. `Method Type` is blank, missing, or `None`.
4. A reserving class path is selected.

If the menu remains visible but disabled, use a tooltip/status reason:

```text
Result Selection can be added only to vector datasets with Method Type None.
```

### 7.2 Default Source Eligibility

Default Method tab source datasets:

1. Same project.
2. Same reserving class path.
3. Same `Category` as the output vector row.
4. `Method Type = DFM`.
5. Exclude the output vector itself.
6. Include DFM output vectors only. Do not include DFM input triangles or intermediate triangle records in the default setup.

---

## 8. Validation And Edge Cases

1. Missing project or reserving class: page opens but disables save and source loading with a visible status.
2. Name collision: follow DFM behavior for existing method names; do not silently overwrite without save confirmation.
3. Origin length change: recompute origin labels and selected ultimate. Preserve sources and weights by row index where possible.
4. Source row length mismatch: align by row index for v1. Later versions can support explicit origin label matching.
5. Triangle latest diagonal missing for a row: leave that source value blank for that row.
6. All weights zero: selected ultimate is blank, not zero.
7. Ratio Basis blank: allowed.
8. Ratio Basis selected: persist the selected dataset name/path and render `Selected Ultimate / Ratio Basis` after the selected ultimate column.
9. Deleted source dataset: keep the source in JSON but mark unavailable, with blank values and a warning until the user removes it.
10. Unsaved changes: close/cancel prompts should match DFM dirty-state semantics.

---

## 9. Implementation Phases

### Phase 1: Page Skeleton

1. Add `frontend/ui/result_selection/` feature files.
2. Build real Details, Method, and Notes tab contents.
3. Add placeholder Results and Validation tabs.
4. Add local state and dirty-state messages.
5. Add method JSON build/apply functions.

### Phase 2: Project Instance Creation

1. Add context menu item.
2. Add open window function and URL builder.
3. Pass selected vector metadata and default source filters through query params or an initial payload message.
4. Route existing Result Selection rows to the new page.

### Phase 3: Dataset Loading And Calculation

1. Load candidate source datasets from cached metadata.
2. Load vector values and triangle latest diagonals.
3. Load Ratio Basis vector values when configured.
4. Render Method grid.
5. Recalculate selected ultimate when sources or weights change.
6. Recalculate the ratio column when selected ultimate or ratio basis changes.

### Phase 4: Persistence

1. Save method JSON.
2. Save output vector CSV.
3. Save/update sidecar metadata.
4. Refresh Project Instance cached dataset table.
5. Restore clean state after successful save.

### Phase 5: Docs And Release Notes

1. Update user-facing UI docs for Project Instance and Result Selection.
2. Add or update generated docs indexes.
3. Add a release fragment with scope `result selection` or `project instance`.

---

## 10. Validation Plan

Targeted checks should run within the repository's 120 second validation limit:

1. Open Project Instance for a test project and selected reserving class.
2. Right-click a vector dataset with `Method Type = None`; confirm `Add -> Result Selection` appears.
3. Right-click a triangle or non-None method row; confirm the action is hidden or disabled.
4. Create Result Selection and confirm Details fields are prefilled.
5. Confirm tabs exist in this order: Details, Method, Results, Validation, Notes.
6. Confirm Results and Validation render placeholder surfaces.
7. Confirm default DFM output vector sources are added with `Weight = 0`.
8. Add a vector source manually.
9. Add a triangle source manually and confirm latest diagonal values populate.
10. Enter weights and confirm `Selected Ultimate` recalculates row by row.
11. Toggle `Show Weights` and confirm weight columns hide/show without changing calculation.
12. Select a Ratio Basis and confirm the ratio column renders after `Selected Ultimate`.
13. Confirm ratio values equal `Selected Ultimate / Ratio Basis` and respect percentage/decimal settings.
14. Save, close, and reopen; confirm Details, sources, weights, selected ultimate, ratio basis settings, Method display settings, and Notes restore.
15. Confirm Project Instance table reports `Method Type = Result Selection`.

---

## 11. Open Questions For Review

No open questions remain for the current v1 scope.

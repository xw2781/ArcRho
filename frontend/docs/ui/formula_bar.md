# DSV and DFM formula bars

## Formula assistance
<!-- MANUAL:BEGIN -->
Both editors offer function-name completion, argument names with the active argument highlighted, and choices for datasets, projects, reserving-class paths, and Boolean arguments. Typing `[` opens the dataset-name list; choosing a name inserts `[Dataset][` ready for coordinates. Tab or Enter accepts a suggestion, arrows move through it, and Escape closes it. Dataset choices use the project and RC specified by the call.

Path offers the current RC shortcut; enter other RC paths as quoted text. Formula dataset lists and value reads require the Gateway. Other legacy dataset-router reads (including index-signature polling) retain their existing SMB paths and should be migrated separately.

Click **fx** to open Insert Formula inside the current window. Select a function, enter arguments, choose available values, and preview the result. Text arguments use double quotes. Preview shows up to 20 rows and 12 columns and reports the full result dimensions. Insert is enabled only for a successful preview of the current draft; it writes the formula bar draft. Enter in the bar applies it. Cancel keeps the original draft. Dragging fx retains the existing bar movement gesture.

DSV's persistent formula panel shows the first cell (top left) of the first selected range, including a multi-cell selection. Read-only cells retain their existing restrictions.
<!-- MANUAL:END -->

## Functions and dataset calls
<!-- MANUAL:BEGIN -->
`TAKE(array, rows, [columns])` selects leading or trailing rows/columns; negative counts select from the end, oversized counts clamp to the available size, and zero is an error. `INDEX(array, row_num, [column_num])` uses one-based positions; zero selects an entire row or column. `TRANSPOSE(array)` swaps axes. Array constants use commas between columns and semicolons between rows. These functions compose with the existing numeric functions and dataset/workbook references.

The numeric Excel add-in dataset functions are available with the same positional argument order: `ArcRhoTri`, `ArcRhoTriDiag`, `ArcRhoTriCell`, `ArcRhoTriOrigin`, `ArcRhoVec`, and `ArcRhoVecCell`. Their signatures and defaults are generated from `excel-addin/src_vba/ArcRhoFunctions.bas`. Arguments are quoted text, numbers, TRUE/FALSE, or omitted slots; calculations can wrap the calls. Blank/omitted Path and blank/omitted/Default ProjectName use the editor's current RC and project. Explicit project and RC values can name other scopes. As in the add-in, ByTypeName and SuppressWarnings are accepted compatibility slots.

Examples:

```text
=TAKE(ArcRhoTri(,"Paid Claims"),-3,2)
=TRANSPOSE(ArcRhoVec("","Selected Ultimate"))
=INDEX(ArcRhoTri("Other RC","Paid Claims",TRUE,FALSE,FALSE,"Other Project"),2,1)
```

DSV spills into its eligible target cells and saves the formula link. DFM accepts one row of positive numeric results that fits the available User Entry cells; use TAKE/INDEX/TRANSPOSE to select that shape. DFM saves each spilled cell as INDEX of the original expression, preserving its dataset references for recalculation. Existing DFM row references and decimal half-up ROUND behavior remain supported.

Local dataset calls participate in the existing segment dependency graph. Other-project/RC calls are evaluated on entry, preview, and explicit refresh (and when the owning DFM recalculates); a save in another scope does not automatically push refreshes across scopes. Cross-scope sources are not recorded as same-named local graph nodes. Saved values remain snapshots until refreshed.
<!-- MANUAL:END -->

## Implementation and checks
<!-- MANUAL:BEGIN -->
`arcrho_api.dataset_link_contract` owns numeric grammar and evaluation, with `dataset_formula_arrays` owning array selection. `generate_dataset_formula_metadata.py` derives browser metadata and the Python add-in catalog; browser/server parity tests cover the evaluator. `dataset_formula_values.js` shares asynchronous reads and preview evaluation; formula completion and the dialog live in `ui/shared/components/formula_bar/`.

The existing `/dataset/internal_links/resolve` route batches both bracket references and add-in calls. It requires Gateway transport on clients. `arcrho_formula_service` delegates dataset shape conversion to the same hosted dataset reader used by Excel, caches repeated reads within a request, and supplies numeric matrices. Missing sources or invalid indices fail visibly without applying a partial preview.

Node tests that load browser `/ui/` module paths use `--import ./frontend/tests/ui_module_loader.mjs`. The helper lifecycle tests check preview, cancellation, stale responses, insertion, and focus; browser testing is still needed for visual layout.
<!-- MANUAL:END -->

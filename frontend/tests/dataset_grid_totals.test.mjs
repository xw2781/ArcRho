import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const helperSource = await readFile(
  new URL("../ui/shared/tabs/data/dataset_grid_totals.js", import.meta.url),
  "utf8",
);
const gridViewSource = await readFile(
  new URL("../ui/shared/tabs/data/dataset_grid_view.js", import.meta.url),
  "utf8",
);
const datasetViewerSource = await readFile(
  new URL("../ui/dataset_viewer/dataset_viewer_view.js", import.meta.url),
  "utf8",
);
const persistenceSource = await readFile(
  new URL("../ui/shared/tabs/data/data_tab_persistence_controller.js", import.meta.url),
  "utf8",
);
const gridInteractionsSource = await readFile(
  new URL("../ui/shared/tabs/data/dataset_grid_interactions.js", import.meta.url),
  "utf8",
);
const dataTabCss = await readFile(
  new URL("../ui/shared/tabs/data/data_tab.css", import.meta.url),
  "utf8",
);
const spreadsheetCss = await readFile(
  new URL("../ui/shared/components/spreadsheet/spreadsheet_table.css", import.meta.url),
  "utf8",
);
const workspaceCss = await readFile(
  new URL("../ui/shared/components/workspace/workspace.css", import.meta.url),
  "utf8",
);
const dfmCss = await readFile(
  new URL("../ui/method_pages/dfm/dfm.css", import.meta.url),
  "utf8",
);
const helperModuleUrl = `data:text/javascript;base64,${Buffer.from(helperSource).toString("base64")}`;
const {
  getDatasetGridTotalLayout,
  shouldShowDatasetGridTotals,
  sumDatasetGridColumn,
  sumDatasetGridRow,
} = await import(helperModuleUrl);

test("Dataset Viewer follows the persisted Show subtotal setting", () => {
  assert.equal(shouldShowDatasetGridTotals({ isDfmHost: false, formula: "Paid + Reported", showSubtotal: true }), true);
  assert.equal(shouldShowDatasetGridTotals({ isDfmHost: false, formula: "Paid + Reported", showSubtotal: false }), false);
  assert.equal(shouldShowDatasetGridTotals({ isDfmHost: false }), true);
});

test("Dataset Viewer hides the total row for ratio formulas", () => {
  assert.equal(shouldShowDatasetGridTotals({ isDfmHost: false, formula: "Paid / Reported", showSubtotal: true }), false);
  assert.equal(
    shouldShowDatasetGridTotals({
      isDfmHost: false,
      formula: '"Claim Counts--Total Closed" / "Claim Counts--Reported"',
      showSubtotal: true,
    }),
    false,
  );
  // A slash inside a quoted dataset name is not a division operator.
  assert.equal(
    shouldShowDatasetGridTotals({ isDfmHost: false, formula: '"Closed w/ Payment" + "Closed w/o Payment"', showSubtotal: true }),
    true,
  );
  // Products keep the total row in the Dataset Viewer; only ratios lose it.
  assert.equal(shouldShowDatasetGridTotals({ isDfmHost: false, formula: "Paid * 0.80", showSubtotal: true }), true);
});

test("Dataset Viewer exposes a standard Show/Hide subtotal context-menu command", () => {
  assert.doesNotMatch(datasetViewerSource, /id="showSubtotalChk"/u);
  assert.match(datasetViewerSource, /class="ctx-item" data-action="toggle_subtotal">Show\/Hide subtotal<\/button>/u);
  assert.doesNotMatch(datasetViewerSource, /ctx-item-toggle|ctx-item-check|role="menuitemcheckbox"|aria-checked=/u);
  assert.doesNotMatch(gridViewSource, /subtotalButton|aria-checked/u);
  assert.match(persistenceSource, /show_subtotal:\s*state\.showSubtotal\s*!==\s*false/u);
  assert.match(persistenceSource, /typeof source\.show_subtotal === "boolean" \? source\.show_subtotal : true/u);
  assert.match(persistenceSource, /state\.showSubtotal = normalized\.show_subtotal/u);
  assert.match(gridInteractionsSource, /action === "toggle_subtotal"[\s\S]*?state\.showSubtotal = state\.showSubtotal === false/u);
});

test("the grid applies the total policy using its configured host", () => {
  assert.match(gridViewSource, /isDfmHost:\s*isDfmDataTabHost\(\)/u);
  assert.match(gridViewSource, /formula:\s*getCurrentDatasetTypeFormula\(\)/u);
  assert.match(gridViewSource, /showSubtotal:\s*state\.showSubtotal\s*!==\s*false/u);
  assert.match(gridViewSource, /state\.model\?\.formula/u);
});

test("editable null cells display a formatted muted zero without changing their value", () => {
  assert.match(
    gridViewSource,
    /displayNullAsZero\s*=\s*isEditable\s*&&\s*v\s*==\s*null[\s\S]*?formatCellValue\(displayNullAsZero\s*\?\s*0\s*:\s*v\)/u,
  );
  assert.match(gridViewSource, /classList\.toggle\("dsNullValue",\s*displayNullAsZero\)/u);
  assert.match(
    dataTabCss,
    /#tableWrap td\.dsNullValue,[\s\S]*?color:\s*#7a858f/u,
  );
});

test("the grid auto-fits the row-label column to its corner header", () => {
  assert.match(gridViewSource, /fitRowLabelColumn\(tbl,\s*th0\)/u);
  assert.match(
    gridViewSource,
    /measureText\(cornerCell\.textContent\s*\|\|\s*""\)[\s\S]*?--data-tab-row-label-column-width/u,
  );
  assert.match(
    dataTabCss,
    /#tableWrap th:first-child,[\s\S]*?width:\s*var\(--data-tab-row-label-column-width/u,
  );
});

test("the Data grid draws its own top and left perimeter inside the scroll wrapper", () => {
  assert.match(
    dataTabCss,
    /#tableWrap thead th\s*\{[\s\S]*?border-top:\s*1px solid var\(--ar-spreadsheet-grid-border\)/u,
  );
  assert.match(
    dataTabCss,
    /#tableWrap th:first-child,[\s\S]*?border-left:\s*1px solid var\(--ar-spreadsheet-grid-border\)/u,
  );
});

test("the sticky row-label seam does not cover the dynamic-array left border", () => {
  assert.match(
    dataTabCss,
    /#tableWrap th:first-child,[\s\S]*?box-shadow:\s*inset -1px 0 0 var\(--ar-spreadsheet-grid-border\)/u,
  );
  assert.doesNotMatch(
    dataTabCss,
    /#tableWrap th:first-child,[\s\S]*?box-shadow:\s*1px 0 0 var\(--ar-spreadsheet-grid-border\)/u,
  );
});

test("dynamic-array outlines stay continuous above the optional Total row", () => {
  const edgeBorders = {
    Top: "border-top: 1px solid var\\(--ar-array-formula-border\\) !important",
    Right: "border-right-color: var\\(--ar-array-formula-border\\) !important",
    Bottom: "border-bottom: 1px solid var\\(--ar-array-formula-border\\) !important",
    Left: "border-left: 1px solid var\\(--ar-array-formula-border\\) !important",
  };
  for (const [edge, declaration] of Object.entries(edgeBorders)) {
    assert.match(
      spreadsheetCss,
      new RegExp(`\\.arArrayFormulaEdge${edge} \\{[^}]*${declaration}`, "u"),
    );
  }
  assert.match(
    spreadsheetCss,
    /\.arArrayFormulaEdgeBottom \{[^}]*position: relative;[^}]*z-index: 1;/u,
  );
  assert.match(
    dataTabCss,
    /table\.has-total-row tbody tr:last-child > \* \{\s*border-bottom: 0;/u,
  );
  assert.doesNotMatch(spreadsheetCss, /inset 0 1px 0 var\(--ar-array-formula-top\)/u);
  assert.doesNotMatch(spreadsheetCss, /inset -1px 0 0 var\(--ar-array-formula-right\)/u);
});

test("Data and Ratios scroll frames share the same neutral border token", () => {
  assert.match(workspaceCss, /--ar-workspace-frame-border:\s*#d8dde3/u);
  assert.match(dataTabCss, /#tableWrap\s*\{[\s\S]*?border:\s*1px solid var\(--ar-workspace-frame-border\)/u);
  assert.match(dfmCss, /#ratioWrapHost\s*\{[\s\S]*?border:\s*1px solid var\(--ar-workspace-frame-border\)/u);
});

test("DFM retains its multiplication and division total-row policy", () => {
  assert.equal(shouldShowDatasetGridTotals({ isDfmHost: true, formula: "Paid * 0.80" }), false);
  assert.equal(shouldShowDatasetGridTotals({ isDfmHost: true, formula: "Paid / Reported" }), false);
  assert.equal(shouldShowDatasetGridTotals({ isDfmHost: true, formula: "Paid + Reported" }), true);
  assert.equal(shouldShowDatasetGridTotals({ isDfmHost: true, formula: "" }), true);
  assert.equal(shouldShowDatasetGridTotals({ isDfmHost: true, formula: '"Closed w/ Payment" + "Closed w/o Payment"' }), true);
});

test("the standard Total row extends the selectable row boundary", () => {
  assert.deepEqual(
    getDatasetGridTotalLayout({ rowCount: 2, columnCount: 3, showTotals: true }),
    {
      rowCount: 2,
      columnCount: 3,
      totalRowIndex: 2,
      totalColumnIndex: null,
      maxRow: 2,
      maxCol: 2,
    },
  );
});

test("the transposed Total column extends the selectable column boundary", () => {
  assert.deepEqual(
    getDatasetGridTotalLayout({
      rowCount: 2,
      columnCount: 3,
      showTotals: true,
      transposed: true,
    }),
    {
      rowCount: 2,
      columnCount: 3,
      totalRowIndex: null,
      totalColumnIndex: 3,
      maxRow: 1,
      maxCol: 3,
    },
  );
});

test("hidden totals do not change the selectable grid boundary", () => {
  assert.deepEqual(
    getDatasetGridTotalLayout({ rowCount: 2, columnCount: 3, showTotals: false }),
    {
      rowCount: 2,
      columnCount: 3,
      totalRowIndex: null,
      totalColumnIndex: null,
      maxRow: 1,
      maxCol: 2,
    },
  );
});

test("Total copy values use the same masked numeric sums as the renderer", () => {
  const values = [
    [10, "20", 30],
    [5, "not numeric", 15],
  ];
  const mask = [
    [true, true, false],
    [true, true, true],
  ];

  assert.equal(sumDatasetGridRow(values, mask, 0, 3), 30);
  assert.equal(sumDatasetGridRow(values, mask, 1, 3), 20);
  assert.equal(sumDatasetGridColumn(values, mask, 0, 2), 15);
  assert.equal(sumDatasetGridColumn(values, mask, 1, 2), 20);
  assert.equal(sumDatasetGridColumn(values, mask, 2, 2), 15);
});

test("rendered totals expose selectable coordinates and raw copy values", () => {
  assert.match(gridViewSource, /totalLabel\.classList\.add\("rowhdr"\)/u);
  assert.match(gridViewSource, /totalLabel\.dataset\.r\s*=\s*String\(totalRowIndex\)/u);
  assert.match(gridViewSource, /th\.classList\.add\("totalColHdr",\s*"colhdr"\)/u);
  assert.match(gridViewSource, /th\.dataset\.c\s*=\s*String\(totalColumnIndex\)/u);
  assert.match(
    gridViewSource,
    /configureSelectableDatasetCell\(td,\s*r,\s*totalColumnIndex,\s*\{[\s\S]*?copyValue:\s*sum,[\s\S]*?readOnly:\s*true/u,
  );
  assert.match(
    gridViewSource,
    /configureSelectableDatasetCell\(td,\s*totalRowIndex,\s*c,\s*\{[\s\S]*?copyValue:\s*sum,[\s\S]*?readOnly:\s*true/u,
  );
});

test("grid selection bounds and copy include rendered Total cells", () => {
  assert.match(gridInteractionsSource, /getDatasetGridSelectionLayout\(\)/u);
  assert.match(
    gridInteractionsSource,
    /cell\?\.dataset\?\.copyValue\s*\?\?\s*getDisplayDatasetModel\(\)\?\.values/u,
  );
});

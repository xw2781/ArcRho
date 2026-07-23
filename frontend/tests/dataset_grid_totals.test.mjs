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
const gridInteractionsSource = await readFile(
  new URL("../ui/shared/tabs/data/dataset_grid_interactions.js", import.meta.url),
  "utf8",
);
const dataTabCss = await readFile(
  new URL("../ui/shared/tabs/data/data_tab.css", import.meta.url),
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

test("Dataset Viewer keeps totals for calculated dataset formulas", () => {
  for (const formula of ["Paid * 0.80", "Paid / Reported", "Paid + Reported", "Paid - Reported"]) {
    assert.equal(
      shouldShowDatasetGridTotals({ isDfmHost: false, formula }),
      true,
      formula,
    );
  }
});

test("the grid applies the total policy using its configured host", () => {
  assert.match(gridViewSource, /isDfmHost:\s*isDfmDataTabHost\(\)/u);
  assert.match(gridViewSource, /formula:\s*getCurrentDatasetTypeFormula\(\)/u);
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

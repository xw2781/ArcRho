import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const tooltipStub = "export function attachArcrhoTooltip() {}";
const tooltipStubUrl = `data:text/javascript;base64,${Buffer.from(tooltipStub).toString("base64")}`;
let moduleSource = await readFile(
  new URL("../ui/project_instance/project_instance_excel_links.js", import.meta.url),
  "utf8",
);
moduleSource = moduleSource.replace(
  '"/ui/shared/components/tooltip/tooltip.js?v=20260812a"',
  JSON.stringify(tooltipStubUrl),
);
const excelLinks = await import(
  `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`
);

const htmlSource = await readFile(
  new URL("../ui/project_instance/project_instance.html", import.meta.url),
  "utf8",
);
const bootSource = await readFile(
  new URL("../ui/project_instance/project_instance_boot.js", import.meta.url),
  "utf8",
);
const pathPanelSource = await readFile(
  new URL("../ui/project_instance/project_instance_path_panel.js", import.meta.url),
  "utf8",
);

test("normalizeExcelLinkWorkbooks keeps valid rows and normalizes usage kinds", () => {
  const workbooks = excelLinks.normalizeExcelLinkWorkbooks([
    {
      workbook_path: "C:\\Data\\Book.xlsx",
      workbook_name: "Book.xlsx",
      folder: "C:\\Data\\",
      exists: true,
      dataset_count: 2,
      method_count: 1,
      link_count: 3,
      cell_count: 9,
      usages: [
        { kind: "dataset", name: "Manual Paid", link_count: 2 },
        { kind: "dfm", name: "Development", link_count: 1 },
        { kind: "dfm", name: "   ", link_count: 1 },
      ],
    },
    { workbook_path: "   ", workbook_name: "Dropped.xlsx" },
  ]);

  assert.equal(workbooks.length, 1);
  assert.equal(workbooks[0].workbookName, "Book.xlsx");
  assert.equal(workbooks[0].datasetCount, 2);
  assert.equal(workbooks[0].methodCount, 1);
  assert.deepEqual(
    workbooks[0].usages.map((usage) => [usage.kind, usage.name]),
    [["dataset", "Manual Paid"], ["dfm", "Development"]],
  );
});

test("excelLinkUsageSummary and tooltip describe datasets and DFM methods", () => {
  const workbook = {
    datasetCount: 2,
    methodCount: 1,
    usages: [
      { kind: "dataset", name: "Manual Paid" },
      { kind: "dataset", name: "Manual Incurred" },
      { kind: "dfm", name: "Development" },
    ],
  };
  assert.equal(excelLinks.excelLinkUsageSummary(workbook), "2 datasets, 1 DFM method");
  assert.equal(
    excelLinks.excelLinkUsageTooltip(workbook),
    "Dataset: Manual Paid\nDataset: Manual Incurred\nDFM: Development",
  );
  assert.equal(excelLinks.excelLinkUsageSummary({ datasetCount: 0, methodCount: 0 }), "Unused");
});

test("excelLinkRetargetSummary reports success, no-op, and partial failures", () => {
  const success = excelLinks.excelLinkRetargetSummary({
    results: [
      { kind: "dataset", name: "Manual Paid", ok: true },
      { kind: "dfm", name: "Development", ok: true },
    ],
    changed_file_count: 2,
    changed_link_count: 3,
  });
  assert.equal(success.ok, true);
  assert.match(success.message, /Updated 3 links in 2 files/);

  const noop = excelLinks.excelLinkRetargetSummary({
    results: [],
    changed_file_count: 0,
    message: "The selected workbook is already the current link.",
  });
  assert.equal(noop.ok, true);
  assert.match(noop.message, /already the current link/);

  const partial = excelLinks.excelLinkRetargetSummary({
    results: [
      { kind: "dataset", name: "Manual Paid", ok: true },
      { kind: "dfm", name: "Development", ok: false, error: "DFM changed on disk." },
      { kind: "dfm", name: "Tail", ok: false, error: "locked" },
    ],
    changed_file_count: 1,
    changed_link_count: 1,
  });
  assert.equal(partial.ok, false);
  assert.match(partial.message, /Development: DFM changed on disk\./);
  assert.match(partial.message, /\(\+1 more\)/);
});

test("excelLinkRetargetSummary reports recalculation outcomes", () => {
  const recalculated = excelLinks.excelLinkRetargetSummary({
    results: [{ kind: "dataset", name: "Manual Paid", ok: true, value_changed: true }],
    changed_file_count: 2,
    changed_link_count: 3,
    refresh_requested: true,
    refreshed_cell_count: 5,
    failed_refresh_count: 0,
    value_changed_file_count: 2,
    propagation_ok: true,
  });
  assert.equal(recalculated.ok, true);
  assert.match(recalculated.message, /Recalculated 5 linked cells in 2 files/);
  assert.match(recalculated.message, /Dependent recalculation has started/);

  const unchanged = excelLinks.excelLinkRetargetSummary({
    results: [{ kind: "dataset", name: "Manual Paid", ok: true }],
    changed_file_count: 1,
    changed_link_count: 1,
    refresh_requested: true,
    refreshed_cell_count: 2,
    failed_refresh_count: 0,
    value_changed_file_count: 0,
  });
  assert.equal(unchanged.ok, true);
  assert.match(unchanged.message, /matches the stored values/);

  const failedCells = excelLinks.excelLinkRetargetSummary({
    results: [{ kind: "dfm", name: "Development", ok: true }],
    changed_file_count: 1,
    changed_link_count: 1,
    refresh_requested: true,
    refreshed_cell_count: 1,
    failed_refresh_count: 2,
    value_changed_file_count: 0,
  });
  assert.equal(failedCells.ok, false);
  assert.match(failedCells.message, /2 linked cells could not be recalculated/);
});

test("project instance wires the toolbar button, window, and path sync", () => {
  assert.match(htmlSource, /id="excelLinksBtn"/);
  assert.ok(
    htmlSource.indexOf('id="excelLinksBtn"') < htmlSource.indexOf('id="datasetRefreshBtn"'),
    "Excel links button should sit before the refresh button",
  );
  for (const id of [
    "excelLinksWindow",
    "excelLinksHeader",
    "excelLinksPath",
    "excelLinksRefresh",
    "excelLinksRefreshValues",
    "excelLinksClose",
    "excelLinksBody",
    "excelLinksState",
    "excelLinksStatus",
  ]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(htmlSource, /project_instance_excel_links\.css\?v=\d{8}[a-z]/);
  assert.match(bootSource, /installProjectInstanceExcelLinks\(ctx\)/);
  assert.match(bootSource, /api\.initExcelLinkManager\(\)/);
  assert.match(pathPanelSource, /api\.syncExcelLinkManagerPath\?\.\(\)/);
});

test("the recalculation checkbox always defaults back to No", () => {
  const checkboxSource = moduleSource;
  assert.match(checkboxSource, /refresh_values: refreshValues/, "request carries the checkbox state");
  const resetCalls = (checkboxSource.match(/resetRefreshValuesChoice\(\)/g) || []).length;
  assert.ok(resetCalls >= 3, "checkbox resets on open and after every change");
  const openBody = checkboxSource.slice(
    checkboxSource.indexOf("function openExcelLinkManager"),
    checkboxSource.indexOf("function closeExcelLinkManager"),
  );
  assert.match(openBody, /resetRefreshValuesChoice\(\)/, "opening the window resets the choice");
  const changeBody = checkboxSource.slice(
    checkboxSource.indexOf("async function changeWorkbook"),
    checkboxSource.indexOf("function openExcelLinkManager"),
  );
  assert.match(changeBody, /finally[\s\S]*resetRefreshValuesChoice\(\)/, "every change resets the choice");
  assert.doesNotMatch(checkboxSource, /excelLinksRefreshValues\.checked = true/, "nothing pre-checks the box");
});

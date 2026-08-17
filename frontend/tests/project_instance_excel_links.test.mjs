import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const tooltipStub = "export function attachArcrhoTooltip() {}";
const tooltipStubUrl = `data:text/javascript;base64,${Buffer.from(tooltipStub).toString("base64")}`;
let moduleSource = await readFile(
  new URL("../ui/project_instance/excel_links_window.js", import.meta.url),
  "utf8",
);
moduleSource = moduleSource.replace(
  '"/ui/shared/components/tooltip/tooltip.js?v=20260812a"',
  JSON.stringify(tooltipStubUrl),
);
// The page module reads the DOM and starts a load as soon as it is imported;
// only its exported pure helpers are exercised here.
const importableSource = moduleSource
  .replace(/^import "\/ui\/shared\/integrations\/zoom_bridge\.js[^"]*";$/m, "")
  .replace(/^const params = new URLSearchParams[\s\S]*$/m, "");
const excelLinks = await import(
  `data:text/javascript;base64,${Buffer.from(importableSource).toString("base64")}`
);

const htmlSource = await readFile(
  new URL("../ui/project_instance/project_instance.html", import.meta.url),
  "utf8",
);
const windowHtmlSource = await readFile(
  new URL("../ui/project_instance/excel_links_window.html", import.meta.url),
  "utf8",
);
const hostSource = await readFile(
  new URL("../ui/project_instance/project_instance_excel_links.js", import.meta.url),
  "utf8",
);
const bootSource = await readFile(
  new URL("../ui/project_instance/project_instance_boot.js", import.meta.url),
  "utf8",
);
const messagesSource = await readFile(
  new URL("../ui/project_instance/project_instance_messages.js", import.meta.url),
  "utf8",
);
const windowsSource = await readFile(
  new URL("../ui/project_instance/project_instance_windows.js", import.meta.url),
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

test("the manager is a nested window page, not inline Project Instance markup", () => {
  assert.match(htmlSource, /id="excelLinksBtn"/);
  assert.ok(
    htmlSource.indexOf('id="excelLinksBtn"') < htmlSource.indexOf('id="datasetRefreshBtn"'),
    "Excel links button should sit before the refresh button",
  );
  // The manager's own markup and stylesheet moved out of the host page so the
  // frame can be closed and removed like any other nested window.
  for (const gone of [
    'id="excelLinksWindow"',
    'id="excelLinksRefresh"',
    'id="excelLinksBody"',
    'id="excelLinksStatus"',
    "project_instance_excel_links.css",
  ]) {
    assert.ok(!htmlSource.includes(gone), `${gone} should no longer be in project_instance.html`);
  }
  for (const id of ["excelLinksRefresh", "excelLinksRefreshValues", "excelLinksBody", "excelLinksState", "excelLinksStatus"]) {
    assert.match(windowHtmlSource, new RegExp(`id="${id}"`), `missing #${id} in the window page`);
  }
  assert.match(windowHtmlSource, /excel_links_window\.css\?v=\d{8}[a-z]/);
  assert.match(windowHtmlSource, /excel_links_window\.js\?v=\d{8}[a-z]/);
  assert.match(bootSource, /installProjectInstanceExcelLinks\(ctx\)/);
  assert.match(bootSource, /api\.initExcelLinkManager\(\)/);
});

test("opening the manager creates a standard pi-window pinned to its class", () => {
  assert.match(hostSource, /createFloatingContentWindow\(\{/, "the manager uses the canonical window factory");
  assert.match(hostSource, /kind: "excel_links"/);
  assert.match(hostSource, /excel_links_window\.html\?/);
  assert.match(hostSource, /title: `\$\{path\}\\\\Excel Links`/, "the titlebar names the reserving class");
  // Pinned, like every other nested window: the path panel no longer reloads it.
  assert.ok(
    !pathPanelSource.includes("syncExcelLinkManagerPath"),
    "selecting another reserving class must not reload the window",
  );
  assert.ok(
    !hostSource.includes("syncExcelLinkManagerPath"),
    "the pinned window exposes no path-follow hook",
  );
  // A tool window is not part of the saved/restored Project Instance state.
  assert.match(windowsSource, /windowKind === "excel_links"\) return null/);
});

test("the retarget tells the host to quiet its index watch and reload the table", () => {
  assert.match(moduleSource, /arcrho:excel-links-retarget-begin/);
  assert.match(moduleSource, /arcrho:excel-links-retarget-end/);
  assert.match(messagesSource, /arcrho:excel-links-retarget-begin/);
  assert.match(messagesSource, /api\.handleExcelLinksWindowMessage\(msg, event\.source\)/);
  assert.match(hostSource, /suppressIndexWatch\(RETARGET_INDEX_WATCH_SUPPRESS_MS\)/);
  assert.match(hostSource, /refreshCachedDatasetTableFromDisk/);
  const changeBody = moduleSource.slice(moduleSource.indexOf("async function changeWorkbook"));
  assert.match(
    changeBody,
    /finally \{[\s\S]*arcrho:excel-links-retarget-end/,
    "the host is always told the retarget finished",
  );
});

test("the recalculation checkbox always defaults back to No", () => {
  assert.match(moduleSource, /refresh_values: refreshValues/, "request carries the checkbox state");
  const resetCalls = (moduleSource.match(/resetRefreshValuesChoice\(\)/g) || []).length;
  assert.ok(resetCalls >= 3, "checkbox resets on load and after every change");
  const boot = moduleSource.slice(moduleSource.indexOf("els.refresh?.addEventListener"));
  assert.match(boot, /resetRefreshValuesChoice\(\)/, "opening the window resets the choice");
  const changeBody = moduleSource.slice(
    moduleSource.indexOf("async function changeWorkbook"),
    moduleSource.indexOf("els.refresh?.addEventListener"),
  );
  assert.match(changeBody, /finally[\s\S]*resetRefreshValuesChoice\(\)/, "every change resets the choice");
  assert.doesNotMatch(moduleSource, /refreshValues\.checked = true/, "nothing pre-checks the box");
});

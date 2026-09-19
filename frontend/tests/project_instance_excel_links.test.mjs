import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stubUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const tooltipStubUrl = stubUrl("export function attachArcrhoTooltip() {}");
const menuStubUrl = stubUrl("export function openContextMenu() {}");
const openPathStubUrl = stubUrl("export function openPathThroughDesktopHost() {}");
const messageBoxStubUrl = stubUrl("export function showPageMessageBox() {}");
const progressPopupStubUrl = stubUrl("export function createArcRhoBusyOverlay() { return { begin() { return { dismiss() {} }; } }; }");
const tableStubUrl = stubUrl(
  "export function createExcelLinksTable() { return { setRows() {}, getSelectedRows() { return []; }, clearSelection() {}, closeFilterPopover() {} }; }\n"
  + "export function excelLinkDetailRows() { return []; }",
);

const TOOLTIP_IMPORT = /"\/ui\/shared\/components\/tooltip\/tooltip\.js\?v=\d{8}[a-z]"/;
const MENU_IMPORT = /"\/ui\/shared\/components\/context_menu\/context_menu\.js\?v=\d{8}[a-z]"/;
const TIMESTAMP_IMPORT = /"\/ui\/shared\/utils\/timestamp\.js\?v=\d{8}[a-z]"/;
const STATUS_ICON_IMPORT = /"\/ui\/shared\/components\/status_icon\/status_icon\.js\?v=\d{8}[a-z]"/;
// Not a stub: the table's Created and Last Modified must read exactly as the
// dataset table's do, so the real shared formatter is what runs here.
const timestampUrl = new URL("../ui/shared/utils/timestamp.js", import.meta.url).href;
const { formatArcrhoTimestamp } = await import(timestampUrl);
// Likewise the Status glyphs: the real module the dataset table draws from.
const statusIconUrl = new URL("../ui/shared/components/status_icon/status_icon.js", import.meta.url).href;

const rawModuleSource = await readFile(
  new URL("../ui/project_instance/excel_links_window.js", import.meta.url),
  "utf8",
);
const rawTableSource = await readFile(
  new URL("../ui/project_instance/excel_links_table.js", import.meta.url),
  "utf8",
);
let moduleSource = rawModuleSource
  .replace(TOOLTIP_IMPORT, JSON.stringify(tooltipStubUrl))
  .replace(MENU_IMPORT, JSON.stringify(menuStubUrl))
  .replace(/"\/ui\/shared\/integrations\/open_path\.js\?v=\d{8}[a-z]"/, JSON.stringify(openPathStubUrl))
  .replace(/"\/ui\/shared\/components\/message_box\/message_box\.js\?v=\d{8}[a-z]"/, JSON.stringify(messageBoxStubUrl))
  .replace(/"\/ui\/shared\/components\/progress_popup\/progress_popup\.js\?v=\d{8}[a-z]"/, JSON.stringify(progressPopupStubUrl))
  .replace(/"\/ui\/project_instance\/excel_links_table\.js\?v=\d{8}[a-z]"/, JSON.stringify(tableStubUrl));
// The page module reads the DOM and starts a load as soon as it is imported;
// only its exported pure helpers are exercised here.
const importableSource = moduleSource
  .replace(/^import "\/ui\/shared\/integrations\/zoom_bridge\.js[^"]*";$/m, "")
  .replace(/^const params = new URLSearchParams[\s\S]*$/m, "");
const excelLinks = await import(stubUrl(importableSource));
// The table module only touches the DOM from inside its functions, so it
// imports whole once its two component imports are stubbed.
const excelLinksTable = await import(stubUrl(
  rawTableSource
    .replace(TOOLTIP_IMPORT, JSON.stringify(tooltipStubUrl))
    .replace(MENU_IMPORT, JSON.stringify(menuStubUrl))
    .replace(TIMESTAMP_IMPORT, JSON.stringify(timestampUrl))
    .replace(STATUS_ICON_IMPORT, JSON.stringify(statusIconUrl)),
));

const htmlSource = await readFile(
  new URL("../ui/project_instance/project_instance.html", import.meta.url),
  "utf8",
);
const datasetTableSource = await readFile(
  new URL("../ui/project_instance/project_instance_dataset_table.js", import.meta.url),
  "utf8",
);
const windowHtmlSource = await readFile(
  new URL("../ui/project_instance/excel_links_window.html", import.meta.url),
  "utf8",
);
const windowCssSource = await readFile(
  new URL("../ui/project_instance/excel_links_window.css", import.meta.url),
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

const LISTING = [
  {
    workbook_path: "C:\\Data\\Book.xlsx",
    workbook_name: "Book.xlsx",
    folder: "C:\\Data\\",
    exists: true,
    created: "2024-03-02T09:15:41Z",
    modified: "2026-08-14T16:22:07Z",
    last_modified_by: "j.tanaka",
    dataset_count: 2,
    method_count: 1,
    link_count: 4,
    cell_count: 9,
    usages: [
      { kind: "dataset", name: "Manual Paid", dataset_type: "Paid Loss", method_type: "None", status: "needs_review", link_count: 2, cell_count: 6 },
      { kind: "dataset", name: "Manual Incurred", dataset_type: "Manual Incurred", method_type: "Result Selection", status: "updated", link_count: 1, cell_count: 2 },
      { kind: "dfm", name: "Development", dataset_type: "", method_type: "DFM", status: "updated", link_count: 1, cell_count: 1 },
    ],
  },
  {
    workbook_path: "C:\\Other\\Tail.xlsx",
    workbook_name: "Tail.xlsx",
    folder: "C:\\Other\\",
    exists: false,
    dataset_count: 0,
    method_count: 1,
    link_count: 1,
    cell_count: 1,
    // A workbook the server cannot open has no status to report.
    usages: [{ kind: "dfm", name: "Tail", method_type: "DFM", status: "", link_count: 1, cell_count: 1 }],
  },
];

test("normalizeExcelLinkWorkbooks keeps valid rows and normalizes usage kinds", () => {
  const workbooks = excelLinks.normalizeExcelLinkWorkbooks([
    LISTING[0],
    { workbook_path: "   ", workbook_name: "Dropped.xlsx" },
    { ...LISTING[0], usages: [{ kind: "dfm", name: "   ", link_count: 1 }] },
  ]);

  assert.equal(workbooks.length, 2);
  assert.equal(workbooks[0].workbookName, "Book.xlsx");
  assert.equal(workbooks[0].datasetCount, 2);
  assert.equal(workbooks[0].methodCount, 1);
  assert.deepEqual(
    workbooks[0].usages.map((usage) => [usage.kind, usage.name, usage.linkCount]),
    [["dataset", "Manual Paid", 2], ["dataset", "Manual Incurred", 1], ["dfm", "Development", 1]],
  );
  assert.equal(workbooks[0].usages[0].datasetType, "Paid Loss", "the instance's Dataset Type travels with it");
  assert.deepEqual(workbooks[1].usages, [], "a usage with no name is dropped");
});

test("excelLinkDetailRows gives every usage its own row", () => {
  const rows = excelLinksTable.excelLinkDetailRows(excelLinks.normalizeExcelLinkWorkbooks(LISTING));
  assert.equal(rows.length, 4, "three usages of Book.xlsx plus one of Tail.xlsx");
  assert.deepEqual(
    rows.map((row) => [row.workbookName, row.kind, row.name]),
    [
      ["Book.xlsx", "dataset", "Manual Paid"],
      ["Book.xlsx", "dataset", "Manual Incurred"],
      ["Book.xlsx", "dfm", "Development"],
      ["Tail.xlsx", "dfm", "Tail"],
    ],
  );
  // The workbook's path and found/missing verdict repeat on each of its rows,
  // which is what lets the Workbook Path column filter and the missing cue work.
  assert.equal(rows[1].folder, "C:\\Data\\");
  assert.equal(excelLinksTable.excelLinkCellText(rows[1], "workbookPath"), "C:\\Data\\Book.xlsx");
  assert.equal(rows[1].exists, true);
  assert.equal(rows[3].exists, false);
  assert.equal(rows[0].datasetType, "Paid Loss");
  assert.equal(rows[0].methodType, "None");
  // Until the listing carries method_type, the usage kind stands in for it.
  assert.equal(excelLinksTable.excelLinkCellText({ kind: "dfm" }, "methodType"), "DFM");
  assert.equal(excelLinksTable.excelLinkCellText({ kind: "dataset" }, "methodType"), "None");
  assert.equal(excelLinksTable.excelLinkCellText({ kind: "dataset", methodType: "Cape Cod" }, "methodType"), "Cape Cod");
  // A workbook with no readable usage still shows, so it can be relinked.
  assert.deepEqual(
    excelLinksTable.excelLinkDetailRows([{ workbookName: "Empty.xlsx", usages: [] }])
      .map((row) => [row.workbookName, row.kind, row.name]),
    [["Empty.xlsx", "", ""]],
  );
});

test("the table columns name the detail row and carry explicit widths", () => {
  assert.deepEqual(
    excelLinksTable.EXCEL_LINK_COLUMNS.map((col) => col.key),
    ["name", "status", "methodType", "workbookPath", "lastModified", "created", "user"],
    "Status sits right after Dataset Name; Workbook and Location became one Workbook Path column",
  );
  const byKey = new Map(excelLinksTable.EXCEL_LINK_COLUMNS.map((col) => [col.key, col]));
  assert.equal(byKey.get("name").label, "Dataset Name");
  assert.equal(byKey.get("status").label, "Status");
  assert.equal(byKey.get("methodType").label, "Method Type");
  assert.equal(byKey.get("workbookPath").label, "Workbook Path");
  // The three workbook-metadata columns are named exactly as the dataset
  // table's, because they answer the same question about a different object.
  assert.equal(byKey.get("lastModified").label, "Last Modified");
  assert.equal(byKey.get("created").label, "Created");
  assert.equal(byKey.get("user").label, "User");
  for (const col of excelLinksTable.EXCEL_LINK_COLUMNS) {
    assert.ok(Number.isFinite(col.width) && col.width >= col.minWidth, `${col.key} needs an explicit width`);
    assert.ok(col.filterable, `${col.key} should be filterable`);
  }
});

test("column filters keep the rows every active column accepts", () => {
  const rows = excelLinksTable.excelLinkDetailRows(excelLinks.normalizeExcelLinkWorkbooks(LISTING));
  assert.deepEqual(
    excelLinksTable.excelLinkColumnOptions(rows, "methodType").map((option) => option.value),
    ["DFM", "None", "Result Selection"],
    "Method Type carries the same values the dataset table shows",
  );
  assert.deepEqual(
    excelLinksTable.excelLinkColumnOptions(rows, "workbookPath").map((option) => option.label),
    ["C:\\Data\\Book.xlsx", "C:\\Other\\Tail.xlsx"],
  );

  const noFilter = excelLinksTable.filterExcelLinkRows(rows, new Map());
  assert.equal(noFilter.length, 4);

  const dfmOnly = excelLinksTable.filterExcelLinkRows(rows, new Map([["methodType", new Set(["DFM"])]]));
  assert.deepEqual(dfmOnly.map((row) => row.name), ["Development", "Tail"]);

  const both = excelLinksTable.filterExcelLinkRows(rows, new Map([
    ["methodType", new Set(["DFM"])],
    ["workbookPath", new Set(["C:\\Data\\Book.xlsx"])],
  ]));
  assert.deepEqual(both.map((row) => row.name), ["Development"]);

  // An empty selection means "all", so a filter never hides everything by itself.
  assert.equal(excelLinksTable.filterExcelLinkRows(rows, new Map([["methodType", new Set()]])).length, 4);

  // Reloading the listing drops filter values the new rows no longer contain.
  const filters = new Map([["name", new Set(["Manual Paid", "Gone"])], ["methodType", new Set(["Missing"])]]);
  excelLinksTable.pruneExcelLinkFilters(filters, rows);
  assert.deepEqual([...filters.get("name")], ["Manual Paid"]);
  assert.ok(!filters.has("type"), "a filter left with no live value is cleared");
});

test("the Status column is the dataset table's review glyph, settled by the listing", () => {
  const rows = excelLinksTable.excelLinkDetailRows(excelLinks.normalizeExcelLinkWorkbooks(LISTING));
  // Opening the window is the check: the server compares each workbook's file
  // time with the file holding the row's linked values, and the row shows the
  // verdict. A workbook the server cannot open settles nothing and stays blank.
  assert.deepEqual(
    rows.map((row) => [row.name, excelLinksTable.excelLinkCellText(row, "status")]),
    [["Manual Paid", "Needs Review"], ["Manual Incurred", "Updated"], ["Development", "Updated"], ["Tail", ""]],
  );
  assert.deepEqual(
    excelLinksTable.excelLinkColumnOptions(rows, "status").map((option) => option.label),
    ["(blank)", "Needs Review", "Updated"],
  );
  // The glyph is the one the dataset table paints, from the one module both
  // tables draw it from, coloured by the pi_table.css rules the window loads.
  assert.match(rawTableSource, STATUS_ICON_IMPORT);
  assert.match(datasetTableSource, STATUS_ICON_IMPORT);
  assert.doesNotMatch(datasetTableSource, /pi-status-icon warning/, "the dataset table no longer carries its own copy");
  assert.match(rawTableSource, /className = `pi-status-cell \$\{needsReview \? "warning" : "updated"\}`/);
  assert.match(rawTableSource, /wrap\.innerHTML = reviewStatusIconSvg\(needsReview\)/);
  assert.match(rawTableSource, /if \(!value\) return td;/, "a blank verdict leaves the cell empty");
  assert.match(windowHtmlSource, /\/ui\/shared\/styles\/pi_table\.css\?v=\d{8}[a-z]/);
  assert.match(windowCssSource, /td\.pi-excel-links-cell\.status \{\s*text-align: center;/);
  // The status line counts the rows that need review.
  assert.equal(
    excelLinks.excelLinkInventorySummary({ workbookCount: 2, visibleRows: 4, totalRows: 4, needsReviewCount: 1 }),
    "2 linked workbooks, 4 references. 1 reference needs review.",
  );
  assert.equal(
    excelLinks.excelLinkInventorySummary({ workbookCount: 2, visibleRows: 4, totalRows: 4, needsReviewCount: 2, scanErrorCount: 1 }),
    "2 linked workbooks, 4 references. 2 references need review. 1 file could not be read.",
  );
  assert.match(rawModuleSource, /const STATUS_NEEDS_REVIEW = "needs_review";/);
  assert.match(rawModuleSource, /needsReviewCount: manager\.rows\.filter\(\(row\) => row\.status === STATUS_NEEDS_REVIEW\)\.length/);
});

test("clicking a header sorts by that column, then reverses, then restores the listing order", () => {
  const rows = excelLinksTable.excelLinkDetailRows(excelLinks.normalizeExcelLinkWorkbooks(LISTING));
  const names = (sorted) => sorted.map((row) => row.name);
  assert.deepEqual(names(excelLinksTable.sortExcelLinkRows(rows, { key: "name", dir: "asc" })),
    ["Development", "Manual Incurred", "Manual Paid", "Tail"]);
  assert.deepEqual(names(excelLinksTable.sortExcelLinkRows(rows, { key: "name", dir: "desc" })),
    ["Tail", "Manual Paid", "Manual Incurred", "Development"]);
  // Ties keep the listing's order, and no key means the listing's order.
  assert.deepEqual(names(excelLinksTable.sortExcelLinkRows(rows, { key: "methodType", dir: "asc" })),
    ["Development", "Tail", "Manual Paid", "Manual Incurred"]);
  assert.deepEqual(names(excelLinksTable.sortExcelLinkRows(rows, { key: "", dir: "asc" })), names(rows));
  assert.deepEqual(names(excelLinksTable.sortExcelLinkRows(rows, { key: "nope", dir: "desc" })), names(rows));
  // Dates order by the moment they name, with an undated workbook first.
  assert.deepEqual(
    names(excelLinksTable.sortExcelLinkRows(rows, { key: "lastModified", dir: "asc" })),
    ["Tail", "Manual Paid", "Manual Incurred", "Development"],
  );
  assert.deepEqual(names(excelLinksTable.sortExcelLinkRows(rows, { key: "status", dir: "asc" })),
    ["Tail", "Manual Paid", "Manual Incurred", "Development"]);
  assert.ok(Object.isFrozen(rows) === false && rows[0].name === "Manual Paid", "sorting never reorders the source rows");
  // The header wiring: the label toggles asc -> desc -> off and carries the
  // dataset table's sort triangle; the cell exposes the state to assistive tech.
  assert.match(rawTableSource, /if \(sort\.key === key && sort\.dir === "desc"\) sort = \{ key: "", dir: "asc" \};/);
  assert.match(rawTableSource, /label\.addEventListener\("click", \(\) => toggleSort\(col\.key\)\)/);
  assert.match(rawTableSource, /th\.setAttribute\("aria-sort"/);
  assert.match(rawTableSource, /label\.appendChild\(sortIconSvg\(sort\.dir\)\)/);
  assert.match(rawTableSource, /visibleRows = sortExcelLinkRows\(filterExcelLinkRows\(rows, filters\), sort\)/);
  assert.match(windowCssSource, /\.pi-excel-links-col-label\.is-sorted \{ padding-right: 12px; \}/);
  assert.match(windowCssSource, /\.pi-excel-links-sort-icon \{[\s\S]*position: absolute;/);
  assert.match(windowHtmlSource, /a header to sort\./);
});

test("excelLinkInventorySummary counts workbooks, references, and hidden rows", () => {
  assert.equal(
    excelLinks.excelLinkInventorySummary({ workbookCount: 2, visibleRows: 4, totalRows: 4 }),
    "2 linked workbooks, 4 references.",
  );
  assert.equal(
    excelLinks.excelLinkInventorySummary({ workbookCount: 2, visibleRows: 1, totalRows: 4 }),
    "2 linked workbooks, 1 of 4 references shown.",
  );
  assert.match(
    excelLinks.excelLinkInventorySummary({ workbookCount: 1, visibleRows: 1, totalRows: 1, scanErrorCount: 2 }),
    /1 linked workbook, 1 reference\. 2 files could not be read\./,
  );
  assert.equal(excelLinks.excelLinkInventorySummary({ workbookCount: 0, visibleRows: 0, totalRows: 0 }), "");
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

test("excelLinkRetargetSummary reports the server-side refresh outcome", () => {
  const refreshed = excelLinks.excelLinkRetargetSummary({
    results: [{ kind: "dataset", name: "Manual Paid", ok: true, value_changed: true }],
    changed_file_count: 2,
    changed_link_count: 3,
    refreshed_cell_count: 5,
    failed_refresh_count: 0,
    value_changed_file_count: 2,
    propagation: { ok: true, status: "completed", refreshed_datasets: ["Ultimate"] },
    propagation_ok: true,
  });
  assert.equal(refreshed.ok, true);
  assert.match(refreshed.message, /Updated 3 links in 2 files; recalculated 5 linked cells \(values changed in 2 files\)/);
  assert.match(refreshed.message, /marked Needs Review/);

  // Same numbers in the new workbook: still a change, still flagged for review.
  const unchanged = excelLinks.excelLinkRetargetSummary({
    results: [{ kind: "dataset", name: "Manual Paid", ok: true }],
    changed_file_count: 1,
    changed_link_count: 1,
    refreshed_cell_count: 2,
    failed_refresh_count: 0,
    value_changed_file_count: 0,
    propagation: { ok: true, status: "queued", job_id: "abc" },
    propagation_ok: true,
  });
  assert.equal(unchanged.ok, true);
  assert.match(unchanged.message, /stored values already matched/);
  assert.match(unchanged.message, /Dependent recalculation has started; affected objects are marked Needs Review/);

  const failedCells = excelLinks.excelLinkRetargetSummary({
    results: [{ kind: "dfm", name: "Development", ok: true }],
    changed_file_count: 1,
    changed_link_count: 1,
    refreshed_cell_count: 1,
    failed_refresh_count: 2,
    value_changed_file_count: 0,
    propagation_ok: true,
  });
  assert.equal(failedCells.ok, false);
  assert.match(failedCells.message, /2 linked cells could not be recalculated and kept the stored values/);

  const walkTrouble = excelLinks.excelLinkRetargetSummary({
    results: [{ kind: "dataset", name: "Manual Paid", ok: true }],
    changed_file_count: 1,
    changed_link_count: 1,
    refreshed_cell_count: 1,
    propagation: { ok: false, status: "completed", message: "boom" },
    propagation_ok: false,
  });
  assert.equal(walkTrouble.ok, false);
  assert.match(walkTrouble.message, /Dependent recalculation reported a problem/);
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
  for (const id of [
    "excelLinksRefreshAll",
    "excelLinksWorking",
    "excelLinksTable",
    "excelLinksTableWrap",
    "excelLinksState",
    "excelLinksStatus",
    "excelLinksMenu",
    "excelLinksFilterPopover",
  ]) {
    assert.match(windowHtmlSource, new RegExp(`id="${id}"`), `missing #${id} in the window page`);
  }
  assert.match(windowHtmlSource, /excel_links_window\.css\?v=\d{8}[a-z]/);
  assert.match(windowHtmlSource, /excel_links_window\.js\?v=\d{8}[a-z]/);
  assert.match(rawModuleSource, /excel_links_table\.js\?v=\d{8}[a-z]/);
  assert.match(bootSource, /installProjectInstanceExcelLinks\(ctx\)/);
  assert.match(bootSource, /api\.initExcelLinkManager\(\)/);
});

test("opening the manager creates a standard pi-window pinned to its class", () => {
  assert.match(hostSource, /createFloatingContentWindow\(\{/, "the manager uses the canonical window factory");
  assert.match(hostSource, /kind: "excel_links"/);
  assert.match(hostSource, /excel_links_window\.html\?/);
  assert.match(hostSource, /title: `\$\{path\}\\\\Manage Excel Links`/, "the titlebar names the reserving class");
  assert.match(windowHtmlSource, /<title>Manage Excel Links<\/title>/);
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
  const changeBody = moduleSource.slice(moduleSource.indexOf("async function changeWorkbook"));
  assert.match(
    changeBody,
    /finally \{[\s\S]*arcrho:excel-links-retarget-end/,
    "the host is always told the retarget finished",
  );
  // Every changed file was re-saved and flagged, so the table reloads on any
  // changed file, not only when a value moved.
  assert.match(hostSource, /Number\(message\.changedFileCount\) > 0\) \{[\s\S]*refreshCachedDatasetTableFromDisk/);
  assert.doesNotMatch(hostSource, /valueChangedFileCount/);
});

test("the row menu opens, relinks, and - on a Workbook Path cell - opens the folder", () => {
  // No Status column, no per-row button, no recalculation choice: the toolbar
  // holds the refresh icon and the row's right-click menu holds the actions.
  for (const gone of [
    "pi-excel-links-header",
    "pi-excel-links-hint",
    "excelLinksRefreshValues",
    "pi-excel-links-refresh-option",
    "<th>Status</th>",
    "Used By",
    "Change...",
  ]) {
    assert.ok(!windowHtmlSource.includes(gone), `${gone} should no longer be in the window page`);
  }
  assert.match(windowHtmlSource, /class="pi-excel-links-toolbar"[\s\S]*id="excelLinksRefreshAll"/);
  assert.match(windowHtmlSource, /class="ctx-menu pi-excel-links-menu" id="excelLinksMenu"/);
  for (const action of [
    "open-object", "copy-name", "open-workbook", "open-workbook-read-only",
    "open-folder", "copy-path", "refresh-links", "change-link",
  ]) {
    assert.match(windowHtmlSource, new RegExp(`class="ctx-item"[^>]*data-action="${action}"`));
  }
  // The column under the pointer decides which half of the menu is shown: the
  // object's actions on the first three columns, the workbook's on the rest,
  // with the link actions in both.
  assert.match(moduleSource, /const DATASET_MENU_COLUMNS = new Set\(\["name", "status", "methodType"\]\)/);
  assert.match(moduleSource, /for \(const action of \["open-object", "copy-name"\]\) show\(action, datasetScope\)/);
  assert.match(moduleSource, /show\(action, !datasetScope\);/);
  assert.match(moduleSource, /show\("open-folder", !datasetScope && folders\.length > 0\)/);
  // Breaking is destructive, so it is the one red item.
  assert.match(windowHtmlSource, /class="ctx-item danger"[^>]*data-action="break-links"/);
  assert.match(windowCssSource, /\.pi-excel-links-menu \.ctx-item\.danger:not\(:disabled\)[\s\S]*var\(--ar-color-danger\)/);
  // The pointer takes the keyboard focus with it, so the first item cannot
  // stay highlighted while the pointer highlights another.
  assert.match(moduleSource, /addEventListener\("pointerover", \(event\) => \{\s*focusMenuItem/);
  // Both link actions read singular or plural from the rows selected.
  assert.match(moduleSource, /item\("refresh-links"\)\.textContent = links > 1 \? "Refresh links" : "Refresh link"/);
  assert.match(moduleSource, /item\("break-links"\)\.textContent = links > 1 \? "Break links" : "Break link"/);
  assert.match(rawModuleSource, /import \{ openPathThroughDesktopHost \} from "\/ui\/shared\/integrations\/open_path\.js\?v=\d{8}[a-z]"/);
  assert.match(moduleSource, /openPathThroughDesktopHost\(path, \{ readOnly: !!readOnly \}\)/);
  assert.match(moduleSource, /opened in File Explorer\./);
  // The menu acts on every highlighted row: each distinct workbook or folder
  // opens in turn, and a link change needs exactly one workbook highlighted.
  assert.match(moduleSource, /const workbooks = distinct\(rows, \(row\) => row\.workbookPath\)/);
  assert.match(moduleSource, /item\("change-link"\)\.disabled = many;/);
  assert.match(moduleSource, /else if \(action === "refresh-links"\) void refreshLinks\(rows, "selected"\)/);
  assert.match(moduleSource, /else if \(action === "change-link"\) void changeWorkbook\(rows\[0\]\)/);
  assert.match(moduleSource, /function closeMenu\(\) \{[\s\S]*els\.menu\.style\.display = ""/, "closing hands the menu back to the stylesheet");
  // The request carries only the two paths: refresh is unconditional and the
  // server decides whether it can read the workbook.
  assert.doesNotMatch(moduleSource, /refresh_values/);
  const changeBody = moduleSource.slice(moduleSource.indexOf("async function changeWorkbook"));
  assert.match(changeBody, /old_workbook_path: row\.workbookPath,\s*new_workbook_path: picked,\s*\}\)/);
  assert.match(changeBody, /Could not change the link to \$\{picked\}/, "a refusal names the picked path");
});

test("a Dataset Name cell asks Project Instance to open the dataset or DFM method", () => {
  assert.match(moduleSource, /postToParent\("arcrho:project-instance-open-dependent-dataset"/);
  const openBody = moduleSource.slice(moduleSource.indexOf("function openUsage"));
  assert.match(openBody, /openMethod: isDfm/);
  assert.match(openBody, /methodType: "DFM", methodName: name/);
  assert.match(openBody, /datasetTypeName: text\(row\?\.datasetType\) \|\| name/, "a dataset opens by instance and type");
  assert.match(openBody, /methodType: text\(row\.methodType\)/, "and by the Method Type the listing resolved");
  assert.match(openBody, /reservingClass/, "the window is pinned, so it names its own class");
  // The Project Instance page already routes that message to DSV or the DFM page.
  assert.match(messagesSource, /msg\.type === "arcrho:project-instance-open-dependent-dataset"/);
  assert.match(rawTableSource, /onOpenUsage\(row\)/);
});

test("columns resize on the pi-table model and filter from the header", () => {
  // T09: explicit widths on every col, table width is their sum, and the drag
  // handle sits outside layout flow.
  assert.match(rawTableSource, /table\.style\.width = total;\s*table\.style\.minWidth = total;/);
  assert.match(rawTableSource, /col\.style\.width = `\$\{width\}px`/);
  assert.match(rawTableSource, /function startColumnResize/);
  assert.match(rawTableSource, /document\.addEventListener\("mousemove", onMove, true\)/);
  assert.match(windowCssSource, /\.pi-excel-links-col-resizer \{[\s\S]*position: absolute;/);
  assert.match(windowCssSource, /table-layout: fixed;/);
  assert.match(windowCssSource, /body\.pi-excel-links-resizing-column/);
  // The table is only as wide as its columns, so the last column draws the
  // right edge instead of leaving every row open inside a wider frame.
  assert.doesNotMatch(windowCssSource, /\.pi-excel-links-table t[dh]:last-child \{ border-right: 0; \}/);
  // The filter popover is the header button's, and the page markup owns it.
  assert.match(rawTableSource, /className = "pi-excel-links-filter-btn"/);
  assert.match(rawTableSource, /function openFilterPopover/);
  assert.match(windowCssSource, /\.pi-excel-links-filter-popover \{[\s\S]*display: none;/);
});

test("Last Modified, Created, and User describe the workbook, not the dataset", () => {
  const rows = excelLinksTable.excelLinkDetailRows(excelLinks.normalizeExcelLinkWorkbooks(LISTING));
  // The workbook's own document properties, so they repeat on every row of the
  // same workbook exactly as Workbook and Folder do.
  const bookRows = rows.filter((row) => row.workbookName === "Book.xlsx");
  assert.equal(bookRows.length, 3);
  for (const row of bookRows) {
    assert.equal(excelLinksTable.excelLinkCellText(row, "user"), "j.tanaka");
    // The dates carry the shared ArcRho timestamp text, the same rule the
    // dataset table's Created and Last Modified use. Asserted against the
    // shared formatter and its shape, because the text is local-time.
    const created = excelLinksTable.excelLinkCellText(row, "created");
    const modified = excelLinksTable.excelLinkCellText(row, "lastModified");
    assert.equal(created, formatArcrhoTimestamp("2024-03-02T09:15:41Z"));
    assert.equal(modified, formatArcrhoTimestamp("2026-08-14T16:22:07Z"));
    assert.match(created, /^\d{1,2}\/\d{1,2}\/2024 \d{1,2}:\d{2}:\d{2} [AP]M$/);
    assert.match(modified, /^\d{1,2}\/\d{1,2}\/2026 \d{1,2}:\d{2}:\d{2} [AP]M$/);
  }
  // A workbook the listing carries no properties for - a legacy .xls, an
  // encrypted package, a server that predates the fields - shows blank rather
  // than a placeholder date.
  const bare = excelLinksTable.excelLinkDetailRows([{ workbookName: "Tail.xlsx", usages: [] }])[0];
  assert.equal(excelLinksTable.excelLinkCellText(bare, "lastModified"), "");
  assert.equal(excelLinksTable.excelLinkCellText(bare, "created"), "");
  assert.equal(excelLinksTable.excelLinkCellText(bare, "user"), "");
  // Each is filterable on the value the cell shows, like every other column.
  assert.deepEqual(
    excelLinksTable.excelLinkColumnOptions(rows, "user").map((option) => option.label),
    ["(blank)", "j.tanaka"],
  );
});

test("columns auto-fit on load, cap their width, and wrap long text to two lines", () => {
  const cssRule = (selector) => {
    const start = windowCssSource.indexOf(`${selector} {`);
    return start < 0 ? "" : windowCssSource.slice(start, windowCssSource.indexOf("}", start) + 1);
  };

  // Every column caps how far auto-fit may grow it, so one long folder path
  // cannot crowd out the columns the reader acts on.
  for (const col of excelLinksTable.EXCEL_LINK_COLUMNS) {
    assert.ok(
      Number.isFinite(col.maxAutoWidth) && col.maxAutoWidth >= col.minWidth,
      `${col.key} needs an auto-fit cap at or above its minimum width`,
    );
  }
  // Auto-fit is a load-time sizing that runs against the rendered cells, and a
  // column the user dragged keeps the width they gave it.
  assert.match(rawTableSource, /autoFitPending = true;\s*render\(\);/);
  assert.match(rawTableSource, /if \(autoFitPending\) \{\s*autoFitPending = false;\s*autoFitColumns\(\);/);
  assert.match(rawTableSource, /if \(manualWidths\.has\(col\.key\)\) continue;/);
  assert.match(rawTableSource, /manualWidths\.add\(key\);/);
  // The measured font is read off the rendered cell, so the stylesheet stays
  // the only place this table's typography is declared.
  assert.match(rawTableSource, /ctx\.font = `\$\{style\.fontStyle\}/);

  // Text past the cap wraps rather than being cut, and the two-line clamp keeps
  // the tallest row inside twice the 31px base row height (T01).
  const cellText = cssRule(".pi-excel-links-cell-text");
  assert.match(cellText, /-webkit-line-clamp: 2;/);
  assert.match(cellText, /line-height: 16px;/);
  assert.match(cellText, /max-height: 32px;/);
  assert.doesNotMatch(cellText, /white-space: nowrap;/);
  assert.match(rawTableSource, /className = "pi-excel-links-cell-text"/);
  // The name cell is a button around that same wrappable element; clipping it
  // on the button would defeat the clamp.
  assert.doesNotMatch(cssRule(".pi-excel-links-open"), /white-space: nowrap;/);
});

test("the toolbar holds Refresh all and a running-work indicator; the refresh icon is gone", () => {
  // The manual refresh icon is retired: the window keeps itself current.
  assert.ok(!windowHtmlSource.includes('id="excelLinksRefresh"'), "the icon-only refresh button is gone");
  assert.ok(!windowHtmlSource.includes("pi-excel-links-icon-btn"));
  assert.ok(!windowCssSource.includes(".pi-excel-links-icon-btn"));
  const refreshAll = windowHtmlSource.slice(
    windowHtmlSource.indexOf('id="excelLinksRefreshAll"'),
    windowHtmlSource.indexOf("</button>", windowHtmlSource.indexOf('id="excelLinksRefreshAll"')),
  );
  assert.match(refreshAll, /viewBox="0 0 24 24"/, "the 24-unit reload glyph, like datasetRefreshBtn");
  assert.match(refreshAll, /<span>Refresh all<\/span>/);
  assert.match(windowHtmlSource, /class="pi-excel-links-btn primary" id="excelLinksRefreshAll"/);
  assert.match(windowCssSource, /\.pi-excel-links-btn\.primary \{[^}]*background: var\(--ar-color-accent-soft\);/);
  // The indicator is a real-work spinner (V13), hidden whenever nothing runs.
  assert.match(windowHtmlSource, /id="excelLinksWorking" hidden/);
  assert.match(windowHtmlSource, /class="pi-excel-links-spinner"/);
  assert.match(windowCssSource, /@keyframes pi-excel-links-sweep/);
  assert.match(moduleSource, /setWorking\("Checking linked values\.\.\."\)/);
  assert.match(moduleSource, /setWorking\("Loading Excel links\.\.\."\)/);
  assert.match(moduleSource, /els\.refreshAll\?\.addEventListener\("click", \(\) => void refreshLinks\(manager\.rows, "all"\)\)/);
});

test("opening the window checks the linked values, not only the file times", () => {
  // Two steps: the listing first, its statuses blanked and marked pending,
  // then the value check settles them.
  const pending = excelLinks.pendingExcelLinkWorkbooks(excelLinks.normalizeExcelLinkWorkbooks(LISTING));
  assert.ok(pending[0].usages.every((usage) => usage.statusPending && usage.status === "" && !usage.checkedValues));
  const rows = excelLinksTable.excelLinkDetailRows(pending);
  assert.ok(rows.every((row) => row.statusPending));
  assert.match(rawTableSource, /if \(row\.statusPending\) \{[\s\S]*className = "pi-excel-links-status-pending"/);
  assert.match(windowCssSource, /\.pi-excel-links-status-pending::after \{[^}]*animation: pi-excel-links-sweep/);
  assert.equal(excelLinksTable.excelLinkStatusTooltip(rows[0]), "Checking the linked values against Book.xlsx...");

  // The check's listing carries the value comparison per usage.
  const checked = excelLinks.normalizeExcelLinkWorkbooks([{
    ...LISTING[0],
    usages: [
      { kind: "dataset", name: "Manual Paid", status: "needs_review", changed_cell_count: 3 },
      { kind: "dataset", name: "Manual Incurred", status: "updated", changed_cell_count: 0 },
      { kind: "dfm", name: "Development", status: "", check_error: "Sheet not found: Inputs" },
    ],
  }], { valueCheck: true });
  const checkedRows = excelLinksTable.excelLinkDetailRows(checked);
  assert.ok(checkedRows.every((row) => row.checkedValues && !row.statusPending));
  assert.deepEqual(checkedRows.map((row) => [row.status, row.changedCellCount, row.checkError]), [
    ["needs_review", 3, ""],
    ["updated", 0, ""],
    ["", 0, "Sheet not found: Inputs"],
  ]);
  assert.match(excelLinksTable.excelLinkStatusTooltip(checkedRows[0]), /^3 linked cells in Book\.xlsx no longer match the values this dataset holds\./);
  assert.equal(excelLinksTable.excelLinkStatusTooltip(checkedRows[1]), "Every linked value matches Book.xlsx.");
  assert.equal(excelLinksTable.excelLinkStatusTooltip(checkedRows[2]), "The linked values could not be checked: Sheet not found: Inputs");
  // Without a value check the file-time verdict says so in its tooltip.
  const timed = excelLinksTable.excelLinkDetailRows(excelLinks.normalizeExcelLinkWorkbooks(LISTING));
  assert.match(excelLinksTable.excelLinkStatusTooltip(timed[0]), /values not compared/);

  // The page asks the check endpoint after the listing, and falls back to the
  // listing's own statuses when the check cannot run.
  assert.match(moduleSource, /const CHECK_ENDPOINT = "\/excel_links\/check";/);
  assert.match(moduleSource, /await fetchListing\(CHECK_ENDPOINT\)/);
  assert.match(moduleSource, /normalizeExcelLinkWorkbooks\(payload\?\.workbooks, \{ valueCheck: true \}\)/);
  assert.match(moduleSource, /setRows\(manager\.listing, \{ autoFit: false \}\);\s*setManagerStatus\(`Linked values could not be checked/);
  const loadBody = moduleSource.slice(moduleSource.indexOf("async function loadExcelLinks"), moduleSource.indexOf("async function pollListing"));
  assert.match(loadBody, /adoptListing\(payload\);[\s\S]*await checkValues\(seq\);/);
});

test("the window keeps itself current: saves in its class and external workbook saves", () => {
  // A nested window's save reaches the manager through the host, from the
  // same event that reloads the dataset table.
  assert.match(messagesSource, /api\.notifyExcelLinksWindows\?\.\(frame\?\.dataset\?\.windowPath \|\| state\.selectedPath\)/);
  assert.match(hostSource, /const EXCEL_LINKS_DATASETS_CHANGED_MESSAGE = "arcrho:excel-links-datasets-changed";/);
  assert.match(hostSource, /function notifyExcelLinksWindows\(path\)[\s\S]*data-window-kind="excel_links"[\s\S]*normalizePath\(frame\.dataset\.windowPath\) !== target\) continue;/);
  assert.match(moduleSource, /message\?\.type !== "arcrho:excel-links-datasets-changed"\) return;[\s\S]*void loadExcelLinks\(\);/);
  // The listing is polled; only a listing that moved is adopted and re-checked.
  assert.equal(excelLinks.LISTING_POLL_MS, 15000);
  assert.match(moduleSource, /window\.setInterval\(\(\) => void pollListing\(\), LISTING_POLL_MS\)/);
  assert.match(moduleSource, /if \(manager\.polling \|\| manager\.loading \|\| manager\.checking \|\| manager\.busy \|\| document\.hidden\) return;/);
  assert.match(moduleSource, /if \(excelLinkListingSignature\(next\) === manager\.listingSignature\) return;/);
  assert.match(moduleSource, /visibilitychange/);
  const base = excelLinks.normalizeExcelLinkWorkbooks([{ ...LISTING[0], mtime: 1700000000.5 }]);
  const same = excelLinks.normalizeExcelLinkWorkbooks([{ ...LISTING[0], mtime: 1700000000.5 }]);
  assert.equal(excelLinks.excelLinkListingSignature(base), excelLinks.excelLinkListingSignature(same));
  // A workbook saved in Excel moves its file time; a dataset saved in ArcRho
  // moves its file-time verdict; a workbook that vanished moves `exists`.
  const savedInExcel = excelLinks.normalizeExcelLinkWorkbooks([{ ...LISTING[0], mtime: 1700000099 }]);
  assert.notEqual(excelLinks.excelLinkListingSignature(base), excelLinks.excelLinkListingSignature(savedInExcel));
  const savedInArcRho = excelLinks.normalizeExcelLinkWorkbooks([{
    ...LISTING[0], mtime: 1700000000.5,
    usages: LISTING[0].usages.map((usage, index) => (index === 0 ? { ...usage, status: "updated" } : usage)),
  }]);
  assert.notEqual(excelLinks.excelLinkListingSignature(base), excelLinks.excelLinkListingSignature(savedInArcRho));
  const gone = excelLinks.normalizeExcelLinkWorkbooks([{ ...LISTING[0], mtime: null, exists: false }]);
  assert.notEqual(excelLinks.excelLinkListingSignature(base), excelLinks.excelLinkListingSignature(gone));
});

test("Refresh all previews the directly affected objects and saves only those", () => {
  const rows = excelLinksTable.excelLinkDetailRows(excelLinks.normalizeExcelLinkWorkbooks([
    {
      ...LISTING[0],
      usages: [
        { kind: "dataset", name: "Manual Paid", dataset_type: "Paid Loss", method_type: "None", status: "needs_review", changed_cell_count: 2 },
        { kind: "dataset", name: "Manual Incurred", status: "updated", changed_cell_count: 0 },
        { kind: "dfm", name: "Development", method_type: "DFM", status: "needs_review", changed_cell_count: 1 },
      ],
    },
    {
      ...LISTING[1], exists: true,
      // The same dataset from a second workbook: one target, both workbooks named.
      usages: [{ kind: "dataset", name: "Manual Paid", status: "needs_review", changed_cell_count: 4 }],
    },
  ], { valueCheck: true }));
  const targets = excelLinks.excelLinkRefreshTargets(rows);
  assert.deepEqual(
    targets.map((target) => [target.kind, target.name, target.changedCellCount, target.workbookNames]),
    [["dataset", "Manual Paid", 6, ["Book.xlsx", "Tail.xlsx"]], ["dfm", "Development", 1, ["Book.xlsx"]]],
  );
  // A file-time verdict alone never makes a target: only compared values do.
  const timed = excelLinksTable.excelLinkDetailRows(excelLinks.normalizeExcelLinkWorkbooks(LISTING));
  assert.deepEqual(excelLinks.excelLinkRefreshTargets(timed), []);

  // The preview is the shared message box with Accept; the commit posts only
  // the accepted objects, and the host is told around the write as for a retarget.
  const refreshBody = moduleSource.slice(moduleSource.indexOf("async function refreshLinks"), moduleSource.indexOf("async function reloadKeepingStatus"));
  assert.match(refreshBody, /await checkValues\(seq\);/, "the preview rests on a fresh comparison");
  assert.match(refreshBody, /showPageMessageBox\(\{[\s\S]*actions: \[\{ id: "accept", label: "Accept" \}\],\s*okLabel: "Cancel",/);
  assert.match(refreshBody, /if \(choice !== "accept"\) return;/);
  assert.match(refreshBody, /Nothing to refresh\./);
  assert.match(refreshBody, /const REFRESH_ENDPOINT|postJson\(REFRESH_ENDPOINT, \{[\s\S]*targets,\s*\}\)/);
  assert.match(refreshBody, /postToParent\("arcrho:excel-links-retarget-begin"\)/);
  assert.match(refreshBody, /finally \{[\s\S]*arcrho:excel-links-retarget-end/);
  assert.match(moduleSource, /const REFRESH_ENDPOINT = "\/excel_links\/refresh";/);

  // The status line after the commit.
  const saved = excelLinks.excelLinkRefreshSummary({
    results: [
      { kind: "dataset", name: "Manual Paid", ok: true, saved: true, value_changed: true },
      { kind: "dfm", name: "Development", ok: true, saved: false, value_changed: false },
    ],
    changed_file_count: 1, refreshed_cell_count: 3, failed_refresh_count: 0, propagation: { ok: true, status: "completed" }, propagation_ok: true,
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.message, "Refreshed 3 linked cells and saved 1 file; 1 object already matched and was skipped. Affected objects and their dependents are marked Needs Review.");
  const nothing = excelLinks.excelLinkRefreshSummary({
    results: [{ kind: "dataset", name: "Manual Paid", ok: true, saved: false }],
    changed_file_count: 0, refreshed_cell_count: 2, failed_refresh_count: 0, propagation_ok: true,
  });
  assert.equal(nothing.ok, true);
  assert.match(nothing.message, /^Nothing was saved: the linked values of 1 object already matched\./);
  const partial = excelLinks.excelLinkRefreshSummary({
    results: [{ kind: "dataset", name: "Manual Paid", ok: true, saved: true }, { kind: "dfm", name: "Development", ok: false, error: "locked" }],
    changed_file_count: 1,
  });
  assert.equal(partial.ok, false);
  assert.match(partial.message, /Refreshed 1 of 2 files; Development: locked/);
  const failedCells = excelLinks.excelLinkRefreshSummary({
    results: [{ kind: "dataset", name: "Manual Paid", ok: true, saved: true }],
    changed_file_count: 1, refreshed_cell_count: 2, failed_refresh_count: 1, propagation_ok: true,
  });
  assert.equal(failedCells.ok, false);
  assert.match(failedCells.message, /1 linked cell could not be read and kept the stored values\./);
});

test("Break links confirms first, then drops only the selected rows' references", () => {
  // The request names one row at a time - one object reading one workbook -
  // so a second workbook the same object reads keeps its link.
  const breakBody = moduleSource.slice(moduleSource.indexOf("async function breakLinks"), moduleSource.indexOf("async function runBreak"));
  assert.match(breakBody, /kind: row\.kind === "dfm" \? "dfm" : "dataset", name: text\(row\.name\), workbook_path: text\(row\.workbookPath\)/);
  assert.match(breakBody, /tone: "warn"/);
  assert.match(breakBody, /The objects below stop reading Excel and keep their current values\./);
  assert.match(breakBody, /if \(choice !== "break"\) return;/);
  const runBody = moduleSource.slice(moduleSource.indexOf("async function runBreak"), moduleSource.indexOf("async function reloadKeepingStatus"));
  assert.match(runBody, /postJson\(BREAK_ENDPOINT, \{[\s\S]*targets,\s*\}\)/);
  assert.match(runBody, /postToParent\("arcrho:excel-links-retarget-begin"\)/);
  assert.match(runBody, /finally \{[\s\S]*arcrho:excel-links-retarget-end/);
  assert.match(moduleSource, /const BREAK_ENDPOINT = "\/excel_links\/break";/);
  // No value check runs first: a break reads nothing from Excel.
  assert.doesNotMatch(breakBody, /checkValues/);

  // The status line after the commit.
  const broke = excelLinks.excelLinkBreakSummary({
    results: [{ kind: "dataset", name: "Manual Paid", ok: true, saved: true, broken_link_count: 2 }],
    changed_file_count: 1, broken_link_count: 2, propagation_ok: true,
  });
  assert.equal(broke.ok, true);
  assert.equal(broke.message, "Broke 2 links in 1 file. The stored values are unchanged.");
  const nothing = excelLinks.excelLinkBreakSummary({ results: [], changed_file_count: 0, broken_link_count: 0 });
  assert.equal(nothing.ok, true);
  assert.match(nothing.message, /^No saved link named those workbooks\./);
  const partial = excelLinks.excelLinkBreakSummary({
    results: [{ kind: "dataset", name: "Manual Paid", ok: true, saved: true }, { kind: "dfm", name: "Development", ok: false, error: "locked" }],
    changed_file_count: 1,
  });
  assert.equal(partial.ok, false);
  assert.match(partial.message, /Broke links in 1 of 2 files; Development: locked/);
});

test("a finished refresh names the downstream objects its walk changed", () => {
  // The walk's short list is what the notice shows: the dependents whose
  // values really moved, deduplicated, with blanks dropped.
  assert.deepEqual(
    excelLinks.excelLinkRefreshedDependents({
      propagation: {
        ok: true, status: "completed",
        review_flagged_datasets: ["Ultimate Loss", " Ultimate Loss ", "", "IBNR"],
      },
    }),
    ["Ultimate Loss", "IBNR"],
  );
  // Dependents the walk rewrote without a value change, a queued walk, and a
  // refresh that never answered all leave the notice away.
  assert.deepEqual(excelLinks.excelLinkRefreshedDependents({
    propagation: { ok: true, status: "completed", refreshed_datasets: ["Paid DFM"], review_flagged_datasets: [] },
  }), []);
  assert.deepEqual(excelLinks.excelLinkRefreshedDependents({ propagation: { ok: true, status: "queued", job_id: "j1" } }), []);
  assert.deepEqual(excelLinks.excelLinkRefreshedDependents(null), []);

  // The notice is raised after the refresh answers and before the reload, so
  // the status line the reload restores is the refresh's own outcome, and each
  // name is a link that asks the host to open it.
  const runBody = moduleSource.slice(moduleSource.indexOf("async function runRefresh"), moduleSource.indexOf("async function reloadKeepingStatus"));
  assert.match(runBody, /await showRefreshedDependentsNotice\(payload\);\s*await reloadKeepingStatus\(outcome\);/);
  const noticeBody = moduleSource.slice(moduleSource.indexOf("async function showRefreshedDependentsNotice"));
  assert.match(noticeBody, /if \(!names\.length\) return;/);
  assert.match(noticeBody, /onLinkClick: \(item\) => openDependent\(item\?\.label\)/);
  assert.match(moduleSource, /function openDependent[\s\S]*postToParent\("arcrho:project-instance-open-dependent-dataset", \{[\s\S]*openMethod: true,/);
});

test("rows select like the dataset table's, and the selection survives a reload", () => {
  const rows = excelLinksTable.excelLinkDetailRows(excelLinks.normalizeExcelLinkWorkbooks(LISTING));
  const keys = rows.map((row) => excelLinksTable.excelLinkRowKey(row));
  assert.equal(new Set(keys).size, 4, "every usage row has its own key");
  assert.equal(
    excelLinksTable.excelLinkRowKey({ kind: "dataset", name: "Manual Paid", workbookPath: "c:/data/BOOK.xlsx" }),
    keys[0],
    "the key ignores path case and separators, so a reload matches the same row",
  );
  const selection = { keys: new Set(), anchorKey: "", activeKey: "" };
  const apply = (index, event = {}) => excelLinksTable.applyExcelLinkRowSelection(selection, keys[index], keys, event);
  apply(0);
  assert.deepEqual([...selection.keys], [keys[0]]);
  apply(0);
  assert.equal(selection.keys.size, 0, "clicking the only selected row again clears the selection");
  apply(0);
  apply(2, { shiftKey: true });
  assert.deepEqual([...selection.keys], [keys[0], keys[1], keys[2]], "Shift selects the visible range from the anchor");
  assert.equal(selection.activeKey, keys[2]);
  apply(1, { ctrlKey: true });
  assert.deepEqual([...selection.keys], [keys[0], keys[2]], "Ctrl toggles one row");
  apply(3);
  assert.deepEqual([...selection.keys], [keys[3]], "a plain click inside a multi-selection narrows to that row");
  // A right-click outside the selection collapses it to the clicked row; one
  // inside keeps it and moves the active row.
  excelLinksTable.targetExcelLinkRowSelection(selection, keys[1]);
  assert.deepEqual([...selection.keys], [keys[1]]);
  apply(2, { shiftKey: true });
  excelLinksTable.targetExcelLinkRowSelection(selection, keys[1]);
  assert.deepEqual([...selection.keys], [keys[1], keys[2]]);
  assert.equal(selection.activeKey, keys[1]);
  // The wiring: rows carry their key and the selected/multi/active classes of
  // pi_table.css, the menu receives every selected row, and setRows keeps the
  // keys that still exist.
  assert.match(rawTableSource, /tr\.dataset\.recordKey = key;/);
  assert.match(rawTableSource, /tr\.classList\.toggle\("multi", selected && multi\);/);
  assert.match(rawTableSource, /onRowMenu\(selectedRows\(\), tr, event, /);
  assert.match(rawTableSource, /getSelectedRows: selectedRows,/);
  assert.match(rawTableSource, /for \(const key of \[\.\.\.selection\.keys\]\) \{\s*if \(keys\.has\(key\)\) continue;/);
  assert.match(windowCssSource, /\.pi-excel-links-table tbody tr\[data-record-key\]\.selected td \{/);
  assert.match(windowCssSource, /\.pi-excel-links-table tbody tr\[data-record-key\]\.selected\.multi:not\(\.active\) td:first-child \{/);
  assert.match(windowHtmlSource, /aria-multiselectable="true"/);
  assert.match(windowHtmlSource, /Click a row to select it, right-click for workbook actions\./);
  // Rows are for selecting, not for highlighting as text; only the filter
  // search box keeps text selection.
  assert.match(windowCssSource, /\.pi-excel-links-page \{[^}]*user-select: none;/);
  assert.match(windowCssSource, /\.pi-excel-links-filter-search \{ user-select: text; \}/);
});

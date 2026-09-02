import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stubUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const tooltipStubUrl = stubUrl("export function attachArcrhoTooltip() {}");
const menuStubUrl = stubUrl("export function openContextMenu() {}");
const openPathStubUrl = stubUrl("export function openPathThroughDesktopHost() {}");
const tableStubUrl = stubUrl(
  "export function createExcelLinksTable() { return { setRows() {}, closeFilterPopover() {} }; }\n"
  + "export function excelLinkDetailRows() { return []; }",
);

const TOOLTIP_IMPORT = /"\/ui\/shared\/components\/tooltip\/tooltip\.js\?v=\d{8}[a-z]"/;
const MENU_IMPORT = /"\/ui\/shared\/components\/context_menu\/context_menu\.js\?v=\d{8}[a-z]"/;
const TIMESTAMP_IMPORT = /"\/ui\/shared\/utils\/timestamp\.js\?v=\d{8}[a-z]"/;
// Not a stub: the table's Created and Last Modified must read exactly as the
// dataset table's do, so the real shared formatter is what runs here.
const timestampUrl = new URL("../ui/shared/utils/timestamp.js", import.meta.url).href;
const { formatArcrhoTimestamp } = await import(timestampUrl);

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
    .replace(TIMESTAMP_IMPORT, JSON.stringify(timestampUrl)),
));

const htmlSource = await readFile(
  new URL("../ui/project_instance/project_instance.html", import.meta.url),
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
      { kind: "dataset", name: "Manual Paid", dataset_type: "Paid Loss", method_type: "None", link_count: 2, cell_count: 6 },
      { kind: "dataset", name: "Manual Incurred", dataset_type: "Manual Incurred", method_type: "Result Selection", link_count: 1, cell_count: 2 },
      { kind: "dfm", name: "Development", dataset_type: "", method_type: "DFM", link_count: 1, cell_count: 1 },
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
    usages: [{ kind: "dfm", name: "Tail", method_type: "DFM", link_count: 1, cell_count: 1 }],
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
  // The workbook's folder and found/missing verdict repeat on each of its rows,
  // which is what lets the Folder column filter and the missing cue work.
  assert.equal(rows[1].folder, "C:\\Data\\");
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
    ["name", "methodType", "workbook", "folder", "lastModified", "created", "user"],
    "Status and Links are gone; the used-by column became one row per object",
  );
  const byKey = new Map(excelLinksTable.EXCEL_LINK_COLUMNS.map((col) => [col.key, col]));
  assert.equal(byKey.get("name").label, "Dataset Name");
  assert.equal(byKey.get("methodType").label, "Method Type");
  assert.equal(byKey.get("folder").label, "Location");
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
    excelLinksTable.excelLinkColumnOptions(rows, "workbook").map((option) => option.label),
    ["Book.xlsx", "Tail.xlsx"],
  );

  const noFilter = excelLinksTable.filterExcelLinkRows(rows, new Map());
  assert.equal(noFilter.length, 4);

  const dfmOnly = excelLinksTable.filterExcelLinkRows(rows, new Map([["methodType", new Set(["DFM"])]]));
  assert.deepEqual(dfmOnly.map((row) => row.name), ["Development", "Tail"]);

  const both = excelLinksTable.filterExcelLinkRows(rows, new Map([
    ["methodType", new Set(["DFM"])],
    ["workbook", new Set(["Book.xlsx"])],
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
    "excelLinksRefresh",
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

test("the row menu opens, relinks, and - on a Folder cell - opens the folder", () => {
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
  assert.match(windowHtmlSource, /class="pi-excel-links-toolbar"[\s\S]*id="excelLinksRefresh"/);
  assert.match(windowHtmlSource, /class="ctx-menu pi-excel-links-menu" id="excelLinksMenu"/);
  for (const action of ["open-workbook", "open-workbook-read-only", "open-folder", "change-link"]) {
    assert.match(windowHtmlSource, new RegExp(`class="ctx-item"[^>]*data-action="${action}"`));
  }
  // Opening the folder belongs to the Folder cell only.
  assert.match(windowHtmlSource, /data-action="open-folder"[^>]*hidden/);
  assert.match(moduleSource, /folderItem\.hidden = columnKey !== "folder"/);
  assert.match(rawModuleSource, /import \{ openPathThroughDesktopHost \} from "\/ui\/shared\/integrations\/open_path\.js\?v=\d{8}[a-z]"/);
  assert.match(moduleSource, /openPathThroughDesktopHost\(path, \{ readOnly: !!readOnly \}\)/);
  assert.match(moduleSource, /opened: "Folder opened in File Explorer\."/);
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

test("the refresh icon matches the Project Instance dataset toolbar buttons", () => {
  const refreshButton = windowHtmlSource.slice(
    windowHtmlSource.indexOf('id="excelLinksRefresh"'),
    windowHtmlSource.indexOf("</button>", windowHtmlSource.indexOf('id="excelLinksRefresh"')),
  );
  assert.match(refreshButton, /viewBox="0 0 24 24"/, "the 24-unit refresh glyph, like datasetRefreshBtn");
  assert.match(windowCssSource, /\.pi-excel-links-icon-btn svg \{ width: 15px; height: 15px;[^}]*stroke-width: 1\.8;/);
});

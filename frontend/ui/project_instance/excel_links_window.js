// Excel Link Manager page.
//
// This runs inside a Project Instance nested window (pi-window). The host frame
// in project_instance_windows.js owns the titlebar, dragging, resizing,
// minimize/maximize/close and the dock; this page owns the inventory, the
// Refresh all command, and the row actions reached from a right-click menu.
// That menu is really two: the column under the pointer decides whether it
// offers the object's actions (open it, copy its name) or the workbook's
// (open it, open it read-only, open its file location, copy its path, change
// what it points at). Refreshing and breaking the row's link sit in both,
// because a row is one object reading one workbook. The window is pinned to
// the reserving class it was opened
// on, which arrives in the query string, so selecting another class in the
// tree leaves it alone exactly like a Dataset or DFM window.
//
// The table shows one row per usage - a workbook read by two datasets is two
// rows - and lives in excel_links_table.js, which owns the column widths,
// filters, selection, and rendering. Clicking a Dataset Name cell asks the
// Project Instance page to open that dataset in DSV or that method in DFM,
// through the same arcrho:project-instance-open-dependent-dataset message a
// method page uses for a precedent. Rows select like the dataset table's, so
// the context menu acts on every highlighted row.
//
// Everything about a workbook is answered by ArcRho Server. Opening the window
// is a two-step check: the listing arrives first, with the server's
// found/missing verdict per workbook, and the linked cells are then read on
// the server and compared with the stored values, so the Status column says
// whether a workbook actually holds different numbers rather than only that
// it was saved later. The window keeps itself current: it reloads when the
// Project Instance page reports a save in this reserving class, and it polls
// the listing so a workbook saved in Excel shows up without a manual refresh.
// Refresh all previews the datasets and DFM methods whose values changed and,
// once accepted, re-reads and saves exactly those on Arco Engine, which walks
// their dependents once; a second notice then names the downstream objects
// that walk really changed. A change of link is the same kind of Engine-hosted
// job for one workbook. Opening a workbook is the exception and runs on the
// client machine, through the desktop host, because that is where Excel is.
//
// Two messages go back to the Project Instance page around any write, because
// the job rewrites files the host is watching:
//   arcrho:excel-links-retarget-begin  - suppress the host's index-change prompt
//   arcrho:excel-links-retarget-end    - restore it, report status, and reload
//                                        the cached dataset table when files changed
// and a third after every value check, arcrho:excel-links-status, which hands
// the host the answer for the dataset table's own Status column so that table
// does not read every workbook a second time.
// One comes in: arcrho:excel-links-datasets-changed, sent by the host when
// a nested window saved something in this class, which reloads the inventory.
import { openContextMenu } from "/ui/shared/components/context_menu/context_menu.js?v=20260811b";
import { showPageMessageBox } from "/ui/shared/components/message_box/message_box.js?v=20260916a";
import { createArcRhoBusyOverlay } from "/ui/shared/components/progress_popup/progress_popup.js?v=20260824a";
import { openPathThroughDesktopHost } from "/ui/shared/integrations/open_path.js?v=20260907b";
import { createExcelLinksTable, excelLinkDetailRows } from "/ui/project_instance/excel_links_table.js?v=20260918a";
import {
  LISTING_POLL_MS,
  STATUS_NEEDS_REVIEW,
  excelLinkListingSignature,
  normalizeExcelLinkWorkbooks,
  pendingExcelLinkWorkbooks,
} from "/ui/shared/dataset/excel_link_inventory.js?v=20260919a";
import "/ui/shared/integrations/zoom_bridge.js?v=20260521a";

const LIST_ENDPOINT = "/excel_links/list";
const CHECK_ENDPOINT = "/excel_links/check";
const REFRESH_ENDPOINT = "/excel_links/refresh";
const BREAK_ENDPOINT = "/excel_links/break";
const RETARGET_ENDPOINT = "/excel_links/retarget";
const EXCEL_FILE_FILTERS = [
  { name: "Excel Workbooks", extensions: ["xlsx", "xlsm", "xlsb", "xls"] },
  { name: "All Files", extensions: ["*"] },
];

function text(value) {
  return String(value ?? "").trim();
}

function count(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function plural(n, singular, pluralForm = `${singular}s`) {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

function detailMessage(payload, fallback) {
  const detail = payload?.detail;
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  if (Array.isArray(detail) && detail.length) return detail.map((item) => item?.msg || String(item)).join("; ");
  return fallback;
}

export function excelLinkInventorySummary({ workbookCount, visibleRows, totalRows, needsReviewCount, scanErrorCount }) {
  const books = count(workbookCount);
  const total = count(totalRows);
  const visible = count(visibleRows);
  if (!books) return "";
  const workbooks = `${books} linked workbook${books === 1 ? "" : "s"}`;
  const references = visible === total
    ? `${total} reference${total === 1 ? "" : "s"}`
    : `${visible} of ${total} references shown`;
  const stale = count(needsReviewCount);
  const review = stale ? ` ${stale} reference${stale === 1 ? " needs" : "s need"} review.` : "";
  const errors = count(scanErrorCount);
  const skipped = errors ? ` ${errors} file${errors === 1 ? "" : "s"} could not be read.` : "";
  return `${workbooks}, ${references}.${review}${skipped}`;
}

function propagationSentence(payload) {
  if (payload?.propagation_ok === false) return " Dependent recalculation reported a problem; check the affected pages.";
  if (text(payload?.propagation?.status) === "queued") {
    return " Dependent recalculation has started; affected objects are marked Needs Review.";
  }
  return " Affected objects and their dependents are marked Needs Review.";
}

function failureSummary(payload, verb) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const failures = results.filter((item) => item?.ok === false);
  if (!failures.length) return null;
  const changedFiles = count(payload?.changed_file_count);
  const first = failures[0];
  const name = text(first?.name) || "a file";
  const error = text(first?.error) || "The file could not be updated.";
  const others = failures.length > 1 ? ` (+${failures.length - 1} more)` : "";
  return {
    ok: false,
    message: `${verb} ${changedFiles} of ${changedFiles + failures.length} files; ${name}: ${error}${others}`,
  };
}

export function excelLinkRetargetSummary(payload) {
  const failed = failureSummary(payload, "Updated");
  if (failed) return failed;
  const changedFiles = count(payload?.changed_file_count);
  const changedLinks = count(payload?.changed_link_count);
  if (!changedFiles) {
    return { ok: true, message: text(payload?.message) || "No saved links needed a change." };
  }
  const relinked = `Updated ${changedLinks} link${changedLinks === 1 ? "" : "s"} in ${changedFiles} file${changedFiles === 1 ? "" : "s"}`;
  const refreshedCells = count(payload?.refreshed_cell_count);
  const changedValueFiles = count(payload?.value_changed_file_count);
  const values = changedValueFiles
    ? `values changed in ${changedValueFiles} file${changedValueFiles === 1 ? "" : "s"}`
    : "stored values already matched";
  const refreshed = `recalculated ${refreshedCells} linked cell${refreshedCells === 1 ? "" : "s"} (${values}).`;
  const failedRefresh = count(payload?.failed_refresh_count);
  const failed2 = failedRefresh
    ? ` ${failedRefresh} linked cell${failedRefresh === 1 ? "" : "s"} could not be recalculated and kept the stored values.`
    : "";
  return {
    ok: !failedRefresh && payload?.propagation_ok !== false,
    message: `${relinked}; ${refreshed}${failed2}${propagationSentence(payload)}`,
  };
}

/** The status line after a refresh: what was saved, skipped, and flagged. */
export function excelLinkRefreshSummary(payload) {
  const failed = failureSummary(payload, "Refreshed");
  if (failed) return failed;
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const savedFiles = count(payload?.changed_file_count);
  const skipped = results.filter((item) => item?.ok !== false && item?.saved === false).length;
  const failedRefresh = count(payload?.failed_refresh_count);
  const failedCells = failedRefresh
    ? ` ${plural(failedRefresh, "linked cell")} could not be read and kept the stored values.`
    : "";
  if (!savedFiles) {
    return {
      ok: !failedRefresh,
      message: `Nothing was saved: the linked values of ${plural(skipped, "object")} already matched.${failedCells}`,
    };
  }
  const refreshedCells = count(payload?.refreshed_cell_count);
  const saved = `Refreshed ${plural(refreshedCells, "linked cell")} and saved ${plural(savedFiles, "file")}`;
  const unchanged = skipped ? `; ${plural(skipped, "object")} already matched and ${skipped === 1 ? "was" : "were"} skipped` : "";
  return {
    ok: !failedRefresh && payload?.propagation_ok !== false,
    message: `${saved}${unchanged}.${failedCells}${propagationSentence(payload)}`,
  };
}

/** The status line after a break: what was dropped, and what stayed put. */
export function excelLinkBreakSummary(payload) {
  const failed = failureSummary(payload, "Broke links in");
  if (failed) return failed;
  const files = count(payload?.changed_file_count);
  if (!files) return { ok: true, message: "No saved link named those workbooks. Nothing was changed." };
  const broken = count(payload?.broken_link_count);
  return {
    ok: payload?.propagation_ok !== false,
    message: `Broke ${plural(broken, "link")} in ${plural(files, "file")}. The stored values are unchanged.`,
  };
}

/**
 * The downstream objects a refresh really changed, named by the Engine walk.
 *
 * `propagation.review_flagged_datasets` is the walk's short list: the
 * dependents whose values moved, which is what turned them from OK to Needs
 * Review. Dependents the walk rewrote without a meaningful change are not in
 * it, so this is exactly what the user has to look at. A walk that was queued
 * rather than run on the Engine names nothing and the notice stays away.
 */
export function excelLinkRefreshedDependents(payload) {
  const names = [];
  const seen = new Set();
  const flagged = payload?.propagation?.review_flagged_datasets;
  for (const value of Array.isArray(flagged) ? flagged : []) {
    const name = text(value);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/**
 * The objects a refresh would save, from the rows the value check flagged:
 * one target per dataset or DFM, with the workbooks and cell counts behind it.
 */
export function excelLinkRefreshTargets(rows) {
  const targets = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.checkedValues || row.status !== STATUS_NEEDS_REVIEW || !text(row.name)) continue;
    const kind = row.kind === "dfm" ? "dfm" : "dataset";
    const key = `${kind}\u001f${text(row.name).toLowerCase()}`;
    const target = targets.get(key) || {
      kind, name: text(row.name), datasetType: text(row.datasetType), methodType: text(row.methodType),
      changedCellCount: 0, workbookNames: [], row,
    };
    target.changedCellCount += count(row.changedCellCount);
    if (!target.workbookNames.includes(row.workbookName)) target.workbookNames.push(row.workbookName);
    targets.set(key, target);
  }
  return [...targets.values()];
}

const params = new URLSearchParams(window.location.search);
const inst = text(params.get("inst"));
const projectName = text(params.get("project"));
const reservingClass = text(params.get("class"));

const els = {
  refreshAll: document.getElementById("excelLinksRefreshAll"),
  working: document.getElementById("excelLinksWorking"),
  workingText: document.getElementById("excelLinksWorkingText"),
  table: document.getElementById("excelLinksTable"),
  wrap: document.getElementById("excelLinksTableWrap"),
  state: document.getElementById("excelLinksState"),
  status: document.getElementById("excelLinksStatus"),
  menu: document.getElementById("excelLinksMenu"),
  filterPopover: document.getElementById("excelLinksFilterPopover"),
};

const manager = {
  loading: false,
  checking: false,
  busy: false,
  // The last listing as the server stated it (file-time statuses), and the
  // signature the poll compares the next listing with.
  listing: [],
  listingSignature: "",
  // What the table shows: the listing with statuses settled by values once
  // the check has run, or with the file-time statuses when it could not.
  workbooks: [],
  rows: [],
  visibleRows: 0,
  requestSeq: 0,
  scanErrorCount: 0,
  polling: false,
  pollTimer: 0,
  // The rows the context menu is open for, its <tr>, and the clicked column.
  menuRows: [],
  menuRowEl: null,
};

const busyOverlay = createArcRhoBusyOverlay({ title: "Excel links", documentRef: document });

function postToParent(type, payload = {}) {
  try {
    window.parent?.postMessage({ type, inst, ...payload }, "*");
  } catch {}
}

function hostApi() {
  try {
    return window.ADAHost || window.parent?.ADAHost || window.top?.ADAHost || null;
  } catch {
    return null;
  }
}

function setManagerStatus(message, tone = "") {
  if (!els.status) return;
  els.status.textContent = text(message);
  els.status.className = `pi-excel-links-status${tone ? ` ${tone}` : ""}`;
}

function setWorking(message) {
  if (!els.working) return;
  const label = text(message);
  els.working.hidden = !label;
  if (els.workingText) els.workingText.textContent = label;
}

function syncControls() {
  const blocked = manager.busy || manager.loading;
  if (els.refreshAll) els.refreshAll.disabled = blocked || manager.checking || !manager.rows.length;
  if (blocked) {
    closeMenu();
    table?.closeFilterPopover();
  }
  document.body.setAttribute("aria-busy", blocked || manager.checking ? "true" : "false");
}

function setBusy(busy) {
  manager.busy = !!busy;
  syncControls();
}

function showState(message) {
  if (!els.state) return;
  els.state.textContent = text(message);
  els.state.hidden = !els.state.textContent;
}

function syncInventoryStatus() {
  setManagerStatus(excelLinkInventorySummary({
    workbookCount: manager.workbooks.length,
    visibleRows: manager.visibleRows,
    totalRows: manager.rows.length,
    needsReviewCount: manager.rows.filter((row) => row.status === STATUS_NEEDS_REVIEW).length,
    scanErrorCount: manager.scanErrorCount,
  }), manager.scanErrorCount ? "error" : "");
}

const table = createExcelLinksTable({
  table: els.table,
  wrap: els.wrap,
  popover: els.filterPopover,
  onOpenUsage: (row) => openUsage(row),
  onRowMenu: (rows, rowEl, event, columnKey) => openMenu(rows, rowEl, event, columnKey),
  onViewChange: ({ visible, total, filtered }) => {
    manager.visibleRows = visible;
    if (manager.loading) return;
    if (!total) showState(manager.workbooks.length ? "" : "No Excel links are saved in this reserving class.");
    else showState(visible ? "" : "No rows match the current column filters.");
    if (filtered || total) syncInventoryStatus();
  },
});

function setRows(workbooks, options = {}) {
  manager.workbooks = workbooks;
  manager.rows = excelLinkDetailRows(workbooks);
  closeMenu();
  table.setRows(manager.rows, options);
  syncControls();
}

async function postJson(endpoint, body) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(detailMessage(payload, `HTTP ${response.status}`));
  }
  return payload;
}

function fetchListing(endpoint) {
  return postJson(endpoint, { project_name: projectName, reserving_class: reservingClass });
}

// ---------------------------------------------------------------------------
// Load, check, poll
// ---------------------------------------------------------------------------

/** Adopts one listing: file-time statuses, blanked while the values are checked. */
function adoptListing(payload) {
  manager.listing = normalizeExcelLinkWorkbooks(payload?.workbooks);
  manager.listingSignature = excelLinkListingSignature(manager.listing);
  manager.scanErrorCount = Array.isArray(payload?.errors) ? payload.errors.length : 0;
  setRows(pendingExcelLinkWorkbooks(manager.listing));
  if (!manager.workbooks.length) {
    showState("No Excel links are saved in this reserving class.");
    setManagerStatus("");
  }
}

/**
 * Reads every linked cell on the server and settles each row's status by
 * value. When the check cannot run the rows fall back to the listing's
 * file-time verdict, and the status line says so.
 */
async function checkValues(seq) {
  if (!manager.listing.length) return;
  manager.checking = true;
  setWorking("Checking linked values...");
  syncControls();
  try {
    const payload = await fetchListing(CHECK_ENDPOINT);
    if (seq !== manager.requestSeq) return;
    setRows(normalizeExcelLinkWorkbooks(payload?.workbooks, { valueCheck: true }), { autoFit: false });
    syncInventoryStatus();
    // The dataset table behind this window folds the same verdict into its own
    // Status column, so it takes this answer rather than paying for a second
    // read of every workbook.
    postToParent("arcrho:excel-links-status", {
      reservingClass,
      workbooks: Array.isArray(payload?.workbooks) ? payload.workbooks : [],
    });
  } catch (error) {
    if (seq !== manager.requestSeq) return;
    setRows(manager.listing, { autoFit: false });
    setManagerStatus(`Linked values could not be checked (${error.message}); Status shows the file times instead.`, "error");
  } finally {
    if (seq === manager.requestSeq) {
      manager.checking = false;
      setWorking("");
      syncControls();
    }
  }
}

async function loadExcelLinks() {
  const seq = ++manager.requestSeq;
  if (!projectName || !reservingClass) {
    manager.loading = false;
    setRows([]);
    showState("This window is missing its project or reserving class.");
    setManagerStatus("");
    syncControls();
    return;
  }
  manager.loading = true;
  if (!manager.rows.length) showState("Loading Excel links...");
  setWorking("Loading Excel links...");
  syncControls();
  try {
    const payload = await fetchListing(LIST_ENDPOINT);
    if (seq !== manager.requestSeq) return;
    manager.loading = false;
    adoptListing(payload);
  } catch (error) {
    if (seq !== manager.requestSeq) return;
    manager.loading = false;
    setRows([]);
    showState("Excel links could not be loaded.");
    setManagerStatus(`Could not load Excel links: ${error.message}`, "error");
    return;
  } finally {
    if (seq === manager.requestSeq) {
      setWorking("");
      syncControls();
    }
  }
  await checkValues(seq);
}

/**
 * One poll: fetch the listing and, only when it moved since the last one,
 * adopt it and compare the values again. Skipped while anything else is in
 * flight or the window is hidden.
 */
async function pollListing() {
  if (manager.polling || manager.loading || manager.checking || manager.busy || document.hidden) return;
  if (!projectName || !reservingClass) return;
  manager.polling = true;
  const seq = manager.requestSeq;
  try {
    const payload = await fetchListing(LIST_ENDPOINT);
    if (seq !== manager.requestSeq) return;
    const next = normalizeExcelLinkWorkbooks(payload?.workbooks);
    if (excelLinkListingSignature(next) === manager.listingSignature) return;
    const checkSeq = ++manager.requestSeq;
    adoptListing(payload);
    await checkValues(checkSeq);
  } catch {
    // A poll that fails says nothing; the next one, or the user, tries again.
  } finally {
    manager.polling = false;
  }
}

function startPolling() {
  if (manager.pollTimer) return;
  manager.pollTimer = window.setInterval(() => void pollListing(), LISTING_POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void pollListing();
  });
}

// ---------------------------------------------------------------------------
// Open the dataset or DFM method a row names
// ---------------------------------------------------------------------------

// The Project Instance page owns every dataset and method window, so the same
// message a method page sends for a precedent opens the row's object here: a
// dataset row lands in DSV, a DFM row in the DFM page, both pinned to this
// window's reserving class.
function openUsage(row) {
  const name = text(row?.name);
  if (!name || manager.busy || manager.loading) return;
  const isDfm = row?.kind === "dfm";
  postToParent("arcrho:project-instance-open-dependent-dataset", {
    datasetName: name,
    reservingClass,
    projectName,
    openMethod: isDfm,
    ...(isDfm
      ? { methodType: "DFM", methodName: name }
      // The listing names the instance's Dataset Type and Method Type, so an
      // instance whose name differs from its type opens without the host
      // guessing from the reserving class the tree happens to be showing.
      : {
        datasetTypeName: text(row?.datasetType) || name,
        ...(text(row?.methodType) ? { methodType: text(row.methodType) } : {}),
      }),
  });
  setManagerStatus(isDfm ? `Opening DFM method ${name}...` : `Opening dataset ${name}...`);
}

// A dependent the walk changed is not a row of this table, so only its name is
// known; the host resolves what owns it and opens that page. `openMethod` lets
// a method output land on its method rather than on the output dataset.
function openDependent(name) {
  const datasetName = text(name);
  if (!datasetName) return;
  postToParent("arcrho:project-instance-open-dependent-dataset", {
    datasetName,
    reservingClass,
    projectName,
    openMethod: true,
  });
}

// ---------------------------------------------------------------------------
// Row context menu
// ---------------------------------------------------------------------------

function closeMenu() {
  if (!manager.menuRows.length || !els.menu) return;
  // openContextMenu shows the menu with an inline display; clearing it hands
  // the menu back to the stylesheet's hidden default.
  els.menu.style.display = "";
  manager.menuRowEl?.classList.remove("context-target");
  manager.menuRows = [];
  manager.menuRowEl = null;
}

function distinct(rows, pick) {
  const seen = new Set();
  const values = [];
  for (const row of rows) {
    const value = text(pick(row));
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  return values;
}

/**
 * The right-click menu is two menus in one element: the column under the
 * pointer decides which half is shown. The Dataset Name, Status and Method
 * Type cells describe the object, so they open the object's actions; the
 * workbook columns describe the file, so they open the workbook's. The link
 * actions sit in both, because a row is one object reading one workbook and
 * refreshing or breaking that link belongs to neither side alone.
 */
const DATASET_MENU_COLUMNS = new Set(["name", "status", "methodType"]);

function openMenu(rows, rowEl, event, columnKey = "") {
  closeMenu();
  if (manager.busy || manager.loading || !els.menu || !rows.length) return;
  table.closeFilterPopover();
  manager.menuRows = rows;
  manager.menuRowEl = rowEl;
  rowEl.classList.add("context-target");
  const datasetScope = DATASET_MENU_COLUMNS.has(columnKey);
  // A workbook row with no usage names no object, so it counts as none here.
  const objects = distinct(rows, (row) => (text(row.name) ? `${row.kind}|${row.name}` : ""));
  const workbooks = distinct(rows, (row) => row.workbookPath);
  const folders = distinct(rows, (row) => row.folder);
  const many = workbooks.length > 1;
  const links = rows.filter((row) => text(row.name)).length;
  const item = (action) => els.menu.querySelector(`[data-action="${action}"]`);
  const show = (action, visible) => { item(action).hidden = !visible; };
  const openObject = item("open-object");
  openObject.textContent = objects.length > 1
    ? `Open ${objects.length} objects`
    : (rows[0]?.kind === "dfm" ? "Open DFM method" : "Open dataset");
  openObject.disabled = !objects.length;
  item("copy-name").textContent = objects.length > 1 ? `Copy ${objects.length} names` : "Copy name";
  item("copy-name").disabled = !objects.length;
  item("open-workbook").textContent = many ? `Open ${workbooks.length} workbooks` : "Open workbook";
  item("open-workbook-read-only").textContent = many
    ? `Open ${workbooks.length} workbooks as Read-Only`
    : "Open workbook as Read-Only";
  item("open-folder").textContent = folders.length > 1
    ? `Open ${folders.length} file locations`
    : "Open file location";
  item("copy-path").textContent = many ? `Copy ${workbooks.length} paths` : "Copy path";
  item("refresh-links").textContent = links > 1 ? "Refresh links" : "Refresh link";
  item("refresh-links").disabled = !links;
  item("break-links").textContent = links > 1 ? "Break links" : "Break link";
  item("break-links").disabled = !links;
  // A link change repoints one workbook for every object reading it; with two
  // workbooks highlighted there is no one file to change.
  item("change-link").disabled = many;
  for (const action of ["open-object", "copy-name"]) show(action, datasetScope);
  for (const action of ["open-workbook", "open-workbook-read-only", "copy-path", "change-link"]) {
    show(action, !datasetScope);
  }
  show("open-folder", !datasetScope && folders.length > 0);
  els.menu.setAttribute("aria-label", datasetScope ? "Dataset actions" : "Excel link actions");
  openContextMenu(els.menu, {
    anchorEl: rowEl,
    clientX: Number(event?.clientX),
    clientY: Number(event?.clientY),
    offset: 8,
    align: "top-left",
  });
  els.menu.querySelector(".ctx-item:not([hidden]):not(:disabled)")?.focus();
}

/** The item the keyboard would act on, so only one item is ever highlighted. */
function focusMenuItem(item) {
  if (!item || item.disabled || item === document.activeElement) return;
  item.focus();
}

function wireMenu() {
  if (!els.menu) return;
  // Opening the menu focuses its first item so the keyboard can walk it, and
  // the stylesheet highlights both the focused item and the hovered one. The
  // pointer therefore takes the focus with it: without this the first item
  // stays highlighted while the pointer highlights another, and the menu shows
  // two current items at once.
  els.menu.addEventListener("pointerover", (event) => {
    focusMenuItem(event.target.closest?.(".ctx-item"));
  });
  els.menu.addEventListener("click", (event) => {
    const item = event.target.closest?.(".ctx-item");
    if (!item || item.disabled) return;
    const rows = manager.menuRows;
    closeMenu();
    if (!rows.length) return;
    const action = item.dataset.action;
    if (action === "open-object") for (const row of oneRowPerObject(rows)) openUsage(row);
    else if (action === "copy-name") void copyText(distinct(rows, (row) => row.name), "name");
    else if (action === "open-workbook") void openWorkbooks(rows, false);
    else if (action === "open-workbook-read-only") void openWorkbooks(rows, true);
    else if (action === "open-folder") void openFolders(rows);
    else if (action === "copy-path") void copyText(distinct(rows, (row) => row.workbookPath), "path");
    else if (action === "refresh-links") void refreshLinks(rows, "selected");
    else if (action === "change-link") void changeWorkbook(rows[0]);
    else if (action === "break-links") void breakLinks(rows);
  });
  document.addEventListener("mousedown", (event) => {
    if (!els.menu.contains(event.target)) closeMenu();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  }, true);
  els.wrap?.addEventListener("scroll", closeMenu);
  window.addEventListener("resize", closeMenu);
  window.addEventListener("blur", closeMenu);
}

// ---------------------------------------------------------------------------
// Open workbook and folder
// ---------------------------------------------------------------------------

// Opening runs on the client machine through the desktop host, not on ArcRho
// Server: the workbook opens for this user in their own Excel, so a workbook
// the server cannot reach can still open here and the reverse. The same route
// hands a folder to File Explorer. Several highlighted rows open each distinct
// path in turn.
async function openThroughDesktopHost(paths, messages, readOnly = false) {
  if (!paths.length || manager.busy || manager.loading) return;
  setBusy(true);
  setManagerStatus(messages.opening);
  const failures = [];
  try {
    for (const path of paths) {
      try {
        const result = await openPathThroughDesktopHost(path, { readOnly: !!readOnly });
        if (!result?.ok) failures.push(`${path}: ${text(result?.error) || messages.failed}`);
      } catch (error) {
        failures.push(`${path}: ${error.message}`);
      }
    }
    if (!failures.length) setManagerStatus(messages.opened, "success");
    else setManagerStatus(`Could not open ${failures.join("; ")}`, "error");
  } finally {
    setBusy(false);
  }
}

function openWorkbooks(rows, readOnly) {
  const paths = distinct(rows, (row) => row.workbookPath);
  const name = paths.length === 1 ? (text(rows[0]?.workbookName) || paths[0]) : plural(paths.length, "workbook");
  return openThroughDesktopHost(paths, {
    opening: readOnly ? `Opening ${name} read-only...` : `Opening ${name}...`,
    opened: readOnly ? `${paths.length === 1 ? "Workbook" : "Workbooks"} opened read-only.` : `${paths.length === 1 ? "Workbook" : "Workbooks"} opened.`,
    failed: readOnly ? "The workbook could not be opened read-only." : "The workbook could not be opened.",
  }, readOnly);
}

// The clipboard belongs to the machine the window runs on, so this never asks
// the server. Several highlighted rows copy one value per line.
async function copyText(values, what) {
  if (!values.length) return;
  try {
    await navigator.clipboard.writeText(values.join("\r\n"));
    setManagerStatus(values.length === 1 ? `Copied ${values[0]}` : `Copied ${plural(values.length, what)}.`, "success");
  } catch (error) {
    setManagerStatus(`Could not copy the ${what}: ${error.message}`, "error");
  }
}

/** One row per object, so opening several rows opens each object once. */
function oneRowPerObject(rows) {
  const seen = new Set();
  const picked = [];
  for (const row of rows) {
    const key = `${row.kind}|${text(row.name).toLowerCase()}`;
    if (!text(row.name) || seen.has(key)) continue;
    seen.add(key);
    picked.push(row);
  }
  return picked;
}

function openFolders(rows) {
  const folders = distinct(rows, (row) => row.folder);
  return openThroughDesktopHost(folders, {
    opening: `Opening ${folders.length === 1 ? folders[0] : plural(folders.length, "file location")}...`,
    opened: `${folders.length === 1 ? "File location" : "File locations"} opened in File Explorer.`,
    failed: "The file location could not be opened.",
  });
}

// ---------------------------------------------------------------------------
// Refresh all / refresh selected
// ---------------------------------------------------------------------------

/**
 * Previews the datasets and DFM methods among `rows` whose linked values
 * changed, and on Accept re-reads and saves exactly those on Arco Engine.
 * The value check is (re)run first so the preview never rests on an older
 * comparison than the one the user is looking at.
 */
async function refreshLinks(rows, scope = "all") {
  if (manager.busy || manager.loading || manager.checking || !reservingClass) return;
  const seq = ++manager.requestSeq;
  await checkValues(seq);
  if (seq !== manager.requestSeq) return;
  // The rows the caller named, re-read from the checked table by key.
  const wanted = new Set(rows.map((row) => `${row.kind}\u001f${text(row.name).toLowerCase()}\u001f${text(row.workbookPath).toLowerCase()}`));
  const checked = manager.rows.filter((row) => wanted.has(`${row.kind}\u001f${text(row.name).toLowerCase()}\u001f${text(row.workbookPath).toLowerCase()}`));
  const targets = excelLinkRefreshTargets(checked);
  const unreadable = checked.filter((row) => row.checkedValues && !row.status && row.checkError).length;
  if (!targets.length) {
    const where = scope === "selected" ? "the selected rows" : "this reserving class";
    const caveat = unreadable ? ` ${plural(unreadable, "row")} could not be checked; see the Status tooltip.` : "";
    setManagerStatus(`Every linked value in ${where} already matches its workbook. Nothing to refresh.${caveat}`, unreadable ? "error" : "success");
    return;
  }
  const choice = await showPageMessageBox({
    title: scope === "selected" ? "Refresh selected links" : "Refresh all links",
    message: "Accept to load the new workbook values and save. Dependents are recalculated by the save.",
    links: targets.map((target) => ({
      label: `${target.name}${target.kind === "dfm" ? " (DFM)" : ""}`,
      ariaLabel: `Open ${target.kind === "dfm" ? "DFM method" : "dataset"} ${target.name}`,
      row: target.row,
    })),
    onLinkClick: (item) => openUsage(item.row),
    actions: [{ id: "accept", label: "Accept" }],
    okLabel: "Cancel",
    balancedActions: true,
  });
  if (choice !== "accept") return;
  await runRefresh(targets.map((target) => ({ kind: target.kind, name: target.name })));
}

async function runRefresh(targets) {
  if (manager.busy || manager.loading) return;
  const seq = ++manager.requestSeq;
  setBusy(true);
  const scope = busyOverlay.begin(`Reading the linked workbooks on Arco Server and saving ${plural(targets.length, "object")}...`);
  setManagerStatus(`Refreshing ${plural(targets.length, "object")} from their workbooks...`);
  // The refresh rewrites files and rebuilds index.json on the server; the
  // host suppresses its own disk-watch prompt for this window's change.
  postToParent("arcrho:excel-links-retarget-begin");
  let summary = { ok: false, message: "" };
  let payload = null;
  try {
    payload = await postJson(REFRESH_ENDPOINT, {
      project_name: projectName,
      reserving_class: reservingClass,
      targets,
    });
    summary = excelLinkRefreshSummary(payload);
    setManagerStatus(summary.message, summary.ok ? "success" : "error");
  } catch (error) {
    setManagerStatus(`Could not refresh the links: ${error.message}`, "error");
  } finally {
    scope.dismiss();
    postToParent("arcrho:excel-links-retarget-end", {
      ok: !!summary.ok,
      changedFileCount: count(payload?.changed_file_count),
    });
    setBusy(false);
  }
  if (seq !== manager.requestSeq) return;
  // The saved objects now match their workbooks; reload and re-check so the
  // Status column shows that, keeping the outcome on the status line.
  const outcome = { message: els.status?.textContent || "", tone: els.status?.className.includes("error") ? "error" : "success" };
  await showRefreshedDependentsNotice(payload);
  await reloadKeepingStatus(outcome);
}

/**
 * The post-refresh notice: the downstream objects whose values the walk
 * changed, each a link that opens it. This list is the only record the user
 * gets of what the refresh moved downstream, so the box stays up until it is
 * dismissed and the links stay clickable while it is. A refresh that changed
 * nothing downstream raises no box; the status line reports the outcome.
 */
async function showRefreshedDependentsNotice(payload) {
  const names = excelLinkRefreshedDependents(payload);
  if (!names.length) return;
  await showPageMessageBox({
    title: "Refresh complete",
    message: `${plural(names.length, "downstream object")} changed and ${names.length === 1 ? "needs" : "need"} review.`,
    links: names.map((name) => ({ label: name, ariaLabel: `Open ${name}` })),
    onLinkClick: (item) => openDependent(item?.label),
  });
}

// ---------------------------------------------------------------------------
// Break links
// ---------------------------------------------------------------------------

/**
 * Confirms, then drops the highlighted rows' Excel references on Arco Engine.
 *
 * A row is one object reading one workbook, so only that pair's references
 * go; every stored number stays where it is. Nothing is read from Excel, so
 * unlike a refresh this needs no value check first.
 */
async function breakLinks(rows) {
  if (manager.busy || manager.loading || manager.checking || !reservingClass) return;
  const targets = rows
    .filter((row) => text(row.name) && text(row.workbookPath))
    .map((row) => ({ kind: row.kind === "dfm" ? "dfm" : "dataset", name: text(row.name), workbook_path: text(row.workbookPath) }));
  if (!targets.length) return;
  const objects = oneRowPerObject(rows);
  const choice = await showPageMessageBox({
    title: targets.length > 1 ? "Break links" : "Break link",
    tone: "warn",
    message: "The objects below stop reading Excel and keep their current values.",
    links: objects.map((row) => ({
      label: `${row.name}${row.kind === "dfm" ? " (DFM)" : ""}`,
      ariaLabel: `Open ${row.kind === "dfm" ? "DFM method" : "dataset"} ${row.name}`,
      row,
    })),
    onLinkClick: (item) => openUsage(item.row),
    actions: [{ id: "break", label: targets.length > 1 ? "Break links" : "Break link" }],
    okLabel: "Cancel",
    balancedActions: true,
  });
  if (choice !== "break") return;
  await runBreak(targets);
}

async function runBreak(targets) {
  if (manager.busy || manager.loading) return;
  const seq = ++manager.requestSeq;
  setBusy(true);
  const scope = busyOverlay.begin(`Removing ${plural(targets.length, "link")} on Arco Engine...`);
  setManagerStatus(`Breaking ${plural(targets.length, "link")}...`);
  // A break rewrites saved files and rebuilds index.json on the server, so the
  // host is told around it exactly as it is around a refresh.
  postToParent("arcrho:excel-links-retarget-begin");
  let summary = { ok: false, message: "" };
  let payload = null;
  try {
    payload = await postJson(BREAK_ENDPOINT, {
      project_name: projectName,
      reserving_class: reservingClass,
      targets,
    });
    summary = excelLinkBreakSummary(payload);
    setManagerStatus(summary.message, summary.ok ? "success" : "error");
  } catch (error) {
    setManagerStatus(`Could not break the links: ${error.message}`, "error");
  } finally {
    scope.dismiss();
    postToParent("arcrho:excel-links-retarget-end", {
      ok: !!summary.ok,
      changedFileCount: count(payload?.changed_file_count),
    });
    setBusy(false);
  }
  if (seq !== manager.requestSeq) return;
  const outcome = { message: els.status?.textContent || "", tone: els.status?.className.includes("error") ? "error" : "success" };
  await reloadKeepingStatus(outcome);
}

async function reloadKeepingStatus(outcome) {
  const seq = ++manager.requestSeq;
  try {
    const payload = await fetchListing(LIST_ENDPOINT);
    if (seq !== manager.requestSeq) return;
    adoptListing(payload);
    await checkValues(seq);
  } catch {
    // The outcome below is what matters; the poll refreshes the rows later.
  }
  if (seq === manager.requestSeq && outcome?.message) setManagerStatus(outcome.message, outcome.tone);
}

// ---------------------------------------------------------------------------
// Change link
// ---------------------------------------------------------------------------

async function changeWorkbook(row) {
  if (manager.busy || manager.loading) return;
  if (!reservingClass) return;
  const host = hostApi();
  if (!host?.pickOpenFile) {
    setManagerStatus("Changing links is available in the desktop app only.", "error");
    return;
  }
  let picked = "";
  try {
    picked = text(await host.pickOpenFile({
      startDir: row.folder,
      filters: EXCEL_FILE_FILTERS,
    }));
  } catch {
    picked = "";
  }
  if (!picked) return;

  const seq = ++manager.requestSeq;
  setBusy(true);
  const scope = busyOverlay.begin(`Relinking ${row.workbookName} on Arco Server and recalculating the affected datasets and DFM methods...`);
  setManagerStatus(`Relinking ${row.workbookName} to ${picked} on Arco Server and recalculating affected datasets and DFM methods...`);
  // The retarget rewrites files and rebuilds index.json on the server; the
  // host suppresses its own disk-watch prompt for this window's change.
  postToParent("arcrho:excel-links-retarget-begin");
  let summary = { ok: false, message: "" };
  let payload = null;
  try {
    payload = await postJson(RETARGET_ENDPOINT, {
      project_name: projectName,
      reserving_class: reservingClass,
      old_workbook_path: row.workbookPath,
      new_workbook_path: picked,
    });
    summary = excelLinkRetargetSummary(payload);
    setManagerStatus(summary.message, summary.ok ? "success" : "error");
  } catch (error) {
    // A refused workbook arrives as the server's own verdict ("ArcRho Server
    // cannot open the selected workbook: ..."); the picked path is named here
    // because the server redacts paths from its messages.
    setManagerStatus(`Could not change the link to ${picked}: ${error.message}`, "error");
  } finally {
    scope.dismiss();
    postToParent("arcrho:excel-links-retarget-end", {
      ok: !!summary.ok,
      workbookPath: picked,
      changedFileCount: count(payload?.changed_file_count),
    });
    setBusy(false);
  }
  if (seq !== manager.requestSeq) return;
  const outcome = { message: els.status?.textContent || "", tone: els.status?.className.includes("error") ? "error" : "success" };
  await reloadKeepingStatus(outcome);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

// The host posts arcrho:set-zoom to every nested window on load, so this page
// scales with the app exactly like a Dataset or DFM window.
window.ArcRhoZoomBridge?.wirePageZoomBridge();

els.refreshAll?.addEventListener("click", () => void refreshLinks(manager.rows, "all"));
// A nested window saved something in this reserving class: reload and
// re-check, the way the Project Instance dataset table reloads on the same
// event, so a dataset whose links were just refreshed reads Updated here.
window.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type !== "arcrho:excel-links-datasets-changed") return;
  if (manager.busy || manager.loading || manager.checking) return;
  void loadExcelLinks();
});
wireMenu();
void loadExcelLinks();
startPolling();

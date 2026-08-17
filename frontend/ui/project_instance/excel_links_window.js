// Excel Link Manager page.
//
// This runs inside a Project Instance nested window (pi-window). The host frame
// in project_instance_windows.js owns the titlebar, dragging, resizing,
// minimize/maximize/close and the dock; this page owns only the inventory and
// the retarget action. The window is pinned to the reserving class it was
// opened on, which arrives in the query string, so selecting another class in
// the tree leaves it alone exactly like a Dataset or DFM window.
//
// Two messages go back to the Project Instance page, because the retarget
// writes files the host is watching:
//   arcrho:excel-links-retarget-begin  - suppress the host's index-change prompt
//   arcrho:excel-links-retarget-end    - restore it, report status, and reload
//                                        the cached dataset table when values moved
import { attachArcrhoTooltip } from "/ui/shared/components/tooltip/tooltip.js?v=20260812a";
import "/ui/shared/integrations/zoom_bridge.js?v=20260521a";

const LIST_ENDPOINT = "/excel_links/list";
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

function detailMessage(payload, fallback) {
  const detail = payload?.detail;
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  if (Array.isArray(detail) && detail.length) return detail.map((item) => item?.msg || String(item)).join("; ");
  return fallback;
}

export function normalizeExcelLinkWorkbooks(value) {
  const source = Array.isArray(value) ? value : [];
  return source
    .map((item) => ({
      workbookPath: text(item?.workbook_path),
      workbookName: text(item?.workbook_name) || text(item?.workbook_path),
      folder: text(item?.folder),
      exists: item?.exists === true,
      datasetCount: count(item?.dataset_count),
      methodCount: count(item?.method_count),
      linkCount: count(item?.link_count),
      cellCount: count(item?.cell_count),
      usages: (Array.isArray(item?.usages) ? item.usages : [])
        .map((usage) => ({
          kind: usage?.kind === "dfm" ? "dfm" : "dataset",
          name: text(usage?.name),
          linkCount: count(usage?.link_count),
        }))
        .filter((usage) => usage.name),
    }))
    .filter((item) => item.workbookPath);
}

export function excelLinkUsageSummary(workbook) {
  const parts = [];
  if (workbook?.datasetCount) {
    parts.push(`${workbook.datasetCount} dataset${workbook.datasetCount === 1 ? "" : "s"}`);
  }
  if (workbook?.methodCount) {
    parts.push(`${workbook.methodCount} DFM method${workbook.methodCount === 1 ? "" : "s"}`);
  }
  return parts.join(", ") || "Unused";
}

export function excelLinkUsageTooltip(workbook) {
  const lines = (workbook?.usages || []).map((usage) => (
    `${usage.kind === "dfm" ? "DFM" : "Dataset"}: ${usage.name}`
  ));
  return lines.join("\n");
}

export function excelLinkRetargetSummary(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const failures = results.filter((item) => item?.ok === false);
  const changedFiles = count(payload?.changed_file_count);
  const changedLinks = count(payload?.changed_link_count);
  if (failures.length) {
    const first = failures[0];
    const name = text(first?.name) || "a file";
    const error = text(first?.error) || "The file could not be updated.";
    const others = failures.length > 1 ? ` (+${failures.length - 1} more)` : "";
    return {
      ok: false,
      message: `Updated ${changedFiles} of ${changedFiles + failures.length} files; ${name}: ${error}${others}`,
    };
  }
  if (!changedFiles) {
    return { ok: true, message: text(payload?.message) || "No saved links needed a change." };
  }
  const relinked = `Updated ${changedLinks} link${changedLinks === 1 ? "" : "s"} in ${changedFiles} file${changedFiles === 1 ? "" : "s"}.`;
  if (!payload?.refresh_requested) {
    return {
      ok: true,
      message: `${relinked} Values keep their stored snapshots until refreshed.`,
    };
  }
  const failedRefresh = count(payload?.failed_refresh_count);
  if (failedRefresh) {
    return {
      ok: false,
      message: `${relinked} ${failedRefresh} linked cell${failedRefresh === 1 ? "" : "s"} could not be recalculated; refresh them from the Dataset or DFM Links tab.`,
    };
  }
  const refreshedCells = count(payload?.refreshed_cell_count);
  const changedValueFiles = count(payload?.value_changed_file_count);
  if (!changedValueFiles) {
    return {
      ok: true,
      message: `${relinked} The new workbook matches the stored values.`,
    };
  }
  const propagationNote = payload?.propagation_ok === false
    ? " Dependent recalculation reported a problem; check the affected pages."
    : " Dependent recalculation has started.";
  return {
    ok: payload?.propagation_ok !== false,
    message: `${relinked} Recalculated ${refreshedCells} linked cell${refreshedCells === 1 ? "" : "s"} in ${changedValueFiles} file${changedValueFiles === 1 ? "" : "s"}.${propagationNote}`,
  };
}

const params = new URLSearchParams(window.location.search);
const inst = text(params.get("inst"));
const projectName = text(params.get("project"));
const reservingClass = text(params.get("class"));

const els = {
  refresh: document.getElementById("excelLinksRefresh"),
  refreshValues: document.getElementById("excelLinksRefreshValues"),
  body: document.getElementById("excelLinksBody"),
  state: document.getElementById("excelLinksState"),
  status: document.getElementById("excelLinksStatus"),
};

const manager = {
  loading: false,
  busy: false,
  workbooks: [],
  requestSeq: 0,
  scanErrorCount: 0,
};

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

function syncControls() {
  const blocked = manager.busy || manager.loading;
  if (els.refresh) els.refresh.disabled = blocked;
  if (els.refreshValues) els.refreshValues.disabled = manager.busy;
  els.body?.querySelectorAll("button").forEach((button) => {
    button.disabled = blocked;
  });
  document.body.setAttribute("aria-busy", blocked ? "true" : "false");
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

function renderRows() {
  const body = els.body;
  if (!body) return;
  body.replaceChildren();
  manager.workbooks.forEach((workbook) => {
    const row = document.createElement("tr");

    const nameCell = document.createElement("td");
    nameCell.className = "pi-excel-links-workbook";
    nameCell.textContent = workbook.workbookName;
    attachArcrhoTooltip(nameCell, workbook.workbookPath);
    row.appendChild(nameCell);

    const folderCell = document.createElement("td");
    folderCell.className = "pi-excel-links-folder";
    folderCell.textContent = workbook.folder;
    attachArcrhoTooltip(folderCell, workbook.folder);
    row.appendChild(folderCell);

    const statusCell = document.createElement("td");
    const chip = document.createElement("span");
    chip.className = `pi-excel-links-chip ${workbook.exists ? "found" : "missing"}`;
    chip.textContent = workbook.exists ? "Found" : "Missing";
    statusCell.appendChild(chip);
    row.appendChild(statusCell);

    const usageCell = document.createElement("td");
    usageCell.className = "pi-excel-links-usage";
    usageCell.textContent = excelLinkUsageSummary(workbook);
    const usageTooltip = excelLinkUsageTooltip(workbook);
    if (usageTooltip) attachArcrhoTooltip(usageCell, usageTooltip);
    row.appendChild(usageCell);

    const actionCell = document.createElement("td");
    actionCell.className = "pi-excel-links-action";
    const change = document.createElement("button");
    change.type = "button";
    change.textContent = "Change...";
    change.setAttribute("aria-label", `Change linked workbook ${workbook.workbookName}`);
    change.addEventListener("click", () => void changeWorkbook(workbook));
    actionCell.appendChild(change);
    row.appendChild(actionCell);

    body.appendChild(row);
  });
  if (manager.workbooks.length) {
    showState("");
  }
  syncControls();
}

function applyListing(payload) {
  manager.workbooks = normalizeExcelLinkWorkbooks(payload?.workbooks);
  manager.scanErrorCount = Array.isArray(payload?.errors) ? payload.errors.length : 0;
  renderRows();
  if (!manager.workbooks.length) {
    showState("No Excel links are saved in this reserving class.");
  }
  const scanned = `${count(payload?.dataset_scan_count)} dataset${count(payload?.dataset_scan_count) === 1 ? "" : "s"}`;
  const summary = manager.workbooks.length
    ? `${manager.workbooks.length} linked workbook${manager.workbooks.length === 1 ? "" : "s"} found.`
    : "";
  const skipped = manager.scanErrorCount
    ? ` ${manager.scanErrorCount} file${manager.scanErrorCount === 1 ? "" : "s"} could not be read.`
    : "";
  setManagerStatus(`${summary}${skipped}`.trim() || `Scanned ${scanned}.`, manager.scanErrorCount ? "error" : "");
}

async function loadExcelLinks() {
  const seq = ++manager.requestSeq;
  manager.workbooks = [];
  renderRows();
  if (!projectName || !reservingClass) {
    manager.loading = false;
    showState("This window is missing its project or reserving class.");
    setManagerStatus("");
    syncControls();
    return;
  }
  manager.loading = true;
  showState("Loading Excel links...");
  setManagerStatus("");
  syncControls();
  try {
    const response = await fetch(LIST_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: projectName, reserving_class: reservingClass }),
    });
    const payload = await response.json().catch(() => ({}));
    if (seq !== manager.requestSeq) return;
    if (!response.ok || payload?.ok === false) {
      throw new Error(detailMessage(payload, `HTTP ${response.status}`));
    }
    manager.loading = false;
    applyListing(payload);
  } catch (error) {
    if (seq !== manager.requestSeq) return;
    manager.loading = false;
    showState("Excel links could not be loaded.");
    setManagerStatus(`Could not load Excel links: ${error.message}`, "error");
  } finally {
    if (seq === manager.requestSeq) syncControls();
  }
}

function resetRefreshValuesChoice() {
  // Recalculation is a per-change decision that always defaults back to No.
  if (els.refreshValues) els.refreshValues.checked = false;
}

async function changeWorkbook(workbook) {
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
      startDir: workbook.folder,
      filters: EXCEL_FILE_FILTERS,
    }));
  } catch {
    picked = "";
  }
  if (!picked) return;

  const refreshValues = els.refreshValues?.checked === true;
  const seq = ++manager.requestSeq;
  setBusy(true);
  setManagerStatus(refreshValues
    ? `Relinking ${workbook.workbookName} and recalculating affected datasets and DFM methods...`
    : `Relinking ${workbook.workbookName} for every dataset and DFM method...`);
  // The retarget rebuilds index.json server-side; the host suppresses its own
  // disk-watch prompt for this window's write.
  postToParent("arcrho:excel-links-retarget-begin");
  let summary = { ok: false, message: "" };
  let payload = null;
  try {
    const response = await fetch(RETARGET_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: projectName,
        reserving_class: reservingClass,
        old_workbook_path: workbook.workbookPath,
        new_workbook_path: picked,
        refresh_values: refreshValues,
      }),
    });
    payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(detailMessage(payload, `HTTP ${response.status}`));
    summary = excelLinkRetargetSummary(payload);
    if (seq === manager.requestSeq) {
      manager.workbooks = normalizeExcelLinkWorkbooks(payload?.workbooks);
      renderRows();
      if (!manager.workbooks.length) showState("No Excel links are saved in this reserving class.");
    }
    setManagerStatus(summary.message, summary.ok ? "success" : "error");
  } catch (error) {
    setManagerStatus(`Could not change the link: ${error.message}`, "error");
  } finally {
    postToParent("arcrho:excel-links-retarget-end", {
      ok: !!summary.ok,
      workbookPath: picked,
      changedFileCount: count(payload?.changed_file_count),
      valueChangedFileCount: refreshValues ? count(payload?.value_changed_file_count) : 0,
    });
    resetRefreshValuesChoice();
    setBusy(false);
  }
}

// The host posts arcrho:set-zoom to every nested window on load, so this page
// scales with the app exactly like a Dataset or DFM window.
window.ArcRhoZoomBridge?.wirePageZoomBridge();

els.refresh?.addEventListener("click", () => void loadExcelLinks());
resetRefreshValuesChoice();
void loadExcelLinks();

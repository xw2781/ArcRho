import { attachArcrhoTooltip } from "/ui/shared/components/tooltip/tooltip.js?v=20260715a";

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
  return {
    ok: true,
    message: `Updated ${changedLinks} link${changedLinks === 1 ? "" : "s"} in ${changedFiles} file${changedFiles === 1 ? "" : "s"}. Values keep their stored snapshots until refreshed.`,
  };
}

export function installProjectInstanceExcelLinks(ctx) {
  const { api, els, state, projectName } = ctx;
  const normalizePath = (...args) => api.normalizePath(...args);
  const setStatus = (...args) => api.setStatus(...args);
  const manager = {
    loading: false,
    busy: false,
    workbooks: [],
    scanErrorCount: 0,
    requestSeq: 0,
    drag: null,
    lastFocus: null,
  };

  function hostApi() {
    try {
      return window.ADAHost || window.parent?.ADAHost || window.top?.ADAHost || null;
    } catch {
      return null;
    }
  }

  function isOpen() {
    return !!els.excelLinksWindow && !els.excelLinksWindow.hidden;
  }

  function setManagerStatus(message, tone = "") {
    if (!els.excelLinksStatus) return;
    els.excelLinksStatus.textContent = text(message);
    els.excelLinksStatus.className = `pi-excel-links-status${tone ? ` ${tone}` : ""}`;
  }

  function setBusy(busy) {
    manager.busy = !!busy;
    syncControls();
  }

  function syncControls() {
    const blocked = manager.busy || manager.loading;
    if (els.excelLinksRefresh) els.excelLinksRefresh.disabled = blocked;
    if (els.excelLinksClose) els.excelLinksClose.disabled = manager.busy;
    els.excelLinksBody?.querySelectorAll("button").forEach((button) => {
      button.disabled = blocked;
    });
    els.excelLinksWindow?.setAttribute("aria-busy", blocked ? "true" : "false");
  }

  function renderPathLabel() {
    if (!els.excelLinksPath) return;
    const path = normalizePath(state.selectedPath);
    els.excelLinksPath.textContent = path || "Select a reserving class path.";
  }

  function showState(message) {
    if (!els.excelLinksState) return;
    els.excelLinksState.textContent = text(message);
    els.excelLinksState.hidden = !els.excelLinksState.textContent;
  }

  function renderRows() {
    const body = els.excelLinksBody;
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
    renderPathLabel();
    const path = normalizePath(state.selectedPath);
    const seq = ++manager.requestSeq;
    manager.workbooks = [];
    renderRows();
    if (!projectName || !path) {
      manager.loading = false;
      showState("Select a reserving class path to see its Excel links.");
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
        body: JSON.stringify({ project_name: projectName, reserving_class: path }),
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

  async function changeWorkbook(workbook) {
    if (manager.busy || manager.loading) return;
    const path = normalizePath(state.selectedPath);
    if (!path) return;
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

    const seq = ++manager.requestSeq;
    setBusy(true);
    setManagerStatus(`Relinking ${workbook.workbookName} for every dataset and DFM method...`);
    // The retarget rebuilds index.json server-side; suppress the disk watcher
    // prompt for this window's own write.
    if (state.datasetIndexWatch) state.datasetIndexWatch.suppressUntil = Date.now() + 30000;
    try {
      const response = await fetch(RETARGET_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_name: projectName,
          reserving_class: path,
          old_workbook_path: workbook.workbookPath,
          new_workbook_path: picked,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(detailMessage(payload, `HTTP ${response.status}`));
      const summary = excelLinkRetargetSummary(payload);
      if (seq === manager.requestSeq && normalizePath(state.selectedPath) === path) {
        manager.workbooks = normalizeExcelLinkWorkbooks(payload?.workbooks);
        renderRows();
        if (!manager.workbooks.length) showState("No Excel links are saved in this reserving class.");
      }
      setManagerStatus(summary.message, summary.ok ? "success" : "error");
      if (summary.ok && count(payload?.changed_file_count)) {
        setStatus(`Excel links now read from ${picked}.`);
      }
    } catch (error) {
      setManagerStatus(`Could not change the link: ${error.message}`, "error");
    } finally {
      if (state.datasetIndexWatch) state.datasetIndexWatch.suppressUntil = Date.now() + 1500;
      setBusy(false);
    }
  }

  function openExcelLinkManager() {
    if (!els.excelLinksWindow) return;
    if (isOpen()) {
      closeExcelLinkManager();
      return;
    }
    manager.lastFocus = document.activeElement;
    els.excelLinksWindow.hidden = false;
    els.excelLinksBtn?.classList.add("active");
    els.excelLinksBtn?.setAttribute("aria-pressed", "true");
    void loadExcelLinks();
    els.excelLinksRefresh?.focus?.();
  }

  function closeExcelLinkManager() {
    if (manager.busy || !isOpen()) return;
    manager.requestSeq += 1;
    manager.loading = false;
    els.excelLinksWindow.hidden = true;
    els.excelLinksBtn?.classList.remove("active");
    els.excelLinksBtn?.setAttribute("aria-pressed", "false");
    manager.lastFocus?.focus?.();
    manager.lastFocus = null;
  }

  /** Keeps an open manager in sync when the selected reserving class changes. */
  function syncExcelLinkManagerPath() {
    if (!isOpen()) return;
    void loadExcelLinks();
  }

  function beginDrag(event) {
    if (event.button !== 0 || event.target.closest("button")) return;
    const win = els.excelLinksWindow;
    const rect = win?.getBoundingClientRect();
    if (!win || !rect) return;
    win.style.transform = "none";
    win.style.left = `${rect.left}px`;
    win.style.top = `${rect.top}px`;
    manager.drag = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
    event.preventDefault();
  }

  function moveDrag(event) {
    if (!manager.drag) return;
    const win = els.excelLinksWindow;
    const maxLeft = Math.max(8, window.innerWidth - win.offsetWidth - 8);
    const maxTop = Math.max(8, window.innerHeight - 42);
    win.style.left = `${Math.max(8, Math.min(event.clientX - manager.drag.offsetX, maxLeft))}px`;
    win.style.top = `${Math.max(8, Math.min(event.clientY - manager.drag.offsetY, maxTop))}px`;
  }

  function initExcelLinkManager() {
    if (!els.excelLinksBtn || els.excelLinksBtn.dataset.wired === "1") return;
    els.excelLinksBtn.dataset.wired = "1";
    attachArcrhoTooltip(els.excelLinksBtn, "Manage Excel Links");
    els.excelLinksBtn.addEventListener("click", openExcelLinkManager);
    els.excelLinksClose?.addEventListener("click", closeExcelLinkManager);
    els.excelLinksRefresh?.addEventListener("click", () => void loadExcelLinks());
    els.excelLinksHeader?.addEventListener("pointerdown", beginDrag);
    window.addEventListener("pointermove", moveDrag);
    window.addEventListener("pointerup", () => { manager.drag = null; });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !isOpen() || manager.busy) return;
      if (!els.excelLinksWindow.contains(document.activeElement)) return;
      event.preventDefault();
      closeExcelLinkManager();
    });
  }

  Object.assign(api, {
    initExcelLinkManager,
    openExcelLinkManager,
    syncExcelLinkManagerPath,
  });
}

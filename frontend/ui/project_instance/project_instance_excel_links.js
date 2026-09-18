// Project Instance host for the Excel Link Manager nested window.
//
// The manager itself lives in excel_links_window.html and runs inside a normal
// pi-window, so it drags, resizes, minimizes to the dock, maximizes, and closes
// exactly like a Dataset or DFM window. This module opens that window, reacts
// to the two messages it sends around a write (a retarget or a link refresh),
// both of which concern files the Project Instance page is watching, and
// tells every open manager for a reserving class when a nested window saved
// something there, so the manager reloads the way the dataset table does.
//
// The window is pinned to the reserving class it was opened on, like every
// other nested window: selecting another class in the tree leaves it alone and
// opens a second window for that class instead.
import { attachArcrhoTooltip } from "/ui/shared/components/tooltip/tooltip.js?v=20260812a";

// A retarget or a refresh is an Engine-hosted job that rewrites and refreshes
// every affected object and rebuilds the index as it goes; the client gives it
// the hosted-save processing timeout, and the end message shortens this again.
const RETARGET_INDEX_WATCH_SUPPRESS_MS = 180000;
// Sent into every open manager of a reserving class after a nested window's
// save there, so the manager reloads and re-checks its linked values.
const EXCEL_LINKS_DATASETS_CHANGED_MESSAGE = "arcrho:excel-links-datasets-changed";
// The table reload after retarget-end re-baselines the watch from the
// snapshot payload's authoritative signature, so this brief hold only covers
// a poll racing that reload (see DATASET_INDEX_SETTLE_SUPPRESS_MS in
// project_instance_dataset_cache.js).
const SETTLED_INDEX_WATCH_SUPPRESS_MS = 1500;

export function installProjectInstanceExcelLinks(ctx) {
  const { api, els, state, projectName } = ctx;
  const normalizePath = (...args) => api.normalizePath(...args);
  const setStatus = (...args) => api.setStatus(...args);
  const toText = (...args) => api.toText(...args);

  function getExcelLinksWindowKey(path) {
    // Same shape as the dataset and method window keys: a kind tag, the unit
    // separator, then the normalized reserving-class path.
    return `excel_links${normalizePath(path)}`;
  }

  function buildExcelLinksWindowUrl(inst, path) {
    const params = new URLSearchParams();
    params.set("project", projectName);
    params.set("class", path);
    params.set("inst", inst);
    params.set("project_instance", "1");
    params.set("v", String(Date.now()));
    return `/ui/project_instance/excel_links_window.html?${params.toString()}`;
  }

  function isExcelLinksWindow(frame) {
    return frame?.dataset?.windowKind === "excel_links";
  }

  function openExcelLinkManager() {
    const path = normalizePath(state.selectedPath);
    if (!path) {
      setStatus("Select a reserving class path before opening Excel links.", true);
      return null;
    }
    const inst = `pi_excel_links_${Date.now()}_${state.windowSeq++}`;
    // An already-open window for this class is re-activated rather than duplicated.
    return api.createFloatingContentWindow({
      kind: "excel_links",
      name: "Manage Excel Links",
      itemName: "Manage Excel Links",
      title: `${path}\\Manage Excel Links`,
      windowKey: getExcelLinksWindowKey(path),
      inst,
      iframeSrc: buildExcelLinksWindowUrl(inst, path),
      path,
    });
  }

  function suppressIndexWatch(milliseconds) {
    if (state.datasetIndexWatch) {
      state.datasetIndexWatch.suppressUntil = Date.now() + milliseconds;
    }
  }

  /** Handles the messages excel_links_window.js sends around a retarget. */
  function handleExcelLinksWindowMessage(message, sourceWindow) {
    const frame = api.findWindowByInstance(message?.inst)
      || api.findWindowByMessageSource(sourceWindow);
    if (!isExcelLinksWindow(frame)) return true;
    if (message.type === "arcrho:excel-links-retarget-begin") {
      // The retarget rebuilds index.json server-side; keep the disk watcher
      // quiet about this window's own write.
      suppressIndexWatch(RETARGET_INDEX_WATCH_SUPPRESS_MS);
      return true;
    }
    if (message.type !== "arcrho:excel-links-retarget-end") return true;
    suppressIndexWatch(SETTLED_INDEX_WATCH_SUPPRESS_MS);
    const workbookPath = toText(message.workbookPath);
    if (message.ok && Number(message.changedFileCount) > 0 && workbookPath) {
      setStatus(`Excel links now read from ${workbookPath}.`);
    }
    if (Number(message.changedFileCount) > 0) {
      // Every changed file was re-saved and its dependents flagged Needs
      // Review, whether or not a value moved; reload the dataset table.
      void api.refreshCachedDatasetTableFromDisk?.();
    }
    return true;
  }

  /**
   * Tells every open manager for `path` that a nested window saved something
   * in that reserving class. Sent from the same event that reloads the
   * dataset table, so a dataset whose links were just refreshed and saved
   * reads Updated in the manager without a manual reload. A manager for
   * another class is left alone.
   */
  function notifyExcelLinksWindows(path) {
    const target = normalizePath(path);
    if (!target) return;
    const frames = els.windowLayer?.querySelectorAll('.pi-window[data-window-kind="excel_links"]') || [];
    for (const frame of frames) {
      if (normalizePath(frame.dataset.windowPath) !== target) continue;
      try {
        frame.querySelector("iframe")?.contentWindow?.postMessage({ type: EXCEL_LINKS_DATASETS_CHANGED_MESSAGE }, "*");
      } catch {}
    }
  }

  function initExcelLinkManager() {
    if (!els.excelLinksBtn || els.excelLinksBtn.dataset.wired === "1") return;
    els.excelLinksBtn.dataset.wired = "1";
    attachArcrhoTooltip(els.excelLinksBtn, "Manage Excel Links");
    els.excelLinksBtn.addEventListener("click", () => void openExcelLinkManager());
  }

  Object.assign(api, {
    handleExcelLinksWindowMessage,
    initExcelLinkManager,
    isExcelLinksWindow,
    notifyExcelLinksWindows,
    openExcelLinkManager,
  });
}

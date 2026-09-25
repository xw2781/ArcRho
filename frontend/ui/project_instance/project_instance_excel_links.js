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
//
// This module also runs that check for the dataset table itself, so a stale
// link is visible without opening the manager at all. It reads the same two
// endpoints on the same terms - the listing on a timer, the values only when
// the listing moved - and hands the dataset table one verdict per object,
// which that table folds into its Status column. While a manager for the
// selected class is open the poll stands down and the answer comes from that
// window instead, so a class is never read twice.
import { attachArcrhoTooltip } from "/ui/shared/components/tooltip/tooltip.js?v=20260925a";
import {
  LISTING_POLL_MS,
  excelLinkChangeSentence,
  excelLinkListingSignature,
  excelLinkObjectStatuses,
  normalizeExcelLinkWorkbooks,
} from "/ui/shared/dataset/excel_link_inventory.js?v=20260919a";

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
const LIST_ENDPOINT = "/excel_links/list";
const CHECK_ENDPOINT = "/excel_links/check";
// Posted by a manager window after every value check, so the dataset table
// takes that answer instead of reading the same workbooks again.
const EXCEL_LINKS_STATUS_MESSAGE = "arcrho:excel-links-status";

export function installProjectInstanceExcelLinks(ctx) {
  const { api, els, state, projectName } = ctx;
  const normalizePath = (...args) => api.normalizePath(...args);
  const normalizeLookupKey = (...args) => api.normalizeLookupKey(...args);
  const renderDatasetTable = (...args) => api.renderDatasetTable(...args);
  const setStatus = (...args) => api.setStatus(...args);
  const toText = (...args) => api.toText(...args);

  // The dataset table's Excel-link verdicts for the loaded reserving class:
  // one entry per object whose stored values no longer match its workbook,
  // keyed by the same lookup key the table matches its rows on.
  const linkStatus = {
    path: "",
    signature: "",
    byName: new Map(),
    // null until the first listing of this class says whether it has any.
    hasLinks: null,
    seq: 0,
    busy: false,
    rerun: false,
    timer: 0,
    visibilityWired: false,
  };

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
    if (message.type === EXCEL_LINKS_STATUS_MESSAGE) {
      // The manager just read every workbook of its class; the dataset table
      // takes that answer when the class is the one it is showing.
      adoptExcelLinkStatuses(
        normalizeExcelLinkWorkbooks(message.workbooks, { valueCheck: true }),
        toText(message.reservingClass),
      );
      return true;
    }
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
    for (const frame of excelLinksWindowsForPath(path)) {
      try {
        frame.querySelector("iframe")?.contentWindow?.postMessage({ type: EXCEL_LINKS_DATASETS_CHANGED_MESSAGE }, "*");
      } catch {}
    }
  }

  /** Every open manager window pinned to `path`. */
  function excelLinksWindowsForPath(path) {
    const target = normalizePath(path);
    if (!target) return [];
    const frames = els.windowLayer?.querySelectorAll('.pi-window[data-window-kind="excel_links"]') || [];
    return [...frames].filter((frame) => normalizePath(frame.dataset.windowPath) === target);
  }

  // -------------------------------------------------------------------------
  // The dataset table's Excel-link verdicts
  // -------------------------------------------------------------------------

  async function readExcelLinks(endpoint, path) {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: projectName, reserving_class: path }),
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || payload?.ok === false) {
      throw new Error(toText(payload?.detail) || `Excel link read failed (${resp.status})`);
    }
    return payload;
  }

  function excelLinkStatusSignature(byName) {
    return JSON.stringify([...byName.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, entry.changedCellCount, entry.workbookNames.join("|")]));
  }

  /** Adopts one checked listing and repaints the table only when it moved. */
  function adoptExcelLinkStatuses(workbooks, path) {
    if (normalizePath(path).toLowerCase() !== normalizePath(linkStatus.path).toLowerCase()) return;
    const byName = new Map();
    for (const entry of excelLinkObjectStatuses(workbooks)) {
      byName.set(normalizeLookupKey(entry.name), entry);
    }
    if (excelLinkStatusSignature(byName) === excelLinkStatusSignature(linkStatus.byName)) return;
    linkStatus.byName = byName;
    renderDatasetTable();
  }

  /**
   * One pass: read the listing and, when it moved since the last one, read
   * every linked cell and settle each object by value. A `poll` pass stands
   * down while the window is hidden or a manager for this class is open,
   * because that window is already doing exactly this and reports its answer.
   */
  async function refreshExcelLinkStatuses(options = {}) {
    const poll = options.poll === true;
    const path = normalizePath(linkStatus.path);
    if (!projectName || !path) return;
    if (poll && (document.hidden || excelLinksWindowsForPath(path).length)) return;
    if (linkStatus.busy) {
      // A class change that lands mid-read is not news the running read can
      // answer, so it runs again once that one is out of the way.
      if (!poll) linkStatus.rerun = true;
      return;
    }
    linkStatus.busy = true;
    const seq = linkStatus.seq;
    try {
      const listing = normalizeExcelLinkWorkbooks((await readExcelLinks(LIST_ENDPOINT, path))?.workbooks);
      if (seq !== linkStatus.seq) return;
      // Nothing in this class reads a workbook, so there is nothing to watch
      // and the class is not scanned again on a timer; a save here, which is
      // what adds a link, starts the watch again.
      linkStatus.hasLinks = listing.length > 0;
      if (!linkStatus.hasLinks) stopExcelLinkStatusTimer();
      const signature = excelLinkListingSignature(listing);
      if (signature === linkStatus.signature) return;
      linkStatus.signature = signature;
      if (!listing.length) {
        adoptExcelLinkStatuses([], path);
        return;
      }
      const checked = normalizeExcelLinkWorkbooks(
        (await readExcelLinks(CHECK_ENDPOINT, path))?.workbooks,
        { valueCheck: true },
      );
      if (seq !== linkStatus.seq) return;
      adoptExcelLinkStatuses(checked, path);
    } catch {
      // A read that fails says nothing about the links; the next pass, or the
      // user opening the manager, tries again.
      linkStatus.signature = "";
    } finally {
      linkStatus.busy = false;
      if (linkStatus.rerun) {
        linkStatus.rerun = false;
        void refreshExcelLinkStatuses();
      }
    }
  }

  function stopExcelLinkStatusTimer() {
    if (!linkStatus.timer) return;
    clearInterval(linkStatus.timer);
    linkStatus.timer = 0;
  }

  function startExcelLinkStatusTimer() {
    stopExcelLinkStatusTimer();
    if (!linkStatus.path || linkStatus.hasLinks === false) return;
    if (typeof document !== "undefined" && document.hidden) return;
    linkStatus.timer = setInterval(() => void refreshExcelLinkStatuses({ poll: true }), LISTING_POLL_MS);
    // Node's timer object keeps its event loop alive; the browser's numeric
    // handle has no unref, so this only matters when a test loads this module.
    linkStatus.timer?.unref?.();
  }

  function ensureExcelLinkStatusVisibilityListener() {
    if (linkStatus.visibilityWired || typeof document === "undefined") return;
    linkStatus.visibilityWired = true;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        stopExcelLinkStatusTimer();
        return;
      }
      startExcelLinkStatusTimer();
      void refreshExcelLinkStatuses({ poll: true });
    });
  }

  function stopExcelLinkStatusWatch() {
    stopExcelLinkStatusTimer();
    linkStatus.seq += 1;
    linkStatus.path = "";
    linkStatus.signature = "";
    linkStatus.byName = new Map();
    linkStatus.hasLinks = null;
  }

  /**
   * Follows the dataset table: a newly loaded class is checked at once, and a
   * reload of the same class - a save, a refresh - only looks for a listing
   * that moved, which a save in the class always does.
   */
  function startExcelLinkStatusWatch(path) {
    const normalized = normalizePath(path);
    if (!normalized) {
      stopExcelLinkStatusWatch();
      return;
    }
    const samePath = normalized.toLowerCase() === normalizePath(linkStatus.path).toLowerCase();
    linkStatus.seq += 1;
    linkStatus.path = normalized;
    if (!samePath) {
      linkStatus.signature = "";
      linkStatus.byName = new Map();
      linkStatus.hasLinks = null;
    }
    ensureExcelLinkStatusVisibilityListener();
    startExcelLinkStatusTimer();
    void refreshExcelLinkStatuses({ poll: samePath });
  }

  /**
   * The dataset table's lookup: what this object's linked workbooks now say,
   * or null when nothing about it moved.
   */
  function getExcelLinkStatus(name) {
    const key = normalizeLookupKey(name);
    return key ? linkStatus.byName.get(key) || null : null;
  }

  /** The Status tooltip sentence for a row whose linked values moved. */
  function getExcelLinkStatusSentence(name) {
    return excelLinkChangeSentence(getExcelLinkStatus(name));
  }

  function initExcelLinkManager() {
    if (!els.excelLinksBtn || els.excelLinksBtn.dataset.wired === "1") return;
    els.excelLinksBtn.dataset.wired = "1";
    attachArcrhoTooltip(els.excelLinksBtn, "Manage Excel Links");
    els.excelLinksBtn.addEventListener("click", () => void openExcelLinkManager());
  }

  Object.assign(api, {
    getExcelLinkStatus,
    getExcelLinkStatusSentence,
    handleExcelLinksWindowMessage,
    initExcelLinkManager,
    isExcelLinksWindow,
    notifyExcelLinksWindows,
    openExcelLinkManager,
    startExcelLinkStatusWatch,
    stopExcelLinkStatusWatch,
  });
}

/*
===============================================================================
DFM Tabs - Orchestrator
Initializes all DFM tabs, wires event handlers, and coordinates modules.
===============================================================================
*/
import { createTabbedPage } from "/ui/shared/tabbed_page.js";
import { setStorageInstance, loadNaBorders } from "/ui/dfm/dfm_storage.js";
import {
  getDfmInst,
  ALLOWED_DFM_TABS,
  setShowNaBorders,
  setCachedRootPath,
  setCurrentDfmTab,
  getCurrentDfmTab,
  getDfmIsDirty,
  markDfmDirty,
  notifyDfmEditState,
  buildRatioSavePath,
} from "/ui/dfm/dfm_state.js";
import {
  renderRatioTable,
  wireRatioStrikeToggle,
  wireRatioChartModal,
  wireRatioContextMenu,
  wireDfmSpinnerControls,
  excludeExtremeInActiveCol,
  includeAllInActiveCol,
  isRatioChartOpen,
  scheduleRatioChartRender,
  restoreRatioHistoryUi,
} from "/ui/dfm/dfm_ratios_tab.js";
import {
  renderResultsTable,
  wireResultsRatioBasisControls,
} from "/ui/dfm/dfm_results_tab.js";
import { wireNotesInput } from "/ui/dfm/dfm_notes_tab.js";
import {
  syncMethodNameFromInputs,
  syncOutputTypeFromProject,
  updatePathBar,
  wireMethodName,
  wireDfmInstanceCreationNotice,
  wireDetailsThresholdReset,
} from "/ui/dfm/dfm_details.js";
import {
  scheduleRatioSelectionLoad,
  saveRatioSelectionPattern,
  restoreCleanDfmMethodState,
  saveDfmTemplate,
  loadDfmTemplate,
  applyDfmMethodPayload,
  buildDfmAssistantContextPayload,
  startDfmMethodFileWatcher,
  stopDfmMethodFileWatcher,
} from "/ui/dfm/dfm_persistence.js?v=20260604a";
import { wireRatioSyncChannel, requestRatioStateSync } from "/ui/dfm/dfm_sync.js";
import { wireDfmRpcBridgePathBar } from "/ui/dfm/dfm_rpc_bridge_pathbar.js?v=20260514a";
import { wireDfmTabPopoutWindows } from "/ui/dfm/dfm_tab_popout_window.js";
import {
  clearRatioHistoryTempSession,
  getRatioHistoryState,
  initRatioHistory,
  runRatioRedo,
  runRatioUndo,
} from "/ui/dfm/dfm_ratio_history.js";

const DEFAULT_TOKEN = "__DEFAULT__";
let dfmSaveInFlight = false;
let dfmCancelConfirmResolve = null;

function getDfmInputSnapshotSafe() {
  try {
    if (typeof window.ADA_GET_DFM_INPUTS === "function") {
      return window.ADA_GET_DFM_INPUTS();
    }
  } catch {
    // ignore
  }
  const project = document.getElementById("projectSelect")?.value?.trim() || "";
  const reservingClass = document.getElementById("pathInput")?.value?.trim() || "";
  return {
    resolved: { project, reservingClass },
    display: { project, reservingClass },
    defaults: { projectDefault: false, reservingClassDefault: false },
  };
}

function handleDatasetUpdated() {
  refreshDfmTabContent("dataset-updated");
}

function refreshDfmTabContent(reason = "") {
  renderRatioTable();
  renderResultsTable();
  syncMethodNameFromInputs();
  syncOutputTypeFromProject();
  updatePathBar();
  if (!getDfmIsDirty()) {
    scheduleRatioSelectionLoad(reason || "dfm-refresh");
  }
  if (isRatioChartOpen()) scheduleRatioChartRender();
}

async function buildAssistantContext() {
  let methodPath = "";
  let pathError = "";
  let activeJson = null;
  let activeJsonError = "";
  try {
    methodPath = await buildRatioSavePath();
  } catch (err) {
    pathError = String(err?.message || err || "Could not resolve DFM method path.");
  }
  try {
    activeJson = await buildDfmAssistantContextPayload({ persistSummaryOrder: false });
  } catch (err) {
    activeJsonError = String(err?.message || err || "Could not build active DFM method payload.");
  }
  const inputSnap = getDfmInputSnapshotSafe();
  return {
    available: true,
    pageType: "dfm",
    activeDfmTab: getCurrentDfmTab(),
    methodPath,
    pathError,
    activeJson,
    activeJsonSource: activeJson ? "dfm-ui-state" : "",
    activeJsonError,
    dirty: getDfmIsDirty(),
    fields: {
      project: inputSnap.resolved?.project || document.getElementById("projectSelect")?.value?.trim() || "",
      reservingClass: inputSnap.resolved?.reservingClass || document.getElementById("pathInput")?.value?.trim() || "",
      methodName: document.getElementById("dfmMethodName")?.value?.trim() || "",
      outputVector: document.getElementById("dfmOutputVector")?.value?.trim() || "",
      inputTriangle: document.getElementById("triInput")?.value?.trim() || "",
      originLength: document.getElementById("originLenSelect")?.value?.trim() || "",
      developmentLength: document.getElementById("devLenSelect")?.value?.trim() || "",
    },
  };
}

function postDfmStatus(text, tone = "") {
  window.parent.postMessage({ type: "arcrho:status", text: String(text || ""), tone }, "*");
}

function updateDfmSaveUi() {
  const saveBtn = document.getElementById("dfmSaveBtn");
  const cancelBtn = document.getElementById("dfmCancelBtn");
  const dirty = getDfmIsDirty();
  if (saveBtn) {
    saveBtn.disabled = dfmSaveInFlight || !dirty;
    saveBtn.classList.toggle("is-clean", !dirty);
  }
  if (cancelBtn) {
    cancelBtn.disabled = dfmSaveInFlight || !dirty;
  }
}

function resolveDfmCancelConfirm(value) {
  const overlay = document.getElementById("dfmCancelConfirmOverlay");
  if (overlay) overlay.hidden = true;
  const resolve = dfmCancelConfirmResolve;
  dfmCancelConfirmResolve = null;
  if (resolve) resolve(!!value);
}

function showDfmCancelConfirm() {
  if (dfmCancelConfirmResolve) return Promise.resolve(false);
  const overlay = document.getElementById("dfmCancelConfirmOverlay");
  const yesBtn = document.getElementById("dfmCancelConfirmYes");
  if (!overlay || !yesBtn) return Promise.resolve(false);
  overlay.hidden = false;
  requestAnimationFrame(() => yesBtn.focus());
  return new Promise((resolve) => {
    dfmCancelConfirmResolve = resolve;
  });
}

async function saveCurrentDfmMethodFromBar() {
  if (dfmSaveInFlight) return;
  dfmSaveInFlight = true;
  updateDfmSaveUi();
  try {
    const result = await saveRatioSelectionPattern(false);
    if (!result?.ok && result?.error) {
      postDfmStatus(`DFM save failed: ${result.error}`, "error");
    }
  } finally {
    dfmSaveInFlight = false;
    updateDfmSaveUi();
  }
}

async function cancelCurrentDfmChangesFromBar() {
  if (dfmSaveInFlight || !getDfmIsDirty()) return;
  const discard = await showDfmCancelConfirm();
  if (!discard) return;
  const result = await restoreCleanDfmMethodState();
  if (result?.ok) {
    postDfmStatus("DFM changes discarded.");
  } else {
    postDfmStatus(`DFM cancel failed: ${result?.error || "Could not restore saved method."}`, "error");
  }
  updateDfmSaveUi();
}

function wireDfmSaveControls() {
  document.getElementById("dfmSaveBtn")?.addEventListener("click", () => {
    void saveCurrentDfmMethodFromBar();
  });
  document.getElementById("dfmCancelBtn")?.addEventListener("click", () => {
    void cancelCurrentDfmChangesFromBar();
  });
  document.getElementById("dfmCancelConfirmYes")?.addEventListener("click", () => {
    resolveDfmCancelConfirm(true);
  });
  document.getElementById("dfmCancelConfirmNo")?.addEventListener("click", () => {
    resolveDfmCancelConfirm(false);
  });
  document.getElementById("dfmCancelConfirmClose")?.addEventListener("click", () => {
    resolveDfmCancelConfirm(false);
  });
  document.getElementById("dfmCancelConfirmOverlay")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) resolveDfmCancelConfirm(false);
  });
  document.getElementById("dfmCancelConfirmOverlay")?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      resolveDfmCancelConfirm(false);
    }
  });
  window.addEventListener("arcrho:dfm-dirty-state", updateDfmSaveUi);
  updateDfmSaveUi();
}

function openPathViaShellBridge(targetPath, preferredApp = "") {
  return new Promise((resolve) => {
    if (!targetPath || !window.parent || window.parent === window) {
      resolve({ ok: false, error: "Open path requires desktop app." });
      return;
    }
    const requestId = `dfm-open-json-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let done = false;
    let timeoutId = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (timeoutId != null) window.clearTimeout(timeoutId);
      window.removeEventListener("message", onMessage);
      resolve(result || { ok: false, error: "Open path failed." });
    };
    const onMessage = (evt) => {
      const msg = evt?.data;
      if (!msg || msg.type !== "arcrho:open-path-result") return;
      if (String(msg.requestId || "") !== requestId) return;
      finish({ ok: !!msg.ok, error: String(msg.error || "") });
    };
    window.addEventListener("message", onMessage);
    timeoutId = window.setTimeout(() => {
      finish({ ok: false, error: "Open path timed out." });
    }, 5000);
    try {
      window.parent.postMessage({ type: "arcrho:open-path", requestId, path: targetPath, preferredApp }, "*");
    } catch {
      finish({ ok: false, error: "Open path requires desktop app." });
    }
  });
}

async function openCurrentDfmMethodJson() {
  let methodPath = "";
  try {
    methodPath = await buildRatioSavePath();
  } catch (err) {
    postDfmStatus(`Open DFM JSON failed: ${String(err?.message || err)}`, "error");
    return;
  }
  if (!methodPath) {
    postDfmStatus("Open DFM JSON failed: no DFM JSON path is available.", "error");
    return;
  }
  try {
    const hostApi = window.ADAHost || null;
    const result = hostApi && typeof hostApi.openPath === "function"
      ? await hostApi.openPath({ path: methodPath, preferredApp: "vscode" })
      : await openPathViaShellBridge(methodPath, "vscode");
    if (result?.ok) {
      postDfmStatus(`Opened DFM JSON: ${methodPath}`);
    } else {
      postDfmStatus(`Open DFM JSON failed: ${result?.error || methodPath}`, "error");
    }
  } catch (err) {
    postDfmStatus(`Open DFM JSON failed: ${String(err?.message || err)}`, "error");
  }
}

function initDfmTabs() {
  const detailsPage = document.getElementById("dfmDetailsPage");
  const dataPage = document.getElementById("dfmDataPage");
  const ratiosPage = document.getElementById("dfmRatiosPage");
  const resultsPage = document.getElementById("dfmResultsPage");
  const notesPage = document.getElementById("dfmNotesPage");
  if (!detailsPage || !dataPage || !ratiosPage || !resultsPage || !notesPage) return;

  setShowNaBorders(loadNaBorders());

  wireDfmSpinnerControls();
  wireMethodName();
  wireDfmInstanceCreationNotice();
  wireNotesInput();
  wireDfmSaveControls();
  wireDetailsThresholdReset();
  wireRatioStrikeToggle();
  wireRatioChartModal();
  wireRatioContextMenu();
  wireResultsRatioBasisControls();

  const params = new URLSearchParams(window.location.search);
  const urlTab = params.get("tab");
  const initialTab = ALLOWED_DFM_TABS.has(urlTab) ? urlTab : "details";

  const tabSystem = createTabbedPage(document.body, {
    tabs: [
      { id: "details", label: "Details" },
      { id: "data", label: "Data" },
      { id: "ratios", label: "Ratios" },
      { id: "results", label: "Results" },
      { id: "notes", label: "Notes" }
    ],
    cssPrefix: "dfm",
    initialTab,
    injectTabBar: false,
    onTabChange: (tabId) => {
      setCurrentDfmTab(tabId);
      if (tabId === "ratios") renderRatioTable();
      if (tabId === "results") renderResultsTable();
      notifyDfmEditState();
      if (tabId === "details") {
        syncMethodNameFromInputs();
        syncOutputTypeFromProject();
      }
      const inst = getDfmInst();
      window.parent.postMessage({ type: "arcrho:dfm-tab-changed", inst, tab: tabId }, "*");
    }
  });

  window.dfmTabSystem = tabSystem;
  wireDfmTabPopoutWindows({
    onPopoutTab: (tabId) => {
      if (tabId === "ratios") renderRatioTable();
      if (tabId === "results") renderResultsTable();
      notifyDfmEditState();
    },
  });
}

export function initDfmRatios() {
  setStorageInstance(getDfmInst());
  initDfmTabs();
  notifyDfmEditState();
  syncMethodNameFromInputs();
  syncOutputTypeFromProject();
  updatePathBar();
  wireDfmRpcBridgePathBar();
  setTimeout(() => {
    syncOutputTypeFromProject();
    updatePathBar();
  }, 500);

  document.getElementById("loadDfmSettingsBtn")?.addEventListener("click", () => loadDfmTemplate());
  window.addEventListener("arcrho:workflow-defaults-updated", () => {
    syncMethodNameFromInputs();
    syncOutputTypeFromProject();
    updatePathBar();
  });
  wireRatioSyncChannel();
  requestRatioStateSync();
  initRatioHistory({
    afterRestore: () => {
      restoreRatioHistoryUi();
      if (isRatioChartOpen()) scheduleRatioChartRender();
    },
  });
  startDfmMethodFileWatcher();
  window.addEventListener("beforeunload", () => {
    stopDfmMethodFileWatcher();
    clearRatioHistoryTempSession();
  }, { once: true });

  window.addEventListener("arcrho:dataset-updated", handleDatasetUpdated);

  /* ---- Apply project/class from URL params when embedded in workflow ---- */
  const _qs = new URLSearchParams(window.location.search);
  const _urlProject = _qs.get("project") || "";
  const _urlClass = _qs.get("class") || "";
  const _urlMethodName = _qs.get("method_name") || "";
  const _urlInputTriangle = _qs.get("input_triangle") || "";
  if (_urlProject || _urlClass || _urlMethodName || _urlInputTriangle) {
    const projEl = document.getElementById("projectSelect");
    const classEl = document.getElementById("pathInput");
    const methodEl = document.getElementById("dfmMethodName");
    const triEl = document.getElementById("triInput");
    if (_urlProject && projEl) projEl.value = _urlProject;
    if (_urlClass && classEl) classEl.value = _urlClass;
    if (_urlMethodName && methodEl) methodEl.value = _urlMethodName;
    if (_urlInputTriangle && triEl) triEl.value = _urlInputTriangle;
    syncMethodNameFromInputs();
    syncOutputTypeFromProject({ forceReload: true });
    updatePathBar();
  }
  refreshDfmTabContent("dfm-open");

  window.addEventListener("message", (e) => {
    /* Respond to workflow requesting DFM step settings for snapshot */
    if (e?.data?.type === "arcrho:get-dfm-settings") {
      const inputSnap = getDfmInputSnapshotSafe();
      const settings = {
        project: inputSnap.defaults?.projectDefault
          ? DEFAULT_TOKEN
          : (inputSnap.resolved?.project || document.getElementById("projectSelect")?.value?.trim() || ""),
        reservingClass: inputSnap.defaults?.reservingClassDefault
          ? DEFAULT_TOKEN
          : (inputSnap.resolved?.reservingClass || document.getElementById("pathInput")?.value?.trim() || ""),
        objectName: document.getElementById("dfmMethodName")?.value?.trim() || "",
        outputType: document.getElementById("dfmOutputVector")?.value?.trim() || "",
        originLen: document.getElementById("originLenSelect")?.value?.trim() || "",
        devLen: document.getElementById("devLenSelect")?.value?.trim() || "",
      };
      window.parent.postMessage({ type: "arcrho:dfm-settings", settings, requestId: e.data.requestId }, "*");
      return;
    }
    /* Handle global control changes from workflow */
    if (e?.data?.type === "arcrho:workflow-global-changed") {
      const inputSnap = getDfmInputSnapshotSafe();
      if (!inputSnap.defaults?.projectDefault && !inputSnap.defaults?.reservingClassDefault) return;
      syncMethodNameFromInputs();
      syncOutputTypeFromProject({ forceReload: true });
      updatePathBar();
      scheduleRatioSelectionLoad("global-changed");
      return;
    }
    if (e?.data?.type === "arcrho:server-connection-updated") {
      setCachedRootPath(e.data.config?.workspace_root || "");
      window.parent.postMessage({ type: "arcrho:status", text: "Server connection updated." }, "*");
      return;
    }
    if (e?.data?.type === "arcrho:assistant-context-request") {
      const requestId = e.data.requestId || "";
      buildAssistantContext()
        .then((context) => {
          window.parent.postMessage({ type: "arcrho:assistant-context-result", requestId, context }, "*");
        })
        .catch((err) => {
          window.parent.postMessage({
            type: "arcrho:assistant-context-result",
            requestId,
            context: {
              available: false,
              pageType: "dfm",
              error: String(err?.message || err || "DFM assistant context failed."),
            },
          }, "*");
        });
      return;
    }
    if (e?.data?.type === "arcrho:assistant-json-updated") {
      scheduleRatioSelectionLoad("assistant-edit");
      return;
    }
    if (e?.data?.type === "arcrho:dfm-apply-method-payload") {
      const requestId = e.data.requestId || "";
      const reply = (payload) => {
        try {
          window.parent.postMessage({
            type: "arcrho:dfm-apply-method-payload-result",
            requestId,
            ...payload,
          }, "*");
        } catch {
          // ignore stale shell messaging
        }
      };
      applyDfmMethodPayload(e.data.payload, { markClean: false, reason: "macro" })
        .then((applied) => {
          if (applied?.ok) {
            markDfmDirty();
            postDfmStatus("Macro applied to active DFM.");
            reply({ ok: true });
          } else {
            reply({ ok: false, error: "Could not apply macro result to DFM tab." });
          }
        })
        .catch((err) => reply({ ok: false, error: String(err?.message || err || "Could not apply macro result.") }));
      return;
    }
    if (e?.data?.type === "arcrho:dfm-request-state") {
      notifyDfmEditState();
      const history = getRatioHistoryState();
      window.parent.postMessage({
        type: "arcrho:dfm-history-state",
        inst: getDfmInst(),
        canUndo: history.canUndo,
        canRedo: history.canRedo,
      }, "*");
      return;
    }
    if (e?.data?.type === "arcrho:dfm-tab-activated") {
      notifyDfmEditState();
      const history = getRatioHistoryState();
      window.parent.postMessage({
        type: "arcrho:dfm-history-state",
        inst: getDfmInst(),
        canUndo: history.canUndo,
        canRedo: history.canRedo,
      }, "*");
      return;
    }
    if (e?.data?.type === "arcrho:dfm-exclude-high") {
      const ratiosPage = document.getElementById("dfmRatiosPage");
      if (!ratiosPage || ratiosPage.style.display === "none") return;
      excludeExtremeInActiveCol("high");
      return;
    }
    if (e?.data?.type === "arcrho:dfm-exclude-low") {
      const ratiosPage = document.getElementById("dfmRatiosPage");
      if (!ratiosPage || ratiosPage.style.display === "none") return;
      excludeExtremeInActiveCol("low");
      return;
    }
    if (e?.data?.type === "arcrho:dfm-include-all") {
      const ratiosPage = document.getElementById("dfmRatiosPage");
      if (!ratiosPage || ratiosPage.style.display === "none") return;
      includeAllInActiveCol();
      return;
    }
    if (e?.data?.type === "arcrho:dfm-undo") {
      const ratiosPage = document.getElementById("dfmRatiosPage");
      if (!ratiosPage || ratiosPage.style.display === "none") return;
      runRatioUndo();
      return;
    }
    if (e?.data?.type === "arcrho:dfm-redo") {
      const ratiosPage = document.getElementById("dfmRatiosPage");
      if (!ratiosPage || ratiosPage.style.display === "none") return;
      runRatioRedo();
      return;
    }
    if (e?.data?.type === "arcrho:dfm-tab-closing") {
      clearRatioHistoryTempSession();
      return;
    }
    if (e?.data?.type === "arcrho:dfm-open-method-json") {
      openCurrentDfmMethodJson();
      return;
    }
    if (e?.data?.type === "arcrho:dfm-save") {
      saveRatioSelectionPattern(false);
      return;
    }
    if (e?.data?.type === "arcrho:dfm-save-as") {
      saveRatioSelectionPattern(true);
      return;
    }
    if (e?.data?.type === "arcrho:dfm-save-template") {
      saveDfmTemplate();
      return;
    }
  });

  window.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    const key = (e.key || "").toLowerCase();
    if (key !== "h" && key !== "l" && key !== "i" && key !== "z" && key !== "y") return;
    const tag = e.target?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || e.target?.isContentEditable) return;
    const ratiosPage = document.getElementById("dfmRatiosPage");
    if (!ratiosPage || ratiosPage.style.display === "none") return;
    e.preventDefault();
    if (key === "h") excludeExtremeInActiveCol("high");
    if (key === "l") excludeExtremeInActiveCol("low");
    if (key === "i") includeAllInActiveCol();
    if (key === "z") runRatioUndo();
    if (key === "y") runRatioRedo();
  }, { capture: true });
}

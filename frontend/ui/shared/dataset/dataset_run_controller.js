import { isDfmDataTabHost } from "/ui/shared/tabs/data/data_tab_context.js";
import {
  beginDatasetGridLoading,
  endDatasetGridLoading,
  renderDatasetGridPlaceholder,
  setDatasetGridEmpty,
  setDatasetGridError,
} from "/ui/shared/tabs/data/dataset_grid_placeholder.js?v=20260805a";
import { showPageMessageBox } from "/ui/shared/components/message_box/message_box.js?v=20260728a";
import { trackSavePropagation } from "/ui/shared/services/dependent_propagation_job.js?v=20260806a";

const DEFAULT_LOADING_POPUP_DELAY_MS = 300;

export function createDatasetRunController(deps) {
  const {
    config,
    state,
    $,
    logLine,
    getDataset,
    patchDataset,
    renderTable,
    renderChart,
    notifyDatasetUpdated,
    isForceRebuildEnabled,
    validateTriInputsBeforeRun,
    getTriInputs,
    buildTriRequestPayload,
    buildVecRequestPayload,
    getDatasetRunDataFormat = () => "",
    clearHeadersCacheForProject,
    ensureHeadersForProject,
    ensureDevHeadersForProject,
    saveLastDsId,
    recordDatasetBrowsingHistory,
    syncSidecarForCurrentDataset,
    invalidateDatasetContextLoads = () => {},
    updateCurrentTabTitle,
    setStatus,
    onCalculatedUpdates = null,
    applyGridSelectionFromState,
    stepId,
    suppressLoadingPopup = false,
    loadingPopupDelayMs = DEFAULT_LOADING_POPUP_DELAY_MS,
    isDatasetReadOnly = () => false,
  } = deps;
  const resolvedLoadingPopupDelayMs = Number.isFinite(Number(loadingPopupDelayMs))
    ? Math.max(0, Number(loadingPopupDelayMs))
    : DEFAULT_LOADING_POPUP_DELAY_MS;

  let autoRunTimer = null;
  let autoRunPlaceholderToken = null;
  let lastAutoKey = "";
  let runInFlight = false;
  let queuedRunOptions = null;
  let datasetLoadSequence = 0;
  let datasetLoadingPopupEl = null;
  let datasetLoadingPopupTimer = null;
  let datasetLoadingPopupStart = 0;
  const datasetContextFields = [
    "project",
    "path",
    "tri",
    "instanceName",
    "cumulative",
    "calendar",
    "originLen",
    "devLen",
  ];

  function ensureDatasetLoadingPopupStyles(doc = document) {
    if (doc.getElementById("arcrho-load-popup-style")) return;
    const style = doc.createElement("style");
    style.id = "arcrho-load-popup-style";
    style.textContent = `
      .arcrho-load-popup-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.18);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100000;
      }
      .arcrho-load-popup-card {
        min-width: 340px;
        max-width: min(92vw, 680px);
        border-radius: 10px;
        border: 1px solid #c9d1dc;
        background: #fff;
        box-shadow: 0 20px 44px rgba(15, 23, 42, 0.22);
        padding: 18px 20px 16px;
        color: #0f172a;
        font-family: "Segoe UI", Tahoma, Arial, sans-serif;
      }
      .arcrho-load-popup-title {
        font-size: 14px;
        font-weight: 600;
        margin-bottom: 8px;
      }
      .arcrho-load-popup-msg {
        font-size: 13px;
        line-height: 1.35;
        white-space: normal;
        word-break: break-word;
        color: #334155;
      }
      .arcrho-load-popup-spinner {
        width: 34px;
        height: 34px;
        margin: 11px auto 7px;
        border-radius: 50%;
        position: relative;
      }
      .arcrho-load-popup-spinner::before {
        content: "";
        position: absolute;
        inset: 0;
        border-radius: 50%;
        border: 2px solid rgba(120, 178, 224, 0.24);
        box-shadow:
          inset 0 0 10px rgba(116, 182, 235, 0.14),
          0 0 0 1px rgba(134, 188, 229, 0.1);
      }
      .arcrho-load-popup-spinner::after {
        content: "";
        position: absolute;
        inset: 0;
        border-radius: 50%;
        background:
          conic-gradient(
            from 220deg,
            rgba(86, 176, 236, 0) 0deg,
            rgba(86, 176, 236, 0) 238deg,
            rgba(134, 224, 255, 0.92) 308deg,
            rgba(74, 144, 217, 0.98) 338deg,
            rgba(74, 144, 217, 0) 360deg
          );
        -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3px));
        mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3px));
        filter:
          drop-shadow(0 0 6px rgba(95, 196, 255, 0.42))
          drop-shadow(0 0 13px rgba(84, 161, 228, 0.24));
        animation: arcrho-load-popup-sweep 1.05s linear infinite;
        pointer-events: none;
      }
      @keyframes arcrho-load-popup-sweep {
        to { transform: rotate(360deg); }
      }
      .arcrho-load-popup-elapsed {
        margin-top: 10px;
        font-size: 12px;
        color: #64748b;
      }
    `;
    (doc.head || doc.documentElement).appendChild(style);
  }

  function isDatasetLoadingPopupVisible() {
    return !!(datasetLoadingPopupEl && datasetLoadingPopupEl.isConnected);
  }

  function showDatasetLoadingPopup(message = "") {
    if (suppressLoadingPopup) return;
    const doc = document;
    ensureDatasetLoadingPopupStyles(doc);
    const reuseExisting = isDatasetLoadingPopupVisible();
    if (!reuseExisting) {
      const overlay = doc.createElement("div");
      overlay.className = "arcrho-load-popup-overlay";
      overlay.innerHTML = `
        <div class="arcrho-load-popup-card" role="alert" aria-live="polite">
          <div class="arcrho-load-popup-title">Loading Dataset</div>
          <div class="arcrho-load-popup-msg"></div>
          <div class="arcrho-load-popup-spinner" aria-hidden="true"></div>
          <div class="arcrho-load-popup-elapsed">Elapsed: 0.0s</div>
        </div>
      `;
      doc.body.appendChild(overlay);
      datasetLoadingPopupEl = overlay;
    }
    const msgEl = datasetLoadingPopupEl.querySelector(".arcrho-load-popup-msg");
    if (msgEl) msgEl.textContent = String(message || "Loading...");

    // A popup shown at window boot keeps its running elapsed counter when a
    // later load step re-announces it; only a fresh popup restarts the clock.
    if (reuseExisting && datasetLoadingPopupTimer) return;

    datasetLoadingPopupStart = performance.now();
    if (datasetLoadingPopupTimer) cancelAnimationFrame(datasetLoadingPopupTimer);
    const elapsedEl = datasetLoadingPopupEl.querySelector(".arcrho-load-popup-elapsed");
    const tick = () => {
      if (!datasetLoadingPopupEl) return;
      const sec = (performance.now() - datasetLoadingPopupStart) / 1000;
      if (elapsedEl) elapsedEl.textContent = `Elapsed: ${sec.toFixed(1)}s`;
      datasetLoadingPopupTimer = requestAnimationFrame(tick);
    };
    datasetLoadingPopupTimer = requestAnimationFrame(tick);
  }

  function hideDatasetLoadingPopup() {
    if (suppressLoadingPopup) return;
    if (datasetLoadingPopupTimer) {
      cancelAnimationFrame(datasetLoadingPopupTimer);
      datasetLoadingPopupTimer = null;
    }
    if (!datasetLoadingPopupEl) return;
    if (datasetLoadingPopupEl.parentNode) {
      datasetLoadingPopupEl.parentNode.removeChild(datasetLoadingPopupEl);
    }
    datasetLoadingPopupEl = null;
  }

  function scheduleAutoRun(delayMs = 150) {
    if (autoRunTimer) {
      clearTimeout(autoRunTimer);
    } else {
      // A scheduled run owns the grid placeholder from the moment it is queued.
      // Without that the boot sequence would settle to an empty grid in the gap
      // before the timer fires, flashing "no dataset" at a dataset that is coming.
      autoRunPlaceholderToken = beginDatasetGridLoading();
    }
    autoRunTimer = setTimeout(() => {
      autoRunTimer = null;
      const token = autoRunPlaceholderToken;
      autoRunPlaceholderToken = null;
      void autoRun().finally(() => endDatasetGridLoading(token));
    }, delayMs);
  }

  function queueLatestRun(options = {}) {
    queuedRunOptions = {
      ...(queuedRunOptions || {}),
      ...options,
      clearCache: !!queuedRunOptions?.clearCache || !!options?.clearCache,
    };
    lastAutoKey = "";
  }

  function bindAutoRunOnEnter(el) {
    if (!el) return;

    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;

      e.preventDefault();
      el.blur();
      scheduleAutoRun(0);
    });
  }

  function datasetGridLoadingMessage() {
    const name = String(getTriInputs()?.tri || config.DS_ID || "").trim();
    return name ? `Loading "${name}"` : "Loading dataset";
  }

  function datasetInputContextIsCurrent(expected) {
    const current = getTriInputs();
    return datasetContextFields.every((field) => (
      String(current?.[field] ?? "").trim() === String(expected?.[field] ?? "").trim()
    ));
  }

  function datasetLoadContextIsCurrent(sequence, datasetId, expectedInputs) {
    if (sequence !== datasetLoadSequence) return false;
    if (String(config.DS_ID || "").trim() !== datasetId) return false;
    return datasetInputContextIsCurrent(expectedInputs);
  }

  function showDfmLocalCacheAlert(message) {
    if (!isDfmDataTabHost()) return;
    const text = String(message || "").trim();
    if (!text) return;
    window.alert(text);
  }

  async function autoRun() {
    const { project, path, tri, instanceName, cumulative, calendar, originLen, devLen } = getTriInputs();

    if (!project || !path || !tri) return;

    const key = `${project}||${path}||${tri}||${instanceName || ""}||${cumulative}||${calendar}||${originLen}||${devLen}`;

    if (key === lastAutoKey) return;

    if (runInFlight) {
      scheduleAutoRun(500);
      return;
    }

    lastAutoKey = key;
    await runArcRhoTri({ showValidationMessage: false });
  }

  async function runArcRhoTri(opts = {}) {
    const showValidationMessage = !!opts?.showValidationMessage;
    const clearCacheRequested = !!opts?.clearCache;
    const forceRebuild = isForceRebuildEnabled();
    let clearCache = clearCacheRequested || forceRebuild;
    if (runInFlight) {
      queueLatestRun({
        ...opts,
        clearCache: clearCacheRequested,
      });
      return { ok: false, queued: true };
    }
    runInFlight = true;
    const gridPlaceholderToken = beginDatasetGridLoading({
      message: datasetGridLoadingMessage(),
    });

    const btn = document.getElementById("runArcRhoTriBtn");
    const clearBtn = document.getElementById("clearCacheReloadBtn");
    const status = document.getElementById("arcrhoTriStatus");
    const validationInputs = getTriInputs();
    const validationIsCurrent = () => datasetInputContextIsCurrent(validationInputs);
    const loadingTarget = String(validationInputs?.tri || config.DS_ID || "").trim() || "dataset";
    // A popup already shown at window boot is adopted by this run, so it stays
    // continuously visible through validation and is hidden when the run settles.
    let loadingPopupVisible = isDatasetLoadingPopupVisible();
    let loadingPopupDelayTimer = null;
    let popupContextIsCurrent = validationIsCurrent;
    const showLoadingPopup = () => {
      if (loadingPopupVisible) return;
      showDatasetLoadingPopup(`Loading dataset "${loadingTarget}" ...`);
      loadingPopupVisible = true;
    };
    const scheduleDelayedLoadingPopup = () => {
      loadingPopupDelayTimer = setTimeout(() => {
        loadingPopupDelayTimer = null;
        if (popupContextIsCurrent()) showLoadingPopup();
      }, resolvedLoadingPopupDelayMs);
    };
    const cancelDelayedLoadingPopup = () => {
      if (loadingPopupDelayTimer === null) return;
      clearTimeout(loadingPopupDelayTimer);
      loadingPopupDelayTimer = null;
    };
    const hideLoadingPopup = () => {
      if (!loadingPopupVisible) return;
      hideDatasetLoadingPopup();
      loadingPopupVisible = false;
    };

    if (status) {
      status.textContent = clearCache
        ? "Validating before cache refresh..."
        : "Validating inputs...";
    }
    if (btn) btn.disabled = true;
    if (clearBtn) clearBtn.disabled = true;
    if (clearCache || loadingPopupVisible) {
      showLoadingPopup();
    } else {
      // Avoid a second cache/provenance scan just to decide whether to show the
      // popup. Fast cache hits stay quiet; any delayed end-to-end load remains
      // visibly in progress while the authoritative run request is pending.
      scheduleDelayedLoadingPopup();
    }

    try {
      let validated = null;
      try {
        validated = await validateTriInputsBeforeRun({ showMessage: showValidationMessage });
      } catch (err) {
        console.error("Failed to validate ArcRhoTri inputs:", err);
        if (showValidationMessage) {
          setStatus("Failed to validate inputs. Please check project/reserving class/dataset values.");
        }
        return { ok: false, validationFailed: true };
      }
      if (!validated.ok) {
        return { ok: false, invalid: true };
      }
      if (!validationIsCurrent()) {
        logLine("Dataset run validation became stale; queued the latest inputs.");
        queueLatestRun({ showValidationMessage: false });
        return { ok: false, stale: true, queued: true };
      }

      const forceLocalCsvOnly = !!validated?.dependencyBypassedByExistingCsv;
      if (forceLocalCsvOnly && clearCache) {
        clearCache = false;
        setStatus("Dependencies unresolved: clear-cache refresh disabled; trying local CSV only.");
      }
      const { cumulative, calendar, originLen, devLen, instanceName } = getTriInputs();
      const { project, path, tri } = validated;
      const triRequestInputs = { project, path, tri, instanceName, cumulative, calendar, originLen, devLen };
      const runIsCurrent = () => datasetInputContextIsCurrent(triRequestInputs);
      popupContextIsCurrent = runIsCurrent;
      if (!runIsCurrent()) {
        logLine("Dataset run inputs changed before request publication; queued the latest inputs.");
        queueLatestRun({ showValidationMessage: false });
        return { ok: false, stale: true, queued: true };
      }

      const dataFormat = String(getDatasetRunDataFormat(tri) || "").trim().toLowerCase();
      const isVector = dataFormat === "vector";
      const requestPayload = isVector && typeof buildVecRequestPayload === "function"
        ? buildVecRequestPayload(triRequestInputs)
        : buildTriRequestPayload(triRequestInputs);
      const routeRoot = isVector ? "/arcrho/vec" : "/arcrho/tri";
      const runLabel = isVector ? "ArcRhoVec" : "ArcRhoTri";
      if (status) {
        status.textContent = clearCache
          ? "Clearing cache and sending request..."
          : "Sending request...";
      }
      const endpoint = clearCache ? `${routeRoot}/refresh` : routeRoot;
      // The cache-clear rebuild and the origin/development header refreshes
      // are independent engine round trips. Starting them together keeps a
      // network-drive rebuild at one round-trip wait instead of three
      // sequential ones; the pipeline is awaited before the dataset reload so
      // the reload never races the header cache rebuild.
      const headerRefreshPromise = (clearCache && project)
        ? (async () => {
          try {
            await clearHeadersCacheForProject(project, { remote: true, originLen, devLen });
          } catch (err) {
            console.warn("Failed to clear ArcRhoHeaders cache:", err);
            return;
          }
          try {
            await Promise.all([
              ensureHeadersForProject(project, { forceRefresh: true, isCurrent: runIsCurrent }),
              ensureDevHeadersForProject(project, { forceRefresh: true, isCurrent: runIsCurrent }),
            ]);
          } catch (err) {
            console.warn("Failed to refresh header labels after cache clear:", err);
          }
        })()
        : null;
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
      });

      const data = await resp.json();

      if (!runIsCurrent()) {
        logLine(`${runLabel} response ignored because dataset inputs changed while the request was running.`);
        queueLatestRun({ showValidationMessage: false });
        return { ok: false, stale: true, queued: true };
      }

      if (!resp.ok) {
        logLine(`${clearCache ? `${runLabel} refresh` : runLabel} failed: ${resp.status}`);
        if (status) status.textContent = `Error: ${resp.status}`;
        lastAutoKey = null;
        setStatus(`Error: ${resp.status}`);
        return;
      }

      if (!data.ok) {
        const message = String(
          data?.message
          || (data?.status === "timeout" ? "Timeout waiting for csv (try again)." : "")
          || "Dataset cache is not available.",
        );
        logLine(`${clearCache ? `${runLabel} refresh` : runLabel} failed: ${message} data_path=${data.data_path}`);
        if (status) status.textContent = message;
        lastAutoKey = null;
        setStatus(message);
        showDfmLocalCacheAlert(message);
        return;
      }

      logLine(`${clearCache ? `${runLabel} refresh` : runLabel} OK. ds_id=${data.ds_id}`);
      if (status) status.textContent = `OK: ${data.ds_id}`;

      if (headerRefreshPromise) {
        await headerRefreshPromise;
      }
      if (!runIsCurrent()) {
        queueLatestRun({ showValidationMessage: false });
        return { ok: false, stale: true, queued: true };
      }
      // Switch to the completed cache only after every awaited run step still
      // matches the inputs that produced it.
      config.DS_ID = data.ds_id;
      saveLastDsId(config.DS_ID);
      const loadResult = await loadDataset();
      if (!loadResult?.ok) return loadResult;
      if (typeof onCalculatedUpdates === "function") {
        onCalculatedUpdates(data?.calculated_updates, clearCache ? "Dataset refresh" : "Dataset run");
      }
      recordDatasetBrowsingHistory({ project, path, tri });
      return loadResult;
    } finally {
      cancelDelayedLoadingPopup();
      hideLoadingPopup();
      runInFlight = false;
      if (btn) btn.disabled = false;
      if (clearBtn) clearBtn.disabled = false;
      const nextRunOptions = queuedRunOptions;
      queuedRunOptions = null;
      if (nextRunOptions) {
        // This run's placeholder registration is held until the queued run has
        // taken its own, so a still-loading grid never blinks to empty between
        // two runs of the same dataset.
        setTimeout(() => {
          void runArcRhoTri(nextRunOptions).finally(() => endDatasetGridLoading(gridPlaceholderToken));
        }, 0);
      } else {
        endDatasetGridLoading(gridPlaceholderToken);
      }
    }
  }

  async function loadDataset() {
    const gridPlaceholderToken = beginDatasetGridLoading({
      message: datasetGridLoadingMessage(),
    });
    try {
      return await loadDatasetOnce();
    } finally {
      endDatasetGridLoading(gridPlaceholderToken);
    }
  }

  async function loadDatasetOnce() {
    const loadSequence = ++datasetLoadSequence;
    invalidateDatasetContextLoads();
    const datasetId = String(config.DS_ID || "").trim();
    if (!datasetId) {
      logLine("Dataset load skipped: no dataset selected");
      setDatasetGridEmpty({
        title: "No Dataset Selected",
        hint: "Select a project, reserving class, and dataset to load data.",
      });
      renderDatasetGridPlaceholder($("tableWrap"));
      setStatus("No dataset selected");
      return { ok: false, skipped: true, message: "No dataset selected" };
    }

    const loadInputs = getTriInputs();
    const { project, originLen } = loadInputs;
    $("dsMeta").textContent = "";
    const loadIsCurrent = () => datasetLoadContextIsCurrent(
      loadSequence,
      datasetId,
      loadInputs,
    );
    const developmentHeadersPromise = project
      ? Promise.resolve()
        .then(() => ensureDevHeadersForProject(project, { isCurrent: loadIsCurrent }))
        .catch((err) => {
          console.warn("Failed to resolve development header labels:", err);
          return [];
        })
      : Promise.resolve([]);
    let response;
    try {
      response = await getDataset(
        datasetId,
        { projectName: project, originLength: originLen },
      );
    } catch (err) {
      response = {
        ok: false,
        status: 0,
        data: { detail: String(err?.message || err || "Network error") },
      };
    }
    if (!loadIsCurrent()) {
      return { ok: false, stale: true };
    }
    const { ok, status, data } = response;

    if (!ok) {
      const message = String(data?.detail || data?.error || data?.message || `Dataset request failed (${status || "network error"}).`).trim();
      logLine(`ERROR loading dataset: ${message}`);
      setDatasetGridError(message);
      renderDatasetGridPlaceholder($("tableWrap"));
      state.model = null;
      state.fileMtime = null;
      state.headerLabels = [];
      $("dsMeta").textContent = "";
      renderChart();
      notifyDatasetUpdated({ publishPreview: false });
      setStatus(message);
      return { ok: false, status, data, message };
    }

    // persist the last successfully loaded dataset
    saveLastDsId(config.DS_ID);

    state.dirty.clear();
    state.model = data;
    state.fileMtime = data.mtime;

    // The backend validates origin labels against the dataset row count.
    state.headerLabels = Array.isArray(data.origin_labels) ? data.origin_labels.map(String) : [];

    if (isDfmDataTabHost() && typeof syncSidecarForCurrentDataset === "function") {
      const sidecarSynced = await syncSidecarForCurrentDataset({
        applyLengths: false,
        forceReload: true,
        isCurrent: loadIsCurrent,
      });
      if (!loadIsCurrent()) return { ok: false, stale: true };
      if (sidecarSynced === false) return { ok: false, contextSyncFailed: true };
    }
    if (!loadIsCurrent()) {
      return { ok: false, stale: true };
    }

    renderTable();
    notifyDatasetUpdated();
    applyGridSelectionFromState();
    void developmentHeadersPromise.then((labels) => {
      const resolvedLabels = Array.isArray(labels) ? labels.map(String) : [];
      if (!resolvedLabels.length || !loadIsCurrent() || state.model !== data) return;
      state.devHeaderLabels = resolvedLabels;
      const currentLabels = Array.isArray(state.model.dev_labels)
        ? state.model.dev_labels.map(String)
        : [];
      if (
        currentLabels.length === resolvedLabels.length
        && currentLabels.every((label, index) => label === resolvedLabels[index])
      ) {
        return;
      }
      // The dataset response is authoritative for the first paint. Header
      // discovery is allowed to refine that paint only while this load still
      // owns the visible dataset.
      state.model.dev_labels = resolvedLabels;
      renderTable();
      notifyDatasetUpdated();
      applyGridSelectionFromState();
    });
    if (!isDfmDataTabHost() && typeof syncSidecarForCurrentDataset === "function") {
      const sidecarSynced = await syncSidecarForCurrentDataset({
        applyLengths: false,
        forceReload: true,
        isCurrent: loadIsCurrent,
      });
      if (!loadIsCurrent()) return { ok: false, stale: true };
      if (sidecarSynced === false) return { ok: false, contextSyncFailed: true };
    }
    if (!loadIsCurrent()) return { ok: false, stale: true };

    $("dsMeta").textContent =
      `id=${data.id} | origins=${data.origin_labels.length} | dev=${data.dev_labels.length} | mtime=${data.mtime}`;

    logLine("Loaded dataset");
    {
      const path = (document.getElementById("pathInput")?.value || "").trim();
      const tri = (document.getElementById("triInput")?.value || "").trim();
      const meta = [path, tri].filter(Boolean).join(" | ");
      setStatus(meta || "Ready");
    }
    const title = updateCurrentTabTitle() || config.DS_ID || "Dataset";

    // In DFM context, step title is managed by DFM method naming logic.
    // Avoid overwriting it with transient dataset ids such as "arcrhotri_*".
    if (stepId && !isDfmDataTabHost()) {
      window.parent.postMessage(
        {
          type: "arcrho:update-workflow-step-title",
          stepId: stepId,
          title: title,
        },
        "*"
      );
    }
    return { ok: true, status, data };
  }

  async function savePatch() {
    if (isDatasetReadOnly()) {
      logLine("Generated dataset is read-only; patch save skipped.");
      setStatus("Generated datasets are read-only.");
      return;
    }
    if (state.dirty.size === 0) {
      logLine("No changes to save.");
      return;
    }
    if (!state.model) {
      logLine("Cannot save grid changes because the current dataset failed to load.");
      setStatus("Reload the dataset successfully before saving grid changes.");
      return;
    }

    const items = [];
    for (const [key, value] of state.dirty.entries()) {
      const [r, c] = key.split(",").map((x) => parseInt(x, 10));
      items.push({ r, c, value });
    }

    const { status, data } = await patchDataset(items, state.fileMtime, config.DS_ID);

    if (status === 409) {
      logLine("Conflict: file changed on disk. Reload first.");
      return;
    }
    if (status === 503) {
      // Dependent propagation runs on ArcRho Engine; the save was refused
      // before anything was written and unsaved edits stay in the grid.
      const message = String(
        data?.detail
        || "The ArcRho Engine service is not available. Please try again later or contact the administrator.",
      );
      void showPageMessageBox({ title: "ArcRho Engine Unavailable", message, tone: "warn" });
      setStatus(message);
      logLine(`Save refused: ${message}`);
      return;
    }

    logLine(`Saved patch: applied=${data.applied}, rejected=${(data.rejected || []).length}, new_mtime=${data.mtime}`);
    const loadResult = await loadDataset();
    if (!loadResult?.ok) return;
    if (typeof onCalculatedUpdates === "function") {
      onCalculatedUpdates(data?.calculated_updates, "Dataset grid save");
    }
    void trackSavePropagation(data?.calculated_updates, {
      onStatus: (message) => setStatus(message),
      onComplete: () => {
        try {
          window.parent?.postMessage({ type: "arcrho:project-instance-refresh-datasets" }, "*");
        } catch {}
      },
    });
  }

  function toggleBlanks() {
    state.showBlanks = !state.showBlanks;
    $("toggleBlankBtn").textContent = state.showBlanks ? "Hide blanks" : "Show blanks";
    renderTable(); // re-render only, no reload
    notifyDatasetUpdated();
    applyGridSelectionFromState();
  }

  return {
    bindAutoRunOnEnter,
    hideDatasetLoadingPopup,
    isDatasetLoadingPopupVisible,
    isRunInFlight: () => runInFlight,
    loadDataset,
    runArcRhoTri,
    savePatch,
    scheduleAutoRun,
    showDatasetLoadingPopup,
    toggleBlanks,
  };
}

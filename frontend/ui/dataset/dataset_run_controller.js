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
    precheckArcRhoTriCsv,
    precheckArcRhoVecCsv,
    getDatasetRunDataFormat = () => "",
    clearHeadersCacheForProject,
    ensureHeadersForProject,
    ensureDevHeadersForProject,
    saveLastDsId,
    recordDatasetBrowsingHistory,
    syncNotesForCurrentDataset,
    syncSidecarForCurrentDataset,
    updateCurrentTabTitle,
    setStatus,
    onCalculatedUpdates = null,
    applyGridSelectionFromState,
    stepId,
    suppressLoadingPopup = false,
    isDatasetReadOnly = () => false,
  } = deps;

  let autoRunTimer = null;
  let lastAutoKey = "";
  let runInFlight = false;
  let datasetLoadingPopupEl = null;
  let datasetLoadingPopupTimer = null;
  let datasetLoadingPopupStart = 0;

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

  function showDatasetLoadingPopup(message = "") {
    if (suppressLoadingPopup) return;
    const doc = document;
    ensureDatasetLoadingPopupStyles(doc);
    if (!datasetLoadingPopupEl || !datasetLoadingPopupEl.isConnected) {
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
    if (autoRunTimer) clearTimeout(autoRunTimer);
    autoRunTimer = setTimeout(() => autoRun(), delayMs);
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

  function showDfmLocalCacheAlert(message) {
    if (!window.ADA_DFM_CONTEXT) return;
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
    if (runInFlight) return;
    runInFlight = true;

    const btn = document.getElementById("runArcRhoTriBtn");
    const clearBtn = document.getElementById("clearCacheReloadBtn");
    const status = document.getElementById("arcrhoTriStatus");
    let validated = null;
    try {
      validated = await validateTriInputsBeforeRun({ showMessage: showValidationMessage });
    } catch (err) {
      console.error("Failed to validate ArcRhoTri inputs:", err);
      runInFlight = false;
      if (showValidationMessage) {
        setStatus("Failed to validate inputs. Please check project/reserving class/dataset values.");
      }
      return;
    }
    if (!validated.ok) {
      runInFlight = false;
      return;
    }
    const forceLocalCsvOnly = !!validated?.dependencyBypassedByExistingCsv;
    if (forceLocalCsvOnly && clearCache) {
      clearCache = false;
      setStatus("Dependencies unresolved: clear-cache refresh disabled; trying local CSV only.");
    }
    const { cumulative, calendar, originLen, devLen, instanceName } = getTriInputs();
    const { project, path, tri } = validated;
    const triRequestInputs = { project, path, tri, instanceName, cumulative, calendar, originLen, devLen };
    const dataFormat = String(getDatasetRunDataFormat(tri) || "").trim().toLowerCase();
    const isVector = dataFormat === "vector";
    const requestPayload = isVector && typeof buildVecRequestPayload === "function"
      ? buildVecRequestPayload(triRequestInputs)
      : buildTriRequestPayload(triRequestInputs);
    const precheckExistingCsv = isVector && typeof precheckArcRhoVecCsv === "function"
      ? precheckArcRhoVecCsv
      : precheckArcRhoTriCsv;
    const routeRoot = isVector ? "/arcrho/vec" : "/arcrho/tri";
    const runLabel = isVector ? "ArcRhoVec" : "ArcRhoTri";
    const loadingTarget = String(tri || config.DS_ID || "").trim() || "dataset";
    let loadingPopupVisible = false;
    const showLoadingPopup = () => {
      if (loadingPopupVisible) return;
      showDatasetLoadingPopup(`Loading dataset "${loadingTarget}" ...`);
      loadingPopupVisible = true;
    };
    const hideLoadingPopup = () => {
      if (!loadingPopupVisible) return;
      hideDatasetLoadingPopup();
      loadingPopupVisible = false;
    };

    if (status) {
      status.textContent = clearCache
        ? "Clearing cache and sending request..."
        : "Sending request...";
    }
    if (btn) btn.disabled = true;
    if (clearBtn) clearBtn.disabled = true;
    if (clearCache) {
      showLoadingPopup();
    } else {
      const precheckResult = await precheckExistingCsv(triRequestInputs);
      if (precheckResult.ok && precheckResult?.data?.ok && precheckResult.data.need_request === true) {
        // Show ASAP after the app server decides a request must be sent.
        showLoadingPopup();
      } else if (!precheckResult.ok && !precheckResult.skipped) {
        console.warn(`${runLabel} precheck failed.`);
      }
    }

    try {
      const endpoint = clearCache ? `${routeRoot}/refresh` : routeRoot;
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
      });

      const data = await resp.json();

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

      // switch dataset and load (and persist)
      config.DS_ID = data.ds_id;
      saveLastDsId(config.DS_ID);
      const needRequest = !clearCache && (
        data?.need_request === true
        || !!String(data?.request_file || "").trim()
      );
      if (needRequest) {
        showLoadingPopup();
      } else if (!clearCache) {
        // Cache hit: avoid showing loading popup just for quick local load.
        hideLoadingPopup();
        loadingPopupVisible = false;
      }
      if (clearCache && project) {
        try {
          await clearHeadersCacheForProject(project, { remote: true, originLen, devLen });
        } catch (err) {
          console.warn("Failed to clear ArcRhoHeaders cache:", err);
        }
        try {
          await ensureHeadersForProject(project, { forceRefresh: true });
          await ensureDevHeadersForProject(project, { forceRefresh: true });
        } catch (err) {
          console.warn("Failed to refresh header labels after cache clear:", err);
        }
      }
      await loadDataset();
      if (typeof onCalculatedUpdates === "function") {
        onCalculatedUpdates(data?.calculated_updates, clearCache ? "Dataset refresh" : "Dataset run");
      }
      recordDatasetBrowsingHistory({ project, path, tri });
    } finally {
      hideLoadingPopup();
      runInFlight = false;
      if (btn) btn.disabled = false;
      if (clearBtn) clearBtn.disabled = false;
    }
  }

  async function loadDataset() {
    state.dirty.clear();

    const datasetId = String(config.DS_ID || "").trim();
    if (!datasetId) {
      logLine("Dataset load skipped: no dataset selected");
      $("tableWrap").innerHTML = '<div class="small">Select a project, reserving class, and dataset to load data.</div>';
      setStatus("No dataset selected");
      return;
    }

    const { project } = getTriInputs();
    if (project) {
      await ensureHeadersForProject(project);
      await ensureDevHeadersForProject(project);
    }

    const { ok, status, data } = await getDataset(datasetId, config.START_YEAR);

    if (!ok) {
      logLine(`ERROR loading dataset: ${status}`);
      $("tableWrap").innerHTML = `<div style="color:#b00;"><b>Load failed:</b> ${status}</div>`;
      setStatus("Ready");
      return;
    }

    // persist the last successfully loaded dataset
    saveLastDsId(config.DS_ID);

    state.model = data;
    state.fileMtime = data.mtime;

    // Apply cached header labels, if available
    if (Array.isArray(state.headerLabels) && state.headerLabels.length) {
      state.model.origin_labels = state.headerLabels.map(String);
    }
    if (Array.isArray(state.devHeaderLabels) && state.devHeaderLabels.length) {
      // Do not truncate dev labels by the UI selector.
      // The triangle CSV may contain more columns than the current selector value.
      state.model.dev_labels = state.devHeaderLabels.map(String);
    }

    if (window.ADA_DFM_CONTEXT && typeof syncSidecarForCurrentDataset === "function") {
      await syncSidecarForCurrentDataset({ applyLengths: false, forceReload: true });
    }

    renderTable();
    notifyDatasetUpdated();
    applyGridSelectionFromState();
    if (typeof syncNotesForCurrentDataset === "function") {
      await syncNotesForCurrentDataset();
    }
    if (!window.ADA_DFM_CONTEXT && typeof syncSidecarForCurrentDataset === "function") {
      await syncSidecarForCurrentDataset({ applyLengths: false, forceReload: true });
    }

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
    if (stepId && !window.ADA_DFM_CONTEXT) {
      window.parent.postMessage(
        {
          type: "arcrho:update-workflow-step-title",
          stepId: stepId,
          title: title,
        },
        "*"
      );
    }
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

    logLine(`Saved patch: applied=${data.applied}, rejected=${(data.rejected || []).length}, new_mtime=${data.mtime}`);
    await loadDataset();
    if (typeof onCalculatedUpdates === "function") {
      onCalculatedUpdates(data?.calculated_updates, "Dataset grid save");
    }
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
    isRunInFlight: () => runInFlight,
    loadDataset,
    runArcRhoTri,
    savePatch,
    scheduleAutoRun,
    showDatasetLoadingPopup,
    toggleBlanks,
  };
}

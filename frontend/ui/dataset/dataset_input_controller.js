import {
  applyDecimalPlacesToDatasetNumberFormat,
  clampDatasetDecimalPlaces,
  DATASET_NUMBER_FORMAT_PRESETS,
  getDatasetNumberFormatDecimalPlaces,
  normalizeDatasetNumberFormat,
} from "/ui/dataset/dataset_number_format.js";

function wireChartPanelResize(redrawChartSafely) {
  const panel = document.getElementById("chartPanel");
  if (!panel || typeof ResizeObserver !== "function") return;
  if (panel.__datasetChartResizeObserver) return;

  let resizeFrame = 0;
  const scheduleRedraw = () => {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      redrawChartSafely();
    });
  };

  const observer = new ResizeObserver(scheduleRedraw);
  observer.observe(panel);
  panel.__datasetChartResizeObserver = observer;
}

export function wireDatasetInputController(deps) {
  const {
    state,
    $,
    loadDataset,
    isRunInFlight,
    setStatus,
    runArcRhoTri,
    savePatch,
    toggleBlanks,
    wireLenDropdowns,
    syncDetailDatasetTypeFromTopInput,
    clearInputInvalid,
    openReservingClassTreeForDataset,
    showProjectDropdown,
    openProjectNameTreeForDataset,
    showDatasetDropdown,
    openDatasetNameTreeForDataset,
    saveTriInputsToStorage,
    scheduleAutoRun,
    renderTable,
    notifyDatasetUpdated,
    renderChart,
    isDefaultTokenValue,
    setInputDefaultBound,
    getResolvedProjectValue,
    validateAndNormalizeReservingClassInput,
    filterDatasetOptions,
    getActiveDatasetIndex,
    setActiveDatasetIndex,
    chooseActiveDataset,
    validateAndNormalizeDatasetInput,
    validateDatasetTypeDependencies,
    handleDatasetSelection,
    setLastDatasetSelection,
    filterProjectOptions,
    getProjectFilterQuery,
    getActiveProjectIndex,
    setActiveProjectIndex,
    chooseActiveProject,
    handleProjectSelection,
    setLastProjectSelection,
    LEN_DROPDOWN_CONFIG,
    closeAllLenDropdowns,
    syncLen,
    enforceDevLenRule,
    ensureHeadersForProject,
    ensureDevHeadersForProject,
    isLenLinked,
    bindAutoRunOnEnter,
    redrawChartSafely,
    wireDatasetHostBridge,
    getTriInputsForStorage,
    syncSidecarForCurrentDataset,
    instanceId,
    wireGridInteractions,
  } = deps;

  document.getElementById("reloadBtn")?.addEventListener("click", loadDataset);
  document.getElementById("clearCacheReloadBtn")?.addEventListener("click", () => {
    if (isRunInFlight()) return;
    setStatus("Clearing cache and reloading dataset...");
    void runArcRhoTri({ clearCache: true, showValidationMessage: true });
  });
  const saveBtn = $("saveBtn");
  if (window.location.search.includes("readonly=1") || window.location.search.includes("generated_dataset=1")) {
    saveBtn.disabled = true;
    saveBtn.title = "Generated datasets are read-only.";
  }
  saveBtn.addEventListener("click", savePatch);
  $("toggleBlankBtn").addEventListener("click", toggleBlanks);

  const pathInput = document.getElementById("pathInput");
  const pathTreeBtn = document.getElementById("pathTreeBtn");
  const triInput = document.getElementById("triInput");
  const datasetTreeBtn = document.getElementById("datasetTreeBtn");
  const projectSelect = document.getElementById("projectSelect");
  const projectTreeBtn = document.getElementById("projectTreeBtn");
  const originSel = document.getElementById("originLenSelect");
  const devSel = document.getElementById("devLenSelect");
  wireLenDropdowns();

  // Name is auto-copied only when Dataset Type switches.
  if (triInput) {
    syncDetailDatasetTypeFromTopInput(triInput.value, { syncName: true });
  }

  if (pathTreeBtn && pathInput) {
    pathTreeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void openReservingClassTreeForDataset(pathInput);
    });
  }

  if (projectTreeBtn && projectSelect) {
    projectTreeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showProjectDropdown(false);
      void openProjectNameTreeForDataset(projectSelect);
    });
  }

  if (datasetTreeBtn && triInput) {
    datasetTreeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showDatasetDropdown(false);
      void openDatasetNameTreeForDataset(triInput);
    });
  }

  const cumulativeChk = document.getElementById("cumulativeChk");
  if (cumulativeChk) {
    cumulativeChk.addEventListener("change", () => {
      saveTriInputsToStorage();
      scheduleAutoRun(0);
    });
  }

  const transposedChk = document.getElementById("transposedChk");
  if (transposedChk) {
    transposedChk.addEventListener("change", () => {
      state.activeCell = null;
      state.selRanges = [];
      saveTriInputsToStorage();
      renderTable();
      notifyDatasetUpdated();
      renderChart();
    });
  }

  const timeModeInputs = Array.from(document.querySelectorAll('input[name="timeMode"]'));
  for (const input of timeModeInputs) {
    input.addEventListener("change", async () => {
      if (!input.checked) return;
      saveTriInputsToStorage();
      const project = getResolvedProjectValue();
      if (project) {
        await ensureDevHeadersForProject(project, { forceRefresh: true });
      }
      renderTable();
      notifyDatasetUpdated();
      setStatus("Loading dataset...");
      scheduleAutoRun(0);
    });
  }

  const dec = document.getElementById("decimalPlaces");
  const numberFormatSelect = document.getElementById("numberFormatSelect");
  const numberFormatWrap = document.getElementById("numberFormatWrap");
  const numberFormatDropdownBtn = document.getElementById("numberFormatDropdownBtn");
  const numberFormatDropdown = document.getElementById("numberFormatDropdown");
  const decimalPlacesUpBtn = document.getElementById("decimalPlacesUpBtn");
  const decimalPlacesDownBtn = document.getElementById("decimalPlacesDownBtn");

  function refreshNumberDisplaySettings() {
    saveTriInputsToStorage();
    renderTable();
    notifyDatasetUpdated();
    renderChart();
  }

  function syncNumberFormatFromDecimalPlaces() {
    if (!numberFormatSelect || !dec) return;
    const places = clampDatasetDecimalPlaces(dec.value);
    dec.value = String(places);
    numberFormatSelect.value = applyDecimalPlacesToDatasetNumberFormat(numberFormatSelect.value, places);
  }

  function syncDecimalPlacesFromNumberFormat() {
    if (!numberFormatSelect || !dec) return;
    numberFormatSelect.value = normalizeDatasetNumberFormat(numberFormatSelect.value);
    dec.value = String(clampDatasetDecimalPlaces(getDatasetNumberFormatDecimalPlaces(numberFormatSelect.value)));
  }

  function stepDecimalPlaces(delta) {
    if (!dec) return;
    const next = clampDatasetDecimalPlaces((Number.parseInt(dec.value, 10) || 0) + delta);
    dec.value = String(next);
    syncNumberFormatFromDecimalPlaces();
    refreshNumberDisplaySettings();
    dec.focus();
  }

  function closeNumberFormatDropdown() {
    numberFormatWrap?.classList.remove("open");
    if (numberFormatDropdown) numberFormatDropdown.classList.remove("open");
    numberFormatSelect?.setAttribute("aria-expanded", "false");
    numberFormatDropdownBtn?.setAttribute("aria-expanded", "false");
  }

  function openNumberFormatDropdown() {
    if (!numberFormatWrap || !numberFormatDropdown) return;
    numberFormatDropdown.innerHTML = "";
    for (const preset of DATASET_NUMBER_FORMAT_PRESETS) {
      const option = document.createElement("div");
      option.className = "datasetOption numberFormatOption";
      option.setAttribute("role", "option");
      option.dataset.value = preset;
      option.textContent = preset;
      option.title = preset;
      if (preset === numberFormatSelect?.value) option.classList.add("active");
      numberFormatDropdown.appendChild(option);
    }
    numberFormatWrap.classList.add("open");
    numberFormatDropdown.classList.add("open");
    numberFormatSelect?.setAttribute("aria-expanded", "true");
    numberFormatDropdownBtn?.setAttribute("aria-expanded", "true");
  }

  function toggleNumberFormatDropdown() {
    if (numberFormatDropdown?.classList.contains("open")) {
      closeNumberFormatDropdown();
    } else {
      openNumberFormatDropdown();
    }
  }

  if (dec && numberFormatSelect) {
    dec.addEventListener("change", () => {
      syncNumberFormatFromDecimalPlaces();
      refreshNumberDisplaySettings();
    });
    dec.addEventListener("input", () => {
      syncNumberFormatFromDecimalPlaces();
      refreshNumberDisplaySettings();
    });
  }
  decimalPlacesUpBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    stepDecimalPlaces(1);
  });
  decimalPlacesDownBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    stepDecimalPlaces(-1);
  });

  if (numberFormatSelect) {
    numberFormatSelect.addEventListener("change", () => {
      syncDecimalPlacesFromNumberFormat();
      refreshNumberDisplaySettings();
      closeNumberFormatDropdown();
    });
    numberFormatSelect.addEventListener("input", () => {
      refreshNumberDisplaySettings();
    });
  }
  if (numberFormatDropdownBtn) {
    numberFormatDropdownBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleNumberFormatDropdown();
      numberFormatSelect?.focus();
    });
  }
  if (numberFormatDropdown) {
    numberFormatDropdown.addEventListener("mousedown", (e) => {
      e.preventDefault();
    });
    numberFormatDropdown.addEventListener("click", (e) => {
      const option = e.target.closest(".numberFormatOption");
      if (!option || !numberFormatDropdown.contains(option) || !numberFormatSelect) return;
      numberFormatSelect.value = option.dataset.value || option.textContent || "";
      syncDecimalPlacesFromNumberFormat();
      refreshNumberDisplaySettings();
      closeNumberFormatDropdown();
      numberFormatSelect.focus();
    });
  }
  document.addEventListener("mousedown", (e) => {
    if (!numberFormatWrap || numberFormatWrap.contains(e.target)) return;
    closeNumberFormatDropdown();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeNumberFormatDropdown();
  });
  syncNumberFormatFromDecimalPlaces();

  // Chart mode toggle
  const chartToggle = document.getElementById("chartModeToggle");
  if (chartToggle) {
    chartToggle.addEventListener("click", (e) => {
      const btn = e.target.closest(".chartToggleBtn");
      if (!btn) return;
      const mode = btn.dataset.mode;
      if (mode && mode !== state.chartMode) {
        // Reset legend state when switching modes
        const legendEl = document.getElementById("devChartLegend");
        if (legendEl?.__chartLegendState) {
          legendEl.__chartLegendState.hoverIndex = null;
          legendEl.__chartLegendState.selectedIndex = null;
          legendEl.__chartLegendState.hiddenSet = new Set();
        }
        state.chartMode = mode;
        renderChart();
      }
    });
  }

  // change -> auto run
  if (pathInput) {
    pathInput.addEventListener("change", async () => {
      if (isDefaultTokenValue(pathInput.value)) {
        setInputDefaultBound(pathInput, true);
      } else {
        setInputDefaultBound(pathInput, false);
      }
      const project = getResolvedProjectValue();
      const pathResult = await validateAndNormalizeReservingClassInput(project, { strict: true, showMessage: true });
      if (!pathResult.ok) return;
      saveTriInputsToStorage();
      await syncSidecarForCurrentDataset?.({ applyLengths: true });
      setStatus("Loading dataset...");
      scheduleAutoRun();
    });
    pathInput.addEventListener("input", () => {
      if (!isDefaultTokenValue(pathInput.value)) {
        setInputDefaultBound(pathInput, false);
      }
      clearInputInvalid(pathInput);
    });
  }
  if (triInput) {
    triInput.addEventListener("focus", () => {
      filterDatasetOptions(triInput.value);
    });

    triInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const list = document.getElementById("datasetDropdown");
        if (!list || !list.classList.contains("open")) {
          filterDatasetOptions(triInput.value);
        }
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const activeDatasetIndex = getActiveDatasetIndex();
        if (activeDatasetIndex === -1) {
          setActiveDatasetIndex(dir > 0 ? 0 : -1);
        } else {
          setActiveDatasetIndex(activeDatasetIndex + dir);
        }
        e.preventDefault();
        return;
      }

      if (e.key === "Enter") {
        if (chooseActiveDataset()) {
          e.preventDefault();
          return;
        }
        const datasetResult = validateAndNormalizeDatasetInput({ strict: true, showMessage: true });
        if (!datasetResult.ok) {
          e.preventDefault();
          return;
        }
        void (async () => {
          const dependencyResult = await validateDatasetTypeDependencies(datasetResult.value, { showMessage: true });
          if (!dependencyResult.ok) return;
          saveTriInputsToStorage();
          await syncSidecarForCurrentDataset?.({ applyLengths: true });
          setStatus("Loading dataset...");
          scheduleAutoRun(0);
        })();
        return;
      }

      if (e.key === "Escape") {
        showDatasetDropdown(false);
      }
    });

    triInput.addEventListener("input", () => {
      clearInputInvalid(triInput);
      filterDatasetOptions(triInput.value);
      if (!triInput.value.trim()) setLastDatasetSelection("");
      void handleDatasetSelection(triInput.value);
    });

    triInput.addEventListener("change", async () => {
      const datasetResult = validateAndNormalizeDatasetInput({ strict: true, showMessage: true });
      if (!datasetResult.ok) {
        showDatasetDropdown(false);
        return;
      }
      syncDetailDatasetTypeFromTopInput(datasetResult.value, { syncName: true });
      const dependencyResult = await validateDatasetTypeDependencies(datasetResult.value, { showMessage: true });
      if (!dependencyResult.ok) {
        showDatasetDropdown(false);
        return;
      }
      setLastDatasetSelection(datasetResult.value);
      saveTriInputsToStorage();
      await syncSidecarForCurrentDataset?.({ applyLengths: true });
      setStatus("Loading dataset...");
      scheduleAutoRun();
      showDatasetDropdown(false);
    });
  }

  if (projectSelect) {
    projectSelect.addEventListener("focus", () => {
      filterProjectOptions(getProjectFilterQuery(projectSelect));
    });

    projectSelect.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const list = document.getElementById("projectDropdown");
        if (!list || !list.classList.contains("open")) {
          filterProjectOptions(getProjectFilterQuery(projectSelect));
        }
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const activeProjectIndex = getActiveProjectIndex();
        if (activeProjectIndex === -1) {
          setActiveProjectIndex(dir > 0 ? 0 : -1);
        } else {
          setActiveProjectIndex(activeProjectIndex + dir);
        }
        e.preventDefault();
        return;
      }

      if (e.key === "Enter") {
        if (chooseActiveProject()) {
          e.preventDefault();
          return;
        }
        void (async () => {
          const ok = await handleProjectSelection(projectSelect.value, { strict: true, showMessage: true });
          if (ok) setStatus("Loading dataset...");
        })();
        e.preventDefault();
        return;
      }

      if (e.key === "Escape") {
        showProjectDropdown(false);
      }
    });

    projectSelect.addEventListener("input", () => {
      if (!isDefaultTokenValue(projectSelect.value)) {
        setInputDefaultBound(projectSelect, false);
      }
      clearInputInvalid(projectSelect);
      filterProjectOptions(getProjectFilterQuery(projectSelect));
      if (!projectSelect.value.trim()) setLastProjectSelection("");
      void handleProjectSelection(projectSelect.value);
    });

    projectSelect.addEventListener("change", async () => {
      if (!projectSelect.value.trim()) return;
      const ok = await handleProjectSelection(projectSelect.value, { strict: true, showMessage: true });
      if (!ok) return;
      setStatus("Loading dataset...");
    });
  }

  document.addEventListener("mousedown", (e) => {
    const projectWrap = document.querySelector(".projectSelectWrap");
    if (projectWrap && !projectWrap.contains(e.target)) {
      showProjectDropdown(false);
    }
    const datasetWrap = document.querySelector(".datasetSelectWrap");
    if (datasetWrap && !datasetWrap.contains(e.target)) {
      showDatasetDropdown(false);
    }
    const inLenWrap = Object.values(LEN_DROPDOWN_CONFIG).some((cfg) => {
      const wrap = document.getElementById(cfg.wrapId);
      return !!wrap && wrap.contains(e.target);
    });
    if (!inLenWrap) closeAllLenDropdowns();
  });

  // Origin change -> (optional sync) -> enforce rule -> refresh headers -> auto run
  if (originSel) {
    originSel.addEventListener("change", async () => {
      syncLen("origin");
      enforceDevLenRule({ source: "origin" });
      saveTriInputsToStorage();

      const project = getResolvedProjectValue();
      await ensureHeadersForProject(project);
      await ensureDevHeadersForProject(project);

      renderTable();
      notifyDatasetUpdated();
      setStatus("Loading dataset...");
      scheduleAutoRun(0);
      originSel.blur();
    });
  }

  const linkChk = document.getElementById("linkLenChk");
  if (linkChk) {
    linkChk.addEventListener("change", async () => {
      // Toggling link can change the effective period lengths (origin/dev),
      // so refresh both header label sets to keep them aligned with the data.
      const originBefore = document.getElementById("originLenSelect")?.value || "";
      const devBefore = document.getElementById("devLenSelect")?.value || "";
      if (isLenLinked()) syncLen("init");
      enforceDevLenRule({ source: "origin" });

      saveTriInputsToStorage();

      const project = getResolvedProjectValue();
      if (project) {
        await ensureHeadersForProject(project);
        await ensureDevHeadersForProject(project);
      }

      renderTable();
      notifyDatasetUpdated();
      const originAfter = document.getElementById("originLenSelect")?.value || "";
      const devAfter = document.getElementById("devLenSelect")?.value || "";
      const changed = originBefore !== originAfter || devBefore !== devAfter;
      if (changed) {
        setStatus("Loading dataset...");
        scheduleAutoRun(0);
      }
    });
  }

  // Dev change -> (optional sync) -> refresh dev headers -> auto run
  if (devSel) {
    devSel.addEventListener("change", async () => {
      syncLen("dev");
      enforceDevLenRule({ source: "dev" });
      saveTriInputsToStorage();

      const project = getResolvedProjectValue();
      // If len is linked, origin may change too; ensure both headers are consistent.
      if (project) {
        await ensureHeadersForProject(project);
        await ensureDevHeadersForProject(project);
      }

      renderTable();
      notifyDatasetUpdated();
      setStatus("Loading dataset...");
      scheduleAutoRun(0);
      devSel.blur();
    });
  }

  // Enter -> auto run
  bindAutoRunOnEnter(pathInput);
  // Run button still as fallback
  const runBtn = document.getElementById("runArcRhoTriBtn");
  if (runBtn) {
    runBtn.addEventListener("click", () => {
      void runArcRhoTri({ showValidationMessage: true });
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      // wait for layout to settle
      requestAnimationFrame(() => {
        requestAnimationFrame(redrawChartSafely);
      });
    }
  });

  window.addEventListener("resize", () => {
    requestAnimationFrame(redrawChartSafely);
  });
  wireChartPanelResize(redrawChartSafely);

  wireDatasetHostBridge({
    getTriInputsForStorage,
    instanceId,
    redrawChartSafely,
  });

  wireGridInteractions();
}

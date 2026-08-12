// Owns sidecar, settings, notes, external-link, dirty, save, and close lifecycles.
import { notifyDataTabDurableDatasetState, withDataTabDatasetMutation } from "/ui/shared/tabs/data/data_tab_change_watch_port.js?v=20260806a";
import { buildDatasetSaveStatus } from "/ui/shared/tabs/data/data_tab_propagation_report.js?v=20260728a";
import { createTemporaryDatasetFormat } from "/ui/shared/tabs/data/data_tab_temporary_format.js?v=20260805a";
import { createDatasetDirtyState } from "/ui/shared/tabs/data/data_tab_dirty_state.js?v=20260809a";
import { showPageMessageBox } from "/ui/shared/components/message_box/message_box.js?v=20260811a";
export function registerDataTabPersistenceController(runtime) {
  const { state, config, instanceId, isProjectInstanceDraft, isReadOnlyDatasetViewer, isTemporaryDatasetView } = runtime;
  if (typeof state.showSubtotal !== "boolean") state.showSubtotal = true;
  const defer = (name) => (...args) => runtime[name](...args);
  const { getResolvedProjectValue, getResolvedReservingClassValue, getDatasetInstanceNameValue, normalizeDatasetInstanceKey, getTriInputs, getProjectInstanceDraftDataFormat, getDatasetDecimalPlacesValue, getDatasetSyncedNumberFormatValue, isDfmDataTabHost, clampDatasetDecimalPlaces, normalizeDatasetNumberFormat, applyDecimalPlacesToDatasetNumberFormat, updateTabbedPageSaveControls, setDatasetRenderNumberFormatSettings, renderTable, notifyDatasetUpdated, getDatasetNumberFormatDefaults, getDataTabLinksController, loadDatasetSidecar, renderDatasetAuditLog, getDatasetAuditLog, normalizeDatasetDependencyEntries, renderDetailFormula, getDatasetTypeFormulaByName, renderDatasetPrecedents, renderDatasetDependents, saveTriInputsToStorage, setDatasetDecimalPlacesValue, setDatasetNumberFormatValue, refreshLenDropdowns, validateDatasetOriginLabels, refreshDatasetInstanceNameConflict, saveDatasetSidecar, saveLastDsId, handleCalculationUpdates, invalidateCachedDatasetInstances, clearDatasetDependencyPreview, requestProjectInstanceDatasetTableRefresh, setStatus, requestTabbedPageWindowClose, hideCalculationUpdatesDialog, isInputDefaultBound, loadWorkflowDefaults, saveDatasetNotes, publishDataTabHostInputs, mountDataTabNotes, ensureHeadersForProject, ensureDevHeadersForProject, scheduleAutoRun, applyGridSelectionFromState, setLenSelectValue, getDataTabCloseConfirm, createDatasetExternalLinksController } = new Proxy({}, { get: (_target, name) => defer(name) });
  const normalizeProjectText = defer("normalizeProjectText");
  const renderChart = defer("renderChart");
  const isDatasetReadOnly = defer("isDatasetReadOnly");
  let notesContextKey = "", notesContextPayload = null, notesDirty = false, lastSavedNotesText = "", datasetNotesController = null, datasetSettingsDirty = false, sidecarContextKey = "", sidecarContextPayload = null, lastSavedDatasetSettings = null, sidecarSyncNonce = 0, datasetExternalLinksLoaded = false, datasetCloseConfirm = null, hostInputsPublished = false;
  let datasetExcelFreshnessAbortController = null;
  const datasetExcelFreshnessCheckedKeys = new Set();
  const {
    loadTemporaryNumberFormatSettings,
    resolveTemporaryDatasetSettings,
    applyTemporaryNumberFormatDefaults,
    applyTemporaryNumberFormatSettings,
  } = createTemporaryDatasetFormat({
    isTemporaryDatasetView,
    state,
    getDatasetNumberFormatDefaults,
    getCurrentDatasetSettings: (...args) => getCurrentDatasetSettings(...args),
    normalizeDatasetSettings: (...args) => normalizeDatasetSettings(...args),
    buildDatasetSidecarContextPayload: (...args) => buildDatasetSidecarContextPayload(...args),
    hasDatasetSidecarContext: (...args) => hasDatasetSidecarContext(...args),
    getDatasetSyncedNumberFormatValue,
    setDatasetDecimalPlacesValue,
    setDatasetNumberFormatValue,
    renderTable,
    notifyDatasetUpdated,
    applyGridSelectionFromState,
  });
  const {
    normalizeDatasetModeText,
    sourceKindIsReadOnly,
    currentDatasetIsManualTriangleOrVector,
    hasManualInputGridChanges,
    hasUnsavedDatasetChanges,
    isUnsavedProjectInstanceDraft,
    shouldPersistManualInputGridValues,
    hasPendingDatasetSaveWork,
    isDraftGridUnavailable,
  } = createDatasetDirtyState({
    state,
    isProjectInstanceDraft,
    isReadOnlyDatasetViewer,
    isTemporaryDatasetView,
    isDfmDataTabHost,
    getProjectInstanceDraftDataFormat,
    getDatasetInstanceNameValue,
    normalizeDatasetInstanceKey,
    getSavedProjectInstanceDraftName: () => runtime.savedProjectInstanceDraftName,
    getDatasetSidecarSourceKind: () => runtime.currentDatasetSidecarSourceKind,
    getDatasetSidecarDataFormat: () => runtime.currentDatasetSidecarDataFormat,
    getDatasetExternalLinks: () => runtime.datasetExternalLinks,
    isSettingsDirty: () => datasetSettingsDirty,
    isNotesDirty: () => notesDirty,
  });
  runtime.datasetExternalLinks = createDatasetExternalLinksController({
    state,
    isReadOnly: () => isDatasetReadOnly() || isDfmDataTabHost() || !currentDatasetIsManualTriangleOrVector(),
    isTransposed: () => document.getElementById("transposedChk")?.checked === true,
    onInventoryChanged: () => {
      getDataTabLinksController()?.refresh?.();
      updateDatasetSaveUi();
    },
  });
  function buildDatasetSidecarContextPayload() {
    return {
      project_name: getResolvedProjectValue(),
      reserving_class: getResolvedReservingClassValue(),
      dataset_name: getDatasetInstanceNameValue(),
      dataset_type: (document.getElementById("triInput")?.value || "").trim(),
      instance_name: getDatasetInstanceNameValue(),
    };
  }

  function hasDatasetSidecarContext(payload) {
    return !!(
      String(payload?.project_name || "").trim()
      && String(payload?.reserving_class || "").trim()
      && String(payload?.dataset_name || "").trim()
    );
  }

  function buildDatasetSidecarContextKey(payload) {
    if (!hasDatasetSidecarContext(payload)) return "";
    return `${payload.project_name}\u001f${payload.reserving_class}\u001f${payload.dataset_type || ""}\u001f${payload.dataset_name}`;
  }

  function getCurrentDatasetSettings() {
    const triInputs = getTriInputs();
    return {
      dataset_type: triInputs.tri,
      instance_name: triInputs.instanceName || triInputs.tri,
      data_format: isProjectInstanceDraft ? getProjectInstanceDraftDataFormat() : undefined,
      origin_length: triInputs.originLen,
      development_length: triInputs.devLen,
      cumulative: !!triInputs.cumulative,
      transposed: !!triInputs.transposed,
      calendar: !!triInputs.calendar,
      show_subtotal: state.showSubtotal !== false,
      decimal_places: getDatasetDecimalPlacesValue(),
      number_format: getDatasetSyncedNumberFormatValue(),
    };
  }

  function getManualInputDatasetValuePayload() {
    if (!shouldPersistManualInputGridValues() || !state.model) return {};
    const values = Array.isArray(state.model.values)
      ? state.model.values.map((row) => (
        Array.isArray(row)
          ? row.map((value) => {
            if (value == null || value === "") return null;
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : null;
          })
          : []
      ))
      : null;
    const mask = Array.isArray(state.model.mask)
      ? state.model.mask.map((row) => (Array.isArray(row) ? row.map(Boolean) : []))
      : null;
    if (!Array.isArray(values) || !values.length) return {};
    return {
      source_kind: "input",
      data_format: runtime.currentDatasetSidecarDataFormat || state.model?.data_format || getProjectInstanceDraftDataFormat(),
      origin_labels: Array.isArray(state.model.origin_labels) ? state.model.origin_labels.map(String) : undefined,
      values,
      mask,
    };
  }

  function getDatasetExternalLinksPayload() {
    if (
      isDfmDataTabHost()
      || !datasetExternalLinksLoaded
      || !currentDatasetIsManualTriangleOrVector()
    ) return {};
    return { external_links: runtime.datasetExternalLinks.serialize() };
  }

  function normalizeDatasetSettings(source = {}) {
    const origin = Number(source.origin_length ?? source.originLen);
    const development = Number(source.development_length ?? source.devLen);
    const numberFormat = source.number_format ?? source.numberFormat ?? source.num_format;
    const decimalPlaces = source.decimal_places ?? source.decimalPlaces;
    const normalizedDecimalPlaces = clampDatasetDecimalPlaces(decimalPlaces);
    return {
      dataset_type: String(source.dataset_type ?? source.datasetType ?? source.tri ?? "").trim(),
      instance_name: String(source.instance_name ?? source.instanceName ?? source.dataset_name ?? source.datasetName ?? "").trim(),
      origin_length: Number.isFinite(origin) && origin > 0 ? Math.trunc(origin) : 12,
      development_length: Number.isFinite(development) && development > 0 ? Math.trunc(development) : 12,
      cumulative: typeof source.cumulative === "boolean" ? source.cumulative : true,
      transposed: typeof source.transposed === "boolean" ? source.transposed : false,
      calendar: typeof source.calendar === "boolean" ? source.calendar : false,
      show_subtotal: typeof source.show_subtotal === "boolean" ? source.show_subtotal : true,
      decimal_places: normalizedDecimalPlaces,
      number_format: applyDecimalPlacesToDatasetNumberFormat(
        normalizeDatasetNumberFormat(numberFormat),
        normalizedDecimalPlaces,
      ),
    };
  }

  function sameDatasetSettings(a, b) {
    const left = normalizeDatasetSettings(a || {});
    const right = normalizeDatasetSettings(b || {});
    return (
      left.origin_length === right.origin_length
      && left.development_length === right.development_length
      && left.cumulative === right.cumulative
      && left.transposed === right.transposed
      && left.calendar === right.calendar
      && left.show_subtotal === right.show_subtotal
      && left.decimal_places === right.decimal_places
      && left.number_format === right.number_format
      && normalizeProjectText(left.dataset_type) === normalizeProjectText(right.dataset_type)
      && normalizeProjectText(left.instance_name) === normalizeProjectText(right.instance_name)
    );
  }

  function datasetValuesAreAllZero() {
    const values = Array.isArray(state.model?.values) ? state.model.values : [];
    const mask = Array.isArray(state.model?.mask) ? state.model.mask : [];
    for (let r = 0; r < values.length; r += 1) {
      const row = Array.isArray(values[r]) ? values[r] : [];
      for (let c = 0; c < row.length; c += 1) {
        if (Array.isArray(mask[r]) && mask[r][c] === false) continue;
        const raw = row[c];
        if (raw == null || raw === "") continue;
        const value = Number(raw);
        if (!Number.isFinite(value) || Math.abs(value) > 1e-12) return false;
      }
    }
    return true;
  }

  function getManualDatasetLengthBaseline() {
    const settings = lastSavedDatasetSettings;
    if (!settings) {
      return {
        origin_length: 12,
        development_length: 12,
      };
    }
    return {
      origin_length: Number(settings.origin_length) || 12,
      development_length: Number(settings.development_length) || 12,
    };
  }

  function getCurrentLengthControlValues() {
    const origin = Number.parseInt(document.getElementById("originLenSelect")?.value || "", 10);
    const dev = Number.parseInt(document.getElementById("devLenSelect")?.value || "", 10);
    return {
      origin_length: Number.isFinite(origin) ? origin : 12,
      development_length: Number.isFinite(dev) ? dev : 12,
    };
  }

  function validateManualDatasetLengthChange() {
    if (!currentDatasetIsManualTriangleOrVector()) return true;
    if (datasetValuesAreAllZero()) return true;
    const baseline = getManualDatasetLengthBaseline();
    const current = getCurrentLengthControlValues();
    if (current.origin_length >= baseline.origin_length && current.development_length >= baseline.development_length) {
      return true;
    }
    setLenSelectValue("originLenSelect", String(baseline.origin_length));
    setLenSelectValue("devLenSelect", String(baseline.development_length));
    refreshLenDropdowns();
    setStatus("Manual input datasets with non-zero values cannot use a lower period length. Set all values to 0 before changing to a lower level.");
    return false;
  }

  function updateManualDatasetModeControls() {
    const locked = currentDatasetIsManualTriangleOrVector();
    const message = "Manual input Triangle/Vector datasets keep their cumulative and development/calendar mode fixed.";
    const cumulativeChk = document.getElementById("cumulativeChk");
    if (cumulativeChk) {
      cumulativeChk.disabled = locked;
      cumulativeChk.title = locked ? message : "";
    }
    document.querySelectorAll('input[name="timeMode"]').forEach((input) => {
      input.disabled = locked;
      input.title = locked ? message : "";
    });
  }

  function restoreManualDatasetModeControls() {
    const settings = normalizeDatasetSettings(lastSavedDatasetSettings || getCurrentDatasetSettings());
    const cumulativeChk = document.getElementById("cumulativeChk");
    if (cumulativeChk) cumulativeChk.checked = settings.cumulative;
    const mode = settings.calendar ? "calendar" : "development";
    const modeInput = document.querySelector(`input[name="timeMode"][value="${mode}"]`);
    if (modeInput) modeInput.checked = true;
    updateManualDatasetModeControls();
  }

  function notifyDatasetDirtyState() {
    const dirty = hasUnsavedDatasetChanges();
    try {
      window.parent?.postMessage({
        type: "arcrho:dataset-dirty",
        inst: instanceId,
        dirty,
      }, "*");
    } catch {}
  }

  function updateDatasetSaveUi() {
    const bar = document.getElementById("datasetSaveBar");
    const saveBtn = document.getElementById("datasetSaveBtn");
    const cancelBtn = document.getElementById("datasetCancelBtn");
    const runBtn = document.getElementById("runArcRhoTriBtn");
    const clearBtn = document.getElementById("clearCacheReloadBtn");
    const hasContext = hasDatasetSidecarContext(sidecarContextPayload) || hasNotesContext(notesContextPayload);
    const dirty = hasPendingDatasetSaveWork();
    if (bar) bar.hidden = !hasContext || isTemporaryDatasetView;
    updateTabbedPageSaveControls({
      saveButton: saveBtn,
      cancelButton: cancelBtn,
      dirty,
      saving: runtime.datasetSaveInFlight,
      saveBlocked: isTemporaryDatasetView || runtime.datasetInstanceNameConflict || !hasContext || isDraftGridUnavailable(),
      cancelBlocked: isTemporaryDatasetView || !hasContext,
    });
    for (const button of [runBtn, clearBtn]) {
      if (!button) continue;
      if (runtime.datasetInstanceNameConflict) {
        if (button.dataset.duplicateNameBlocked !== "1") {
          button.dataset.originalTitle = button.title || "";
        }
        button.dataset.duplicateNameBlocked = "1";
        button.disabled = true;
        button.title = runtime.datasetInstanceNameConflictMessage || "Dataset instance name already exists.";
      } else if (button.dataset.duplicateNameBlocked === "1") {
        button.disabled = false;
        button.title = button.dataset.originalTitle || "";
        delete button.dataset.duplicateNameBlocked;
      }
    }
    updateManualDatasetModeControls();
    notifyDatasetDirtyState();
  }

  function refreshDatasetSettingsDirty() {
    if (isTemporaryDatasetView) {
      datasetSettingsDirty = false;
      updateDatasetSaveUi();
      return;
    }
    if (isDfmDataTabHost()) {
      datasetSettingsDirty = false;
      updateDatasetSaveUi();
      return;
    }
    datasetSettingsDirty = !!lastSavedDatasetSettings && !sameDatasetSettings(getCurrentDatasetSettings(), lastSavedDatasetSettings);
    updateDatasetSaveUi();
  }

  function applyDatasetSettingsToControls(settings = {}) {
    const normalized = normalizeDatasetSettings(settings);
    setLenSelectValue("originLenSelect", String(normalized.origin_length));
    setLenSelectValue("devLenSelect", String(normalized.development_length));
    const cumulativeChk = document.getElementById("cumulativeChk");
    if (cumulativeChk) cumulativeChk.checked = normalized.cumulative;
    const transposedChk = document.getElementById("transposedChk");
    if (transposedChk) transposedChk.checked = normalized.transposed;
    state.showSubtotal = normalized.show_subtotal;
    const mode = normalized.calendar ? "calendar" : "development";
    const modeInput = document.querySelector(`input[name="timeMode"][value="${mode}"]`);
    if (modeInput) modeInput.checked = true;
    setDatasetDecimalPlacesValue(normalized.decimal_places);
    setDatasetNumberFormatValue(normalized.number_format);
    refreshLenDropdowns();
  }

  function invalidateDatasetContextLoads() {
    sidecarSyncNonce += 1;
    datasetExcelFreshnessAbortController?.abort();
    datasetExcelFreshnessAbortController = null;
    runtime.datasetExternalLinks.abort();
  }

  function scheduleDatasetExcelFreshnessPrompt({ contextKey, isCurrent }) {
    if (
      !contextKey
      || datasetExcelFreshnessCheckedKeys.has(contextKey)
      || !datasetExternalLinksLoaded
      || !Number.isFinite(Number(state.fileMtime))
    ) return;
    datasetExcelFreshnessCheckedKeys.add(contextKey);
    window.setTimeout(async () => {
      if (!isCurrent()) return;
      datasetExcelFreshnessAbortController?.abort();
      const abortController = new AbortController();
      datasetExcelFreshnessAbortController = abortController;
      const result = await runtime.datasetExternalLinks.checkForNewerWorkbooks(
        state.fileMtime,
        { signal: abortController.signal },
      );
      if (datasetExcelFreshnessAbortController === abortController) {
        datasetExcelFreshnessAbortController = null;
      }
      if (!isCurrent() || result?.aborted) return;
      if (!result?.ok) {
        setStatus("Excel link timestamps could not be verified.");
        return;
      }
      if (!result.newerWorkbookCount) return;
      const workbookNames = result.newerWorkbooks
        .map(({ path }) => String(path || "").split(/[\\/]/).pop())
        .filter(Boolean);
      const workbookSummary = workbookNames.length === 1
        ? `The linked workbook ${workbookNames[0]} is newer`
        : `${workbookNames.length} linked workbooks are newer`;
      const choice = await showPageMessageBox({
        title: "Linked Excel File Updated",
        tone: "warning",
        message: `${workbookSummary} than the values stored in this ArcRho dataset. Keep the stored values, or refresh from Excel. Refreshed values remain unsaved until you select Save.`,
        actions: [{ id: "refresh", label: "Refresh from Excel" }],
        okLabel: "Keep Current Values",
        balancedActions: true,
      });
      if (choice === "refresh" && isCurrent()) {
        await refreshDatasetExternalLinks({ isCurrent });
      }
    }, 0);
  }

  async function refreshDatasetExternalLinks(options = {}) {
    const isCurrent = typeof options?.isCurrent === "function" ? options.isCurrent : () => true;
    if (
      isDfmDataTabHost()
      || !datasetExternalLinksLoaded
      || !state.model
      || !currentDatasetIsManualTriangleOrVector()
      || !isCurrent()
    ) {
      return { linkedCellCount: 0, changedCount: 0, failedCount: 0 };
    }
    const result = await runtime.datasetExternalLinks.refreshAll(options?.ids ?? null);
    if (!isCurrent() || result?.stale || result?.aborted) return result;
    if (result.changedCount > 0) {
      renderTable();
      notifyDatasetUpdated();
      applyGridSelectionFromState();
    }
    getDataTabLinksController()?.refresh?.();
    if (result.failedCount > 0) {
      window.setTimeout(() => {
        if (isCurrent()) {
          setStatus(`Excel refresh: ${result.failedCount} linked dataset cell${result.failedCount === 1 ? "" : "s"} failed; saved values were retained.`);
        }
      }, 0);
    } else if (result.changedCount > 0) {
      window.setTimeout(() => {
        if (isCurrent()) {
          setStatus(`Excel refresh updated ${result.changedCount} linked dataset cell${result.changedCount === 1 ? "" : "s"}.`);
        }
      }, 0);
    }
    return result;
  }

  async function syncSidecarForCurrentDataset(options = {}) {
    const isCurrent = typeof options?.isCurrent === "function" ? options.isCurrent : () => true;
    if (!isCurrent()) return false;
    const context = buildDatasetSidecarContextPayload();
    const key = buildDatasetSidecarContextKey(context);
    sidecarContextPayload = hasDatasetSidecarContext(context) ? context : null;
    sidecarContextKey = key;
    if (!key) {
      if (isDfmDataTabHost()) setDatasetRenderNumberFormatSettings(null);
      runtime.isSidecarReadOnlyDataset = false;
      runtime.currentDatasetSidecarSourceKind = "";
      runtime.currentDatasetSidecarDataFormat = "";
      runtime.currentDatasetPrecedents = [];
      datasetExternalLinksLoaded = false;
      runtime.datasetExternalLinks.clear();
      lastSavedDatasetSettings = null;
      datasetSettingsDirty = false;
      renderDatasetAuditLog([]);
      renderDetailFormula("", runtime.currentDatasetPrecedents);
      renderDatasetPrecedents([]);
      renderDatasetDependents([]);
      updateDatasetSaveUi();
      return false;
    }

    const nonce = ++sidecarSyncNonce;
    getDatasetAuditLog()?.setLoading();
    let resp;
    try {
      resp = options?.sidecarData
        ? { ok: true, data: options.sidecarData }
        : await loadDatasetSidecar(context);
    } catch (error) {
      if (!isCurrent()) return false;
      if (nonce === sidecarSyncNonce) {
        getDatasetAuditLog()?.setError(error?.message || "Unable to load the audit log.");
        datasetExternalLinksLoaded = false;
        runtime.datasetExternalLinks.clear();
      }
      throw error;
    }
    if (nonce !== sidecarSyncNonce || !isCurrent()) return false;
    if (!resp.ok) {
      if (isDfmDataTabHost()) setDatasetRenderNumberFormatSettings(null);
      setStatus(`Dataset settings load failed: ${resp?.data?.detail || "Unknown error."}`);
      runtime.currentDatasetSidecarSourceKind = isProjectInstanceDraft ? "input" : "";
      runtime.currentDatasetSidecarDataFormat = isProjectInstanceDraft ? getProjectInstanceDraftDataFormat() : "";
      runtime.currentDatasetPrecedents = [];
      datasetExternalLinksLoaded = false;
      runtime.datasetExternalLinks.clear();
      lastSavedDatasetSettings = normalizeDatasetSettings(getCurrentDatasetSettings());
      datasetSettingsDirty = false;
      getDatasetAuditLog()?.setError(resp?.data?.detail || "Unable to load the audit log.");
      renderDetailFormula(getDatasetTypeFormulaByName(document.getElementById("triInput")?.value || ""), runtime.currentDatasetPrecedents);
      renderDatasetPrecedents([]);
      renderDatasetDependents([]);
      updateDatasetSaveUi();
      return false;
    }

    const data = resp.data || {};
    const notesSynced = await syncNotesForCurrentDataset({
      isCurrent,
      forceReload: options?.forceReload === true,
      notes: data.exists ? String(data.notes ?? "") : "",
    });
    if (!isCurrent() || notesSynced === false) return false;
    runtime.currentDatasetSidecarSourceKind = data.exists ? String(data.source_kind || "") : (isProjectInstanceDraft ? "input" : "");
    runtime.currentDatasetSidecarDataFormat = data.exists ? String(data.data_format || "") : (isProjectInstanceDraft ? getProjectInstanceDraftDataFormat() : "");
    runtime.currentDatasetPrecedents = data.exists ? normalizeDatasetDependencyEntries(data.Precedents) : [];
    datasetExternalLinksLoaded = !isDfmDataTabHost() && currentDatasetIsManualTriangleOrVector();
    runtime.datasetExternalLinks.load(
      datasetExternalLinksLoaded && data.exists ? data.external_links : [],
    );
    if (data.exists) scheduleDatasetExcelFreshnessPrompt({ contextKey: key, isCurrent });
    if (isProjectInstanceDraft && data.exists && !String(data.csv_file || "").trim()) {
      runtime.savedProjectInstanceDraftName = String(data.dataset_name || context.dataset_name || "").trim();
    }
    renderDatasetAuditLog(data.exists ? data.audit_log : []);
    renderDetailFormula(
      data.exists
        ? (String(data.formula || "").trim() || getDatasetTypeFormulaByName(data.dataset_type || context.dataset_name || ""))
        : getDatasetTypeFormulaByName(document.getElementById("triInput")?.value || ""),
      runtime.currentDatasetPrecedents,
    );
    renderDatasetPrecedents(runtime.currentDatasetPrecedents);
    renderDatasetDependents(data.exists ? data.Dependents : []);
    runtime.isSidecarReadOnlyDataset = !!data.exists && sourceKindIsReadOnly(runtime.currentDatasetSidecarSourceKind);
    const patchSaveBtn = document.getElementById("saveBtn");
    if (patchSaveBtn && !isReadOnlyDatasetViewer) {
      patchSaveBtn.disabled = runtime.isSidecarReadOnlyDataset;
      patchSaveBtn.title = runtime.isSidecarReadOnlyDataset ? "Calculated datasets are read-only." : "";
    }
    let settings;
    if (data.exists) {
      settings = normalizeDatasetSettings(data);
    } else if (isTemporaryDatasetView) {
      settings = await resolveTemporaryDatasetSettings(context);
      if (!isCurrent()) return false;
    } else {
      settings = normalizeDatasetSettings(getCurrentDatasetSettings());
    }
    if (isDfmDataTabHost()) {
      setDatasetRenderNumberFormatSettings(data.exists ? settings : null);
    }
    lastSavedDatasetSettings = settings;
    if (options?.forceReload === true) {
      await refreshDatasetExternalLinks({ isCurrent });
      if (!isCurrent()) return false;
    }
    if (options?.applyLengths !== false && data.exists) {
      applyDatasetSettingsToControls(settings);
      saveTriInputsToStorage();
      datasetSettingsDirty = false;
      updateDatasetSaveUi();
      return true;
    }
    applyTemporaryNumberFormatSettings(settings);
    refreshDatasetSettingsDirty();
    return true;
  }

  async function saveDatasetSidecarForCurrentContext() {
    if (isTemporaryDatasetView) {
      return { ok: false, error: "Temporary view does not save permanent dataset sidecars." };
    }
    if (isProjectInstanceDraft) {
      const originResult = validateDatasetOriginLabels(state.model?.origin_labels, {
        originLen: getTriInputs().originLen,
        requireMatchingPeriod: true,
      });
      if (!originResult.ok) {
        return {
          ok: false,
          error: `Dataset draft cannot be saved: ${originResult.error}. Set a valid Origin Start Date in Project Settings, then try again.`,
        };
      }
    }
    if (await refreshDatasetInstanceNameConflict()) {
      return { ok: false, error: runtime.datasetInstanceNameConflictMessage || "Dataset instance name already exists." };
    }
    const context = buildDatasetSidecarContextPayload();
    if (!hasDatasetSidecarContext(context)) {
      return { ok: false, error: "Project, Reserving Class, and Dataset Type are required." };
    }
    const settings = getCurrentDatasetSettings();
    const resp = await withDataTabDatasetMutation({ source: "sidecar-save" }, () => saveDatasetSidecar({
      ...context,
      ...settings,
      notes: String(getNotesEditorElements().input?.value ?? ""),
      ...getManualInputDatasetValuePayload(),
      ...getDatasetExternalLinksPayload(),
    }));
    if (!resp.ok) {
      return { ok: false, error: resp?.data?.detail || "Failed to save dataset settings." };
    }
    sidecarSyncNonce += 1;
    sidecarContextPayload = context;
    sidecarContextKey = buildDatasetSidecarContextKey(context);
    notesContextPayload = { ...context };
    notesContextKey = buildNotesContextKey(notesContextPayload);
    applyNotesInputValue(String(resp.data?.notes ?? ""));
    lastSavedDatasetSettings = normalizeDatasetSettings(settings);
    runtime.currentDatasetSidecarSourceKind = String(resp.data?.source_kind || (isProjectInstanceDraft ? "input" : runtime.currentDatasetSidecarSourceKind) || "");
    runtime.currentDatasetSidecarDataFormat = String(resp.data?.data_format || settings.data_format || runtime.currentDatasetSidecarDataFormat || "");
    runtime.currentDatasetPrecedents = normalizeDatasetDependencyEntries(resp.data?.Precedents);
    if (datasetExternalLinksLoaded) {
      runtime.datasetExternalLinks.markClean(resp.data?.external_links ?? runtime.datasetExternalLinks.serialize());
    }
    if (isProjectInstanceDraft) {
      runtime.savedProjectInstanceDraftName = context.dataset_name;
    }
    if (hasManualInputGridChanges()) {
      state.dirty.clear();
    }
    if (state.model && currentDatasetIsManualTriangleOrVector()) {
      state.model.source_kind = runtime.currentDatasetSidecarSourceKind;
      state.model.data_format = runtime.currentDatasetSidecarDataFormat;
    }
    if (resp.data?.ds_id) {
      config.DS_ID = String(resp.data.ds_id);
      saveLastDsId(config.DS_ID);
    }
    if (resp.data?.file_mtime !== undefined && resp.data?.file_mtime !== null) {
      state.fileMtime = resp.data.file_mtime;
    }
    renderDatasetAuditLog(resp.data?.audit_log);
    renderDetailFormula(
      String(resp.data?.formula || "").trim() || getDatasetTypeFormulaByName(settings.dataset_type),
      runtime.currentDatasetPrecedents,
    );
    renderDatasetPrecedents(runtime.currentDatasetPrecedents);
    renderDatasetDependents(resp.data?.Dependents);
    invalidateCachedDatasetInstances();
    datasetSettingsDirty = false;
    updateDatasetSaveUi();
    clearDatasetDependencyPreview("save");
    handleCalculationUpdates(resp.data?.calculated_updates, "Dataset settings save");
    notifyDataTabDurableDatasetState({ source: "sidecar-save" });
    return { ok: true, data: resp.data };
  }
  async function saveDatasetChanges(options = {}) {
    if (isTemporaryDatasetView) {
      return { ok: false, error: "Temporary view is read-only and cannot save permanent dataset changes." };
    }
    if (runtime.datasetSaveInFlight) return { ok: false, error: "Save already in progress." };
    runtime.datasetExternalLinks.abort();
    runtime.datasetSaveInFlight = true;
    updateDatasetSaveUi();
    void getDataTabLinksController()?.refresh?.();
    let saveStatus = buildDatasetSaveStatus();
    try {
      if (datasetSettingsDirty || hasManualInputGridChanges() || runtime.datasetExternalLinks.isDirty() || notesDirty || isUnsavedProjectInstanceDraft()) {
        const sidecarResult = await saveDatasetSidecarForCurrentContext();
        if (!sidecarResult.ok) return sidecarResult;
        saveStatus = buildDatasetSaveStatus(sidecarResult.data);
      }
      updateDatasetSaveUi();
      if (!options?.silentStatus) setStatus(saveStatus.text, saveStatus.tone);
      requestProjectInstanceDatasetTableRefresh();
      return { ok: true };
    } finally {
      runtime.datasetSaveInFlight = false;
      updateDatasetSaveUi();
      void getDataTabLinksController()?.refresh?.();
    }
  }

  async function discardDatasetChanges(options = {}) {
    const reload = options?.reload !== false;
    runtime.datasetExternalLinks.restoreSaved();
    if (lastSavedDatasetSettings) {
      applyDatasetSettingsToControls(lastSavedDatasetSettings);
      saveTriInputsToStorage();
      if (reload) {
        const project = getResolvedProjectValue();
        if (project) {
          await ensureHeadersForProject(project);
          await ensureDevHeadersForProject(project);
        }
        renderTable();
        notifyDatasetUpdated();
        renderChart();
        setStatus("Loading dataset...");
        scheduleAutoRun(0);
      }
    }
    if (notesDirty) applyNotesInputValue(lastSavedNotesText);
    clearDatasetDependencyPreview("cancel");
    state.dirty.clear();
    datasetSettingsDirty = false;
    updateDatasetSaveUi();
  }

  async function confirmCancelDatasetChanges(reason = "close") {
    if (!datasetCloseConfirm) datasetCloseConfirm = getDataTabCloseConfirm();
    if (!hasUnsavedDatasetChanges()) return true;
    if (!datasetCloseConfirm) return false;
    const discard = await datasetCloseConfirm.confirm({ reason });
    if (!discard) return false;
    await discardDatasetChanges({ reload: reason !== "close" });
    return true;
  }

  function requestConfirmedDatasetClose() {
    clearDatasetDependencyPreview("close-discard");
    requestTabbedPageWindowClose({
      messageType: "arcrho:dataset-close-confirmed",
      inst: instanceId,
    });
  }

  function wireDatasetSaveControls() {
    if (!datasetCloseConfirm) datasetCloseConfirm = getDataTabCloseConfirm();
    document.getElementById("datasetSaveBtn")?.addEventListener("click", async () => {
      await handleDatasetSaveCommand();
    });
    document.getElementById("datasetCancelBtn")?.addEventListener("click", async () => {
      const ok = await confirmCancelDatasetChanges("close");
      if (ok) requestConfirmedDatasetClose();
    });
    document.getElementById("datasetRecalcOk")?.addEventListener("click", hideCalculationUpdatesDialog);
    document.getElementById("datasetRecalcClose")?.addEventListener("click", hideCalculationUpdatesDialog);
    document.getElementById("datasetRecalcOverlay")?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) hideCalculationUpdatesDialog();
    });
    document.getElementById("datasetRecalcOverlay")?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        hideCalculationUpdatesDialog();
      }
    });
    window.__arcrho_request_close = () => {
      if (!hasUnsavedDatasetChanges()) return false;
      if (datasetCloseConfirm?.isOpen) return true;
      void (async () => {
        const ok = await confirmCancelDatasetChanges("close");
        if (ok) requestConfirmedDatasetClose();
      })();
      return true;
    };
    window.__arcrho_consume_close_shortcut = window.__arcrho_request_close;
    window.addEventListener("beforeunload", (event) => {
      if (!hasUnsavedDatasetChanges()) return;
      event.preventDefault();
      event.returnValue = "";
    });
    updateDatasetSaveUi();
  }

  async function handleDatasetSaveCommand() {
    const result = await saveDatasetChanges();
    if (!result.ok) setStatus(`Dataset save failed: ${result.error || "Unknown error."}`);
    return result;
  }

  function getDisplayProjectValue() {
    return (document.getElementById("projectSelect")?.value || "").trim();
  }

  function getDisplayReservingClassValue() {
    return (document.getElementById("pathInput")?.value || "").trim();
  }

  function getDisplayTriValue() {
    return (document.getElementById("triInput")?.value || "").trim();
  }

  function getRawProjectValueForNotes() {
    const input = document.getElementById("projectSelect");
    if (isInputDefaultBound(input)) {
      const defaults = loadWorkflowDefaults();
      return typeof defaults?.project === "string" ? defaults.project : "";
    }
    return String(input?.value ?? "");
  }

  function getRawReservingClassValueForNotes() {
    const input = document.getElementById("pathInput");
    if (isInputDefaultBound(input)) {
      const defaults = loadWorkflowDefaults();
      return typeof defaults?.reservingClass === "string" ? defaults.reservingClass : "";
    }
    return String(input?.value ?? "");
  }

  function getRawDatasetNameValueForNotes() {
    const input = document.getElementById("dsDetailName") || document.getElementById("triInput");
    return String(input?.value ?? "");
  }

  function buildNotesContextPayload() {
    return {
      project_name: getRawProjectValueForNotes(),
      reserving_class: getRawReservingClassValueForNotes(),
      dataset_name: getRawDatasetNameValueForNotes(),
    };
  }

  function hasNotesContext(payload) {
    if (!payload || typeof payload !== "object") return false;
    const projectName = String(payload.project_name ?? "");
    const reservingClass = String(payload.reserving_class ?? "");
    const datasetName = String(payload.dataset_name ?? "");
    return !!projectName.trim() && !!reservingClass.trim() && !!datasetName.trim();
  }

  function buildNotesContextKey(payload) {
    if (!hasNotesContext(payload)) return "";
    return `${payload.project_name}\u001f${payload.reserving_class}\u001f${payload.dataset_name}`;
  }

  function getNotesErrorMessage(resp, fallback) {
    const detail = resp?.data?.detail;
    if (typeof detail === "string" && detail.trim()) return detail.trim();
    const error = resp?.data?.error;
    if (typeof error === "string" && error.trim()) return error.trim();
    if (typeof fallback === "string" && fallback.trim()) return fallback.trim();
    return "Unknown error.";
  }

  function getNotesEditorElements() {
    return {
      input: datasetNotesController?.elements?.input || null,
      saveState: document.getElementById("dsNotesSaveState"),
    };
  }

  function updateNotesSaveUi() {
    const { saveState } = getNotesEditorElements();
    const hasContext = !!notesContextKey && hasNotesContext(notesContextPayload);

    if (!saveState) return;
    saveState.classList.remove("is-dirty", "is-clean", "is-hidden");
    if (isTemporaryDatasetView) {
      saveState.textContent = "Read-only in temporary view";
      saveState.classList.add("is-clean");
      updateDatasetSaveUi();
      return;
    }
    if (!hasContext) {
      saveState.textContent = "No dataset context";
      updateDatasetSaveUi();
      return;
    }
    if (notesDirty) {
      saveState.textContent = "Unsaved changes";
      saveState.classList.add("is-dirty");
      updateDatasetSaveUi();
      return;
    }
    saveState.textContent = "";
    saveState.classList.add("is-hidden");
    updateDatasetSaveUi();
  }

  function applyNotesInputValue(text) {
    const nextText = String(text ?? "");
    lastSavedNotesText = nextText;
    notesDirty = false;
    datasetNotesController?.setValue(nextText, { markClean: true });
    updateNotesSaveUi();
    updateDatasetSaveUi();
  }

  async function saveNotesForPayload(payload, options = {}) {
    if (isTemporaryDatasetView) {
      return { ok: false, error: "Temporary view is read-only and cannot save notes." };
    }
    const silentStatus = !!options?.silentStatus;
    const isCurrent = typeof options?.isCurrent === "function" ? options.isCurrent : () => true;
    if (!isCurrent()) return { ok: false, stale: true };
    if (!hasNotesContext(payload)) {
      updateNotesSaveUi();
      return { ok: false, error: "Project, Reserving Class, and Dataset Type are required." };
    }

    const { input } = getNotesEditorElements();
    const notesText = String(input?.value ?? "");
    const req = {
      project_name: payload.project_name,
      reserving_class: payload.reserving_class,
      dataset_name: payload.dataset_name,
      notes: notesText,
    };
    const resp = await saveDatasetNotes(req);
    if (!isCurrent()) return { ok: false, stale: true };
    if (!resp.ok) {
      return { ok: false, error: getNotesErrorMessage(resp, "Failed to save notes.") };
    }

    notesContextPayload = {
      project_name: req.project_name,
      reserving_class: req.reserving_class,
      dataset_name: req.dataset_name,
    };
    notesContextKey = buildNotesContextKey(notesContextPayload);
    lastSavedNotesText = notesText;
    datasetNotesController?.markClean(notesText);
    notesDirty = datasetNotesController?.isDirty()
      ?? (String(input?.value ?? "") !== notesText);
    updateNotesSaveUi();
    if (!silentStatus && !notesDirty) setStatus("Notes saved.");
    return { ok: true, data: resp.data, dirty: notesDirty };
  }

  async function saveNotesForCurrentContext(options = {}) {
    return saveNotesForPayload(notesContextPayload, options);
  }

  async function syncNotesForCurrentDataset(options = {}) {
    const isCurrent = typeof options?.isCurrent === "function" ? options.isCurrent : () => true;
    const forceReload = options?.forceReload === true;
    if (!isCurrent()) return false;
    const nextPayload = buildNotesContextPayload();
    const nextKey = buildNotesContextKey(nextPayload);
    if (nextKey === notesContextKey && notesDirty) {
      notesContextPayload = hasNotesContext(nextPayload) ? nextPayload : null;
      updateNotesSaveUi();
      return true;
    }
    if (nextKey === notesContextKey && !forceReload) {
      notesContextPayload = hasNotesContext(nextPayload) ? nextPayload : null;
      updateNotesSaveUi();
      return true;
    }

    if (notesContextKey && notesDirty) {
      const shouldSave = window.confirm(
        "You have unsaved Notes. Click OK to save before switching notes, or Cancel to discard unsaved changes.",
      );
      if (shouldSave) {
        const saveResult = await saveNotesForCurrentContext({ silentStatus: true, isCurrent });
        if (!isCurrent()) return false;
        if (saveResult.stale) return false;
        if (!saveResult.ok) {
          setStatus(`Notes save failed: ${saveResult.error || "Unknown error."}`);
          updateNotesSaveUi();
          return false;
        }
        if (saveResult.dirty) {
          setStatus("Notes changed while saving. Save the latest notes before switching datasets.");
          updateNotesSaveUi();
          return false;
        }
      } else {
        notesDirty = false;
      }
    }

    notesContextPayload = hasNotesContext(nextPayload) ? nextPayload : null;
    notesContextKey = nextKey;
    updateNotesSaveUi();
    if (!nextKey) {
      applyNotesInputValue("");
      return true;
    }

    applyNotesInputValue(String(options?.notes ?? ""));
    return true;
  }

  function wireDataTabPersistenceLifecycle() {
    if (hostInputsPublished) return;
    hostInputsPublished = true;
    publishDataTabHostInputs({
      getResolvedProjectValue,
      getResolvedReservingClassValue,
      getDisplayProjectValue,
      getDisplayReservingClassValue,
      getDisplayTriValue,
      isInputDefaultBound,
    });
  }
  function wireNotesEditor() {
    if (datasetNotesController && !datasetNotesController.destroyed) return datasetNotesController;
    const container = document.getElementById("datasetNotesMount");
    if (!container) return null;
    datasetNotesController = mountDataTabNotes({
      container,
      setNotesDirty: (value) => {
        notesDirty = !!value;
      },
      updateNotesSaveUi,
      setStatus,
    });
    if (isTemporaryDatasetView) {
      const { input, styleControls } = datasetNotesController?.elements || {};
      if (input) {
        input.readOnly = true;
        input.setAttribute("aria-readonly", "true");
        input.title = "Notes are read-only in temporary view.";
      }
      for (const control of Object.values(styleControls || {})) {
        if (control) control.disabled = true;
      }
    }
    return datasetNotesController;
  }


  Object.assign(runtime, {
    wireDataTabPersistenceLifecycle,
    buildDatasetSidecarContextPayload, hasDatasetSidecarContext,
    buildDatasetSidecarContextKey, getCurrentDatasetSettings,
    getManualInputDatasetValuePayload, getDatasetExternalLinksPayload,
    normalizeDatasetSettings, sameDatasetSettings,
    hasManualInputGridChanges, hasUnsavedDatasetChanges,
    isUnsavedProjectInstanceDraft, shouldPersistManualInputGridValues,
    hasPendingDatasetSaveWork, isDraftGridUnavailable,
    normalizeDatasetModeText,
    sourceKindIsReadOnly,
    currentDatasetIsManualTriangleOrVector,
    datasetValuesAreAllZero,
    getManualDatasetLengthBaseline,
    getCurrentLengthControlValues,
    validateManualDatasetLengthChange,
    updateManualDatasetModeControls,
    restoreManualDatasetModeControls,
    notifyDatasetDirtyState,
    updateDatasetSaveUi,
    refreshDatasetSettingsDirty,
    applyDatasetSettingsToControls,
    applyTemporaryNumberFormatDefaults,
    resolveTemporaryDatasetSettings,
    loadTemporaryNumberFormatSettings,
    invalidateDatasetContextLoads,
    refreshDatasetExternalLinks,
    syncSidecarForCurrentDataset,
    saveDatasetSidecarForCurrentContext,
    saveDatasetChanges,
    discardDatasetChanges,
    confirmCancelDatasetChanges,
    requestConfirmedDatasetClose,
    wireDatasetSaveControls,
    handleDatasetSaveCommand,
    getDisplayProjectValue,
    getDisplayReservingClassValue,
    getDisplayTriValue,
    getRawProjectValueForNotes,
    getRawReservingClassValueForNotes,
    getRawDatasetNameValueForNotes,
    buildNotesContextPayload,
    hasNotesContext,
    buildNotesContextKey,
    getNotesErrorMessage,
    getNotesEditorElements,
    updateNotesSaveUi,
    applyNotesInputValue,
    saveNotesForPayload,
    saveNotesForCurrentContext,
    syncNotesForCurrentDataset,
    wireNotesEditor,
  });
}

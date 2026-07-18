/**
 * Project Settings - Folder Tree View
 * Displays projects in an expandable folder structure
 */
import { AuditLogStore } from "/ui/project_settings/project_settings_audit.js?v=20260223";
import { createFieldMappingFeature } from "/ui/project_settings/project_settings_field_mapping.js?v=20260315";
import { createDatasetTypesFeature } from "/ui/project_settings/project_settings_dataset_types.js?v=2026040308";
import { createReservingClassTypesFeature } from "/ui/project_settings/project_settings_reserving_class_types.js?v=20260716resize2";
import { createDataProcessingRulesFeature } from "/ui/project_settings/project_settings_data_processing_rules.js?v=20260717dpr8";
import { loadProjectUserPreferences } from "/ui/shared/services/project_user_preferences.js?v=20260716psprefs1";
import "/ui/shared/integrations/zoom_bridge.js?v=20260521a";

// ============ Zoom & Hotkey Handling ============
const EXPANDED_FOLDERS_SESSION_KEY = "arcrho_project_settings_expanded_folders_v1";
const SELECTED_PROJECT_SESSION_KEY = "arcrho_project_settings_selected_project_v1";
const LOCAL_PROJECT_PREFS_ENDPOINT = "/local-project/preferences";
const PROJECT_EXPLORER_PREF_SAVE_DEBOUNCE_MS = 400;

window.ArcRhoZoomBridge?.wirePageZoomBridge();

function wireProjectSettingsTableScrollbarActivity(scrollHost) {
  if (!scrollHost || scrollHost.dataset.scrollbarActivityWired === "1") return;
  scrollHost.dataset.scrollbarActivityWired = "1";
  let idleTimer = 0;

  scrollHost.addEventListener("scroll", () => {
    scrollHost.classList.add("isScrolling");
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => scrollHost.classList.remove("isScrolling"), 550);
  }, { passive: true });

  scrollHost.addEventListener("pointermove", (event) => {
    const rect = scrollHost.getBoundingClientRect();
    const verticalScrollbarWidth = Math.max(0, scrollHost.offsetWidth - scrollHost.clientWidth);
    const horizontalScrollbarHeight = Math.max(0, scrollHost.offsetHeight - scrollHost.clientHeight);
    const overVerticalLane = scrollHost.scrollHeight > scrollHost.clientHeight
      && verticalScrollbarWidth > 0
      && event.clientX >= rect.right - Math.max(verticalScrollbarWidth, 16);
    const overHorizontalLane = scrollHost.scrollWidth > scrollHost.clientWidth
      && horizontalScrollbarHeight > 0
      && event.clientY >= rect.bottom - Math.max(horizontalScrollbarHeight, 16);
    scrollHost.classList.toggle("isScrollbarHover", overVerticalLane || overHorizontalLane);
  }, { passive: true });

  scrollHost.addEventListener("pointerleave", () => {
    scrollHost.classList.remove("isScrollbarHover");
  }, { passive: true });
}

window.addEventListener("message", (e) => {
  const msgType = String(e?.data?.type || "");
  if (msgType === "arcrho:project-settings-reserving-class-types-save-local") {
    handleShellReservingClassTypesLocalSave();
    return;
  }
  if (msgType === "arcrho:project-settings-reserving-class-types-load-local") {
    handleShellReservingClassTypesLocalLoad();
    return;
  }
  if (msgType === "arcrho:project-settings-dataset-types-save-local") {
    handleShellDatasetTypesLocalSave();
    return;
  }
  if (msgType === "arcrho:project-settings-dataset-types-load-local") {
    handleShellDatasetTypesLocalLoad();
    return;
  }
  if (msgType === "arcrho:server-connection-updated") {
    loadProjectData(DEFAULT_SOURCE);
  }
});

window.addEventListener("mousedown", () => {
  window.parent.postMessage({ type: "arcrho:close-shell-menus" }, "*");
}, { capture: true });

window.addEventListener("keydown", (e) => {
  const key = (e.key || "").toLowerCase();
  if (e.altKey && key === "w") {
    e.preventDefault();
    window.parent.postMessage({ type: "arcrho:close-active-tab" }, "*");
    return;
  }
  if (e.ctrlKey && key === "q") {
    e.preventDefault();
    window.parent.postMessage({ type: "arcrho:hotkey", action: "app_shutdown" }, "*");
    return;
  }
}, { capture: true });

// ============ State ============
let projectData = null;       // Raw JSON data
let treeData = null;          // Parsed tree structure
let selectedProject = null;   // Currently selected project
let expandedFolders = new Set(); // Track expanded folders
let draggedProject = null;    // Currently dragged project
let draggedFolder = null;     // Currently dragged folder node
let contextMenuProject = null; // Project for context menu actions
let contextMenuFolder = null;  // Folder node for context menu (create subfolder)
let activeProjectSettingsRibbon = "summary";
let projectExplorerPreferenceSaveTimer = 0;
let projectExplorerPreferencesLoaded = false;

// ============ DOM Elements ============
const treeContent = document.getElementById("treeContent");
const detailEmpty = document.getElementById("detailEmpty");
const detailView = document.getElementById("detailView");
const detailTitle = document.getElementById("detailTitle");
const detailForm = document.getElementById("detailForm");
const openProjectFolderBtn = document.getElementById("openProjectFolderBtn");
const openInTabBtn = document.getElementById("openInTabBtn");
const treePanel = document.getElementById("treePanel");
const resizeHandle = document.getElementById("resizeHandle");
const treeHeader = document.querySelector(".tree-header");
const contextMenu = document.getElementById("contextMenu");
const folderContextMenu = document.getElementById("folderContextMenu");
const treeContextMenu = document.getElementById("treeContextMenu");
const summaryTablePathInput = document.getElementById("summaryTablePathInput");
const summaryTablePathReloadBtn = document.getElementById("summaryTablePathReloadBtn");
const summaryTablePathBrowseBtn = document.getElementById("summaryTablePathBrowseBtn");
const summaryOriginStartInput = document.getElementById("summaryOriginStartInput");
const summaryOriginEndInput = document.getElementById("summaryOriginEndInput");
const summaryDevelopmentEndInput = document.getElementById("summaryDevelopmentEndInput");
const summaryOriginStartUpBtn = document.getElementById("summaryOriginStartUpBtn");
const summaryOriginStartDownBtn = document.getElementById("summaryOriginStartDownBtn");
const summaryOriginEndUpBtn = document.getElementById("summaryOriginEndUpBtn");
const summaryOriginEndDownBtn = document.getElementById("summaryOriginEndDownBtn");
const summaryDevelopmentEndUpBtn = document.getElementById("summaryDevelopmentEndUpBtn");
const summaryDevelopmentEndDownBtn = document.getElementById("summaryDevelopmentEndDownBtn");
const dialogOverlay = document.getElementById("dialogOverlay");
const dialogTitle = document.getElementById("dialogTitle");
const dialogInput = document.getElementById("dialogInput");
const dialogOk = document.getElementById("dialogOk");
const dialogCancel = document.getElementById("dialogCancel");
const projectOperationProgress = document.getElementById("projectOperationProgress");
const projectOperationProgressTitle = document.getElementById("projectOperationProgressTitle");
const confirmOverlay = document.getElementById("confirmOverlay");
const confirmTitle = document.getElementById("confirmTitle");
const confirmMessage = document.getElementById("confirmMessage");
const confirmOk = document.getElementById("confirmOk");
const confirmCancel = document.getElementById("confirmCancel");
const confirmBox = document.getElementById("confirmBox");
const fieldMappingBody = document.getElementById("fieldMappingBody");
const fieldMappingStatus = document.getElementById("fieldMappingStatus");
const saveFieldMappingBtn = document.getElementById("saveFieldMappingBtn");
const datasetTypesBody = document.getElementById("datasetTypesBody");
const datasetTypesStatus = document.getElementById("datasetTypesStatus");
const datasetTypesRowContextMenu = document.getElementById("datasetTypesRowContextMenu");
const datasetTypesErrorOverlay = document.getElementById("datasetTypesErrorOverlay");
const datasetTypesErrorBody = document.getElementById("datasetTypesErrorBody");
const datasetTypesErrorClose = document.getElementById("datasetTypesErrorClose");
const reservingClassTypesBody = document.getElementById("reservingClassTypesBody");
const reservingClassTypesStatus = document.getElementById("reservingClassTypesStatus");
const reservingClassTypesRowContextMenu = document.getElementById("reservingClassTypesRowContextMenu");
const dataProcessingRulesBody = document.getElementById("dataProcessingRulesBody");
const dataProcessingRulesStatus = document.getElementById("dataProcessingRulesStatus");
const dataProcessingRulesRowContextMenu = document.getElementById("dataProcessingRulesRowContextMenu");
const addDataProcessingRuleBtn = document.getElementById("addDataProcessingRuleBtn");
const validateDataProcessingRulesBtn = document.getElementById("validateDataProcessingRulesBtn");
const dataProcessingRulesJsonBtn = document.getElementById("dataProcessingRulesJsonBtn");
const dataProcessingRuleEditor = document.getElementById("dataProcessingRuleEditor");
const dataProcessingRuleEditorTitle = document.getElementById("dataProcessingRuleEditorTitle");
const dataProcessingRuleEditorClose = document.getElementById("dataProcessingRuleEditorClose");
const dprEditName = document.getElementById("dprEditName");
const dprEditEnabled = document.getElementById("dprEditEnabled");
const dprAutoNamePill = document.getElementById("dprAutoNamePill");
const dprEditEnabledLabel = document.getElementById("dprEditEnabledLabel");
const dprEditSourceMeasure = document.getElementById("dprEditSourceMeasure");
const dprRequestConditions = document.getElementById("dprRequestConditions");
const dprAddRequestConditionBtn = document.getElementById("dprAddRequestConditionBtn");
const dprThenConditions = document.getElementById("dprThenConditions");
const dprAddThenConditionBtn = document.getElementById("dprAddThenConditionBtn");
const dprActionVerbGroup = document.getElementById("dprActionVerbGroup");
const dprKeepHint = document.getElementById("dprKeepHint");
const dprVocabWarning = document.getElementById("dprVocabWarning");
const dprEditSummary = document.getElementById("dprEditSummary");
const dprEditError = document.getElementById("dprEditError");
const dprEditorCancelBtn = document.getElementById("dprEditorCancelBtn");
const dprEditorSaveBtn = document.getElementById("dprEditorSaveBtn");
const dataProcessingRulesJsonOverlay = document.getElementById("dataProcessingRulesJsonOverlay");
const dataProcessingRulesJsonBody = document.getElementById("dataProcessingRulesJsonBody");
const dataProcessingRulesJsonClose = document.getElementById("dataProcessingRulesJsonClose");
const auditLogBody = document.getElementById("auditLogBody");
const auditLogStatus = document.getElementById("auditLogStatus");
const reservingClassTypeEditor = document.getElementById("reservingClassTypeEditor");
const reservingClassTypeEditorHeader = document.getElementById("reservingClassTypeEditorHeader");
const reservingClassTypeEditorTitle = document.getElementById("reservingClassTypeEditorTitle");
const reservingClassTypeEditorClose = document.getElementById("reservingClassTypeEditorClose");
const rctEditName = document.getElementById("rctEditName");
const rctEditLevel = document.getElementById("rctEditLevel");
const rctEditFormula = document.getElementById("rctEditFormula");
const rctFormulaReview = document.getElementById("rctFormulaReview");
const rctEditorCancelBtn = document.getElementById("rctEditorCancelBtn");
const rctEditorSaveBtn = document.getElementById("rctEditorSaveBtn");
const datasetTypeEditor = document.getElementById("datasetTypeEditor");
const datasetTypeEditorHeader = document.getElementById("datasetTypeEditorHeader");
const datasetTypeEditorTitle = document.getElementById("datasetTypeEditorTitle");
const datasetTypeEditorClose = document.getElementById("datasetTypeEditorClose");
const dtEditName = document.getElementById("dtEditName");
const dtEditDataFormat = document.getElementById("dtEditDataFormat");
const dtEditCategory = document.getElementById("dtEditCategory");
const dtEditCalculated = document.getElementById("dtEditCalculated");
const dtEditFormula = document.getElementById("dtEditFormula");
const dtEditorCancelBtn = document.getElementById("dtEditorCancelBtn");
const dtEditorSaveBtn = document.getElementById("dtEditorSaveBtn");

// ============ Data Sources ============
const DEFAULT_SOURCE = "project_map";

let currentMtime = null; // Track file modification time for conflict detection
let tableSummaryLoadSeq = 0;
let currentFieldNames = [];
const EMPTY_GENERAL_SETTINGS = Object.freeze({
  projectName: "",
  projectFolderName: "",
  projectNameMismatch: false,
  autoGenerated: true,
  originStartDate: "",
  originEndDate: "",
  developmentEndDate: "",
});
const generalSettingsByProject = new Map();
const AUTO_SAVE_DEBOUNCE_MS = 700;
const datasetTypesAutoSaveTimers = new Map();
const datasetTypesAutoSaveInFlight = new Map();
const datasetTypesAutoSavePending = new Set();
const reservingClassTypesAutoSaveTimers = new Map();
const reservingClassTypesAutoSaveInFlight = new Map();
const reservingClassTypesAutoSavePending = new Set();
const tableColumnWidthsById = new Map();
const tableDefaultColumnWidthsById = new Map();
const configuredTableColumnWidthsById = new Map();

function normalizeTableColumnPreferenceKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function applyProjectSettingsTablePreferences(preferences) {
  configuredTableColumnWidthsById.clear();
  tableColumnWidthsById.clear();
  tableDefaultColumnWidthsById.clear();

  const tables = preferences?.projectSettings?.tables;
  if (!tables || typeof tables !== "object" || Array.isArray(tables)) return;
  Object.entries(tables).forEach(([tableId, tablePreferences]) => {
    const widths = tablePreferences?.widths;
    if (!widths || typeof widths !== "object" || Array.isArray(widths)) return;
    const normalizedWidths = new Map();
    Object.entries(widths).forEach(([columnName, rawWidth]) => {
      const key = normalizeTableColumnPreferenceKey(columnName);
      const width = Math.round(Number(rawWidth));
      if (key && Number.isFinite(width) && width > 0) normalizedWidths.set(key, width);
    });
    if (normalizedWidths.size) configuredTableColumnWidthsById.set(tableId, normalizedWidths);
  });
}

function getConfiguredTableColumnWidths(tableId, cols, ths, minWidths) {
  const configured = configuredTableColumnWidthsById.get(tableId);
  if (!(configured instanceof Map) || !configured.size) return null;
  let matched = false;
  const widths = Array.from(cols).map((col, index) => {
    const th = ths[index];
    const label = th?.querySelector?.(".dt-col-label-text, .table-col-label");
    const key = normalizeTableColumnPreferenceKey(label?.textContent || th?.textContent || "");
    const configuredWidth = Number(configured.get(key));
    const minimumWidth = Number(minWidths?.[index]) || 40;
    if (Number.isFinite(configuredWidth) && configuredWidth > 0) {
      matched = true;
      return Math.max(minimumWidth, Math.round(configuredWidth));
    }
    return getTableColumnWidth(col, minimumWidth);
  });
  return matched ? widths : null;
}

function resizeCellTextarea(textarea) {
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = textarea.scrollHeight + "px";
}

function measureTextWidth(text, font) {
  const span = document.createElement("span");
  span.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;font:" + font;
  span.textContent = text;
  document.body.appendChild(span);
  const w = span.offsetWidth;
  document.body.removeChild(span);
  return w;
}

function measureHeaderLabelWidth(labelEl, fallbackText, fallbackFont) {
  if (!labelEl) return measureTextWidth(fallbackText, fallbackFont);
  const prevInline = {
    maxWidth: labelEl.style.maxWidth,
    whiteSpace: labelEl.style.whiteSpace,
    wordBreak: labelEl.style.wordBreak,
    overflowWrap: labelEl.style.overflowWrap,
    width: labelEl.style.width,
    display: labelEl.style.display,
  };
  const computedDisplay = getComputedStyle(labelEl).display;
  labelEl.style.maxWidth = "none";
  labelEl.style.whiteSpace = "nowrap";
  labelEl.style.wordBreak = "normal";
  labelEl.style.overflowWrap = "normal";
  labelEl.style.width = "max-content";
  if (computedDisplay === "inline") labelEl.style.display = "inline-block";
  const measured = Math.ceil(Math.max(labelEl.scrollWidth || 0, labelEl.getBoundingClientRect().width || 0));
  labelEl.style.maxWidth = prevInline.maxWidth;
  labelEl.style.whiteSpace = prevInline.whiteSpace;
  labelEl.style.wordBreak = prevInline.wordBreak;
  labelEl.style.overflowWrap = prevInline.overflowWrap;
  labelEl.style.width = prevInline.width;
  labelEl.style.display = prevInline.display;
  if (measured > 0) return measured;
  return measureTextWidth(fallbackText, fallbackFont);
}

function getTableColumnWidth(col, minimumWidth = 40) {
  const inlineWidth = Number.parseFloat(col?.style?.width);
  const renderedWidth = Number(col?.offsetWidth);
  const width = Number.isFinite(inlineWidth) && inlineWidth > 0
    ? inlineWidth
    : renderedWidth;
  return Math.max(minimumWidth, Math.round(Number.isFinite(width) && width > 0 ? width : minimumWidth));
}

function syncTableTotalWidth(table, cols, minWidths = []) {
  const totalWidth = Array.from(cols).reduce((sum, col, index) => (
    sum + getTableColumnWidth(col, Number(minWidths[index]) || 40)
  ), 0);
  const width = Math.max(1, Math.round(totalWidth));
  table.style.width = `${width}px`;
  table.style.minWidth = `${width}px`;
  return width;
}

function captureTableColumnWidths(cols, minWidths = []) {
  return Array.from(cols).map((col, index) => (
    getTableColumnWidth(col, Number(minWidths[index]) || 40)
  ));
}

function applyTableColumnWidths(table, cols, widths, minWidths = []) {
  Array.from(cols).forEach((col, index) => {
    const minimumWidth = Number(minWidths[index]) || 40;
    const width = Math.max(minimumWidth, Math.round(Number(widths[index]) || minimumWidth));
    col.style.width = `${width}px`;
  });
  syncTableTotalWidth(table, cols, minWidths);
}

function autoFitColumn(table, cols, ths, minWidths, index, maxColWidth) {
  if (index < 0 || index >= cols.length || index >= ths.length) return;
  const rows = table.querySelectorAll("tbody tr");
  const font = getComputedStyle(table).font;
  const headerFont = ths[0] ? getComputedStyle(ths[0]).font : font;
  const th = ths[index];
  const minW = (minWidths && minWidths[index]) || 40;
  const thStyles = getComputedStyle(th);
  const headerPadX = (parseFloat(thStyles.paddingLeft) || 0) + (parseFloat(thStyles.paddingRight) || 0);
  const labelEl = th.querySelector(".table-col-label");
  const headerText = String(labelEl ? labelEl.textContent : th.textContent || "");
  const headerContentW = measureHeaderLabelWidth(labelEl, headerText, headerFont);
  let maxW = Math.max(minW, headerContentW + headerPadX + 8);
  rows.forEach(tr => {
    const td = tr.children[index];
    if (!td) return;
    const textarea = td.querySelector("textarea");
    const select = td.querySelector("select");
    const input = td.querySelector("input");
    let text = "";
    if (textarea) text = textarea.value;
    else if (select) text = select.options[select.selectedIndex]?.text || "";
    else if (input && input.type === "checkbox") return;
    else if (input) text = input.value;
    else text = td.textContent;
    if (text) maxW = Math.max(maxW, measureTextWidth(text, font) + 28);
  });
  cols[index].style.width = `${Math.min(maxW, maxColWidth)}px`;
}

function autoFitColumns(table, cols, ths, minWidths, maxColWidth) {
  ths.forEach((_th, index) => autoFitColumn(table, cols, ths, minWidths, index, maxColWidth));
  syncTableTotalWidth(table, cols, minWidths);
  table.querySelectorAll("tbody textarea").forEach(resizeCellTextarea);
}

function initTableColumnResizing(tableId, minWidths) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const cols = table.querySelectorAll("colgroup col");
  const ths = table.querySelectorAll("thead th");
  if (!cols.length || !ths.length) return;
  const configuredWidths = getConfiguredTableColumnWidths(tableId, cols, ths, minWidths);
  const defaultWidths = configuredWidths || captureTableColumnWidths(cols, minWidths);
  if (configuredWidths) {
    tableDefaultColumnWidthsById.set(tableId, defaultWidths);
  } else if (!tableDefaultColumnWidthsById.has(tableId)
      || tableDefaultColumnWidthsById.get(tableId).length !== cols.length) {
    tableDefaultColumnWidthsById.set(tableId, defaultWidths);
  }

  ths.forEach((th, idx) => {
    if (idx >= cols.length) return;

    // Wrap header text in a label span if not already wrapped
    if (!th.querySelector(".table-col-label")) {
      const label = document.createElement("span");
      label.className = "table-col-label";
      while (th.firstChild) label.appendChild(th.firstChild);
      th.appendChild(label);
    }

    // Remove existing resizer if any (in case of re-init)
    const existing = th.querySelector(".table-col-resizer");
    if (existing) existing.remove();

    const resizer = document.createElement("div");
    resizer.className = "table-col-resizer";
    th.appendChild(resizer);

    const minW = (minWidths && minWidths[idx]) || 40;

    // Drag to resize
    resizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = getTableColumnWidth(cols[idx], minW);
      document.body.classList.add("ps-resizing-table-column");

      function onMove(ev) {
        const newW = Math.max(minW, startW + (ev.clientX - startX));
        cols[idx].style.width = `${Math.round(newW)}px`;
        syncTableTotalWidth(table, cols, minWidths);
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mouseup", onUp, true);
        document.body.classList.remove("ps-resizing-table-column");
        tableColumnWidthsById.set(tableId, captureTableColumnWidths(cols, minWidths));
        table.querySelectorAll("tbody textarea").forEach(resizeCellTextarea);
      }
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
    });

    // A click is emitted after mouseup even when the pointer was dragged. Keep
    // that synthetic click on the handle from reaching sortable table headers.
    resizer.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    resizer.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const defaults = tableDefaultColumnWidthsById.get(tableId) || defaultWidths;
      const width = Math.max(minW, Math.round(Number(defaults[idx]) || minW));
      cols[idx].style.width = `${width}px`;
      syncTableTotalWidth(table, cols, minWidths);
      tableColumnWidthsById.set(tableId, captureTableColumnWidths(cols, minWidths));
      table.querySelectorAll("tbody textarea").forEach(resizeCellTextarea);
    });
  });

  const savedWidths = tableColumnWidthsById.get(tableId);
  if (Array.isArray(savedWidths) && savedWidths.length === cols.length) {
    applyTableColumnWidths(table, cols, savedWidths, minWidths);
  } else if (configuredWidths) {
    applyTableColumnWidths(table, cols, configuredWidths, minWidths);
    tableColumnWidthsById.set(tableId, captureTableColumnWidths(cols, minWidths));
  } else {
    autoFitColumns(table, cols, ths, minWidths, 380);
    tableColumnWidthsById.set(tableId, captureTableColumnWidths(cols, minWidths));
  }
}

function setStatus(msg) {
  // Send status to app's statusbar
  window.parent.postMessage({ type: "arcrho:status", text: msg || "" }, "*");
}

function showProjectOperationProgress(title) {
  if (!projectOperationProgress || !projectOperationProgressTitle) return;
  projectOperationProgressTitle.textContent = String(title || "Working...").trim() || "Working...";
  projectOperationProgress.hidden = false;
}

function hideProjectOperationProgress() {
  if (!projectOperationProgress) return;
  projectOperationProgress.hidden = true;
}

function notifyProjectSettingsRibbonChanged() {
  window.parent.postMessage(
    {
      type: "arcrho:project-settings-ribbon-changed",
      ribbon: String(activeProjectSettingsRibbon || "").trim().toLowerCase(),
    },
    "*",
  );
}

async function handleShellDatasetTypesLocalSave() {
  if (String(activeProjectSettingsRibbon || "").trim().toLowerCase() !== "dataset-types") {
    setStatus("Dataset Types tab is not active.");
    return;
  }
  const projectName = String(selectedProject?.name || "").trim();
  if (!projectName) {
    datasetTypesFeature?.setDatasetTypesStatus("Select a project first.", true);
    setStatus("Select a project first.");
    return;
  }
  await datasetTypesFeature?.saveDatasetTypesToLocalFile(projectName);
}

async function handleShellDatasetTypesLocalLoad() {
  if (String(activeProjectSettingsRibbon || "").trim().toLowerCase() !== "dataset-types") {
    setStatus("Dataset Types tab is not active.");
    return;
  }
  const projectName = String(selectedProject?.name || "").trim();
  if (!projectName) {
    datasetTypesFeature?.setDatasetTypesStatus("Select a project first.", true);
    setStatus("Select a project first.");
    return;
  }
  await datasetTypesFeature?.loadDatasetTypesFromLocalFile(projectName);
}

async function handleShellReservingClassTypesLocalSave() {
  if (String(activeProjectSettingsRibbon || "").trim().toLowerCase() !== "reserving-class-types") {
    setStatus("Reserving Class Types tab is not active.");
    return;
  }
  const projectName = String(selectedProject?.name || "").trim();
  if (!projectName) {
    reservingClassTypesFeature?.setReservingClassTypesStatus("Select a project first.", true);
    setStatus("Select a project first.");
    return;
  }
  await reservingClassTypesFeature?.saveReservingClassTypesToLocalFile(projectName);
}

async function handleShellReservingClassTypesLocalLoad() {
  if (String(activeProjectSettingsRibbon || "").trim().toLowerCase() !== "reserving-class-types") {
    setStatus("Reserving Class Types tab is not active.");
    return;
  }
  const projectName = String(selectedProject?.name || "").trim();
  if (!projectName) {
    reservingClassTypesFeature?.setReservingClassTypesStatus("Select a project first.", true);
    setStatus("Select a project first.");
    return;
  }
  await reservingClassTypesFeature?.loadReservingClassTypesFromLocalFile(projectName);
}

function normalizeProjectKey(name) {
  return String(name || "").trim().toLowerCase();
}

const auditLogStore = new AuditLogStore({
  auditLogBody,
  auditLogStatus,
  initTableColumnResizing,
  fetchImpl: fetch.bind(window),
});

async function loadAuditLog(projectName, force = false) {
  return auditLogStore.load(projectName, force);
}

async function appendAuditLogAction(projectName, action) {
  return auditLogStore.append(projectName, action);
}

function clearAutoSaveTimer(timerMap, key) {
  const timerId = timerMap.get(key);
  if (timerId) {
    clearTimeout(timerId);
    timerMap.delete(key);
  }
}

function scheduleDatasetTypesAutoSave(projectName) {
  const key = normalizeProjectKey(projectName);
  if (!key) return;
  clearAutoSaveTimer(datasetTypesAutoSaveTimers, key);
  const timerId = setTimeout(() => {
    triggerDatasetTypesAutoSave(projectName);
  }, AUTO_SAVE_DEBOUNCE_MS);
  datasetTypesAutoSaveTimers.set(key, timerId);
}

async function triggerDatasetTypesAutoSave(projectName) {
  const key = normalizeProjectKey(projectName);
  if (!key) return;
  clearAutoSaveTimer(datasetTypesAutoSaveTimers, key);
  if (datasetTypesAutoSaveInFlight.get(key)) {
    datasetTypesAutoSavePending.add(key);
    return;
  }
  datasetTypesAutoSaveInFlight.set(key, true);
  try {
    await datasetTypesFeature?.saveDatasetTypes(projectName);
  } finally {
    datasetTypesAutoSaveInFlight.set(key, false);
    if (datasetTypesAutoSavePending.has(key)) {
      datasetTypesAutoSavePending.delete(key);
      scheduleDatasetTypesAutoSave(projectName);
    }
  }
}

async function syncDatasetTypeSourcesAfterFieldMappingSave(projectName) {
  const name = String(projectName || "").trim();
  if (!name) {
    return { ok: false, message: "Project name is missing." };
  }
  if (!datasetTypesFeature) {
    return { ok: false, message: "Dataset Types feature is unavailable." };
  }

  const loadedOk = await datasetTypesFeature.ensureDatasetTypesLoaded(name);
  if (!loadedOk) {
    return { ok: false, message: "Unable to load Dataset Types for source sync." };
  }

  const savedOk = await datasetTypesFeature.saveDatasetTypes(name);
  if (!savedOk) {
    return { ok: false, message: "Unable to save Dataset Types after Field Mapping update." };
  }
  return { ok: true };
}

function scheduleReservingClassTypesAutoSave(projectName) {
  const key = normalizeProjectKey(projectName);
  if (!key) return;
  clearAutoSaveTimer(reservingClassTypesAutoSaveTimers, key);
  const timerId = setTimeout(() => {
    triggerReservingClassTypesAutoSave(projectName);
  }, AUTO_SAVE_DEBOUNCE_MS);
  reservingClassTypesAutoSaveTimers.set(key, timerId);
}

async function triggerReservingClassTypesAutoSave(projectName) {
  const key = normalizeProjectKey(projectName);
  if (!key) return;
  clearAutoSaveTimer(reservingClassTypesAutoSaveTimers, key);
  if (reservingClassTypesAutoSaveInFlight.get(key)) {
    reservingClassTypesAutoSavePending.add(key);
    return;
  }
  reservingClassTypesAutoSaveInFlight.set(key, true);
  try {
    await reservingClassTypesFeature?.saveReservingClassTypes(projectName);
  } finally {
    reservingClassTypesAutoSaveInFlight.set(key, false);
    if (reservingClassTypesAutoSavePending.has(key)) {
      reservingClassTypesAutoSavePending.delete(key);
      scheduleReservingClassTypesAutoSave(projectName);
    }
  }
}

let fieldMappingFeature = null;
let datasetTypesFeature = null;
let reservingClassTypesFeature = null;
let dataProcessingRulesFeature = null;

datasetTypesFeature = createDatasetTypesFeature({
  datasetTypesBody,
  datasetTypesStatus,
  datasetTypesRowContextMenu,
  datasetTypesErrorOverlay,
  datasetTypesErrorBody,
  datasetTypesErrorClose,
  initTableColumnResizing,
  resizeCellTextarea,
  normalizeProjectKey,
  fetchImpl: fetch.bind(window),
  setStatus,
  loadAuditLog,
  getSelectedProject: () => selectedProject,
  getCurrentFieldNames: () => currentFieldNames,
  ensureFieldMappingLoaded: (...args) => fieldMappingFeature?.ensureFieldMappingLoaded(...args),
  findDatasetTypeOwnerInFieldMapping: (...args) => fieldMappingFeature?.findDatasetTypeOwner(...args) || "",
  getMappedDatasetTypeNamesInFieldMapping: (...args) => fieldMappingFeature?.getMappedDatasetTypeNames(...args) || [],
  renderFieldMappingTable: (...args) => fieldMappingFeature?.renderFieldMappingTable(...args),
  hideContextMenu,
  hideFolderContextMenu,
  hideTreeContextMenu,
  hideReservingClassTypesRowContextMenu: (...args) => reservingClassTypesFeature?.hideReservingClassTypesRowContextMenu(...args),
  positionContextMenu,
  datasetTypeEditor,
  datasetTypeEditorHeader,
  datasetTypeEditorTitle,
  dtEditName,
  dtEditDataFormat,
  dtEditCategory,
  dtEditCalculated,
  dtEditFormula,
  scheduleDatasetTypesAutoSave,
});

fieldMappingFeature = createFieldMappingFeature({
  fieldMappingBody,
  fieldMappingStatus,
  initTableColumnResizing,
  normalizeProjectKey,
  fetchImpl: fetch.bind(window),
  setStatus,
  getDatasetTypeNamesForProject: (...args) => datasetTypesFeature?.getDatasetTypeNamesForProject(...args) || [],
  getCurrentFieldNames: () => currentFieldNames,
  loadAuditLog,
  syncDatasetTypesSources: (...args) => syncDatasetTypeSourcesAfterFieldMappingSave(...args),
});

reservingClassTypesFeature = createReservingClassTypesFeature({
  reservingClassTypesBody,
  reservingClassTypesStatus,
  reservingClassTypesRowContextMenu,
  reservingClassTypeEditor,
  reservingClassTypeEditorHeader,
  reservingClassTypeEditorTitle,
  rctEditName,
  rctEditLevel,
  rctEditFormula,
  rctFormulaReview,
  initTableColumnResizing,
  normalizeProjectKey,
  fetchImpl: fetch.bind(window),
  setStatus,
  loadAuditLog,
  hideContextMenu,
  hideFolderContextMenu,
  hideTreeContextMenu,
  hideDatasetTypesRowContextMenu: (...args) => datasetTypesFeature?.hideDatasetTypesRowContextMenu(...args),
  scheduleReservingClassTypesAutoSave,
  positionContextMenu,
});

dataProcessingRulesFeature = createDataProcessingRulesFeature({
  rulesBody: dataProcessingRulesBody,
  rulesStatus: dataProcessingRulesStatus,
  rowContextMenu: dataProcessingRulesRowContextMenu,
  addButton: addDataProcessingRuleBtn,
  validateButton: validateDataProcessingRulesBtn,
  jsonButton: dataProcessingRulesJsonBtn,
  editor: dataProcessingRuleEditor,
  editorTitle: dataProcessingRuleEditorTitle,
  editorClose: dataProcessingRuleEditorClose,
  editName: dprEditName,
  editEnabled: dprEditEnabled,
  autoNamePill: dprAutoNamePill,
  editEnabledLabel: dprEditEnabledLabel,
  editSourceMeasure: dprEditSourceMeasure,
  requestConditions: dprRequestConditions,
  addRequestConditionButton: dprAddRequestConditionBtn,
  thenConditions: dprThenConditions,
  addThenConditionButton: dprAddThenConditionBtn,
  actionVerbGroup: dprActionVerbGroup,
  keepHint: dprKeepHint,
  dprVocabWarning,
  editSummary: dprEditSummary,
  editError: dprEditError,
  editorCancelButton: dprEditorCancelBtn,
  editorSaveButton: dprEditorSaveBtn,
  jsonOverlay: dataProcessingRulesJsonOverlay,
  jsonBody: dataProcessingRulesJsonBody,
  jsonClose: dataProcessingRulesJsonClose,
  fetchImpl: fetch.bind(window),
  setStatus,
  loadAuditLog,
  showConfirm,
  initTableColumnResizing,
  positionContextMenu,
  hideContextMenu,
  hideFolderContextMenu,
  hideTreeContextMenu,
  hideDatasetTypesRowContextMenu: (...args) => datasetTypesFeature?.hideDatasetTypesRowContextMenu(...args),
  hideReservingClassTypesRowContextMenu: (...args) => reservingClassTypesFeature?.hideReservingClassTypesRowContextMenu(...args),
});

function toWinPath(pathValue) {
  return String(pathValue || "").trim().replace(/\//g, "\\");
}

function normalizeTreePath(pathValue) {
  const raw = String(pathValue || "").trim().replace(/\//g, "\\");
  if (!raw) return "";
  const parts = raw.split("\\").map((p) => p.trim()).filter(Boolean);
  return parts.join("\\");
}

function loadExpandedFoldersFromSession() {
  try {
    const raw = sessionStorage.getItem(EXPANDED_FOLDERS_SESSION_KEY);
    if (raw == null) return false;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return false;
    expandedFolders = new Set(parsed.map(normalizeTreePath).filter(Boolean));
    return true;
  } catch {
    return false;
  }
}

function getExpandedFoldersSnapshot() {
  return Array.from(expandedFolders)
    .map(normalizeTreePath)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
}

function saveExpandedFoldersToSession() {
  try {
    sessionStorage.setItem(EXPANDED_FOLDERS_SESSION_KEY, JSON.stringify(getExpandedFoldersSnapshot()));
  } catch {}
}

function normalizeExpandedFolderList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const path = normalizeTreePath(item);
    const key = path.toLowerCase();
    if (!path || seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

async function loadExpandedFoldersFromLocalPreferences() {
  try {
    const res = await fetch(LOCAL_PROJECT_PREFS_ENDPOINT, { cache: "no-store" });
    if (!res.ok) return false;
    const payload = await res.json().catch(() => ({}));
    const prefs = payload?.preferences || payload || {};
    const explorerPrefs = prefs?.projectExplorer || prefs?.project_explorer || {};
    const folders = normalizeExpandedFolderList(explorerPrefs?.expandedFolders || explorerPrefs?.expanded_folders || []);
    if (!folders.length && !Array.isArray(explorerPrefs?.expandedFolders) && !Array.isArray(explorerPrefs?.expanded_folders)) {
      return false;
    }
    expandedFolders = new Set(folders);
    saveExpandedFoldersToSession();
    return true;
  } catch (err) {
    console.warn("Failed to load project explorer preferences:", err);
    return false;
  }
}

async function saveExpandedFoldersToLocalPreferences() {
  const folders = getExpandedFoldersSnapshot();
  try {
    const res = await fetch(LOCAL_PROJECT_PREFS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectExplorer: {
          expandedFolders: folders,
        },
        updated_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(detail || `HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn("Failed to save project explorer preferences:", err);
  }
}

function persistExpandedFolders(options = {}) {
  saveExpandedFoldersToSession();
  if (!projectExplorerPreferencesLoaded) return;
  if (projectExplorerPreferenceSaveTimer) {
    window.clearTimeout(projectExplorerPreferenceSaveTimer);
    projectExplorerPreferenceSaveTimer = 0;
  }
  if (options?.immediate) {
    void saveExpandedFoldersToLocalPreferences();
    return;
  }
  projectExplorerPreferenceSaveTimer = window.setTimeout(() => {
    projectExplorerPreferenceSaveTimer = 0;
    void saveExpandedFoldersToLocalPreferences();
  }, PROJECT_EXPLORER_PREF_SAVE_DEBOUNCE_MS);
}

function syncExpandedFoldersWithTreeData() {
  if (!treeData || typeof treeData !== "object") return;

  const validPathMap = new Map();
  for (const folderPath of Object.keys(treeData)) {
    const normalized = normalizeTreePath(folderPath);
    if (!normalized) continue;
    const parts = normalized.split("\\");
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}\\${part}` : part;
      const key = acc.toLowerCase();
      if (!validPathMap.has(key)) validPathMap.set(key, acc);
    }
  }

  const nextExpanded = new Set();
  for (const path of expandedFolders) {
    const normalized = normalizeTreePath(path);
    if (!normalized) continue;
    const canonical = validPathMap.get(normalized.toLowerCase());
    if (canonical) nextExpanded.add(canonical);
  }

  expandedFolders = nextExpanded;
  persistExpandedFolders();
}

function buildSelectedProjectSnapshot(project) {
  if (!project || typeof project !== "object") return null;
  const name = String(project.name || "").trim();
  if (!name) return null;
  return {
    name,
    folder: normalizeTreePath(project.folder || ""),
    tablePath: toWinPath(project.tablePath || ""),
  };
}

function loadSelectedProjectFromSession() {
  try {
    const raw = sessionStorage.getItem(SELECTED_PROJECT_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return buildSelectedProjectSnapshot(parsed);
  } catch {
    return null;
  }
}

function saveSelectedProjectToSession(project) {
  const snapshot = buildSelectedProjectSnapshot(project);
  if (!snapshot) {
    clearSelectedProjectFromSession();
    return;
  }
  try {
    sessionStorage.setItem(SELECTED_PROJECT_SESSION_KEY, JSON.stringify(snapshot));
  } catch {}
}

function clearSelectedProjectFromSession() {
  try {
    sessionStorage.removeItem(SELECTED_PROJECT_SESSION_KEY);
  } catch {}
}

function findProjectBySnapshot(snapshot) {
  if (!snapshot || !treeData || typeof treeData !== "object") return null;

  const nameKey = String(snapshot.name || "").trim().toLowerCase();
  if (!nameKey) return null;
  const folderKey = normalizeTreePath(snapshot.folder || "").toLowerCase();
  const tablePathKey = toWinPath(snapshot.tablePath || "").toLowerCase();

  const candidates = [];
  for (const folderData of Object.values(treeData)) {
    const projects = Array.isArray(folderData?.projects) ? folderData.projects : [];
    for (const project of projects) {
      const projectName = String(project?.name || "").trim().toLowerCase();
      if (projectName === nameKey) candidates.push(project);
    }
  }
  if (!candidates.length) return null;

  const byFolderAndTablePath = candidates.find((project) => {
    const projectFolder = normalizeTreePath(project.folder || "").toLowerCase();
    const projectTablePath = toWinPath(project.tablePath || "").toLowerCase();
    return !!folderKey && !!tablePathKey && projectFolder === folderKey && projectTablePath === tablePathKey;
  });
  if (byFolderAndTablePath) return byFolderAndTablePath;

  const byFolder = candidates.find((project) => {
    const projectFolder = normalizeTreePath(project.folder || "").toLowerCase();
    return !!folderKey && projectFolder === folderKey;
  });
  if (byFolder) return byFolder;

  return candidates[0];
}

function restoreSelectedProjectFromSession() {
  const snapshot = loadSelectedProjectFromSession() || buildSelectedProjectSnapshot(selectedProject);
  if (!snapshot) return false;

  const project = findProjectBySnapshot(snapshot);
  if (!project) {
    selectedProject = null;
    clearSelectedProjectFromSession();
    detailEmpty.style.display = "flex";
    detailView.style.display = "none";
    return false;
  }

  selectProject(project);
  return true;
}

function splitProjectTreePath(fullPath) {
  const normalized = normalizeTreePath(fullPath);
  if (!normalized) return { folderPath: "", projectName: "" };
  const parts = normalized.split("\\");
  const projectName = parts[parts.length - 1] || "";
  const folderPath = parts.length > 1 ? parts.slice(0, -1).join("\\") : "";
  return { folderPath, projectName };
}

function joinProjectTreePath(folderPath, projectName) {
  const folder = normalizeTreePath(folderPath);
  const name = String(projectName || "").trim();
  if (!name) return "";
  return folder ? `${folder}\\${name}` : name;
}

function pathEqualsCI(a, b) {
  return normalizeTreePath(a).toLowerCase() === normalizeTreePath(b).toLowerCase();
}

function ensureFolderStructureState() {
  if (!projectData || typeof projectData !== "object") return;
  if (!Array.isArray(projectData.customFolders)) projectData.customFolders = [];
  if (!Array.isArray(projectData.projectPaths)) projectData.projectPaths = [];
}

function ensureFolderPathWithParents(folderPath) {
  ensureFolderStructureState();
  const folder = normalizeTreePath(folderPath);
  if (!folder) return;
  const parts = folder.split("\\");
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}\\${part}` : part;
    const exists = projectData.customFolders.some((p) => pathEqualsCI(p, acc));
    if (!exists) projectData.customFolders.push(acc);
  }
}

function getProjectFolderFromStructure(projectName) {
  ensureFolderStructureState();
  const target = String(projectName || "").trim().toLowerCase();
  if (!target) return "Uncategorized";
  for (const fullPath of projectData.projectPaths) {
    const parsed = splitProjectTreePath(fullPath);
    if (String(parsed.projectName || "").trim().toLowerCase() === target) {
      return parsed.folderPath || "Uncategorized";
    }
  }
  return "Uncategorized";
}

function addProjectPathToStructure(projectName, folderPath = "Uncategorized") {
  ensureFolderStructureState();
  const project = String(projectName || "").trim();
  if (!project) return;
  const folder = normalizeTreePath(folderPath) || "Uncategorized";
  ensureFolderPathWithParents(folder);
  const full = joinProjectTreePath(folder, project);
  const exists = projectData.projectPaths.some((p) => pathEqualsCI(p, full));
  if (!exists) projectData.projectPaths.push(full);
}

function setProjectFolderInStructure(projectName, newFolderPath) {
  ensureFolderStructureState();
  const target = String(projectName || "").trim().toLowerCase();
  if (!target) return;
  const folder = normalizeTreePath(newFolderPath) || "Uncategorized";
  ensureFolderPathWithParents(folder);

  for (let i = 0; i < projectData.projectPaths.length; i++) {
    const parsed = splitProjectTreePath(projectData.projectPaths[i]);
    if (String(parsed.projectName || "").trim().toLowerCase() === target) {
      projectData.projectPaths[i] = joinProjectTreePath(folder, parsed.projectName);
      return;
    }
  }
  projectData.projectPaths.push(joinProjectTreePath(folder, projectName));
}

function renameProjectInStructure(oldProjectName, newProjectName) {
  ensureFolderStructureState();
  const oldKey = String(oldProjectName || "").trim().toLowerCase();
  const newName = String(newProjectName || "").trim();
  if (!oldKey || !newName) return;
  for (let i = 0; i < projectData.projectPaths.length; i++) {
    const parsed = splitProjectTreePath(projectData.projectPaths[i]);
    if (String(parsed.projectName || "").trim().toLowerCase() === oldKey) {
      projectData.projectPaths[i] = joinProjectTreePath(parsed.folderPath || "Uncategorized", newName);
      return;
    }
  }
}

function removeProjectPathFromStructure(projectName) {
  ensureFolderStructureState();
  const target = String(projectName || "").trim().toLowerCase();
  if (!target) return;
  const idx = projectData.projectPaths.findIndex((p) => {
    const parsed = splitProjectTreePath(p);
    return String(parsed.projectName || "").trim().toLowerCase() === target;
  });
  if (idx >= 0) projectData.projectPaths.splice(idx, 1);
}

const OBSOLETE_PROJECT_MAP_COLUMNS = new Set(["Folder", "Preload", "Project Settings", "Settings Profile"]);

function removeObsoleteProjectMapColumns(data) {
  if (!data || typeof data !== "object") return data;

  for (const sheetName of Object.keys(data)) {
    if (sheetName === "customFolders" || sheetName === "projectPaths") continue;
    const sheet = data[sheetName];
    if (!sheet || typeof sheet !== "object" || !Array.isArray(sheet.headers)) continue;

    const keepIndexes = [];
    const nextHeaders = [];
    sheet.headers.forEach((header, index) => {
      if (OBSOLETE_PROJECT_MAP_COLUMNS.has(String(header || ""))) return;
      keepIndexes.push(index);
      nextHeaders.push(header);
    });

    if (keepIndexes.length === sheet.headers.length) continue;
    sheet.headers = nextHeaders;
    if (Array.isArray(sheet.rows)) {
      sheet.rows = sheet.rows.map((row) => {
        const sourceRow = Array.isArray(row) ? row : [];
        return keepIndexes.map((index) => sourceRow[index]);
      });
    }
  }

  return data;
}

// ============ Load JSON Data ============
async function loadProjectData(sourceKey = DEFAULT_SOURCE) {
  setStatus("Loading projects...");
  generalSettingsByProject.clear();
  try {
    const res = await fetch(`/project_settings/${sourceKey}`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const result = await res.json();
    projectData = result.data;
    currentMtime = result.mtime;
    removeObsoleteProjectMapColumns(projectData);

    // Load virtual folder structure from projects/index.json.
    try {
      let folders = [];
      let projectPaths = [];

      const foldersRes = await fetch(`/project_settings/${sourceKey}/folders`);
      if (foldersRes.ok) {
        const foldersResult = await foldersRes.json();
        folders = Array.isArray(foldersResult.folders) ? foldersResult.folders : [];
        projectPaths = Array.isArray(foldersResult.project_paths) ? foldersResult.project_paths : [];
      }

      projectData.customFolders = Array.isArray(folders) ? folders : [];
      projectData.projectPaths = Array.isArray(projectPaths) ? projectPaths : [];
    } catch {
      projectData.customFolders = [];
      projectData.projectPaths = [];
    }

    buildTreeData();
    renderTree();
    restoreSelectedProjectFromSession();
    setStatus(`Loaded ${countProjects()} projects from ${result.path}`);
  } catch (err) {
    setStatus(`Error loading: ${err.message}`);
    console.error(err);
  }
}

function countProjects() {
  if (!treeData) return 0;
  let count = 0;
  for (const folder of Object.values(treeData)) {
    count += folder.projects.length;
  }
  return count;
}

/** Get the first sheet name (excludes customFolders). */
function getSheetName() {
  return projectData && Object.keys(projectData).find((k) => {
    if (k === "customFolders" || k === "projectPaths") return false;
    const v = projectData[k];
    return v && typeof v === "object" && Array.isArray(v.headers) && Array.isArray(v.rows);
  });
}

// ============ Build Tree Structure ============
function buildTreeData() {
  treeData = {};
  ensureFolderStructureState();

  const sheetName = getSheetName();
  if (!sheetName) return;

  const sheet = projectData[sheetName];
  if (!sheet || !Array.isArray(sheet.rows)) return;
  const headers = sheet.headers || [];
  const rows = sheet.rows || [];

  // Find column indices.
  const colIdx = {};
  headers.forEach((h, i) => {
    colIdx[h] = i;
  });

  const projectFolderMap = new Map();
  for (const fullPath of projectData.projectPaths || []) {
    const parsed = splitProjectTreePath(fullPath);
    const pName = String(parsed.projectName || "").trim();
    if (!pName) continue;
    const key = pName.toLowerCase();
    if (!projectFolderMap.has(key)) {
      projectFolderMap.set(key, parsed.folderPath || "Uncategorized");
    }
  }

  // Build folder -> projects map
  for (const row of rows) {
    const projectName = row[colIdx["Project Name"]] || "";
    const folder = projectFolderMap.get(String(projectName || "").trim().toLowerCase()) || "Uncategorized";
    const tablePath = row[colIdx["Table Path"]] || "";

    if (!projectName) continue;

    if (!treeData[folder]) {
      treeData[folder] = {
        name: folder,
        projects: []
      };
    }

    treeData[folder].projects.push({
      name: projectName,
      tablePath: tablePath,
      folder: folder,
      _row: row
    });
  }

  // Merge custom (empty) folders so they appear in the tree
  const customFolders = projectData.customFolders || [];
  for (const folderPath of customFolders) {
    if (folderPath && !treeData[folderPath]) {
      treeData[folderPath] = { name: folderPath.split("\\").pop(), projects: [] };
    }
  }

  // Sort folders
  const sortedFolders = {};
  Object.keys(treeData).sort().forEach(key => {
    sortedFolders[key] = treeData[key];
  });
  treeData = sortedFolders;
}

// ============ Render Tree ============
function renderTree() {
  treeContent.innerHTML = "";

  if (!treeData || Object.keys(treeData).length === 0) {
    treeContent.innerHTML = '<div style="padding:12px;color:#999;">No projects found</div>';
    return;
  }

  syncExpandedFoldersWithTreeData();

  // Build hierarchical folder structure
  // Folders can be nested like "New Jersey\2025 Q1"
  const rootFolders = buildHierarchy(treeData);

  for (const node of rootFolders) {
    const el = createFolderNode(node, 0);
    treeContent.appendChild(el);
  }
}

function buildHierarchy(flatFolders) {
  // Parse folder paths and build tree
  // e.g., "New Jersey\2025 Q1" -> { "New Jersey": { "2025 Q1": [...] } }
  const root = {};

  for (const [folderPath, data] of Object.entries(flatFolders)) {
    const parts = folderPath.split("\\");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!current[part]) {
        current[part] = {
          _name: part,
          _fullPath: parts.slice(0, i + 1).join("\\"),
          _children: {},
          _projects: []
        };
      }
      if (i === parts.length - 1) {
        // Leaf folder - add projects
        current[part]._projects = data.projects;
      }
      current = current[part]._children;
    }
  }

  // Convert to array for rendering
  return objectToArray(root);
}

function objectToArray(obj) {
  return Object.values(obj).map(node => ({
    name: node._name,
    fullPath: node._fullPath,
    projects: node._projects || [],
    children: objectToArray(node._children)
  }));
}

function createFolderNode(node, depth) {
  const container = document.createElement("div");
  container.className = "tree-node";

  const hasChildren = node.children.length > 0 || node.projects.length > 0;
  const isExpanded = expandedFolders.has(node.fullPath);
  const totalProjects = countFolderProjects(node);

  // Folder header
  const folderEl = document.createElement("div");
  folderEl.className = "tree-folder";
  folderEl.style.paddingLeft = `${4 + depth * 8}px`;
  folderEl.draggable = true;

  // Arrow indicator
  const arrowEl = document.createElement("div");
  arrowEl.className = "tree-folder-arrow" + (isExpanded ? " expanded" : "");
  arrowEl.innerHTML = hasChildren ? `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/></svg>` : "";

  const iconEl = document.createElement("div");
  iconEl.className = "tree-folder-icon" + (isExpanded ? " expanded" : "");
  // Folder open/closed SVG icons
  if (isExpanded) {
    iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg>`;
  } else {
    iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;
  }

  const nameEl = document.createElement("div");
  nameEl.className = "tree-folder-name";
  nameEl.textContent = node.name;

  const countEl = document.createElement("div");
  countEl.className = "tree-folder-count";
  countEl.textContent = totalProjects;

  folderEl.appendChild(arrowEl);
  folderEl.appendChild(iconEl);
  folderEl.appendChild(nameEl);
  folderEl.appendChild(countEl);

  container.appendChild(folderEl);

  // Children container (create before click handler so we can reference it)
  let childrenEl = null;
  if (hasChildren) {
    childrenEl = document.createElement("div");
    childrenEl.className = "tree-children" + (isExpanded ? " expanded" : "");

    // Render child folders
    for (const child of node.children) {
      childrenEl.appendChild(createFolderNode(child, depth + 1));
    }

    // Render projects
    for (const project of node.projects) {
      childrenEl.appendChild(createProjectNode(project, depth + 1));
    }

    container.appendChild(childrenEl);
  }

  folderEl.addEventListener("click", () => {
    const nowExpanded = expandedFolders.has(node.fullPath);
    if (nowExpanded) {
      expandedFolders.delete(node.fullPath);
      arrowEl.classList.remove("expanded");
      iconEl.classList.remove("expanded");
      iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;
      if (childrenEl) childrenEl.classList.remove("expanded");
    } else {
      expandedFolders.add(node.fullPath);
      arrowEl.classList.add("expanded");
      iconEl.classList.add("expanded");
      iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg>`;
      if (childrenEl) childrenEl.classList.add("expanded");
    }
    persistExpandedFolders({ immediate: true });
  });

  // Drag events for folder
  folderEl.addEventListener("dragstart", (e) => {
    draggedFolder = node;
    draggedProject = null;
    folderEl.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });

  folderEl.addEventListener("dragend", () => {
    draggedFolder = null;
    folderEl.classList.remove("dragging");
    document.querySelectorAll(".tree-folder.drop-target").forEach(f => f.classList.remove("drop-target"));
  });

  // Drop events for folder (accept both project and folder)
  folderEl.addEventListener("dragover", (e) => {
    if (draggedProject) {
      if (draggedProject.folder === node.fullPath) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      folderEl.classList.add("drop-target");
    } else if (draggedFolder) {
      // Cannot drop folder onto itself or onto a descendant
      if (draggedFolder.fullPath === node.fullPath) return;
      if (node.fullPath && node.fullPath.startsWith(draggedFolder.fullPath + "\\")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      folderEl.classList.add("drop-target");
    }
  });

  folderEl.addEventListener("dragleave", () => {
    folderEl.classList.remove("drop-target");
  });

  folderEl.addEventListener("drop", (e) => {
    e.preventDefault();
    folderEl.classList.remove("drop-target");
    if (draggedProject && draggedProject.folder !== node.fullPath) {
      moveProjectToFolder(draggedProject, node.fullPath);
    } else if (draggedFolder && draggedFolder.fullPath !== node.fullPath && (!node.fullPath || !node.fullPath.startsWith(draggedFolder.fullPath + "\\"))) {
      moveFolderToFolder(draggedFolder, node.fullPath);
    }
  });

  // Right-click: Create subfolder
  folderEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    contextMenuFolder = node;
    contextMenuProject = null;
    hideContextMenu();
    hideTreeContextMenu();
    datasetTypesFeature?.hideDatasetTypesRowContextMenu();
    reservingClassTypesFeature?.hideReservingClassTypesRowContextMenu();
    positionContextMenu(folderContextMenu, e.clientX, e.clientY);
  });

  return container;
}

function countFolderProjects(node) {
  let count = node.projects.length;
  for (const child of node.children) {
    count += countFolderProjects(child);
  }
  return count;
}

function createProjectNode(project, depth) {
  const el = document.createElement("div");
  el.className = "tree-project";
  if (selectedProject && selectedProject.name === project.name) {
    el.classList.add("active");
  }
  el.style.paddingLeft = `${12 + depth * 8}px`;
  el.draggable = true;

  const iconEl = document.createElement("div");
  iconEl.className = "tree-project-icon";
  iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>`;

  const nameEl = document.createElement("div");
  nameEl.className = "tree-project-name";
  nameEl.textContent = project.name;
  nameEl.title = project.name;

  const viewDatasetsBtn = document.createElement("button");
  viewDatasetsBtn.type = "button";
  viewDatasetsBtn.className = "tree-project-action";
  viewDatasetsBtn.title = "View project contents in a new tab";
  viewDatasetsBtn.setAttribute("aria-label", `View project contents in a new tab for ${project.name}`);
  viewDatasetsBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-2"/><path d="M13 4h7v7"/><path d="M11 13l9-9"/></svg>`;
  viewDatasetsBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openProjectInstanceTab(project);
  });

  el.appendChild(iconEl);
  el.appendChild(nameEl);
  el.appendChild(viewDatasetsBtn);

  el.addEventListener("click", () => {
    selectProject(project);
  });

  el.addEventListener("dblclick", () => {
    openProjectInNewTab(project);
  });

  // Drag events
  el.addEventListener("dragstart", (e) => {
    draggedProject = project;
    draggedFolder = null;
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });

  el.addEventListener("dragend", () => {
    draggedProject = null;
    el.classList.remove("dragging");
    // Remove all drop highlights
    document.querySelectorAll(".tree-folder.drop-target").forEach(f => f.classList.remove("drop-target"));
  });

  // Right-click context menu
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    contextMenuProject = project;
    contextMenuFolder = null;
    hideFolderContextMenu();
    hideTreeContextMenu();
    datasetTypesFeature?.hideDatasetTypesRowContextMenu();
    reservingClassTypesFeature?.hideReservingClassTypesRowContextMenu();
    showContextMenu(e.clientX, e.clientY);
  });

  return el;
}

// ============ Project Selection ============
async function selectProject(project) {
  reservingClassTypesFeature?.closeReservingClassTypeEditor();
  dataProcessingRulesFeature?.closeEditor();
  selectedProject = project;
  saveSelectedProjectToSession(project);
  renderTree(); // Update active state
  const selectionKey = normalizeProjectKey(project?.name);
  let preferences = {};
  try {
    preferences = await loadProjectUserPreferences(project?.name, { forceReload: true });
  } catch (err) {
    console.warn("Failed to load Project Settings table defaults:", err);
  }
  if (!selectedProject || normalizeProjectKey(selectedProject.name) !== selectionKey) return;
  applyProjectSettingsTablePreferences(preferences);
  showProjectDetails(project);
  // Update tree header to show the last part of the folder name
  if (treeHeader && project.folder) {
    const parts = project.folder.split("\\");
    treeHeader.textContent = parts[parts.length - 1];
  }
}

function getDirFromPath(filePath) {
  const s = String(filePath || "").trim();
  if (!s) return "";
  const slash = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  if (slash <= 0) return "";
  return s.slice(0, slash);
}

async function pickTablePathFromHost(startDir = "") {
  const hostApi = window.ADAHost
    || window.parent?.ADAHost
    || window.top?.ADAHost;
  if (!hostApi?.pickOpenTableFile) {
    setStatus("Browse is available in the desktop app only.");
    return "";
  }
  try {
    const selected = await hostApi.pickOpenTableFile(startDir || "");
    return String(selected || "");
  } catch {
    return "";
  }
}

async function saveTablePathField(project, nextTablePath) {
  if (!project || !Array.isArray(project._row)) {
    throw new Error("Project row is unavailable.");
  }
  const sheetName = getSheetName();
  if (!sheetName || !projectData || !projectData[sheetName]) {
    throw new Error("Project data is unavailable.");
  }
  const sheet = projectData[sheetName];
  const headers = Array.isArray(sheet.headers) ? sheet.headers : [];
  const tablePathCol = headers.indexOf("Table Path");
  if (tablePathCol < 0) {
    throw new Error('Column "Table Path" was not found.');
  }

  const prevTablePath = String(project._row[tablePathCol] || "");
  const prevProjectTablePath = String(project.tablePath || "");
  const nextValue = String(nextTablePath || "").trim();

  project._row[tablePathCol] = nextValue;
  project.tablePath = nextValue;

  const saved = await saveProjectData(DEFAULT_SOURCE);
  if (!saved) {
    project._row[tablePathCol] = prevTablePath;
    project.tablePath = prevProjectTablePath;
    throw new Error("Save failed.");
  }

  buildTreeData();
  renderTree();
}

function bindSummaryTablePathEditor(project) {
  if (!summaryTablePathInput || !summaryTablePathBrowseBtn || !summaryTablePathReloadBtn) return;

  summaryTablePathInput.value = String(project.tablePath || "");
  summaryTablePathInput.disabled = false;
  summaryTablePathReloadBtn.disabled = false;
  summaryTablePathBrowseBtn.disabled = false;

  let committing = false;
  const setControlsDisabled = (disabled) => {
    summaryTablePathInput.disabled = disabled;
    summaryTablePathReloadBtn.disabled = disabled;
    summaryTablePathBrowseBtn.disabled = disabled;
  };
  const refreshFromSource = async ({ forceRefresh = false } = {}) => {
    return loadTableSummary(project.tablePath, project.name, {
      forceRefresh,
      forceFieldMappingReload: true,
      forceReservingClassTypesReload: true,
    });
  };
  const commitCandidate = async (candidate) => {
    if (committing) return;
    if (!selectedProject || selectedProject.name !== project.name) return;

    const latest = String(project.tablePath || "");
    const nextValue = String(candidate || "").trim();
    if (nextValue === latest) return;

    committing = true;
    let savedTablePath = false;
    setControlsDisabled(true);
    try {
      await saveTablePathField(project, nextValue);
      savedTablePath = true;
      summaryTablePathInput.value = String(project.tablePath || "");
      setStatus("Updated Table Path.");
      const refreshed = await refreshFromSource({ forceRefresh: true });
      if (!refreshed) throw new Error("Unable to reload table summary.");
    } catch (err) {
      summaryTablePathInput.value = savedTablePath ? String(project.tablePath || "") : latest;
      alert(`Failed to update Table Path: ${err.message}`);
      setStatus(`Failed to update Table Path: ${err.message}`);
    } finally {
      if (selectedProject && selectedProject.name === project.name) {
        setControlsDisabled(false);
      }
      committing = false;
    }
  };

  summaryTablePathInput.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      summaryTablePathInput.blur();
    }
  };

  summaryTablePathInput.onblur = async () => {
    await commitCandidate(summaryTablePathInput.value);
  };

  summaryTablePathReloadBtn.onclick = async () => {
    if (!selectedProject || selectedProject.name !== project.name) return;
    if (committing) return;
    committing = true;
    setControlsDisabled(true);
    try {
      setStatus("Reloading table summary...");
      const refreshed = await refreshFromSource({ forceRefresh: true });
      if (!refreshed) throw new Error("Unable to reload table summary.");
      setStatus("Reloaded table summary.");
    } catch (err) {
      alert(`Failed to reload table summary: ${err.message}`);
      setStatus(`Failed to reload table summary: ${err.message}`);
    } finally {
      if (selectedProject && selectedProject.name === project.name) {
        setControlsDisabled(false);
      }
      committing = false;
    }
  };

  summaryTablePathBrowseBtn.onclick = async () => {
    if (!selectedProject || selectedProject.name !== project.name) return;
    if (committing) return;

    const startDir = getDirFromPath(summaryTablePathInput.value) || getDirFromPath(project.tablePath);
    const pickedPath = await pickTablePathFromHost(startDir);
    if (!pickedPath) return;
    summaryTablePathInput.value = pickedPath;
    await commitCandidate(pickedPath);
  };
}

function showProjectDetails(project) {
  detailEmpty.style.display = "none";
  detailView.style.display = "flex";
  detailTitle.textContent = project.name;
  saveSelectedProjectToSession(project);

  // Ensure rename button exists next to title
  let renameBtn = document.getElementById("detailRenameBtn");
  if (!renameBtn) {
    renameBtn = document.createElement("button");
    renameBtn.id = "detailRenameBtn";
    renameBtn.className = "detail-rename-btn";
    renameBtn.title = "Rename project";
    renameBtn.innerHTML = `<svg viewBox="0 0 32 32" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 4 L28 10 L12 26 L4 28 L6 20 Z"/><line x1="19" y1="7" x2="25" y2="13"/></svg>`;
    detailTitle.parentNode.insertBefore(renameBtn, detailTitle.nextSibling);
  }
  renameBtn.onclick = () => renameProject(project);

  // Detail form fields were moved to ribbon panels.
  detailForm.innerHTML = "";
  detailForm.style.display = "none";
  bindSummaryTablePathEditor(project);
  bindSummaryDerivedDateEditor(project);

  // Load table summary from current table path
  loadTableSummary(project.tablePath, project.name);
  datasetTypesFeature?.loadDatasetTypes(project.name);
  reservingClassTypesFeature?.loadReservingClassTypes(project.name);
  dataProcessingRulesFeature?.loadRules(project.name);
  loadAuditLog(project.name);
}

// ============ Table Summary ============
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function setSummaryDerivedDateInputs(values = {}) {
  const originStart = formatBoundaryYmDisplay(values?.originStart || "");
  const originEnd = formatBoundaryYmDisplay(values?.originEnd || "");
  const developmentEnd = formatBoundaryYmDisplay(values?.developmentEnd || "");
  if (summaryOriginStartInput) summaryOriginStartInput.value = originStart;
  if (summaryOriginEndInput) summaryOriginEndInput.value = originEnd;
  if (summaryDevelopmentEndInput) summaryDevelopmentEndInput.value = developmentEnd;
}

function clearSummaryDerivedDateInputs() {
  setSummaryDerivedDateInputs();
}

function normalizeBoundaryIntegerText(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const compact = raw.replace(/,/g, "");
  const m = compact.match(/^(-?\d+)(?:\.0+)?$/);
  if (!m) return raw;
  const intPart = String(m[1] || "");
  const sign = intPart.startsWith("-") ? "-" : "";
  const digits = sign ? intPart.slice(1) : intPart;
  const normalizedDigits = digits.replace(/^0+(?=\d)/, "");
  return sign + normalizedDigits;
}

function normalizeYmParts(yearRaw, monthRaw) {
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isInteger(year) || year < 1) return "";
  if (!Number.isInteger(month) || month < 1 || month > 12) return "";
  return String(year).padStart(4, "0") + String(month).padStart(2, "0");
}

function monthTokenToNumber(token) {
  const key = String(token || "").trim().toLowerCase();
  if (!key) return null;
  const map = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12,
  };
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
}

function normalizeBoundaryYmCanonical(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  const compact = normalizeBoundaryIntegerText(raw);
  let m = compact.match(/^(\d{4})(\d{2})$/);
  if (m) return normalizeYmParts(m[1], m[2]);

  m = raw.match(/^(\d{4})\s*[-/]\s*(\d{1,2})$/);
  if (m) return normalizeYmParts(m[1], m[2]);

  m = raw.match(/^(\d{1,2})\s*[-/]\s*(\d{4})$/);
  if (m) return normalizeYmParts(m[2], m[1]);

  m = raw.match(/^([A-Za-z]{3,9})[\s,/-]+(\d{4})$/);
  if (m) {
    const month = monthTokenToNumber(m[1]);
    if (month != null) return normalizeYmParts(m[2], month);
  }

  m = raw.match(/^(\d{4})[\s,/-]+([A-Za-z]{3,9})$/);
  if (m) {
    const month = monthTokenToNumber(m[2]);
    if (month != null) return normalizeYmParts(m[1], month);
  }

  return "";
}

function formatBoundaryYmDisplay(value) {
  const canonical = normalizeBoundaryYmCanonical(value);
  if (!canonical) return "";
  const year = canonical.slice(0, 4);
  const month = Number(canonical.slice(4, 6));
  if (!Number.isInteger(month) || month < 1 || month > 12) return "";
  return `${MONTH_ABBR[month - 1]} ${year}`;
}

function shiftBoundaryYmCanonical(value, deltaMonths) {
  const canonical = normalizeBoundaryYmCanonical(value);
  if (!canonical) return "";
  const year = Number(canonical.slice(0, 4));
  const month = Number(canonical.slice(4, 6));
  if (!Number.isInteger(year) || !Number.isInteger(month)) return "";
  const idx = (year * 12) + (month - 1) + Number(deltaMonths || 0);
  if (!Number.isFinite(idx)) return "";
  const nextYear = Math.floor(idx / 12);
  const nextMonth = (idx % 12) + 1;
  if (nextYear < 1 || nextMonth < 1 || nextMonth > 12) return canonical;
  return normalizeYmParts(nextYear, nextMonth);
}

function normalizeGeneralSettingsBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "y" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "n" || s === "off") return false;
  return !!fallback;
}

function normalizeGeneralSettingsValues(values = {}) {
  const projectName = String(values?.projectName ?? values?.project_name ?? "").trim();
  const projectFolderName = String(values?.projectFolderName ?? values?.project_folder_name ?? "").trim();
  const inferredMismatch = (
    projectName
    && projectFolderName
    && normalizeProjectKey(projectName) !== normalizeProjectKey(projectFolderName)
  );
  return {
    projectName,
    projectFolderName,
    projectNameMismatch: normalizeGeneralSettingsBool(values?.projectNameMismatch ?? values?.project_name_mismatch, inferredMismatch),
    autoGenerated: normalizeGeneralSettingsBool(values?.autoGenerated ?? values?.auto_generated, false),
    originStartDate: normalizeBoundaryYmCanonical(values?.originStartDate ?? values?.origin_start_date ?? ""),
    originEndDate: normalizeBoundaryYmCanonical(values?.originEndDate ?? values?.origin_end_date ?? ""),
    developmentEndDate: normalizeBoundaryYmCanonical(values?.developmentEndDate ?? values?.development_end_date ?? ""),
  };
}

function getGeneralSettingsCache(projectName) {
  const key = normalizeProjectKey(projectName);
  if (!key) return normalizeGeneralSettingsValues(EMPTY_GENERAL_SETTINGS);
  return normalizeGeneralSettingsValues(generalSettingsByProject.get(key) || EMPTY_GENERAL_SETTINGS);
}

function setGeneralSettingsCache(projectName, values = {}) {
  const key = normalizeProjectKey(projectName);
  if (!key) return normalizeGeneralSettingsValues(EMPTY_GENERAL_SETTINGS);
  const normalized = normalizeGeneralSettingsValues(values);
  generalSettingsByProject.set(key, normalized);
  return normalized;
}

function hasGeneralSettingsValues(values = {}) {
  const v = normalizeGeneralSettingsValues(values);
  return !!(v.originStartDate || v.originEndDate || v.developmentEndDate);
}

function areGeneralSettingsEqual(a = {}, b = {}) {
  const left = normalizeGeneralSettingsValues(a);
  const right = normalizeGeneralSettingsValues(b);
  return (
    left.autoGenerated === right.autoGenerated
    && left.originStartDate === right.originStartDate
    && left.originEndDate === right.originEndDate
    && left.developmentEndDate === right.developmentEndDate
  );
}

function getSummaryDerivedDateInputValues() {
  return normalizeGeneralSettingsValues({
    originStartDate: summaryOriginStartInput?.value || "",
    originEndDate: summaryOriginEndInput?.value || "",
    developmentEndDate: summaryDevelopmentEndInput?.value || "",
  });
}

async function loadGeneralSettingsForProject(projectName, options = {}) {
  const applyToInputs = !!options?.applyToInputs;
  const name = String(projectName || "").trim();
  const empty = normalizeGeneralSettingsValues(EMPTY_GENERAL_SETTINGS);
  if (!name) return empty;

  try {
    const res = await fetch(`/general_settings?project_name=${encodeURIComponent(name)}`);
    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.json();
        detail = String(body?.detail || "").trim();
      } catch {
        const text = await res.text();
        detail = String(text || "").trim();
      }
      throw new Error(detail || `HTTP ${res.status}`);
    }
    const out = await res.json();
    const values = setGeneralSettingsCache(name, normalizeGeneralSettingsValues(out?.data || {}));
    if (applyToInputs && selectedProject && selectedProject.name === name) {
      setSummaryDerivedDateInputs({
        originStart: values.originStartDate,
        originEnd: values.originEndDate,
        developmentEnd: values.developmentEndDate,
      });
    }
    return values;
  } catch (err) {
    setStatus(`Failed to load General Settings: ${err.message}`);
    const values = setGeneralSettingsCache(name, empty);
    if (applyToInputs && selectedProject && selectedProject.name === name) {
      setSummaryDerivedDateInputs({
        originStart: values.originStartDate,
        originEnd: values.originEndDate,
        developmentEnd: values.developmentEndDate,
      });
    }
    return values;
  }
}

async function ensureGeneralSettingsLoaded(projectName, options = {}) {
  const applyToInputs = !!options?.applyToInputs;
  const name = String(projectName || "").trim();
  if (!name) return normalizeGeneralSettingsValues(EMPTY_GENERAL_SETTINGS);
  const key = normalizeProjectKey(name);
  if (generalSettingsByProject.has(key)) {
    const values = getGeneralSettingsCache(name);
    if (applyToInputs && selectedProject && selectedProject.name === name) {
      setSummaryDerivedDateInputs({
        originStart: values.originStartDate,
        originEnd: values.originEndDate,
        developmentEnd: values.developmentEndDate,
      });
    }
    return values;
  }
  return loadGeneralSettingsForProject(name, { applyToInputs });
}

async function saveGeneralSettingsForProject(projectName, values = {}, options = {}) {
  const force = !!options?.force;
  const interactive = !!options?.interactive;
  const autoGenerated = normalizeGeneralSettingsBool(options?.autoGenerated, false);
  const name = String(projectName || "").trim();
  if (!name) return { ok: false, data: normalizeGeneralSettingsValues(EMPTY_GENERAL_SETTINGS) };

  const normalized = normalizeGeneralSettingsValues({ ...values, autoGenerated });
  const cached = getGeneralSettingsCache(name);
  if (!force && areGeneralSettingsEqual(cached, normalized)) {
    return { ok: true, skipped: true, data: cached };
  }

  try {
    const res = await fetch("/general_settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: name,
        origin_start_date: normalized.originStartDate,
        origin_end_date: normalized.originEndDate,
        development_end_date: normalized.developmentEndDate,
        auto_generated: normalized.autoGenerated,
      }),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.json();
        detail = String(body?.detail || "").trim();
      } catch {
        const text = await res.text();
        detail = String(text || "").trim();
      }
      throw new Error(detail || `HTTP ${res.status}`);
    }
    const out = await res.json();
    const saved = setGeneralSettingsCache(name, normalizeGeneralSettingsValues(out?.data || normalized));
    return { ok: true, data: saved };
  } catch (err) {
    setStatus(`Failed to save General Settings: ${err.message}`);
    if (interactive) {
      alert(`Failed to save General Settings: ${err.message}`);
    }
    return { ok: false, data: normalized };
  }
}

function bindSummaryDerivedDateEditor(project) {
  const controls = [
    { key: "originStartDate", input: summaryOriginStartInput, upBtn: summaryOriginStartUpBtn, downBtn: summaryOriginStartDownBtn },
    { key: "originEndDate", input: summaryOriginEndInput, upBtn: summaryOriginEndUpBtn, downBtn: summaryOriginEndDownBtn },
    { key: "developmentEndDate", input: summaryDevelopmentEndInput, upBtn: summaryDevelopmentEndUpBtn, downBtn: summaryDevelopmentEndDownBtn },
  ].filter((x) => !!x.input);
  if (controls.length === 0 || !project?.name) return;

  let committing = false;
  const commitCurrentValues = async () => {
    if (committing) return;
    if (!selectedProject || selectedProject.name !== project.name) return;
    committing = true;
    try {
      const values = getSummaryDerivedDateInputValues();
      const cached = getGeneralSettingsCache(project.name);
      const changed = !areGeneralSettingsEqual(
        { ...cached, autoGenerated: false },
        { ...values, autoGenerated: false },
      );
      if (!changed) return;
      const out = await saveGeneralSettingsForProject(project.name, values, { autoGenerated: false });
      if (out.ok) {
        setGeneralSettingsCache(project.name, out.data || values);
      }
    } finally {
      committing = false;
    }
  };

  const getDateInputSelectedPart = (input) => {
    const saved = String(input?.dataset?.selectedPart || "").trim().toLowerCase();
    if (saved === "month" || saved === "year") return saved;
    const start = Number(input?.selectionStart);
    if (Number.isInteger(start) && start >= 4) return "year";
    return "month";
  };

  const selectDateInputPart = (input, part) => {
    if (!input) return;
    const p = part === "year" ? "year" : "month";
    input.dataset.selectedPart = p;
    const canonical = normalizeBoundaryYmCanonical(input.value);
    if (!canonical) return;
    const start = p === "year" ? 4 : 0;
    const end = p === "year" ? 8 : 3;
    try {
      input.setSelectionRange(start, end);
    } catch {
      // ignore selection failures in non-focus state
    }
  };

  const adjustDateInputBySelectedPart = (input, fallbackCanonical, delta) => {
    const base = normalizeBoundaryYmCanonical(input.value) || normalizeBoundaryYmCanonical(fallbackCanonical);
    if (!base) return "";
    const part = getDateInputSelectedPart(input);
    const monthDelta = part === "year" ? (Number(delta || 0) * 12) : Number(delta || 0);
    const shifted = shiftBoundaryYmCanonical(base, monthDelta);
    if (!shifted) return "";
    input.value = formatBoundaryYmDisplay(shifted);
    selectDateInputPart(input, part);
    return shifted;
  };

  for (const control of controls) {
    const input = control.input;
    const getFallbackCanonical = () => {
      const cached = getGeneralSettingsCache(project.name);
      return normalizeBoundaryYmCanonical(cached?.[control.key] || "");
    };

    const normalizeInputDisplay = () => {
      const canonical = normalizeBoundaryYmCanonical(input.value) || getFallbackCanonical();
      const part = getDateInputSelectedPart(input);
      input.value = formatBoundaryYmDisplay(canonical);
      if (canonical) selectDateInputPart(input, part);
      return canonical;
    };

    input.disabled = false;
    input.onfocus = () => {
      if (!input.value) return;
      selectDateInputPart(input, getDateInputSelectedPart(input));
    };
    input.onclick = () => {
      setTimeout(() => {
        const caret = Number(input.selectionStart);
        const part = Number.isInteger(caret) && caret >= 4 ? "year" : "month";
        selectDateInputPart(input, part);
      }, 0);
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
    };
    input.onwheel = (e) => {
      if (!selectedProject || selectedProject.name !== project.name) return;
      const delta = e.deltaY < 0 ? 1 : -1;
      if (!delta) return;
      const changed = adjustDateInputBySelectedPart(input, getFallbackCanonical(), delta);
      if (!changed) return;
      e.preventDefault();
      commitCurrentValues();
    };
    input.onblur = () => {
      normalizeInputDisplay();
      commitCurrentValues();
    };

    if (control.upBtn) {
      control.upBtn.disabled = false;
      control.upBtn.onmousedown = (e) => e.preventDefault();
      control.upBtn.onclick = () => {
        if (!selectedProject || selectedProject.name !== project.name) return;
        const changed = adjustDateInputBySelectedPart(input, getFallbackCanonical(), 1);
        if (!changed) return;
        if (document.activeElement !== input) input.focus();
        commitCurrentValues();
      };
    }
    if (control.downBtn) {
      control.downBtn.disabled = false;
      control.downBtn.onmousedown = (e) => e.preventDefault();
      control.downBtn.onclick = () => {
        if (!selectedProject || selectedProject.name !== project.name) return;
        const changed = adjustDateInputBySelectedPart(input, getFallbackCanonical(), -1);
        if (!changed) return;
        if (document.activeElement !== input) input.focus();
        commitCurrentValues();
      };
    }
  }
}

function normalizeSummaryColumnKey(value) {
  return String(value || "").trim().toLowerCase();
}

function findSummaryColumnByName(summaryColumns, fieldName) {
  const key = normalizeSummaryColumnKey(fieldName);
  if (!key) return null;
  for (const column of Array.isArray(summaryColumns) ? summaryColumns : []) {
    const name = normalizeSummaryColumnKey(column?.name);
    if (name && name === key) return column;
  }
  return null;
}

function extractRangeBoundsFromSummary(column) {
  const values = String(column?.values || "").trim();
  if (!values) return { min: "", max: "" };

  const m = values.match(/^range:\s*(.+)$/i);
  if (!m) return { min: "", max: "" };
  const range = String(m[1] || "").trim();
  if (!range) return { min: "", max: "" };

  const dtype = String(column?.dtype || "").toLowerCase();
  const friendlyType = String(column?.type || "").toLowerCase();
  if (friendlyType === "datetime" || dtype.includes("datetime")) {
    const sep = " - ";
    const idx = range.indexOf(sep);
    if (idx > 0) {
      return {
        min: range.slice(0, idx).trim(),
        max: range.slice(idx + sep.length).trim(),
      };
    }
  }

  const numericMatches = range.match(/-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?/g);
  if (Array.isArray(numericMatches) && numericMatches.length >= 2) {
    return {
      min: String(numericMatches[0] || "").trim(),
      max: String(numericMatches[numericMatches.length - 1] || "").trim(),
    };
  }
  return { min: "", max: "" };
}

async function fetchMappedDateFields(projectName) {
  const result = { originField: "", developmentField: "" };
  const name = String(projectName || "").trim();
  if (!name) return result;

  try {
    const res = await fetch(`/field_mapping?project_name=${encodeURIComponent(name)}`);
    if (!res.ok) return result;
    const out = await res.json();
    const rows = Array.isArray(out?.data?.rows) ? out.data.rows : [];

    for (const row of rows) {
      const significance = String(row?.significance || "").trim();
      const fieldName = String(row?.field_name || "").trim();
      if (!fieldName) continue;
      if (significance === "Origin Date" && !result.originField) result.originField = fieldName;
      if (significance === "Development Date" && !result.developmentField) result.developmentField = fieldName;
      if (result.originField && result.developmentField) break;
    }
  } catch {
    // Ignore mapping load failures here; field mapping panel has its own explicit errors.
  }
  return result;
}

function deriveSummaryDateInputs(summaryColumns, mappedDateFields) {
  const originCol = findSummaryColumnByName(summaryColumns, mappedDateFields?.originField);
  const developmentCol = findSummaryColumnByName(summaryColumns, mappedDateFields?.developmentField);
  const originRange = extractRangeBoundsFromSummary(originCol);
  const developmentRange = extractRangeBoundsFromSummary(developmentCol);
  return {
    originStart: originRange.min || "",
    originEnd: originRange.max || "",
    developmentEnd: developmentRange.max || "",
  };
}

async function clearArcRhoHeadersCacheForProject(projectName) {
  const name = String(projectName || "").trim();
  if (!name) return { ok: true, cleared_count: 0 };
  try {
    const res = await fetch("/arcrho/headers/cache/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ProjectName: name }),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const out = await res.json();
        detail = String(out?.detail || "").trim();
      } catch {
        const text = await res.text();
        detail = String(text || "").trim();
      }
      throw new Error(detail || `HTTP ${res.status}`);
    }
    return res.json();
  } catch (err) {
    setStatus(`Warning: failed to clear ArcRhoHeaders cache for "${name}": ${err.message}`);
    return { ok: false, error: String(err.message || err) };
  }
}

async function clearGeneratedDatasetCsvCachesForProject(projectName) {
  const name = String(projectName || "").trim();
  if (!name) return { ok: true, cleared_count: 0, preserved_count: 0 };
  try {
    const res = await fetch(`/project_settings/${DEFAULT_SOURCE}/generated_dataset_cache/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: name }),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const out = await res.json();
        detail = String(out?.detail || "").trim();
      } catch {
        const text = await res.text();
        detail = String(text || "").trim();
      }
      throw new Error(detail || `HTTP ${res.status}`);
    }
    return res.json();
  } catch (err) {
    setStatus(`Warning: failed to clear generated dataset caches for "${name}": ${err.message}`);
    return { ok: false, error: String(err.message || err), cleared_count: 0, preserved_count: 0 };
  }
}

async function loadTableSummary(tablePath, projectName = "", options = {}) {
  const forceRefresh = !!options?.forceRefresh;
  const forceFieldMappingReload = !!options?.forceFieldMappingReload;
  const forceReservingClassTypesReload = !!options?.forceReservingClassTypesReload;
  const summaryEl = document.getElementById("tableSummary");
  const statsEl = document.getElementById("summaryStats");
  const columnsEl = document.getElementById("summaryColumns");
  const requestSeq = ++tableSummaryLoadSeq;

  if (!tablePath) {
    summaryEl.style.display = "flex";
    statsEl.innerHTML = '<div class="summary-loading">No Table Path is configured for this project.</div>';
    columnsEl.innerHTML = "";
    const existingGeneralSettings = await ensureGeneralSettingsLoaded(projectName, { applyToInputs: false });
    if (requestSeq !== tableSummaryLoadSeq) return true;
    setSummaryDerivedDateInputs({
      originStart: existingGeneralSettings.originStartDate,
      originEnd: existingGeneralSettings.originEndDate,
      developmentEnd: existingGeneralSettings.developmentEndDate,
    });
    currentFieldNames = [];
    fieldMappingFeature?.renderFieldMappingEmpty("No Table Path is configured for this project.");
    fieldMappingFeature?.setFieldMappingStatus("");
    if (forceReservingClassTypesReload) {
      await reservingClassTypesFeature?.loadReservingClassTypes(projectName, { force: true });
    }
    return true;
  }

  summaryEl.style.display = "flex";
  statsEl.innerHTML = '<div class="summary-loading">Loading table summary...</div>';
  columnsEl.innerHTML = "";

  try {
    if (forceRefresh && projectName) {
      await clearArcRhoHeadersCacheForProject(projectName);
      const generatedCacheClear = await clearGeneratedDatasetCsvCachesForProject(projectName);
      if (generatedCacheClear?.ok && Number(generatedCacheClear.cleared_count || 0) > 0) {
        setStatus(`Cleared ${generatedCacheClear.cleared_count} generated dataset cache file(s).`);
      }
      if (requestSeq !== tableSummaryLoadSeq) return true;
    }

    let res = null;
    if (forceRefresh) {
      res = await fetch("/table_summary/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: tablePath,
          project_name: projectName || "",
          refresh_reserving: true,
        }),
      });
    } else {
      const q = new URLSearchParams({
        path: tablePath,
        project_name: projectName || ""
      });
      res = await fetch(`/table_summary?${q.toString()}`);
    }
    if (!res.ok) {
      let detail = "";
      try {
        const out = await res.json();
        detail = String(out?.detail || "").trim();
      } catch {
        const text = await res.text();
        detail = String(text || "").trim();
      }
      throw new Error(detail || `HTTP ${res.status}`);
    }

    const data = await res.json();
    if (requestSeq !== tableSummaryLoadSeq) return true;

    // Render stats
    statsEl.innerHTML = `
      <div class="stat-item">
        <div class="stat-label">Rows</div>
        <div class="stat-value">${data.row_count.toLocaleString()}</div>
      </div>
      <div class="stat-item">
        <div class="stat-label">Columns</div>
        <div class="stat-value">${data.column_count}</div>
      </div>
      <div class="stat-item">
        <div class="stat-label">File Size</div>
        <div class="stat-value">${data.file_size_str}</div>
      </div>
    `;

    // Render columns table
    let colHtml = `
      <table class="columns-table" id="summaryColumnsTable">
        <colgroup>
          <col style="width: 260px;">
          <col style="width: 120px;">
          <col style="width: 520px;">
        </colgroup>
        <thead>
          <tr>
            <th>Column Name</th>
            <th>Data Type</th>
            <th>Values</th>
          </tr>
        </thead>
        <tbody>
    `;

    for (const col of data.columns) {
      colHtml += `
        <tr>
          <td class="col-name">${escapeHtml(col.name)}</td>
          <td class="col-type">${col.type}</td>
          <td class="col-sample" title="${escapeHtml(col.values)}">${escapeHtml(col.values)}</td>
        </tr>
      `;
    }

    colHtml += "</tbody></table>";
    columnsEl.innerHTML = colHtml;
    initTableColumnResizing("summaryColumnsTable", [120, 80, 160]);

    currentFieldNames = Array.isArray(data.columns)
      ? data.columns.map(col => String(col?.name || "").trim()).filter(Boolean)
      : [];
    const existingGeneralSettings = await ensureGeneralSettingsLoaded(projectName, { applyToInputs: false });
    if (requestSeq !== tableSummaryLoadSeq) return true;
    const mappedDateFields = await fetchMappedDateFields(projectName);
    if (requestSeq !== tableSummaryLoadSeq) return true;
    const derivedValues = deriveSummaryDateInputs(data.columns, mappedDateFields);
    const shouldApplyDerived = (
      !!existingGeneralSettings.projectNameMismatch
      || !hasGeneralSettingsValues(existingGeneralSettings)
      || (forceRefresh && !!existingGeneralSettings.autoGenerated)
    );
    if (shouldApplyDerived) {
      setSummaryDerivedDateInputs(derivedValues);
      await saveGeneralSettingsForProject(
        projectName,
        {
          originStartDate: derivedValues.originStart || "",
          originEndDate: derivedValues.originEnd || "",
          developmentEndDate: derivedValues.developmentEnd || "",
        },
        {
          autoGenerated: true,
          force: !!existingGeneralSettings.projectNameMismatch,
        },
      );
    } else {
      setSummaryDerivedDateInputs({
        originStart: existingGeneralSettings.originStartDate,
        originEnd: existingGeneralSettings.originEndDate,
        developmentEnd: existingGeneralSettings.developmentEndDate,
      });
    }
    if (requestSeq !== tableSummaryLoadSeq) return true;
    await fieldMappingFeature?.ensureFieldMappingLoaded(projectName, {
      force: forceRefresh || forceFieldMappingReload,
    });
    if (requestSeq !== tableSummaryLoadSeq) return true;
    fieldMappingFeature?.renderFieldMappingTable(currentFieldNames, projectName);
    fieldMappingFeature?.setFieldMappingStatus("");
    if (forceReservingClassTypesReload) {
      await reservingClassTypesFeature?.loadReservingClassTypes(projectName, { force: true });
    }
    return true;

  } catch (err) {
    if (requestSeq !== tableSummaryLoadSeq) return true;
    statsEl.innerHTML = `<div class="summary-error">Error: ${escapeHtml(err.message)}</div>`;
    columnsEl.innerHTML = "";
    const existingGeneralSettings = await ensureGeneralSettingsLoaded(projectName, { applyToInputs: false });
    if (requestSeq !== tableSummaryLoadSeq) return true;
    setSummaryDerivedDateInputs({
      originStart: existingGeneralSettings.originStartDate,
      originEnd: existingGeneralSettings.originEndDate,
      developmentEnd: existingGeneralSettings.developmentEndDate,
    });
    currentFieldNames = [];
    fieldMappingFeature?.renderFieldMappingEmpty("Unable to load fields from Table Summary.");
    fieldMappingFeature?.setFieldMappingStatus(err.message || "Unable to load table summary.", true);
    return false;
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ============ Open in New Tab ============
function openProjectInNewTab(project) {
  // Send message to parent to open project in new tab
  window.parent.postMessage({
    type: "arcrho:open-project",
    project: {
      name: project.name,
      tablePath: project.tablePath,
      folder: project.folder
    }
  }, "*");

  setStatus(`Opening: ${project.name}`);
}

function openProjectInstanceTab(project) {
  window.parent.postMessage({
    type: "arcrho:open-project-instance",
    project: {
      name: project.name,
      tablePath: project.tablePath,
      folder: project.folder,
    },
  }, "*");

  setStatus(`Opening datasets: ${project.name}`);
}

async function openProjectFolderInExplorer(project) {
  const projectName = String(project?.name || "").trim();
  if (!projectName) {
    setStatus("Select a project first.");
    return;
  }

  if (openProjectFolderBtn) openProjectFolderBtn.disabled = true;
  setStatus(`Opening project folder: ${projectName}`);
  try {
    const res = await fetch(`/project_settings/${DEFAULT_SOURCE}/open_project_folder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: projectName }),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.json();
        detail = String(body?.detail || "").trim();
      } catch {
        const text = await res.text();
        detail = String(text || "").trim();
      }
      throw new Error(detail || `HTTP ${res.status}`);
    }
    const out = await res.json();
    const path = String(out?.path || "").trim();
    setStatus(path ? `Opened project folder: ${path}` : `Opened project folder: ${projectName}`);
  } catch (err) {
    const msg = err?.message || "Unable to open project folder.";
    alert(`Failed to open project folder: ${msg}`);
    setStatus(`Failed to open project folder: ${msg}`);
  } finally {
    if (openProjectFolderBtn) openProjectFolderBtn.disabled = false;
  }
}

// ============ Resize Handle ============
let isResizing = false;

resizeHandle.addEventListener("mousedown", (e) => {
  isResizing = true;
  document.body.style.cursor = "col-resize";
  e.preventDefault();
});

document.addEventListener("mousemove", (e) => {
  if (!isResizing) return;
  const newWidth = e.clientX;
  if (newWidth >= 200 && newWidth <= 500) {
    treePanel.style.width = `${newWidth}px`;
  }
});

document.addEventListener("mouseup", () => {
  if (isResizing) {
    isResizing = false;
    document.body.style.cursor = "";
  }
});

// ============ Event Handlers ============
openInTabBtn?.addEventListener("click", () => {
  if (selectedProject) {
    openProjectInNewTab(selectedProject);
  }
});

openProjectFolderBtn?.addEventListener("click", async () => {
  if (!selectedProject) return;
  await openProjectFolderInExplorer(selectedProject);
});

saveFieldMappingBtn?.addEventListener("click", () => {
  if (!selectedProject) {
    fieldMappingFeature?.setFieldMappingStatus("Select a project first.", true);
    return;
  }
  fieldMappingFeature?.saveFieldMapping(selectedProject);
});

// ============ Move Project to Folder ============
async function moveProjectToFolder(project, newFolder) {
  const oldFolder = project.folder;
  if (oldFolder === newFolder) return;
  setProjectFolderInStructure(project.name, newFolder);
  project.folder = normalizeTreePath(newFolder) || "Uncategorized";

  // Rebuild tree and re-render
  buildTreeData();
  renderTree();
  
  // Update selected project if it was moved
  if (selectedProject && selectedProject.name === project.name) {
    selectedProject = project;
    showProjectDetails(project);
  }

  // Auto-save
  setStatus(`Moving "${project.name}" to "${newFolder}"...`);
  const saved = await saveProjectData(DEFAULT_SOURCE);
  if (saved) {
    const fromFolder = normalizeTreePath(oldFolder) || "Uncategorized";
    const toFolder = normalizeTreePath(newFolder) || "Uncategorized";
    await appendAuditLogAction(project.name, `Moved project folder: "${fromFolder}" -> "${toFolder}"`);
  }
}

// ============ Custom Prompt Dialog ============
let dialogResolve = null;

function showDialog(title, defaultValue = "") {
  return new Promise((resolve) => {
    dialogResolve = resolve;
    dialogTitle.textContent = title;
    dialogInput.value = defaultValue;
    dialogInput.removeAttribute("readonly");
    dialogInput.removeAttribute("disabled");
    dialogOverlay.classList.add("show");
    // Defer focus so the dialog is painted and context menu / other UI has released focus (fixes Electron/iframe)
    setTimeout(() => {
      dialogInput.focus();
      dialogInput.select();
    }, 50);
  });
}

function hideDialog(result) {
  dialogOverlay.classList.remove("show");
  if (dialogResolve) {
    dialogResolve(result);
    dialogResolve = null;
  }
}

dialogOk.addEventListener("click", () => {
  hideDialog(dialogInput.value.trim());
});

dialogCancel.addEventListener("click", () => {
  hideDialog(null);
});

dialogInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    hideDialog(dialogInput.value.trim());
  } else if (e.key === "Escape") {
    hideDialog(null);
  }
});

// Keep focus inside dialog: stop events from bubbling to parent (helps in Electron/iframe)
const dialogBox = document.getElementById("dialogBox");
dialogOverlay.addEventListener("mousedown", (e) => {
  if (dialogBox.contains(e.target)) {
    e.stopPropagation();
  }
});
dialogOverlay.addEventListener("click", (e) => {
  if (dialogBox.contains(e.target)) {
    e.stopPropagation();
  }
});

// ============ Custom Confirm Dialog ============
let confirmResolve = null;

function showConfirm(message, title = "Confirm") {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    confirmTitle.textContent = title;
    confirmMessage.textContent = message;
    confirmOverlay.classList.add("show");
    setTimeout(() => confirmOk.focus(), 50);
  });
}

function hideConfirm(result) {
  confirmOverlay.classList.remove("show");
  if (confirmResolve) {
    confirmResolve(result);
    confirmResolve = null;
  }
}

confirmOk.addEventListener("click", () => hideConfirm(true));
confirmCancel.addEventListener("click", () => hideConfirm(false));
confirmOverlay.addEventListener("keydown", (e) => {
  if (e.key === "Enter") hideConfirm(true);
  else if (e.key === "Escape") hideConfirm(false);
});
confirmOverlay.addEventListener("mousedown", (e) => {
  if (confirmBox.contains(e.target)) e.stopPropagation();
});
confirmOverlay.addEventListener("click", (e) => {
  if (confirmBox.contains(e.target)) e.stopPropagation();
});

// ============ Context Menu ============
function positionContextMenu(menu, x, y) {
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.classList.add("show");
  // Adjust if overflowing viewport
  const rect = menu.getBoundingClientRect();
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${Math.max(0, y - (rect.bottom - window.innerHeight))}px`;
  }
  if (rect.right > window.innerWidth) {
    menu.style.left = `${Math.max(0, x - (rect.right - window.innerWidth))}px`;
  }
}

function showContextMenu(x, y) {
  positionContextMenu(contextMenu, x, y);
}

function hideContextMenu() {
  contextMenu.classList.remove("show");
  contextMenuProject = null;
}

function hideFolderContextMenu() {
  folderContextMenu.classList.remove("show");
  contextMenuFolder = null;
}

function hideTreeContextMenu() {
  treeContextMenu.classList.remove("show");
}

// Hide context menus on click outside
document.addEventListener("click", (e) => {
  if (!contextMenu.contains(e.target)) hideContextMenu();
  if (!folderContextMenu.contains(e.target)) hideFolderContextMenu();
  if (!treeContextMenu.contains(e.target)) hideTreeContextMenu();
  if (!datasetTypesRowContextMenu?.contains(e.target)) datasetTypesFeature?.hideDatasetTypesRowContextMenu();
  if (!reservingClassTypesRowContextMenu?.contains(e.target)) reservingClassTypesFeature?.hideReservingClassTypesRowContextMenu();
});

// Right-click on tree blank area: Create root folder
treeContent.addEventListener("contextmenu", (e) => {
  // Only when clicking on blank area (not on a folder or project)
  if (e.target.closest(".tree-folder") || e.target.closest(".tree-project")) return;
  if (!treeContent.contains(e.target)) return;
  e.preventDefault();
  contextMenuFolder = null;
  contextMenuProject = null;
  hideContextMenu();
  hideFolderContextMenu();
  datasetTypesFeature?.hideDatasetTypesRowContextMenu();
  reservingClassTypesFeature?.hideReservingClassTypesRowContextMenu();
  positionContextMenu(treeContextMenu, e.clientX, e.clientY);
});

// Context menu actions (projects)
contextMenu.addEventListener("click", (e) => {
  const action = e.target.dataset.action;
  if (!action || !contextMenuProject) return;
  
  const project = contextMenuProject;
  hideContextMenu();
  
  if (action === "rename") {
    renameProject(project);
  } else if (action === "duplicate") {
    duplicateProject(project);
  } else if (action === "delete") {
    deleteProject(project);
  }
});

// Folder context menu: Rename, Create New Project, Create subfolder, Delete
folderContextMenu.addEventListener("click", (e) => {
  const action = e.target.dataset.action;
  if (!action || !contextMenuFolder) return;
  const folderNode = contextMenuFolder;
  hideFolderContextMenu();
  if (action === "rename-folder") {
    renameFolder(folderNode);
  } else if (action === "create-project-in-folder") {
    createProjectInFolder(folderNode);
  } else if (action === "create-subfolder") {
    createSubfolder(folderNode);
  } else if (action === "delete-folder") {
    deleteFolder(folderNode);
  }
});

// Tree context menu: Create root folder
treeContextMenu.addEventListener("click", (e) => {
  if (e.target.dataset.action !== "create-root-folder") return;
  hideTreeContextMenu();
  createRootFolder();
});

datasetTypesRowContextMenu?.addEventListener("click", (e) => {
  const action = e.target?.dataset?.action;
  if (!action) return;
  datasetTypesFeature?.handleDatasetTypesRowContextAction(action);
});

datasetTypeEditorClose?.addEventListener("click", () => {
  datasetTypesFeature?.closeDatasetTypeEditor();
});

dtEditorCancelBtn?.addEventListener("click", () => {
  datasetTypesFeature?.closeDatasetTypeEditor();
});

dtEditorSaveBtn?.addEventListener("click", () => {
  datasetTypesFeature?.applyDatasetTypeEditor();
});

datasetTypeEditorHeader?.addEventListener("mousedown", (e) => {
  datasetTypesFeature?.onEditorHeaderMouseDown(e);
});

dtEditCalculated?.addEventListener("change", () => {
  datasetTypesFeature?.handleDatasetTypeEditorCalculatedToggle();
});

reservingClassTypesRowContextMenu?.addEventListener("click", (e) => {
  const action = e.target?.dataset?.action;
  if (!action) return;
  reservingClassTypesFeature?.handleReservingClassTypesRowContextAction(action);
});

reservingClassTypeEditorClose?.addEventListener("click", () => {
  reservingClassTypesFeature?.closeReservingClassTypeEditor();
});

rctEditorCancelBtn?.addEventListener("click", () => {
  reservingClassTypesFeature?.closeReservingClassTypeEditor();
});

rctEditorSaveBtn?.addEventListener("click", () => {
  reservingClassTypesFeature?.applyReservingClassTypeEditor();
});

reservingClassTypeEditorHeader?.addEventListener("mousedown", (e) => {
  reservingClassTypesFeature?.onEditorHeaderMouseDown(e);
});

document.addEventListener("mousemove", (e) => {
  reservingClassTypesFeature?.onEditorMouseMove(e);
  datasetTypesFeature?.onEditorMouseMove(e);
});

document.addEventListener("mouseup", () => {
  reservingClassTypesFeature?.onEditorMouseUp();
  datasetTypesFeature?.onEditorMouseUp();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (datasetTypeEditor?.classList.contains("show")) {
      datasetTypesFeature?.closeDatasetTypeEditor();
    }
  }
});

function buildEmptyProjectRow(headers, projectName) {
  const cols = Array.isArray(headers) ? headers.length : 0;
  const row = new Array(cols).fill("");
  const nameIdx = Array.isArray(headers) ? headers.indexOf("Project Name") : -1;
  if (nameIdx >= 0) {
    row[nameIdx] = String(projectName || "").trim();
  }
  return row;
}

function ensureFolderPathInList(foldersList, folderPath) {
  const normalized = normalizeTreePath(folderPath);
  if (!normalized || !Array.isArray(foldersList)) return;
  const parts = normalized.split("\\").filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    const nextPath = parts.slice(0, i).join("\\");
    if (!foldersList.some((p) => pathEqualsCI(p, nextPath))) {
      foldersList.push(nextPath);
    }
  }
}

async function updateCurrentMtimeFromResponse(response) {
  try {
    const result = await response.json();
    const nextMtime = Number(result?.mtime);
    if (Number.isFinite(nextMtime)) {
      currentMtime = nextMtime;
    }
    return result;
  } catch {
    return null;
  }
}

async function createProjectInFolder(folderNode) {
  const targetFolderPath = normalizeTreePath(folderNode?.fullPath) || "Uncategorized";
  const enteredName = await showDialog("Enter new project name:", "");
  if (!enteredName) return;
  const newProjectName = enteredName.trim();
  if (!newProjectName) return;

  const sheetName = getSheetName();
  const sheet = projectData?.[sheetName];
  const headers = Array.isArray(sheet?.headers) ? sheet.headers : [];
  const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];
  const nameIdx = headers.indexOf("Project Name");
  if (nameIdx === -1) {
    const msg = "Error: Project Name column not found";
    setStatus(msg);
    alert(msg);
    return;
  }

  const alreadyExists = rows.some((row) =>
    String((row && row[nameIdx]) || "").trim().toLowerCase() === newProjectName.toLowerCase()
  );
  if (alreadyExists) {
    const msg = `Project "${newProjectName}" already exists.`;
    setStatus(msg);
    alert(msg);
    return;
  }

  const newRow = buildEmptyProjectRow(headers, newProjectName);
  let folderCreated = false;
  let folderStructureSaved = false;
  const foldersBefore = Array.isArray(projectData?.customFolders) ? [...projectData.customFolders] : [];
  const projectPathsBefore = Array.isArray(projectData?.projectPaths) ? [...projectData.projectPaths] : [];

  setStatus(`Creating "${newProjectName}"...`);

  try {
    // 1) Create project folder on disk first so later saves do not create orphan map entries.
    const createFolderRes = await fetch(`/project_settings/${DEFAULT_SOURCE}/create_project_folder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newProjectName })
    });
    if (!createFolderRes.ok) {
      const errText = await createFolderRes.text();
      throw new Error(`Folder create failed: ${errText}`);
    }
    await createFolderRes.json();
    folderCreated = true;

    // 2) Save folder structure with the new project path.
    const foldersNext = [...foldersBefore];
    const projectPathsNext = [...projectPathsBefore];
    ensureFolderPathInList(foldersNext, targetFolderPath);
    const newFullPath = joinProjectTreePath(targetFolderPath || "Uncategorized", newProjectName);
    if (!projectPathsNext.some((p) => pathEqualsCI(p, newFullPath))) {
      projectPathsNext.push(newFullPath);
    }

    const folderSaveRes = await fetch(`/project_settings/${DEFAULT_SOURCE}/folders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folders: foldersNext, project_paths: projectPathsNext })
    });
    if (!folderSaveRes.ok) {
      const errText = await folderSaveRes.text();
      throw new Error(`Folder structure save failed: ${errText}`);
    }
    await updateCurrentMtimeFromResponse(folderSaveRes);
    folderStructureSaved = true;

    // 3) Save new empty project row to settings JSON.
    const dataToSave = { ...projectData };
    const currentSheet = dataToSave[sheetName] || {};
    const currentRows = Array.isArray(currentSheet.rows)
      ? currentSheet.rows.map((row) => (Array.isArray(row) ? [...row] : row))
      : [];
    currentRows.push(newRow);
    dataToSave[sheetName] = { ...currentSheet, rows: currentRows };
    delete dataToSave.customFolders;
    delete dataToSave.projectPaths;
    removeObsoleteProjectMapColumns(dataToSave);

    const saveRes = await fetch(`/project_settings/${DEFAULT_SOURCE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: dataToSave,
        file_mtime: currentMtime
      })
    });

    if (saveRes.status === 409) {
      throw new Error("File was modified by another user. Please refresh and try again.");
    }
    if (saveRes.status === 423) {
      throw new Error("File is locked. Another user may have it open.");
    }
    if (!saveRes.ok) {
      const errText = await saveRes.text();
      throw new Error(`Save failed: HTTP ${saveRes.status}: ${errText}`);
    }

    const saveResult = await saveRes.json();
    currentMtime = saveResult.mtime;

    // 4) Commit in-memory/UI after the app server succeeds.
    sheet.rows.push(newRow);
    projectData.customFolders = foldersNext;
    projectData.projectPaths = projectPathsNext;
    expandedFolders.add(targetFolderPath);
    buildTreeData();
    renderTree();

    const createdProject = findProjectBySnapshot({ name: newProjectName, folder: targetFolderPath });
    if (createdProject) {
      selectProject(createdProject);
    }

    setStatus(`Created project "${newProjectName}"`);
    await appendAuditLogAction(newProjectName, `Created empty project in folder "${targetFolderPath}"`);
  } catch (e) {
    let rollbackError = "";
    if (folderStructureSaved) {
      try {
        const rollbackFsRes = await fetch(`/project_settings/${DEFAULT_SOURCE}/folders`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folders: foldersBefore, project_paths: projectPathsBefore })
        });
        if (!rollbackFsRes.ok) {
          const rollbackFsText = await rollbackFsRes.text();
          rollbackError += ` Folder structure rollback failed: ${rollbackFsText}`;
        } else {
          await updateCurrentMtimeFromResponse(rollbackFsRes);
        }
      } catch (rollbackFsErr) {
        rollbackError += ` Folder structure rollback failed: ${rollbackFsErr.message}`;
      }
    }
    if (folderCreated) {
      try {
        const rollbackRes = await fetch(`/project_settings/${DEFAULT_SOURCE}/delete_project_folder`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newProjectName })
        });
        if (!rollbackRes.ok) {
          const rollbackText = await rollbackRes.text();
          rollbackError += ` Folder rollback failed: ${rollbackText}`;
        }
      } catch (rollbackErr) {
        rollbackError += ` Folder rollback failed: ${rollbackErr.message}`;
      }
    }
    const msg = `Create project failed: ${e.message}${rollbackError}`;
    setStatus(msg);
    alert(msg);
    try {
      await loadProjectData(DEFAULT_SOURCE);
    } catch {}
  }
}

async function renameProject(project) {
  const enteredName = await showDialog("Enter new project name:", project.name);
  if (!enteredName) return;
  const newName = enteredName.trim();
  const oldName = String(project.name || "").trim();
  if (!newName || newName === oldName) return;

  const sheetName = getSheetName();
  const sheet = projectData[sheetName];
  const headers = sheet.headers || [];
  const nameIdx = headers.indexOf("Project Name");
  if (nameIdx === -1) {
    const msg = "Error: Project Name column not found";
    setStatus(msg);
    alert(msg);
    return;
  }

  const rowIndex = sheet.rows.indexOf(project._row);
  if (rowIndex === -1) {
    const msg = "Error: Project row not found";
    setStatus(msg);
    alert(msg);
    return;
  }

  const duplicateNameExists = sheet.rows.some((row, idx) =>
    idx !== rowIndex && String((row && row[nameIdx]) || "").trim().toLowerCase() === newName.toLowerCase()
  );
  if (duplicateNameExists) {
    const msg = `Project "${newName}" already exists.`;
    setStatus(msg);
    alert(msg);
    return;
  }

  setStatus(`Renaming "${oldName}" to "${newName}"...`);
  let folderRenamed = false;
  let folderStructureSaved = false;
  const oldFolderPath = getProjectFolderFromStructure(oldName);
  const foldersBefore = Array.isArray(projectData.customFolders) ? [...projectData.customFolders] : [];
  const projectPathsBefore = Array.isArray(projectData.projectPaths) ? [...projectData.projectPaths] : [];

  try {
    // 1) Rename folder first. If this fails, abort before touching JSON/UI.
    const renameFolderRes = await fetch(`/project_settings/${DEFAULT_SOURCE}/rename_project_folder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old_name: oldName, new_name: newName })
    });

    let renameFolderResult = null;
    if (!renameFolderRes.ok) {
      const errText = await renameFolderRes.text();
      throw new Error(`Folder rename failed: ${errText}`);
    } else {
      renameFolderResult = await renameFolderRes.json();
    }

    // Treat missing source folder as a hard failure for rename.
    if (renameFolderResult?.message && /source folder does not exist/i.test(String(renameFolderResult.message))) {
      throw new Error(`Folder rename failed: ${renameFolderResult.message}`);
    }
    folderRenamed = !!(renameFolderResult?.old_folder && renameFolderResult?.new_folder);

    // 2) Save folder structure with renamed project path.
    const foldersNext = [...foldersBefore];
    const projectPathsNext = [...projectPathsBefore];
    let foundPath = false;
    for (let i = 0; i < projectPathsNext.length; i++) {
      const parsed = splitProjectTreePath(projectPathsNext[i]);
      if (String(parsed.projectName || "").trim().toLowerCase() === oldName.toLowerCase()) {
        projectPathsNext[i] = joinProjectTreePath(parsed.folderPath || "Uncategorized", newName);
        foundPath = true;
        break;
      }
    }
    if (!foundPath) {
      projectPathsNext.push(joinProjectTreePath(oldFolderPath || "Uncategorized", newName));
    }
    const folderSaveRes = await fetch(`/project_settings/${DEFAULT_SOURCE}/folders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folders: foldersNext, project_paths: projectPathsNext })
    });
    if (!folderSaveRes.ok) {
      const errText = await folderSaveRes.text();
      throw new Error(`Folder structure save failed: ${errText}`);
    }
    await updateCurrentMtimeFromResponse(folderSaveRes);
    folderStructureSaved = true;

    // 3) Save renamed project name into projects/index.json.
    const dataToSave = { ...projectData };
    const currentSheet = dataToSave[sheetName] || {};
    const currentRows = Array.isArray(currentSheet.rows)
      ? currentSheet.rows.map((row) => (Array.isArray(row) ? [...row] : row))
      : [];

    if (rowIndex < 0 || rowIndex >= currentRows.length || !Array.isArray(currentRows[rowIndex])) {
      throw new Error("Project row not found while preparing save.");
    }

    currentRows[rowIndex][nameIdx] = newName;
    dataToSave[sheetName] = { ...currentSheet, rows: currentRows };
    delete dataToSave.customFolders;
    delete dataToSave.projectPaths;
    removeObsoleteProjectMapColumns(dataToSave);

    const saveRes = await fetch(`/project_settings/${DEFAULT_SOURCE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: dataToSave,
        file_mtime: currentMtime
      })
    });

    if (saveRes.status === 409) {
      throw new Error("File was modified by another user. Please refresh and try again.");
    }
    if (saveRes.status === 423) {
      throw new Error("File is locked. Another user may have it open.");
    }
    if (!saveRes.ok) {
      const errText = await saveRes.text();
      throw new Error(`Save failed: HTTP ${saveRes.status}: ${errText}`);
    }

    const saveResult = await saveRes.json();
    currentMtime = saveResult.mtime;

    // 4) Commit UI updates only after app-server steps succeed.
    project._row[nameIdx] = newName;
    project.name = newName;
    projectData.projectPaths = projectPathsNext;
    buildTreeData();
    renderTree();
    if (selectedProject && selectedProject === project) {
      showProjectDetails(project);
    }
    setStatus(`Renamed to "${newName}"`);
    await appendAuditLogAction(newName, `Renamed project from "${oldName}" to "${newName}"`);
  } catch (e) {
    let rollbackError = "";
    if (folderStructureSaved) {
      try {
        const rollbackFsRes = await fetch(`/project_settings/${DEFAULT_SOURCE}/folders`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folders: foldersBefore, project_paths: projectPathsBefore })
        });
        if (!rollbackFsRes.ok) {
          const rollbackFsText = await rollbackFsRes.text();
          rollbackError += ` Folder structure rollback failed: ${rollbackFsText}`;
        } else {
          await updateCurrentMtimeFromResponse(rollbackFsRes);
        }
      } catch (rollbackFsErr) {
        rollbackError += ` Folder structure rollback failed: ${rollbackFsErr.message}`;
      }
    }
    if (folderRenamed) {
      try {
        const rollbackRes = await fetch(`/project_settings/${DEFAULT_SOURCE}/rename_project_folder`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ old_name: newName, new_name: oldName })
        });
        if (!rollbackRes.ok) {
          const rollbackText = await rollbackRes.text();
          rollbackError += ` Folder rollback failed: ${rollbackText}`;
        }
      } catch (rollbackErr) {
        rollbackError += ` Folder rollback failed: ${rollbackErr.message}`;
      }
    }
    const msg = `Rename failed: ${e.message}${rollbackError}`;
    setStatus(msg);
    alert(msg);
    try {
      await loadProjectData(DEFAULT_SOURCE);
    } catch {}
  }
}

function getNextDuplicateName(baseName) {
  // Get all existing project names
  const sheetName = getSheetName();
  const sheet = projectData[sheetName];
  const headers = sheet.headers || [];
  const nameIdx = headers.indexOf("Project Name");
  const existingNames = new Set(sheet.rows.map(row => row[nameIdx]));
  
  // Remove existing index suffix like "(2)", "(3)" from base name
  const baseWithoutIndex = baseName.replace(/\s*\(\d+\)\s*$/, "").trim();
  
  // Find next available index
  let index = 2;
  let newName = `${baseWithoutIndex} (${index})`;
  while (existingNames.has(newName)) {
    index++;
    newName = `${baseWithoutIndex} (${index})`;
  }
  return newName;
}

async function duplicateProject(project) {
  const suggestedName = getNextDuplicateName(project.name);
  const newName = await showDialog("Enter name for duplicate:", suggestedName);
  if (!newName) return;
  const newProjectName = newName.trim();
  if (!newProjectName) return;
  
  const sheetName = getSheetName();
  const sheet = projectData[sheetName];
  const headers = sheet.headers || [];
  const nameIdx = headers.indexOf("Project Name");
  
  if (nameIdx === -1) {
    const msg = "Error: Project Name column not found";
    setStatus(msg);
    alert(msg);
    return;
  }

  const alreadyExists = sheet.rows.some((row) =>
    String((row && row[nameIdx]) || "").trim().toLowerCase() === newProjectName.toLowerCase()
  );
  if (alreadyExists) {
    const msg = `Project "${newProjectName}" already exists.`;
    setStatus(msg);
    alert(msg);
    return;
  }

  setStatus(`Duplicating as "${newProjectName}"...`);
  const newRow = [...project._row];
  newRow[nameIdx] = newProjectName;

  let folderCopied = false;
  let folderStructureSaved = false;
  const foldersBefore = Array.isArray(projectData.customFolders) ? [...projectData.customFolders] : [];
  const projectPathsBefore = Array.isArray(projectData.projectPaths) ? [...projectData.projectPaths] : [];
  try {
    // 1) Copy folder first.
    showProjectOperationProgress(`Duplicating "${project.name}" to "${newProjectName}"...`);
    const copyRes = await fetch(`/project_settings/${DEFAULT_SOURCE}/duplicate_project_folder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old_name: project.name, new_name: newProjectName })
    });
    if (!copyRes.ok) {
      const errText = await copyRes.text();
      throw new Error(`Folder copy failed: ${errText}`);
    }
    const copyResult = await copyRes.json();
    if (copyResult && copyResult.message) {
      throw new Error(`Folder copy failed: ${copyResult.message}`);
    }
    folderCopied = true;
    showProjectOperationProgress(`Finalizing "${newProjectName}"...`);

    // 2) Save folder structure with the new project path.
    const sourceFolderPath = getProjectFolderFromStructure(project.name);
    const foldersNext = [...foldersBefore];
    const projectPathsNext = [...projectPathsBefore];
    const newFullPath = joinProjectTreePath(sourceFolderPath || "Uncategorized", newProjectName);
    if (!projectPathsNext.some((p) => pathEqualsCI(p, newFullPath))) {
      projectPathsNext.push(newFullPath);
    }
    const folderSaveRes = await fetch(`/project_settings/${DEFAULT_SOURCE}/folders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folders: foldersNext, project_paths: projectPathsNext })
    });
    if (!folderSaveRes.ok) {
      const errText = await folderSaveRes.text();
      throw new Error(`Folder structure save failed: ${errText}`);
    }
    await updateCurrentMtimeFromResponse(folderSaveRes);
    folderStructureSaved = true;

    // 3) Save duplicated project row to settings JSON.
    const dataToSave = { ...projectData };
    const currentSheet = dataToSave[sheetName] || {};
    const currentRows = Array.isArray(currentSheet.rows) ? currentSheet.rows.map((row) => (Array.isArray(row) ? [...row] : row)) : [];
    currentRows.push(newRow);
    dataToSave[sheetName] = { ...currentSheet, rows: currentRows };
    delete dataToSave.customFolders;
    delete dataToSave.projectPaths;
    removeObsoleteProjectMapColumns(dataToSave);

    const saveRes = await fetch(`/project_settings/${DEFAULT_SOURCE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: dataToSave,
        file_mtime: currentMtime
      })
    });

    if (saveRes.status === 409) {
      throw new Error("File was modified by another user. Please refresh and try again.");
    }
    if (saveRes.status === 423) {
      throw new Error("File is locked. Another user may have it open.");
    }
    if (!saveRes.ok) {
      const errText = await saveRes.text();
      throw new Error(`Save failed: HTTP ${saveRes.status}: ${errText}`);
    }

    const saveResult = await saveRes.json();
    currentMtime = saveResult.mtime;

    // 4) Commit to in-memory/UI only after app-server steps succeed.
    sheet.rows.push(newRow);
    projectData.projectPaths = projectPathsNext;
    buildTreeData();
    renderTree();
    hideProjectOperationProgress();
    setStatus(`Duplicated "${newProjectName}"`);
    await appendAuditLogAction(newProjectName, `Duplicated from project "${project.name}"`);
  } catch (e) {
    hideProjectOperationProgress();
    let rollbackError = "";
    if (folderStructureSaved) {
      try {
        const rollbackFsRes = await fetch(`/project_settings/${DEFAULT_SOURCE}/folders`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folders: foldersBefore, project_paths: projectPathsBefore })
        });
        if (!rollbackFsRes.ok) {
          const rollbackFsText = await rollbackFsRes.text();
          rollbackError += ` Folder structure rollback failed: ${rollbackFsText}`;
        } else {
          await updateCurrentMtimeFromResponse(rollbackFsRes);
        }
      } catch (rollbackFsErr) {
        rollbackError += ` Folder structure rollback failed: ${rollbackFsErr.message}`;
      }
    }
    if (folderCopied) {
      try {
        const rollbackRes = await fetch(`/project_settings/${DEFAULT_SOURCE}/delete_project_folder`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newProjectName })
        });
        if (!rollbackRes.ok) {
          const rollbackText = await rollbackRes.text();
          rollbackError += ` Folder rollback failed: ${rollbackText}`;
        }
      } catch (rollbackErr) {
        rollbackError += ` Folder rollback failed: ${rollbackErr.message}`;
      }
    }
    const msg = `Duplicate failed: ${e.message}${rollbackError}`;
    setStatus(msg);
    alert(msg);
    try {
      await loadProjectData(DEFAULT_SOURCE);
    } catch {}
  }
}

async function deleteProject(project) {
  const deletedProjectName = project.name;
  const confirmed = await showConfirm(`Are you sure you want to delete "${project.name}"?`, "Delete Project");
  if (!confirmed) return;
  
  const sheetName = getSheetName();
  const sheet = projectData[sheetName];
  const headers = sheet.headers || [];
  const nameIdx = headers.indexOf("Project Name");
  const deletedNameKey = String(deletedProjectName || "").trim().toLowerCase();
  
  // Find and remove the row
  const rowIndex = sheet.rows.indexOf(project._row);
  if (rowIndex === -1) {
    setStatus("Error: Project row not found");
    return;
  }
  const removedRow = sheet.rows[rowIndex];
  sheet.rows.splice(rowIndex, 1);

  // If another row with the same project name still exists, keep project path mapping.
  const duplicateNameExists = nameIdx >= 0 && sheet.rows.some((row) => {
    const rowName = String((row && row[nameIdx]) || "").trim().toLowerCase();
    return rowName && rowName === deletedNameKey;
  });
  const removedFolderPath = getProjectFolderFromStructure(deletedProjectName);
  if (!duplicateNameExists) {
    removeProjectPathFromStructure(deletedProjectName);
  }
  
  // Clear selection if deleted project was selected
  if (selectedProject && selectedProject.name === project.name) {
    selectedProject = null;
    clearSelectedProjectFromSession();
    detailEmpty.style.display = "flex";
    detailView.style.display = "none";
  }
  
  // Rebuild and re-render
  buildTreeData();
  renderTree();
  
  setStatus(`Deleting "${project.name}"...`);
  const saved = await saveProjectData(DEFAULT_SOURCE);
  if (!saved) {
    sheet.rows.splice(rowIndex, 0, removedRow);
    if (!duplicateNameExists) {
      addProjectPathToStructure(deletedProjectName, removedFolderPath || "Uncategorized");
    }
    buildTreeData();
    renderTree();
    return;
  }

  // If another row with the same project name still exists, keep the folder on disk.
  if (duplicateNameExists) {
    setStatus(`Deleted "${deletedProjectName}". Folder kept because another project with the same name still exists.`);
    return;
  }

  // Delete the project folder on disk (e.g. E:\ArcRho\projects\ProjectName)
  try {
    const res = await fetch(`/project_settings/${DEFAULT_SOURCE}/delete_project_folder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: deletedProjectName })
    });
    if (res.ok) {
      const result = await res.json();
      setStatus(`Deleted "${deletedProjectName}"` + (result.message ? ` (${result.message})` : ""));
    } else {
      const errText = await res.text();
      setStatus(`Deleted in data but folder delete failed: ${errText}`);
    }
  } catch (e) {
    setStatus(`Deleted in data but folder delete failed: ${e.message}`);
  }
}

// ============ Create Folder ============
async function createSubfolder(parentNode) {
  const name = await showDialog("Enter subfolder name:", "");
  if (!name || !name.trim()) return;

  const newPath = normalizeTreePath(parentNode.fullPath ? `${parentNode.fullPath}\\${name.trim()}` : name.trim());
  ensureFolderStructureState();
  if (projectData.customFolders.some((p) => pathEqualsCI(p, newPath))) {
    setStatus("Folder already exists.");
    return;
  }

  ensureFolderPathWithParents(newPath);
  expandedFolders.add(parentNode.fullPath);
  expandedFolders.add(newPath);
  buildTreeData();
  renderTree();
  setStatus(`Created subfolder "${name.trim()}"`);
  await saveProjectData(DEFAULT_SOURCE);
}

async function createRootFolder() {
  const name = await showDialog("Enter root folder name:", "");
  if (!name || !name.trim()) return;

  const newPath = normalizeTreePath(name.trim());
  ensureFolderStructureState();
  if (projectData.customFolders.some((p) => pathEqualsCI(p, newPath))) {
    setStatus("Folder already exists.");
    return;
  }

  ensureFolderPathWithParents(newPath);
  expandedFolders.add(newPath);
  buildTreeData();
  renderTree();
  setStatus(`Created root folder "${newPath}"`);
  await saveProjectData(DEFAULT_SOURCE);
}

async function renameFolder(node) {
  const currentName = node.name;
  const newName = await showDialog("Enter folder name:", currentName);
  if (!newName || newName.trim() === "" || newName === currentName) return;

  const oldPath = normalizeTreePath(node.fullPath);
  const parentPath = oldPath.includes("\\") ? oldPath.replace(/\\[^\\]+$/, "") : "";
  const newPath = normalizeTreePath(parentPath ? `${parentPath}\\${newName.trim()}` : newName.trim());

  if (oldPath === newPath) return;

  ensureFolderStructureState();
  // Update customFolders.
  projectData.customFolders = projectData.customFolders.map((p) => {
    const norm = normalizeTreePath(p);
    if (pathEqualsCI(norm, oldPath)) return newPath;
    if (norm.toLowerCase().startsWith((oldPath + "\\").toLowerCase())) return newPath + norm.slice(oldPath.length);
    return norm;
  });
  ensureFolderPathWithParents(newPath);

  // Update project full paths.
  projectData.projectPaths = projectData.projectPaths.map((full) => {
    const parsed = splitProjectTreePath(full);
    const folder = normalizeTreePath(parsed.folderPath || "");
    if (pathEqualsCI(folder, oldPath)) {
      return joinProjectTreePath(newPath, parsed.projectName);
    }
    if (folder.toLowerCase().startsWith((oldPath + "\\").toLowerCase())) {
      const folder2 = newPath + folder.slice(oldPath.length);
      return joinProjectTreePath(folder2, parsed.projectName);
    }
    return joinProjectTreePath(folder || "Uncategorized", parsed.projectName);
  });

  expandedFolders.delete(oldPath);
  expandedFolders.add(newPath);
  buildTreeData();
  renderTree();
  setStatus(`Renamed folder to "${newName.trim()}"`);
  await saveProjectData(DEFAULT_SOURCE);
}

async function deleteFolder(node) {
  const path = normalizeTreePath(node.fullPath);
  const confirmed = await showConfirm(`Delete folder "${path}"? Projects inside will be moved to the parent folder.`, "Delete Folder");
  if (!confirmed) return;

  const parentPath = path.includes("\\") ? path.replace(/\\[^\\]+$/, "") : "";
  const targetPath = parentPath || "Uncategorized";
  ensureFolderStructureState();

  // Move all projects under this folder to parent.
  projectData.projectPaths = projectData.projectPaths.map((full) => {
    const parsed = splitProjectTreePath(full);
    const folder = normalizeTreePath(parsed.folderPath || "");
    if (pathEqualsCI(folder, path)) {
      return joinProjectTreePath(targetPath, parsed.projectName);
    }
    if (folder.toLowerCase().startsWith((path + "\\").toLowerCase())) {
      const rest = folder.slice(path.length + 1);
      const movedFolder = targetPath === "Uncategorized" ? rest : `${targetPath}\\${rest}`;
      return joinProjectTreePath(movedFolder, parsed.projectName);
    }
    return joinProjectTreePath(folder || "Uncategorized", parsed.projectName);
  });

  // Remove folder and descendants from customFolders.
  projectData.customFolders = projectData.customFolders.filter((p) => {
    const norm = normalizeTreePath(p);
    return !pathEqualsCI(norm, path) && !norm.toLowerCase().startsWith((path + "\\").toLowerCase());
  });

  expandedFolders.delete(path);
  buildTreeData();
  renderTree();
  setStatus(`Deleted folder "${path}"`);
  await saveProjectData(DEFAULT_SOURCE);
}

async function moveFolderToFolder(fromNode, toPath) {
  const oldPath = normalizeTreePath(fromNode.fullPath);
  const newPath = normalizeTreePath(toPath ? `${toPath}\\${fromNode.name}` : fromNode.name);

  if (oldPath === newPath) return;
  ensureFolderStructureState();
  projectData.customFolders = projectData.customFolders.map((p) => {
    const norm = normalizeTreePath(p);
    if (pathEqualsCI(norm, oldPath)) return newPath;
    if (norm.toLowerCase().startsWith((oldPath + "\\").toLowerCase())) return newPath + norm.slice(oldPath.length);
    return norm;
  });
  ensureFolderPathWithParents(newPath);

  projectData.projectPaths = projectData.projectPaths.map((full) => {
    const parsed = splitProjectTreePath(full);
    const folder = normalizeTreePath(parsed.folderPath || "");
    if (pathEqualsCI(folder, oldPath)) {
      return joinProjectTreePath(newPath, parsed.projectName);
    }
    if (folder.toLowerCase().startsWith((oldPath + "\\").toLowerCase())) {
      return joinProjectTreePath(newPath + folder.slice(oldPath.length), parsed.projectName);
    }
    return joinProjectTreePath(folder || "Uncategorized", parsed.projectName);
  });

  expandedFolders.delete(oldPath);
  expandedFolders.add(newPath);
  buildTreeData();
  renderTree();
  setStatus(`Moved folder to "${newPath}"`);
  await saveProjectData(DEFAULT_SOURCE);
}

// ============ Save Project Data ============
async function saveProjectData(sourceKey = DEFAULT_SOURCE) {
  if (!projectData) {
    alert("No data to save.");
    return false;
  }

  setStatus("Saving...");
  try {
    // Save project data (exclude folder structure fields - stored in projects/index.json folders)
    const dataToSave = { ...projectData };
    delete dataToSave.customFolders;
    delete dataToSave.projectPaths;
    removeObsoleteProjectMapColumns(dataToSave);

    const res = await fetch(`/project_settings/${sourceKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: dataToSave,
        file_mtime: currentMtime
      })
    });

    if (res.status === 409) {
      alert("File was modified by another user. Refreshing to get latest data.");
      await loadProjectData(sourceKey);
      return false;
    }
    if (res.status === 423) {
      alert("File is locked. Another user may have it open.");
      return false;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    const result = await res.json();
    currentMtime = result.mtime;

    // Save virtual folder structure to projects/index.json
    const folders = Array.isArray(projectData.customFolders) ? projectData.customFolders : [];
    const project_paths = Array.isArray(projectData.projectPaths) ? projectData.projectPaths : [];
    const foldersRes = await fetch(`/project_settings/${sourceKey}/folders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folders, project_paths })
    });
    if (!foldersRes.ok) {
      setStatus(`Saved projects, but project index folder save failed: ${foldersRes.status}`);
      return false;
    } else {
      await updateCurrentMtimeFromResponse(foldersRes);
      setStatus("Saved successfully.");
      return true;
    }
  } catch (err) {
    setStatus(`Save error: ${err.message}`);
    console.error(err);
    return false;
  }
}

// ============ Ribbon Tab Switching ============
(function initRibbon() {
  const ribbonBar = document.getElementById("ribbonBar");
  if (!ribbonBar) return;

  const panelMap = {
    "summary": document.getElementById("ribbonSummary"),
    "field-mapping": document.getElementById("ribbonFieldMapping"),
    "reserving-class-types": document.getElementById("ribbonReservingClassTypes"),
    "dataset-types": document.getElementById("ribbonDatasetTypes"),
    "data-processing": document.getElementById("ribbonDataProcessing"),
    "audit-log": document.getElementById("ribbonAuditLog"),
    "project-settings": document.getElementById("ribbonProjectSettings"),
  };

  const initialActiveItem = ribbonBar.querySelector(".ribbon-item.active");
  const initialKey = String(initialActiveItem?.dataset?.ribbon || "").trim().toLowerCase();
  if (initialKey) {
    activeProjectSettingsRibbon = initialKey;
  }
  notifyProjectSettingsRibbonChanged();

  ribbonBar.addEventListener("click", (e) => {
    const item = e.target.closest(".ribbon-item");
    if (!item) return;
    const key = String(item.dataset.ribbon || "").trim().toLowerCase();
    if (!key) return;

    // Update active ribbon
    ribbonBar.querySelectorAll(".ribbon-item").forEach(r => r.classList.remove("active"));
    item.classList.add("active");

    // Show matching panel
    Object.entries(panelMap).forEach(([k, panel]) => {
      if (panel) panel.classList.toggle("active", k === key);
    });
    activeProjectSettingsRibbon = key;
    notifyProjectSettingsRibbonChanged();
    if (key === "audit-log" && selectedProject?.name) {
      loadAuditLog(selectedProject.name, true);
    }
  });
})();

// ============ Initialize ============
(async function init() {
  document
    .querySelectorAll(".summary-columns, .field-mapping-grid, .dataset-types-grid")
    .forEach(wireProjectSettingsTableScrollbarActivity);
  const restoredFromLocalPreferences = await loadExpandedFoldersFromLocalPreferences();
  projectExplorerPreferencesLoaded = true;
  const restoredFromSession = restoredFromLocalPreferences ? true : loadExpandedFoldersFromSession();
  // Expand first level by default only when no prior local or in-session state exists.
  if (!restoredFromSession) {
    expandedFolders.add("New Jersey");
    persistExpandedFolders({ immediate: true });
  }

  await loadProjectData(DEFAULT_SOURCE);
})();

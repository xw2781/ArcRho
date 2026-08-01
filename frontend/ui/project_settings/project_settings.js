/**
 * Project Settings - Workspace coordinator
 *
 * Owns the page shell: DOM lookups, feature composition, project selection,
 * the Source Data table-summary load, dialogs, context menus, and the ribbon.
 * Domain logic lives in the sibling feature modules:
 *   - project map document + folder structure -> project_settings_project_map.js
 *   - Project Explorer tree                   -> project_settings_tree_view.js
 *   - project/folder create-rename-delete     -> project_settings_project_ops.js
 *   - origin/development boundary months      -> project_settings_general_settings.js
 *   - shared table column sizing              -> project_settings_table_columns.js
 */
import { AuditLogStore } from "/ui/project_settings/project_settings_audit.js?v=20260223";
import { createFieldMappingFeature } from "/ui/project_settings/project_settings_field_mapping.js?v=20260730sqlsrc6";
import { createDatasetTypesFeature } from "/ui/project_settings/project_settings_dataset_types.js?v=20260722a";
import { createReservingClassTypesFeature } from "/ui/project_settings/project_settings_reserving_class_types.js?v=20260716resize2";
import { createDataProcessingRulesFeature } from "/ui/project_settings/project_settings_data_processing_rules.js?v=20260721dpr12";
import { createSourceDataFeature } from "/ui/project_settings/project_settings_source_data.js?v=20260731loading1";
import {
  applyProjectSettingsTablePreferences,
  getConfiguredTableColumnWidthMap,
  initTableColumnResizing,
  normalizeTableColumnPreferenceKey,
  resizeCellTextarea,
  wireProjectSettingsTableScrollbarActivity,
} from "/ui/project_settings/project_settings_table_columns.js?v=20260730sqlsrc6";
import {
  createGeneralSettingsFeature,
  formatBoundaryYmDisplay,
  normalizeBoundaryYmCanonical,
} from "/ui/project_settings/project_settings_general_settings.js?v=20260730sqlsrc6";
import { createProjectMapStore } from "/ui/project_settings/project_settings_project_map.js?v=20260730sqlsrc6";
import { createTreeViewFeature } from "/ui/project_settings/project_settings_tree_view.js?v=20260730sqlsrc6";
import { createProjectOpsFeature } from "/ui/project_settings/project_settings_project_ops.js?v=20260730sqlsrc6";
import { loadProjectUserPreferences } from "/ui/shared/services/project_user_preferences.js?v=20260716psprefs1";
import "/ui/shared/integrations/zoom_bridge.js?v=20260521a";

const DEFAULT_SOURCE = "project_map";
const AUTO_SAVE_DEBOUNCE_MS = 700;

window.ArcRhoZoomBridge?.wirePageZoomBridge();

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
const summaryOriginStartInput = document.getElementById("summaryOriginStartInput");
const summaryOriginEndInput = document.getElementById("summaryOriginEndInput");
const summaryDevelopmentEndInput = document.getElementById("summaryDevelopmentEndInput");
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

// ============ State ============
let selectedProject = null;    // Currently selected project
let contextMenuProject = null; // Project for context menu actions
let contextMenuFolder = null;  // Folder node for context menu (create subfolder)
let activeProjectSettingsRibbon = "summary";
let tableSummaryLoadSeq = 0;
let currentFieldNames = [];

// ============ Shared helpers ============
function setStatus(msg) {
  // Send status to app's statusbar
  window.parent.postMessage({ type: "arcrho:status", text: msg || "" }, "*");
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeProjectKey(name) {
  return String(name || "").trim().toLowerCase();
}

/** Best available failure message for a non-OK app-server response. */
async function readResponseErrorDetail(res) {
  let detail = "";
  try {
    const body = await res.json();
    detail = String(body?.detail || "").trim();
  } catch {
    const text = await res.text();
    detail = String(text || "").trim();
  }
  return detail || `HTTP ${res.status}`;
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

// ============ Shell integration ============
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

/** Guard a shell-triggered local file action on the matching ribbon and selection. */
function requireActiveRibbonProject(ribbonKey, tabLabel, setFeatureStatus) {
  if (String(activeProjectSettingsRibbon || "").trim().toLowerCase() !== ribbonKey) {
    setStatus(`${tabLabel} tab is not active.`);
    return "";
  }
  const projectName = String(selectedProject?.name || "").trim();
  if (!projectName) {
    setFeatureStatus("Select a project first.", true);
    setStatus("Select a project first.");
    return "";
  }
  return projectName;
}

async function handleShellDatasetTypesLocalSave() {
  const projectName = requireActiveRibbonProject("dataset-types", "Dataset Types", (...args) => datasetTypesFeature?.setDatasetTypesStatus(...args));
  if (!projectName) return;
  await datasetTypesFeature?.saveDatasetTypesToLocalFile(projectName);
}

async function handleShellDatasetTypesLocalLoad() {
  const projectName = requireActiveRibbonProject("dataset-types", "Dataset Types", (...args) => datasetTypesFeature?.setDatasetTypesStatus(...args));
  if (!projectName) return;
  await datasetTypesFeature?.loadDatasetTypesFromLocalFile(projectName);
}

async function handleShellReservingClassTypesLocalSave() {
  const projectName = requireActiveRibbonProject("reserving-class-types", "Reserving Class Types", (...args) => reservingClassTypesFeature?.setReservingClassTypesStatus(...args));
  if (!projectName) return;
  await reservingClassTypesFeature?.saveReservingClassTypesToLocalFile(projectName);
}

async function handleShellReservingClassTypesLocalLoad() {
  const projectName = requireActiveRibbonProject("reserving-class-types", "Reserving Class Types", (...args) => reservingClassTypesFeature?.setReservingClassTypesStatus(...args));
  if (!projectName) return;
  await reservingClassTypesFeature?.loadReservingClassTypesFromLocalFile(projectName);
}

// ============ Audit log ============
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

// ============ Debounced auto-save ============
/** Debounce + single-flight wrapper shared by the auto-saving grid features. */
function createAutoSaveScheduler(runSave) {
  const timers = new Map();
  const inFlight = new Map();
  const pending = new Set();

  function clearTimer(key) {
    const timerId = timers.get(key);
    if (timerId) {
      clearTimeout(timerId);
      timers.delete(key);
    }
  }

  function schedule(projectName) {
    const key = normalizeProjectKey(projectName);
    if (!key) return;
    clearTimer(key);
    timers.set(key, setTimeout(() => trigger(projectName), AUTO_SAVE_DEBOUNCE_MS));
  }

  async function trigger(projectName) {
    const key = normalizeProjectKey(projectName);
    if (!key) return;
    clearTimer(key);
    if (inFlight.get(key)) {
      pending.add(key);
      return;
    }
    inFlight.set(key, true);
    try {
      await runSave(projectName);
    } finally {
      inFlight.set(key, false);
      if (pending.has(key)) {
        pending.delete(key);
        schedule(projectName);
      }
    }
  }

  return schedule;
}

const scheduleDatasetTypesAutoSave = createAutoSaveScheduler((projectName) => datasetTypesFeature?.saveDatasetTypes(projectName));
const scheduleReservingClassTypesAutoSave = createAutoSaveScheduler((projectName) => reservingClassTypesFeature?.saveReservingClassTypes(projectName));

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

// ============ Feature composition ============
let fieldMappingFeature = null;
let datasetTypesFeature = null;
let reservingClassTypesFeature = null;
let dataProcessingRulesFeature = null;

const projectMapStore = createProjectMapStore({
  defaultSource: DEFAULT_SOURCE,
  fetchImpl: fetch.bind(window),
  setStatus,
  reloadProjectData: (...args) => loadProjectData(...args),
});

const sourceDataFeature = createSourceDataFeature({
  escapeHtml,
  setStatus,
  normalizeMonth: normalizeBoundaryYmCanonical,
  formatMonth: formatBoundaryYmDisplay,
  getHostApi: () => window.ADAHost,
  onProfileSave: (...args) => saveImportSettings(...args),
  onListTables: (...args) => listSourceTables(...args),
  onListConnections: () => listSourceConnections(),
  onForgetConnection: (...args) => forgetSourceConnection(...args),
  onCsvPathPick: (...args) => pickTablePathFromHost(...args),
  onImportData: (...args) => importSourceData(...args),
  // Admin-editable defaults stay owned by the shared table preference JSON.
  getConfiguredColumnWidths: () => {
    const configured = getConfiguredTableColumnWidthMap("summaryColumnsTable");
    if (!configured) return null;
    return {
      name: configured.get(normalizeTableColumnPreferenceKey("Column Name")),
      type: configured.get(normalizeTableColumnPreferenceKey("Data Type")),
    };
  },
});

const generalSettingsFeature = createGeneralSettingsFeature({
  setStatus,
  normalizeProjectKey,
  readResponseErrorDetail,
  getSelectedProject: () => selectedProject,
  onInputsChanged: () => sourceDataFeature.refreshOriginSpanNote(),
  fetchImpl: fetch.bind(window),
  controls: {
    originStartDate: { input: summaryOriginStartInput },
    originEndDate: { input: summaryOriginEndInput },
    developmentEndDate: { input: summaryDevelopmentEndInput },
  },
});

const treeViewFeature = createTreeViewFeature({
  treeContent,
  fetchImpl: fetch.bind(window),
  getTreeData: () => projectMapStore.getTreeData(),
  getSelectedProject: () => selectedProject,
  selectProject: (...args) => selectProject(...args),
  openProjectInNewTab: (...args) => openProjectInNewTab(...args),
  openProjectInstanceTab: (...args) => openProjectInstanceTab(...args),
  moveProjectToFolder: (...args) => projectOpsFeature.moveProjectToFolder(...args),
  moveFolderToFolder: (...args) => projectOpsFeature.moveFolderToFolder(...args),
  showProjectContextMenu,
  showFolderContextMenu,
});

const projectOpsFeature = createProjectOpsFeature({
  defaultSource: DEFAULT_SOURCE,
  fetchImpl: fetch.bind(window),
  store: projectMapStore,
  treeView: treeViewFeature,
  setStatus,
  showDialog,
  showConfirm,
  showProgress: showProjectOperationProgress,
  hideProgress: hideProjectOperationProgress,
  appendAuditLogAction,
  getSelectedProject: () => selectedProject,
  setSelectedProject: (project) => { selectedProject = project; },
  selectProject: (...args) => selectProject(...args),
  showProjectDetails: (...args) => showProjectDetails(...args),
  clearProjectSelection,
  reloadProjectData: (...args) => loadProjectData(...args),
});

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

// ============ Load JSON Data ============
async function loadProjectData(sourceKey = DEFAULT_SOURCE) {
  setStatus("Loading projects...");
  generalSettingsFeature.clearCache();
  try {
    const { path } = await projectMapStore.load(sourceKey);
    treeViewFeature.render();
    restoreSelectedProjectFromSession();
    setStatus(`Loaded ${projectMapStore.countProjects()} projects from ${path}`);
  } catch (err) {
    setStatus(`Error loading: ${err.message}`);
    console.error(err);
  }
}

// ============ Project Selection ============
function clearProjectSelection() {
  selectedProject = null;
  treeViewFeature.clearSelectedProjectFromSession();
  detailEmpty.style.display = "flex";
  detailView.style.display = "none";
}

function restoreSelectedProjectFromSession() {
  const snapshot = treeViewFeature.loadSelectedProjectFromSession()
    || treeViewFeature.buildSelectedProjectSnapshot(selectedProject);
  if (!snapshot) return false;

  const project = projectMapStore.findProjectBySnapshot(snapshot);
  if (!project) {
    clearProjectSelection();
    return false;
  }

  selectProject(project);
  return true;
}

async function selectProject(project) {
  reservingClassTypesFeature?.closeReservingClassTypeEditor();
  dataProcessingRulesFeature?.closeEditor();
  selectedProject = project;
  treeViewFeature.saveSelectedProjectToSession(project);
  treeViewFeature.render(); // Update active state
  const selectionKey = normalizeProjectKey(project?.name);
  let preferences = {};
  try {
    preferences = await loadProjectUserPreferences(project?.name, { forceReload: true });
  } catch (err) {
    console.warn("Failed to load Project Settings table defaults:", err);
  }
  if (!selectedProject || normalizeProjectKey(selectedProject.name) !== selectionKey) return;
  applyProjectSettingsTablePreferences(preferences);
  sourceDataFeature.applyConfiguredColumnWidths();
  showProjectDetails(project);
  // Update tree header to show the last part of the folder name
  if (treeHeader && project.folder) {
    const parts = project.folder.split("\\");
    treeHeader.textContent = parts[parts.length - 1];
  }
}

function showProjectDetails(project) {
  detailEmpty.style.display = "none";
  detailView.style.display = "flex";
  detailTitle.textContent = project.name;
  treeViewFeature.saveSelectedProjectToSession(project);

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
  renameBtn.onclick = () => projectOpsFeature.renameProject(project);

  // Detail form fields were moved to ribbon panels.
  detailForm.innerHTML = "";
  detailForm.style.display = "none";
  bindSummaryTablePathEditor(project);
  generalSettingsFeature.bindEditor(project);

  // Load the summary of the table this project has imported.
  loadTableSummary(project.name);
  datasetTypesFeature?.loadDatasetTypes(project.name);
  reservingClassTypesFeature?.loadReservingClassTypes(project.name);
  dataProcessingRulesFeature?.loadRules(project.name);
  loadAuditLog(project.name);
}

// ============ Source Table Path ============
function getDirFromPath(filePath) {
  const s = String(filePath || "").trim();
  if (!s) return "";
  const slash = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  if (slash <= 0) return "";
  return s.slice(0, slash);
}

/** Open the desktop file picker, starting beside the currently entered path. */
async function pickTablePathFromHost(currentPath = "") {
  const hostApi = window.ADAHost
    || window.parent?.ADAHost
    || window.top?.ADAHost;
  if (!hostApi?.pickOpenTableFile) {
    setStatus("Browse is available in the desktop app only.");
    return "";
  }
  const startDir = getDirFromPath(currentPath) || getDirFromPath(selectedProject?.tablePath);
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
  const sheet = projectMapStore.getSheet();
  if (!sheet) {
    throw new Error("Project data is unavailable.");
  }
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

  const saved = await projectMapStore.save(DEFAULT_SOURCE);
  if (!saved) {
    project._row[tablePathCol] = prevTablePath;
    project.tablePath = prevProjectTablePath;
    throw new Error("Save failed.");
  }

  projectMapStore.buildTreeData();
  treeViewFeature.render();
}

/**
 * Bind the Source Data header to a project.
 *
 * The hidden path input stays the coordinator's record of the current CSV
 * selection: the folder actions read it and the Import Settings panel commits
 * through it. Reload re-imports from whichever source the project is set to.
 */
function bindSummaryTablePathEditor(project) {
  if (!summaryTablePathInput || !summaryTablePathReloadBtn) return;

  summaryTablePathInput.value = String(project.tablePath || "");
  summaryTablePathReloadBtn.disabled = false;
  sourceDataFeature.syncPathDisplay(summaryTablePathInput.value);

  let reloading = false;
  const isCurrentProject = () => !!selectedProject && selectedProject.name === project.name;

  summaryTablePathReloadBtn.onclick = async () => {
    if (!isCurrentProject() || reloading) return;
    reloading = true;
    summaryTablePathReloadBtn.disabled = true;
    try {
      setStatus("Reloading table summary...");
      const refreshed = await loadTableSummary(project.name, {
        forceRefresh: true,
        forceFieldMappingReload: true,
        forceReservingClassTypesReload: true,
      });
      if (!refreshed) throw new Error("Unable to reload table summary.");
      setStatus("Reloaded table summary.");
    } catch (err) {
      alert(`Failed to reload table summary: ${err.message}`);
      setStatus(`Failed to reload table summary: ${err.message}`);
    } finally {
      if (isCurrentProject()) summaryTablePathReloadBtn.disabled = false;
      reloading = false;
    }
  };
}

// ============ Import Source (CSV file / SQL Server) ============
/** Load the project's import-source record and hand it to the Source Data tab. */
async function loadSourceTableState(projectName) {
  const name = String(projectName || "").trim();
  if (!name) return sourceDataFeature.applySourceState(null);
  try {
    const res = await fetch(`/source_table?project_name=${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(await readResponseErrorDetail(res));
    return sourceDataFeature.applySourceState(await res.json());
  } catch (err) {
    setStatus(`Could not read the import source: ${err.message}`);
    return sourceDataFeature.applySourceState(null);
  }
}

/**
 * Persist the import settings chosen in the panel.
 *
 * The SQL Server profile lives in the project's own import record, while a CSV
 * selection stays in the project-map `Table Path` column that field mapping
 * already owns, so each value keeps its existing single writer.
 */
async function saveImportSettings(sourceType, mssql, csvPath) {
  const project = selectedProject;
  const name = String(project?.name || "").trim();
  if (!name) return false;
  try {
    if (sourceType === "csv" && String(csvPath || "").trim() !== String(project.tablePath || "").trim()) {
      await saveTablePathField(project, csvPath);
    }
    const res = await fetch("/source_table/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: name, source_type: sourceType, mssql }),
    });
    if (!res.ok) throw new Error(await readResponseErrorDetail(res));
    sourceDataFeature.applySourceState(await res.json());
    return true;
  } catch (err) {
    sourceDataFeature.setSourceStatus(err.message || "Could not save the import settings.", "error");
    setStatus(`Failed to save the import settings: ${err.message}`);
    return false;
  }
}

/** Tables and views available in the database the panel is pointed at. */
async function listSourceTables(profile) {
  try {
    const res = await fetch("/source_table/tables", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    });
    if (!res.ok) return { ok: false, error: await readResponseErrorDetail(res), tables: [] };
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message || "Could not reach the app server.", tables: [] };
  }
}

/** Server-shared list of previously used SQL Server server/database pairs. */
async function listSourceConnections() {
  try {
    const res = await fetch("/source_table/connections");
    if (!res.ok) throw new Error(await readResponseErrorDetail(res));
    return await res.json();
  } catch (err) {
    setStatus(`Could not read saved SQL Server connections: ${err.message}`);
    return { connections: [] };
  }
}

/** Drop one saved pair, or every pair for a server when no database is given. */
async function forgetSourceConnection(server, database) {
  try {
    const res = await fetch("/source_table/connections/forget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server, database: database || null }),
    });
    if (!res.ok) throw new Error(await readResponseErrorDetail(res));
    return await res.json();
  } catch (err) {
    sourceDataFeature.setSourceStatus(
      err.message || "Could not remove the saved connection.",
      "error",
    );
    return listSourceConnections();
  }
}

/**
 * Rebuild the project-owned master table from the saved import settings, then
 * refresh everything derived from it.
 */
async function importSourceData(sourceType) {
  const name = String(selectedProject?.name || "").trim();
  if (!name) return { ok: false, error: "Select a project first." };

  const isSql = sourceType === "mssql";
  setStatus(`Importing the source table for "${name}"...`);
  showProjectOperationProgress(isSql ? "Importing table from SQL Server..." : "Importing CSV file...");
  try {
    const res = await fetch(isSql ? "/source_table/import" : "/source_table/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(isSql ? { project_name: name } : { project_name: name, force: true }),
    });
    if (!res.ok) return { ok: false, error: await readResponseErrorDetail(res) };
    const out = await res.json();
    sourceDataFeature.applySourceState(out);
    const rowCount = Number(out?.last_import?.row_count || 0);
    setStatus(`Imported ${rowCount.toLocaleString("en-US")} row(s) into "${name}".`);
    await loadTableSummary(name, {
      forceRefresh: true,
      forceFieldMappingReload: true,
      forceReservingClassTypesReload: true,
    });
    return { ok: true, rowCount };
  } catch (err) {
    return { ok: false, error: err.message || "The import failed." };
  } finally {
    hideProjectOperationProgress();
  }
}

// ============ Table Summary ============
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
    if (!res.ok) throw new Error(await readResponseErrorDetail(res));
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
    if (!res.ok) throw new Error(await readResponseErrorDetail(res));
    return res.json();
  } catch (err) {
    setStatus(`Warning: failed to clear generated dataset caches for "${name}": ${err.message}`);
    return { ok: false, error: String(err.message || err), cleared_count: 0, preserved_count: 0 };
  }
}

/** Apply a stored General Settings record to the period inputs. */
function applyStoredPeriodsToInputs(values) {
  generalSettingsFeature.setDerivedDateInputs({
    originStart: values.originStartDate,
    originEnd: values.originEndDate,
    developmentEnd: values.developmentEndDate,
  });
}

async function loadTableSummary(projectName = "", options = {}) {
  const forceRefresh = !!options?.forceRefresh;
  const forceFieldMappingReload = !!options?.forceFieldMappingReload;
  const forceReservingClassTypesReload = !!options?.forceReservingClassTypesReload;
  const summaryEl = document.getElementById("tableSummary");
  const requestSeq = ++tableSummaryLoadSeq;
  const isStale = () => requestSeq !== tableSummaryLoadSeq;

  summaryEl.style.display = "flex";
  const sourceState = await loadSourceTableState(projectName);
  if (isStale()) return true;

  // Nothing to summarize until an import source is configured or a table has
  // already been imported into the project folder.
  const isSqlSource = sourceState.sourceType === "mssql";
  const hasSource = isSqlSource
    ? (sourceState.masterTableExists || !!sourceState.mssql.table)
    : (!!sourceState.csvPath || sourceState.masterTableExists);
  if (!hasSource) {
    sourceDataFeature.showNoPath(
      isSqlSource
        ? "No SQL Server table is configured for this project."
        : "No source file is configured for this project.",
    );
    const existingGeneralSettings = await generalSettingsFeature.ensureLoaded(projectName, { applyToInputs: false });
    if (isStale()) return true;
    applyStoredPeriodsToInputs(existingGeneralSettings);
    currentFieldNames = [];
    fieldMappingFeature?.renderFieldMappingEmpty("No source table is configured for this project.");
    fieldMappingFeature?.setFieldMappingStatus("");
    if (forceReservingClassTypesReload) {
      await reservingClassTypesFeature?.loadReservingClassTypes(projectName, { force: true });
    }
    return true;
  }

  sourceDataFeature.showLoading();

  try {
    if (forceRefresh && projectName) {
      await clearArcRhoHeadersCacheForProject(projectName);
      const generatedCacheClear = await clearGeneratedDatasetCsvCachesForProject(projectName);
      if (generatedCacheClear?.ok && Number(generatedCacheClear.cleared_count || 0) > 0) {
        setStatus(`Cleared ${generatedCacheClear.cleared_count} generated dataset cache file(s).`);
      }
      if (isStale()) return true;
    }

    let res = null;
    if (forceRefresh) {
      res = await fetch("/table_summary/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_name: projectName || "",
          refresh_reserving: true,
        }),
      });
    } else {
      const q = new URLSearchParams({ project_name: projectName || "" });
      res = await fetch(`/table_summary?${q.toString()}`);
    }
    if (!res.ok) throw new Error(await readResponseErrorDetail(res));

    const data = await res.json();
    if (isStale()) return true;

    // A CSV refresh may have re-copied the master table; pick up its provenance.
    if (forceRefresh) {
      await loadSourceTableState(projectName);
      if (isStale()) return true;
    }
    currentFieldNames = Array.isArray(data.columns)
      ? data.columns.map(col => String(col?.name || "").trim()).filter(Boolean)
      : [];
    const existingGeneralSettings = await generalSettingsFeature.ensureLoaded(projectName, { applyToInputs: false });
    if (isStale()) return true;
    const mappedDateFields = await fetchMappedDateFields(projectName);
    if (isStale()) return true;
    sourceDataFeature.setDateRoles(mappedDateFields);
    const derivedValues = deriveSummaryDateInputs(data.columns, mappedDateFields);
    const shouldApplyDerived = (
      !!existingGeneralSettings.projectNameMismatch
      || !generalSettingsFeature.hasValues(existingGeneralSettings)
      || (forceRefresh && !!existingGeneralSettings.autoGenerated)
    );
    if (shouldApplyDerived) {
      generalSettingsFeature.setDerivedDateInputs(derivedValues);
      await generalSettingsFeature.save(
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
      applyStoredPeriodsToInputs(existingGeneralSettings);
    }
    if (isStale()) return true;
    sourceDataFeature.renderSummary(data);
    await fieldMappingFeature?.ensureFieldMappingLoaded(projectName, {
      force: forceRefresh || forceFieldMappingReload,
    });
    if (isStale()) return true;
    fieldMappingFeature?.renderFieldMappingTable(currentFieldNames, projectName);
    fieldMappingFeature?.setFieldMappingStatus("");
    if (forceReservingClassTypesReload) {
      await reservingClassTypesFeature?.loadReservingClassTypes(projectName, { force: true });
    }
    return true;

  } catch (err) {
    if (isStale()) return true;
    sourceDataFeature.showError(err.message || "Unable to read the source table.");
    const existingGeneralSettings = await generalSettingsFeature.ensureLoaded(projectName, { applyToInputs: false });
    if (isStale()) return true;
    applyStoredPeriodsToInputs(existingGeneralSettings);
    currentFieldNames = [];
    fieldMappingFeature?.renderFieldMappingEmpty("Unable to load fields from Table Summary.");
    fieldMappingFeature?.setFieldMappingStatus(err.message || "Unable to load table summary.", true);
    return false;
  }
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
    if (!res.ok) throw new Error(await readResponseErrorDetail(res));
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

function hideFeatureRowContextMenus() {
  datasetTypesFeature?.hideDatasetTypesRowContextMenu();
  reservingClassTypesFeature?.hideReservingClassTypesRowContextMenu();
}

function showProjectContextMenu(project, x, y) {
  contextMenuProject = project;
  contextMenuFolder = null;
  hideFolderContextMenu();
  hideTreeContextMenu();
  hideFeatureRowContextMenus();
  positionContextMenu(contextMenu, x, y);
}

function showFolderContextMenu(folderNode, x, y) {
  contextMenuFolder = folderNode;
  contextMenuProject = null;
  hideContextMenu();
  hideTreeContextMenu();
  hideFeatureRowContextMenus();
  positionContextMenu(folderContextMenu, x, y);
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
  hideFeatureRowContextMenus();
  positionContextMenu(treeContextMenu, e.clientX, e.clientY);
});

// Context menu actions (projects)
contextMenu.addEventListener("click", (e) => {
  const action = e.target.dataset.action;
  if (!action || !contextMenuProject) return;

  const project = contextMenuProject;
  hideContextMenu();

  if (action === "rename") {
    projectOpsFeature.renameProject(project);
  } else if (action === "duplicate") {
    projectOpsFeature.duplicateProject(project);
  } else if (action === "delete") {
    projectOpsFeature.deleteProject(project);
  }
});

// Folder context menu: Rename, Create New Project, Create subfolder, Delete
folderContextMenu.addEventListener("click", (e) => {
  const action = e.target.dataset.action;
  if (!action || !contextMenuFolder) return;
  const folderNode = contextMenuFolder;
  hideFolderContextMenu();
  if (action === "rename-folder") {
    projectOpsFeature.renameFolder(folderNode);
  } else if (action === "create-project-in-folder") {
    projectOpsFeature.createProjectInFolder(folderNode);
  } else if (action === "create-subfolder") {
    projectOpsFeature.createSubfolder(folderNode);
  } else if (action === "delete-folder") {
    projectOpsFeature.deleteFolder(folderNode);
  }
});

// Tree context menu: Create root folder
treeContextMenu.addEventListener("click", (e) => {
  if (e.target.dataset.action !== "create-root-folder") return;
  hideTreeContextMenu();
  projectOpsFeature.createRootFolder();
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
  sourceDataFeature?.onEditorMouseMove(e);
});

document.addEventListener("mouseup", () => {
  reservingClassTypesFeature?.onEditorMouseUp();
  datasetTypesFeature?.onEditorMouseUp();
  sourceDataFeature?.onEditorMouseUp();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (datasetTypeEditor?.classList.contains("show")) {
      datasetTypesFeature?.closeDatasetTypeEditor();
    }
  }
});

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
    .querySelectorAll(".tree-content, .sd-list, .field-mapping-grid, .dataset-types-grid")
    .forEach(wireProjectSettingsTableScrollbarActivity);
  sourceDataFeature.init();
  const restoredFromSession = await treeViewFeature.restoreExpandedFolders();
  // Expand first level by default only when no prior local or in-session state exists.
  if (!restoredFromSession) {
    treeViewFeature.expandFolder("New Jersey");
    treeViewFeature.persistExpandedFolders({ immediate: true });
  }

  await loadProjectData(DEFAULT_SOURCE);
})();

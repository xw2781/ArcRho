// Shared Dataset Data-tab controller used by Dataset Viewer and DFM hosts.

import { state } from "/ui/shared/dataset/dataset_state.js";
import { config } from "/ui/shared/dataset/dataset_config.js";
import { getBerquistShermanContract } from "/ui/shared/dataset/berquist_sherman_contract.js";
import { $, logLine } from "/ui/shared/tabs/data/data_tab_dom.js";
import {
  getDataset,
  getDatasetNumberFormatDefaults,
  loadCachedDataset,
  loadDatasetSidecar,
  patchDataset,
  previewCalculatedDatasetDependents,
  saveDatasetNotes,
  saveDatasetSidecar,
} from "/ui/shared/dataset/dataset_api.js";
import {
  renderTable,
  setDatasetRenderNumberFormatSettings,
  setDatasetRenderVectorColumnLabel,
} from "/ui/shared/tabs/data/dataset_grid_view.js?v=20260811j";
import {
  beginDatasetGridLoading,
  endDatasetGridLoading,
  renderDatasetGridPlaceholder,
  setDatasetGridEmpty,
} from "/ui/shared/tabs/data/dataset_grid_placeholder.js?v=20260809a";
import {
  redrawDataTabChartSafely as redrawChartSafely,
  renderDataTabChart as renderChart,
} from "/ui/shared/tabs/data/data_tab_chart_port.js";
import {
  requestTabbedPageWindowClose,
  updateTabbedPageSaveControls,
} from "/ui/shared/tabbed_page/tabbed_page.js?v=20260714a";
import { createDatasetDependencyGuard } from "/ui/shared/dataset/dataset_dependency_service.js";
import { createDatasetHeadersService } from "/ui/shared/dataset/dataset_headers_service.js";
import { validateDatasetOriginLabels } from "/ui/shared/dataset/dataset_origin_labels.js";
import { wireDatasetGridInteractions } from "/ui/shared/tabs/data/dataset_grid_interactions.js?v=20260811j";
import { mountDataTabNotes } from "/ui/shared/tabs/data/data_tab_notes_port.js";
import { publishDataTabHostInputs } from "/ui/shared/tabs/data/data_tab_host_port.js";
import { wireDatasetHostBridge } from "/ui/shared/integrations/dataset_host_bridge.js";
import { createDatasetRunController } from "/ui/shared/dataset/dataset_run_controller.js?v=20260824a";
import { hasResultSelectionUpdates } from "/ui/shared/dataset/result_selection_update_report.js?v=20260725b";
import { wireDatasetInputController } from "/ui/shared/tabs/data/data_tab_controls.js?v=20260820b";
import { readDatasetInputQueryValues } from "/ui/shared/tabs/data/data_tab_query_inputs.js";
import {
  applyDecimalPlacesToDatasetNumberFormat,
  clampDatasetDecimalPlaces,
  normalizeDatasetNumberFormat,
} from "/ui/shared/dataset/dataset_number_format.js";
import {
  isDfmDataTabHost,
  isPersistedDfmMethodBootstrap,
} from "/ui/shared/tabs/data/data_tab_context.js";
import { mountDataTabPageHost } from "/ui/shared/tabs/data/data_tab_page_host_port.js";
import {
  appDefaultWindowTab,
  windowTabIds,
} from "/ui/shared/tabs/window_tab_catalog.js?v=20260824e";
import { openProjectNameTreePicker } from "/ui/shared/components/pickers/project_name_tree_picker.js";
import { openDatasetNamePicker } from "/ui/shared/components/pickers/dataset_name_picker.js";
import { decodeFileNameSegment } from "/ui/shared/utils/filename.js";
import { getDataTabAuditController } from "/ui/shared/tabs/data/data_tab_audit_port.js";
import { getDataTabCloseConfirm } from "/ui/shared/tabs/data/data_tab_close_port.js";
import { getDataTabLinksController } from "/ui/shared/tabs/data/data_tab_links_port.js";
import { createDatasetExternalLinksController } from "/ui/shared/dataset/dataset_external_links.js?v=20260819a";
import {
  loadProjectUserPreferences,
  scheduleProjectUserPreferencesSave,
} from "/ui/shared/services/project_user_preferences.js";
import {
  loadProjectValidValueList,
  loadDatasetValidValueList,
  loadReservingClassValidValueList,
  clearValidValueListCache,
  validateReservingClassPathByTypeNames,
  buildReservingClassPathPartLookup,
  normalizeReservingClassPathByPartLookup,
  normalizeReservingClassPath,
  normalizeReservingClassPathKey,
} from "/ui/shared/services/valid_value_lists.js";
import {
  getLastViewedDatasetInputs,
  setLastViewedDatasetInputs,
  pushBrowsingHistoryEntry,
  normalizeBrowsingHistoryEntry,
} from "/ui/shell/browsing_history.js";
import "/ui/shared/integrations/zoom_bridge.js?v=20260715a";

import { registerDataTabHostController } from "/ui/shared/tabs/data/data_tab_host_controller.js?v=20260805a";
import { registerDataTabDetailsController } from "/ui/shared/tabs/data/data_tab_details_controller.js?v=20260824b";
import { registerDataTabInputsController } from "/ui/shared/tabs/data/data_tab_inputs_controller.js?v=20260731b";
import { registerDataTabPreferencesController } from "/ui/shared/tabs/data/data_tab_preferences_controller.js?v=20260726a";
import { registerDataTabRequestController } from "/ui/shared/tabs/data/data_tab_request_controller.js?v=20260809a";
import { registerDataTabPersistenceController } from "/ui/shared/tabs/data/data_tab_persistence_controller.js?v=20260824a";

const LS_DS_KEY = "arcrho_last_ds_id";
const LS_FORM_KEY = "arcrho_tri_inputs";
const LOCAL_PROJECT_PREFS_ENDPOINT = "/local-project/preferences";
const WF_GLOBAL_CTRL_PREFIX = "arcrho_workflow_global_ctrl_v1::";
const DEFAULT_PROJECT_DISPLAY = "Default Project";
const DEFAULT_PATH_DISPLAY = "Default Path";
const DEFAULT_TOKEN = "__DEFAULT__";
const BROWSING_HISTORY_MAX_ENTRIES = 15;

const qs = new URLSearchParams(window.location.search);
const instanceId = qs.get("inst") || "default";
const isProjectInstanceHost = qs.get("project_instance") === "1";
const isProjectInstanceDraft = qs.get("draft_instance") === "1" || qs.get("draft") === "1";
const isReadOnlyDatasetViewer = qs.get("readonly") === "1";
const temporaryDatasetSessionId = String(qs.get("temporary_session_id") || "").trim();
const isTemporaryDatasetView = qs.get("temporary_view") === "1" && !!temporaryDatasetSessionId;
const isProjectInstanceCachedDatasetOpen = isProjectInstanceHost
  && !isDfmDataTabHost()
  && !isProjectInstanceDraft
  && !isTemporaryDatasetView;
const stepId = instanceId.startsWith("step_") ? instanceId : null;
const scopedKey = (key) => `${key}::${instanceId}`;
const workflowId = qs.get("wf") || "";

const runtime = {
  state,
  config,
  $,
  logLine,
  getBerquistShermanContract,
  getDataset,
  getDatasetNumberFormatDefaults,
  loadCachedDataset,
  loadDatasetSidecar,
  patchDataset,
  previewCalculatedDatasetDependents,
  saveDatasetNotes,
  saveDatasetSidecar,
  renderTable,
  setDatasetRenderNumberFormatSettings,
  setDatasetRenderVectorColumnLabel,
  redrawChartSafely,
  renderChart,
  requestTabbedPageWindowClose,
  updateTabbedPageSaveControls,
  createDatasetDependencyGuard,
  createDatasetHeadersService,
  validateDatasetOriginLabels,
  wireDatasetGridInteractions,
  mountDataTabNotes,
  publishDataTabHostInputs,
  wireDatasetHostBridge,
  createDatasetRunController,
  hasResultSelectionUpdates,
  wireDatasetInputController,
  readDatasetInputQueryValues,
  applyDecimalPlacesToDatasetNumberFormat,
  clampDatasetDecimalPlaces,
  normalizeDatasetNumberFormat,
  isDfmDataTabHost,
  isPersistedDfmMethodBootstrap,
  decodeFileNameSegment,
  getDataTabAuditController,
  getDataTabCloseConfirm,
  getDataTabLinksController,
  createDatasetExternalLinksController,
  loadProjectUserPreferences,
  scheduleProjectUserPreferencesSave,
  loadProjectValidValueList,
  loadDatasetValidValueList,
  loadReservingClassValidValueList,
  clearValidValueListCache,
  validateReservingClassPathByTypeNames,
  buildReservingClassPathPartLookup,
  normalizeReservingClassPathByPartLookup,
  normalizeReservingClassPath,
  normalizeReservingClassPathKey,
  getLastViewedDatasetInputs,
  setLastViewedDatasetInputs,
  pushBrowsingHistoryEntry,
  normalizeBrowsingHistoryEntry,
  qs,
  instanceId,
  isProjectInstanceHost,
  isProjectInstanceDraft,
  isReadOnlyDatasetViewer,
  temporaryDatasetSessionId,
  isTemporaryDatasetView,
  isProjectInstanceCachedDatasetOpen,
  stepId,
  scopedKey,
  workflowId,
  LS_DS_KEY,
  LS_FORM_KEY,
  LOCAL_PROJECT_PREFS_ENDPOINT,
  WF_GLOBAL_CTRL_PREFIX,
  DEFAULT_PROJECT_DISPLAY,
  DEFAULT_PATH_DISPLAY,
  DEFAULT_TOKEN,
  BROWSING_HISTORY_MAX_ENTRIES,
  DATASET_VIEWER_TAB_IDS: windowTabIds("dataset"),
  DATASET_VIEWER_APP_DEFAULT_TAB: appDefaultWindowTab("dataset"),
  activeDependencyPreviewKey: "",
  allDatasetTypes: [],
  allProjects: [],
  currentDatasetPrecedents: [],
  currentDatasetSidecarDataFormat: "",
  currentDatasetSidecarSourceKind: "",
  datasetDependencyGuard: null,
  datasetExternalLinks: null,
  datasetHeadersService: null,
  datasetInstanceNameConflict: false,
  datasetInstanceNameConflictMessage: "",
  datasetRunController: null,
  datasetSaveInFlight: false,
  isSidecarReadOnlyDataset: false,
  lastProjectSelection: "",
  savedProjectInstanceDraftName: "",
};

registerDataTabInputsController(runtime);
registerDataTabPreferencesController(runtime);
registerDataTabRequestController(runtime);
registerDataTabDetailsController(runtime);
registerDataTabPersistenceController(runtime);
registerDataTabHostController(runtime);

let datasetGridInteractions = null;
let eventsWired = false;
let bootPromise = null;

export function getDatasetExternalLinkRecords() {
  return runtime.datasetExternalLinks.listRecords();
}

export function getDatasetExternalLinkCellInfo(displayRow, displayColumn) {
  return runtime.datasetExternalLinks.getCellLinkInfo(displayRow, displayColumn);
}

export async function breakDatasetExternalLinks(ids) {
  const result = runtime.datasetExternalLinks.breakLinks(ids);
  if (!result.ok) return result;
  renderTable();
  runtime.notifyDatasetUpdated({ publishPreview: false });
  runtime.setStatus(result.message || "Links broken. Current dataset values are now hard-coded.");
  return result;
}

export async function breakDatasetExternalLink(id) {
  return breakDatasetExternalLinks([id]);
}

export async function refreshDatasetExternalLinkRecords(ids) {
  return runtime.refreshDatasetExternalLinks({ ids });
}

async function openProjectNameTreeForDataset(targetInput) {
  const initialProject = runtime.getResolvedProjectValue() || targetInput?.value || "";
  await openProjectNameTreePicker({
    initialProject,
    anchorElement: targetInput || null,
    title: "Select a Project",
    setStatus: runtime.setStatus,
    onError: (err) => {
      console.error("Failed to load project tree:", err);
      runtime.setStatus("Error loading project tree.");
    },
    onSelect: async (projectName) => {
      const selected = String(projectName || "").trim();
      if (!selected || !targetInput) return;
      runtime.setInputDefaultBound(targetInput, false);
      targetInput.value = selected;
      runtime.showProjectDropdown(false);
      runtime.setStatus("Loading dataset...");
      await runtime.handleProjectSelection(selected, { strict: true, showMessage: true });
    },
  });
}

async function openDatasetNameTreeForDataset(targetInput) {
  await openDatasetNamePicker({
    projectName: runtime.getResolvedProjectValue(),
    initialName: targetInput?.value || "",
    anchorElement: targetInput || null,
    title: "Select a Dataset Type",
    setStatus: runtime.setStatus,
    onError: (err) => {
      console.error("Failed to load dataset type tree:", err);
      runtime.setStatus("Error loading dataset types.");
    },
    onSelect: (datasetName) => {
      const selected = String(datasetName || "").trim();
      if (!selected || !targetInput) return;
      targetInput.value = selected;
      runtime.showDatasetDropdown(false);
      const knownName = runtime.ensureDatasetTypeOption(selected) || selected;
      void runtime.handleDatasetSelection(knownName, { strict: true });
    },
  });
}

function wireGridInteractions() {
  if (datasetGridInteractions) return;
  datasetGridInteractions = wireDatasetGridInteractions({
    state,
    renderTable,
    isReadOnly: runtime.isDatasetReadOnly,
    setStatus: runtime.setStatus,
    notifyDatasetUpdated: runtime.notifyDatasetUpdated,
    refreshDatasetSettingsDirty: runtime.refreshDatasetSettingsDirty,
    commitExternalReference: (request) => (
      isDfmDataTabHost()
        ? Promise.resolve({
          handled: true,
          ok: false,
          error: "Enter external Excel links in DFM Ratios User Entry cells.",
        })
        : runtime.datasetExternalLinks.commitReference(request)
    ),
    cancelExternalReference: () => runtime.datasetExternalLinks.abort(),
    hardCodeExternalLinkCells: (cells) => runtime.datasetExternalLinks.hardCodeTargetCells(
      (Array.isArray(cells) ? cells : []).map((cell) => ({
        row: Number(cell?.row ?? cell?.r),
        column: Number(cell?.column ?? cell?.c),
      })),
    ),
    decorateExternalLinkCell: (cell, displayRow, displayColumn) => {
      runtime.datasetExternalLinks.decorateCell(cell, displayRow, displayColumn);
    },
    getExternalLinkCellInfo: (displayRow, displayColumn) => (
      runtime.datasetExternalLinks.getCellLinkInfo(displayRow, displayColumn)
    ),
  });
}

function applyGridSelectionFromState() {
  datasetGridInteractions?.applySelectionFromState?.();
}

Object.assign(runtime, {
  openProjectNameTreeForDataset,
  openDatasetNameTreeForDataset,
  wireGridInteractions,
  applyGridSelectionFromState,
});

function wireEvents() {
  if (eventsWired) return;
  eventsWired = true;
  wireDatasetInputController({
    ...runtime,
    state,
    $,
    openProjectNameTreeForDataset,
    openDatasetNameTreeForDataset,
    wireDatasetHostBridge,
    wireGridInteractions,
  });
  runtime.wireDatasetInstanceNameInput();
  runtime.wireDatasetSaveControls();
}

async function bootDatasetDataTabOnce() {
  // Boot owns the grid placeholder until a load, a run, or an explicit empty
  // state takes over, so the first paint of a Client PC window shows the grid
  // that is on its way rather than an empty-looking one.
  const gridPlaceholderToken = beginDatasetGridLoading();
  const gridHost = document.getElementById("tableWrap");
  // The grid host is mounted before boot runs, so the skeleton is the window's
  // first paint of that area instead of a blank panel or a stale empty state.
  if (gridHost && !state.model) renderDatasetGridPlaceholder(gridHost);
  try {
    await bootDatasetDataTabSteps();
  } finally {
    endDatasetGridLoading(gridPlaceholderToken);
  }
}

async function bootDatasetDataTabSteps() {
  runtime.wireDataTabHostLifecycle();
  runtime.wireDataTabInputLifecycle();
  runtime.wireDataTabPersistenceLifecycle();
  runtime.initializeDatasetId();
  setDatasetRenderVectorColumnLabel(isProjectInstanceHost ? qs.get("vector_column_label") : "");
  runtime.wireNotesEditor();
  runtime.fillLenDropdowns();

  const persistedDfmBootstrap = isPersistedDfmMethodBootstrap();
  try {
    if (persistedDfmBootstrap || isProjectInstanceCachedDatasetOpen || isTemporaryDatasetView) {
      // Temporary views carry complete inputs in the URL and cannot save, so
      // they skip the dropdown/preference/sidecar boot chain like cached
      // Project Instance opens; the authoritative run validation reloads the
      // lists it needs on demand.
      runtime.applyTriInputsFromQueryParams();
      // Skipping that chain also skips the only step that resolves a number
      // format, and the grid formats from the toolbar controls when the run
      // paints it. Resolve the Dataset Type default first so the first paint is
      // already formatted instead of waiting for the next input change.
      if (isTemporaryDatasetView) await runtime.applyTemporaryNumberFormatDefaults();
    } else {
      await runtime.loadProjectsDropdown();
      runtime.applyWorkflowDefaultsIfNew();
      await runtime.restoreTriInputsFromStorage();
      runtime.applyTriInputsFromQueryParams();
      const projectResult = runtime.validateAndNormalizeProjectInput({ strict: true, showMessage: false });
      if (projectResult.ok) {
        runtime.lastProjectSelection = projectResult.value;
        if (!isDfmDataTabHost()) runtime.saveLastDatasetViewerProjectToAppData(projectResult.value);
        await Promise.all([
          runtime.refreshDatasetTypesForProject(projectResult.value),
          runtime.refreshReservingClassPathsForProject(projectResult.value),
        ]);
      } else {
        await Promise.all([
          runtime.refreshDatasetTypesForProject(""),
          runtime.refreshReservingClassPathsForProject(""),
        ]);
      }
      await runtime.validateAndNormalizeReservingClassInput(
        runtime.getResolvedProjectValue(),
        { strict: true, showMessage: false },
      );
      runtime.validateAndNormalizeDatasetInput({ strict: true, showMessage: false });
      await runtime.syncSidecarForCurrentDataset({ applyLengths: !isProjectInstanceDraft });
      await runtime.refreshDatasetInstanceNameConflict();
    }
    runtime.enforceDevLenRule({ source: "origin" });

    mountDataTabPageHost({
      initialTab: runtime.getDatasetInitialTab(),
      onDetailsActivated: () => requestAnimationFrame(runtime.resizeDetailFormulaInput),
      onChartActivated: () => {
        requestAnimationFrame(() => requestAnimationFrame(redrawChartSafely));
      },
      wireDataTabTopBarToggle: runtime.wireDatasetDataTabTopBarToggle,
    });

    wireEvents();

    const { project, path, tri } = runtime.getTriInputs();
    if (persistedDfmBootstrap) {
      runtime.setStatus("Loading DFM method...");
    } else if (project && path && tri) {
      // The loading popup is reserved for clear-cache rebuilds, which show it
      // immediately, and for runs still pending after the run controller's
      // short delay (the cache-miss engine path). Cached opens render the
      // grid without a spinner; the status line still reports progress.
      if (isProjectInstanceCachedDatasetOpen) {
        await runtime.loadProjectInstanceCachedDataset();
      } else if (isProjectInstanceDraft) {
        await runtime.refreshProjectInstanceDraftModel();
      } else {
        runtime.scheduleAutoRun(0);
      }
    } else if (isDfmDataTabHost()) {
      setDatasetGridEmpty({
        title: "Waiting For DFM Inputs",
        hint: "This table fills in once the method has a project, reserving class, and dataset.",
      });
      runtime.setStatus("Waiting for DFM inputs...");
    } else {
      await runtime.loadDataset();
    }
  } catch (err) {
    runtime.hideDatasetLoadingPopup();
    throw err;
  }
}

export function bootDatasetDataTab() {
  if (!bootPromise) bootPromise = bootDatasetDataTabOnce();
  return bootPromise;
}

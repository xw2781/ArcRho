import { fetchProjectDatasetTypeItems } from "/ui/dataset/dataset_types_source.js";
import {
  ensureDatasetOriginLabels,
  formatDatasetOriginLabel,
  getDatasetOriginLabelText,
} from "/ui/dataset/dataset_origin_labels.js";
import { openDatasetNamePicker } from "/ui/dataset/dataset_name_picker.js";
import { sanitizeDataFolderPart, sanitizeFileNamePart } from "/ui/shared/filename_sanitizer.js";
import {
  applyTabbedPageSaveBar,
  createTabbedPage,
  requestTabbedPageWindowClose,
  updateTabbedPageSaveControls,
} from "/ui/shared/tabbed_page.js";
import { wireTabPopoutWindows } from "/ui/shared/tab_popout_window.js";
import { wireNotesEditorInteractions } from "/ui/shared/notes_editor_interactions.js";
import { syncDetailsLabelWidth } from "/ui/shared/details_form_layout.js?v=20260710f";
import { startResultSelectionRpcBridgeSync } from "/ui/result_selection/result_selection_rpc_bridge_client.js?v=20260626a";
import { createPageCloseConfirm } from "/ui/shared/page_close_confirm.js";
import { createSpreadsheetTableController } from "/ui/shared/spreadsheet_table.js?v=20260712c";

const RS_JSON_FORMAT = "arcrho-result-selection-method-by-tab-v1";
const RS_JSON_VALUE_DECIMAL_PLACES = 6;
const MAX_RATIO_BASIS_COUNT = 3;
const DEFAULT_ORIGIN_LENGTH = 12;
const VALID_ORIGIN_LENGTHS = [12, 6, 3, 1];
const RS_TAB_DEFS = [
  { id: "details", label: "Details" },
  { id: "method", label: "Method" },
  { id: "results", label: "Results" },
  { id: "validation", label: "Validation" },
  { id: "notes", label: "Notes" },
];
const ALLOWED_RS_TABS = new Set(RS_TAB_DEFS.map((tab) => tab.id));
const FALLBACK_ORIGIN_LABEL_COUNTS = {
  12: 10,
  6: 20,
  3: 40,
  1: 120,
};
const METHOD_COL_DEFAULT_WIDTHS = {
  origin: 90,
  source: 90,
  weight: 68,
  ultimate: 100,
  reserve: 100,
  ratio: 100,
  spacer: 14,
};
const METHOD_COL_MIN_WIDTHS = {
  origin: 58,
  source: 52,
  weight: 68,
  ultimate: 70,
  reserve: 70,
  ratio: 70,
  spacer: 14,
};
const METHOD_COL_MAX_WIDTH = 320;

function text(value) {
  return String(value ?? "").trim();
}

function norm(value) {
  return text(value).replace(/\s+/g, " ").toLowerCase();
}

const params = new URLSearchParams(window.location.search);
const inst = params.get("inst") || `rs_${Date.now()}`;
let programmatic = false;
let isDirty = false;
let cleanSnapshot = "";
let datasetTypeItems = [];
let cachedRows = [];
let notesProgrammatic = false;
let lastSavedNotesText = "";
const closeConfirm = createPageCloseConfirm({ subject: "Result Selection" });
let rsTabSystem = null;

const state = {
  project: text(params.get("project")),
  reservingClass: text(params.get("class") || params.get("path")),
  outputCategory: text(params.get("category")),
  sources: [],
  ratioBasisValues: [],
  outputValues: [],
  activeRatioBasisName: "",
  originLabels: [],
  originLabelsKey: "",
  sidecarOriginLength: null,
  sidecarOriginLabels: [],
  methodColumnWidths: {},
  showEffectiveWeights: false,
  methodHighlight: null,
  methodHighlights: [],
  methodHighlightDragging: false,
  ratioBasisDragIndex: null,
  resultsHighlight: null,
  resultsHighlightDragging: false,
  weightEditSession: null,
  sourceReloadSeq: 0,
  ultimateOverrides: [],
  activeTab: ALLOWED_RS_TABS.has(norm(params.get("tab"))) ? norm(params.get("tab")) : "details",
};

const els = {
  tabBar: document.getElementById("rsTabBar"),
  nameInput: document.getElementById("rsNameInput"),
  outputTypeInput: document.getElementById("rsOutputTypeInput"),
  outputTypeBtn: document.getElementById("rsOutputTypeBtn"),
  originLengthInput: document.getElementById("rsOriginLengthInput"),
  originLengthDropdown: document.getElementById("rsOriginLengthDropdown"),
  originLengthButton: document.getElementById("rsOriginLengthButton"),
  originLengthLabel: document.getElementById("rsOriginLengthLabel"),
  originLengthMenu: document.getElementById("rsOriginLengthMenu"),
  ratioBasisInputs: [
    document.getElementById("rsRatioBasisInput"),
    document.getElementById("rsRatioBasisInput2"),
    document.getElementById("rsRatioBasisInput3"),
  ],
  ratioBasisList: document.getElementById("rsRatioBasisList"),
  ratioBasisAddButton: document.getElementById("rsRatioBasisAddBtn"),
  ratioBasisPicker: document.querySelector(".rsRatioBasisPicker"),
  ratioBasisContextMenu: document.getElementById("rsRatioBasisContextMenu"),
  showRatiosPctInput: document.getElementById("rsShowRatiosPctInput"),
  statisticDecimalsInput: document.getElementById("rsStatisticDecimalsInput"),
  methodStatisticDecimalsInput: document.getElementById("rsMethodStatisticDecimalsInput"),
  methodStatisticDecimalsUp: document.getElementById("rsMethodStatisticDecimalsUp"),
  methodStatisticDecimalsDown: document.getElementById("rsMethodStatisticDecimalsDown"),
  showWeightsInput: document.getElementById("rsShowWeightsInput"),
  weightDisplayDropdown: document.getElementById("rsWeightDisplayDropdown"),
  weightDisplayButton: document.getElementById("rsWeightDisplayButton"),
  weightDisplayLabel: document.getElementById("rsWeightDisplayLabel"),
  weightDisplayMenu: document.getElementById("rsWeightDisplayMenu"),
  syncBtn: document.getElementById("rsSyncBtn"),
  activeRatioBasisDropdown: document.getElementById("rsActiveRatioBasisDropdown"),
  activeRatioBasisButton: document.getElementById("rsActiveRatioBasisButton"),
  activeRatioBasisLabel: document.getElementById("rsActiveRatioBasisLabel"),
  activeRatioBasisMenu: document.getElementById("rsActiveRatioBasisMenu"),
  methodGrid: document.getElementById("rsMethodGrid"),
  resultsGrid: document.getElementById("rsResultsGrid"),
  saveBar: document.querySelector(".rsSaveBar"),
  saveBtn: document.getElementById("rsSaveBtn"),
  cancelBtn: document.getElementById("rsCancelBtn"),
  notesInput: document.getElementById("rsNotesInput"),
  cellContextMenu: document.getElementById("rsCellContextMenu"),
  sourceContextMenu: document.getElementById("rsSourceContextMenu"),
};

const ctx = {
  fetchProjectDatasetTypeItems,
  ensureDatasetOriginLabels,
  formatDatasetOriginLabel,
  getDatasetOriginLabelText,
  openDatasetNamePicker,
  sanitizeDataFolderPart,
  sanitizeFileNamePart,
  applyTabbedPageSaveBar,
  createTabbedPage,
  requestTabbedPageWindowClose,
  updateTabbedPageSaveControls,
  wireTabPopoutWindows,
  wireNotesEditorInteractions,
  createSpreadsheetTableController,
  startResultSelectionRpcBridgeSync,
  RS_JSON_FORMAT,
  RS_JSON_VALUE_DECIMAL_PLACES,
  MAX_RATIO_BASIS_COUNT,
  DEFAULT_ORIGIN_LENGTH,
  VALID_ORIGIN_LENGTHS,
  RS_TAB_DEFS,
  ALLOWED_RS_TABS,
  FALLBACK_ORIGIN_LABEL_COUNTS,
  METHOD_COL_DEFAULT_WIDTHS,
  METHOD_COL_MIN_WIDTHS,
  METHOD_COL_MAX_WIDTH,
  params,
  inst,
  state,
  els,
  text,
  norm,
  closeConfirm,
};

Object.defineProperties(ctx, {
  programmatic: {
    get: () => programmatic,
    set: (value) => { programmatic = value; },
  },
  isDirty: {
    get: () => isDirty,
    set: (value) => { isDirty = value; },
  },
  cleanSnapshot: {
    get: () => cleanSnapshot,
    set: (value) => { cleanSnapshot = value; },
  },
  datasetTypeItems: {
    get: () => datasetTypeItems,
    set: (value) => { datasetTypeItems = value; },
  },
  cachedRows: {
    get: () => cachedRows,
    set: (value) => { cachedRows = value; },
  },
  notesProgrammatic: {
    get: () => notesProgrammatic,
    set: (value) => { notesProgrammatic = value; },
  },
  lastSavedNotesText: {
    get: () => lastSavedNotesText,
    set: (value) => { lastSavedNotesText = value; },
  },
  rsTabSystem: {
    get: () => rsTabSystem,
    set: (value) => { rsTabSystem = value; },
  },
});

function installResultSelectionPart(name, installer) {
  if (typeof installer !== "function") {
    throw new Error(`Result Selection ${name} module failed to load.`);
  }
  Object.assign(ctx, installer(ctx));
}

const resultSelectionParts = window.ResultSelectionParts || {};
installResultSelectionPart("ui", resultSelectionParts.installUi);
installResultSelectionPart("data", resultSelectionParts.installData);
installResultSelectionPart("grids", resultSelectionParts.installGrids);
installResultSelectionPart("model", resultSelectionParts.installModel);

syncDetailsLabelWidth({
  root: "#rsDetailsPage",
  labelSelector: ".rsDetailsGrid > label, .rsBasisPanel > .rsBasisLabel",
  propertyName: "--rs-details-label-width",
});

ctx.init().catch((err) => {
  console.error("Result Selection initialization failed:", err);
  ctx.postStatus(`Result Selection failed to initialize: ${err?.message || err}`, "error");
});

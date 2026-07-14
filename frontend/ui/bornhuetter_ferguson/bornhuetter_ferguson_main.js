import {
  ensureDatasetOriginLabels,
  formatDatasetOriginLabel,
  validateDatasetOriginLabels,
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
import { createDatasetAuditLog } from "/ui/shared/dataset_audit_log.js?v=20260714b";
import { createBornhuetterFergusonChart } from "/ui/bornhuetter_ferguson/bornhuetter_ferguson_chart.js";
import { createPageCloseConfirm } from "/ui/shared/page_close_confirm.js";
import { createSpreadsheetTableController } from "/ui/shared/spreadsheet_table.js?v=20260712c";

const BF_METHOD_TYPE = "Bornhuetter Ferguson";
const BF_SOURCE_KIND = "bornhuetter_ferguson";
const BF_JSON_FORMAT = "arcrho-bornhuetter-ferguson-method-by-tab-v2";
const DEFAULT_ORIGIN_LENGTH = 12;
const VALID_ORIGIN_LENGTHS = [12, 6, 3, 1];
const BF_TABS = [
  { id: "details", label: "Details" },
  { id: "method", label: "Method" },
  { id: "chart", label: "Chart" },
  { id: "notes", label: "Notes" },
  { id: "audit", label: "Audit Log" },
];
const ALLOWED_BF_TABS = new Set(BF_TABS.map((tab) => tab.id));

const params = new URLSearchParams(window.location.search || "");
const inst = text(params.get("inst")) || `bf_${Date.now()}`;

const state = {
  project: text(params.get("project")),
  reservingClass: text(params.get("class") || params.get("path")),
  cachedRows: [],
  originLabels: [],
  sidecarOriginLabels: [],
  latestValues: [],
  dfmUltimateValues: [],
  priorSources: [],
  priorDragIndex: null,
  selectedPriorValues: [],
  percentDevelopedValues: [],
  newUltimateValues: [],
  showWeights: true,
  showEffectiveWeights: false,
  statisticDecimalPlaces: 1,
  methodHighlight: null,
  methodHighlightDragging: false,
  weightEditSession: null,
};

let cleanSnapshot = "";
let isDirty = false;
let programmatic = false;
let notesProgrammatic = false;
let lastSavedNotesText = "";
let tabbedPage = null;
let bfChart = null;
let sidecarLoadSequence = 0;
const bfCloseConfirm = createPageCloseConfirm({ subject: BF_METHOD_TYPE });
const activeDependencyPreviews = new Map();

const els = {
  title: document.getElementById("bfTitle"),
  subtitle: document.getElementById("bfSubtitle"),
  projectInput: document.getElementById("bfProjectInput"),
  classInput: document.getElementById("bfClassInput"),
  nameInput: document.getElementById("bfNameInput"),
  outputTypeInput: document.getElementById("bfOutputTypeInput"),
  outputTypeBtn: document.getElementById("bfOutputTypeBtn"),
  originLengthInput: document.getElementById("bfOriginLengthInput"),
  originLengthDropdown: document.getElementById("bfOriginLengthDropdown"),
  originLengthButton: document.getElementById("bfOriginLengthButton"),
  originLengthLabel: document.getElementById("bfOriginLengthLabel"),
  originLengthMenu: document.getElementById("bfOriginLengthMenu"),
  latestInput: document.getElementById("bfLatestInput"),
  latestBtn: document.getElementById("bfLatestBtn"),
  dfmInput: document.getElementById("bfDfmInput"),
  dfmBtn: document.getElementById("bfDfmBtn"),
  priorList: document.getElementById("bfPriorList"),
  priorContextMenu: document.getElementById("bfPriorContextMenu"),
  showWeightsInput: document.getElementById("bfShowWeightsInput"),
  weightDisplayDropdown: document.getElementById("bfWeightDisplayDropdown"),
  weightDisplayButton: document.getElementById("bfWeightDisplayButton"),
  weightDisplayLabel: document.getElementById("bfWeightDisplayLabel"),
  weightDisplayMenu: document.getElementById("bfWeightDisplayMenu"),
  methodDecimalsInput: document.getElementById("bfMethodDecimalsInput"),
  methodDecimalsUp: document.getElementById("bfMethodDecimalsUp"),
  methodDecimalsDown: document.getElementById("bfMethodDecimalsDown"),
  methodTable: document.querySelector(".bfMethodTable"),
  methodCols: document.getElementById("bfMethodCols"),
  methodHead: document.getElementById("bfMethodHead"),
  methodGrid: document.getElementById("bfMethodGrid"),
  chartCanvas: document.getElementById("bfChartCanvas"),
  chartLegend: document.getElementById("bfChartLegend"),
  chartEmpty: document.getElementById("bfChartEmpty"),
  chartTooltip: document.getElementById("bfChartTooltip"),
  cellContextMenu: document.getElementById("bfCellContextMenu"),
  auditLogMount: document.getElementById("bfAuditLogMount"),
  notesInput: document.getElementById("bfNotesInput"),
  saveBtn: document.getElementById("bfSaveBtn"),
  cancelBtn: document.getElementById("bfCancelBtn"),
};

const auditLogView = createDatasetAuditLog({
  container: els.auditLogMount,
  ariaLabel: "Bornhuetter Ferguson audit log",
  emptyDescription: "Method saves will appear here after the first save.",
});

const methodSpreadsheetTable = createSpreadsheetTableController({
  getRoot: () => els.methodTable,
  getBounds: () => ({
    maxRow: rowCount(),
    maxCol: methodColumnCount() - 1,
  }),
  readSelection: () => {
    const highlight = state.methodHighlight;
    if (!highlight) return { ranges: [], activeCell: null, anchorCell: null };
    return {
      ranges: [{
        r0: highlight.startRow,
        r1: highlight.endRow,
        c0: highlight.startCol,
        c1: highlight.endCol,
      }],
      activeCell: { r: highlight.endRow, c: highlight.endCol },
      anchorCell: { r: highlight.startRow, c: highlight.startCol },
    };
  },
  writeSelection: ({ ranges, activeCell, anchorCell }) => {
    const range = ranges[0];
    if (!range) {
      state.methodHighlight = null;
      return;
    }
    let anchor = anchorCell || { r: range.r0, c: range.c0 };
    let active = activeCell || { r: range.r1, c: range.c1 };
    const directionalRange = {
      r0: Math.min(anchor.r, active.r),
      r1: Math.max(anchor.r, active.r),
      c0: Math.min(anchor.c, active.c),
      c1: Math.max(anchor.c, active.c),
    };
    if (
      directionalRange.r0 !== range.r0
      || directionalRange.r1 !== range.r1
      || directionalRange.c0 !== range.c0
      || directionalRange.c1 !== range.c1
    ) {
      anchor = { r: range.r0, c: range.c0 };
      active = { r: range.r1, c: range.c1 };
    }
    state.methodHighlight = {
      startCol: anchor.c,
      startRow: anchor.r,
      endCol: active.c,
      endRow: active.r,
    };
  },
  cellSelector: "td.bfMethodCell[data-row-index][data-col-index]",
  rowHeaderSelector: "td.bfOriginCell[data-row-index]",
  columnHeaderSelector: "thead th[data-col-index]",
  getCellPosition: (cell) => ({
    r: Number(cell?.dataset?.rowIndex),
    c: Number(cell?.dataset?.colIndex),
  }),
  getRowHeaderIndex: (header) => Number(header?.dataset?.rowIndex),
  getColumnHeaderIndex: (header) => Number(header?.dataset?.colIndex),
  selectedClasses: ["bfHighlightedCell"],
  anchorClasses: ["bfHighlightAnchorCell", "arSpreadsheetSelectionAnchor"],
  rowSelectedLabelClasses: ["bfHighlightedRowLabel", "arSpreadsheetSelectedLabel"],
  columnSelectedLabelClasses: ["bfHighlightedColumnLabel", "arSpreadsheetSelectedLabel"],
  getCellValue: (_position, cell) => cell?.dataset?.copyValue || "",
  onAfterCopy: () => postStatus("Copied selected Bornhuetter Ferguson values."),
  scrollCellIntoView: scrollMethodCellIntoView,
});

function text(value) {
  return String(value ?? "").trim();
}

function norm(value) {
  return text(value).replace(/\s+/g, " ").toLowerCase();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function validOriginLength(value, fallback = DEFAULT_ORIGIN_LENGTH) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return VALID_ORIGIN_LENGTHS.includes(n) ? n : fallback;
}

function statisticDecimalPlaces(value, fallback = 1) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(8, parsed));
}

function getDetails() {
  return {
    name: text(els.nameInput?.value),
    outputType: text(els.outputTypeInput?.value),
    originLength: validOriginLength(els.originLengthInput?.value),
    latestDataset: text(els.latestInput?.value),
    dfmDataset: text(els.dfmInput?.value),
    priorDatasets: state.priorSources.map((source) => source.name).filter(Boolean),
    showWeights: state.showWeights,
    statisticDecimalPlaces: state.statisticDecimalPlaces,
  };
}

function hasRequiredSourceConfig() {
  const details = getDetails();
  return !!(details.latestDataset && details.dfmDataset && details.priorDatasets.length);
}

function withProgrammatic(fn) {
  programmatic = true;
  try {
    return fn();
  } finally {
    programmatic = false;
  }
}

function getHostApi() {
  if (window.ADAHost) return window.ADAHost;
  try {
    let w = window.parent;
    while (w && w !== window) {
      if (w.ADAHost) return w.ADAHost;
      if (w === w.parent) break;
      w = w.parent;
    }
  } catch {}
  return null;
}

function postStatus(message, tone = "") {
  const msg = text(message);
  try {
    window.parent?.postMessage({ type: "arcrho:status", text: msg, ...(tone ? { tone } : {}) }, "*");
  } catch {}
}

function postDirty(dirty, force = false) {
  const next = !!dirty;
  if (!force && isDirty === next) return;
  isDirty = next;
  updateTabbedPageSaveControls({
    saveButton: els.saveBtn,
    cancelButton: els.cancelBtn,
    dirty: next,
  });
  try {
    window.parent?.postMessage({ type: "arcrho:dataset-dirty", inst, dirty: next }, "*");
  } catch {}
}

function markDirty() {
  if (programmatic) return;
  postDirty(snapshotPayload() !== cleanSnapshot);
}

function syncTitles() {
  const details = getDetails();
  const title = details.name ? `${details.name} - ${BF_METHOD_TYPE}` : BF_METHOD_TYPE;
  document.title = title;
  if (els.title) els.title.textContent = title;
  if (els.subtitle) els.subtitle.textContent = [state.project, state.reservingClass].filter(Boolean).join(" / ");
}

async function getWorkspacePathsConfig() {
  const res = await fetch("/workspace_paths", { cache: "no-store" });
  if (!res.ok) throw new Error(`Workspace paths failed (${res.status}).`);
  const payload = await res.json().catch(() => ({}));
  const config = payload?.config && typeof payload.config === "object" ? payload.config : {};
  const paths = config.paths && typeof config.paths === "object" ? config.paths : {};
  return {
    root: text(config.workspace_root) || "E:\\ArcRho",
    projectsDir: text(paths.projects_dir) || "projects",
  };
}

function isAbsolutePath(value) {
  return /^[A-Za-z]:[\\/]/.test(text(value)) || /^\\\\/.test(text(value));
}

function joinPath(...parts) {
  return parts
    .map((part, index) => {
      const value = text(part);
      if (!value) return "";
      return index === 0 ? value.replace(/[\\/]+$/g, "") : value.replace(/^[\\/]+|[\\/]+$/g, "");
    })
    .filter(Boolean)
    .join("\\");
}

async function getProjectDataDir() {
  const cfg = await getWorkspacePathsConfig();
  const projectsRoot = isAbsolutePath(cfg.projectsDir) ? cfg.projectsDir : joinPath(cfg.root, cfg.projectsDir);
  return joinPath(
    projectsRoot,
    sanitizeFileNamePart(state.project, "UnknownProject"),
    "data",
    sanitizeDataFolderPart(state.reservingClass, "ReservingClass"),
  );
}

async function getMethodsDir() {
  return joinPath(await getProjectDataDir(), "methods");
}

async function getDatasetDir() {
  return joinPath(await getProjectDataDir(), "datasets");
}

function getMethodFilename() {
  return `BF@${sanitizeFileNamePart(getDetails().name || BF_METHOD_TYPE, "Name")}.json`;
}

async function getMethodPath() {
  return `${await getMethodsDir()}\\${getMethodFilename()}`;
}

function getCsvFilenameForLength(originLength) {
  return `${sanitizeFileNamePart(getDetails().name || BF_METHOD_TYPE, "Dataset")}@${validOriginLength(originLength)}.csv`;
}

async function getCsvPath() {
  return `${await getDatasetDir()}\\${getCsvFilenameForLength(getDetails().originLength)}`;
}

function vectorCsv(values) {
  return `${(Array.isArray(values) ? values : []).map((v) => v == null ? "" : String(v)).join("\n")}\n`;
}

function displayNumber(value, decimals = 0) {
  const n = numberOrNull(value);
  if (n === null) return "";
  return n.toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
}

function displayPercent(value) {
  const n = numberOrNull(value);
  if (n === null) return "";
  return `${(n * 100).toLocaleString(undefined, {
    maximumFractionDigits: state.statisticDecimalPlaces,
    minimumFractionDigits: state.statisticDecimalPlaces,
  })}%`;
}

function csvBaseName(value) {
  return text(value).split(/[\\/]/).pop();
}

function stripDatasetCacheVariantSuffix(value) {
  const raw = text(value);
  const stem = raw.replace(/\.csv$/iu, "");
  const parts = stem.split("@");
  if (
    parts.length >= 5
    && /^(dev|cal)$/i.test(parts[parts.length - 1])
    && /^(cum|inc)$/i.test(parts[parts.length - 2])
    && /^\d+$/.test(parts[parts.length - 3])
    && /^\d+$/.test(parts[parts.length - 4])
  ) {
    return parts.slice(0, -4).join("@").trim();
  }
  if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) {
    return parts.slice(0, -1).join("@").trim();
  }
  return raw.replace(/\.[^.]+$/u, "");
}

function normalizeCachedRow(row) {
  const rawName = text(row?.datasetName || row?.dataset_name || row?.name || row?.datasetTypeName || row?.dataset_type);
  const name = stripDatasetCacheVariantSuffix(rawName);
  return {
    ...row,
    name,
    datasetName: name,
    datasetType: text(row?.datasetTypeName || row?.dataset_type || row?.datasetType || name),
    dataFormat: text(row?.dataFormat || row?.data_format || row?.meta?.dataFormat),
    methodType: text(row?.methodType || row?.method_type || row?.meta?.methodType),
    sourceKind: text(row?.sourceKind || row?.source_kind || row?.meta?.sourceKind),
    category: text(row?.category || row?.dataset_category || row?.meta?.category),
    csvFile: text(row?.csvFile || row?.csv_file || row?.meta?.csvFile || csvBaseName(row?.path)),
    originLength: validOriginLength(row?.meta?.originLength ?? row?.originLength ?? row?.origin_length, 0),
  };
}

async function loadCachedRows(force = false) {
  if (!state.project || !state.reservingClass) return [];
  const qs = new URLSearchParams({
    project_name: state.project,
    reserving_class: state.reservingClass,
  });
  if (force) qs.set("refresh", "1");
  const resp = await fetch(`/datasets/cached?${qs.toString()}`, { cache: "no-store" });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok || payload?.ok === false) throw new Error(payload?.detail || payload?.error || `Dataset cache failed (${resp.status}).`);
  const rows = Array.isArray(payload?.files)
    ? payload.files
    : Array.isArray(payload?.rows)
      ? payload.rows
      : Array.isArray(payload?.items)
        ? payload.items
        : Array.isArray(payload?.datasets)
          ? payload.datasets
          : [];
  state.cachedRows = rows.map(normalizeCachedRow).filter((row) => row.name);
  return state.cachedRows;
}

function cachedRecordByName(name) {
  const key = norm(name);
  return state.cachedRows.find((row) => norm(row.name) === key || norm(row.datasetType) === key) || null;
}

async function loadDatasetValues(datasetName, options = {}) {
  const name = text(datasetName);
  if (!state.project || !state.reservingClass || !name) throw new Error("Missing project, reserving class, or dataset name.");
  const body = {
    project_name: state.project,
    reserving_class: state.reservingClass,
    dataset_name: name,
  };
  const csvFile = text(options.csvFile || options.csv_file);
  const originLength = validOriginLength(options.originLength ?? options.origin_length, 0);
  const developmentLength = validOriginLength(options.developmentLength ?? options.development_length, 0);
  if (csvFile) body.csv_file = csvFile;
  if (originLength && developmentLength) {
    body.origin_length = originLength;
    body.development_length = developmentLength;
    body.cumulative = options.cumulative !== false;
    body.calendar = !!options.calendar;
  }
  const resp = await fetch("/dataset/cache/load", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok || payload?.ok === false) throw new Error(payload?.detail || payload?.error || `Dataset load failed (${resp.status}).`);
  return payload;
}

async function loadConfiguredSourcePayload(datasetName, details = getDetails()) {
  const record = cachedRecordByName(datasetName);
  return loadDatasetValues(datasetName, {
    csvFile: record?.csvFile,
    originLength: record?.originLength || details.originLength,
    developmentLength: record?.originLength || details.originLength,
    cumulative: true,
    calendar: false,
  });
}

function latestDiagonal(values) {
  const rows = Array.isArray(values) ? values : [];
  return rows.map((row) => {
    const cells = Array.isArray(row) ? row : [row];
    for (let i = cells.length - 1; i >= 0; i -= 1) {
      const n = numberOrNull(cells[i]);
      if (n !== null) return n;
    }
    return null;
  });
}

function vectorValues(values) {
  const rows = Array.isArray(values) ? values : [];
  return rows.map((row) => {
    if (Array.isArray(row)) return numberOrNull(row[0]);
    return numberOrNull(row);
  });
}

function sourceRowCount() {
  const priorValueCount = state.priorSources.reduce((max, source) => Math.max(max, source.values?.length || 0), 0);
  return Math.max(
    state.latestValues.length,
    state.dfmUltimateValues.length,
    priorValueCount,
  );
}

function rowCount() {
  return Math.max(
    state.originLabels.length,
    sourceRowCount(),
    1,
  );
}

function normalizePriorWeights(weights, count, fallback = 1) {
  const source = Array.isArray(weights) ? weights : [];
  return Array.from({ length: count }, (_, index) => Math.max(0, numberOrNull(source[index]) ?? fallback));
}

function normalizePriorSource(raw, count = rowCount()) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    name: text(source.name || source.dataset_name || source.dataset),
    values: Array.isArray(source.values) ? source.values.map(numberOrNull) : [],
    weights: normalizePriorWeights(source.weights, count, 1),
  };
}

function normalizedReservingClassPath(value) {
  return text(value).replace(/\\+/g, "\\").toLowerCase();
}

function dependencyMessageNames(message = {}) {
  return new Set([
    ...(Array.isArray(message.names) ? message.names : []),
    message.datasetName,
    message.datasetTypeName,
    message.name,
  ].map(norm).filter(Boolean));
}

function dependencyMessageMatchesContext(message = {}) {
  if (!message || typeof message !== "object") return false;
  if (text(message.inst) && text(message.inst) === inst) return false;
  const project = text(message.project || message.project_name);
  if (project && norm(project) !== norm(state.project)) return false;
  const reservingClass = text(message.reservingClass || message.reserving_class);
  if (reservingClass && normalizedReservingClassPath(reservingClass) !== normalizedReservingClassPath(state.reservingClass)) return false;
  return true;
}

function dependencyRolesMatchingMessage(message = {}) {
  if (!dependencyMessageMatchesContext(message)) return [];
  const names = dependencyMessageNames(message);
  if (!names.size) return [];
  const details = getDetails();
  const roles = [];
  if (details.latestDataset && names.has(norm(details.latestDataset))) {
    roles.push({ key: "latest", kind: "latest", name: details.latestDataset });
  }
  if (details.dfmDataset && names.has(norm(details.dfmDataset))) {
    roles.push({ key: "dfm", kind: "dfm", name: details.dfmDataset });
  }
  for (const source of state.priorSources) {
    if (!source?.name || !names.has(norm(source.name))) continue;
    roles.push({ key: `prior:${norm(source.name)}`, kind: "prior", name: source.name });
  }
  return roles;
}

function dependencyPreviewValues(message = {}) {
  if (Array.isArray(message.values)) return message.values.map(numberOrNull);
  const matrix = Array.isArray(message.matrixValues)
    ? message.matrixValues
    : (Array.isArray(message.matrix_values) ? message.matrix_values : []);
  if (!matrix.length) return [];
  return norm(message.dataFormat || message.data_format) === "triangle"
    ? latestDiagonal(matrix)
    : vectorValues(matrix);
}

function applyDependencyValuesToRole(role, values) {
  const normalizedValues = Array.isArray(values) ? values.map(numberOrNull) : [];
  if (role.kind === "latest") {
    state.latestValues = normalizedValues;
    return true;
  }
  if (role.kind === "dfm") {
    state.dfmUltimateValues = normalizedValues;
    return true;
  }
  if (role.kind === "prior") {
    const source = state.priorSources.find((item) => norm(item.name) === norm(role.name));
    if (!source) return false;
    source.values = normalizedValues;
    source.weights = normalizePriorWeights(source.weights, Math.max(normalizedValues.length, rowCount()), 1);
    return true;
  }
  return false;
}

function reapplyActiveDependencyPreviews() {
  let changed = false;
  for (const [roleKey, preview] of Array.from(activeDependencyPreviews.entries())) {
    const role = dependencyRolesMatchingMessage(preview.message).find((item) => item.key === roleKey);
    if (!role) {
      activeDependencyPreviews.delete(roleKey);
      continue;
    }
    changed = applyDependencyValuesToRole(role, preview.values) || changed;
  }
  return changed;
}

function applyDependencySourcePreview(message = {}) {
  const roles = dependencyRolesMatchingMessage(message);
  const values = dependencyPreviewValues(message);
  if (!roles.length || !values.length) return false;
  let changed = false;
  for (const role of roles) {
    activeDependencyPreviews.set(role.key, { message: { ...message }, values: values.slice() });
    changed = applyDependencyValuesToRole(role, values) || changed;
  }
  if (!changed) return false;
  calculateOutputs();
  renderMethodGrid();
  return true;
}

async function reloadDependencyRolesFromDisk(roles, { refreshCache = false } = {}) {
  if (!Array.isArray(roles) || !roles.length) return false;
  if (refreshCache) await loadCachedRows(true).catch(() => {});
  const details = getDetails();
  const loaded = await Promise.all(roles.map(async (role) => {
    const payload = await loadConfiguredSourcePayload(role.name, details);
    return {
      role,
      values: role.kind === "latest" ? latestDiagonal(payload?.values) : vectorValues(payload?.values),
    };
  }));
  for (const item of loaded) applyDependencyValuesToRole(item.role, item.values);
  reapplyActiveDependencyPreviews();
  calculateOutputs();
  renderMethodGrid();
  return true;
}

async function clearDependencySourcePreview(message = {}) {
  const roles = dependencyRolesMatchingMessage(message)
    .filter((role) => activeDependencyPreviews.has(role.key));
  if (!roles.length) return false;
  for (const role of roles) activeDependencyPreviews.delete(role.key);
  const reason = norm(message.reason);
  return reloadDependencyRolesFromDisk(roles, {
    refreshCache: reason === "save" || reason === "clean",
  });
}

function renderPriorSourceList() {
  if (!els.priorList) return;
  const sources = state.priorSources.length
    ? state.priorSources.map((source, sourceIndex) => `
    <span class="bfPriorToken" role="listitem" draggable="true" data-prior-token-index="${sourceIndex}" title="${escapeHtml(source.name)}">
      <button class="bfPriorOpen" type="button" data-prior-open-index="${sourceIndex}" aria-label="Open dataset ${escapeHtml(source.name)}">
        <span class="bfPriorTokenLabel">${escapeHtml(source.name)}</span>
      </button>
    </span>`).join("")
    : '<span class="bfPriorEmpty" role="listitem">Select one or more prior vectors.</span>';
  els.priorList.innerHTML = `${sources}
    <span class="bfPriorAddSlot" role="listitem">
      <button class="bfPriorAdd" id="bfPriorAddBtn" type="button" data-prior-add title="Add prior vector" aria-label="Add prior vector">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>
      </button>
    </span>`;
}

function openPriorDataset(sourceIndex) {
  const source = state.priorSources[sourceIndex];
  const datasetName = text(source?.name);
  if (!datasetName) return;
  if (window.parent === window) {
    postStatus("Prior datasets open from a Project Instance window.", "warn");
    return;
  }
  const record = cachedRecordByName(datasetName);
  try {
    window.parent?.postMessage({
      type: "arcrho:project-instance-open-dependent-dataset",
      inst,
      datasetName,
      datasetTypeName: text(record?.datasetType) || datasetName,
      methodType: text(record?.methodType),
      openMethod: false,
      projectName: state.project,
      reservingClass: state.reservingClass,
    }, "*");
    postStatus(`Opening dataset: ${datasetName}`);
  } catch {
    postStatus(`Could not open dataset: ${datasetName}`, "error");
  }
}

function closePriorContextMenu() {
  if (!els.priorContextMenu) return;
  els.priorContextMenu.classList.remove("open");
  els.priorContextMenu.setAttribute("aria-hidden", "true");
  delete els.priorContextMenu.dataset.priorIndex;
}

function openPriorContextMenu(event, sourceIndex) {
  if (!els.priorContextMenu || !state.priorSources[sourceIndex]) return;
  event.preventDefault();
  event.stopPropagation();
  closeMethodCellContextMenu();
  els.priorContextMenu.dataset.priorIndex = String(sourceIndex);
  els.priorContextMenu.classList.add("open");
  els.priorContextMenu.setAttribute("aria-hidden", "false");
  const rect = els.priorContextMenu.getBoundingClientRect();
  els.priorContextMenu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8))}px`;
  els.priorContextMenu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8))}px`;
}

function resetPriorDragState() {
  state.priorDragIndex = null;
  els.priorList?.classList.remove("bfPriorDragActive", "bfPriorDragOutside");
  els.priorList?.querySelector(".bfPriorDragging")?.classList.remove("bfPriorDragging");
}

function addPriorSource(name) {
  const clean = text(name);
  if (!clean || state.priorSources.some((source) => norm(source.name) === norm(clean))) return false;
  state.priorSources.push({ name: clean, values: [], weights: normalizePriorWeights([], rowCount(), 1) });
  renderPriorSourceList();
  return true;
}

async function removePriorSource(sourceIndex) {
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= state.priorSources.length) return;
  state.priorSources.splice(sourceIndex, 1);
  renderPriorSourceList();
  await refreshCalculations({ mark: false }).catch((err) => postStatus(`Prior refresh failed: ${String(err?.message || err)}`, "error"));
  markDirty();
}

function originLabel(index) {
  const label = text(state.originLabels[index]);
  return label ? formatDatasetOriginLabel(label, getDetails().originLength) : "";
}

async function refreshOriginLabels({ render = true } = {}) {
  const details = getDetails();
  const expectedCount = sourceRowCount();
  const validationOptions = {
    originLen: details.originLength,
    requireMatchingPeriod: true,
    ...(expectedCount > 0 ? { expectedCount } : {}),
  };
  const current = validateDatasetOriginLabels(state.originLabels, validationOptions);
  const sidecar = validateDatasetOriginLabels(state.sidecarOriginLabels, validationOptions);
  if (current.ok) state.originLabels = current.labels;
  else if (sidecar.ok) state.originLabels = sidecar.labels;
  else {
    state.originLabels = [];
    state.originLabels = await ensureDatasetOriginLabels(state.project, details.originLength, {
      requireMatchingPeriod: true,
      ...(expectedCount > 0 ? { expectedCount } : {}),
    });
  }
  if (render) renderMethodGrid();
}

function clearCalculatedOutputs() {
  state.percentDevelopedValues = [];
  state.selectedPriorValues = [];
  state.newUltimateValues = [];
}

function calculateOutputs() {
  const count = rowCount();
  clearCalculatedOutputs();
  for (let i = 0; i < count; i += 1) {
    const latest = numberOrNull(state.latestValues[i]);
    const dfmUltimate = numberOrNull(state.dfmUltimateValues[i]);
    const pct = latest !== null && dfmUltimate !== null && dfmUltimate !== 0 ? latest / dfmUltimate : null;
    let priorNumerator = 0;
    let priorDenominator = 0;
    for (const source of state.priorSources) {
      const prior = numberOrNull(source.values?.[i]);
      const weight = Math.max(0, numberOrNull(source.weights?.[i]) ?? 0);
      if (prior === null || weight <= 0) continue;
      priorNumerator += prior * weight;
      priorDenominator += weight;
    }
    const selectedPrior = priorDenominator > 0 ? priorNumerator / priorDenominator : null;
    let ultimate = null;
    if (latest !== null) {
      ultimate = selectedPrior === null
        ? latest
        : pct !== null
          ? Math.round(latest + (1 - pct) * selectedPrior)
          : null;
    }
    state.percentDevelopedValues.push(pct);
    state.selectedPriorValues.push(selectedPrior);
    state.newUltimateValues.push(ultimate);
  }
  renderBfChart();
}

function renderBfChart() {
  bfChart?.render({
    originLabels: Array.from({ length: rowCount() }, (_, index) => originLabel(index)),
    latestValues: state.latestValues,
    percentDevelopedValues: state.percentDevelopedValues,
    selectedPriorValues: state.selectedPriorValues,
    newUltimateValues: state.newUltimateValues,
    decimalPlaces: state.statisticDecimalPlaces,
  });
}

async function refreshOriginLabelsForCalculations() {
  try {
    await refreshOriginLabels({ render: false });
  } catch (err) {
    clearCalculatedOutputs();
    renderMethodGrid();
    renderBfChart();
    throw err;
  }
}

async function refreshCalculations({ mark = false } = {}) {
  const details = getDetails();
  if (!details.latestDataset || !details.dfmDataset) {
    reapplyActiveDependencyPreviews();
    await refreshOriginLabelsForCalculations();
    calculateOutputs();
    renderMethodGrid();
    if (mark) markDirty();
    return;
  }
  const latestPayload = await loadConfiguredSourcePayload(details.latestDataset, details);
  const dfmPayload = await loadConfiguredSourcePayload(details.dfmDataset, details);
  const priorSources = await Promise.all(state.priorSources.map(async (source) => {
    try {
      const payload = await loadConfiguredSourcePayload(source.name, details);
      const values = vectorValues(payload?.values);
      return {
        ...source,
        values,
        weights: normalizePriorWeights(source.weights, Math.max(values.length, rowCount()), 1),
      };
    } catch (err) {
      postStatus(`Prior source unavailable (${source.name}): ${String(err?.message || err)}`, "warn");
      return { ...source, values: [] };
    }
  }));
  state.latestValues = latestDiagonal(latestPayload?.values);
  state.dfmUltimateValues = vectorValues(dfmPayload?.values);
  state.priorSources = priorSources;
  reapplyActiveDependencyPreviews();
  const labels = Array.isArray(latestPayload?.origin_labels) ? latestPayload.origin_labels : [];
  if (!state.originLabels.length && labels.length) state.originLabels = labels.map(String);
  await refreshOriginLabelsForCalculations();
  calculateOutputs();
  renderMethodGrid();
  if (mark) markDirty();
}

function sumMethodValues(values) {
  const numbers = (Array.isArray(values) ? values : []).map(numberOrNull).filter((value) => value !== null);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) : null;
}

function methodColumns() {
  const columns = [
    { type: "origin", label: "Accident Year", className: "bfOriginCell", colClass: "bfMethodOriginCol" },
    { type: "latest", label: "Latest", className: "bfLatestCell", colClass: "bfMethodValueCol" },
    { type: "percentage", label: "Percentage Developed", className: "bfPercentCell", colClass: "bfMethodValueCol" },
  ];
  state.priorSources.forEach((source, sourceIndex) => {
    columns.push({ type: "prior", label: source.name, sourceIndex, className: "bfPriorCell", colClass: "bfMethodValueCol" });
    if (state.showWeights) {
      columns.push({
        type: "weight",
        label: state.showEffectiveWeights ? "Weight %" : "Weight",
        sourceIndex,
        className: "bfWeightCell",
        colClass: "bfMethodWeightCol",
      });
    }
  });
  columns.push(
    { type: "selectedPrior", label: "Selected Prior", className: "bfSelectedPriorCell", colClass: "bfMethodValueCol" },
    { type: "ultimate", label: "New Ultimate", className: "bfUltimateCell", colClass: "bfMethodValueCol" },
  );
  return columns;
}

function methodColumnCount() {
  return methodColumns().length;
}

function effectivePriorWeight(sourceIndex, rowIndex) {
  const source = state.priorSources[sourceIndex];
  if (!source || numberOrNull(source.values?.[rowIndex]) === null) return null;
  const targetWeight = Math.max(0, numberOrNull(source.weights?.[rowIndex]) ?? 0);
  let denominator = 0;
  for (const prior of state.priorSources) {
    if (numberOrNull(prior.values?.[rowIndex]) === null) continue;
    denominator += Math.max(0, numberOrNull(prior.weights?.[rowIndex]) ?? 0);
  }
  return denominator > 0 ? targetWeight / denominator : 0;
}

function displayWeight(sourceIndex, rowIndex) {
  if (numberOrNull(state.priorSources[sourceIndex]?.values?.[rowIndex]) === null) return "";
  if (state.showEffectiveWeights) {
    const value = effectivePriorWeight(sourceIndex, rowIndex);
    return value === null ? "" : `${(value * 100).toFixed(state.statisticDecimalPlaces)}%`;
  }
  const value = numberOrNull(state.priorSources[sourceIndex]?.weights?.[rowIndex]);
  return value === null ? "0.0" : value.toFixed(1);
}

function methodCellDisplay(column, rowIndex, count = rowCount()) {
  if (rowIndex === count) {
    if (column.type === "origin") return "Total";
    if (column.type === "latest") return displayNumber(sumMethodValues(state.latestValues));
    if (column.type === "prior") return displayNumber(sumMethodValues(state.priorSources[column.sourceIndex]?.values));
    if (column.type === "selectedPrior") return displayNumber(sumMethodValues(state.selectedPriorValues));
    if (column.type === "ultimate") return displayNumber(sumMethodValues(state.newUltimateValues));
    return "";
  }
  if (column.type === "origin") return originLabel(rowIndex);
  if (column.type === "latest") return displayNumber(state.latestValues[rowIndex]);
  if (column.type === "percentage") return displayPercent(state.percentDevelopedValues[rowIndex]);
  if (column.type === "prior") return displayNumber(state.priorSources[column.sourceIndex]?.values?.[rowIndex]);
  if (column.type === "weight") return displayWeight(column.sourceIndex, rowIndex);
  if (column.type === "selectedPrior") return displayNumber(state.selectedPriorValues[rowIndex]);
  if (column.type === "ultimate") return displayNumber(state.newUltimateValues[rowIndex]);
  return "";
}

function normalizedMethodHighlight() {
  const highlight = state.methodHighlight;
  if (!highlight) return null;
  const lastRow = rowCount();
  const clampCol = (value) => Math.max(0, Math.min(methodColumnCount() - 1, Number(value) || 0));
  const clampRow = (value) => Math.max(0, Math.min(lastRow, Number(value) || 0));
  const firstCol = clampCol(highlight.startCol);
  const lastCol = clampCol(highlight.endCol);
  const firstRow = clampRow(highlight.startRow);
  const endRow = clampRow(highlight.endRow);
  return {
    startCol: Math.min(firstCol, lastCol),
    endCol: Math.max(firstCol, lastCol),
    startRow: Math.min(firstRow, endRow),
    endRow: Math.max(firstRow, endRow),
  };
}

function applyMethodHighlightDom() {
  methodSpreadsheetTable.applyDom();
}

function focusMethodTable() {
  try {
    els.methodTable?.focus({ preventScroll: true });
  } catch {
    els.methodTable?.focus?.();
  }
}

function clearMethodHighlight() {
  state.methodHighlightDragging = false;
  methodSpreadsheetTable.clear();
}

function methodCellAt(colIndex, rowIndex) {
  return els.methodGrid?.querySelector(`.bfMethodCell[data-col-index="${colIndex}"][data-row-index="${rowIndex}"]`) || null;
}

function scrollMethodCellIntoView({ r, c }) {
  const table = els.methodTable;
  const host = table?.closest(".bfTableWrap");
  if (!host) return;
  const cell = methodCellAt(c, r);
  if (!cell) return;
  const hostRect = host.getBoundingClientRect();
  const cellRect = cell.getBoundingClientRect();
  const headerHeight = table.tHead?.getBoundingClientRect().height || 0;
  const originWidth = table.querySelector("tbody td:first-child")?.getBoundingClientRect().width || 0;
  const visibleTop = hostRect.top + headerHeight;
  const visibleLeft = hostRect.left + (c > 0 ? originWidth : 0);
  if (cellRect.top < visibleTop) host.scrollTop -= visibleTop - cellRect.top;
  else if (cellRect.bottom > hostRect.bottom) host.scrollTop += cellRect.bottom - hostRect.bottom;
  if (cellRect.left < visibleLeft) host.scrollLeft -= visibleLeft - cellRect.left;
  else if (cellRect.right > hostRect.right) host.scrollLeft += cellRect.right - hostRect.right;
}

async function copyHighlightedMethodValues() {
  return methodSpreadsheetTable.copy();
}

async function readMethodClipboardText() {
  if (!navigator.clipboard?.readText) throw new Error("Clipboard paste is not available in this browser.");
  return navigator.clipboard.readText();
}

function setPriorWeight(sourceIndex, rowIndex, rawValue) {
  const source = state.priorSources[sourceIndex];
  if (!source || rowIndex < 0 || rowIndex >= rowCount() || numberOrNull(source.values?.[rowIndex]) === null) return false;
  const value = Math.max(0, numberOrNull(rawValue) ?? 0);
  while (source.weights.length <= rowIndex) source.weights.push(1);
  source.weights[rowIndex] = value;
  return true;
}

function highlightedWeightTargets() {
  const highlight = normalizedMethodHighlight();
  const columns = methodColumns();
  if (!highlight) return [];
  const targets = [];
  const seen = new Set();
  for (let rowIndex = highlight.startRow; rowIndex <= Math.min(highlight.endRow, rowCount() - 1); rowIndex += 1) {
    for (let colIndex = highlight.startCol; colIndex <= highlight.endCol; colIndex += 1) {
      const column = columns[colIndex];
      if (!column || (column.type !== "prior" && column.type !== "weight")) continue;
      if (numberOrNull(state.priorSources[column.sourceIndex]?.values?.[rowIndex]) === null) continue;
      const key = `${column.sourceIndex}:${rowIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ sourceIndex: column.sourceIndex, rowIndex, colIndex });
    }
  }
  return targets;
}

function finishWeightEdit() {
  calculateOutputs();
  renderMethodGrid();
  markDirty();
}

function applyHighlightedWeightValue(rawValue) {
  const targets = highlightedWeightTargets();
  if (!targets.length) return false;
  let changed = false;
  for (const target of targets) changed = setPriorWeight(target.sourceIndex, target.rowIndex, rawValue) || changed;
  if (changed) finishWeightEdit();
  return changed;
}

function applyHighlightedWeightKey(key) {
  if (!/^[0-9.]$/.test(key || "") || !highlightedWeightTargets().length) return false;
  const highlight = normalizedMethodHighlight();
  const sessionKey = highlight ? `${highlight.startCol}:${highlight.startRow}:${highlight.endCol}:${highlight.endRow}` : "";
  const current = state.weightEditSession?.key === sessionKey ? state.weightEditSession.value : "";
  if (key === "." && current.includes(".")) return false;
  const next = current ? `${current}${key}` : key === "." ? "0." : key;
  state.weightEditSession = { key: sessionKey, value: next };
  return applyHighlightedWeightValue(next);
}

async function pasteHighlightedWeights() {
  const raw = await readMethodClipboardText();
  const highlight = normalizedMethodHighlight();
  if (!raw || !highlight) return false;
  const grid = String(raw).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((row, index, rows) => row || index < rows.length - 1).map((row) => row.split("\t"));
  if (!grid.length) return false;
  if (grid.length === 1 && grid[0].length === 1) return applyHighlightedWeightValue(grid[0][0]);
  const columns = methodColumns();
  let changed = false;
  const visited = new Set();
  for (let rowIndex = highlight.startRow; rowIndex <= Math.min(rowCount() - 1, highlight.startRow + grid.length - 1); rowIndex += 1) {
    for (let colIndex = highlight.startCol; colIndex <= Math.min(columns.length - 1, highlight.startCol + grid[rowIndex - highlight.startRow].length - 1); colIndex += 1) {
      const column = columns[colIndex];
      if (!column || (column.type !== "prior" && column.type !== "weight")) continue;
      const key = `${column.sourceIndex}:${rowIndex}`;
      if (visited.has(key)) continue;
      visited.add(key);
      changed = setPriorWeight(column.sourceIndex, rowIndex, grid[rowIndex - highlight.startRow][colIndex - highlight.startCol]) || changed;
    }
  }
  if (changed) finishWeightEdit();
  return changed;
}

function closeMethodCellContextMenu() {
  if (!els.cellContextMenu) return;
  els.cellContextMenu.classList.remove("open");
  els.cellContextMenu.setAttribute("aria-hidden", "true");
}

function openMethodCellContextMenu(event, colIndex, rowIndex) {
  const menu = els.cellContextMenu;
  if (!menu) return;
  event.preventDefault();
  methodSpreadsheetTable.prepareContextCell({ r: rowIndex, c: colIndex });
  const pasteButton = menu.querySelector('[data-bf-cell-action="paste"]');
  if (pasteButton) pasteButton.hidden = !highlightedWeightTargets().length;
  menu.classList.add("open");
  menu.setAttribute("aria-hidden", "false");
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8))}px`;
}

function wireMethodGridInteractions() {
  const table = els.methodTable;
  if (!table) return;
  table.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    closeMethodCellContextMenu();
    const header = event.target.closest("thead th[data-col-index]");
    if (header) {
      event.preventDefault();
      const colIndex = Number(header.dataset.colIndex);
      methodSpreadsheetTable.selectColumn(colIndex, { extend: event.shiftKey });
      focusMethodTable();
      return;
    }
    const cell = event.target.closest("td.bfMethodCell");
    if (!cell) return;
    event.preventDefault();
    const colIndex = Number(cell.dataset.colIndex);
    const rowIndex = Number(cell.dataset.rowIndex);
    if (colIndex === 0) {
      methodSpreadsheetTable.selectRow(rowIndex, { extend: event.shiftKey });
    } else {
      methodSpreadsheetTable.selectCell({ r: rowIndex, c: colIndex }, { extend: event.shiftKey });
    }
    state.weightEditSession = null;
    state.methodHighlightDragging = colIndex !== 0;
    focusMethodTable();
  });
  table.addEventListener("dblclick", (event) => {
    const cell = event.target.closest('td.bfMethodCell[data-cell-type="prior"], td.bfMethodCell[data-cell-type="weight"]');
    if (!cell) return;
    if (cell.dataset.cellType === "weight" && state.showEffectiveWeights) return;
    event.preventDefault();
    event.stopPropagation();
    const sourceIndex = Number(cell.dataset.sourceIndex);
    const rowIndex = Number(cell.dataset.rowIndex);
    const current = Math.max(0, numberOrNull(state.priorSources[sourceIndex]?.weights?.[rowIndex]) ?? 0);
    if (setPriorWeight(sourceIndex, rowIndex, current === 0 ? 1 : 0)) finishWeightEdit();
  });
  table.addEventListener("mouseover", (event) => {
    if (!state.methodHighlightDragging || !(event.buttons & 1)) return;
    const cell = event.target.closest("td.bfMethodCell");
    if (!cell) return;
    const anchor = methodSpreadsheetTable.selection().anchorCell;
    if (!anchor) return;
    methodSpreadsheetTable.setRange(anchor, {
      r: Number(cell.dataset.rowIndex),
      c: Number(cell.dataset.colIndex),
    });
  });
  document.addEventListener("mouseup", () => {
    state.methodHighlightDragging = false;
  });
  table.addEventListener("contextmenu", (event) => {
    const cell = event.target.closest("td.bfMethodCell");
    if (!cell) return;
    openMethodCellContextMenu(event, Number(cell.dataset.colIndex), Number(cell.dataset.rowIndex));
  });
  els.cellContextMenu?.addEventListener("click", (event) => {
    const action = event.target.closest("button[data-bf-cell-action]")?.dataset.bfCellAction;
    if (action === "copy") {
      void copyHighlightedMethodValues().catch((err) => postStatus(`Copy failed: ${String(err?.message || err)}`, "error"));
    } else if (action === "paste") {
      void pasteHighlightedWeights().catch((err) => postStatus(`Paste failed: ${String(err?.message || err)}`, "error"));
    } else if (action === "remove-highlights") {
      clearMethodHighlight();
    }
    closeMethodCellContextMenu();
    focusMethodTable();
  });
  document.addEventListener("mousedown", (event) => {
    if (!els.cellContextMenu?.classList.contains("open")) return;
    if (!event.target.closest("#bfCellContextMenu")) closeMethodCellContextMenu();
  });
  table.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.methodHighlight) {
      event.preventDefault();
      closeMethodCellContextMenu();
      clearMethodHighlight();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && state.methodHighlight) {
      event.preventDefault();
      void copyHighlightedMethodValues().catch((err) => postStatus(`Copy failed: ${String(err?.message || err)}`, "error"));
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v" && state.methodHighlight) {
      event.preventDefault();
      void pasteHighlightedWeights().catch((err) => postStatus(`Paste failed: ${String(err?.message || err)}`, "error"));
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && highlightedWeightTargets().length) {
      event.preventDefault();
      state.weightEditSession = null;
      applyHighlightedWeightValue(0);
      return;
    }
    if (!event.ctrlKey && !event.metaKey && !event.altKey && applyHighlightedWeightKey(event.key)) {
      event.preventDefault();
      return;
    }
    const deltas = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const delta = deltas[event.key];
    if (!delta || event.altKey || !state.methodHighlight) return;
    if (methodSpreadsheetTable.move(delta[1], delta[0], {
      extend: event.shiftKey,
      jump: event.ctrlKey || event.metaKey,
    })) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
}

function methodCellMarkup(value, column, colIndex, rowIndex) {
  const display = String(value ?? "");
  const isNullCell = rowIndex < rowCount() && display === "";
  const visibleDisplay = isNullCell ? "null" : display;
  const source = Number.isInteger(column.sourceIndex) ? state.priorSources[column.sourceIndex] : null;
  const weight = source ? Math.max(0, numberOrNull(source.weights?.[rowIndex]) ?? 0) : 0;
  const hasSourceValue = source ? numberOrNull(source.values?.[rowIndex]) !== null : false;
  const classes = ["bfMethodCell", column.className || ""];
  if (isNullCell) classes.push("bfNullCell");
  if (column.type === "prior" && rowIndex < rowCount() && hasSourceValue && weight > 0) classes.push("bfSelectedSourceCell");
  if (column.type === "weight" && rowIndex < rowCount() && hasSourceValue && weight > 0) classes.push("bfWeightNonZero");
  const sourceAttr = Number.isInteger(column.sourceIndex) ? ` data-source-index="${column.sourceIndex}"` : "";
  return `<td class="${classes.join(" ")}" data-col-index="${colIndex}" data-row-index="${rowIndex}" data-cell-type="${column.type}"${sourceAttr} data-copy-value="${escapeHtml(display)}" aria-selected="false">${escapeHtml(visibleDisplay)}</td>`;
}

function renderMethodGrid() {
  if (!els.methodGrid || !els.methodHead || !els.methodCols) return;
  const count = rowCount();
  const columns = methodColumns();
  els.methodCols.innerHTML = columns.map((column) => `<col class="${column.colClass}">`).join("");
  els.methodHead.innerHTML = `<tr>${columns.map((column, colIndex) => `<th class="${column.type === "weight" ? "bfWeightHeader" : ""}" data-col-index="${colIndex}"><span class="bfMethodHeaderText">${escapeHtml(column.label)}</span></th>`).join("")}</tr>`;
  const rows = [];
  for (let rowIndex = 0; rowIndex < count; rowIndex += 1) {
    rows.push(`<tr>${columns.map((column, colIndex) => methodCellMarkup(methodCellDisplay(column, rowIndex, count), column, colIndex, rowIndex)).join("")}</tr>`);
  }
  rows.push(`<tr class="bfTotalRow">${columns.map((column, colIndex) => methodCellMarkup(methodCellDisplay(column, count, count), column, colIndex, count)).join("")}</tr>`);
  els.methodGrid.innerHTML = rows.join("");
  applyMethodHighlightDom();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function roundJsonNumber(value) {
  const n = numberOrNull(value);
  if (n === null) return null;
  return Math.round(n * 1000000) / 1000000;
}

function roundJsonVector(values) {
  return Array.isArray(values) ? values.map(roundJsonNumber) : [];
}

function buildPayload() {
  const details = getDetails();
  const count = rowCount();
  return {
    json_format: BF_JSON_FORMAT,
    details_tab: {
      name: details.name,
      method_type: BF_METHOD_TYPE,
      output_type: details.outputType,
      origin_length: details.originLength,
      statistic_decimal_places: details.statisticDecimalPlaces,
    },
    method_tab: {
      latest_dataset: details.latestDataset,
      dfm_dataset: details.dfmDataset,
      show_weights: details.showWeights,
      prior_datasets: state.priorSources.map((source) => ({
        name: source.name,
        values: roundJsonVector(Array.from({ length: count }, (_, index) => source.values?.[index] ?? null)),
        weights: roundJsonVector(normalizePriorWeights(source.weights, count, 1)),
      })),
      origin_labels: Array.from({ length: count }, (_, i) => originLabel(i)),
      latest_values: roundJsonVector(state.latestValues),
      dfm_ultimate_values: roundJsonVector(state.dfmUltimateValues),
      percentage_developed: roundJsonVector(state.percentDevelopedValues),
      selected_prior_values: roundJsonVector(state.selectedPriorValues),
      new_ultimate: roundJsonVector(state.newUltimateValues),
    },
    chart_tab: {},
    notes_tab: {
      notes: els.notesInput?.value || "",
    },
    audit_log_tab: {},
    method_metadata: {
      method_type: BF_METHOD_TYPE,
      source_kind: BF_SOURCE_KIND,
      last_modified: new Date().toISOString(),
    },
  };
}

async function applyPayload(payload) {
  const data = payload && typeof payload === "object" ? payload : {};
  const details = data.details_tab || {};
  const method = data.method_tab || {};
  withProgrammatic(() => {
    els.nameInput.value = text(details.name || els.nameInput.value);
    els.outputTypeInput.value = text(details.output_type || els.outputTypeInput.value);
    els.originLengthInput.value = String(validOriginLength(details.origin_length || els.originLengthInput.value));
    els.latestInput.value = text(method.latest_dataset || els.latestInput.value);
    els.dfmInput.value = text(method.dfm_dataset || els.dfmInput.value);
    setNotesText(text(data.notes_tab?.notes));
  });
  syncOriginLengthControl();
  state.statisticDecimalPlaces = statisticDecimalPlaces(details.statistic_decimal_places, 1);
  state.showWeights = method.show_weights !== false;
  state.originLabels = Array.isArray(method.origin_labels) ? method.origin_labels.map(String) : [];
  state.latestValues = Array.isArray(method.latest_values) ? method.latest_values.map(numberOrNull) : [];
  state.dfmUltimateValues = Array.isArray(method.dfm_ultimate_values) ? method.dfm_ultimate_values.map(numberOrNull) : [];
  state.percentDevelopedValues = Array.isArray(method.percentage_developed) ? method.percentage_developed.map(numberOrNull) : [];
  const storedPriorSources = Array.isArray(method.prior_datasets)
    ? method.prior_datasets
    : text(method.prior_dataset)
      ? [{
          name: text(method.prior_dataset),
          values: Array.isArray(method.prior_ultimate_values) ? method.prior_ultimate_values : [],
          weights: [],
        }]
      : [];
  state.priorSources = storedPriorSources.map((source) => normalizePriorSource(source, rowCount())).filter((source) => source.name);
  state.selectedPriorValues = Array.isArray(method.selected_prior_values) ? method.selected_prior_values.map(numberOrNull) : [];
  state.newUltimateValues = Array.isArray(method.new_ultimate) ? method.new_ultimate.map(numberOrNull) : [];
  syncTitles();
  syncFormattingControls();
  renderPriorSourceList();
  renderMethodGrid();
  renderBfChart();
}

function snapshotPayload() {
  return JSON.stringify(buildPayload());
}

function markClean() {
  cleanSnapshot = snapshotPayload();
  lastSavedNotesText = els.notesInput?.value || "";
  postDirty(false, true);
}

async function tryLoadExistingMethod() {
  const hostApi = getHostApi();
  if (!hostApi?.readJsonFile) return false;
  const path = await getMethodPath();
  const result = await hostApi.readJsonFile({ path });
  if (!result?.exists || !result.data) return false;
  await applyPayload(result.data);
  postStatus(`Loaded ${BF_METHOD_TYPE}: ${getDetails().name}`);
  return true;
}

async function loadSidecar() {
  const requestSequence = ++sidecarLoadSequence;
  const details = getDetails();
  if (!state.project || !state.reservingClass || !details.name) {
    auditLogView.clear();
    return null;
  }
  auditLogView.setLoading();
  try {
    const resp = await fetch("/dataset/sidecar/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: state.project,
        reserving_class: state.reservingClass,
        dataset_name: details.name,
      }),
    });
    const payload = await resp.json().catch(() => ({}));
    if (requestSequence !== sidecarLoadSequence) return null;
    if (!resp.ok || payload?.ok === false) {
      throw new Error(text(payload?.detail || payload?.error) || `Dataset sidecar load failed (${resp.status}).`);
    }
    const sidecar = payload?.sidecar || payload?.data || payload;
    state.sidecarOriginLabels = Array.isArray(sidecar?.origin_labels) ? sidecar.origin_labels.map(String) : [];
    auditLogView.render(sidecar?.audit_log);
    return sidecar;
  } catch (err) {
    if (requestSequence !== sidecarLoadSequence) return null;
    const message = text(err?.message || err) || "Unknown error.";
    auditLogView.setError(`Could not load the audit log. ${message}`);
    return null;
  }
}

function getSourcePrecedentNames() {
  const seen = new Set();
  const out = [];
  const details = getDetails();
  for (const name of [details.latestDataset, details.dfmDataset, ...details.priorDatasets]) {
    const clean = text(name);
    const key = norm(clean);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

async function saveSidecar(csvPath, originLabels = []) {
  const details = getDetails();
  const resp = await fetch("/dataset/sidecar/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_name: state.project,
      reserving_class: state.reservingClass,
      dataset_name: details.name,
      dataset_type: details.outputType || details.name,
      instance_name: details.name,
      source_kind: BF_SOURCE_KIND,
      method_type: BF_METHOD_TYPE,
      status: 0,
      data_format: "Vector",
      origin_length: details.originLength,
      development_length: details.originLength,
      cumulative: true,
      transposed: false,
      calendar: false,
      origin_labels: Array.isArray(originLabels) ? originLabels.map(String) : [],
      csv_file: csvBaseName(csvPath),
      precedents: getSourcePrecedentNames(),
    }),
  });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok || payload?.ok === false) throw new Error(payload?.detail || payload?.error || `Sidecar save failed (${resp.status}).`);
  sidecarLoadSequence += 1;
  auditLogView.render(payload?.audit_log);
  return payload;
}

const MONTH_NAME_TO_NUM = new Map([
  ["jan", 1], ["january", 1],
  ["feb", 2], ["february", 2],
  ["mar", 3], ["march", 3],
  ["apr", 4], ["april", 4],
  ["may", 5],
  ["jun", 6], ["june", 6],
  ["jul", 7], ["july", 7],
  ["aug", 8], ["august", 8],
  ["sep", 9], ["sept", 9], ["september", 9],
  ["oct", 10], ["october", 10],
  ["nov", 11], ["november", 11],
  ["dec", 12], ["december", 12],
]);

function parseOriginStartMonth(label, baseLen) {
  const s = text(label);
  if (!s) return null;
  if (baseLen === 1) {
    const yyyymm = s.match(/^(\d{4})(\d{2})$/);
    if (yyyymm) {
      const year = Number.parseInt(yyyymm[1], 10);
      const month = Number.parseInt(yyyymm[2], 10);
      if (Number.isFinite(year) && month >= 1 && month <= 12) return { year, month };
    }
    const monYear = s.match(/^([A-Za-z]{3,9})\s+(\d{4})$/);
    if (monYear) {
      const month = MONTH_NAME_TO_NUM.get(monYear[1].toLowerCase());
      const year = Number.parseInt(monYear[2], 10);
      if (month && Number.isFinite(year)) return { year, month };
    }
    return null;
  }
  if (baseLen === 3) {
    let match = s.match(/^(\d{4})\s*Q([1-4])$/i);
    if (match) return { year: Number.parseInt(match[1], 10), month: (Number.parseInt(match[2], 10) - 1) * 3 + 1 };
    match = s.match(/^Q([1-4])\s*(\d{4})$/i);
    if (match) return { year: Number.parseInt(match[2], 10), month: (Number.parseInt(match[1], 10) - 1) * 3 + 1 };
    return null;
  }
  if (baseLen === 6) {
    let match = s.match(/^(\d{4})\s*H([1-2])$/i);
    if (match) return { year: Number.parseInt(match[1], 10), month: (Number.parseInt(match[2], 10) - 1) * 6 + 1 };
    match = s.match(/^H([1-2])\s*(\d{4})$/i);
    if (match) return { year: Number.parseInt(match[2], 10), month: (Number.parseInt(match[1], 10) - 1) * 6 + 1 };
    return null;
  }
  if (baseLen === 12 && /^\d{4}$/.test(s)) {
    return { year: Number.parseInt(s, 10), month: 1 };
  }
  return null;
}

function aggregateVectorByLength(vector, originLabels, baseLen, targetLen) {
  if (!Array.isArray(vector) || !vector.length) return [];
  const factor = targetLen / baseLen;
  if (!Number.isFinite(factor) || factor <= 1 || Math.floor(factor) !== factor) return [];

  const labels = Array.isArray(originLabels) ? originLabels : [];
  if (labels.length === vector.length && [1, 3, 6, 12].includes(baseLen)) {
    const orderedKeys = [];
    const bucketMap = new Map();
    let parseFailed = false;
    for (let i = 0; i < vector.length; i += 1) {
      const parsed = parseOriginStartMonth(labels[i], baseLen);
      if (!parsed) {
        parseFailed = true;
        break;
      }
      const bucketMonth = Math.floor((parsed.month - 1) / targetLen) * targetLen + 1;
      const key = `${parsed.year}-${bucketMonth}`;
      if (!bucketMap.has(key)) {
        bucketMap.set(key, { sum: 0, hasValue: false });
        orderedKeys.push(key);
      }
      const bucket = bucketMap.get(key);
      const num = numberOrNull(vector[i]);
      if (num !== null) {
        bucket.sum += num;
        bucket.hasValue = true;
      }
    }
    if (!parseFailed) return orderedKeys.map((key) => {
      const bucket = bucketMap.get(key);
      return bucket?.hasValue ? bucket.sum : null;
    });
  }

  const out = [];
  for (let i = 0; i < vector.length; i += factor) {
    const slice = vector.slice(i, i + factor);
    let sum = 0;
    let hasValue = false;
    for (const value of slice) {
      const num = numberOrNull(value);
      if (num !== null) {
        sum += num;
        hasValue = true;
      }
    }
    out.push(hasValue ? sum : null);
  }
  return out;
}

function buildAggregatedResultVariants(vector, originLabels, baseLen) {
  const nativeLen = validOriginLength(baseLen);
  return [3, 6, 12]
    .filter((len) => len > nativeLen && len % nativeLen === 0)
    .map((originLen) => ({
      originLen,
      vector: aggregateVectorByLength(vector, originLabels, nativeLen, originLen),
    }))
    .filter((variant) => variant.vector.length);
}

async function saveBornhuetterFerguson() {
  const details = getDetails();
  if (!details.name || !details.outputType) {
    postStatus(`${BF_METHOD_TYPE} save requires Name and Output Type.`, "error");
    return { ok: false };
  }
  if (!details.latestDataset || !details.dfmDataset || !details.priorDatasets.length) {
    postStatus(`${BF_METHOD_TYPE} save requires Latest, Development Pattern, and at least one Prior Vector.`, "error");
    return { ok: false };
  }
  const hostApi = getHostApi();
  if (!hostApi?.saveJsonFile || !hostApi?.saveTextFile) {
    postStatus(`${BF_METHOD_TYPE} save requires the desktop app.`, "error");
    return { ok: false };
  }
  await refreshCalculations({ mark: false });
  const vector = state.newUltimateValues;
  if (!vector.some((value) => numberOrNull(value) !== null)) {
    postStatus(`${BF_METHOD_TYPE} output vector is blank. Check source selections.`, "error");
    return { ok: false };
  }
  const payload = buildPayload();
  const methodPath = await getMethodPath();
  const jsonOut = await hostApi.saveJsonFile({
    path: methodPath,
    suggestedName: getMethodFilename(),
    startDir: await getMethodsDir(),
    data: payload,
  });
  if (!jsonOut?.path || jsonOut?.error) throw new Error(jsonOut?.error || "Method JSON save failed.");
  const csvPath = await getCsvPath();
  const csvOut = await hostApi.saveTextFile({
    path: csvPath,
    data: vectorCsv(vector),
  });
  if (csvOut?.error) throw new Error(csvOut.error);
  await saveSidecar(csvPath, payload.method_tab.origin_labels || []);

  const datasetDir = await getDatasetDir();
  const aggregatedCsvPaths = [];
  for (const variant of buildAggregatedResultVariants(vector, payload.method_tab.origin_labels || [], details.originLength)) {
    const aggPath = `${datasetDir}\\${getCsvFilenameForLength(variant.originLen)}`;
    if (aggPath.toLowerCase() === csvPath.toLowerCase()) continue;
    const aggOut = await hostApi.saveTextFile({
      path: aggPath,
      data: vectorCsv(variant.vector),
    });
    if (aggOut?.error) throw new Error(aggOut.error);
    aggregatedCsvPaths.push(aggPath);
  }

  await Promise.all([
    loadCachedRows(true).catch(() => {}),
    loadSidecar().catch(() => null),
  ]);
  markClean();
  try {
    window.parent?.postMessage({ type: "arcrho:project-instance-refresh-datasets" }, "*");
  } catch {}
  postStatus(`${BF_METHOD_TYPE} saved: ${details.name}${aggregatedCsvPaths.length ? ` (+${aggregatedCsvPaths.length} aggregated)` : ""}`);
  return { ok: true, path: jsonOut.path, csvPath, aggregatedCsvPaths };
}

function setNotesText(value) {
  const next = text(value);
  lastSavedNotesText = next;
  if (!els.notesInput) return;
  notesProgrammatic = true;
  els.notesInput.value = next;
  els.notesInput.dispatchEvent(new Event("input", { bubbles: true }));
  notesProgrammatic = false;
}

function wireNotes() {
  wireNotesEditorInteractions({
    ids: {
      inputId: "bfNotesInput",
      wrapId: "bfNotesInputWrap",
      decorId: "bfNotesDecor",
      formatToolbarId: "bfNotesFormatToolbar",
    },
    classes: {
      tooltipClass: "bfNotesPathTooltip",
      pathTokenClass: "bfNotesPathToken",
      hoverPathClass: "isHoverPath",
    },
    getNotesProgrammaticInput: () => notesProgrammatic,
    getLastSavedNotesText: () => lastSavedNotesText,
    setNotesDirty: markDirty,
    onOpenPath: (path) => {
      try {
        window.parent?.postMessage({ type: "arcrho:open-path", path }, "*");
      } catch {}
    },
  });
}

async function openPicker(kind, anchor) {
  await loadCachedRows().catch(() => {});
  const titles = {
    output: "Select Output Vector",
    latest: "Select Latest",
    dfm: "Select Development Pattern",
    prior: "Select Prior Vector",
  };
  const allowedDataFormats = kind === "latest" ? ["Triangle"] : ["Vector"];
  await openDatasetNamePicker({
    projectName: state.project,
    initialName: kind === "output"
      ? els.outputTypeInput?.value
      : kind === "latest"
        ? els.latestInput?.value
        : kind === "dfm"
          ? els.dfmInput?.value
          : state.priorSources.at(-1)?.name || "",
    anchorElement: anchor instanceof Element ? anchor : null,
    title: titles[kind] || "Select Dataset",
    allowedDataFormats,
    includeCalculated: true,
    emptyMessage: kind === "latest" ? "No cached triangle datasets found." : "No cached vector datasets found.",
    itemFilter: (item) => {
      const record = cachedRecordByName(item?.name);
      if (!record && kind !== "output") return false;
      if (kind === "dfm") return norm(record?.methodType) === "dfm" && norm(record?.dataFormat) === "vector";
      if (kind === "latest") return norm(record?.dataFormat) === "triangle";
      if (kind === "prior") return norm(record?.dataFormat) === "vector";
      return true;
    },
    setStatus: (message) => {
      const msg = text(message);
      if (msg) postStatus(msg, "warn");
    },
    onError: (err) => {
      console.error(`Failed to open ${kind} picker:`, err);
      postStatus(`Error loading dataset names: ${String(err?.message || err)}`, "error");
    },
    onSelect: async (name, item) => {
      const selected = text(name);
      if (!selected) return;
      if (kind === "prior" && !addPriorSource(selected)) {
        postStatus(`Prior Vector is already selected: ${selected}`, "warn");
        return;
      }
      withProgrammatic(() => {
        if (kind === "output") els.outputTypeInput.value = selected;
        if (kind === "latest") els.latestInput.value = selected;
        if (kind === "dfm") els.dfmInput.value = selected;
        if (kind === "output" && !els.nameInput.value) els.nameInput.value = selected;
        if (item?.origin_length || item?.originLength) {
          els.originLengthInput.value = String(validOriginLength(item.origin_length || item.originLength));
        }
      });
      syncOriginLengthControl();
      syncTitles();
      try {
        await refreshCalculations({ mark: false });
      } catch (err) {
        postStatus(`Source refresh failed: ${String(err?.message || err)}`, "error");
      }
      markDirty();
    },
  });
}

function requestConfirmedClose() {
  requestTabbedPageWindowClose({
    messageType: "arcrho:dataset-close-confirmed",
    inst,
  });
}

async function closeOrConfirm() {
  if (isDirty) {
    const discard = await bfCloseConfirm.confirm({ reason: "close" });
    if (!discard) return;
  }
  requestConfirmedClose();
}

async function initTabbedPage() {
  const container = document.getElementById("bfTabbedPage");
  tabbedPage = createTabbedPage(container, {
    tabs: BF_TABS,
    cssPrefix: "bf",
    initialTab: ALLOWED_BF_TABS.has(text(params.get("tab") || params.get("initial_tab"))) ? text(params.get("tab") || params.get("initial_tab")) : "details",
    onTabChange: (tabId) => {
      if (tabId === "chart") requestAnimationFrame(() => bfChart?.refresh());
      if (tabId === "audit" && tabbedPage) void loadSidecar();
      try {
        window.parent?.postMessage({ type: "arcrho:bf-tab-changed", inst, tab: tabId }, "*");
      } catch {}
    },
  });
  applyTabbedPageSaveBar(document.getElementById("bfSaveBar"));
  wireTabPopoutWindows({
    cssPrefix: "bf",
    tabs: BF_TABS,
    tabSystem: () => tabbedPage,
    getTitle: () => `${getDetails().name || BF_METHOD_TYPE} - ${BF_METHOD_TYPE}`,
    onPopoutTab: (tabId) => {
      if (tabId === "audit") void loadSidecar();
    },
  });
  bfChart = createBornhuetterFergusonChart({
    canvas: els.chartCanvas,
    legend: els.chartLegend,
    emptyState: els.chartEmpty,
    tooltip: els.chartTooltip,
  });
  renderBfChart();
}

function syncFormattingControls() {
  if (els.showWeightsInput) els.showWeightsInput.checked = state.showWeights;
  if (els.methodDecimalsInput) els.methodDecimalsInput.value = String(state.statisticDecimalPlaces);
  if (els.weightDisplayLabel) els.weightDisplayLabel.textContent = state.showEffectiveWeights ? "Effective %" : "Index";
  if (els.weightDisplayButton) els.weightDisplayButton.disabled = !state.showWeights;
  for (const option of els.weightDisplayMenu?.querySelectorAll("[data-value]") || []) {
    option.setAttribute("aria-selected", option.dataset.value === (state.showEffectiveWeights ? "effective" : "actual") ? "true" : "false");
  }
}

function originLengthOptions() {
  return Array.from(els.originLengthMenu?.querySelectorAll("button[data-value]") || []);
}

function syncOriginLengthControl() {
  const value = String(validOriginLength(els.originLengthInput?.value));
  if (els.originLengthInput) els.originLengthInput.value = value;
  if (els.originLengthLabel) els.originLengthLabel.textContent = value;
  for (const option of originLengthOptions()) {
    option.setAttribute("aria-selected", option.dataset.value === value ? "true" : "false");
  }
}

function closeOriginLengthDropdown({ focusButton = false } = {}) {
  els.originLengthDropdown?.classList.remove("open");
  els.originLengthButton?.setAttribute("aria-expanded", "false");
  if (focusButton) els.originLengthButton?.focus();
}

function openOriginLengthDropdown({ focusSelected = false } = {}) {
  closeWeightDisplayDropdown();
  els.originLengthDropdown?.classList.add("open");
  els.originLengthButton?.setAttribute("aria-expanded", "true");
  if (focusSelected) {
    const selected = originLengthOptions().find((option) => option.getAttribute("aria-selected") === "true");
    selected?.focus();
  }
}

function setOriginLength(value) {
  const nextValue = String(validOriginLength(value));
  const changed = els.originLengthInput?.value !== nextValue;
  if (els.originLengthInput) els.originLengthInput.value = nextValue;
  syncOriginLengthControl();
  closeOriginLengthDropdown({ focusButton: true });
  if (!changed || !els.originLengthInput) return;
  els.originLengthInput.dispatchEvent(new Event("input", { bubbles: true }));
  els.originLengthInput.dispatchEvent(new Event("change", { bubbles: true }));
}

function closeWeightDisplayDropdown() {
  els.weightDisplayDropdown?.classList.remove("open");
  els.weightDisplayButton?.setAttribute("aria-expanded", "false");
}

function setStatisticDecimals(value) {
  state.statisticDecimalPlaces = statisticDecimalPlaces(value, state.statisticDecimalPlaces);
  syncFormattingControls();
  renderMethodGrid();
  renderBfChart();
  markDirty();
}

function wireInputs() {
  wireMethodGridInteractions();
  for (const input of [els.nameInput, els.outputTypeInput, els.originLengthInput]) {
    input?.addEventListener("input", () => {
      if (input === els.originLengthInput) syncOriginLengthControl();
      syncTitles();
      markDirty();
    });
    input?.addEventListener("change", async () => {
      syncTitles();
      try {
        await refreshCalculations({ mark: false });
      } catch (err) {
        postStatus(`Refresh failed: ${String(err?.message || err)}`, "error");
      }
      markDirty();
    });
  }
  els.outputTypeBtn?.addEventListener("click", () => openPicker("output", els.outputTypeBtn));
  els.latestBtn?.addEventListener("click", () => openPicker("latest", els.latestBtn));
  els.dfmBtn?.addEventListener("click", () => openPicker("dfm", els.dfmBtn));
  els.priorList?.addEventListener("click", (event) => {
    const addButton = event.target.closest("button[data-prior-add]");
    if (addButton) {
      void openPicker("prior", addButton);
      return;
    }
    const openButton = event.target.closest("button[data-prior-open-index]");
    if (openButton) openPriorDataset(Number.parseInt(openButton.dataset.priorOpenIndex || "", 10));
  });
  els.priorList?.addEventListener("contextmenu", (event) => {
    const token = event.target.closest("[data-prior-token-index]");
    if (!token) return;
    openPriorContextMenu(event, Number.parseInt(token.dataset.priorTokenIndex || "", 10));
  });
  els.priorList?.addEventListener("dragstart", (event) => {
    const token = event.target.closest("[data-prior-token-index]");
    const sourceIndex = Number.parseInt(token?.dataset.priorTokenIndex || "", 10);
    if (!token || !Number.isInteger(sourceIndex) || !state.priorSources[sourceIndex]) return;
    closePriorContextMenu();
    state.priorDragIndex = sourceIndex;
    token.classList.add("bfPriorDragging");
    els.priorList.classList.add("bfPriorDragActive");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", state.priorSources[sourceIndex].name);
    }
  });
  document.addEventListener("dragover", (event) => {
    if (!Number.isInteger(state.priorDragIndex)) return;
    event.preventDefault();
    const insideList = event.target.closest?.("#bfPriorList");
    els.priorList?.classList.toggle("bfPriorDragOutside", !insideList);
    if (event.dataTransfer) event.dataTransfer.dropEffect = insideList ? "none" : "move";
  });
  document.addEventListener("drop", (event) => {
    if (!Number.isInteger(state.priorDragIndex)) return;
    event.preventDefault();
    const sourceIndex = state.priorDragIndex;
    const insideList = event.target.closest?.("#bfPriorList");
    resetPriorDragState();
    if (!insideList) void removePriorSource(sourceIndex);
  });
  document.addEventListener("dragend", resetPriorDragState);
  els.priorContextMenu?.addEventListener("click", (event) => {
    if (!event.target.closest('button[data-bf-prior-action="delete"]')) return;
    const sourceIndex = Number.parseInt(els.priorContextMenu.dataset.priorIndex || "", 10);
    closePriorContextMenu();
    if (Number.isInteger(sourceIndex)) void removePriorSource(sourceIndex);
  });
  document.addEventListener("mousedown", (event) => {
    if (els.priorContextMenu?.classList.contains("open") && !event.target.closest("#bfPriorContextMenu")) closePriorContextMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePriorContextMenu();
  });
  els.showWeightsInput?.addEventListener("change", () => {
    state.showWeights = !!els.showWeightsInput.checked;
    if (!state.showWeights) closeWeightDisplayDropdown();
    state.methodHighlight = null;
    syncFormattingControls();
    renderMethodGrid();
    markDirty();
  });
  els.weightDisplayButton?.addEventListener("click", () => {
    if (els.weightDisplayButton.disabled) return;
    const open = !els.weightDisplayDropdown?.classList.contains("open");
    if (open) closeOriginLengthDropdown();
    els.weightDisplayDropdown?.classList.toggle("open", open);
    els.weightDisplayButton.setAttribute("aria-expanded", open ? "true" : "false");
  });
  els.weightDisplayMenu?.addEventListener("click", (event) => {
    const option = event.target.closest("button[data-value]");
    if (!option) return;
    state.showEffectiveWeights = option.dataset.value === "effective";
    state.weightEditSession = null;
    closeWeightDisplayDropdown();
    syncFormattingControls();
    renderMethodGrid();
  });
  els.originLengthButton?.addEventListener("click", () => {
    const open = !els.originLengthDropdown?.classList.contains("open");
    if (open) openOriginLengthDropdown();
    else closeOriginLengthDropdown();
  });
  els.originLengthButton?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeOriginLengthDropdown();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openOriginLengthDropdown({ focusSelected: true });
  });
  els.originLengthMenu?.addEventListener("click", (event) => {
    const option = event.target.closest("button[data-value]");
    if (option) setOriginLength(option.dataset.value);
  });
  els.originLengthMenu?.addEventListener("keydown", (event) => {
    const options = originLengthOptions();
    if (!options.length) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeOriginLengthDropdown({ focusButton: true });
      return;
    }
    if (event.key === "Tab") {
      closeOriginLengthDropdown();
      return;
    }
    const currentIndex = Math.max(0, options.indexOf(document.activeElement));
    let nextIndex = currentIndex;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % options.length;
    else if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + options.length) % options.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = options.length - 1;
    else return;
    event.preventDefault();
    options[nextIndex].focus();
  });
  document.addEventListener("mousedown", (event) => {
    if (els.weightDisplayDropdown?.classList.contains("open") && !event.target.closest("#bfWeightDisplayDropdown")) closeWeightDisplayDropdown();
    if (els.originLengthDropdown?.classList.contains("open") && !event.target.closest("#bfOriginLengthDropdown")) closeOriginLengthDropdown();
  });
  els.methodDecimalsInput?.addEventListener("input", () => setStatisticDecimals(els.methodDecimalsInput.value));
  els.methodDecimalsInput?.addEventListener("change", () => setStatisticDecimals(els.methodDecimalsInput.value));
  els.methodDecimalsUp?.addEventListener("click", () => setStatisticDecimals(state.statisticDecimalPlaces + 1));
  els.methodDecimalsDown?.addEventListener("click", () => setStatisticDecimals(state.statisticDecimalPlaces - 1));
  syncFormattingControls();
  syncOriginLengthControl();
  renderPriorSourceList();
  els.saveBtn?.addEventListener("click", async () => {
    try {
      await saveBornhuetterFerguson();
    } catch (err) {
      console.error(err);
      postStatus(`Save failed: ${String(err?.message || err)}`, "error");
    }
  });
  els.cancelBtn?.addEventListener("click", closeOrConfirm);
  window.__arcrho_request_close = () => {
    if (!isDirty) return false;
    if (bfCloseConfirm.isOpen) return true;
    void closeOrConfirm();
    return true;
  };
  window.__arcrho_consume_close_shortcut = window.__arcrho_request_close;
}

function wireMessages() {
  window.addEventListener("message", async (event) => {
    const msg = event?.data && typeof event.data === "object" ? event.data : {};
    if (msg.type === "arcrho:dataset-save") {
      try {
        await saveBornhuetterFerguson();
      } catch (err) {
        postStatus(`Save failed: ${String(err?.message || err)}`, "error");
      }
      return;
    }
    if (msg.type === "arcrho:dependency-source-preview") {
      applyDependencySourcePreview(msg);
      return;
    }
    if (msg.type === "arcrho:dependency-source-cleared") {
      try {
        await clearDependencySourcePreview(msg);
      } catch (err) {
        postStatus(`Source preview reload failed: ${String(err?.message || err)}`, "error");
      }
      return;
    }
    if (msg.type === "arcrho:close-active-tab" || msg.type === "arcrho:dataset-close-request") {
      await closeOrConfirm();
    }
  });
}

async function init() {
  syncDetailsLabelWidth({
    root: "#bfDetailsPage",
    labelSelector: ".bfLabel",
    propertyName: "--bf-details-label-width",
  });
  withProgrammatic(() => {
    els.projectInput.value = state.project;
    els.classInput.value = state.reservingClass;
    els.nameInput.value = text(params.get("name") || params.get("dataset") || "");
    els.outputTypeInput.value = text(params.get("output_type") || params.get("dataset_type") || params.get("datasetType") || "");
    els.originLengthInput.value = String(validOriginLength(params.get("origin_length") || params.get("originLength")));
  });
  syncOriginLengthControl();
  syncTitles();
  await initTabbedPage();
  wireNotes();
  wireInputs();
  wireMessages();
  try {
    await loadCachedRows();
  } catch (err) {
    postStatus(`Dataset cache unavailable: ${String(err?.message || err)}`, "warn");
  }
  await loadSidecar().catch(() => null);
  const loaded = await tryLoadExistingMethod().catch((err) => {
    postStatus(`Could not load existing ${BF_METHOD_TYPE}: ${String(err?.message || err)}`, "warn");
    return false;
  });
  if (loaded && hasRequiredSourceConfig()) {
    try {
      postStatus("Loading Bornhuetter Ferguson source data...");
      await refreshCalculations({ mark: false });
      postStatus(`${BF_METHOD_TYPE} ready.`);
    } catch (err) {
      postStatus(`Source refresh failed: ${String(err?.message || err)}`, "error");
    }
  } else if (!loaded) {
    try {
      await refreshOriginLabels({ render: false });
      calculateOutputs();
      renderMethodGrid();
    } catch (err) {
      state.originLabels = [];
      calculateOutputs();
      renderMethodGrid();
      postStatus(`Origin labels unavailable: ${String(err?.message || err)}`, "error");
    }
  }
  markClean();
}

void init();

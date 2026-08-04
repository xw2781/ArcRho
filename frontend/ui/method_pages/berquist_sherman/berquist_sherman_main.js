import { ensureDatasetOriginLabels } from "/ui/shared/dataset/dataset_origin_labels.js";
import { createDatasetHeadersService } from "/ui/shared/dataset/dataset_headers_service.js";
import { openDatasetNamePicker } from "/ui/shared/components/pickers/dataset_name_picker.js";
import { sanitizeDataFolderPart, sanitizeFileNamePart } from "/ui/shared/utils/filename.js";
import {
  applyTabbedPageSaveBar,
  createTabbedPage,
  requestTabbedPageWindowClose,
  updateTabbedPageSaveControls,
} from "/ui/shared/tabbed_page/tabbed_page.js?v=20260714a";
import { mountNotesTab } from "/ui/shared/tabs/notes/notes_tab.js?v=20260714a";
import { syncDetailsLabelWidth } from "/ui/shared/tabs/details/details_form_layout.js?v=20260720c";
import { createAuditLogView } from "/ui/shared/tabs/audit_log/audit_log_view.js?v=20260714c";
import {
  formatSidecarAuditEventDate,
  normalizeSidecarAuditEntries,
} from "/ui/shared/tabs/audit_log/sidecar_audit_entries.js?v=20260714c";
import { createPageCloseConfirm } from "/ui/shared/components/close_confirm/close_confirm.js";
import { openContextMenu } from "/ui/shared/components/context_menu/context_menu.js";
import { showMethodSaveReviewWarning } from "/ui/shared/components/message_box/method_save_review_warning.js?v=20260728b";
import {
  getBerquistShermanContract,
  normalizeBerquistShermanVariant,
} from "/ui/shared/dataset/berquist_sherman_contract.js";
import {
  DEFAULT_LOESS_SPAN,
  calculateSettlementRate,
  normalizeLoessSpan,
} from "./settlement_rate_calculation.js";
import { calculateCaseReserveAdequacy } from "./case_reserve_adequacy_calculation.js";
import { readProjectInstanceDatasetSnapshot } from "/ui/shared/dataset/project_instance_dataset_snapshot.js?v=20260725a";

const ANNUAL_PERIOD_LENGTH = 12;
const TABS = [
  { id: "details", label: "Details" },
  { id: "method", label: "Method" },
  { id: "notes", label: "Notes" },
  { id: "audit", label: "Audit Log" },
];
const ALLOWED_TABS = new Set(TABS.map((tab) => tab.id));
const params = new URLSearchParams(window.location.search || "");
const variant = normalizeBerquistShermanVariant(params.get("variant")) || "sr";
const contract = getBerquistShermanContract(variant);
const inst = text(params.get("inst")) || `bs_${Date.now()}`;

const ROLE_DEFINITIONS = Object.freeze({
  sr: Object.freeze([
    { key: "paid_claims", label: "Paid Claims", format: "Triangle", inputId: "bsSrPaidInput" },
    { key: "closed_claim_numbers", label: "Closed Claim Counts", format: "Triangle", inputId: "bsSrClosedInput" },
    { key: "ultimate_claim_numbers", label: "Ultimate Claim Counts", format: "Vector", inputId: "bsSrUltimateInput" },
  ]),
  cra: Object.freeze([
    { key: "reported_claim_numbers", label: "Reported Claim Counts", format: "Triangle", inputId: "bsCraReportedInput" },
    { key: "closed_claim_numbers", label: "Closed Claim Counts", format: "Triangle", inputId: "bsCraClosedInput" },
    { key: "incurred_claims", label: "Incurred Claims", format: "Triangle", inputId: "bsCraIncurredInput" },
    { key: "paid_claims", label: "Paid Claims", format: "Triangle", inputId: "bsCraPaidInput" },
  ]),
});

const VIEW_DEFINITIONS = Object.freeze({
  // Settlement Rate mirrors the ResQ Method sub-tab order and captions. The
  // Pairs, All, and Loess estimates are shown per origin period inside the
  // Adjusted Paid Claims selection grid.
  sr: Object.freeze([
    { key: "paidClaims", label: "Paid Claims", caption: "Paid Claims:", decimals: 2 },
    { key: "numbersClosed", label: "Numbers Closed", caption: "Numbers Closed:", decimals: 2 },
    { key: "proportionSettled", label: "Proportion Settled", caption: "Proportion Settled:", decimals: 6 },
    { key: "selectedClaimNumbers", label: "Selected Numbers Closed", caption: "Selected Numbers Closed:", decimals: 2 },
    {
      key: "output",
      label: "Adjusted Paid Claims",
      caption: "Paid Claims Adjusted to Constant Proportions Settled",
      decimals: 2,
    },
  ]),
  cra: Object.freeze([
    { key: "output", label: "Adjusted Incurred Claims", decimals: 2 },
    { key: "openClaimNumbers", label: "Open Claim Counts", decimals: 2 },
    { key: "caseReserves", label: "Case Reserves", decimals: 2 },
    { key: "averageCaseReserves", label: "Average Case Reserves", decimals: 2 },
    { key: "averagePaidClaims", label: "Average Paid Claims", decimals: 2 },
    { key: "adjustedAverageCaseReserves", label: "Adjusted Average Case Reserves", decimals: 2 },
  ]),
});

const state = {
  project: text(params.get("project")),
  reservingClass: text(params.get("class") || params.get("path")),
  cachedRows: [],
  sourceNames: {},
  sourceValues: {},
  sourcePayloads: {},
  originLabels: [],
  developmentLabels: [],
  sidecarOriginLabels: [],
  numberFormat: "0,000",
  decimalPlaces: 0,
  result: null,
  currentView: variant === "sr" ? "paidClaims" : "output",
  selectedProportionSettled: [],
  selectedProportionIsDefault: [],
  selectedAdjustment: [],
  loessSpan: DEFAULT_LOESS_SPAN,
  inflationSelection: [],
  userInflation: [],
  averageCaseReserveSelection: [],
  userAverageCaseReserves: [],
};

let cleanSnapshot = "";
let isDirty = false;
let programmatic = false;
let tabbedPage = null;
let sidecarLoadSequence = 0;
let outputPreviewTimer = 0;
let lastOutputPreviewMessage = null;
const activeDependencyPreviews = new Map();
const closeConfirm = createPageCloseConfirm({ subject: contract.methodType });
const headerState = { headerLabels: [], devHeaderLabels: [] };
const headersService = createDatasetHeadersService({
  state: headerState,
  setStatus: (message) => {
    if (text(message)) postStatus(message);
  },
});

const els = {
  projectInput: document.getElementById("bsProjectInput"),
  classInput: document.getElementById("bsClassInput"),
  nameInput: document.getElementById("bsNameInput"),
  methodTypeInput: document.getElementById("bsMethodTypeInput"),
  outputTypeInput: document.getElementById("bsOutputTypeInput"),
  outputTypeBtn: document.getElementById("bsOutputTypeBtn"),
  originLengthInput: document.getElementById("bsOriginLengthInput"),
  developmentLengthInput: document.getElementById("bsDevelopmentLengthInput"),
  srInputs: document.getElementById("bsSrInputs"),
  craInputs: document.getElementById("bsCraInputs"),
  viewButtons: document.getElementById("bsViewButtons"),
  methodCaption: document.getElementById("bsMethodCaption"),
  methodCaptionText: document.getElementById("bsMethodCaptionText"),
  loessSpanField: document.getElementById("bsLoessSpanField"),
  loessSpanInput: document.getElementById("bsLoessSpanInput"),
  loessSpanUp: document.getElementById("bsLoessSpanUp"),
  loessSpanDown: document.getElementById("bsLoessSpanDown"),
  selectionSummary: document.getElementById("bsSelectionSummary"),
  methodMessage: document.getElementById("bsMethodMessage"),
  methodHead: document.getElementById("bsMethodHead"),
  methodBody: document.getElementById("bsMethodBody"),
  auditLogMount: document.getElementById("bsAuditLogMount"),
  saveBtn: document.getElementById("bsSaveBtn"),
  cancelBtn: document.getElementById("bsCancelBtn"),
};

const notesController = mountNotesTab({
  container: document.getElementById("bsNotesMount"),
  ariaLabel: `${contract.methodType} notes`,
  onChange: () => markDirty(),
  onStatus: postStatus,
});

const auditLogView = createAuditLogView({
  container: els.auditLogMount,
  ariaLabel: `${contract.methodType} audit log`,
  emptyDescription: "Method saves will appear here after the first save.",
  normalizeEntries: normalizeSidecarAuditEntries,
  formatEventDate: formatSidecarAuditEventDate,
});

function text(value) {
  return String(value ?? "").trim();
}

function norm(value) {
  return text(value).replace(/\s+/g, " ").toLowerCase();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function csvBaseName(value) {
  return text(value).split(/[\\/]/).pop();
}

function roleDefinitions() {
  return ROLE_DEFINITIONS[variant];
}

function viewDefinitions() {
  return VIEW_DEFINITIONS[variant];
}

function roleByKey(key) {
  return roleDefinitions().find((role) => role.key === key) || null;
}

function getDetails() {
  return {
    name: text(els.nameInput?.value),
    outputType: text(els.outputTypeInput?.value),
  };
}

function withProgrammatic(callback) {
  programmatic = true;
  try {
    return callback();
  } finally {
    programmatic = false;
  }
}

function getHostApi() {
  if (window.ADAHost) return window.ADAHost;
  try {
    let current = window.parent;
    while (current && current !== window) {
      if (current.ADAHost) return current.ADAHost;
      if (current === current.parent) break;
      current = current.parent;
    }
  } catch {}
  return null;
}

function postStatus(message, tone = "") {
  const statusText = text(message);
  try {
    window.parent?.postMessage(
      { type: "arcrho:status", text: statusText, ...(tone ? { tone } : {}) },
      "*",
    );
  } catch {}
}

function postDirty(dirty, force = false) {
  const next = !!dirty;
  if (!force && next === isDirty) return;
  isDirty = next;
  updateTabbedPageSaveControls({
    saveButton: els.saveBtn,
    cancelButton: els.cancelBtn,
    dirty: next,
  });
  try {
    window.parent?.postMessage({ type: "arcrho:dataset-dirty", inst, dirty: next }, "*");
  } catch {}
  if (next) scheduleOutputDependencyPreview("dirty");
  else clearOutputDependencyPreview("clean");
}

function configSnapshot() {
  const details = getDetails();
  const selection = variant === "sr"
    ? {
        selectedProportionSettled: state.selectedProportionSettled,
        selectedProportionIsDefault: state.selectedProportionIsDefault,
        selectedAdjustment: state.selectedAdjustment,
        loessSpan: state.loessSpan,
      }
    : {
        inflationSelection: state.inflationSelection,
        userInflation: state.userInflation,
        averageCaseReserveSelection: state.averageCaseReserveSelection,
        userAverageCaseReserves: state.userAverageCaseReserves,
      };
  return JSON.stringify({
    name: details.name,
    outputType: details.outputType,
    sourceNames: roleDefinitions().map((role) => [role.key, text(state.sourceNames[role.key])]),
    selection,
    notes: notesController.getValue(),
  });
}

function markDirty() {
  if (programmatic) return;
  const dirty = configSnapshot() !== cleanSnapshot;
  postDirty(dirty);
  if (dirty) scheduleOutputDependencyPreview("dirty");
}

function markClean() {
  cleanSnapshot = configSnapshot();
  notesController.markClean();
  postDirty(false, true);
}

function syncTitle() {
  const name = getDetails().name;
  document.title = name ? `${name} - ${contract.methodType}` : contract.methodType;
}

function setMethodMessage(message, tone = "") {
  if (!els.methodMessage) return;
  els.methodMessage.textContent = text(message);
  els.methodMessage.classList.toggle("error", tone === "error");
}

function latestDiagonalValues(matrix) {
  return (Array.isArray(matrix) ? matrix : []).map((row) => {
    const cells = Array.isArray(row) ? row : [];
    for (let index = cells.length - 1; index >= 0; index -= 1) {
      const value = numberOrNull(cells[index]);
      if (value !== null) return value;
    }
    return null;
  });
}

function outputDependencyMessage(type, reason = "") {
  const details = getDetails();
  const output = state.result?.output;
  const message = {
    type,
    inst,
    project: state.project,
    reservingClass: state.reservingClass,
    datasetName: details.name,
    datasetTypeName: details.outputType || details.name,
    names: [details.name, details.outputType].map(text).filter(Boolean),
    methodType: contract.methodType,
    sourceKind: contract.sourceKind,
    dataFormat: "Triangle",
    originLength: ANNUAL_PERIOD_LENGTH,
    developmentLength: ANNUAL_PERIOD_LENGTH,
    reason,
  };
  if (type === "arcrho:dependency-source-preview" && Array.isArray(output)) {
    message.values = latestDiagonalValues(output);
    message.matrixValues = cloneMatrix(output);
    message.mask = output.map((row) => (
      Array.isArray(row) ? row.map((value) => numberOrNull(value) !== null) : []
    ));
    message.originLabels = state.originLabels.map(String);
    message.developmentLabels = Array.from(
      { length: matrixDevelopmentCount() },
      (_, index) => getDevelopmentLabel(index),
    );
  }
  return message;
}

function outputPreviewIdentity(message) {
  return [
    norm(message?.project),
    normalizedReservingClassPath(message?.reservingClass),
    ...(Array.isArray(message?.names) ? message.names.map(norm).sort() : []),
  ].join("\u001f");
}

function postOutputDependencyPreview(reason = "dirty") {
  const output = state.result?.output;
  if (!Array.isArray(output) || !output.length) return;
  const message = outputDependencyMessage("arcrho:dependency-source-preview", reason);
  if (!message.names.length) return;
  if (
    lastOutputPreviewMessage
    && outputPreviewIdentity(lastOutputPreviewMessage) !== outputPreviewIdentity(message)
  ) {
    try {
      window.parent?.postMessage({
        ...lastOutputPreviewMessage,
        type: "arcrho:dependency-source-cleared",
        reason: "identity-changed",
      }, "*");
    } catch {}
  }
  lastOutputPreviewMessage = message;
  try {
    window.parent?.postMessage(message, "*");
  } catch {}
}

function scheduleOutputDependencyPreview(reason = "dirty", force = false) {
  window.clearTimeout(outputPreviewTimer);
  outputPreviewTimer = window.setTimeout(() => {
    outputPreviewTimer = 0;
    if (force || isDirty) postOutputDependencyPreview(reason);
  }, 120);
}

function clearOutputDependencyPreview(reason = "clean") {
  window.clearTimeout(outputPreviewTimer);
  outputPreviewTimer = 0;
  const message = lastOutputPreviewMessage || outputDependencyMessage(
    "arcrho:dependency-source-cleared",
    reason,
  );
  lastOutputPreviewMessage = null;
  if (!message.names?.length) return;
  try {
    window.parent?.postMessage({
      ...message,
      type: "arcrho:dependency-source-cleared",
      reason,
    }, "*");
  } catch {}
}

function normalizeMatrix(rawValues) {
  const rows = Array.isArray(rawValues) ? rawValues : [];
  return rows.map((rawRow) => {
    const row = (Array.isArray(rawRow) ? rawRow : [rawRow]).map(numberOrNull);
    while (row.length && row[row.length - 1] === null) row.pop();
    return row;
  });
}

function normalizeMaskedMatrix(rawValues, rawMask) {
  if (!Array.isArray(rawMask) || !rawMask.length) return normalizeMatrix(rawValues);
  const rows = Array.isArray(rawValues) ? rawValues : [];
  return rows.map((rawRow, rowIndex) => {
    const values = Array.isArray(rawRow) ? rawRow : [rawRow];
    const mask = Array.isArray(rawMask[rowIndex]) ? rawMask[rowIndex] : [];
    let lastIncluded = -1;
    for (let columnIndex = 0; columnIndex < mask.length; columnIndex += 1) {
      if (mask[columnIndex]) lastIncluded = columnIndex;
    }
    if (lastIncluded < 0) return [];
    return Array.from(
      { length: lastIncluded + 1 },
      (_, columnIndex) => mask[columnIndex] ? numberOrNull(values[columnIndex]) : null,
    );
  });
}

function normalizeVector(rawValues) {
  const rows = Array.isArray(rawValues) ? rawValues : [];
  return rows.map((rawRow) => {
    if (!Array.isArray(rawRow)) return numberOrNull(rawRow);
    for (const value of rawRow) {
      const number = numberOrNull(value);
      if (number !== null) return number;
    }
    return null;
  });
}

function normalizeStringVector(values) {
  return Array.isArray(values) ? values.map((value) => text(value) || null) : [];
}

function normalizeNumberVector(values) {
  return Array.isArray(values) ? values.map(numberOrNull) : [];
}

function normalizeBooleanVector(values) {
  return Array.isArray(values) ? values.map((value) => !!value) : [];
}

function normalizeSelectionMatrix(values) {
  return Array.isArray(values)
    ? values.map((row) => Array.isArray(row) ? row.map((value) => text(value) || null) : [])
    : [];
}

function matrixRowCount() {
  for (const role of roleDefinitions()) {
    if (role.format !== "Triangle") continue;
    const matrix = state.sourceValues[role.key];
    if (Array.isArray(matrix) && matrix.length) return matrix.length;
  }
  return 0;
}

function matrixDevelopmentCount() {
  let count = state.developmentLabels.length;
  for (const role of roleDefinitions()) {
    if (role.format !== "Triangle") continue;
    for (const row of state.sourceValues[role.key] || []) {
      count = Math.max(count, Array.isArray(row) ? row.length : 0);
    }
  }
  return count;
}

function getOriginLabel(index) {
  return text(state.originLabels[index]) || String(index + 1);
}

function getDevelopmentLabel(index) {
  return text(state.developmentLabels[index]) || `Age ${index + 1}`;
}

function ensureSelectionConfig() {
  const rowCount = matrixRowCount();
  const developmentCount = matrixDevelopmentCount();
  if (!rowCount || !developmentCount) return;

  if (variant === "sr") {
    if (state.selectedProportionSettled.length !== developmentCount) {
      const closed = state.sourceValues.closed_claim_numbers || [];
      const ultimate = state.sourceValues.ultimate_claim_numbers || [];
      state.selectedProportionSettled = Array.from({ length: developmentCount }, (_, devIndex) => {
        const originIndex = rowCount - devIndex - 1;
        const numerator = numberOrNull(closed[originIndex]?.[devIndex]);
        const denominator = numberOrNull(ultimate[originIndex]);
        return numerator !== null && denominator !== null && denominator !== 0
          ? numerator / denominator
          : 0;
      });
    }
    if (state.selectedProportionIsDefault.length !== developmentCount) {
      state.selectedProportionIsDefault = Array(developmentCount).fill(true);
    }
    const paid = state.sourceValues.paid_claims || [];
    const selectionMatches = state.selectedAdjustment.length === paid.length
      && paid.every((row, rowIndex) => (
        Array.isArray(state.selectedAdjustment[rowIndex])
        && state.selectedAdjustment[rowIndex].length >= row.length
      ));
    if (!selectionMatches) {
      state.selectedAdjustment = paid.map((row) => (
        row.map(() => row.length > 1 ? "pairs" : "unadjusted")
      ));
    }
    return;
  }

  if (state.inflationSelection.length !== developmentCount) {
    state.inflationSelection = Array(developmentCount).fill("paid_all");
  }
  if (state.userInflation.length !== developmentCount) {
    state.userInflation = Array(developmentCount).fill(0);
  }
  if (state.averageCaseReserveSelection.length !== developmentCount) {
    state.averageCaseReserveSelection = Array(developmentCount).fill("latest");
  }
  if (state.userAverageCaseReserves.length !== developmentCount) {
    state.userAverageCaseReserves = Array(developmentCount).fill(0);
  }
}

function validateSourceShape() {
  const missing = roleDefinitions()
    .filter((role) => !text(state.sourceNames[role.key]))
    .map((role) => role.label);
  if (missing.length) throw new Error(`Select ${missing.join(", ")}.`);

  const triangleRoles = roleDefinitions().filter((role) => role.format === "Triangle");
  const firstMatrix = state.sourceValues[triangleRoles[0]?.key];
  if (!Array.isArray(firstMatrix) || !firstMatrix.length) {
    throw new Error("The selected annual triangle is empty.");
  }
  const rowLengths = firstMatrix.map((row) => Array.isArray(row) ? row.length : 0);
  if (!rowLengths.some((count) => count > 0)) throw new Error("The selected annual triangle is empty.");

  for (const role of triangleRoles.slice(1)) {
    const matrix = state.sourceValues[role.key];
    if (!Array.isArray(matrix) || matrix.length !== firstMatrix.length) {
      throw new Error(`${role.label} does not match the selected annual triangle shape.`);
    }
    const matches = matrix.every((row, index) => (
      (Array.isArray(row) ? row.length : 0) === rowLengths[index]
    ));
    if (!matches) throw new Error(`${role.label} does not match the selected annual triangle shape.`);
  }

  for (const role of roleDefinitions().filter((item) => item.format === "Vector")) {
    const vector = state.sourceValues[role.key];
    if (!Array.isArray(vector) || vector.length !== firstMatrix.length) {
      throw new Error(`${role.label} must have one value for each origin period.`);
    }
  }

  const developmentCount = Math.max(...rowLengths, 0);
  if (state.originLabels.length !== firstMatrix.length) {
    throw new Error("Annual origin labels do not match the selected source rows.");
  }
  if (state.developmentLabels.length < developmentCount) {
    throw new Error(
      "Annual development labels are unavailable. Check the project's development dates.",
    );
  }
  for (const role of roleDefinitions()) {
    const payload = state.sourcePayloads[role.key] || {};
    const originLabels = payload.origin_labels || payload.originLabels;
    if (
      Array.isArray(originLabels)
      && originLabels.length
      && (
        originLabels.length !== state.originLabels.length
        || originLabels.some((label, index) => text(label) !== text(state.originLabels[index]))
      )
    ) {
      throw new Error(`${role.label} uses different origin periods.`);
    }
    if (role.format !== "Triangle") continue;
    const developmentLabels = payload.development_labels
      || payload.developmentLabels
      || payload.dev_labels;
    if (
      Array.isArray(developmentLabels)
      && developmentLabels.length
      && (
        developmentLabels.length < developmentCount
        || state.developmentLabels.slice(0, developmentCount).some(
          (label, index) => text(label) !== text(developmentLabels[index]),
        )
      )
    ) {
      throw new Error(`${role.label} uses different development periods.`);
    }
  }
}

function calculateCurrent({ renderSelections = true } = {}) {
  try {
    validateSourceShape();
    ensureSelectionConfig();
    state.result = variant === "sr"
      ? calculateSettlementRate({
          paidClaims: state.sourceValues.paid_claims,
          closedClaimNumbers: state.sourceValues.closed_claim_numbers,
          ultimateClaimNumbers: state.sourceValues.ultimate_claim_numbers,
          selectedProportionSettled: state.selectedProportionSettled,
          selectedProportionIsDefault: state.selectedProportionIsDefault,
          selectedAdjustment: state.selectedAdjustment,
          loessSpan: state.loessSpan,
        })
      : calculateCaseReserveAdequacy({
          reportedClaimNumbers: state.sourceValues.reported_claim_numbers,
          closedClaimNumbers: state.sourceValues.closed_claim_numbers,
          incurredClaims: state.sourceValues.incurred_claims,
          paidClaims: state.sourceValues.paid_claims,
          // The stored COL exclusion flags are non-contributing and deferred from the MVP.
          avgCaseReserveExclusions: [],
          avgPaidClaimsExclusions: [],
          inflationSelection: state.inflationSelection,
          userInflation: state.userInflation,
          averageCaseReserveSelection: state.averageCaseReserveSelection,
          userAverageCaseReserves: state.userAverageCaseReserves,
        });
    // A good calculation reports nothing, as in ResQ: the message row only
    // carries failures, and clearing it drops any error from a prior attempt.
    setMethodMessage("");
  } catch (error) {
    state.result = null;
    if (lastOutputPreviewMessage) clearOutputDependencyPreview("invalid");
    setMethodMessage(text(error?.message || error), "error");
  }
  renderMethodTable();
  if (renderSelections) renderSelectionSummary();
  if (isDirty) scheduleOutputDependencyPreview("dirty");
}

function matrixForCurrentView() {
  if (variant === "sr" && state.currentView === "paidClaims") {
    return state.sourceValues.paid_claims || [];
  }
  if (variant === "sr" && state.currentView === "numbersClosed") {
    return state.sourceValues.closed_claim_numbers || [];
  }
  const value = state.result?.[state.currentView];
  return Array.isArray(value) ? value : [];
}

function currentViewDefinition() {
  return viewDefinitions().find((item) => item.key === state.currentView) || viewDefinitions()[0];
}

function formatPercentValue(value) {
  const number = numberOrNull(value);
  if (number === null) return "";
  return `${(number * 100).toLocaleString(undefined, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  })}%`;
}

function parsePercentInput(rawText) {
  const numeric = Number.parseFloat(text(rawText).replace(/%/gu, "").replace(/,/gu, ""));
  return Number.isFinite(numeric) ? numeric / 100 : null;
}

function formatCellValue(value, decimals) {
  const number = numberOrNull(value);
  if (number === null) return "";
  return number.toLocaleString(undefined, {
    maximumFractionDigits: decimals,
    minimumFractionDigits: 0,
  });
}

function syncLoessSpanControls() {
  if (els.loessSpanInput && document.activeElement !== els.loessSpanInput) {
    els.loessSpanInput.value = String(state.loessSpan);
  }
}

// The caption row mirrors the ResQ tab headers, including the Loess Span
// spinner beside the Adjusted Paid Claims caption.
function syncMethodChrome() {
  const caption = variant === "sr" ? text(currentViewDefinition()?.caption) : "";
  const showLoessSpan = variant === "sr" && state.currentView === "output";
  if (els.methodCaptionText) els.methodCaptionText.textContent = caption;
  if (els.loessSpanField) els.loessSpanField.hidden = !showLoessSpan;
  if (els.methodCaption) els.methodCaption.hidden = !caption && !showLoessSpan;
  syncLoessSpanControls();
}

function applyLoessSpan(value) {
  const span = normalizeLoessSpan(value);
  if (span === state.loessSpan) {
    syncLoessSpanControls();
    return;
  }
  state.loessSpan = span;
  syncLoessSpanControls();
  recalculateAfterSelectionEdit();
}

function renderViewButtons() {
  if (!els.viewButtons) return;
  els.viewButtons.replaceChildren();
  for (const view of viewDefinitions()) {
    const button = document.createElement("button");
    button.type = "button";
    const active = view.key === state.currentView;
    button.className = `bsViewTab tabbedPageTab${active ? " active" : ""}`;
    button.dataset.view = view.key;
    button.textContent = view.label;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", active ? "true" : "false");
    button.tabIndex = active ? 0 : -1;
    button.addEventListener("click", () => {
      state.currentView = view.key;
      renderViewButtons();
      renderMethodTable();
      renderSelectionSummary();
    });
    els.viewButtons.appendChild(button);
  }
  syncMethodChrome();
}

function buildMethodHeaderRow(cornerLabel, developmentCount) {
  const headerRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.scope = "col";
  corner.textContent = cornerLabel;
  headerRow.appendChild(corner);
  for (let devIndex = 0; devIndex < developmentCount; devIndex += 1) {
    const header = document.createElement("th");
    header.scope = "col";
    header.textContent = getDevelopmentLabel(devIndex);
    headerRow.appendChild(header);
  }
  return headerRow;
}

function adjustmentGridRows() {
  const span = state.result?.loessSpan ?? state.loessSpan;
  return [
    { method: "unadjusted", label: "Unadjusted :", matrix: state.sourceValues.paid_claims || [] },
    { method: "pairs", label: "Pairs :", matrix: state.result?.pairsAdjustment || [] },
    { method: "all", label: "All :", matrix: state.result?.allAdjustment || [] },
    { method: "loess", label: `Loess (${span}) :`, matrix: state.result?.loessAdjustment || [] },
    { method: "selected", label: "Selected :", matrix: state.result?.adjustedPaidClaims || [] },
  ];
}

function selectedAdjustmentFor(rowIndex, devIndex) {
  const effective = state.result?.selectedAdjustment;
  return norm(effective?.[rowIndex]?.[devIndex] ?? state.selectedAdjustment?.[rowIndex]?.[devIndex]);
}

// ResQ-style Adjusted Paid Claims grid: five estimator rows per origin period.
// Click a value to select that cell, click a row label for the whole origin,
// Ctrl+click a row label for every origin and development period.
function renderAdjustedPaidGrid(view) {
  const paid = state.sourceValues.paid_claims || [];
  const developmentCount = matrixDevelopmentCount();
  els.methodHead.replaceChildren(buildMethodHeaderRow("Accident Year", developmentCount));

  const body = document.createDocumentFragment();
  const gridRows = adjustmentGridRows();
  for (let rowIndex = 0; rowIndex < paid.length; rowIndex += 1) {
    const populatedCount = Array.isArray(paid[rowIndex]) ? paid[rowIndex].length : 0;
    const yearRow = document.createElement("tr");
    yearRow.className = "bsAdjYearRow";
    const yearLabel = document.createElement("td");
    yearLabel.textContent = getOriginLabel(rowIndex);
    yearRow.appendChild(yearLabel);
    const yearFill = document.createElement("td");
    yearFill.colSpan = Math.max(developmentCount, 1);
    yearRow.appendChild(yearFill);
    body.appendChild(yearRow);

    for (const gridRow of gridRows) {
      const isSelectedRow = gridRow.method === "selected";
      const rowElement = document.createElement("tr");
      const label = document.createElement("td");
      label.className = `bsAdjRowLabel${isSelectedRow ? " bsAdjSelectedRowLabel" : ""}`;
      label.textContent = gridRow.label;
      if (!isSelectedRow) {
        label.classList.add("bsAdjPick");
        label.dataset.adjustMethod = gridRow.method;
        label.dataset.adjustOrigin = String(rowIndex);
        label.tabIndex = 0;
        label.title = "Click selects this estimator for the origin period. Ctrl+Click selects it everywhere.";
      }
      rowElement.appendChild(label);
      for (let devIndex = 0; devIndex < developmentCount; devIndex += 1) {
        const cell = document.createElement("td");
        if (devIndex >= populatedCount) {
          cell.className = "bsAdjBlankCell";
          rowElement.appendChild(cell);
          continue;
        }
        const rawValue = gridRow.matrix[rowIndex]?.[devIndex];
        cell.textContent = formatCellValue(rawValue, view.decimals);
        cell.title = numberOrNull(rawValue) === null ? "" : String(rawValue);
        if (isSelectedRow) {
          cell.className = "bsAdjSelectedValue";
        } else {
          cell.className = "bsAdjCell bsAdjPick";
          cell.dataset.adjustMethod = gridRow.method;
          cell.dataset.adjustOrigin = String(rowIndex);
          cell.dataset.adjustDev = String(devIndex);
          cell.tabIndex = 0;
          if (selectedAdjustmentFor(rowIndex, devIndex) === gridRow.method) {
            cell.classList.add("bsAdjSelectedSource");
          }
        }
        rowElement.appendChild(cell);
      }
      body.appendChild(rowElement);
    }
  }
  els.methodBody.replaceChildren(body);
}

function applyAdjustmentSelection(method, originIndex, devIndex, applyToAllOrigins) {
  const paid = state.sourceValues.paid_claims || [];
  if (applyToAllOrigins) {
    state.selectedAdjustment = paid.map((row) => (Array.isArray(row) ? row : []).map(() => method));
  } else if (devIndex === null) {
    state.selectedAdjustment[originIndex] = (paid[originIndex] || []).map(() => method);
  } else {
    const row = paid[originIndex] || [];
    const previous = Array.isArray(state.selectedAdjustment[originIndex])
      ? state.selectedAdjustment[originIndex]
      : [];
    if (previous.length < row.length) {
      state.selectedAdjustment[originIndex] = row.map((_, index) => previous[index] ?? null);
    }
    state.selectedAdjustment[originIndex][devIndex] = method;
  }
  recalculateAfterSelectionEdit();
}

function handleAdjustmentGridEvent(event) {
  if (variant !== "sr" || state.currentView !== "output") return;
  const target = event.target instanceof Element
    ? event.target.closest("[data-adjust-method]")
    : null;
  if (!target) return;
  if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  const method = text(target.dataset.adjustMethod);
  const originIndex = Number.parseInt(target.dataset.adjustOrigin || "", 10);
  if (!method || !Number.isInteger(originIndex)) return;
  const devRaw = Number.parseInt(target.dataset.adjustDev || "", 10);
  applyAdjustmentSelection(
    method,
    originIndex,
    Number.isInteger(devRaw) ? devRaw : null,
    (event.ctrlKey || event.metaKey) && !Number.isInteger(devRaw),
  );
}

// The green highlight marks the proportion cell currently feeding each
// development period: the leading diagonal by default, or the clicked value.
function proportionHighlightRowIndex(proportionMatrix, devIndex) {
  const isDefault = state.selectedProportionIsDefault[devIndex] === true;
  const selected = numberOrNull(state.result?.selectedProportionSettled?.[devIndex]);
  for (let rowIndex = proportionMatrix.length - 1; rowIndex >= 0; rowIndex -= 1) {
    const value = numberOrNull(proportionMatrix[rowIndex]?.[devIndex]);
    if (value === null) continue;
    if (isDefault) return rowIndex;
    if (selected !== null && Math.abs(value - selected) <= Math.max(1e-12, Math.abs(selected) * 1e-9)) {
      return rowIndex;
    }
  }
  return -1;
}

// ResQ-style Proportion Settled tab: click a triangle value to select it for
// that development period, type into the Selected row for custom values, and
// right-click for Select Leading Diagonal.
function renderProportionSettledGrid() {
  const proportionMatrix = Array.isArray(state.result?.proportionSettled)
    ? state.result.proportionSettled
    : [];
  const developmentCount = matrixDevelopmentCount();
  els.methodHead.replaceChildren(buildMethodHeaderRow("Accident Year", developmentCount));

  const body = document.createDocumentFragment();
  const highlightByColumn = Array.from(
    { length: developmentCount },
    (_, devIndex) => proportionHighlightRowIndex(proportionMatrix, devIndex),
  );
  for (let rowIndex = 0; rowIndex < proportionMatrix.length; rowIndex += 1) {
    const rowElement = document.createElement("tr");
    const origin = document.createElement("td");
    origin.textContent = getOriginLabel(rowIndex);
    rowElement.appendChild(origin);
    for (let devIndex = 0; devIndex < developmentCount; devIndex += 1) {
      const cell = document.createElement("td");
      const rawValue = numberOrNull(proportionMatrix[rowIndex]?.[devIndex]);
      if (rawValue === null) {
        rowElement.appendChild(cell);
        continue;
      }
      cell.className = "bsPropCell";
      cell.textContent = formatPercentValue(rawValue);
      cell.title = String(rawValue);
      cell.dataset.propDev = String(devIndex);
      cell.dataset.propValue = String(rawValue);
      cell.tabIndex = 0;
      if (highlightByColumn[devIndex] === rowIndex) cell.classList.add("bsPropSelectedSource");
      rowElement.appendChild(cell);
    }
    body.appendChild(rowElement);
  }

  const spacerRow = document.createElement("tr");
  spacerRow.className = "bsPropSpacerRow";
  for (let index = 0; index <= developmentCount; index += 1) {
    spacerRow.appendChild(document.createElement("td"));
  }
  body.appendChild(spacerRow);

  const selectedRow = document.createElement("tr");
  selectedRow.className = "bsPropSelectedRow";
  const selectedLabel = document.createElement("td");
  selectedLabel.textContent = "Selected";
  selectedRow.appendChild(selectedLabel);
  const selectedValues = Array.isArray(state.result?.selectedProportionSettled)
    ? state.result.selectedProportionSettled
    : state.selectedProportionSettled;
  for (let devIndex = 0; devIndex < developmentCount; devIndex += 1) {
    const cell = document.createElement("td");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "bsPropSelectedInput";
    input.value = formatPercentValue(selectedValues[devIndex]);
    input.setAttribute(
      "aria-label",
      `${getDevelopmentLabel(devIndex)} selected proportion settled`,
    );
    input.dataset.propDev = String(devIndex);
    cell.appendChild(input);
    selectedRow.appendChild(cell);
  }
  body.appendChild(selectedRow);
  els.methodBody.replaceChildren(body);
}

function applyProportionSelection(devIndex, value) {
  const parsed = numberOrNull(value);
  if (parsed === null || !Number.isInteger(devIndex) || devIndex < 0) return;
  ensureSelectionConfig();
  state.selectedProportionSettled[devIndex] = parsed;
  state.selectedProportionIsDefault[devIndex] = false;
  recalculateAfterSelectionEdit();
}

function selectLeadingDiagonal() {
  state.selectedProportionIsDefault = Array(matrixDevelopmentCount()).fill(true);
  recalculateAfterSelectionEdit();
}

let proportionContextMenu = null;

function hideProportionContextMenu() {
  if (proportionContextMenu) proportionContextMenu.style.display = "none";
}

function ensureProportionContextMenu() {
  if (proportionContextMenu) return proportionContextMenu;
  proportionContextMenu = document.createElement("div");
  proportionContextMenu.className = "ctx-menu";
  proportionContextMenu.style.display = "none";
  const inner = document.createElement("div");
  inner.className = "ctx-menu-inner";
  const item = document.createElement("button");
  item.type = "button";
  item.className = "ctx-item";
  item.textContent = "Select Leading Diagonal";
  item.addEventListener("click", () => {
    hideProportionContextMenu();
    selectLeadingDiagonal();
  });
  inner.appendChild(item);
  proportionContextMenu.appendChild(inner);
  document.body.appendChild(proportionContextMenu);
  document.addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof Element) || !proportionContextMenu.contains(event.target)) {
      hideProportionContextMenu();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideProportionContextMenu();
  });
  return proportionContextMenu;
}

function handleProportionGridEvent(event) {
  if (variant !== "sr" || state.currentView !== "proportionSettled") return;
  if (event.type === "contextmenu") {
    event.preventDefault();
    const menu = ensureProportionContextMenu();
    menu.style.display = "block";
    openContextMenu(menu, { clientX: event.clientX, clientY: event.clientY });
    return;
  }
  if (event.target instanceof HTMLInputElement && event.target.classList.contains("bsPropSelectedInput")) {
    const input = event.target;
    const commit = () => {
      const devIndex = Number.parseInt(input.dataset.propDev || "", 10);
      const parsed = parsePercentInput(input.value);
      if (parsed === null) {
        input.value = formatPercentValue(state.result?.selectedProportionSettled?.[devIndex]);
        return;
      }
      applyProportionSelection(devIndex, parsed);
    };
    if (event.type === "change") commit();
    if (event.type === "keydown" && event.key === "Enter") input.blur();
    return;
  }
  if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
  const cell = event.target instanceof Element ? event.target.closest("td.bsPropCell") : null;
  if (!cell) return;
  event.preventDefault();
  applyProportionSelection(
    Number.parseInt(cell.dataset.propDev || "", 10),
    numberOrNull(cell.dataset.propValue),
  );
}

function renderMethodTable() {
  if (!els.methodHead || !els.methodBody) return;
  const view = currentViewDefinition();
  syncMethodChrome();
  if (variant === "sr" && state.currentView === "output" && state.result) {
    renderAdjustedPaidGrid(view);
    return;
  }
  if (variant === "sr" && state.currentView === "proportionSettled" && state.result) {
    renderProportionSettledGrid();
    return;
  }
  const matrix = matrixForCurrentView();
  const developmentCount = Math.max(
    matrixDevelopmentCount(),
    ...matrix.map((row) => Array.isArray(row) ? row.length : 0),
    0,
  );
  const showUltimateColumn = variant === "sr" && state.currentView === "numbersClosed";

  const headerRow = buildMethodHeaderRow(
    variant === "sr" ? "Accident Year" : "Origin",
    developmentCount,
  );
  if (showUltimateColumn) {
    const ultimateHeader = document.createElement("th");
    ultimateHeader.scope = "col";
    ultimateHeader.textContent = "Ultimate";
    headerRow.appendChild(ultimateHeader);
  }
  els.methodHead.replaceChildren(headerRow);

  const body = document.createDocumentFragment();
  const rowCount = Math.max(matrixRowCount(), matrix.length);
  const ultimateValues = state.sourceValues.ultimate_claim_numbers || [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const rowElement = document.createElement("tr");
    const origin = document.createElement("td");
    origin.textContent = getOriginLabel(rowIndex);
    rowElement.appendChild(origin);
    for (let devIndex = 0; devIndex < developmentCount; devIndex += 1) {
      const cell = document.createElement("td");
      const rawValue = matrix[rowIndex]?.[devIndex];
      const display = formatCellValue(rawValue, view.decimals);
      cell.textContent = display;
      cell.title = numberOrNull(rawValue) === null ? "" : String(rawValue);
      // ResQ renders the Settlement Rate triangles as plain cells; the CRA
      // views keep the calculated-result fill.
      if (variant !== "sr") cell.className = "bsResultCell";
      rowElement.appendChild(cell);
    }
    if (showUltimateColumn) {
      const ultimateCell = document.createElement("td");
      const rawValue = ultimateValues[rowIndex];
      ultimateCell.textContent = formatCellValue(rawValue, view.decimals);
      ultimateCell.title = numberOrNull(rawValue) === null ? "" : String(rawValue);
      rowElement.appendChild(ultimateCell);
    }
    body.appendChild(rowElement);
  }
  els.methodBody.replaceChildren(body);
}

function selectionDisplayLabel(value) {
  const labels = {
    case_column: "Case Column",
    case_all: "Case All",
    paid_column: "Paid Column",
    paid_all: "Paid All",
    user: "User",
    latest: "Latest",
    monotone: "Monotone",
  };
  return labels[norm(value).replace(/\s+/g, "_")] || text(value);
}

function createSelectionSelect(value, options, ariaLabel, onChange) {
  const select = document.createElement("select");
  select.className = "bsSelectionSelect";
  select.setAttribute("aria-label", ariaLabel);
  for (const optionValue of options) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = selectionDisplayLabel(optionValue);
    select.appendChild(option);
  }
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function createSelectionNumber(value, ariaLabel, onChange) {
  const input = document.createElement("input");
  input.className = "bsSelectionNumber";
  input.type = "number";
  input.step = "any";
  input.value = numberOrNull(value) === null ? "" : String(value);
  input.setAttribute("aria-label", ariaLabel);
  input.addEventListener("input", () => onChange(numberOrNull(input.value)));
  return input;
}

function appendSelectionTitle(container, title) {
  const heading = document.createElement("strong");
  heading.className = "bsSelectionHeading";
  heading.textContent = title;
  container.appendChild(heading);
}

function recalculateAfterSelectionEdit({ renderSelections = true } = {}) {
  calculateCurrent({ renderSelections });
  markDirty();
}

function renderCaseReserveSelections() {
  const developmentCount = matrixDevelopmentCount();
  const editorRow = document.createElement("div");
  editorRow.className = "bsSelectionEditorRow";
  appendSelectionTitle(editorRow, "Development selections");
  for (let devIndex = 0; devIndex < developmentCount; devIndex += 1) {
    const age = getDevelopmentLabel(devIndex);
    const card = document.createElement("div");
    card.className = "bsSelectionEditor wide";
    const label = document.createElement("span");
    label.className = "bsSelectionEditorLabel";
    label.textContent = age;
    const inflationSelect = createSelectionSelect(
      state.inflationSelection[devIndex] || "paid_all",
      ["case_column", "case_all", "paid_column", "paid_all", "user"],
      `${age} inflation selection`,
      (value) => {
        state.inflationSelection[devIndex] = value;
        recalculateAfterSelectionEdit();
      },
    );
    const inflationInput = createSelectionNumber(
      state.userInflation[devIndex],
      `${age} user inflation`,
      (value) => {
        state.userInflation[devIndex] = value ?? 0;
        recalculateAfterSelectionEdit({ renderSelections: false });
      },
    );
    inflationInput.disabled = inflationSelect.value !== "user";
    inflationSelect.addEventListener("change", () => {
      inflationInput.disabled = inflationSelect.value !== "user";
    });
    const averageSelect = createSelectionSelect(
      state.averageCaseReserveSelection[devIndex] || "latest",
      ["latest", "monotone", "user"],
      `${age} average case reserve selection`,
      (value) => {
        state.averageCaseReserveSelection[devIndex] = value;
        recalculateAfterSelectionEdit();
      },
    );
    const averageInput = createSelectionNumber(
      state.userAverageCaseReserves[devIndex],
      `${age} user average case reserve`,
      (value) => {
        state.userAverageCaseReserves[devIndex] = value ?? 0;
        recalculateAfterSelectionEdit({ renderSelections: false });
      },
    );
    averageInput.disabled = averageSelect.value !== "user";
    averageSelect.addEventListener("change", () => {
      averageInput.disabled = averageSelect.value !== "user";
    });
    const inflationField = document.createElement("label");
    inflationField.className = "bsSelectionField";
    inflationField.append("Inflation", inflationSelect, inflationInput);
    const averageField = document.createElement("label");
    averageField.className = "bsSelectionField";
    averageField.append("Average", averageSelect, averageInput);
    card.append(label, inflationField, averageField);
    editorRow.appendChild(card);
  }
  els.selectionSummary.appendChild(editorRow);
}

function renderSelectionSummary() {
  if (!els.selectionSummary) return;
  els.selectionSummary.replaceChildren();
  if (variant === "sr") {
    // Settlement Rate selections live inside the Method grids themselves: the
    // Proportion Settled tab's Selected row and the Adjusted Paid Claims grid.
    els.selectionSummary.hidden = true;
    return;
  }
  els.selectionSummary.hidden = false;
  if (!matrixDevelopmentCount()) {
    appendSelectionTitle(els.selectionSummary, "Waiting for source data.");
    return;
  }
  renderCaseReserveSelections();
}

function normalizeCachedRow(row) {
  const rawName = text(row?.datasetName || row?.dataset_name || row?.name || row?.datasetTypeName || row?.dataset_type);
  const name = rawName;
  return {
    ...row,
    name,
    datasetName: name,
    datasetType: text(row?.datasetTypeName || row?.dataset_type || row?.datasetType || name),
    dataFormat: text(row?.dataFormat || row?.data_format || row?.meta?.dataFormat),
    methodType: text(row?.methodType || row?.method_type || row?.meta?.methodType),
    sourceKind: text(row?.sourceKind || row?.source_kind || row?.meta?.sourceKind),
    csvFile: text(row?.csvFile || row?.csv_file || row?.meta?.csvFile || csvBaseName(row?.path)),
    originLength: Number(row?.meta?.originLength ?? row?.originLength ?? row?.origin_length) || 0,
    developmentLength: Number(row?.meta?.developmentLength ?? row?.developmentLength ?? row?.development_length) || 0,
  };
}

async function loadCachedRows(force = false) {
  if (!state.project || !state.reservingClass) return [];
  const sharedPayload = !force && params.get("project_instance") === "1"
    ? readProjectInstanceDatasetSnapshot(state.project, state.reservingClass)
    : null;
  if (sharedPayload) {
    state.cachedRows = sharedPayload.files.map(normalizeCachedRow).filter((row) => row.name);
    return state.cachedRows;
  }
  const query = new URLSearchParams({
    project_name: state.project,
    reserving_class: state.reservingClass,
  });
  if (force) query.set("refresh", "1");
  const response = await fetch(`/datasets/cached?${query.toString()}`, { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.detail || payload?.error || `Dataset cache failed (${response.status}).`);
  }
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
  return state.cachedRows.find((row) => (
    norm(row.name) === key || norm(row.datasetType) === key
  )) || null;
}

async function loadDatasetPayload(datasetName) {
  const name = text(datasetName);
  if (!state.project || !state.reservingClass || !name) {
    throw new Error("Missing project, reserving class, or dataset name.");
  }
  const record = cachedRecordByName(name);
  if (
    record
    && (
      (record.originLength && record.originLength !== ANNUAL_PERIOD_LENGTH)
      || (record.developmentLength && record.developmentLength !== ANNUAL_PERIOD_LENGTH)
    )
  ) {
    throw new Error(`${name} is not an annual dataset.`);
  }
  const body = {
    project_name: state.project,
    reserving_class: state.reservingClass,
    dataset_name: name,
    origin_length: ANNUAL_PERIOD_LENGTH,
    development_length: ANNUAL_PERIOD_LENGTH,
    cumulative: true,
    calendar: false,
  };
  if (record?.csvFile) body.csv_file = record.csvFile;
  const response = await fetch("/dataset/cache/load", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.detail || payload?.error || `Dataset load failed (${response.status}).`);
  }
  const originLength = Number(payload?.origin_length) || ANNUAL_PERIOD_LENGTH;
  const developmentLength = Number(payload?.development_length) || ANNUAL_PERIOD_LENGTH;
  if (originLength !== ANNUAL_PERIOD_LENGTH || developmentLength !== ANNUAL_PERIOD_LENGTH) {
    throw new Error(`${name} is not an annual dataset.`);
  }
  return payload;
}

function applyPayloadToRole(role, payload) {
  const payloadFormat = text(payload?.data_format || payload?.dataFormat);
  if (norm(payloadFormat) !== norm(role.format)) {
    throw new Error(
      `${role.label} must be an annual ${role.format.toLowerCase()} dataset.`,
    );
  }
  const values = role.format === "Vector"
    ? normalizeVector(payload?.values)
    : normalizeMatrix(payload?.values);
  state.sourceValues[role.key] = values;
  state.sourcePayloads[role.key] = payload;
  if (role.format === "Triangle") {
    const originLabels = payload?.origin_labels || payload?.originLabels;
    const developmentLabels = payload?.development_labels || payload?.developmentLabels || payload?.dev_labels;
    if (Array.isArray(originLabels) && originLabels.length === values.length) {
      if (!state.originLabels.length || state.originLabels.length !== values.length) {
        state.originLabels = originLabels.map(String);
      }
    }
    const developmentCount = Math.max(0, ...values.map((row) => row.length));
    if (Array.isArray(developmentLabels) && developmentLabels.length >= developmentCount) {
      if (!state.developmentLabels.length || state.developmentLabels.length < developmentCount) {
        state.developmentLabels = developmentLabels.slice(0, developmentCount).map(String);
      }
    }
  }
}

async function refreshOriginLabels() {
  const expectedCount = matrixRowCount();
  if (!expectedCount || state.originLabels.length === expectedCount) return;
  if (state.sidecarOriginLabels.length === expectedCount) {
    state.originLabels = state.sidecarOriginLabels.slice();
    return;
  }
  try {
    state.originLabels = await ensureDatasetOriginLabels(
      state.project,
      ANNUAL_PERIOD_LENGTH,
      { expectedCount, requireMatchingPeriod: true },
    );
  } catch {
    state.originLabels = [];
  }
}

async function refreshDevelopmentLabels() {
  const expectedCount = matrixDevelopmentCount();
  if (!expectedCount || state.developmentLabels.length >= expectedCount) return;
  const labels = await headersService.ensureDevHeadersForProject(state.project);
  state.developmentLabels = Array.isArray(labels)
    ? labels.slice(0, expectedCount).map(String)
    : [];
}

async function refreshSourceRoles(roles = roleDefinitions(), { refreshCache = false } = {}) {
  if (refreshCache) await loadCachedRows(true).catch(() => {});
  const selectedRoles = roles.filter((role) => text(state.sourceNames[role.key]));
  const loaded = await Promise.all(selectedRoles.map(async (role) => ({
    role,
    payload: await loadDatasetPayload(state.sourceNames[role.key]),
  })));
  for (const item of loaded) applyPayloadToRole(item.role, item.payload);
  reapplyActiveDependencyPreviews();
  await refreshOriginLabels();
  await refreshDevelopmentLabels();
  calculateCurrent();
}

function normalizedReservingClassPath(value) {
  return text(value).replace(/\\+/g, "\\").toLowerCase();
}

function dependencyMessageMatchesContext(message = {}) {
  if (text(message.inst) && text(message.inst) === inst) return false;
  const project = text(message.project || message.project_name);
  if (project && norm(project) !== norm(state.project)) return false;
  const reservingClass = text(message.reservingClass || message.reserving_class);
  return !reservingClass
    || normalizedReservingClassPath(reservingClass) === normalizedReservingClassPath(state.reservingClass);
}

function dependencyMessageNames(message = {}) {
  return new Set([
    ...(Array.isArray(message.names) ? message.names : []),
    message.datasetName,
    message.datasetTypeName,
    message.name,
  ].map(norm).filter(Boolean));
}

function dependencyRolesMatchingMessage(message = {}) {
  if (!dependencyMessageMatchesContext(message)) return [];
  const names = dependencyMessageNames(message);
  if (!names.size) return [];
  return roleDefinitions().filter((role) => names.has(norm(state.sourceNames[role.key])));
}

function dependencyValuesForRole(message, role) {
  const matrixValues = Array.isArray(message.matrixValues)
    ? message.matrixValues
    : Array.isArray(message.matrix_values)
      ? message.matrix_values
      : message.values;
  return role.format === "Vector"
    ? normalizeVector(matrixValues)
    : normalizeMaskedMatrix(matrixValues, message.mask);
}

function assertDependencyPreviewCompatible(message, role, values) {
  const dataFormat = text(message.dataFormat || message.data_format);
  if (dataFormat && norm(dataFormat) !== norm(role.format)) {
    throw new Error(`${role.label} preview has the wrong data format.`);
  }
  const originLabels = message.originLabels || message.origin_labels;
  if (
    Array.isArray(originLabels)
    && originLabels.length
    && (
      originLabels.length !== state.originLabels.length
      || originLabels.some((label, index) => text(label) !== text(state.originLabels[index]))
    )
  ) {
    throw new Error(`${role.label} preview uses different origin periods.`);
  }
  if (role.format === "Triangle") {
    const developmentLabels = message.developmentLabels || message.development_labels;
    const developmentCount = Math.max(0, ...values.map((row) => row.length));
    if (
      Array.isArray(developmentLabels)
      && developmentLabels.length
      && state.developmentLabels.slice(0, developmentCount).some(
        (label, index) => text(label) !== text(developmentLabels[index]),
      )
    ) {
      throw new Error(`${role.label} preview uses different development periods.`);
    }
  }
}

function applyDependencyValues(role, values) {
  state.sourceValues[role.key] = role.format === "Vector"
    ? normalizeVector(values)
    : normalizeMatrix(values);
}

function reapplyActiveDependencyPreviews() {
  for (const [roleKey, preview] of Array.from(activeDependencyPreviews.entries())) {
    const role = roleByKey(roleKey);
    if (!role || norm(state.sourceNames[role.key]) !== norm(preview.sourceName)) {
      activeDependencyPreviews.delete(roleKey);
      continue;
    }
    applyDependencyValues(role, preview.values);
  }
}

function applyDependencySourcePreview(message = {}) {
  const roles = dependencyRolesMatchingMessage(message);
  if (!roles.length) return false;
  let changed = false;
  for (const role of roles) {
    const values = dependencyValuesForRole(message, role);
    if (!values.length) continue;
    assertDependencyPreviewCompatible(message, role, values);
    activeDependencyPreviews.set(role.key, {
      sourceName: state.sourceNames[role.key],
      values,
    });
    applyDependencyValues(role, values);
    changed = true;
  }
  if (changed) {
    calculateCurrent();
    scheduleOutputDependencyPreview("upstream-preview", true);
  }
  return changed;
}

async function clearDependencySourcePreview(message = {}) {
  const roles = dependencyRolesMatchingMessage(message)
    .filter((role) => activeDependencyPreviews.has(role.key));
  if (!roles.length) return false;
  for (const role of roles) activeDependencyPreviews.delete(role.key);
  const reason = norm(message.reason);
  await refreshSourceRoles(roles, { refreshCache: reason === "save" || reason === "clean" });
  if (isDirty || activeDependencyPreviews.size > 0) {
    scheduleOutputDependencyPreview("dirty", true);
  } else {
    clearOutputDependencyPreview("upstream-cleared");
  }
  return true;
}

function syncSourceInputs() {
  for (const role of roleDefinitions()) {
    const input = document.getElementById(role.inputId);
    if (input) input.value = text(state.sourceNames[role.key]);
  }
}

async function openPicker(roleKey, anchorElement) {
  await loadCachedRows().catch(() => {});
  const role = roleKey === "output" ? null : roleByKey(roleKey);
  const format = role?.format || "Triangle";
  await openDatasetNamePicker({
    projectName: state.project,
    initialName: role ? state.sourceNames[role.key] : getDetails().outputType,
    anchorElement: anchorElement instanceof Element ? anchorElement : null,
    title: role ? `Select ${role.label}` : "Select Output Type",
    allowedDataFormats: [format],
    includeCalculated: true,
    emptyMessage: `No annual ${format.toLowerCase()} datasets found.`,
    itemFilter: (item) => {
      if (!role) return true;
      const record = cachedRecordByName(item?.name);
      if (!record || norm(record.dataFormat) !== norm(format)) return false;
      return (!record.originLength || record.originLength === ANNUAL_PERIOD_LENGTH)
        && (!record.developmentLength || record.developmentLength === ANNUAL_PERIOD_LENGTH);
    },
    setStatus: (message) => {
      if (text(message)) postStatus(message, "warn");
    },
    onError: (error) => {
      console.error(error);
      postStatus(`Dataset picker failed: ${text(error?.message || error)}`, "error");
    },
    onSelect: async (name) => {
      const selected = text(name);
      if (!selected) return;
      if (!role) {
        withProgrammatic(() => {
          els.outputTypeInput.value = selected;
          if (!text(els.nameInput.value)) els.nameInput.value = selected;
        });
        syncTitle();
        markDirty();
        return;
      }
      const priorName = state.sourceNames[role.key];
      const hadPriorValues = Object.prototype.hasOwnProperty.call(state.sourceValues, role.key);
      const priorValues = state.sourceValues[role.key];
      const hadPriorPayload = Object.prototype.hasOwnProperty.call(state.sourcePayloads, role.key);
      const priorPayload = state.sourcePayloads[role.key];
      const priorPreview = activeDependencyPreviews.get(role.key);
      state.sourceNames[role.key] = selected;
      activeDependencyPreviews.delete(role.key);
      syncSourceInputs();
      try {
        await refreshSourceRoles([role]);
        postStatus(`${role.label} selected: ${selected}`);
      } catch (error) {
        state.sourceNames[role.key] = priorName;
        if (hadPriorValues) state.sourceValues[role.key] = priorValues;
        else delete state.sourceValues[role.key];
        if (hadPriorPayload) state.sourcePayloads[role.key] = priorPayload;
        else delete state.sourcePayloads[role.key];
        if (priorPreview) activeDependencyPreviews.set(role.key, priorPreview);
        else activeDependencyPreviews.delete(role.key);
        syncSourceInputs();
        calculateCurrent();
        setMethodMessage(text(error?.message || error), "error");
        postStatus(`Source load failed: ${text(error?.message || error)}`, "error");
      }
      markDirty();
    },
  });
}

async function getWorkspacePathsConfig() {
  const response = await fetch("/workspace_paths", { cache: "no-store" });
  if (!response.ok) throw new Error(`Workspace paths failed (${response.status}).`);
  const payload = await response.json().catch(() => ({}));
  const config = payload?.config && typeof payload.config === "object" ? payload.config : {};
  const paths = config.paths && typeof config.paths === "object" ? config.paths : {};
  return {
    root: text(config.workspace_root) || "E:\\ArcRho Server",
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
      return index === 0
        ? value.replace(/[\\/]+$/g, "")
        : value.replace(/^[\\/]+|[\\/]+$/g, "");
    })
    .filter(Boolean)
    .join("\\");
}

async function getProjectDataDir() {
  const config = await getWorkspacePathsConfig();
  const projectsRoot = isAbsolutePath(config.projectsDir)
    ? config.projectsDir
    : joinPath(config.root, config.projectsDir);
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
  return `${contract.filenamePrefix}${sanitizeFileNamePart(getDetails().name || contract.methodType, "Name")}.json`;
}

async function getMethodPath() {
  return joinPath(await getMethodsDir(), getMethodFilename());
}

function getCsvFilename() {
  const name = sanitizeFileNamePart(getDetails().name || contract.methodType, "Dataset");
  return `${name}@${ANNUAL_PERIOD_LENGTH}@${ANNUAL_PERIOD_LENGTH}@cum@dev.csv`;
}

async function getCsvPath() {
  return joinPath(await getDatasetDir(), getCsvFilename());
}

function cloneMatrix(values) {
  return Array.isArray(values)
    ? values.map((row) => Array.isArray(row) ? row.slice() : [])
    : [];
}

function buildMethodPayload() {
  const details = getDetails();
  const methodTab = {
    origin_labels: state.originLabels.map(String),
    development_labels: Array.from(
      { length: matrixDevelopmentCount() },
      (_, index) => getDevelopmentLabel(index),
    ),
  };
  for (const role of roleDefinitions()) methodTab[role.key] = text(state.sourceNames[role.key]);
  if (variant === "sr") {
    methodTab.selected_proportion_settled = state.selectedProportionSettled.slice();
    methodTab.selected_proportion_is_default = state.selectedProportionIsDefault.slice();
    methodTab.selected_adjustment = cloneMatrix(state.selectedAdjustment);
    methodTab.loess_span = state.loessSpan;
  } else {
    methodTab.inflation_selection = state.inflationSelection.slice();
    methodTab.user_inflation = state.userInflation.slice();
    methodTab.average_case_reserve_selection = state.averageCaseReserveSelection.slice();
    methodTab.user_average_case_reserves = state.userAverageCaseReserves.slice();
  }
  return {
    json_format: contract.jsonFormat,
    details_tab: {
      name: details.name,
      method_type: contract.methodType,
      output_type: details.outputType,
      origin_length: ANNUAL_PERIOD_LENGTH,
      development_length: ANNUAL_PERIOD_LENGTH,
    },
    method_tab: methodTab,
    audit_log_tab: {},
    method_metadata: {
      method_type: contract.methodType,
      source_kind: contract.sourceKind,
      last_modified: new Date().toISOString(),
    },
  };
}

function applyMethodPayload(payload) {
  const data = payload && typeof payload === "object" ? payload : {};
  const details = data.details_tab || {};
  const method = data.method_tab || {};
  withProgrammatic(() => {
    els.nameInput.value = text(details.name || els.nameInput.value);
    els.outputTypeInput.value = text(details.output_type || els.outputTypeInput.value);
  });
  for (const role of roleDefinitions()) {
    state.sourceNames[role.key] = text(method[role.key] || state.sourceNames[role.key]);
  }
  state.originLabels = Array.isArray(method.origin_labels) ? method.origin_labels.map(String) : [];
  state.developmentLabels = Array.isArray(method.development_labels)
    ? method.development_labels.map(String)
    : [];
  state.selectedProportionSettled = normalizeNumberVector(method.selected_proportion_settled);
  state.selectedProportionIsDefault = normalizeBooleanVector(method.selected_proportion_is_default);
  state.selectedAdjustment = normalizeSelectionMatrix(method.selected_adjustment);
  if (variant === "sr") state.loessSpan = normalizeLoessSpan(method.loess_span);
  state.inflationSelection = normalizeStringVector(method.inflation_selection);
  state.userInflation = normalizeNumberVector(method.user_inflation);
  state.averageCaseReserveSelection = normalizeStringVector(method.average_case_reserve_selection);
  state.userAverageCaseReserves = normalizeNumberVector(method.user_average_case_reserves);
  syncSourceInputs();
  syncTitle();
  renderSelectionSummary();
  syncLoessSpanControls();
}

async function tryLoadExistingMethod() {
  if (params.get("fresh") === "1") return false;
  const hostApi = getHostApi();
  if (!hostApi?.readJsonFile) return false;
  const result = await hostApi.readJsonFile({ path: await getMethodPath() });
  if (!result?.exists || !result.data) return false;
  applyMethodPayload(result.data);
  postStatus(`Loaded ${contract.methodType}: ${getDetails().name}`);
  return true;
}

function getPrecedentNames() {
  const seen = new Set();
  const names = [];
  for (const role of roleDefinitions()) {
    const name = text(state.sourceNames[role.key]);
    const key = norm(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
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
    const response = await fetch("/dataset/sidecar/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: state.project,
        reserving_class: state.reservingClass,
        dataset_name: details.name,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (requestSequence !== sidecarLoadSequence) return null;
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.detail || payload?.error || `Sidecar load failed (${response.status}).`);
    }
    const sidecar = payload?.sidecar || payload?.data || payload;
    state.sidecarOriginLabels = Array.isArray(sidecar?.origin_labels)
      ? sidecar.origin_labels.map(String)
      : [];
    state.numberFormat = text(sidecar?.number_format) || state.numberFormat;
    notesController.setValue(text(sidecar?.notes), { markClean: true });
    const decimalPlaces = Number.parseInt(String(sidecar?.decimal_places ?? ""), 10);
    if (Number.isInteger(decimalPlaces) && decimalPlaces >= 0 && decimalPlaces <= 6) {
      state.decimalPlaces = decimalPlaces;
    }
    auditLogView.render(sidecar?.audit_log);
    return sidecar;
  } catch (error) {
    if (requestSequence !== sidecarLoadSequence) return null;
    auditLogView.setError(`Could not load the audit log. ${text(error?.message || error)}`);
    return null;
  }
}

async function saveSidecar(csvPath) {
  const details = getDetails();
  const response = await fetch("/dataset/sidecar/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_name: state.project,
      reserving_class: state.reservingClass,
      dataset_name: details.name,
      dataset_type: details.outputType || details.name,
      instance_name: details.name,
      source_kind: contract.sourceKind,
      method_type: contract.methodType,
      status: 0,
      data_format: "Triangle",
      origin_length: ANNUAL_PERIOD_LENGTH,
      development_length: ANNUAL_PERIOD_LENGTH,
      cumulative: true,
      transposed: false,
      calendar: false,
      number_format: state.numberFormat,
      decimal_places: state.decimalPlaces,
      origin_labels: state.originLabels.map(String),
      csv_file: csvBaseName(csvPath),
      notes: notesController.getValue(),
      precedents: getPrecedentNames(),
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.detail || payload?.error || `Sidecar save failed (${response.status}).`);
  }
  sidecarLoadSequence += 1;
  auditLogView.render(payload?.audit_log);
  return payload;
}

function matrixCsv(values) {
  const matrix = normalizeMatrix(values);
  const width = Math.max(matrixDevelopmentCount(), ...matrix.map((row) => row.length), 0);
  return `${matrix.map((row) => (
    Array.from({ length: width }, (_, index) => {
      const number = numberOrNull(row[index]);
      return number === null ? "" : String(number);
    }).join(",")
  )).join("\n")}\n`;
}

function blockSaveForActiveSourcePreviews() {
  if (activeDependencyPreviews.size === 0) return false;
  postStatus(
    `${contract.methodType} cannot save while a source has unsaved preview changes. Save or discard the source first.`,
    "error",
  );
  return true;
}

async function saveMethod() {
  const details = getDetails();
  if (!details.name || !details.outputType) {
    postStatus(`${contract.methodType} save requires Name and Output Type.`, "error");
    return { ok: false };
  }
  const missing = roleDefinitions().filter((role) => !text(state.sourceNames[role.key]));
  if (missing.length) {
    postStatus(`${contract.methodType} save requires ${missing.map((role) => role.label).join(", ")}.`, "error");
    return { ok: false };
  }
  if (blockSaveForActiveSourcePreviews()) return { ok: false };
  await refreshSourceRoles();
  if (blockSaveForActiveSourcePreviews()) return { ok: false };
  const output = state.result?.output;
  if (!Array.isArray(output) || !output.some((row) => row.some((value) => numberOrNull(value) !== null))) {
    postStatus(`${contract.methodType} output is blank. Check the selected sources.`, "error");
    return { ok: false };
  }
  const hostApi = getHostApi();
  if (!hostApi?.saveJsonFile || !hostApi?.saveTextFile) {
    postStatus(`${contract.methodType} save requires the desktop app.`, "error");
    return { ok: false };
  }
  const methodPath = await getMethodPath();
  const jsonResult = await hostApi.saveJsonFile({
    path: methodPath,
    suggestedName: getMethodFilename(),
    startDir: await getMethodsDir(),
    data: buildMethodPayload(),
  });
  if (!jsonResult?.path || jsonResult?.error) {
    throw new Error(jsonResult?.error || "Method JSON save failed.");
  }
  const csvPath = await getCsvPath();
  const csvResult = await hostApi.saveTextFile({
    path: csvPath,
    data: matrixCsv(output),
  });
  if (csvResult?.error) throw new Error(csvResult.error);
  const sidecar = await saveSidecar(csvPath);
  await Promise.all([
    loadCachedRows(true).catch(() => {}),
    loadSidecar().catch(() => null),
  ]);
  markClean();
  try {
    window.parent?.postMessage({
      type: "arcrho:project-instance-refresh-datasets",
      inst,
      savedDatasetName: details.name,
      variant,
    }, "*");
  } catch {}
  postStatus(`${contract.methodType} saved: ${details.name}`);
  await showMethodSaveReviewWarning(sidecar, {
    instanceId: inst,
    projectName: state.project,
    reservingClass: state.reservingClass,
  });
  return { ok: true, path: jsonResult.path, csvPath };
}

function requestConfirmedClose() {
  clearOutputDependencyPreview("close");
  requestTabbedPageWindowClose({
    messageType: "arcrho:dataset-close-confirmed",
    inst,
  });
}

async function closeOrConfirm() {
  if (isDirty) {
    const discard = await closeConfirm.confirm({ reason: "close" });
    if (!discard) return;
  }
  requestConfirmedClose();
}

function initTabbedPage() {
  const initialTab = text(params.get("tab") || params.get("initial_tab"));
  tabbedPage = createTabbedPage(document.getElementById("bsTabbedPage"), {
    tabs: TABS,
    cssPrefix: "bs",
    initialTab: ALLOWED_TABS.has(initialTab) ? initialTab : "details",
    onTabChange: (tabId) => {
      if (tabId === "audit") void loadSidecar();
      try {
        window.parent?.postMessage({
          type: "arcrho:berquist-sherman-tab-changed",
          inst,
          tab: tabId,
          variant,
        }, "*");
      } catch {}
    },
  });
  applyTabbedPageSaveBar(document.getElementById("bsSaveBar"));
}

function wireMethodGridControls() {
  els.methodBody?.addEventListener("click", handleAdjustmentGridEvent);
  els.methodBody?.addEventListener("keydown", handleAdjustmentGridEvent);
  els.methodBody?.addEventListener("click", handleProportionGridEvent);
  els.methodBody?.addEventListener("keydown", handleProportionGridEvent);
  els.methodBody?.addEventListener("change", handleProportionGridEvent);
  els.methodBody?.addEventListener("contextmenu", handleProportionGridEvent);
  els.loessSpanInput?.addEventListener("change", () => applyLoessSpan(els.loessSpanInput.value));
  els.loessSpanInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") applyLoessSpan(els.loessSpanInput.value);
  });
  els.loessSpanUp?.addEventListener("click", () => applyLoessSpan(state.loessSpan + 1));
  els.loessSpanDown?.addEventListener("click", () => applyLoessSpan(state.loessSpan - 1));
}

function wireTableScrollbarActivity() {
  const host = document.querySelector(".bsTableWrap");
  if (!host) return;
  let idleTimer = null;
  const syncScrollbarHover = (event) => {
    const rect = host.getBoundingClientRect();
    const verticalScrollbarWidth = Math.max(0, host.offsetWidth - host.clientWidth);
    const horizontalScrollbarHeight = Math.max(0, host.offsetHeight - host.clientHeight);
    const nearVerticalScrollbar = host.scrollHeight > host.clientHeight
      && verticalScrollbarWidth > 0
      && event.clientX >= rect.right - Math.max(verticalScrollbarWidth, 16);
    const nearHorizontalScrollbar = host.scrollWidth > host.clientWidth
      && horizontalScrollbarHeight > 0
      && event.clientY >= rect.bottom - Math.max(horizontalScrollbarHeight, 16);
    host.classList.toggle("isScrollbarHover", nearVerticalScrollbar || nearHorizontalScrollbar);
  };
  host.addEventListener("scroll", () => {
    host.classList.add("isScrolling");
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => host.classList.remove("isScrolling"), 550);
  }, { passive: true });
  host.addEventListener("pointermove", syncScrollbarHover, { passive: true });
  host.addEventListener("pointerleave", () => host.classList.remove("isScrollbarHover"), { passive: true });
}

function wireInputs() {
  for (const input of [els.nameInput, els.outputTypeInput]) {
    input?.addEventListener("input", () => {
      syncTitle();
      markDirty();
    });
  }
  wireMethodGridControls();
  wireTableScrollbarActivity();
  els.outputTypeBtn?.addEventListener("click", () => void openPicker("output", els.outputTypeBtn));
  for (const button of document.querySelectorAll("button[data-picker-role]")) {
    button.addEventListener("click", () => void openPicker(button.dataset.pickerRole, button));
  }
  els.saveBtn?.addEventListener("click", async () => {
    try {
      await saveMethod();
    } catch (error) {
      console.error(error);
      postStatus(`Save failed: ${text(error?.message || error)}`, "error");
    }
  });
  els.cancelBtn?.addEventListener("click", () => void closeOrConfirm());
  window.__arcrho_request_close = () => {
    if (!isDirty) return false;
    if (closeConfirm.isOpen) return true;
    void closeOrConfirm();
    return true;
  };
  window.__arcrho_consume_close_shortcut = window.__arcrho_request_close;
}

function wireMessages() {
  window.addEventListener("pagehide", () => clearOutputDependencyPreview("close"));
  window.addEventListener("message", async (event) => {
    const message = event?.data && typeof event.data === "object" ? event.data : {};
    if (message.type === "arcrho:dataset-save") {
      try {
        await saveMethod();
      } catch (error) {
        postStatus(`Save failed: ${text(error?.message || error)}`, "error");
      }
      return;
    }
    if (message.type === "arcrho:dependency-source-preview") {
      try {
        applyDependencySourcePreview(message);
      } catch (error) {
        setMethodMessage(text(error?.message || error), "error");
        postStatus(`Source preview rejected: ${text(error?.message || error)}`, "error");
      }
      return;
    }
    if (message.type === "arcrho:dependency-source-cleared") {
      try {
        await clearDependencySourcePreview(message);
      } catch (error) {
        postStatus(`Source preview reload failed: ${text(error?.message || error)}`, "error");
      }
      return;
    }
    if (message.type === "arcrho:close-active-tab" || message.type === "arcrho:dataset-close-request") {
      await closeOrConfirm();
    }
  });
}

async function init() {
  syncDetailsLabelWidth({
    root: "#bsDetailsPage",
    labelSelector: ".arDetailsLabel",
  });
  withProgrammatic(() => {
    els.projectInput.value = state.project;
    els.classInput.value = state.reservingClass;
    els.nameInput.value = text(params.get("name") || params.get("dataset"));
    els.methodTypeInput.value = contract.methodType;
    els.outputTypeInput.value = text(
      params.get("output_type") || params.get("dataset_type") || params.get("datasetType"),
    );
    els.originLengthInput.value = String(ANNUAL_PERIOD_LENGTH);
    els.developmentLengthInput.value = String(ANNUAL_PERIOD_LENGTH);
  });
  els.srInputs.hidden = variant !== "sr";
  els.craInputs.hidden = variant !== "cra";
  const initialTriangle = text(params.get("input_triangle"));
  if (initialTriangle) state.sourceNames.paid_claims = initialTriangle;
  syncSourceInputs();
  syncTitle();
  initTabbedPage();
  renderViewButtons();
  renderSelectionSummary();
  wireInputs();
  wireMessages();

  try {
    await loadCachedRows();
  } catch (error) {
    postStatus(`Dataset cache unavailable: ${text(error?.message || error)}`, "warn");
  }
  await loadSidecar().catch(() => null);
  const loaded = await tryLoadExistingMethod().catch((error) => {
    postStatus(`Could not load existing ${contract.methodType}: ${text(error?.message || error)}`, "warn");
    return false;
  });
  try {
    await refreshSourceRoles();
  } catch (error) {
    setMethodMessage(text(error?.message || error), "error");
  }
  if (loaded) markClean();
  else {
    cleanSnapshot = "";
    markDirty();
  }
}

void init();

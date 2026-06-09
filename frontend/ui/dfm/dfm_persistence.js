/*
===============================================================================
DFM Persistence - load/save ratio selections to disk via host API
===============================================================================
*/
import {
  state,
  ratioStrikeSet,
  selectedSummaryByCol,
  summaryRowConfigs,
  BASE_SUMMARY_ROWS,
  RATIO_SAVE_PATH_KEY,
  getHostApi,
  buildRatioSavePath,
  buildInputTriangleCsvPath,
  getRatioSaveBaseDir,
  getRatioDataDir,
  getRatioSaveSuggestedName,
  getResultsCsvSuggestedName,
  buildSummaryRows,
  markDfmClean,
  isRatiosTabVisible,
  isResultsTabVisible,
  getDfmIsDirty,
  sanitizeFileNamePart,
  getRatioSaveProjectName,
  getResolvedProjectName,
  getResolvedReservingClass,
  getDfmDecimalPlaces,
  getEffectiveDevLabelsForModel,
  getRatioHeaderLabels,
  calcRatio,
  roundRatio,
  computeAverageForColumn,
  buildExcludedSetForColumn,
  setDfmDirtyEvaluator,
} from "/ui/dfm/dfm_state.js";
import {
  getSummaryConfigKey,
  saveCustomSummaryRows,
  loadCustomSummaryRows,
  markMethodSaved,
  clearMethodSavedFlag,
} from "/ui/dfm/dfm_storage.js";
import {
  buildRatioSelectionPattern,
  applyRatioSelectionPattern,
  buildAverageSelectionPayload,
  applyAverageSelectionFromSaved,
  renderRatioTable,
  queueDfmExternalChangeHighlights,
} from "/ui/dfm/dfm_ratios_tab.js";
import {
  renderResultsTable,
  buildResultsVector,
  buildResultsVectorCsv,
  getResultsRatioBasisSelection,
  getResultsUltimateRatioDecimalPlacesSelection,
  setResultsRatioBasisSelection,
  setResultsUltimateRatioDecimalPlacesSelection,
} from "/ui/dfm/dfm_results_tab.js";
import { getDfmNotesText, setDfmNotesText } from "/ui/dfm/dfm_notes_tab.js";
import {
  buildDfmAverageFormulaObject,
  buildDfmSummaryRowsFromAverageFormulaObject,
  buildDfmSummaryRowsFromAverageFormulas,
  getDfmAverageFormulaLabels,
  getDfmAverageFormulaSelectedIndex,
  getDfmAverageFormulaValues,
} from "/ui/dfm/dfm_average_formula_rows.js?v=20260513b";
import {
  applyDfmCellNotesPayload,
  buildDfmCellNotesPayload,
} from "/ui/dfm/dfm_cell_notes.js";
import {
  recordCurrentDfmObjectSnapshot,
  refreshDfmMethodIndex,
} from "/ui/dfm/dfm_startup_state.js";

let ratioLoadTimer = null;
let ratioLoadPendingReason = "";
let ratioFileWatchTimer = null;
let ratioFileWatchInFlight = false;
let ratioFileWatchPath = "";
let ratioFileWatchRevisionToken = "";
let ratioFileWatchDirtyWarnToken = "";
let lastCleanDfmMethodPayload = null;
const DFM_INSTANCE_PRESENCE_EVENT = "arcrho:dfm-instance-presence";
const DFM_LOCAL_LOOKUP_DEBUG_STATUS = true; // Temporary debug aid.
const DFM_ANALYSIS_DECIMALS = 4;
const DFM_METHOD_JSON_FORMAT = "arcrho-dfm-method-by-tab-v1";
const DFM_METHOD_FILE_WATCH_INTERVAL_MS = 2000;
let lastCleanDfmDirtySnapshot = "";

function splitLengthScopedDatasetName(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(.*)@(\d+)@(\d+)$/);
  return match ? match[1] : text;
}

function getCanonicalDatasetSidecarPath(csvPath) {
  const path = String(csvPath || "");
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const folder = slash >= 0 ? path.slice(0, slash) : "";
  const filename = slash >= 0 ? path.slice(slash + 1) : path;
  const match = filename.match(/^(.*?)(?:@\d+@\d+)?(?:@(?:cum|inc)@(?:dev|cal))?\.csv$/i);
  const sidecarName = match ? `${match[1]}.json` : filename.replace(/\.csv$/i, ".json");
  const folderNorm = folder.replace(/\\/g, "/");
  const parentSlash = folderNorm.lastIndexOf("/");
  const folderName = parentSlash >= 0 ? folderNorm.slice(parentSlash + 1) : folderNorm;
  const parentFolder = parentSlash >= 0 ? folder.slice(0, parentSlash) : "";
  const sidecarFolder = folderName.toLowerCase() === "datasets"
    ? (parentFolder ? `${parentFolder}/sidecars` : "sidecars")
    : `${folder}/sidecars`;
  return folder ? `${sidecarFolder}/${sidecarName}` : `sidecars/${sidecarName}`;
}

function buildDatasetSidecarJson(csvPath, datasetName, userName = "") {
  const name = splitLengthScopedDatasetName(datasetName);
  const outputType = String(document.getElementById("dfmOutputVector")?.value || "").trim();
  const user = String(userName || "").trim();
  return JSON.stringify({
    dataset_name: name,
    dataset_type: outputType || name,
    instance_name: name,
    reserving_class: getResolvedReservingClass(),
    project_name: getRatioSaveProjectName(),
    source_kind: "dfm",
    source: "dfm",
    csv_file: String(csvPath || "").split(/[\\/]/).pop() || "",
    user,
    modified_by: user,
    updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  }, null, 2) + "\n";
}

async function saveDatasetSidecar(hostApi, csvPath, datasetName) {
  if (!hostApi || typeof hostApi.saveTextFile !== "function" || !csvPath) return { ok: true };
  const jsonPath = getCanonicalDatasetSidecarPath(csvPath);
  let userName = "";
  if (typeof hostApi.getWindowsUserName === "function") {
    try {
      userName = String(await hostApi.getWindowsUserName() || "").trim();
    } catch {
      userName = "";
    }
  }
  const out = await hostApi.saveTextFile({
    path: jsonPath,
    data: buildDatasetSidecarJson(csvPath, datasetName, userName),
  });
  if (!out || out.error) {
    return { ok: false, error: out?.error ? String(out.error) : "unknown error" };
  }
  return { ok: true };
}

function getRatioLoadReasonPriority(reason) {
  const key = String(reason || "").trim().toLowerCase();
  switch (key) {
    case "details-change":
      return 50;
    case "global-changed":
    case "dataset-updated":
      return 40;
    case "init":
      return 30;
    case "tab-activated":
      return 10;
    default:
      return 20;
  }
}

function chooseRatioLoadReason(prevReason, nextReason) {
  const prev = String(prevReason || "").trim();
  const next = String(nextReason || "").trim();
  if (!prev) return next;
  if (!next) return prev;
  return getRatioLoadReasonPriority(next) >= getRatioLoadReasonPriority(prev) ? next : prev;
}

function emitDfmInstancePresence(status) {
  try {
    window.dispatchEvent(new CustomEvent(DFM_INSTANCE_PRESENCE_EVENT, { detail: { status } }));
  } catch {
    // ignore
  }
}

function getTrimmedInputValue(id) {
  return String(document.getElementById(id)?.value || "").trim();
}

function postDfmStatus(text, options = {}) {
  window.parent.postMessage(
    {
      type: "arcrho:status",
      text: String(text || ""),
      ...(options?.tone ? { tone: options.tone } : {}),
    },
    "*",
  );
}

function postDfmLookupDebugStatus(text, options = {}) {
  if (!DFM_LOCAL_LOOKUP_DEBUG_STATUS) return;
  const reason = String(options?.reason || "").trim();
  const suffix = reason ? ` [${reason}]` : "";
  postDfmStatus(`Debug: DFM local method lookup ${text}${suffix}`);
}

function getRevisionToken(revision) {
  if (!revision || typeof revision !== "object") return "";
  const path = String(revision.path || "");
  const size = Number.isFinite(Number(revision.size)) ? String(Number(revision.size)) : "";
  const mtimeMs = Number.isFinite(Number(revision.mtimeMs)) ? String(Number(revision.mtimeMs)) : "";
  const hash = String(revision.hash || "");
  return `${path}|${size}|${mtimeMs}|${hash}`;
}

function rememberDfmMethodFileRevision(path, revision) {
  ratioFileWatchPath = String(path || revision?.path || "");
  ratioFileWatchRevisionToken = getRevisionToken(revision);
  ratioFileWatchDirtyWarnToken = "";
}

function clearDfmMethodFileRevision(path = "") {
  ratioFileWatchPath = String(path || "");
  ratioFileWatchRevisionToken = "";
  ratioFileWatchDirtyWarnToken = "";
}

async function readDfmMethodFileRevision(hostApi, path) {
  if (typeof hostApi?.getFileRevision === "function") {
    return hostApi.getFileRevision({ path });
  }
  if (typeof hostApi?.readJsonFile === "function") {
    return hostApi.readJsonFile({ path });
  }
  return { exists: false };
}

async function refreshDfmMethodFileRevision(path) {
  const hostApi = getHostApi();
  if (!hostApi) return;
  try {
    const result = await readDfmMethodFileRevision(hostApi, path);
    if (result?.exists) {
      rememberDfmMethodFileRevision(path, result.revision);
    } else {
      clearDfmMethodFileRevision(path);
    }
  } catch {
    clearDfmMethodFileRevision(path);
  }
}

function hasRequiredDfmInputs() {
  const project = getResolvedProjectName();
  const reservingClass = getResolvedReservingClass();
  const tri = getTrimmedInputValue("triInput");
  const outputVector = getTrimmedInputValue("dfmOutputVector");
  const methodName = getTrimmedInputValue("dfmMethodName");
  const originLen = getTrimmedInputValue("originLenSelect");
  const devLen = getTrimmedInputValue("devLenSelect");
  return !!(project && reservingClass && tri && outputVector && methodName && originLen && devLen);
}

function hasRequiredDfmLookupInputs() {
  const project = getResolvedProjectName();
  const reservingClass = getResolvedReservingClass();
  const methodName = getTrimmedInputValue("dfmMethodName");
  return !!(project && reservingClass && methodName);
}

function getDfmJsonTab(payload, tabKey) {
  const tab = payload && typeof payload === "object" && !Array.isArray(payload) ? payload[tabKey] : null;
  return tab && typeof tab === "object" && !Array.isArray(tab) ? tab : {};
}

function getDfmDetailsTab(payload) {
  return getDfmJsonTab(payload, "details tab");
}

function getDfmRatiosTab(payload) {
  return getDfmJsonTab(payload, "ratios tab");
}

function getDfmRatioTriangleTab(payload) {
  return getDfmJsonTab(getDfmRatiosTab(payload), "ratio triangle");
}

function getDfmResultsTab(payload) {
  return getDfmJsonTab(payload, "results tab");
}

function getDfmNotesTab(payload) {
  return getDfmJsonTab(payload, "notes tab");
}

function getSavedInputTriangleValue(payload) {
  const details = getDfmDetailsTab(payload);
  if ("input triangle" in details) return String(details["input triangle"] ?? "");
  return null;
}

function normalizeSavedLengthValue(value) {
  const raw = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? String(raw) : "";
}

function readSelectedLengthNumber(id, fallback = 12) {
  const raw = Number.parseInt(getTrimmedInputValue(id), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function getSavedOriginLengthValue(payload) {
  const details = getDfmDetailsTab(payload);
  if ("origin length" in details) return normalizeSavedLengthValue(details["origin length"]);
  return null;
}

function getSavedDevelopmentLengthValue(payload) {
  const details = getDfmDetailsTab(payload);
  if ("development length" in details) return normalizeSavedLengthValue(details["development length"]);
  return null;
}

function applySavedSelectValueToUi(id, rawValue) {
  if (rawValue == null) return false;
  const select = document.getElementById(id);
  if (!select) return false;
  const next = String(rawValue ?? "").trim();
  if (!next) return false;
  if (![...select.options].some((opt) => String(opt.value) === next)) {
    const opt = document.createElement("option");
    opt.value = next;
    opt.textContent = next;
    select.appendChild(opt);
  }
  if (String(select.value ?? "") === next) return false;
  select.value = next;
  return true;
}

function getSavedMethodNameValue(payload) {
  const details = getDfmDetailsTab(payload);
  if ("name" in details) return String(details["name"] ?? "");
  return null;
}

function applySavedMethodNameToUi(rawValue) {
  if (rawValue == null) return;
  const input = document.getElementById("dfmMethodName");
  if (!input) return;
  const next = String(rawValue ?? "").trim();
  const prev = String(input.value || "").trim();
  if (next === prev) return;
  input.dataset.programmatic = "1";
  input.value = next;
  // `wireMethodName()` handles title/localStorage sync on input without triggering
  // another local-method lookup.
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function getSavedOutputTypeValue(payload) {
  const details = getDfmDetailsTab(payload);
  if ("output type" in details) return String(details["output type"] ?? "");
  return null;
}

function applySavedOutputTypeToUi(rawValue) {
  if (rawValue == null) return;
  const input = document.getElementById("dfmOutputVector");
  if (!input) return;
  const next = String(rawValue ?? "").trim();
  const prev = String(input.value || "").trim();
  if (next === prev) return;
  input.value = next;
  // Keep the picker module's committed value in sync without opening/revalidating
  // the dropdown during programmatic load.
  input.dispatchEvent(new CustomEvent("arcrho:output-type-selected", { detail: { value: next } }));
}

function applySavedInputTriangleToUi(rawValue) {
  if (rawValue == null) return false;
  const triInput = document.getElementById("triInput");
  if (!triInput) return false;
  const next = String(rawValue ?? "").trim();
  const prev = String(triInput.value || "").trim();
  if (next === prev) return false;
  triInput.value = next;
  return true;
}

function getSavedDecimalPlacesValue(payload) {
  const details = getDfmDetailsTab(payload);
  if ("decimal places" in details) return details["decimal places"];
  return null;
}

function applySavedDecimalPlacesToUi(rawValue) {
  if (rawValue == null) return;
  const input = document.getElementById("decimalPlaces");
  if (!input) return;
  const parsed = Number.parseInt(String(rawValue).trim(), 10);
  if (!Number.isFinite(parsed)) return;
  const normalized = String(Math.max(0, Math.min(6, parsed)));
  if (String(input.value ?? "") === normalized) return;
  input.dataset.programmatic = "1";
  input.value = normalized;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function getSavedUltimateRatioDecimalPlacesValue(payload) {
  const results = getDfmResultsTab(payload);
  if ("ultimate ratio decimal places" in results) return results["ultimate ratio decimal places"];
  return null;
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
  const s = String(label || "").trim();
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
    const yq = s.match(/^(\d{4})\s*Q([1-4])$/i);
    if (yq) {
      const year = Number.parseInt(yq[1], 10);
      const q = Number.parseInt(yq[2], 10);
      return { year, month: (q - 1) * 3 + 1 };
    }
    const qy = s.match(/^Q([1-4])\s*(\d{4})$/i);
    if (qy) {
      const q = Number.parseInt(qy[1], 10);
      const year = Number.parseInt(qy[2], 10);
      return { year, month: (q - 1) * 3 + 1 };
    }
    return null;
  }

  if (baseLen === 6) {
    const yh = s.match(/^(\d{4})\s*H([1-2])$/i);
    if (yh) {
      const year = Number.parseInt(yh[1], 10);
      const h = Number.parseInt(yh[2], 10);
      return { year, month: (h - 1) * 6 + 1 };
    }
    const hy = s.match(/^H([1-2])\s*(\d{4})$/i);
    if (hy) {
      const h = Number.parseInt(hy[1], 10);
      const year = Number.parseInt(hy[2], 10);
      return { year, month: (h - 1) * 6 + 1 };
    }
    return null;
  }

  if (baseLen === 12) {
    const yearOnly = s.match(/^(\d{4})$/);
    if (yearOnly) {
      const year = Number.parseInt(yearOnly[1], 10);
      if (Number.isFinite(year)) return { year, month: 1 };
    }
    return null;
  }

  return null;
}

function aggregateResultsVectorByLength(vector, originLabels, baseLen, targetLen) {
  if (!Array.isArray(vector) || !vector.length) return [];
  const factor = targetLen / baseLen;
  if (!Number.isFinite(factor) || factor <= 1 || Math.floor(factor) !== factor) return [];

  const labels = Array.isArray(originLabels) ? originLabels : [];
  const canUseLabelBuckets = labels.length === vector.length && (baseLen === 1 || baseLen === 3 || baseLen === 6 || baseLen === 12);
  if (canUseLabelBuckets) {
    const orderedKeys = [];
    const bucketMap = new Map();
    let parseFailed = false;
    for (let i = 0; i < vector.length; i++) {
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
      const num = Number(vector[i]);
      if (Number.isFinite(num)) {
        bucket.sum += num;
        bucket.hasValue = true;
      }
    }
    if (!parseFailed) {
      return orderedKeys.map((key) => {
        const bucket = bucketMap.get(key);
        return bucket?.hasValue ? bucket.sum : null;
      });
    }
  }

  const out = [];
  for (let i = 0; i < vector.length; i += factor) {
    let sum = 0;
    let hasValue = false;
    const end = Math.min(i + factor, vector.length);
    for (let j = i; j < end; j++) {
      const num = Number(vector[j]);
      if (!Number.isFinite(num)) continue;
      sum += num;
      hasValue = true;
    }
    out.push(hasValue ? sum : null);
  }
  return out;
}

function buildAggregatedResultVariants(resultVector) {
  const baseOriginRaw = Number.parseInt(String(document.getElementById("originLenSelect")?.value || "").trim(), 10);
  const baseLen = Number.isFinite(baseOriginRaw) ? baseOriginRaw : 12;
  const targetLens = [3, 6, 12].filter((len) => len > baseLen && len % baseLen === 0);
  if (!targetLens.length) return [];

  const originLabels = Array.isArray(state?.model?.origin_labels) ? state.model.origin_labels : [];
  const out = [];
  for (const targetLen of targetLens) {
    const vec = aggregateResultsVectorByLength(resultVector, originLabels, baseLen, targetLen);
    if (!vec.length) continue;
    out.push({
      originLen: targetLen,
      devLen: targetLen,
      vector: vec,
    });
  }
  return out;
}

function getSummaryRowsForPersistence(cfgKey) {
  const savedSummaryRows = cfgKey ? loadCustomSummaryRows(cfgKey) : [];
  const sourceRows = savedSummaryRows.length
    ? savedSummaryRows
    : (summaryRowConfigs.length ? summaryRowConfigs : BASE_SUMMARY_ROWS);
  return sourceRows.map((row) => {
    const { id: _id, ...rowWithoutId } = row || {};
    if (!isUserEntrySummaryRow(rowWithoutId)) return { ...rowWithoutId };
    const {
      values: _values,
      inputs: _inputs,
      formulas: _legacyFormulas,
      ...baseRow
    } = rowWithoutId;
    const rowInputs = Array.isArray(_inputs)
      ? _inputs
      : Array.isArray(_legacyFormulas)
        ? _legacyFormulas
        : null;
    const nextRow = { ...baseRow };
    if (Array.isArray(rowInputs) && rowInputs.some((value) => String(value ?? "").trim())) {
      nextRow.inputs = rowInputs.map((value) => String(value ?? "").trim());
    }
    return nextRow;
  });
}

function buildRatioDisplayHeaderLabels(devs) {
  const ratioLabels = getRatioHeaderLabels(devs);
  return ratioLabels.map((label, index) => {
    const text = String(label ?? "");
    if (index === ratioLabels.length - 1) return text || "Ult";
    return text ? `(${index + 1}) ${text}` : `(${index + 1})`;
  });
}

function roundAnalysisValue(value) {
  return Number.isFinite(Number(value)) ? roundRatio(Number(value), DFM_ANALYSIS_DECIMALS) : null;
}

function trimTrailingNulls(row) {
  const out = Array.isArray(row) ? row.slice() : [];
  while (out.length && out[out.length - 1] === null) {
    out.pop();
  }
  return out;
}

function normalizeSummaryUserEntryValue(raw) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function isUserEntrySummaryRow(cfg) {
  return String(cfg?.averageType || "").trim().toLowerCase() === "user_entry";
}

function buildCalculatedRatioTriangleValues() {
  const model = state.model;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) return [];
  const values = model.values;
  const mask = model.mask;
  const rowCount = Array.isArray(model.origin_labels) ? model.origin_labels.length : values.length;
  const devs = getEffectiveDevLabelsForModel(model);
  const ratioLabels = getRatioHeaderLabels(devs);
  const out = [];
  for (let r = 0; r < rowCount; r++) {
    const row = [];
    for (let c = 0; c < ratioLabels.length; c++) {
      if (c >= devs.length - 1 || !mask?.[r]?.[c] || !mask?.[r]?.[c + 1]) {
        row.push(null);
        continue;
      }
      row.push(roundAnalysisValue(calcRatio(values?.[r]?.[c], values?.[r]?.[c + 1])));
    }
    out.push(trimTrailingNulls(row));
  }
  return out;
}

function trimMatrixToReferenceRowShape(matrix, reference) {
  if (!Array.isArray(matrix)) return [];
  return matrix.map((row, rowIndex) => {
    const out = Array.isArray(row) ? row.slice() : [];
    const referenceRow = Array.isArray(reference?.[rowIndex]) ? reference[rowIndex] : null;
    return referenceRow ? out.slice(0, referenceRow.length) : out;
  });
}

function getSummaryRowsForValues() {
  return Array.isArray(summaryRowConfigs) && summaryRowConfigs.length
    ? summaryRowConfigs
    : buildSummaryRows();
}

function buildAverageFormulaValues() {
  const model = state.model;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) return [];
  const rows = getSummaryRowsForValues();
  const devs = getEffectiveDevLabelsForModel(model);
  const ratioLabels = getRatioHeaderLabels(devs);
  const values = rows.map(() => new Array(ratioLabels.length).fill(null));
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const cfg = rows[rowIndex];
    for (let c = 0; c < ratioLabels.length; c++) {
      if (c >= devs.length - 1) {
        values[rowIndex][c] = roundAnalysisValue(1);
        continue;
      }
      if (isUserEntrySummaryRow(cfg)) {
        const raw = Array.isArray(cfg.values) ? cfg.values[c] : 1;
        values[rowIndex][c] = roundAnalysisValue(normalizeSummaryUserEntryValue(raw));
        continue;
      }
      const excluded = buildExcludedSetForColumn(model, c, cfg, ratioStrikeSet);
      const summary = computeAverageForColumn(model, c, excluded, cfg);
      if (summary.totalValid > 0 && summary.totalIncluded === 0) {
        values[rowIndex][c] = roundAnalysisValue(1);
        continue;
      }
      const isVolume = String(cfg.base || "volume").toLowerCase() === "volume";
      const hasValue =
        summary.value !== null &&
        (isVolume ? summary.sumA : summary.totalIncluded > 0);
      values[rowIndex][c] = roundAnalysisValue(hasValue ? summary.value : 1);
    }
  }
  return values.map((row) => trimTrailingNulls(row));
}

function hydrateUserEntryValuesFromAverageFormulaValues(summaryRows, formulas, averageFormulaValues) {
  if (!Array.isArray(summaryRows) || !Array.isArray(formulas) || !Array.isArray(averageFormulaValues)) {
    return summaryRows;
  }
  const formulaIndexByLabel = new Map();
  formulas.forEach((formula, index) => {
    const key = String(formula || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (key && !formulaIndexByLabel.has(key)) formulaIndexByLabel.set(key, index);
  });
  return summaryRows.map((row) => {
    if (!isUserEntrySummaryRow(row) || Array.isArray(row?.values)) return row;
    const labelKey = String(row?.label || row?.id || "").replace(/\s+/g, " ").trim().toLowerCase();
    const rowIndex = formulaIndexByLabel.get(labelKey);
    const valueRow = Number.isInteger(rowIndex) ? averageFormulaValues[rowIndex] : null;
    if (!Array.isArray(valueRow)) return row;
    return {
      ...row,
      values: valueRow.map((value) => normalizeSummaryUserEntryValue(value)),
    };
  });
}

export async function buildDfmMethodPayloadWithPaths(options = {}) {
  let inputTriangleCsvPath = String(options?.inputTriangleCsvPath || "").trim();
  if (!inputTriangleCsvPath) {
    try {
      inputTriangleCsvPath = await buildInputTriangleCsvPath();
    } catch {
      inputTriangleCsvPath = "";
    }
  }
  let ultimateVectorCsvPath = String(options?.ultimateVectorCsvPath || "").trim();
  if (!ultimateVectorCsvPath) {
    try {
      const dataDir = await getRatioDataDir();
      ultimateVectorCsvPath = `${dataDir}\\${getResultsCsvSuggestedName()}`;
    } catch {
      ultimateVectorCsvPath = "";
    }
  }
  return buildDfmMethodPayload({
    ...options,
    inputTriangleCsvPath,
    ultimateVectorCsvPath,
  });
}

function copyExistingFields(source, keys) {
  const out = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      out[key] = source[key];
    }
  }
  return out;
}

function copyExistingField(source, sourceKey, target, targetKey = sourceKey) {
  if (Object.prototype.hasOwnProperty.call(source, sourceKey)) {
    target[targetKey] = source[sourceKey];
  }
}

function buildDfmGroupedMethodPayload(methodPayload) {
  const data = methodPayload && typeof methodPayload === "object" ? methodPayload : {};
  const dataTab = {};
  copyExistingField(data, "origin labels", dataTab);
  copyExistingField(data, "data development labels", dataTab, "development labels");
  copyExistingField(data, "input data triangle csv path", dataTab);
  const ratiosTab = {};
  const ratioTriangle = {};
  copyExistingField(data, "origin labels", ratioTriangle);
  copyExistingField(data, "ratio development labels", ratioTriangle, "development labels");
  copyExistingField(data, "ratio values", ratioTriangle);
  copyExistingField(data, "excluded", ratioTriangle);
  ratiosTab["ratio triangle"] = ratioTriangle;
  copyExistingField(data, "average formulas", ratiosTab);
  copyExistingField(data, "cell notes", ratiosTab);
  const grouped = {
    "json format": DFM_METHOD_JSON_FORMAT,
    "details tab": copyExistingFields(data, [
      "name",
      "output type",
      "input triangle",
      "origin length",
      "development length",
      "decimal places",
    ]),
    "data tab": dataTab,
    "ratios tab": ratiosTab,
    "results tab": copyExistingFields(data, [
      "ratio basis dataset",
      "ultimate ratio decimal places",
      "ultimate vector csv path",
    ]),
    "notes tab": copyExistingFields(data, [
      "notes",
    ]),
    "method metadata": copyExistingFields(data, [
      "last modified",
    ]),
  };
  return grouped;
}

function canonicalizeForDirtySnapshot(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalizeForDirtySnapshot(item));
  if (!value || typeof value !== "object") return value;
  const out = {};
  Object.keys(value)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .forEach((key) => {
      const item = canonicalizeForDirtySnapshot(value[key]);
      if (typeof item !== "undefined") out[key] = item;
    });
  return out;
}

function buildDfmDirtySnapshot(payload) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : buildDfmMethodPayload();
  const detailsTab = getDfmDetailsTab(source);
  const ratiosTab = getDfmRatiosTab(source);
  const ratioTriangle = getDfmRatioTriangleTab(source);
  const resultsTab = getDfmResultsTab(source);
  const notesTab = getDfmNotesTab(source);
  return {
    "details tab": copyExistingFields(detailsTab, [
      "name",
      "output type",
      "input triangle",
      "origin length",
      "development length",
      "decimal places",
    ]),
    "ratios tab": {
      "ratio triangle": copyExistingFields(ratioTriangle, [
        "excluded",
      ]),
      ...copyExistingFields(ratiosTab, [
        "average formulas",
        "cell notes",
      ]),
    },
    "results tab": copyExistingFields(resultsTab, [
      "ratio basis dataset",
      "ultimate ratio decimal places",
    ]),
    "notes tab": copyExistingFields(notesTab, [
      "notes",
    ]),
  };
}

function serializeDfmDirtySnapshot(payload) {
  return JSON.stringify(canonicalizeForDirtySnapshot(buildDfmDirtySnapshot(payload)));
}

function recordCleanDfmDirtySnapshot(payload = null) {
  const cleanPayload = payload || buildDfmMethodPayload();
  try {
    lastCleanDfmMethodPayload = JSON.parse(JSON.stringify(cleanPayload));
  } catch {
    lastCleanDfmMethodPayload = cleanPayload;
  }
  lastCleanDfmDirtySnapshot = serializeDfmDirtySnapshot(cleanPayload);
}

function isCurrentDfmDirtyComparedToCleanSnapshot() {
  if (!lastCleanDfmDirtySnapshot) return true;
  return serializeDfmDirtySnapshot(buildDfmMethodPayload()) !== lastCleanDfmDirtySnapshot;
}

setDfmDirtyEvaluator(isCurrentDfmDirtyComparedToCleanSnapshot);

export async function buildDfmAssistantContextPayload(options = {}) {
  return buildDfmMethodPayloadWithPaths(options);
}

async function refreshDfmDatasetAfterDetailsApply(options = {}) {
  if (options.refreshDataset === false) return;
  const refreshFn = window.ADA_DFM_REFRESH_DATASET;
  if (typeof refreshFn !== "function") return;
  try {
    await refreshFn({
      forceRefreshLabels: !!options.forceRefreshLabels,
      reason: options.reason || "dfm-method-payload",
    });
  } catch (err) {
    console.warn("Failed to refresh DFM dataset after applying Details fields:", err);
    postDfmStatus("DFM settings were applied, but the Data table refresh failed.", { tone: "warn" });
  }
}

export async function applyDfmMethodPayload(payload, options = {}) {
  let datasetInputsChanged = false;
  if (payload && !Array.isArray(payload)) {
    datasetInputsChanged = applySavedSelectValueToUi("originLenSelect", getSavedOriginLengthValue(payload)) || datasetInputsChanged;
    datasetInputsChanged = applySavedSelectValueToUi("devLenSelect", getSavedDevelopmentLengthValue(payload)) || datasetInputsChanged;
  }

  const ratiosTab = getDfmRatiosTab(payload);
  const ratioTriangle = getDfmRatioTriangleTab(payload);
  const resultsTab = getDfmResultsTab(payload);
  const notesTab = getDfmNotesTab(payload);
  const pattern = Array.isArray(payload) ? payload : ratioTriangle.excluded;
  let applied = applyRatioSelectionPattern(pattern);
  if (payload && !Array.isArray(payload)) {
    const cfgKey = getSummaryConfigKey();
    const averageFormulas = ratiosTab["average formulas"];
    const cellNotes = ratiosTab["cell notes"];
    const formulas = getDfmAverageFormulaLabels(averageFormulas);
    const matrix = getDfmAverageFormulaSelectedIndex(averageFormulas);
    const averageFormulaValues = getDfmAverageFormulaValues(averageFormulas);
    const averageFormulaRows = buildDfmSummaryRowsFromAverageFormulaObject(averageFormulas);
    const resolvedSummary = buildDfmSummaryRowsFromAverageFormulas(averageFormulaRows, formulas);
    const summaryRows = hydrateUserEntryValuesFromAverageFormulaValues(
      resolvedSummary.rows,
      formulas,
      averageFormulaValues,
    );
    let summaryUpdated = false;

    if (Array.isArray(summaryRows) && cfgKey) {
      saveCustomSummaryRows(cfgKey, summaryRows);
      summaryUpdated = true;
    }
    if (summaryUpdated) buildSummaryRows();
    applyDfmCellNotesPayload(cellNotes);

    const notesText = notesTab["notes"];
    const savedMethodName = getSavedMethodNameValue(payload);
    const savedOutputType = getSavedOutputTypeValue(payload);
    const savedInputTriangle = getSavedInputTriangleValue(payload);
    const savedDecimalPlaces = getSavedDecimalPlacesValue(payload);
    const savedUltimateRatioDecimalPlaces = getSavedUltimateRatioDecimalPlacesValue(payload);
    const ratioBasisDataset = resultsTab["ratio basis dataset"] ?? "";
    applySavedOutputTypeToUi(savedOutputType);
    datasetInputsChanged = applySavedInputTriangleToUi(savedInputTriangle) || datasetInputsChanged;
    // Apply saved Name after tri-input restore so custom Names win over
    // any default name derived from the selected Output Vector.
    applySavedMethodNameToUi(savedMethodName);
    applySavedDecimalPlacesToUi(savedDecimalPlaces);
    setResultsUltimateRatioDecimalPlacesSelection(savedUltimateRatioDecimalPlaces, { silent: true, render: false });
    setDfmNotesText(notesText);
    await setResultsRatioBasisSelection(ratioBasisDataset, { silent: true, render: false });
    if (Array.isArray(formulas) && Array.isArray(matrix)) {
      applyAverageSelectionFromSaved(formulas, matrix);
    }
  } else {
    applyDfmCellNotesPayload(null);
    setDfmNotesText("");
    await setResultsRatioBasisSelection("", { silent: true, render: false });
  }

  if (datasetInputsChanged) {
    await refreshDfmDatasetAfterDetailsApply({
      ...options,
      forceRefreshLabels: true,
    });
    if (!applied) {
      applied = applyRatioSelectionPattern(pattern);
    }
  }

  if (applied && options.render !== false) {
    renderRatioTable();
    renderResultsTable();
  }
  if (applied && options.markClean !== false) {
    recordCleanDfmDirtySnapshot();
    markMethodSaved();
    markDfmClean();
  }
  return { ok: applied, datasetInputsChanged };
}

export async function loadRatioSelectionIfExists(reason) {
  postDfmLookupDebugStatus("triggered", { reason });
  if (!hasRequiredDfmLookupInputs()) {
    postDfmLookupDebugStatus("skipped (waiting for required fields)", { reason });
    emitDfmInstancePresence("incomplete");
    return;
  }
  if (getDfmIsDirty() && reason === "tab-activated") {
    postDfmLookupDebugStatus("skipped (dirty + tab-activated)", { reason });
    return;
  }
  const hostApi = getHostApi();
  if (!hostApi || typeof hostApi.readJsonFile !== "function") {
    postDfmLookupDebugStatus("skipped (desktop host readJsonFile unavailable)", { reason });
    emitDfmInstancePresence("incomplete");
    return;
  }
  const standardPath = await buildRatioSavePath();
  let path = standardPath;
  postDfmLookupDebugStatus(`checking ${path}`, { reason });
  const result = await hostApi.readJsonFile({ path });
  if (!result || !result.exists) {
    clearDfmMethodFileRevision(path);
    emitDfmInstancePresence("missing");
    postDfmStatus("This method object has not been created yet, changes will be saved to a new container.", { tone: "warn" });
    if (getDfmIsDirty()) {
      return;
    }
    ratioStrikeSet.clear();
    selectedSummaryByCol.clear();
    applyDfmCellNotesPayload(null);
    setDfmNotesText("");
    await setResultsRatioBasisSelection("", { silent: true, render: false });
    clearMethodSavedFlag();
    renderRatioTable();
    renderResultsTable();
    recordCleanDfmDirtySnapshot();
    markDfmClean();
    return;
  }
  emitDfmInstancePresence("found");
  const applied = await applyDfmMethodPayload(result.data);
  if (applied.ok) {
    rememberDfmMethodFileRevision(path, result.revision);
    postDfmStatus("Ready");
  } else if (reason) {
    postDfmStatus("Error: Ratio file found but could not be applied.");
  }
}

export function scheduleRatioSelectionLoad(reason) {
  ratioLoadPendingReason = chooseRatioLoadReason(ratioLoadPendingReason, reason);
  if (ratioLoadTimer) clearTimeout(ratioLoadTimer);
  ratioLoadTimer = setTimeout(() => {
    const scheduledReason = ratioLoadPendingReason || reason;
    ratioLoadPendingReason = "";
    ratioLoadTimer = null;
    loadRatioSelectionIfExists(scheduledReason);
  }, 120);
}

export async function restoreCleanDfmMethodState() {
  if (lastCleanDfmMethodPayload) {
    return applyDfmMethodPayload(lastCleanDfmMethodPayload, { reason: "cancel", markClean: true });
  }
  const hostApi = getHostApi();
  if (!hostApi || typeof hostApi.readJsonFile !== "function") {
    return { ok: false, error: "desktop app required" };
  }
  try {
    const path = await buildRatioSavePath();
    const result = await hostApi.readJsonFile({ path });
    if (!result?.exists) {
      return { ok: false, error: "No saved DFM method is available to restore." };
    }
    const applied = await applyDfmMethodPayload(result.data, { reason: "cancel", markClean: true });
    if (applied?.ok) rememberDfmMethodFileRevision(path, result.revision);
    return applied;
  } catch (err) {
    return { ok: false, error: String(err?.message || err || "Could not restore DFM method.") };
  }
}

export function buildDfmMethodPayload(options = {}) {
  const devs = getEffectiveDevLabelsForModel(state?.model || {});
  const originLabels = Array.isArray(state?.model?.origin_labels)
    ? state.model.origin_labels.map((label) => String(label ?? ""))
    : [];
  const dataDevelopmentLabels = devs.map((label) => String(label ?? ""));
  const ratioDevelopmentLabels = buildRatioDisplayHeaderLabels(devs);
  const avgSelection = buildAverageSelectionPayload();
  const calculatedRatioTriangleValues = buildCalculatedRatioTriangleValues();
  const pattern = trimMatrixToReferenceRowShape(buildRatioSelectionPattern(), calculatedRatioTriangleValues);
  const averageFormulaValues = buildAverageFormulaValues();
  const cellNotes = buildDfmCellNotesPayload();
  const notesText = getDfmNotesText();
  const ratioBasisDataset = getResultsRatioBasisSelection();
  const outputVector = getTrimmedInputValue("dfmOutputVector");
  const methodName = getTrimmedInputValue("dfmMethodName");
  const inputTriangle = getTrimmedInputValue("triInput");
  const originLength = readSelectedLengthNumber("originLenSelect");
  const developmentLength = readSelectedLengthNumber("devLenSelect");
  const decimalPlaces = getDfmDecimalPlaces();
  const ultimateRatioDecimalPlaces = getResultsUltimateRatioDecimalPlacesSelection();
  const cfgKey = getSummaryConfigKey();
  const summaryRows = getSummaryRowsForPersistence(cfgKey);
  const data = {
    excluded: pattern,
    "origin labels": originLabels,
    "data development labels": dataDevelopmentLabels,
    "ratio development labels": ratioDevelopmentLabels,
    "input data triangle csv path": String(options?.inputTriangleCsvPath || ""),
    "ratio values": calculatedRatioTriangleValues,
    "average formulas": buildDfmAverageFormulaObject(summaryRows, avgSelection.matrix, averageFormulaValues),
    "cell notes": cellNotes,
    "ultimate vector csv path": String(options?.ultimateVectorCsvPath || ""),
    notes: notesText,
    name: methodName,
    "output type": outputVector,
    "input triangle": inputTriangle,
    "origin length": originLength,
    "development length": developmentLength,
    "decimal places": decimalPlaces,
    "ultimate ratio decimal places": ultimateRatioDecimalPlaces,
    "ratio basis dataset": ratioBasisDataset,
    "last modified": new Date().toISOString(),
  };
  return buildDfmGroupedMethodPayload(data);
}

function normalizeRatioMatrixCellValue(matrix, row, col) {
  const sourceRow = Array.isArray(matrix?.[row]) ? matrix[row] : [];
  if (col >= sourceRow.length) return 2;
  const raw = sourceRow[col];
  if (raw === true) return 1;
  if (raw === false) return 0;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 2;
}

function matrixMaxColumnCount(...matrices) {
  let count = 0;
  matrices.forEach((matrix) => {
    if (!Array.isArray(matrix)) return;
    matrix.forEach((row) => {
      if (Array.isArray(row)) count = Math.max(count, row.length);
    });
  });
  return count;
}

function buildChangedRatioCells(prevPattern, nextPattern) {
  const rows = Math.max(
    Array.isArray(prevPattern) ? prevPattern.length : 0,
    Array.isArray(nextPattern) ? nextPattern.length : 0,
  );
  const cells = [];
  for (let r = 0; r < rows; r++) {
    const cols = matrixMaxColumnCount([prevPattern?.[r]], [nextPattern?.[r]]);
    for (let c = 0; c < cols; c++) {
      if (normalizeRatioMatrixCellValue(prevPattern, r, c) !== normalizeRatioMatrixCellValue(nextPattern, r, c)) {
        cells.push({ r, c });
      }
    }
  }
  return cells;
}

function buildAverageMatrixByLabel(formulas, matrix) {
  const out = new Map();
  const formulaList = Array.isArray(formulas) ? formulas : [];
  formulaList.forEach((formula, row) => {
    const label = String(formula || "").trim();
    if (!label) return;
    const sourceRow = Array.isArray(matrix?.[row]) ? matrix[row] : [];
    out.set(label, sourceRow.map((value) => (Number(value) === 1 ? 1 : 0)));
  });
  return out;
}

function buildChangedAverageCells(prevFormulas, prevMatrix, nextFormulas, nextMatrix) {
  const prevByLabel = buildAverageMatrixByLabel(prevFormulas, prevMatrix);
  const nextByLabel = buildAverageMatrixByLabel(nextFormulas, nextMatrix);
  const labels = new Set([...prevByLabel.keys(), ...nextByLabel.keys()]);
  const cells = [];
  labels.forEach((label) => {
    const prevRow = prevByLabel.get(label) || [];
    const nextRow = nextByLabel.get(label) || [];
    const cols = Math.max(prevRow.length, nextRow.length);
    for (let c = 0; c < cols; c++) {
      if (Number(prevRow[c] || 0) !== Number(nextRow[c] || 0)) cells.push({ label, c });
    }
  });
  return cells;
}

function buildDfmExternalChangedCells(nextPayload) {
  const prevPattern = buildRatioSelectionPattern();
  const nextPattern = getDfmRatioTriangleTab(nextPayload).excluded;
  const prevAverage = buildAverageSelectionPayload();
  const nextAverage = getDfmAverageFormulaSelectedIndex(getDfmRatiosTab(nextPayload)["average formulas"]);
  return {
    ratioCells: buildChangedRatioCells(prevPattern, nextPattern),
    averageCells: buildChangedAverageCells(
      prevAverage.formulas,
      prevAverage.matrix,
      getDfmAverageFormulaLabels(getDfmRatiosTab(nextPayload)["average formulas"]),
      nextAverage,
    ),
  };
}

async function checkDfmMethodFileWatch() {
  if (ratioFileWatchInFlight) return;
  if (!hasRequiredDfmLookupInputs()) {
    clearDfmMethodFileRevision();
    return;
  }
  const hostApi = getHostApi();
  if (!hostApi || typeof hostApi.readJsonFile !== "function") return;
  ratioFileWatchInFlight = true;
  try {
    const path = await buildRatioSavePath();
    if (path !== ratioFileWatchPath) {
      clearDfmMethodFileRevision(path);
    }
    const revisionResult = await readDfmMethodFileRevision(hostApi, path);
    if (!revisionResult?.exists) {
      if (ratioFileWatchRevisionToken) clearDfmMethodFileRevision(path);
      return;
    }
    const token = getRevisionToken(revisionResult.revision);
    if (!token) return;
    if (!ratioFileWatchRevisionToken) {
      rememberDfmMethodFileRevision(path, revisionResult.revision);
      return;
    }
    if (token === ratioFileWatchRevisionToken) return;

    if (getDfmIsDirty()) {
      if (ratioFileWatchDirtyWarnToken !== token) {
        ratioFileWatchDirtyWarnToken = token;
        postDfmStatus("DFM method JSON changed on disk. Save or reload before closing to avoid overwriting external changes.", { tone: "warn" });
      }
      return;
    }

    const result = await hostApi.readJsonFile({ path });
    if (!result?.exists) {
      clearDfmMethodFileRevision(path);
      return;
    }
    const changedCells = buildDfmExternalChangedCells(result.data);
    const applied = await applyDfmMethodPayload(result.data, { reason: "external-file-change" });
    if (applied.ok) {
      queueDfmExternalChangeHighlights(changedCells);
      if ((changedCells.ratioCells.length || changedCells.averageCells.length) && isRatiosTabVisible()) {
        renderRatioTable();
      }
      rememberDfmMethodFileRevision(path, result.revision || revisionResult.revision);
      postDfmStatus(`Ready: Reloaded external DFM JSON changes from ${path}`);
    }
  } catch (err) {
    console.warn("DFM method file watch failed:", err);
  } finally {
    ratioFileWatchInFlight = false;
  }
}

export function startDfmMethodFileWatcher() {
  if (ratioFileWatchTimer) return;
  ratioFileWatchTimer = setInterval(() => {
    checkDfmMethodFileWatch();
  }, DFM_METHOD_FILE_WATCH_INTERVAL_MS);
  checkDfmMethodFileWatch();
}

export function stopDfmMethodFileWatcher() {
  if (!ratioFileWatchTimer) return;
  clearInterval(ratioFileWatchTimer);
  ratioFileWatchTimer = null;
}

export async function saveRatioSelectionPattern(forceSaveAs) {
  const hostApi = getHostApi();
  if (!hostApi || typeof hostApi.saveJsonFile !== "function") {
    alert("Save requires the desktop app.");
    window.parent.postMessage({ type: "arcrho:status", text: "Save failed: desktop app required." }, "*");
    return { ok: false, error: "desktop app required" };
  }
  const data = await buildDfmMethodPayloadWithPaths();
  const resultVector = buildResultsVector();
  const payload = {
    data,
    suggestedName: getRatioSaveSuggestedName(),
    startDir: await getRatioSaveBaseDir(),
  };
  if (!forceSaveAs) {
    payload.path = await buildRatioSavePath();
  }
  const result = await hostApi.saveJsonFile(payload);
  if (result && result.path) {
    try {
      localStorage.setItem(RATIO_SAVE_PATH_KEY, result.path);
    } catch {}
    let csvPath = "";
    let csvError = "";
    const aggregatedCsvPaths = [];
    let baseCsvSaved = false;
    if (typeof hostApi.saveTextFile === "function") {
      const csvErrors = [];
      try {
        const dataDir = await getRatioDataDir();
        csvPath = `${dataDir}\\${getResultsCsvSuggestedName()}`;
        const csvOut = await hostApi.saveTextFile({
          path: csvPath,
          data: buildResultsVectorCsv(resultVector),
        });
        if (!csvOut || csvOut.error) {
          csvErrors.push(csvOut?.error ? String(csvOut.error) : "unknown error");
        } else {
          baseCsvSaved = true;
          const sidecarOut = await saveDatasetSidecar(hostApi, csvPath, getResultsCsvSuggestedName().replace(/\.csv$/i, ""));
          if (!sidecarOut.ok) {
            csvErrors.push(`${csvPath.replace(/\.csv$/i, ".json")}: ${sidecarOut.error}`);
          }
          const variants = buildAggregatedResultVariants(resultVector);
          for (const variant of variants) {
            const aggName = getResultsCsvSuggestedName({
              originLen: variant.originLen,
              devLen: variant.devLen,
            });
            const aggPath = `${dataDir}\\${aggName}`;
            if (aggPath.toLowerCase() === csvPath.toLowerCase()) continue;
            const aggOut = await hostApi.saveTextFile({
              path: aggPath,
              data: buildResultsVectorCsv(variant.vector),
            });
            if (!aggOut || aggOut.error) {
              csvErrors.push(`${aggPath}: ${aggOut?.error ? String(aggOut.error) : "unknown error"}`);
              continue;
            }
            aggregatedCsvPaths.push(aggPath);
          }
        }
      } catch (err) {
        csvErrors.push(String(err?.message || err));
      }
      csvError = csvErrors.join("; ");
    } else {
      csvError = "desktop host does not support csv save";
    }
    markMethodSaved();
    recordCleanDfmDirtySnapshot(data);
    markDfmClean();
    emitDfmInstancePresence("found");
    await refreshDfmMethodFileRevision(result.path);
    const objectSnapshot = recordCurrentDfmObjectSnapshot();
    refreshDfmMethodIndex(objectSnapshot.project, objectSnapshot.reservingClass).catch((err) => {
      console.warn("Failed to refresh DFM method index:", err);
    });
    const time = new Date().toLocaleTimeString();
    let statusText = `Method saved at ${time}.`;
    if (baseCsvSaved) {
      statusText += ` | CSV saved${aggregatedCsvPaths.length ? ` (+${aggregatedCsvPaths.length} aggregated)` : ""}`;
    }
    if (csvError) {
      statusText += ` | CSV save failed: ${csvError}`;
    }
    window.parent.postMessage(
      { type: "arcrho:status", text: statusText },
      "*"
    );
    return { ok: true, path: result.path, csvPath, csvError, aggregatedCsvPaths };
  } else if (result && result.error) {
    window.parent.postMessage({ type: "arcrho:status", text: `Save failed: ${result.error}` }, "*");
    return { ok: false, error: result.error };
  } else {
    window.parent.postMessage({ type: "arcrho:status", text: "Save canceled." }, "*");
    return { ok: false, canceled: true };
  }
}

export async function saveDfmTemplate() {
  const hostApi = getHostApi();
  if (!hostApi || typeof hostApi.saveJsonFile !== "function") {
    alert("Save requires the desktop app.");
    window.parent.postMessage({ type: "arcrho:status", text: "Save failed: desktop app required." }, "*");
    return;
  }

  const avgSelection = buildAverageSelectionPayload();
  const cfgKey = getSummaryConfigKey();
  const summaryRows = getSummaryRowsForPersistence(cfgKey);

  const data = buildDfmGroupedMethodPayload({
    "origin length": readSelectedLengthNumber("originLenSelect"),
    "development length": readSelectedLengthNumber("devLenSelect"),
    "average formulas": buildDfmAverageFormulaObject(summaryRows, avgSelection.matrix),
  });

  const project = sanitizeFileNamePart(getRatioSaveProjectName(), "UnknownProject");
  const rc = sanitizeFileNamePart(getResolvedReservingClass() || "ReservingClass", "ReservingClass");
  const suggestedName = `DFM_Template@${project}@${rc}.arc-dfm`;

  let startDir = "";
  try {
    const dirRes = await fetch("/template/default_dir");
    if (dirRes.ok) {
      const dirData = await dirRes.json();
      startDir = dirData.path || "";
    }
  } catch {}

  const result = await hostApi.saveJsonFile({
    data,
    suggestedName,
    startDir,
    filters: [{ name: "DFM Template", extensions: ["arc-dfm"] }],
  });

  if (result && result.path) {
    const time = new Date().toLocaleTimeString();
    window.parent.postMessage({ type: "arcrho:status", text: `Template saved at ${time}: ${result.path}` }, "*");
  } else if (result && result.error) {
    window.parent.postMessage({ type: "arcrho:status", text: `Template save failed: ${result.error}` }, "*");
  } else {
    window.parent.postMessage({ type: "arcrho:status", text: "Template save canceled." }, "*");
  }
}

export async function loadDfmTemplate() {
  const hostApi = getHostApi();
  if (!hostApi) {
    alert("Load requires the desktop app.");
    return;
  }

  const pickFn = hostApi.pickOpenFile || null;
  if (!pickFn) {
    alert("Load requires the desktop app.");
    return;
  }

  let startDir = "";
  try {
    const dirRes = await fetch("/template/default_dir");
    if (dirRes.ok) {
      const dirData = await dirRes.json();
      startDir = dirData.path || "";
    }
  } catch {}

  const filePath = await pickFn({
    startDir,
    filters: [{ name: "DFM Template", extensions: ["arc-dfm"] }],
  });
  if (!filePath) return;

  const fileResult = await hostApi.readJsonFile({ path: filePath });
  if (!fileResult || !fileResult.exists || !fileResult.data) {
    window.parent.postMessage({ type: "arcrho:status", text: "Failed to read template file." }, "*");
    return;
  }

  const payload = fileResult.data;
  const detailsTab = getDfmDetailsTab(payload);
  const ratiosTab = getDfmRatiosTab(payload);

  /* Apply origin / development lengths */
  const originEl = document.getElementById("originLenSelect");
  const devEl = document.getElementById("devLenSelect");
  const ensureOption = (sel, val) => {
    if (!sel || !val) return;
    if (![...sel.options].some((o) => o.value === String(val))) {
      const opt = document.createElement("option");
      opt.value = String(val);
      opt.textContent = String(val);
      sel.appendChild(opt);
    }
    sel.value = String(val);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  };
  if (detailsTab["origin length"]) ensureOption(originEl, detailsTab["origin length"]);
  if (detailsTab["development length"]) ensureOption(devEl, detailsTab["development length"]);

  /* Apply average formula rows */
  const cfgKey = getSummaryConfigKey();
  const averageFormulas = ratiosTab["average formulas"];
  const formulas = getDfmAverageFormulaLabels(averageFormulas);
  const matrix = getDfmAverageFormulaSelectedIndex(averageFormulas);
  const averageFormulaValues = getDfmAverageFormulaValues(averageFormulas);
  const averageFormulaRows = buildDfmSummaryRowsFromAverageFormulaObject(averageFormulas);
  const resolvedSummary = buildDfmSummaryRowsFromAverageFormulas(averageFormulaRows, formulas);
  const summaryRows = hydrateUserEntryValuesFromAverageFormulaValues(
    resolvedSummary.rows,
    formulas,
    averageFormulaValues,
  );
  if (Array.isArray(summaryRows) && cfgKey) {
    saveCustomSummaryRows(cfgKey, summaryRows);
  }
  buildSummaryRows();

  /* Apply average formula selections */
  if (Array.isArray(formulas) && Array.isArray(matrix)) {
    applyAverageSelectionFromSaved(formulas, matrix);
  }

  renderRatioTable();
  renderResultsTable();

  window.parent.postMessage({ type: "arcrho:status", text: `Template loaded: ${filePath}` }, "*");
}

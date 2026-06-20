import { fetchProjectDatasetTypeItems } from "/ui/dataset/dataset_types_source.js";
import {
  ensureDatasetOriginLabels,
  formatDatasetOriginLabel,
  getDatasetOriginLabelText,
} from "/ui/dataset/dataset_origin_labels.js";
import { sanitizeDataFolderPart, sanitizeFileNamePart } from "/ui/shared/filename_sanitizer.js";
import { wireNotesEditorInteractions } from "/ui/shared/notes_editor_interactions.js";

const RS_JSON_FORMAT = "arcrho-result-selection-method-by-tab-v1";
const DEFAULT_ORIGIN_LENGTH = 12;
const VALID_ORIGIN_LENGTHS = [12, 6, 3, 1];
const FALLBACK_ORIGIN_LABEL_COUNTS = {
  12: 10,
  6: 20,
  3: 40,
  1: 120,
};
const METHOD_COL_DEFAULT_WIDTHS = {
  origin: 90,
  source: 90,
  weight: 58,
  ultimate: 100,
  ratio: 100,
  spacer: 14,
};
const METHOD_COL_MIN_WIDTHS = {
  origin: 58,
  source: 52,
  weight: 58,
  ultimate: 70,
  ratio: 70,
  spacer: 14,
};
const METHOD_COL_MAX_WIDTH = 320;

const params = new URLSearchParams(window.location.search);
const inst = params.get("inst") || `rs_${Date.now()}`;
let programmatic = false;
let isDirty = false;
let cleanSnapshot = "";
let datasetTypeItems = [];
let cachedRows = [];
let notesProgrammatic = false;
let lastSavedNotesText = "";
let closeConfirmResolve = null;

const state = {
  project: text(params.get("project")),
  reservingClass: text(params.get("class") || params.get("path")),
  outputCategory: text(params.get("category")),
  sources: [],
  ratioBasisValues: [],
  outputValues: [],
  originLabels: [],
  originLabelsKey: "",
  sidecarOriginLength: null,
  sidecarOriginLabels: [],
  methodColumnWidths: {},
  showEffectiveWeights: false,
  methodHighlight: null,
  methodHighlightDragging: false,
  weightEditSession: null,
  ultimateOverrides: [],
  activeTab: text(params.get("tab") || "details") || "details",
};

const els = {
  tabBar: document.getElementById("rsTabBar"),
  nameInput: document.getElementById("rsNameInput"),
  outputTypeInput: document.getElementById("rsOutputTypeInput"),
  outputTypeBtn: document.getElementById("rsOutputTypeBtn"),
  originLengthInput: document.getElementById("rsOriginLengthInput"),
  ratioBasisInput: document.getElementById("rsRatioBasisInput"),
  ratioBasisBtn: document.getElementById("rsRatioBasisBtn"),
  showRatiosPctInput: document.getElementById("rsShowRatiosPctInput"),
  statisticDecimalsInput: document.getElementById("rsStatisticDecimalsInput"),
  showWeightsInput: document.getElementById("rsShowWeightsInput"),
  toggleWeightsDisplayBtn: document.getElementById("rsToggleWeightsDisplayBtn"),
  addSourceBtn: document.getElementById("rsAddSourceBtn"),
  ratioBasisStatus: document.getElementById("rsRatioBasisStatus"),
  methodGrid: document.getElementById("rsMethodGrid"),
  saveBtn: document.getElementById("rsSaveBtn"),
  cancelBtn: document.getElementById("rsCancelBtn"),
  notesInput: document.getElementById("rsNotesInput"),
  picker: document.getElementById("rsPicker"),
  cellContextMenu: document.getElementById("rsCellContextMenu"),
  sourceContextMenu: document.getElementById("rsSourceContextMenu"),
  closeConfirmOverlay: document.getElementById("rsCloseConfirmOverlay"),
  closeConfirmBox: document.getElementById("rsCloseConfirmBox"),
  closeConfirmTitle: document.getElementById("rsCloseConfirmTitle"),
  closeConfirmMessage: document.getElementById("rsCloseConfirmMessage"),
  closeConfirmOk: document.getElementById("rsCloseConfirmOk"),
  closeConfirmCancel: document.getElementById("rsCloseConfirmCancel"),
  closeConfirmClose: document.getElementById("rsCloseConfirmClose"),
};

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

function positiveInt(value, fallback = DEFAULT_ORIGIN_LENGTH) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function validOriginLength(value, fallback = DEFAULT_ORIGIN_LENGTH) {
  const n = positiveInt(value, fallback);
  return VALID_ORIGIN_LENGTHS.includes(n) ? n : fallback;
}

function validSourceOriginLength(value) {
  const n = validOriginLength(value, 0);
  return VALID_ORIGIN_LENGTHS.includes(n) ? n : null;
}

function nonNegativeInt(value, fallback = 0) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
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
  try {
    window.parent?.postMessage({ type: "arcrho:status", text: String(message || ""), ...(tone ? { tone } : {}) }, "*");
  } catch {}
}

function postDirty(dirty, force = false) {
  const next = !!dirty;
  if (!force && isDirty === next) return;
  isDirty = next;
  els.saveBtn.disabled = !next;
  els.cancelBtn.disabled = !next;
  els.saveBtn.classList.toggle("is-clean", !next);
  try {
    window.parent?.postMessage({ type: "arcrho:dataset-dirty", inst, dirty: next }, "*");
  } catch {}
}

function markDirty() {
  if (programmatic) return;
  postDirty(true);
}

function withProgrammatic(fn) {
  programmatic = true;
  try {
    return fn();
  } finally {
    programmatic = false;
  }
}

function getDetails() {
  return {
    name: text(els.nameInput.value),
    outputType: text(els.outputTypeInput.value),
    originLength: validOriginLength(els.originLengthInput.value),
    ratioBasis: text(els.ratioBasisInput.value),
    showRatiosAsPercentages: !!els.showRatiosPctInput.checked,
    statisticDecimalPlaces: Math.max(0, Math.min(8, nonNegativeInt(els.statisticDecimalsInput.value, 1))),
    showWeights: !!els.showWeightsInput.checked,
  };
}

function getResultSelectionDisplayName() {
  return getDetails().name || "Result Selection";
}

function resolveCloseConfirm(value) {
  if (els.closeConfirmOverlay) els.closeConfirmOverlay.hidden = true;
  const resolve = closeConfirmResolve;
  closeConfirmResolve = null;
  if (resolve) resolve(!!value);
}

function resetCloseConfirmPosition() {
  const box = els.closeConfirmBox;
  if (!box) return;
  box.classList.remove("is-dragging");
  box.style.position = "";
  box.style.left = "";
  box.style.top = "";
  box.style.width = "";
}

function placeCloseConfirmBox(left, top) {
  const box = els.closeConfirmBox;
  if (!box) return;
  const rect = box.getBoundingClientRect();
  const pad = 8;
  const maxLeft = Math.max(pad, window.innerWidth - rect.width - pad);
  const maxTop = Math.max(pad, window.innerHeight - rect.height - pad);
  box.style.left = `${Math.round(Math.max(pad, Math.min(left, maxLeft)))}px`;
  box.style.top = `${Math.round(Math.max(pad, Math.min(top, maxTop)))}px`;
}

function startCloseConfirmDrag(event) {
  if (event.button !== 0) return;
  if (event.target?.closest?.("button,input,select,textarea,a,[contenteditable='true']")) return;
  const box = els.closeConfirmBox;
  if (!box) return;
  event.preventDefault();
  const rect = box.getBoundingClientRect();
  const offsetX = event.clientX - rect.left;
  const offsetY = event.clientY - rect.top;
  box.style.position = "fixed";
  box.style.width = `${Math.round(rect.width)}px`;
  box.classList.add("is-dragging");
  placeCloseConfirmBox(rect.left, rect.top);
  const onMove = (moveEvent) => {
    moveEvent.preventDefault();
    placeCloseConfirmBox(moveEvent.clientX - offsetX, moveEvent.clientY - offsetY);
  };
  const onUp = () => {
    box.classList.remove("is-dragging");
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mouseup", onUp, true);
  };
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("mouseup", onUp, true);
}

function showCloseConfirm(reason = "close") {
  if (closeConfirmResolve) return Promise.resolve(false);
  if (!els.closeConfirmOverlay || !els.closeConfirmOk) return Promise.resolve(false);
  const displayName = getResultSelectionDisplayName();
  const isClose = reason === "close";
  if (els.closeConfirmTitle) els.closeConfirmTitle.textContent = isClose ? "Cancel and close?" : "Cancel changes?";
  if (els.closeConfirmMessage) {
    els.closeConfirmMessage.textContent = isClose
      ? `Unsaved changes to ${displayName} will be discarded and the window will close.`
      : `Unsaved changes to ${displayName} will be discarded.`;
  }
  closeCellContextMenu();
  closeSourceContextMenu();
  closePicker();
  resetCloseConfirmPosition();
  els.closeConfirmOverlay.hidden = false;
  requestAnimationFrame(() => els.closeConfirmOk?.focus());
  return new Promise((resolve) => {
    closeConfirmResolve = resolve;
  });
}

function requestConfirmedClose() {
  postDirty(false, true);
  try {
    window.parent?.postMessage({
      type: "arcrho:dataset-close-confirmed",
      inst,
    }, "*");
  } catch {}
}

function setTab(tab) {
  const next = ["details", "method", "results", "validation", "notes"].includes(norm(tab)) ? norm(tab) : "details";
  state.activeTab = next;
  document.querySelectorAll(".rsTab").forEach((btn) => btn.classList.toggle("active", btn.dataset.page === next));
  document.querySelectorAll(".rsPage").forEach((page) => page.classList.toggle("active", page.id === `rs${next[0].toUpperCase()}${next.slice(1)}Page`));
  try {
    window.parent?.postMessage({ type: "arcrho:result-selection-tab-changed", inst, tab: next }, "*");
  } catch {}
}

function normalizeDatasetRows(payload) {
  const files = Array.isArray(payload?.files) ? payload.files : [];
  const byType = new Map(datasetTypeItems.map((item) => [norm(item.name), item]));
  const rows = [];
  const seen = new Set();
  for (const item of files) {
    const names = Array.isArray(item?.dataset_names) && item.dataset_names.length
      ? item.dataset_names
      : [item?.dataset_name || item?.name];
    for (const rawName of names) {
      const name = stripDatasetCacheVariantSuffix(text(rawName || item?.dataset_name || item?.name));
      const key = norm(name);
      if (!name || seen.has(key)) continue;
      seen.add(key);
      const datasetType = text(item?.dataset_type_name || item?.dataset_type || item?.dataset_name || name);
      const typeInfo = byType.get(norm(datasetType)) || byType.get(norm(name)) || {};
      rows.push({
        name,
        datasetType,
        dataFormat: text(item?.data_format || typeInfo.dataFormat),
        originLength: validSourceOriginLength(item?.origin_length),
        category: text(typeInfo.category || item?.category),
        methodType: text(item?.method_type),
        path: text(item?.path),
      });
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

function stripDatasetCacheVariantSuffix(value) {
  const parts = text(value).split("@");
  if (
    parts.length >= 5
    && /^(dev|cal)$/i.test(parts[parts.length - 1])
    && /^(cum|inc)$/i.test(parts[parts.length - 2])
    && /^\d+$/.test(parts[parts.length - 3])
    && /^\d+$/.test(parts[parts.length - 4])
  ) {
    return parts.slice(0, -4).join("@").trim();
  }
  return text(value).replace(/\.[^.]+$/u, "");
}

async function loadDatasetTypes() {
  if (!state.project) return;
  try {
    const payload = await fetchProjectDatasetTypeItems(state.project, { dedupeByName: true });
    datasetTypeItems = Array.isArray(payload?.items) ? payload.items : [];
  } catch (err) {
    console.warn("Result Selection dataset type load failed:", err);
    datasetTypeItems = [];
  }
}

async function loadCachedRows(refresh = false) {
  if (!state.project || !state.reservingClass) return [];
  const url = new URL("/datasets/cached", window.location.origin);
  url.searchParams.set("project_name", state.project);
  url.searchParams.set("reserving_class", state.reservingClass);
  if (refresh) url.searchParams.set("refresh", "true");
  const resp = await fetch(url.toString(), { cache: "no-store" });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok || payload?.ok === false) throw new Error(payload?.detail || `Cached dataset lookup failed (${resp.status}).`);
  cachedRows = normalizeDatasetRows(payload);
  return cachedRows;
}

async function loadDatasetValues(datasetName) {
  const name = text(datasetName);
  if (!state.project || !state.reservingClass || !name) throw new Error("Missing project, reserving class, or dataset name.");
  const resp = await fetch("/dataset/cache/load", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_name: state.project,
      reserving_class: state.reservingClass,
      dataset_name: name,
    }),
  });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok || payload?.ok === false) throw new Error(payload?.detail || payload?.error || `Dataset load failed (${resp.status}).`);
  return payload;
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

async function buildSourceFromRecord(record, existing = null) {
  const source = {
    name: text(record?.name || existing?.name),
    datasetType: text(record?.datasetType || existing?.dataset_type || existing?.datasetType),
    dataFormat: text(record?.dataFormat || existing?.data_format || existing?.dataFormat),
    originLength: validSourceOriginLength(record?.originLength ?? record?.origin_length ?? existing?.origin_length ?? existing?.originLength),
    methodType: text(record?.methodType || existing?.method_type || existing?.methodType),
    category: text(record?.category || existing?.category),
    valueSource: "vector",
    values: Array.isArray(existing?.values) ? existing.values.map(numberOrNull) : [],
    weights: Array.isArray(existing?.weights) ? existing.weights.map((v) => Math.max(0, numberOrNull(v) ?? 0)) : [],
    selected: Array.isArray(existing?.selected) ? existing.selected.map(Boolean) : [],
    unavailable: false,
  };
  if (!source.name) return null;
  try {
    const payload = await loadDatasetValues(source.name);
    source.datasetType = source.datasetType || text(payload?.dataset_type || source.name);
    source.dataFormat = source.dataFormat || text(payload?.data_format);
    source.originLength = validSourceOriginLength(payload?.origin_length) || source.originLength;
    const isTriangle = norm(source.dataFormat) === "triangle";
    source.valueSource = isTriangle ? "latest_diagonal" : "vector";
    source.values = isTriangle ? latestDiagonal(payload?.values) : vectorValues(payload?.values);
  } catch (err) {
    console.warn("Result Selection source load failed:", source.name, err);
    source.unavailable = true;
  }
  if (source.weights.length < source.values.length) {
    source.weights = source.weights.concat(new Array(source.values.length - source.weights.length).fill(0));
  }
  while (source.selected.length < source.values.length) {
    const idx = source.selected.length;
    source.selected.push(numberOrNull(source.values[idx]) !== null && Math.max(0, numberOrNull(source.weights[idx]) ?? 0) > 0);
  }
  if (source.selected.length > source.values.length) source.selected = source.selected.slice(0, source.values.length);
  return source;
}

function getRowCount() {
  if (originLabelsKey() === state.originLabelsKey && state.originLabels.length) {
    return state.originLabels.length;
  }
  return FALLBACK_ORIGIN_LABEL_COUNTS[getDetails().originLength] || getDetails().originLength;
}

function originLabelsKey(originLength = getDetails().originLength) {
  return `${state.project}||${validOriginLength(originLength)}`;
}

function setOriginLabels(labels, originLength = getDetails().originLength) {
  state.originLabels = Array.isArray(labels) ? labels.map(String) : [];
  state.originLabelsKey = originLabelsKey(originLength);
}

function labelsLookAnnual(labels) {
  const values = Array.isArray(labels) ? labels.map(text).filter(Boolean) : [];
  return values.length > 0 && values.slice(0, Math.min(values.length, 8)).every((label) => /^\d{4}$/.test(label));
}

function labelsLookSubannual(labels) {
  const values = Array.isArray(labels) ? labels.map(text).filter(Boolean) : [];
  return values.length > 0 && values.slice(0, Math.min(values.length, 8)).some((label) => (
    /\bQ[1-4]\b/i.test(label)
    || /\bH[1-2]\b/i.test(label)
    || /^\d{6}$/.test(label)
    || /^[A-Za-z]{3}\s+\d{4}$/.test(label)
  ));
}

function shouldRejectOriginLabels(originLength, labels = []) {
  const length = validOriginLength(originLength);
  if (!Array.isArray(labels) || !labels.length) return false;
  if (length === 12) return labelsLookSubannual(labels);
  return labelsLookAnnual(labels);
}

function applyOriginLength(value) {
  const n = validOriginLength(value, 0);
  if (!n) return false;
  withProgrammatic(() => {
    els.originLengthInput.value = String(n);
  });
  return true;
}

function allowedOriginLengthsForSources() {
  const required = state.sources.reduce((max, source) => {
    const originLength = validSourceOriginLength(source?.originLength);
    return originLength ? Math.max(max, originLength) : max;
  }, 0);
  return VALID_ORIGIN_LENGTHS.filter((originLength) => !required || originLength >= required);
}

function syncOriginLengthOptions() {
  const input = els.originLengthInput;
  if (!input) return false;
  const allowed = allowedOriginLengthsForSources();
  const current = validOriginLength(input.value, DEFAULT_ORIGIN_LENGTH);
  const fallback = allowed[allowed.length - 1] || DEFAULT_ORIGIN_LENGTH;
  const next = allowed.includes(current) ? current : fallback;
  const existing = Array.from(input.options || []).map((option) => Number.parseInt(option.value, 10));
  const needsOptions = existing.length !== allowed.length || existing.some((value, index) => value !== allowed[index]);
  if (needsOptions) {
    input.replaceChildren(...allowed.map((originLength) => {
      const option = document.createElement("option");
      option.value = String(originLength);
      option.textContent = String(originLength);
      return option;
    }));
  }
  withProgrammatic(() => {
    input.value = String(next);
  });
  if (next === current) return false;
  state.sidecarOriginLength = null;
  state.sidecarOriginLabels = [];
  setOriginLabels([], next);
  return true;
}

function generatedOriginLabel(rowIndex, originLength) {
  const startYear = 2017;
  if (originLength === 6) return `${startYear + Math.floor(rowIndex / 2)}H${(rowIndex % 2) + 1}`;
  if (originLength === 3) return `${startYear + Math.floor(rowIndex / 4)}Q${(rowIndex % 4) + 1}`;
  if (originLength === 1) {
    const year = startYear + Math.floor(rowIndex / 12);
    const month = String((rowIndex % 12) + 1).padStart(2, "0");
    return formatDatasetOriginLabel(`${year}${month}`, originLength);
  }
  return String(startYear + rowIndex);
}

function originLabel(rowIndex) {
  const originLength = getDetails().originLength;
  const label = Array.isArray(state.originLabels) ? state.originLabels[rowIndex] : "";
  if (text(label)) return formatDatasetOriginLabel(label, originLength);
  return generatedOriginLabel(rowIndex, originLength);
}

async function refreshOriginLabels(options = {}) {
  const originLength = getDetails().originLength;
  const key = originLabelsKey(originLength);
  state.originLabelsKey = key;
  if (!state.project) {
    setOriginLabels([], originLength);
    if (options.render !== false) renderMethodGrid();
    return;
  }
  try {
    const labels = await ensureDatasetOriginLabels(state.project, originLength, {
      forceRefresh: !!options.forceRefresh,
    });
    if (state.originLabelsKey !== key) return;
    setOriginLabels(labels, originLength);
  } catch (err) {
    if (state.originLabelsKey !== key) return;
    console.warn("Result Selection origin label load failed:", err);
    setOriginLabels([], originLength);
  }
  if (options.render !== false) renderMethodGrid();
}

async function loadOutputSidecarSettings() {
  const datasetName = text(els.nameInput.value);
  if (!state.project || !state.reservingClass || !datasetName) return false;
  const resp = await fetch("/dataset/sidecar/load", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_name: state.project,
      reserving_class: state.reservingClass,
      dataset_name: datasetName,
    }),
  });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok || payload?.ok === false || payload?.exists === false) return false;
  const originLength = validOriginLength(payload?.origin_length, 0);
  const labels = Array.isArray(payload?.origin_labels) ? payload.origin_labels.map(String) : [];
  const resolvedLabels = shouldRejectOriginLabels(originLength, labels) ? [] : labels;
  state.sidecarOriginLength = originLength || null;
  state.sidecarOriginLabels = resolvedLabels;
  if (originLength) applyOriginLength(originLength);
  if (resolvedLabels.length) setOriginLabels(resolvedLabels, originLength || getDetails().originLength);
  return true;
}

function ensureSourceSelection(source, count = getRowCount()) {
  if (!source) return [];
  if (!Array.isArray(source.selected)) source.selected = [];
  while (source.selected.length < count) source.selected.push(false);
  if (source.selected.length > count) source.selected = source.selected.slice(0, count);
  return source.selected;
}

function isSourceCellSelectable(sourceIndex, rowIndex) {
  return numberOrNull(state.sources[sourceIndex]?.values?.[rowIndex]) !== null;
}

function isSourceCellSelected(sourceIndex, rowIndex) {
  const source = state.sources[sourceIndex];
  if (!source || !isSourceCellSelectable(sourceIndex, rowIndex)) return false;
  return !!ensureSourceSelection(source, Math.max(getRowCount(), rowIndex + 1))[rowIndex];
}

function setSourceCellSelected(sourceIndex, rowIndex, selected) {
  const source = state.sources[sourceIndex];
  if (!source || !isSourceCellSelectable(sourceIndex, rowIndex)) return false;
  ensureSourceSelection(source, Math.max(getRowCount(), rowIndex + 1))[rowIndex] = !!selected;
  return true;
}

function syncSourceCellSelectionDom(sourceIndex, rowIndex) {
  const selector = `.rsSourceCell[data-source-index="${sourceIndex}"][data-row-index="${rowIndex}"]`;
  const cell = els.methodGrid?.querySelector?.(selector);
  if (cell) cell.classList.toggle("rsSelectedSourceCell", isSourceCellSelected(sourceIndex, rowIndex));
}

function setWeightValue(sourceIndex, rowIndex, rawValue) {
  const source = state.sources[sourceIndex];
  if (!source) return null;
  const weight = Math.max(0, numberOrNull(rawValue) ?? 0);
  while (source.weights.length <= rowIndex) source.weights.push(0);
  source.weights[rowIndex] = weight;
  setSourceCellSelected(sourceIndex, rowIndex, weight > 0);
  syncSourceCellSelectionDom(sourceIndex, rowIndex);
  return weight;
}

function isUltimateOverridden(rowIndex) {
  return Object.prototype.hasOwnProperty.call(state.ultimateOverrides, rowIndex)
    && numberOrNull(state.ultimateOverrides[rowIndex]) !== null;
}

function calculatedSelectedUltimateAt(rowIndex) {
  let numerator = 0;
  let denominator = 0;
  for (let sourceIndex = 0; sourceIndex < state.sources.length; sourceIndex += 1) {
    const source = state.sources[sourceIndex];
    const value = numberOrNull(source.values[rowIndex]);
    const weight = Math.max(0, numberOrNull(source.weights[rowIndex]) ?? 0);
    if (value === null || weight <= 0 || !isSourceCellSelected(sourceIndex, rowIndex)) continue;
    numerator += value * weight;
    denominator += weight;
  }
  return denominator > 0 ? numerator / denominator : null;
}

function setUltimateOverride(rowIndex, rawValue) {
  const value = numberOrNull(rawValue);
  if (value === null) return false;
  state.ultimateOverrides[rowIndex] = value;
  return true;
}

function clearUltimateOverride(rowIndex) {
  if (!isUltimateOverridden(rowIndex)) return false;
  delete state.ultimateOverrides[rowIndex];
  return true;
}

function isMethodDataRow(rowIndex) {
  return rowIndex >= 0 && rowIndex < getRowCount();
}

function applyHighlightedUltimateValue(rawValue) {
  const h = normalizedMethodHighlight();
  if (!h) return false;
  const columns = buildMethodColumns(getDetails());
  let changed = false;
  for (let rowIndex = h.startRow; rowIndex <= h.endRow; rowIndex += 1) {
    if (!isMethodDataRow(rowIndex)) continue;
    for (let colIndex = h.startCol; colIndex <= h.endCol; colIndex += 1) {
      const column = columns[colIndex];
      if (column?.type !== "ultimate") continue;
      if (setUltimateOverride(rowIndex, rawValue)) changed = true;
    }
  }
  return changed;
}

function highlightedHasWeightTargets(highlight = normalizedMethodHighlight()) {
  if (!highlight) return false;
  const columns = buildMethodColumns(getDetails());
  for (let rowIndex = highlight.startRow; rowIndex <= highlight.endRow; rowIndex += 1) {
    if (!isMethodDataRow(rowIndex)) continue;
    for (let colIndex = highlight.startCol; colIndex <= highlight.endCol; colIndex += 1) {
      const column = columns[colIndex];
      if (column?.type === "weight") return true;
      if (column?.type === "source" && isSourceCellSelectable(column.sourceIndex, rowIndex)) return true;
    }
  }
  return false;
}

function highlightedHasUltimateCells(highlight = normalizedMethodHighlight()) {
  if (!highlight) return false;
  const columns = buildMethodColumns(getDetails());
  for (let rowIndex = highlight.startRow; rowIndex <= highlight.endRow; rowIndex += 1) {
    if (!isMethodDataRow(rowIndex)) continue;
    for (let colIndex = highlight.startCol; colIndex <= highlight.endCol; colIndex += 1) {
      if (columns[colIndex]?.type === "ultimate") return true;
    }
  }
  return false;
}

function visibleWeightSourceIndices() {
  return buildMethodColumns(getDetails())
    .filter((column) => column.type === "weight")
    .map((column) => column.sourceIndex);
}

function applyWeightPaste(startSourceIndex, startRow, rawText) {
  const sourceIndices = visibleWeightSourceIndices();
  const startCol = sourceIndices.indexOf(startSourceIndex);
  if (startCol < 0) return false;
  const rows = String(rawText ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
  if (rows.length > 1 && rows[rows.length - 1] === "") rows.pop();
  let changed = false;
  const rowCount = getRowCount();
  rows.forEach((rowText, rowOffset) => {
    const targetRow = startRow + rowOffset;
    if (targetRow >= rowCount) return;
    rowText.split("\t").forEach((cellText, colOffset) => {
      const sourceIndex = sourceIndices[startCol + colOffset];
      if (sourceIndex === undefined) return;
      setWeightValue(sourceIndex, targetRow, cellText);
      changed = true;
    });
  });
  return changed;
}

function applyHighlightedWeightValue(rawValue) {
  const h = normalizedMethodHighlight();
  if (!h) return false;
  const columns = buildMethodColumns(getDetails());
  let changed = false;
  for (let rowIndex = h.startRow; rowIndex <= h.endRow; rowIndex += 1) {
    if (!isMethodDataRow(rowIndex)) continue;
    for (let colIndex = h.startCol; colIndex <= h.endCol; colIndex += 1) {
      const column = columns[colIndex];
      if (!column || (column.type !== "weight" && column.type !== "source")) continue;
      if (column.type === "source" && !isSourceCellSelectable(column.sourceIndex, rowIndex)) continue;
      setWeightValue(column.sourceIndex, rowIndex, rawValue);
      changed = true;
    }
  }
  return changed;
}

function parseClipboardGrid(rawText) {
  const rows = String(rawText ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
  if (rows.length > 1 && rows[rows.length - 1] === "") rows.pop();
  return rows.map((row) => row.split("\t"));
}

function clipboardGridValue(grid, rowOffset, colOffset) {
  if (!grid.length) return "";
  if (grid.length === 1 && grid[0].length === 1) return grid[0][0] ?? "";
  return grid[rowOffset]?.[colOffset] ?? "";
}

function clipboardGridColumnCount(grid) {
  return grid.reduce((max, row) => Math.max(max, row.length), 0);
}

function pasteTargetEndRow(highlight, grid) {
  return Math.max(highlight.endRow, highlight.startRow + Math.max(1, grid.length) - 1);
}

function pasteTargetEndCol(highlight, grid) {
  return Math.max(highlight.endCol, highlight.startCol + Math.max(1, clipboardGridColumnCount(grid)) - 1);
}

function applyHighlightedWeightGrid(grid) {
  const h = normalizedMethodHighlight();
  if (!h) return false;
  const columns = buildMethodColumns(getDetails());
  let changed = false;
  const endRow = pasteTargetEndRow(h, grid);
  const endCol = pasteTargetEndCol(h, grid);
  for (let rowIndex = h.startRow; rowIndex <= endRow; rowIndex += 1) {
    if (!isMethodDataRow(rowIndex)) continue;
    const rowOffset = rowIndex - h.startRow;
    for (let colIndex = h.startCol; colIndex <= endCol; colIndex += 1) {
      const column = columns[colIndex];
      if (!column || (column.type !== "weight" && column.type !== "source")) continue;
      if (column.type === "source" && !isSourceCellSelectable(column.sourceIndex, rowIndex)) continue;
      setWeightValue(column.sourceIndex, rowIndex, clipboardGridValue(grid, rowOffset, colIndex - h.startCol));
      changed = true;
    }
  }
  return changed;
}

function applyHighlightedUltimateGrid(grid) {
  const h = normalizedMethodHighlight();
  if (!h) return false;
  const columns = buildMethodColumns(getDetails());
  let changed = false;
  const endRow = pasteTargetEndRow(h, grid);
  const endCol = pasteTargetEndCol(h, grid);
  for (let rowIndex = h.startRow; rowIndex <= endRow; rowIndex += 1) {
    if (!isMethodDataRow(rowIndex)) continue;
    const rowOffset = rowIndex - h.startRow;
    for (let colIndex = h.startCol; colIndex <= endCol; colIndex += 1) {
      if (columns[colIndex]?.type !== "ultimate") continue;
      if (setUltimateOverride(rowIndex, clipboardGridValue(grid, rowOffset, colIndex - h.startCol))) changed = true;
    }
  }
  return changed;
}

function applyHighlightedPasteText(rawText) {
  const h = normalizedMethodHighlight();
  if (!h) return false;
  resetWeightEditSession();
  const grid = parseClipboardGrid(rawText);
  if (highlightedHasWeightTargets(h)) return applyHighlightedWeightGrid(grid);
  if (highlightedHasUltimateCells(h)) return applyHighlightedUltimateGrid(grid);
  return false;
}

function methodHighlightSessionKey(highlight = normalizedMethodHighlight()) {
  if (!highlight) return "";
  return `${highlight.startCol}:${highlight.startRow}:${highlight.endCol}:${highlight.endRow}`;
}

function resetWeightEditSession() {
  state.weightEditSession = null;
}

function applyHighlightedWeightKey(key) {
  const h = normalizedMethodHighlight();
  if (!h || !/^[0-9.]$/.test(key || "")) return false;
  const sessionKey = methodHighlightSessionKey(h);
  const current = state.weightEditSession?.key === sessionKey ? state.weightEditSession.value : "";
  if (key === "." && current.includes(".")) return false;
  const nextValue = current
    ? `${current}${key}`
    : key === "."
      ? "0."
      : key;
  state.weightEditSession = { key: sessionKey, value: nextValue };
  if (highlightedHasWeightTargets(h)) {
    if (applyHighlightedWeightValue(nextValue)) return true;
  } else if (highlightedHasUltimateCells(h)) {
    if (applyHighlightedUltimateValue(nextValue)) return true;
  }
  resetWeightEditSession();
  return false;
}

function normalizedMethodHighlight() {
  const h = state.methodHighlight;
  if (!h) return null;
  return {
    startRow: Math.min(h.startRow, h.endRow),
    endRow: Math.max(h.startRow, h.endRow),
    startCol: Math.min(h.startCol, h.endCol),
    endCol: Math.max(h.startCol, h.endCol),
  };
}

function isMethodCellHighlighted(colIndex, rowIndex) {
  const h = normalizedMethodHighlight();
  return !!h
    && rowIndex >= h.startRow
    && rowIndex <= h.endRow
    && colIndex >= h.startCol
    && colIndex <= h.endCol;
}

function isMethodColumnHighlighted(colIndex) {
  const h = normalizedMethodHighlight();
  return !!h && colIndex >= h.startCol && colIndex <= h.endCol;
}

function isMethodRowHighlightedByRange(rowIndex) {
  const h = normalizedMethodHighlight();
  return !!h && rowIndex >= h.startRow && rowIndex <= h.endRow;
}

function isMethodHighlightAnchor(colIndex, rowIndex) {
  const h = state.methodHighlight;
  return !!h && h.startCol === colIndex && h.startRow === rowIndex;
}

function setMethodHighlight(startCol, startRow, endCol = startCol, endRow = startRow) {
  resetWeightEditSession();
  state.methodHighlight = { startCol, startRow, endCol, endRow };
  applyMethodHighlightDom();
}

function removeMethodHighlights() {
  resetWeightEditSession();
  state.methodHighlight = null;
  applyMethodHighlightDom();
}

function normalizeMethodHighlight(columns = buildMethodColumns(getDetails()), rowCount = getRowCount()) {
  const h = state.methodHighlight;
  if (!h) return;
  const maxCol = Math.max(0, columns.length - 1);
  const maxRow = Math.max(0, rowCount - 1);
  const next = {
    startCol: Math.max(0, Math.min(maxCol, h.startCol)),
    startRow: Math.max(0, Math.min(maxRow, h.startRow)),
    endCol: Math.max(0, Math.min(maxCol, h.endCol)),
    endRow: Math.max(0, Math.min(maxRow, h.endRow)),
  };
  const changed = h.startCol !== next.startCol
    || h.startRow !== next.startRow
    || h.endCol !== next.endCol
    || h.endRow !== next.endRow;
  if (changed) {
    resetWeightEditSession();
    state.methodHighlight = next;
  }
}

function setMethodRowHighlight(rowIndex, columnCount) {
  setMethodHighlight(0, rowIndex, Math.max(0, columnCount - 1), rowIndex);
}

function applyMethodHighlightDom() {
  for (const th of els.methodGrid?.querySelectorAll?.("thead th[data-col-index]") || []) {
    const colIndex = Number.parseInt(th.dataset.colIndex || "", 10);
    th.classList.toggle("rsHighlightedColumnLabel", isMethodColumnHighlighted(colIndex));
  }
  for (const td of els.methodGrid?.querySelectorAll?.(".rsMethodCell") || []) {
    const colIndex = Number.parseInt(td.dataset.colIndex || "", 10);
    const rowIndex = Number.parseInt(td.dataset.rowIndex || "", 10);
    const highlighted = isMethodCellHighlighted(colIndex, rowIndex);
    td.classList.toggle("rsHighlightedCell", highlighted);
    td.classList.toggle("rsHighlightAnchorCell", highlighted && isMethodHighlightAnchor(colIndex, rowIndex));
    td.classList.toggle("rsHighlightedRowLabel", td.classList.contains("rsOriginCell") && isMethodRowHighlightedByRange(rowIndex));
    td.classList.toggle("rsHighlightedUltimateCell", highlighted && td.dataset.cellType === "ultimate");
  }
}

function startMethodCellHighlight(event, colIndex, rowIndex, options = {}) {
  if (event.button !== 0) return;
  if (!options.preserveDefault) event.preventDefault();
  closeCellContextMenu();
  state.methodHighlightDragging = true;
  setMethodHighlight(colIndex, rowIndex);
  focusMethodGrid();
  const onUp = () => {
    state.methodHighlightDragging = false;
    document.removeEventListener("mouseup", onUp, true);
  };
  document.addEventListener("mouseup", onUp, true);
}

function extendMethodCellHighlight(colIndex, rowIndex) {
  if (!state.methodHighlightDragging || !state.methodHighlight) return;
  resetWeightEditSession();
  state.methodHighlight.endCol = colIndex;
  state.methodHighlight.endRow = rowIndex;
  applyMethodHighlightDom();
}

function selectedUltimateAt(rowIndex) {
  if (isUltimateOverridden(rowIndex)) return numberOrNull(state.ultimateOverrides[rowIndex]);
  return calculatedSelectedUltimateAt(rowIndex);
}

function effectiveWeightAt(sourceIndex, rowIndex) {
  const target = state.sources[sourceIndex];
  const targetValue = numberOrNull(target?.values?.[rowIndex]);
  if (targetValue === null) return null;
  const targetWeight = Math.max(0, numberOrNull(target?.weights?.[rowIndex]) ?? 0);
  let denominator = 0;
  for (let idx = 0; idx < state.sources.length; idx += 1) {
    const source = state.sources[idx];
    const value = numberOrNull(source.values[rowIndex]);
    const weight = Math.max(0, numberOrNull(source.weights[rowIndex]) ?? 0);
    if (value === null || weight <= 0 || !isSourceCellSelected(idx, rowIndex)) continue;
    denominator += weight;
  }
  if (denominator <= 0) return 0;
  return targetWeight > 0 && isSourceCellSelected(sourceIndex, rowIndex) ? targetWeight / denominator : 0;
}

function selectedUltimateVector() {
  const count = getRowCount();
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(selectedUltimateAt(i));
  return out;
}

function fmtNumber(value) {
  const n = numberOrNull(value);
  if (n === null) return "";
  return Math.round(n).toLocaleString();
}

function fmtRatio(value) {
  const n = numberOrNull(value);
  if (n === null) return "";
  const decimals = getDetails().statisticDecimalPlaces;
  if (getDetails().showRatiosAsPercentages) return `${(n * 100).toFixed(decimals)}%`;
  return n.toFixed(decimals);
}

function fmtEffectiveWeight(value, details = getDetails()) {
  const n = numberOrNull(value);
  if (n === null) return "";
  return `${(n * 100).toFixed(details.statisticDecimalPlaces)}%`;
}

function fmtWeightValue(value) {
  const n = numberOrNull(value);
  if (n === null) return "0.0";
  return n.toFixed(1);
}

function applyWeightValueClass(cell, value) {
  const n = numberOrNull(value) ?? 0;
  cell?.classList.toggle("rsWeightZero", n === 0);
  cell?.classList.toggle("rsWeightNonZero", n !== 0);
}

function methodColumnId(type, index = "") {
  return index === "" ? type : `${type}:${index}`;
}

function sourceMethodSection(source) {
  return norm(source?.dataFormat) === "triangle" ? "triangle" : "vector";
}

function sourceMethodSectionOrder(section) {
  return section === "triangle" ? 0 : 1;
}

function orderedSourceEntries() {
  return state.sources
    .map((source, index) => ({ source, index, section: sourceMethodSection(source) }))
    .sort((left, right) => {
      const sectionDelta = sourceMethodSectionOrder(left.section) - sourceMethodSectionOrder(right.section);
      if (sectionDelta) return sectionDelta;
      const nameDelta = compareSourceNames(left.source, right.source);
      return nameDelta || left.index - right.index;
    });
}

function appendSourceColumns(columns, entries, details, section) {
  entries.forEach(({ source, index }) => {
    columns.push({
      id: methodColumnId("source", index),
      type: "source",
      section,
      sourceIndex: index,
      label: source.name || `Source ${index + 1}`,
      className: "rsSourceHeader",
    });
    if (details.showWeights) {
      columns.push({
        id: methodColumnId("weight", index),
        type: "weight",
        section,
        sourceIndex: index,
        label: state.showEffectiveWeights ? "Weight %" : "Weight",
        className: "rsWeightHeader",
      });
    }
  });
}

function appendMethodSectionSpacer(columns, id) {
  columns.push({
    id: methodColumnId("spacer", id),
    type: "spacer",
    section: "spacer",
    label: "",
    className: "rsSectionSpacerHeader",
  });
}

function buildMethodColumns(details) {
  const columns = [{
    id: methodColumnId("origin"),
    type: "origin",
    section: "origin",
    label: getDatasetOriginLabelText(details.originLength),
    className: "rsOriginHeader",
  }];
  const entries = orderedSourceEntries();
  const triangleEntries = entries.filter((entry) => entry.section === "triangle");
  const vectorEntries = entries.filter((entry) => entry.section === "vector");
  appendSourceColumns(columns, triangleEntries, details, "triangle");
  if (triangleEntries.length && vectorEntries.length) appendMethodSectionSpacer(columns, "triangle-vector");
  appendSourceColumns(columns, vectorEntries, details, "vector");
  if (triangleEntries.length || vectorEntries.length) appendMethodSectionSpacer(columns, "sources-stats");
  columns.push({
    id: methodColumnId("ultimate"),
    type: "ultimate",
    section: "stats",
    label: "Selected Ultimate",
    className: "rsUltimateHeader",
  });
  if (details.ratioBasis) {
    columns.push({
      id: methodColumnId("ratio"),
      type: "ratio",
      section: "stats",
      label: "Ultimate / Basis",
      className: "rsRatioHeader",
    });
  }
  return columns;
}

function getMethodColumnWidth(column) {
  const saved = Number(state.methodColumnWidths[column.id]);
  if (Number.isFinite(saved) && saved > 0) return saved;
  return METHOD_COL_DEFAULT_WIDTHS[column.type] || METHOD_COL_DEFAULT_WIDTHS.source;
}

function clampMethodColumnWidth(column, width) {
  const min = METHOD_COL_MIN_WIDTHS[column.type] || 40;
  const n = Number(width);
  if (!Number.isFinite(n)) return getMethodColumnWidth(column);
  return Math.max(min, Math.min(METHOD_COL_MAX_WIDTH, Math.round(n)));
}

function buildMethodColGroup(columns) {
  const colgroup = document.createElement("colgroup");
  columns.forEach((column) => {
    const col = document.createElement("col");
    col.dataset.colId = column.id;
    col.className = `rsCol rs${column.type[0].toUpperCase()}${column.type.slice(1)}Col`;
    col.style.width = `${getMethodColumnWidth(column)}px`;
    colgroup.appendChild(col);
  });
  return colgroup;
}

function getMethodTableTotalWidth(columns) {
  const sourceColumns = Array.isArray(columns) ? columns : buildMethodColumns(getDetails());
  return sourceColumns.reduce((sum, column) => sum + getMethodColumnWidth(column), 0);
}

function syncMethodTableTotalWidth(columns) {
  if (!els.methodGrid) return;
  const width = Math.max(1, Math.round(getMethodTableTotalWidth(columns)));
  els.methodGrid.style.width = `${width}px`;
  els.methodGrid.style.minWidth = `${width}px`;
}

function applyMethodColumnWidth(column, width) {
  const next = clampMethodColumnWidth(column, width);
  state.methodColumnWidths[column.id] = next;
  const col = Array.from(els.methodGrid?.querySelectorAll?.("col[data-col-id]") || [])
    .find((item) => item.dataset.colId === column.id);
  if (col) col.style.width = `${next}px`;
  syncMethodTableTotalWidth();
}

function startMethodColumnResize(event, column) {
  event.preventDefault();
  event.stopPropagation();
  const startX = event.clientX;
  const header = event.currentTarget?.closest?.("th");
  const startWidth = Math.round(header?.getBoundingClientRect?.().width || getMethodColumnWidth(column));
  document.body.classList.add("rsResizingColumns");
  const onMove = (moveEvent) => {
    applyMethodColumnWidth(column, startWidth + (moveEvent.clientX - startX));
  };
  const onUp = () => {
    document.body.classList.remove("rsResizingColumns");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function syncToggleWeightsDisplayControl(details = getDetails()) {
  if (!els.toggleWeightsDisplayBtn) return;
  els.toggleWeightsDisplayBtn.disabled = !details.showWeights;
  els.toggleWeightsDisplayBtn.setAttribute("aria-pressed", state.showEffectiveWeights ? "true" : "false");
  els.toggleWeightsDisplayBtn.title = state.showEffectiveWeights
    ? "Showing read-only effective row weights"
    : "Showing editable numeric weights";
}

function focusMethodGrid() {
  if (!els.methodGrid) return;
  try {
    els.methodGrid.focus({ preventScroll: true });
  } catch {
    els.methodGrid.focus?.();
  }
}

function wireMethodCell(td, column, colIndex, rowIndex, copyValue = "", options = {}) {
  td.classList.add("rsMethodCell");
  td.dataset.colIndex = String(colIndex);
  td.dataset.rowIndex = String(rowIndex);
  td.dataset.cellType = column.type;
  td.dataset.copyValue = String(copyValue ?? "");
  td.classList.toggle("rsHighlightedCell", isMethodCellHighlighted(colIndex, rowIndex));
  td.classList.toggle("rsHighlightAnchorCell", isMethodHighlightAnchor(colIndex, rowIndex));
  td.classList.toggle("rsHighlightedRowLabel", column.type === "origin" && isMethodRowHighlightedByRange(rowIndex));
  td.classList.toggle("rsHighlightedUltimateCell", isMethodCellHighlighted(colIndex, rowIndex) && column.type === "ultimate");
  if (options.rowToggleColumnCount) {
    td.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeCellContextMenu();
      setMethodRowHighlight(rowIndex, options.rowToggleColumnCount);
      focusMethodGrid();
    });
  } else {
    td.addEventListener("mousedown", (event) => {
      if (event.target?.closest?.("button")) return;
      if (event.target?.closest?.("input") && !options.allowInputSelection) return;
      startMethodCellHighlight(event, colIndex, rowIndex, {
        preserveDefault: options.preserveInputDefault && !!event.target?.closest?.("input"),
      });
    });
    td.addEventListener("mouseenter", () => extendMethodCellHighlight(colIndex, rowIndex));
  }
  td.addEventListener("contextmenu", (event) => openCellContextMenu(event, colIndex, rowIndex));
  return td;
}

function renderMethodGrid() {
  const grid = els.methodGrid;
  if (!grid) return;
  grid.tabIndex = -1;
  syncOriginLengthOptions();
  const details = getDetails();
  const count = getRowCount();
  const hasBasis = !!details.ratioBasis;
  const columns = buildMethodColumns(details);
  normalizeMethodHighlight(columns, count + 1);
  syncToggleWeightsDisplayControl(details);
  els.ratioBasisStatus.textContent = hasBasis ? `Basis: ${details.ratioBasis}` : "Basis: None";
  syncMethodTableTotalWidth(columns);
  const colgroup = buildMethodColGroup(columns);
  const thead = document.createElement("thead");
  const hrow = document.createElement("tr");
  hrow.className = "rsColumnHeaderRow";
  columns.forEach((column, colIndex) => {
    const th = headerCell(column.label, column);
    th.className = column.className || "";
    if (column.type !== "spacer") {
      th.dataset.colIndex = String(colIndex);
      th.classList.toggle("rsHighlightedColumnLabel", isMethodColumnHighlighted(colIndex));
    }
    if (column.type === "source") {
      th.addEventListener("contextmenu", (event) => openSourceContextMenu(event, column.sourceIndex));
    }
    hrow.appendChild(th);
  });
  thead.appendChild(hrow);

  const tbody = document.createElement("tbody");
  const totals = {
    source: new Array(state.sources.length).fill(0),
    ultimate: 0,
    basis: 0,
  };
  for (let r = 0; r < count; r += 1) {
    const tr = document.createElement("tr");
    let rowUltimateValue = null;
    columns.forEach((column, colIndex) => {
      if (column.type === "origin") {
        const label = originLabel(r);
        tr.appendChild(wireMethodCell(
          bodyCell(label, "rsOriginCell"),
          column,
          colIndex,
          r,
          label,
          { rowToggleColumnCount: columns.length }
        ));
      } else if (column.type === "source") {
        const source = state.sources[column.sourceIndex];
        const value = numberOrNull(source?.values?.[r]);
        if (value !== null) totals.source[column.sourceIndex] += value;
        const td = bodyCell(fmtNumber(value), "rsSourceCell");
        td.dataset.sourceIndex = String(column.sourceIndex);
        td.classList.toggle("rsSelectedSourceCell", isSourceCellSelected(column.sourceIndex, r));
        td.addEventListener("dblclick", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!isSourceCellSelectable(column.sourceIndex, r)) return;
          const nextWeight = isSourceCellSelected(column.sourceIndex, r) ? 0 : 1;
          setWeightValue(column.sourceIndex, r, nextWeight);
          markDirty();
          renderMethodGrid();
        });
        tr.appendChild(wireMethodCell(td, column, colIndex, r, value === null ? "" : String(value)));
      } else if (column.type === "weight") {
        const source = state.sources[column.sourceIndex];
        const td = document.createElement("td");
        td.className = "rsWeightCell";
        let copyValue = "";
        if (state.showEffectiveWeights) {
          const weightValue = effectiveWeightAt(column.sourceIndex, r);
          const pct = document.createElement("span");
          pct.className = "rsWeightPercent";
          pct.textContent = fmtEffectiveWeight(weightValue, details);
          pct.title = "Read-only effective row weight";
          copyValue = pct.textContent;
          applyWeightValueClass(td, weightValue);
          td.appendChild(pct);
        } else {
          const weightValue = Math.max(0, numberOrNull(source?.weights?.[r]) ?? 0);
          applyWeightValueClass(td, weightValue);
          td.addEventListener("dblclick", (event) => {
            event.preventDefault();
            event.stopPropagation();
            setWeightValue(column.sourceIndex, r, weightValue === 0 ? 1 : 0);
            markDirty();
            renderMethodGrid();
          });
          const input = document.createElement("input");
          input.className = "rsWeightInput";
          input.type = "number";
          input.min = "0";
          input.step = "any";
          input.value = fmtWeightValue(weightValue);
          copyValue = fmtWeightValue(weightValue);
          input.addEventListener("input", () => {
            const nextWeight = setWeightValue(column.sourceIndex, r, input.value);
            applyWeightValueClass(td, nextWeight);
            td.dataset.copyValue = fmtWeightValue(nextWeight);
            markDirty();
          });
          input.addEventListener("paste", (event) => {
            const data = event.clipboardData?.getData("text/plain") || "";
            if (!data.includes("\t") && !data.includes("\n") && !data.includes("\r")) return;
            event.preventDefault();
            if (applyWeightPaste(column.sourceIndex, r, data)) {
              markDirty();
              renderMethodGrid();
            }
          });
          input.addEventListener("change", () => {
            renderMethodGrid();
          });
          td.appendChild(input);
        }
        tr.appendChild(wireMethodCell(td, column, colIndex, r, copyValue, { allowInputSelection: true }));
      } else if (column.type === "ultimate") {
        rowUltimateValue = selectedUltimateAt(r);
        if (rowUltimateValue !== null) totals.ultimate += rowUltimateValue;
        const ucell = bodyCell(fmtNumber(rowUltimateValue));
        ucell.className = "rsUltimateCell";
        ucell.classList.toggle("rsUltimateCustomValue", isUltimateOverridden(r));
        tr.appendChild(wireMethodCell(ucell, column, colIndex, r, rowUltimateValue === null ? "" : String(rowUltimateValue)));
      } else if (column.type === "ratio") {
        const basis = numberOrNull(state.ratioBasisValues[r]);
        if (basis !== null) totals.basis += basis;
        const ratioValue = basis && rowUltimateValue !== null ? rowUltimateValue / basis : null;
        const rcell = bodyCell(fmtRatio(ratioValue));
        rcell.className = "rsRatioCell";
        tr.appendChild(wireMethodCell(rcell, column, colIndex, r, fmtRatio(ratioValue)));
      } else if (column.type === "spacer") {
        tr.appendChild(bodyCell("", "rsSectionSpacerCell"));
      }
    });
    tbody.appendChild(tr);
  }
  const totalRow = document.createElement("tr");
  totalRow.className = "rsTotalRow";
  const totalRowIndex = count;
  columns.forEach((column, colIndex) => {
    if (column.type === "origin") {
      totalRow.appendChild(wireMethodCell(
        bodyCell("Total", "rsOriginCell"),
        column,
        colIndex,
        totalRowIndex,
        "Total",
        { rowToggleColumnCount: columns.length }
      ));
    } else if (column.type === "source") {
      const totalValue = fmtNumber(totals.source[column.sourceIndex]);
      totalRow.appendChild(wireMethodCell(
        bodyCell(totalValue, "rsSourceCell"),
        column,
        colIndex,
        totalRowIndex,
        totalValue
      ));
    } else if (column.type === "weight") {
      totalRow.appendChild(wireMethodCell(
        bodyCell("", "rsWeightCell"),
        column,
        colIndex,
        totalRowIndex,
        ""
      ));
    } else if (column.type === "ultimate") {
      const totalUltimateValue = fmtNumber(totals.ultimate);
      const totalUltimate = bodyCell(totalUltimateValue);
      totalUltimate.className = "rsUltimateCell";
      totalRow.appendChild(wireMethodCell(totalUltimate, column, colIndex, totalRowIndex, totalUltimateValue));
    } else if (column.type === "ratio") {
      const ratio = totals.basis > 0 ? totals.ultimate / totals.basis : null;
      const ratioValue = fmtRatio(ratio);
      const ratioCell = bodyCell(ratioValue);
      ratioCell.className = "rsRatioCell";
      totalRow.appendChild(wireMethodCell(ratioCell, column, colIndex, totalRowIndex, ratioValue));
    } else if (column.type === "spacer") {
      totalRow.appendChild(bodyCell("", "rsSectionSpacerCell"));
    }
  });
  tbody.appendChild(totalRow);
  grid.replaceChildren(colgroup, thead, tbody);
}

function headerCell(label, column = null) {
  const th = document.createElement("th");
  const textSpan = document.createElement("span");
  textSpan.className = "rsHeaderText";
  textSpan.textContent = String(label || "");
  th.appendChild(textSpan);
  if (column && column.type !== "spacer") {
    th.dataset.colId = column.id;
    const handle = document.createElement("span");
    handle.className = "rsColumnResizeHandle";
    handle.title = "Drag to resize column";
    handle.addEventListener("mousedown", (event) => startMethodColumnResize(event, column));
    th.appendChild(handle);
  }
  return th;
}

function bodyCell(label, className = "") {
  const td = document.createElement("td");
  td.textContent = String(label ?? "");
  if (className) td.className = className;
  return td;
}

function closeCellContextMenu() {
  if (!els.cellContextMenu) return;
  els.cellContextMenu.classList.remove("open");
  els.cellContextMenu.setAttribute("aria-hidden", "true");
}

function closeSourceContextMenu() {
  if (!els.sourceContextMenu) return;
  els.sourceContextMenu.classList.remove("open");
  els.sourceContextMenu.setAttribute("aria-hidden", "true");
  delete els.sourceContextMenu.dataset.sourceIndex;
  delete els.sourceContextMenu.dataset.anchorLeft;
  delete els.sourceContextMenu.dataset.anchorTop;
}

function positionContextMenu(menu, x, y) {
  if (!menu) return;
  const pad = 8;
  menu.style.maxWidth = `${Math.max(120, window.innerWidth - (pad * 2))}px`;
  const rect = menu.getBoundingClientRect();
  const left = Math.max(pad, Math.min(x, window.innerWidth - rect.width - pad));
  const top = Math.max(pad, Math.min(y, window.innerHeight - rect.height - pad));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function openCellContextMenu(event, colIndex, rowIndex) {
  event.preventDefault();
  event.stopPropagation();
  closeSourceContextMenu();
  if (!isMethodCellHighlighted(colIndex, rowIndex)) {
    setMethodHighlight(colIndex, rowIndex);
  }
  const menu = els.cellContextMenu;
  if (!menu) return;
  setUltimateContextMenuVisibility();
  menu.classList.add("open");
  menu.setAttribute("aria-hidden", "false");
  positionContextMenu(menu, event.clientX, event.clientY);
}

function openSourceContextMenu(event, sourceIndex) {
  event.preventDefault();
  event.stopPropagation();
  closeCellContextMenu();
  closePicker();
  const menu = els.sourceContextMenu;
  if (!menu || !state.sources[sourceIndex]) return;
  menu.dataset.sourceIndex = String(sourceIndex);
  menu.dataset.anchorLeft = String(event.clientX);
  menu.dataset.anchorTop = String(event.clientY);
  menu.classList.add("open");
  menu.setAttribute("aria-hidden", "false");
  positionContextMenu(menu, event.clientX, event.clientY);
}

function sourceContextIndex() {
  const n = Number.parseInt(els.sourceContextMenu?.dataset?.sourceIndex || "", 10);
  return Number.isInteger(n) && n >= 0 && n < state.sources.length ? n : -1;
}

function sourceRecordForIndex(sourceIndex) {
  const source = state.sources[sourceIndex];
  if (!source) return null;
  return cachedRows.find((row) => norm(row.name) === norm(source.name)) || null;
}

function viewOrEditSourceDataset(sourceIndex) {
  const source = state.sources[sourceIndex];
  if (!source?.name) return;
  const record = sourceRecordForIndex(sourceIndex);
  const requestId = `rs_open_source_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const onMessage = (event) => {
    const msg = event.data || {};
    if (msg.type !== "arcrho:automation-command-result" || msg.requestId !== requestId) return;
    window.removeEventListener("message", onMessage);
    if (msg.ok === false) postStatus(`Open source dataset failed: ${msg.error || "Unknown error."}`, "error");
  };
  window.addEventListener("message", onMessage);
  window.setTimeout(() => window.removeEventListener("message", onMessage), 10000);
  try {
    window.parent?.postMessage({
      type: "arcrho:automation-open-dataset",
      requestId,
      args: {
        datasetName: source.name,
        datasetTypeName: text(source.datasetType || record?.datasetTypeName || record?.datasetType || source.name),
        methodType: text(source.methodType || record?.methodType),
        readOnly: !!record?.generated,
        generated: !!record?.generated,
      },
    }, "*");
  } catch (err) {
    window.removeEventListener("message", onMessage);
    postStatus(`Open source dataset failed: ${err?.message || err}`, "error");
  }
}

function removeSourceAt(sourceIndex) {
  if (sourceIndex < 0 || sourceIndex >= state.sources.length) return;
  state.sources.splice(sourceIndex, 1);
  markDirty();
  renderMethodGrid();
}

function methodCellCopyValue(colIndex, rowIndex) {
  const cell = Array.from(els.methodGrid?.querySelectorAll?.(".rsMethodCell") || [])
    .find((td) => Number(td.dataset.colIndex) === colIndex && Number(td.dataset.rowIndex) === rowIndex);
  return cell?.dataset?.copyValue ?? "";
}

function highlightedMethodValuesText() {
  const h = normalizedMethodHighlight();
  if (!h) return "";
  const rows = [];
  for (let r = h.startRow; r <= h.endRow; r += 1) {
    const cells = [];
    for (let colIndex = h.startCol; colIndex <= h.endCol; colIndex += 1) {
      cells.push(methodCellCopyValue(colIndex, r));
    }
    rows.push(cells.join("\t"));
  }
  return rows.join("\r\n");
}

async function writeClipboardText(value) {
  const data = String(value || "");
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(data);
    return;
  }
  const area = document.createElement("textarea");
  area.value = data;
  area.setAttribute("readonly", "true");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

async function readClipboardText() {
  if (!navigator.clipboard?.readText) throw new Error("Clipboard paste is not available in this browser.");
  return navigator.clipboard.readText();
}

async function copyHighlightedMethodValues() {
  const data = highlightedMethodValuesText();
  if (!data) return;
  await writeClipboardText(data);
  closeCellContextMenu();
  postStatus("Copied selected Result Selection values.");
}

async function pasteHighlightedMethodValues() {
  const data = await readClipboardText();
  if (!data) return;
  if (!applyHighlightedPasteText(data)) return;
  markDirty();
  closeCellContextMenu();
  renderMethodGrid();
  postStatus("Pasted Result Selection values.");
}

function normalizeUltimateOverrides(rawOverrides, count = getRowCount()) {
  const overrides = [];
  if (Array.isArray(rawOverrides)) {
    rawOverrides.forEach((value, index) => {
      if (index >= count) return;
      const n = numberOrNull(value);
      if (n !== null) overrides[index] = n;
    });
  } else if (rawOverrides && typeof rawOverrides === "object") {
    Object.entries(rawOverrides).forEach(([key, value]) => {
      const index = Number.parseInt(key, 10);
      const n = numberOrNull(value);
      if (Number.isInteger(index) && index >= 0 && index < count && n !== null) overrides[index] = n;
    });
  }
  return overrides;
}

function serializedUltimateOverrides() {
  const count = getRowCount();
  return Array.from({ length: count }, (_, index) => (
    isUltimateOverridden(index) ? numberOrNull(state.ultimateOverrides[index]) : null
  ));
}

function setUltimateContextMenuVisibility() {
  const showUltimateActions = highlightedHasUltimateCells();
  els.cellContextMenu?.querySelectorAll?.("[data-rs-ultimate-action]").forEach((button) => {
    button.hidden = !showUltimateActions;
  });
}

function revertHighlightedUltimateValues() {
  const h = normalizedMethodHighlight();
  if (!h) return false;
  const columns = buildMethodColumns(getDetails());
  let changed = false;
  for (let rowIndex = h.startRow; rowIndex <= h.endRow; rowIndex += 1) {
    for (let colIndex = h.startCol; colIndex <= h.endCol; colIndex += 1) {
      if (columns[colIndex]?.type === "ultimate" && clearUltimateOverride(rowIndex)) changed = true;
    }
  }
  return changed;
}

function revertAllUltimateValues() {
  const changed = state.ultimateOverrides.some((value, index) => isUltimateOverridden(index));
  state.ultimateOverrides = [];
  return changed;
}

function buildPayload() {
  const details = getDetails();
  return {
    json_format: RS_JSON_FORMAT,
    details_tab: {
      name: details.name,
      output_type: details.outputType,
      origin_length: details.originLength,
      ratio_basis: details.ratioBasis,
      show_ratios_as_percentages: details.showRatiosAsPercentages,
      statistic_decimal_places: details.statisticDecimalPlaces,
    },
    method_tab: {
      origin_labels: Array.from({ length: getRowCount() }, (_, i) => originLabel(i)),
      show_weights: details.showWeights,
      sources: state.sources.map((source) => ({
        name: source.name,
        dataset_type: source.datasetType,
        data_format: source.dataFormat,
        origin_length: source.originLength || null,
        method_type: source.methodType,
        category: source.category,
        value_source: source.valueSource,
        values: source.values,
        weights: source.weights,
        selected: ensureSourceSelection(source).slice(),
      })),
      selected_ultimate: selectedUltimateVector(),
      ultimate_overrides: serializedUltimateOverrides(),
      ratio_basis_values: state.ratioBasisValues,
    },
    results_tab: {},
    validation_tab: {},
    notes_tab: {
      notes: els.notesInput?.value || "",
    },
    method_metadata: {
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
    if (state.sidecarOriginLength) els.originLengthInput.value = String(state.sidecarOriginLength);
    els.ratioBasisInput.value = text(details.ratio_basis || "");
    els.showRatiosPctInput.checked = details.show_ratios_as_percentages !== false;
    els.statisticDecimalsInput.value = String(Math.max(0, Math.min(8, nonNegativeInt(details.statistic_decimal_places, 1))));
    els.showWeightsInput.checked = method.show_weights !== false;
    setNotesText(text(data.notes_tab?.notes));
  });
  const sources = [];
  for (const source of Array.isArray(method.sources) ? method.sources : []) {
    const record = cachedRows.find((row) => norm(row.name) === norm(source.name)) || null;
    const built = await buildSourceFromRecord(record || { name: source.name }, source);
    if (built) sources.push(built);
  }
  state.sources = sources;
  syncOriginLengthOptions();
  if (text(els.ratioBasisInput.value)) await refreshRatioBasisValues();
  const methodOriginLabels = Array.isArray(method.origin_labels) ? method.origin_labels.map(String) : [];
  if (methodOriginLabels.length && !shouldRejectOriginLabels(getDetails().originLength, methodOriginLabels)) {
    setOriginLabels(methodOriginLabels, getDetails().originLength);
  } else if (state.sidecarOriginLabels.length && !shouldRejectOriginLabels(getDetails().originLength, state.sidecarOriginLabels)) {
    setOriginLabels(state.sidecarOriginLabels, getDetails().originLength);
  } else {
    await refreshOriginLabels({ render: false });
  }
  state.ultimateOverrides = normalizeUltimateOverrides(method.ultimate_overrides, getRowCount());
  renderMethodGrid();
}

function snapshotPayload() {
  return JSON.stringify(buildPayload());
}

function markClean() {
  cleanSnapshot = snapshotPayload();
  lastSavedNotesText = els.notesInput?.value || "";
  postDirty(false, true);
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

async function getMethodsDir() {
  const cfg = await getWorkspacePathsConfig();
  const projectsRoot = isAbsolutePath(cfg.projectsDir) ? cfg.projectsDir : joinPath(cfg.root, cfg.projectsDir);
  return joinPath(
    projectsRoot,
    sanitizeFileNamePart(state.project, "UnknownProject"),
    "data",
    sanitizeDataFolderPart(state.reservingClass, "ReservingClass"),
    "methods",
  );
}

async function getDatasetDir() {
  const cfg = await getWorkspacePathsConfig();
  const projectsRoot = isAbsolutePath(cfg.projectsDir) ? cfg.projectsDir : joinPath(cfg.root, cfg.projectsDir);
  return joinPath(
    projectsRoot,
    sanitizeFileNamePart(state.project, "UnknownProject"),
    "data",
    sanitizeDataFolderPart(state.reservingClass, "ReservingClass"),
    "datasets",
  );
}

function getMethodFilename() {
  const name = getDetails().name || "Result Selection";
  const rc = sanitizeDataFolderPart(state.reservingClass, "ReservingClass");
  return `RS@${rc}@${sanitizeFileNamePart(name, "Name")}.json`;
}

async function getMethodPath() {
  return `${await getMethodsDir()}\\${getMethodFilename()}`;
}

function getCsvFilename() {
  const details = getDetails();
  const origin = validOriginLength(details.originLength);
  return `${sanitizeFileNamePart(details.name || "Result Selection", "Dataset")}@${origin}@${origin}@cum@dev.csv`;
}

async function getCsvPath() {
  return `${await getDatasetDir()}\\${getCsvFilename()}`;
}

function vectorCsv(values) {
  return `${(Array.isArray(values) ? values : []).map((v) => v == null ? "" : String(v)).join("\n")}\n`;
}

function getSourcePrecedentNames() {
  const seen = new Set();
  const out = [];
  for (const source of state.sources || []) {
    const name = text(source?.name);
    const key = norm(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
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
      source_kind: "result_selection",
      method_type: "Result Selection",
      status: 0,
      data_format: "Vector",
      origin_length: details.originLength,
      development_length: details.originLength,
      cumulative: true,
      transposed: false,
      calendar: false,
      origin_labels: Array.isArray(originLabels) ? originLabels.map(String) : [],
      csv_file: csvPath.split(/[\\/]/).pop(),
      precedents: getSourcePrecedentNames(),
    }),
  });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok || payload?.ok === false) throw new Error(payload?.detail || payload?.error || `Sidecar save failed (${resp.status}).`);
  return payload;
}

async function saveResultSelection() {
  const details = getDetails();
  if (!details.name || !details.outputType) {
    postStatus("Result Selection save requires Name and Output Type.", "error");
    return { ok: false };
  }
  const hostApi = getHostApi();
  if (!hostApi?.saveJsonFile || !hostApi?.saveTextFile) {
    postStatus("Result Selection save requires the desktop app.", "error");
    return { ok: false };
  }
  await refreshOriginLabels({ render: false });
  const payload = buildPayload();
  const methodPath = await getMethodPath();
  const jsonOut = await hostApi.saveJsonFile({
    path: methodPath,
    suggestedName: getMethodFilename(),
    startDir: await getMethodsDir(),
    data: payload,
  });
  if (!jsonOut?.path || jsonOut?.error) throw new Error(jsonOut?.error || "Method JSON save failed.");
  const vector = payload.method_tab.selected_ultimate || [];
  const csvPath = await getCsvPath();
  const csvOut = await hostApi.saveTextFile({
    path: csvPath,
    data: vectorCsv(vector),
  });
  if (csvOut?.error) throw new Error(csvOut.error);
  await saveSidecar(csvPath, payload.method_tab.origin_labels || []);
  await loadCachedRows(true).catch(() => {});
  markClean();
  try {
    window.parent?.postMessage({ type: "arcrho:project-instance-refresh-datasets" }, "*");
  } catch {}
  postStatus(`Result Selection saved: ${details.name}`);
  return { ok: true, path: jsonOut.path, csvPath };
}

async function tryLoadExistingMethod() {
  const hostApi = getHostApi();
  if (!hostApi?.readJsonFile) return false;
  const path = await getMethodPath();
  const result = await hostApi.readJsonFile({ path });
  if (!result?.exists || !result.data) return false;
  await applyPayload(result.data);
  postStatus(`Loaded Result Selection: ${getDetails().name}`);
  return true;
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
      inputId: "rsNotesInput",
      wrapId: "rsNotesInputWrap",
      decorId: "rsNotesDecor",
      formatToolbarId: "rsNotesFormatToolbar",
    },
    classes: {
      tooltipClass: "rsNotesPathTooltip",
      pathTokenClass: "rsNotesPathToken",
      hoverPathClass: "isHoverPath",
    },
    getNotesProgrammaticInput: () => notesProgrammatic,
    getLastSavedNotesText: () => lastSavedNotesText,
    setNotesDirty: markDirty,
    updateNotesSaveUi: () => {},
    onSaveNotes: async () => ({ ok: true }),
    setStatus: postStatus,
    formatSaveErrorStatus: (result) => `Result Selection notes save failed: ${result?.error || "Unknown error."}`,
  });
}

function closePicker() {
  els.picker.classList.remove("open");
  els.picker.setAttribute("aria-hidden", "true");
  els.picker.innerHTML = "";
}

function openPicker(anchor, rows, onPick) {
  closePicker();
  const rect = typeof anchor?.getBoundingClientRect === "function"
    ? anchor.getBoundingClientRect()
    : {
        left: Number(anchor?.left) || 8,
        bottom: Number(anchor?.bottom ?? anchor?.top) || 8,
      };
  rows.forEach((row) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = `<span></span><span></span><span></span>`;
    btn.children[0].textContent = row.name || row.label || "";
    btn.children[1].textContent = row.dataFormat || row.type || "";
    btn.children[2].textContent = row.methodType || row.category || "";
    btn.addEventListener("click", () => {
      closePicker();
      onPick(row);
    });
    els.picker.appendChild(btn);
  });
  if (!rows.length) {
    const empty = document.createElement("button");
    empty.type = "button";
    empty.disabled = true;
    empty.textContent = "No items found.";
    els.picker.appendChild(empty);
  }
  els.picker.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 380))}px`;
  els.picker.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 340)}px`;
  els.picker.classList.add("open");
  els.picker.setAttribute("aria-hidden", "false");
}

function openAddSourcePicker(anchor = els.addSourceBtn) {
  const rows = cachedRows.filter((row) => norm(row.name) !== norm(els.nameInput.value));
  openPicker(anchor, rows, (row) => void addSource(row));
}

function compareSourceNames(left, right) {
  return text(left?.name).localeCompare(text(right?.name), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function compareSourceDisplayOrder(left, right) {
  const sectionDelta = sourceMethodSectionOrder(sourceMethodSection(left)) - sourceMethodSectionOrder(sourceMethodSection(right));
  return sectionDelta || compareSourceNames(left, right);
}

function insertSourceAlphabetically(source) {
  const insertAt = state.sources.findIndex((existing) => compareSourceDisplayOrder(existing, source) > 0);
  if (insertAt === -1) state.sources.push(source);
  else state.sources.splice(insertAt, 0, source);
}

async function addSource(record) {
  if (state.sources.some((source) => norm(source.name) === norm(record.name))) return;
  const source = await buildSourceFromRecord(record);
  if (!source) return;
  const count = Math.max(getRowCount(), source.values.length);
  while (source.weights.length < count) source.weights.push(0);
  ensureSourceSelection(source, count);
  insertSourceAlphabetically(source);
  markDirty();
  renderMethodGrid();
}

function defaultSourceRecords() {
  const outputName = text(els.nameInput.value);
  const category = state.outputCategory || datasetTypeItems.find((item) => norm(item.name) === norm(els.outputTypeInput.value))?.category || "";
  return cachedRows.filter((row) => (
    norm(row.methodType) === "dfm"
    && norm(row.dataFormat) === "vector"
    && (!category || norm(row.category) === norm(category))
    && norm(row.name) !== norm(outputName)
  ));
}

async function initializeDefaultSources() {
  const records = defaultSourceRecords();
  const sources = [];
  for (const record of records) {
    const source = await buildSourceFromRecord(record);
    if (source) sources.push(source);
  }
  state.sources = sources;
}

async function refreshRatioBasisValues() {
  const basis = text(els.ratioBasisInput.value);
  if (!basis) {
    state.ratioBasisValues = [];
    renderMethodGrid();
    return;
  }
  try {
    const record = cachedRows.find((row) => norm(row.name) === norm(basis)) || { name: basis };
    const payload = await loadDatasetValues(record.name);
    state.ratioBasisValues = norm(record.dataFormat || payload.data_format) === "triangle"
      ? latestDiagonal(payload.values)
      : vectorValues(payload.values);
  } catch (err) {
    state.ratioBasisValues = [];
    postStatus(`Ratio Basis load failed: ${err?.message || err}`, "error");
  }
  renderMethodGrid();
}

async function restoreCleanState() {
  if (!cleanSnapshot) return;
  const payload = JSON.parse(cleanSnapshot);
  await applyPayload(payload);
  markClean();
}

function wireEvents() {
  els.tabBar?.addEventListener("click", (event) => {
    const btn = event.target?.closest?.(".rsTab");
    if (!btn) return;
    setTab(btn.dataset.page);
  });
  [els.nameInput, els.outputTypeInput, els.originLengthInput, els.showRatiosPctInput, els.statisticDecimalsInput, els.showWeightsInput].forEach((el) => {
    el?.addEventListener("input", () => {
      markDirty();
      if (el === els.originLengthInput) {
        state.sidecarOriginLength = null;
        state.sidecarOriginLabels = [];
        setOriginLabels([], getDetails().originLength);
      }
      renderMethodGrid();
    });
    el?.addEventListener("change", () => {
      markDirty();
      if (el === els.originLengthInput) {
        state.sidecarOriginLength = null;
        state.sidecarOriginLabels = [];
        setOriginLabels([], getDetails().originLength);
        void refreshOriginLabels({ render: true });
        return;
      }
      renderMethodGrid();
    });
  });
  els.toggleWeightsDisplayBtn?.addEventListener("click", () => {
    state.showEffectiveWeights = !state.showEffectiveWeights;
    renderMethodGrid();
  });
  els.cellContextMenu?.addEventListener("click", (event) => {
    const action = event.target?.closest?.("[data-rs-cell-action]")?.dataset?.rsCellAction || "";
    if (action === "copy-values") {
      void copyHighlightedMethodValues().catch((err) => postStatus(`Copy failed: ${err?.message || err}`, "error"));
      closeCellContextMenu();
    } else if (action === "paste-values") {
      void pasteHighlightedMethodValues().catch((err) => postStatus(`Paste failed: ${err?.message || err}`, "error"));
    } else if (action === "remove-highlights") {
      removeMethodHighlights();
      closeCellContextMenu();
    } else if (action === "revert-ultimate") {
      if (revertHighlightedUltimateValues()) {
        markDirty();
        renderMethodGrid();
      }
      closeCellContextMenu();
    } else if (action === "revert-all-ultimate") {
      if (revertAllUltimateValues()) {
        markDirty();
        renderMethodGrid();
      }
      closeCellContextMenu();
    }
  });
  els.sourceContextMenu?.addEventListener("click", (event) => {
    const action = event.target?.closest?.("[data-rs-source-action]")?.dataset?.rsSourceAction || "";
    if (!action) return;
    const sourceIndex = sourceContextIndex();
    const anchor = {
      left: Number(els.sourceContextMenu.dataset.anchorLeft) || 8,
      bottom: Number(els.sourceContextMenu.dataset.anchorTop) || 8,
    };
    closeSourceContextMenu();
    if (action === "view-edit") {
      viewOrEditSourceDataset(sourceIndex);
    } else if (action === "add") {
      openAddSourcePicker(anchor);
    } else if (action === "delete") {
      removeSourceAt(sourceIndex);
    }
  });
  document.addEventListener("mousedown", (event) => {
    if (els.cellContextMenu?.contains(event.target)) return;
    if (els.sourceContextMenu?.contains(event.target)) return;
    closeCellContextMenu();
    closeSourceContextMenu();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      resetWeightEditSession();
      closeCellContextMenu();
      closeSourceContextMenu();
      return;
    }
    if (
      (event.ctrlKey || event.metaKey)
      && event.key?.toLowerCase?.() === "c"
      && normalizedMethodHighlight()
      && !event.target?.closest?.("input,textarea,[contenteditable='true']")
    ) {
      event.preventDefault();
      void copyHighlightedMethodValues().catch((err) => postStatus(`Copy failed: ${err?.message || err}`, "error"));
      return;
    }
    if (
      (event.ctrlKey || event.metaKey)
      && event.key?.toLowerCase?.() === "v"
      && normalizedMethodHighlight()
      && !event.target?.closest?.("input,textarea,[contenteditable='true']")
    ) {
      event.preventDefault();
      void pasteHighlightedMethodValues().catch((err) => postStatus(`Paste failed: ${err?.message || err}`, "error"));
      return;
    }
    if (
      normalizedMethodHighlight()
      && !event.ctrlKey
      && !event.metaKey
      && !event.altKey
      && /^[0-9.]$/.test(event.key || "")
    ) {
      if (event.target?.closest?.("input:not(.rsWeightInput),textarea,[contenteditable='true']")) return;
      if (applyHighlightedWeightKey(event.key)) {
        event.preventDefault();
        markDirty();
        renderMethodGrid();
      }
    }
  });
  els.ratioBasisInput?.addEventListener("change", () => {
    markDirty();
    void refreshRatioBasisValues();
  });
  els.ratioBasisInput?.addEventListener("input", markDirty);
  els.outputTypeBtn?.addEventListener("click", () => {
    const rows = datasetTypeItems
      .filter((item) => norm(item.dataFormat) === "vector")
      .map((item) => ({ name: item.name, type: item.dataFormat, category: item.category }));
    openPicker(els.outputTypeBtn, rows, (row) => {
      els.outputTypeInput.value = row.name;
      state.outputCategory = row.category || state.outputCategory;
      markDirty();
    });
  });
  els.ratioBasisBtn?.addEventListener("click", () => {
    openPicker(els.ratioBasisBtn, cachedRows, (row) => {
      els.ratioBasisInput.value = row.name;
      markDirty();
      void refreshRatioBasisValues();
    });
  });
  els.addSourceBtn?.addEventListener("click", () => {
    openAddSourcePicker(els.addSourceBtn);
  });
  els.saveBtn?.addEventListener("click", () => {
    saveResultSelection().catch((err) => postStatus(`Result Selection save failed: ${err?.message || err}`, "error"));
  });
  els.cancelBtn?.addEventListener("click", async () => {
    if (!isDirty) return;
    const discard = await showCloseConfirm("cancel");
    if (!discard) return;
    restoreCleanState().catch((err) => postStatus(`Result Selection restore failed: ${err?.message || err}`, "error"));
  });
  els.closeConfirmOk?.addEventListener("click", () => resolveCloseConfirm(true));
  els.closeConfirmCancel?.addEventListener("click", () => resolveCloseConfirm(false));
  els.closeConfirmClose?.addEventListener("click", () => resolveCloseConfirm(false));
  els.closeConfirmBox?.addEventListener("mousedown", startCloseConfirmDrag);
  els.closeConfirmOverlay?.addEventListener("mousedown", (event) => {
    if (event.target === event.currentTarget) resolveCloseConfirm(false);
  });
  els.closeConfirmOverlay?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      resolveCloseConfirm(false);
    }
  });
  document.addEventListener("mousedown", (event) => {
    if (
      !els.picker.contains(event.target)
      && !els.sourceContextMenu?.contains(event.target)
      && !event.target?.closest?.(".rsButton")
    ) closePicker();
  });
  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "arcrho:dataset-save" || msg.type === "arcrho:result-selection-save") {
      saveResultSelection().catch((err) => postStatus(`Result Selection save failed: ${err?.message || err}`, "error"));
    }
  });
  window.__arcrho_request_close = () => {
    if (!isDirty) return false;
    void (async () => {
      const close = await showCloseConfirm("close");
      if (close) requestConfirmedClose();
    })();
    return true;
  };
  window.__arcrho_consume_close_shortcut = window.__arcrho_request_close;
}

async function init() {
  withProgrammatic(() => {
    els.nameInput.value = text(params.get("name") || params.get("dataset_name"));
    els.outputTypeInput.value = text(params.get("output_type") || params.get("dataset_type") || els.nameInput.value);
    els.originLengthInput.value = String(validOriginLength(params.get("origin_length"), DEFAULT_ORIGIN_LENGTH));
    state.outputCategory = text(params.get("category"));
  });
  wireEvents();
  wireNotes();
  await loadOutputSidecarSettings().catch((err) => console.warn("Result Selection sidecar settings load failed:", err));
  if (!state.originLabels.length) await refreshOriginLabels({ render: false });
  await loadDatasetTypes();
  await loadCachedRows(false).catch((err) => postStatus(`Cached dataset lookup failed: ${err?.message || err}`, "error"));
  const loaded = await tryLoadExistingMethod().catch((err) => {
    postStatus(`Result Selection load failed: ${err?.message || err}`, "error");
    return false;
  });
  if (!loaded) {
    await initializeDefaultSources().catch((err) => postStatus(`Default source load failed: ${err?.message || err}`, "error"));
    renderMethodGrid();
  }
  setTab(state.activeTab);
  markClean();
  postStatus("Result Selection ready.");
}

init().catch((err) => {
  console.error("Result Selection initialization failed:", err);
  postStatus(`Result Selection failed to initialize: ${err?.message || err}`, "error");
});

import { fetchProjectDatasetTypeItems } from "/ui/dataset/dataset_types_source.js";
import { sanitizeDataFolderPart, sanitizeFileNamePart } from "/ui/shared/filename_sanitizer.js";
import { wireNotesEditorInteractions } from "/ui/shared/notes_editor_interactions.js";

const RS_JSON_FORMAT = "arcrho-result-selection-method-by-tab-v1";
const DEFAULT_ORIGIN_LENGTH = 12;

const params = new URLSearchParams(window.location.search);
const inst = params.get("inst") || `rs_${Date.now()}`;
let programmatic = false;
let isDirty = false;
let cleanSnapshot = "";
let datasetTypeItems = [];
let cachedRows = [];
let notesProgrammatic = false;
let lastSavedNotesText = "";

const state = {
  project: text(params.get("project")),
  reservingClass: text(params.get("class") || params.get("path")),
  outputCategory: text(params.get("category")),
  sources: [],
  ratioBasisValues: [],
  outputValues: [],
  activeTab: text(params.get("tab") || "details") || "details",
};

const els = {
  pathProject: document.getElementById("rsPathProject"),
  pathClass: document.getElementById("rsPathClass"),
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
  addSourceBtn: document.getElementById("rsAddSourceBtn"),
  ratioBasisStatus: document.getElementById("rsRatioBasisStatus"),
  methodGrid: document.getElementById("rsMethodGrid"),
  saveBtn: document.getElementById("rsSaveBtn"),
  cancelBtn: document.getElementById("rsCancelBtn"),
  notesInput: document.getElementById("rsNotesInput"),
  picker: document.getElementById("rsPicker"),
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
    originLength: positiveInt(els.originLengthInput.value),
    ratioBasis: text(els.ratioBasisInput.value),
    showRatiosAsPercentages: !!els.showRatiosPctInput.checked,
    statisticDecimalPlaces: Math.max(0, Math.min(8, nonNegativeInt(els.statisticDecimalsInput.value, 1))),
    showWeights: !!els.showWeightsInput.checked,
  };
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
    methodType: text(record?.methodType || existing?.method_type || existing?.methodType),
    category: text(record?.category || existing?.category),
    valueSource: "vector",
    values: Array.isArray(existing?.values) ? existing.values.map(numberOrNull) : [],
    weights: Array.isArray(existing?.weights) ? existing.weights.map((v) => Math.max(0, numberOrNull(v) ?? 0)) : [],
    unavailable: false,
  };
  if (!source.name) return null;
  try {
    const payload = await loadDatasetValues(source.name);
    source.datasetType = source.datasetType || text(payload?.dataset_type || source.name);
    source.dataFormat = source.dataFormat || text(payload?.data_format);
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
  return source;
}

function getRowCount() {
  let count = Array.isArray(state.outputValues) ? state.outputValues.length : 0;
  for (const source of state.sources) count = Math.max(count, source.values.length, source.weights.length);
  count = Math.max(count, state.ratioBasisValues.length);
  return count || 12;
}

function originLabel(rowIndex) {
  const originLength = getDetails().originLength;
  if (originLength === 12) return String(2017 + rowIndex);
  return String(rowIndex + 1);
}

function selectedUltimateAt(rowIndex) {
  let numerator = 0;
  let denominator = 0;
  for (const source of state.sources) {
    const value = numberOrNull(source.values[rowIndex]);
    const weight = Math.max(0, numberOrNull(source.weights[rowIndex]) ?? 0);
    if (value === null || weight <= 0) continue;
    numerator += value * weight;
    denominator += weight;
  }
  return denominator > 0 ? numerator / denominator : null;
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

function renderMethodGrid() {
  const grid = els.methodGrid;
  if (!grid) return;
  const details = getDetails();
  const count = getRowCount();
  const showWeights = details.showWeights;
  const hasBasis = !!details.ratioBasis;
  els.ratioBasisStatus.textContent = hasBasis ? `Basis: ${details.ratioBasis}` : "Basis: None";
  const thead = document.createElement("thead");
  const hrow = document.createElement("tr");
  hrow.appendChild(headerCell(details.originLength === 12 ? "Accident Year" : "Origin"));
  state.sources.forEach((source, idx) => {
    const th = headerCell(source.name || `Source ${idx + 1}`);
    th.className = "rsSourceHeader";
    const remove = document.createElement("button");
    remove.className = "rsSourceRemove";
    remove.type = "button";
    remove.title = "Remove source";
    remove.textContent = "x";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      state.sources.splice(idx, 1);
      markDirty();
      renderMethodGrid();
    });
    th.appendChild(remove);
    hrow.appendChild(th);
    if (showWeights) {
      const w = headerCell("Weight");
      w.className = "rsWeightHeader";
      hrow.appendChild(w);
    }
  });
  const ultimate = headerCell("Selected Ultimate");
  ultimate.className = "rsUltimateHeader";
  hrow.appendChild(ultimate);
  if (hasBasis) {
    const ratio = headerCell("Ultimate / Basis");
    ratio.className = "rsRatioHeader";
    hrow.appendChild(ratio);
  }
  thead.appendChild(hrow);

  const tbody = document.createElement("tbody");
  const totals = {
    source: new Array(state.sources.length).fill(0),
    ultimate: 0,
    basis: 0,
  };
  for (let r = 0; r < count; r += 1) {
    const tr = document.createElement("tr");
    tr.appendChild(bodyCell(originLabel(r)));
    state.sources.forEach((source, idx) => {
      const value = numberOrNull(source.values[r]);
      if (value !== null) totals.source[idx] += value;
      tr.appendChild(bodyCell(fmtNumber(value)));
      if (showWeights) {
        const td = document.createElement("td");
        td.className = "rsWeightCell";
        const input = document.createElement("input");
        input.className = "rsWeightInput";
        input.type = "number";
        input.min = "0";
        input.step = "any";
        input.value = String(Math.max(0, numberOrNull(source.weights[r]) ?? 0));
        input.addEventListener("input", () => {
          source.weights[r] = Math.max(0, numberOrNull(input.value) ?? 0);
          markDirty();
        });
        input.addEventListener("change", () => {
          renderMethodGrid();
        });
        td.appendChild(input);
        tr.appendChild(td);
      }
    });
    const ultimateValue = selectedUltimateAt(r);
    if (ultimateValue !== null) totals.ultimate += ultimateValue;
    const ucell = bodyCell(fmtNumber(ultimateValue));
    ucell.className = "rsUltimateCell";
    tr.appendChild(ucell);
    if (hasBasis) {
      const basis = numberOrNull(state.ratioBasisValues[r]);
      if (basis !== null) totals.basis += basis;
      const ratioValue = basis && ultimateValue !== null ? ultimateValue / basis : null;
      const rcell = bodyCell(fmtRatio(ratioValue));
      rcell.className = "rsRatioCell";
      tr.appendChild(rcell);
    }
    tbody.appendChild(tr);
  }
  const totalRow = document.createElement("tr");
  totalRow.className = "rsTotalRow";
  totalRow.appendChild(bodyCell("Total"));
  state.sources.forEach((_, idx) => {
    totalRow.appendChild(bodyCell(fmtNumber(totals.source[idx])));
    if (showWeights) totalRow.appendChild(bodyCell(""));
  });
  const totalUltimate = bodyCell(fmtNumber(totals.ultimate));
  totalUltimate.className = "rsUltimateCell";
  totalRow.appendChild(totalUltimate);
  if (hasBasis) {
    const ratio = totals.basis > 0 ? totals.ultimate / totals.basis : null;
    const ratioCell = bodyCell(fmtRatio(ratio));
    ratioCell.className = "rsRatioCell";
    totalRow.appendChild(ratioCell);
  }
  tbody.appendChild(totalRow);
  grid.replaceChildren(thead, tbody);
}

function headerCell(label) {
  const th = document.createElement("th");
  th.textContent = String(label || "");
  return th;
}

function bodyCell(label) {
  const td = document.createElement("td");
  td.textContent = String(label ?? "");
  return td;
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
        method_type: source.methodType,
        category: source.category,
        value_source: source.valueSource,
        values: source.values,
        weights: source.weights,
      })),
      selected_ultimate: selectedUltimateVector(),
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
    els.originLengthInput.value = String(positiveInt(details.origin_length || els.originLengthInput.value));
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
  if (text(els.ratioBasisInput.value)) await refreshRatioBasisValues();
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
  const origin = positiveInt(details.originLength);
  return `${sanitizeFileNamePart(details.name || "Result Selection", "Dataset")}@${origin}@${origin}@cum@dev.csv`;
}

async function getCsvPath() {
  return `${await getDatasetDir()}\\${getCsvFilename()}`;
}

function vectorCsv(values) {
  return `${(Array.isArray(values) ? values : []).map((v) => v == null ? "" : String(v)).join("\n")}\n`;
}

async function saveSidecar(csvPath) {
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
      data_format: "Vector",
      origin_length: details.originLength,
      development_length: details.originLength,
      cumulative: true,
      transposed: false,
      calendar: false,
      csv_file: csvPath.split(/[\\/]/).pop(),
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
  await saveSidecar(csvPath);
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
  const rect = anchor.getBoundingClientRect();
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

async function addSource(record) {
  if (state.sources.some((source) => norm(source.name) === norm(record.name))) return;
  const source = await buildSourceFromRecord(record);
  if (!source) return;
  const count = Math.max(getRowCount(), source.values.length);
  while (source.weights.length < count) source.weights.push(0);
  state.sources.push(source);
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
      renderMethodGrid();
    });
    el?.addEventListener("change", () => {
      markDirty();
      renderMethodGrid();
    });
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
    const rows = cachedRows.filter((row) => norm(row.name) !== norm(els.nameInput.value));
    openPicker(els.addSourceBtn, rows, (row) => void addSource(row));
  });
  els.saveBtn?.addEventListener("click", () => {
    saveResultSelection().catch((err) => postStatus(`Result Selection save failed: ${err?.message || err}`, "error"));
  });
  els.cancelBtn?.addEventListener("click", () => {
    if (!isDirty) return;
    if (!window.confirm("Unsaved Result Selection changes will be discarded.")) return;
    restoreCleanState().catch((err) => postStatus(`Result Selection restore failed: ${err?.message || err}`, "error"));
  });
  document.addEventListener("mousedown", (event) => {
    if (!els.picker.contains(event.target) && !event.target?.closest?.(".rsButton")) closePicker();
  });
  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "arcrho:dataset-save" || msg.type === "arcrho:result-selection-save") {
      saveResultSelection().catch((err) => postStatus(`Result Selection save failed: ${err?.message || err}`, "error"));
    }
  });
  window.__arcrho_request_close = () => {
    if (!isDirty) return false;
    if (!window.confirm("Result Selection has unsaved changes. Close it anyway?")) return true;
    postDirty(false, true);
    return false;
  };
}

async function init() {
  withProgrammatic(() => {
    els.pathProject.textContent = state.project || "-";
    els.pathClass.textContent = state.reservingClass || "-";
    els.nameInput.value = text(params.get("name") || params.get("dataset_name"));
    els.outputTypeInput.value = text(params.get("output_type") || params.get("dataset_type") || els.nameInput.value);
    els.originLengthInput.value = String(positiveInt(params.get("origin_length"), DEFAULT_ORIGIN_LENGTH));
    state.outputCategory = text(params.get("category"));
  });
  wireEvents();
  wireNotes();
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

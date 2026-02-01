import { state } from "./state.js";
import { redrawChartSafely, formatCellValue } from "./render.js";
import { createTabbedPage } from "./tabbed_page.js";
import {
  getSummaryOrderKey,
  getSummaryConfigKey,
  getSummaryHiddenKey,
  getMethodNameKey,
  loadHiddenSummaryIds,
  loadSummaryOrder,
  loadCustomSummaryRows,
  loadMethodName,
  loadNaBorders,
  saveHiddenSummaryIds,
  saveSummaryOrder,
  saveCustomSummaryRows,
  saveMethodName,
  saveNaBorders,
  markMethodSaved,
  clearMethodSavedFlag,
} from "./dfm_storage.js";

const __ratioParams = new URL(import.meta.url).search;
const pageParams = new URLSearchParams(window.location.search);
const __ratioCalcUrl = new URL("./dfm_ratio_calc.js", import.meta.url);
__ratioCalcUrl.search = __ratioParams;
  const {
    calcRatio,
    roundRatio,
    formatRatio,
    computeAverageForColumn,
  } = await import(__ratioCalcUrl.toString());

const ratioStrikeSet = new Set();
let activeRatioCol = null; // number | "all"
let cachedRootPath = null;

async function getRootPath() {
  if (cachedRootPath) return cachedRootPath;
  try {
    const res = await fetch("/ui_config");
    if (res.ok) {
      const data = await res.json();
      cachedRootPath = data.config?.root_path || "E:\\ADAS";
    } else {
      cachedRootPath = "E:\\ADAS";
    }
  } catch {
    cachedRootPath = "E:\\ADAS";
  }
  return cachedRootPath;
}
let ratioSummaryRaf = null;
let showNaBorders = false;
let summaryRowConfigs = [];
let summaryRowMap = new Map();
let lastSummaryCtxRowId = null;
const selectedSummaryByCol = new Map();

const BASE_SUMMARY_ROWS = [
  { id: "volume_all", label: "Volume - all", base: "volume", periods: "all" },
];

function getDefaultMethodName() {
  const tri = document.getElementById("triInput")?.value?.trim();
  return tri ? `DFM | ${tri}` : "DFM";
}

function updateAppTabTitle(title) {
  if (!title) return;
  window.parent.postMessage({ type: "adas:update-active-tab-title", title }, "*");
}

function getHostApi() {
  if (window.ADAHost) return window.ADAHost;
  try {
    if (window.parent && window.parent !== window && window.parent.ADAHost) {
      return window.parent.ADAHost;
    }
  } catch {}
  return null;
}

function updateResultsWindowTitle() {
  if (!resultsOnlyMode) return;
  let title = "";
  const passed = ratioSyncParams.get("results_title");
  if (passed) title = passed;
  if (!title) {
    const input = document.getElementById("dfmMethodName");
    const name = input?.value?.trim() || getDefaultMethodName();
    title = `Results - ${name}`;
  }
  document.title = title;
  const label = document.getElementById("resultsTitleText");
  if (label) label.textContent = title;
}

function getRatioSaveSuggestedName() {
  const triName = document.getElementById("triInput")?.value?.trim() || "Triangle";
  const reservingClass = document.getElementById("pathInput")?.value?.trim() || "ReservingClass";
  const originLen = document.getElementById("originLenSelect")?.value?.trim() || "Origin";
  const devLen = document.getElementById("devLenSelect")?.value?.trim() || "Dev";
  const raw = [triName, reservingClass, originLen, devLen]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join("@");
  const safe = raw
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ");
  return safe ? `DFM@${safe}.json` : "DFM@dfm_ratios.json";
}

function getRatioSaveProjectName() {
  const project = document.getElementById("projectSelect")?.value?.trim();
  return project ? project : "UnknownProject";
}

async function getRatioSaveBaseDir() {
  const rootPath = await getRootPath();
  const project = getRatioSaveProjectName()
    .toString()
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ");
  return `${rootPath}\\data\\${project || "UnknownProject"}`;
}

async function buildRatioSavePath() {
  const baseDir = await getRatioSaveBaseDir();
  const filename = getRatioSaveSuggestedName();
  return `${baseDir}\\${filename}`;
}

function buildRatioSelectionPattern() {
  const model = state.model;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) return [];
  const origins = model.origin_labels || [];
  const devs = getEffectiveDevLabelsForModel(model);
  const ratioLabels = getRatioHeaderLabels(devs);
  const colCount = ratioLabels.length;
  const vals = model.values;
  const mask = model.mask;
  const pattern = [];

  for (let r = 0; r < origins.length; r++) {
    const row = [];
    for (let c = 0; c < colCount; c++) {
      const strikeKey = `${r},${c}`;
      if (c >= devs.length - 1) {
        row.push(2);
        continue;
      }
      const hasA = !!(mask[r] && mask[r][c]);
      const hasB = !!(mask[r] && mask[r][c + 1]);
      if (!hasA || !hasB) {
        row.push(2);
        continue;
      }
      const ratio = calcRatio(vals?.[r]?.[c], vals?.[r]?.[c + 1]);
      if (!Number.isFinite(ratio)) {
        row.push(2);
        continue;
      }
      row.push(ratioStrikeSet.has(strikeKey) ? 1 : 0);
    }
    pattern.push(row);
  }
  return pattern;
}

function buildAverageSelectionPayload() {
  const model = state.model;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) {
    return { formulas: [], matrix: [] };
  }
  const devs = getEffectiveDevLabelsForModel(model);
  const ratioLabels = getRatioHeaderLabels(devs);
  const colCount = ratioLabels.length;
  const formulas = summaryRowConfigs.map((row) => String(row.label || row.id));
  const matrix = [];

  for (let c = 0; c < colCount; c++) {
    const rowId = selectedSummaryByCol.get(c) || "";
    const row = new Array(formulas.length).fill(0);
    const idx = summaryRowConfigs.findIndex((cfg) => String(cfg.id) === String(rowId));
    if (idx >= 0) row[idx] = 1;
    matrix.push(row);
  }

  return { formulas, matrix };
}


function applyRatioSelectionPattern(pattern) {
  if (!Array.isArray(pattern)) return false;
  const model = state.model;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) return false;
  const devs = getEffectiveDevLabelsForModel(model);
  const ratioLabels = getRatioHeaderLabels(devs);
  const rowCount = Math.min(pattern.length, (model.origin_labels || []).length);
  const colCount = Math.min(ratioLabels.length, devs.length - 1);
  if (!rowCount || colCount <= 0) return false;

  ratioStrikeSet.clear();
  for (let r = 0; r < rowCount; r++) {
    const row = Array.isArray(pattern[r]) ? pattern[r] : [];
    for (let c = 0; c < colCount; c++) {
      if (row[c] === 1) ratioStrikeSet.add(`${r},${c}`);
    }
  }
  return true;
}

function applySelectedSummaryFromSaved(selected, colCount) {
  if (!selected) return;
  selectedSummaryByCol.clear();
  if (Array.isArray(selected)) {
    if (selected.length && Array.isArray(selected[0])) {
      selected.forEach((entry) => {
        const col = Number(entry?.[0]);
        const rowId = entry?.[1];
        if (Number.isFinite(col) && typeof rowId === "string" && rowId) {
          selectedSummaryByCol.set(col, rowId);
        }
      });
      return;
    }
    for (let c = 0; c < Math.min(selected.length, colCount); c++) {
      const rowId = selected[c];
      if (typeof rowId === "string" && rowId) {
        selectedSummaryByCol.set(c, rowId);
      }
    }
  }
}

function applyAverageSelectionFromSaved(formulas, matrix) {
  if (!Array.isArray(formulas) || !Array.isArray(matrix)) return;
  selectedSummaryByCol.clear();
  const formulaList = formulas.map((f) => String(f));
  const colCount = matrix.length;
  for (let c = 0; c < colCount; c++) {
    const row = Array.isArray(matrix[c]) ? matrix[c] : [];
    const idx = row.findIndex((v) => Number(v) === 1);
    if (idx >= 0 && formulaList[idx]) {
      const label = formulaList[idx];
      const cfg = summaryRowConfigs.find((rowCfg) =>
        String(rowCfg.label || "") === label || String(rowCfg.id || "") === label
      );
      if (cfg?.id) selectedSummaryByCol.set(c, String(cfg.id));
    }
  }
}

async function loadRatioSelectionIfExists(reason) {
  const hostApi = getHostApi();
  if (!hostApi || typeof hostApi.readJsonFile !== "function") return;
  const path = await buildRatioSavePath();
  const result = await hostApi.readJsonFile({ path });
  if (!result || !result.exists) {
    ratioStrikeSet.clear();
    selectedSummaryByCol.clear();
    clearMethodSavedFlag();
    if (isRatiosTabVisible()) renderRatioTable();
    if (isResultsTabVisible()) renderResultsTable();
    window.parent.postMessage({ type: "adas:status", text: "No saved ratios found. Reset to default." }, "*");
    return;
  }
  const payload = result.data;
  const pattern = Array.isArray(payload) ? payload : payload?.pattern;
  const applied = applyRatioSelectionPattern(pattern);
  if (payload && !Array.isArray(payload)) {
    const model = state.model;
    const devs = getEffectiveDevLabelsForModel(model || {});
    const ratioLabels = getRatioHeaderLabels(devs);
    const formulas = payload["average formula"];
    const matrix = payload["average index"];
    if (Array.isArray(formulas) && Array.isArray(matrix)) {
      applyAverageSelectionFromSaved(formulas, matrix);
    } else {
      applySelectedSummaryFromSaved(payload?.selected, ratioLabels.length);
    }
  }
  if (applied) {
    if (isRatiosTabVisible()) renderRatioTable();
    if (isResultsTabVisible()) renderResultsTable();
    markMethodSaved();
    window.parent.postMessage({ type: "adas:status", text: "Edit Method" }, "*");
  } else if (reason) {
    window.parent.postMessage({ type: "adas:status", text: "Ratio file found but could not be applied." }, "*");
  }
}

function scheduleRatioSelectionLoad(reason) {
  if (ratioLoadTimer) clearTimeout(ratioLoadTimer);
  ratioLoadTimer = setTimeout(() => {
    ratioLoadTimer = null;
    loadRatioSelectionIfExists(reason);
  }, 120);
}

async function saveRatioSelectionPattern(forceSaveAs) {
  const hostApi = getHostApi();
  if (!hostApi || typeof hostApi.saveJsonFile !== "function") {
    alert("Save requires the desktop app.");
    window.parent.postMessage({ type: "adas:status", text: "Save failed: desktop app required." }, "*");
    return;
  }
  const pattern = buildRatioSelectionPattern();
  const avgSelection = buildAverageSelectionPayload();
  const payload = {
    data: {
      pattern,
      "average formula": avgSelection.formulas,
      "average index": avgSelection.matrix,
    },
    suggestedName: getRatioSaveSuggestedName(),
  };
  if (!forceSaveAs) {
    payload.path = await buildRatioSavePath();
  }
  const result = await hostApi.saveJsonFile(payload);
  if (result && result.path) {
    try {
      localStorage.setItem(RATIO_SAVE_PATH_KEY, result.path);
    } catch {}
    markMethodSaved();
    const time = new Date().toLocaleTimeString();
    window.parent.postMessage(
      { type: "adas:status", text: `Method saved at ${time}: ${result.path}` },
      "*"
    );
  } else if (result && result.error) {
    window.parent.postMessage({ type: "adas:status", text: `Save failed: ${result.error}` }, "*");
  } else {
    window.parent.postMessage({ type: "adas:status", text: "Save canceled." }, "*");
  }
}

function syncMethodNameFromInputs() {
  const input = document.getElementById("dfmMethodName");
  if (!input) return;
  const key = getMethodNameKey();
  const stored = key ? loadMethodName(key) : null;
  const next = stored || getDefaultMethodName();
  if (input.value !== next) input.value = next;
  updateAppTabTitle(next);
  updateResultsWindowTitle();
}

function wireMethodName() {
  const input = document.getElementById("dfmMethodName");
  if (!input || input.dataset.wired === "1") return;
  input.dataset.wired = "1";

  const commitValue = () => {
    const key = getMethodNameKey();
    const raw = input.value.trim();
    if (!raw) {
      const def = getDefaultMethodName();
      input.value = def;
      if (key) {
        try { localStorage.removeItem(key); } catch {}
      }
      updateAppTabTitle(def);
      return;
    }
    if (key) saveMethodName(key, raw);
    updateAppTabTitle(raw);
  };

  input.addEventListener("input", commitValue);
  input.addEventListener("change", commitValue);

  const triInput = document.getElementById("triInput");
  const pathInput = document.getElementById("pathInput");
  const projectInput = document.getElementById("projectSelect");
  const originLen = document.getElementById("originLenSelect");
  const devLen = document.getElementById("devLenSelect");
  triInput?.addEventListener("change", syncMethodNameFromInputs);
  triInput?.addEventListener("input", syncMethodNameFromInputs);
  pathInput?.addEventListener("change", syncMethodNameFromInputs);
  originLen?.addEventListener("change", syncMethodNameFromInputs);
  devLen?.addEventListener("change", syncMethodNameFromInputs);

  const triggerLoad = () => scheduleRatioSelectionLoad("details-change");
  triInput?.addEventListener("change", triggerLoad);
  triInput?.addEventListener("input", triggerLoad);
  pathInput?.addEventListener("change", triggerLoad);
  projectInput?.addEventListener("change", triggerLoad);
  originLen?.addEventListener("change", triggerLoad);
  devLen?.addEventListener("change", triggerLoad);
}

function buildSummaryRows() {
  const key = getSummaryConfigKey();
  const custom = loadCustomSummaryRows(key);
  const baseRows = BASE_SUMMARY_ROWS;
  const hiddenKey = getSummaryHiddenKey();
  const hidden = new Set(loadHiddenSummaryIds(hiddenKey));
  const visibleBase = baseRows.filter((row) => !hidden.has(row.id));
  const merged = [...visibleBase, ...custom];
  summaryRowConfigs = merged;
  summaryRowMap = new Map(merged.map((row) => [row.id, row]));
  return merged;
}

function getCurrentSummaryOrder(summaryBody) {
  return Array.from(summaryBody.querySelectorAll("tr[data-row-id]"))
    .map((row) => row.dataset.rowId)
    .filter(Boolean);
}

function applySummaryOrder(summaryBody, order) {
  if (!summaryBody || !Array.isArray(order) || !order.length) return;
  const rows = Array.from(summaryBody.children);
  const byId = new Map();
  rows.forEach((row) => {
    if (row.dataset?.rowId) byId.set(row.dataset.rowId, row);
  });
  const frag = document.createDocumentFragment();
  order.forEach((id) => {
    const row = byId.get(id);
    if (row) {
      frag.appendChild(row);
      byId.delete(id);
    }
  });
  rows.forEach((row) => {
    if (row.dataset?.rowId && byId.has(row.dataset.rowId)) {
      frag.appendChild(row);
      byId.delete(row.dataset.rowId);
    }
  });
  summaryBody.appendChild(frag);
}

function wireSummaryRowDrag(summaryBody, orderKey) {
  if (!summaryBody || summaryBody.dataset.dragWired === "1") return;
  summaryBody.dataset.dragWired = "1";

  let dragRow = null;
  let dragGhost = null;
  let dragOverRow = null;
  let dropBefore = true;
  let dragStartIndex = -1;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragMoved = false;
  let offsetY = 0;
  let fixedLeft = 0;

  const animateLayoutChange = (body, fn) => {
    const rows = Array.from(body.querySelectorAll("tr[data-row-id]"));
    const first = new Map(rows.map((row) => [row, row.getBoundingClientRect()]));
    fn();
    const last = new Map(rows.map((row) => [row, row.getBoundingClientRect()]));
    rows.forEach((row) => {
      const a = first.get(row);
      const b = last.get(row);
      if (!a || !b) return;
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (!dx && !dy) return;
      row.style.transform = `translate(${dx}px, ${dy}px)`;
      row.style.transition = "none";
    });
    body.offsetHeight; // force reflow
    rows.forEach((row) => {
      if (!row.style.transform) return;
      row.style.transition = "";
      row.style.transform = "";
    });
    window.setTimeout(() => {
      rows.forEach((row) => {
        row.style.transition = "";
        row.style.transform = "";
      });
    }, 180);
  };

  const clearDropTarget = () => {
    if (dragOverRow) dragOverRow.classList.remove("summaryDropTarget");
    dragOverRow = null;
    dropBefore = true;
  };

  const updateDropTarget = (clientY) => {
    const rows = Array.from(summaryBody.querySelectorAll("tr[data-row-id]"));
    let target = null;
    let before = true;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (clientY <= rect.bottom) {
        target = row;
        before = true;
        break;
      }
    }
    if (!target && rows.length) {
      target = rows[rows.length - 1];
      before = false;
    }
    if (target && dragStartIndex >= 0) {
      const targetIndex = rows.indexOf(target);
      if (targetIndex !== -1) {
        // Dragging down should insert AFTER the target to land on its row.
        before = dragStartIndex < targetIndex ? false : true;
      }
    }
    if (dragOverRow && dragOverRow !== target) {
      dragOverRow.classList.remove("summaryDropTarget");
    }
    dragOverRow = target;
    dropBefore = before;
    if (dragOverRow) dragOverRow.classList.add("summaryDropTarget");
  };

  const onMouseMove = (e) => {
    if (!dragRow) return;
    if (!dragMoved) {
      const dx = Math.abs(e.clientX - dragStartX);
      const dy = Math.abs(e.clientY - dragStartY);
      if (dx < 4 && dy < 4) return;
      dragMoved = true;
      clearDropTarget();
      const rect = dragRow.getBoundingClientRect();
      offsetY = dragStartY - rect.top;
      fixedLeft = rect.left;
      const ghostTable = document.createElement("table");
      ghostTable.classList.add("summaryDragGhostTable");
      ghostTable.style.width = `${rect.width}px`;
      ghostTable.style.left = `${fixedLeft}px`;
      ghostTable.style.top = `${rect.top}px`;
      const ghostBody = document.createElement("tbody");
      const ghostRow = dragRow.cloneNode(true);
      ghostRow.classList.add("summaryDragGhostRow");
      const srcCells = Array.from(dragRow.children);
      const ghostCells = Array.from(ghostRow.children);
      srcCells.forEach((cell, idx) => {
        const w = Math.round(cell.getBoundingClientRect().width);
        const gc = ghostCells[idx];
        if (!gc || !w) return;
        gc.style.width = `${w}px`;
        gc.style.minWidth = `${w}px`;
        gc.style.maxWidth = `${w}px`;
      });
      ghostBody.appendChild(ghostRow);
      ghostTable.appendChild(ghostBody);
      dragGhost = ghostTable;
      document.body.appendChild(dragGhost);
      dragRow.classList.add("dragging");
    }
    if (!dragGhost) return;
    const top = e.clientY - offsetY;
    dragGhost.style.top = `${top}px`;
    dragGhost.style.left = `${fixedLeft}px`;
    updateDropTarget(e.clientY);
  };

  const endDrag = (commit) => {
    if (!dragRow) return;
    if (!dragMoved) {
      clearDropTarget();
      dragRow = null;
      dragStartIndex = -1;
      dragStartX = 0;
      dragStartY = 0;
      dragMoved = false;
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("mouseup", onMouseUp, true);
      return;
    }
    if (dragGhost) {
      dragGhost.remove();
      dragGhost = null;
    }
    dragRow.classList.remove("dragging");
    if (commit && dragOverRow && dragOverRow !== dragRow) {
      animateLayoutChange(summaryBody, () => {
        const insertBeforeNode = dropBefore ? dragOverRow : dragOverRow.nextSibling;
        summaryBody.insertBefore(dragRow, insertBeforeNode);
      });
      saveSummaryOrder(orderKey, getCurrentSummaryOrder(summaryBody));
    }
    clearDropTarget();
    dragRow = null;
    offsetY = 0;
    fixedLeft = 0;
    dragStartIndex = -1;
    dragStartX = 0;
    dragStartY = 0;
    dragMoved = false;
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("mouseup", onMouseUp, true);
  };

  const onMouseUp = (e) => {
    if (e) updateDropTarget(e.clientY);
    endDrag(true);
  };

  summaryBody.addEventListener("mousedown", (e) => {
    const th = e.target?.closest?.("th.summaryDragHandle");
    if (!th) return;
    if (e.button !== 0) return;
    const row = th.closest("tr");
    if (!row || !row.dataset?.rowId) return;
    e.preventDefault();
    dragRow = row;
    const rows = Array.from(summaryBody.querySelectorAll("tr[data-row-id]"));
    dragStartIndex = rows.indexOf(row);
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragMoved = false;
    dragOverRow = row;
    dropBefore = true;
    row.classList.add("summaryDropTarget");
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseup", onMouseUp, true);
  });
}

let avgMenuWired = false;
let resultsMenuWired = false;
let ratioSyncChannel = null;
let ratioSyncMuted = false;
let resultsAutoResized = false;
const ratioSyncSourceId = `dfm_${Math.random().toString(36).slice(2)}_${Date.now()}`;
const ratioSyncParams = pageParams;
const ratioSyncInst = ratioSyncParams.get("inst") || "default";
const ratioSyncChannelName = `adas-dfm-ratio-sync::${ratioSyncInst}`;
const resultsOnlyMode = ratioSyncParams.get("results_only") === "1";
const RATIO_SAVE_PATH_KEY = `adas_dfm_ratio_save_path_v1::${ratioSyncInst}`;
let ratioLoadTimer = null;
const ALLOWED_DFM_TABS = new Set(["details", "data", "ratios", "results"]);
let currentDfmTab = "details";

function getAvgMenuEl() {
  return document.getElementById("dfmAvgMenu");
}

function getRatioMenuEl() {
  return document.getElementById("dfmRatioMenu");
}

function getResultsTabMenuEl() {
  return document.getElementById("dfmResultsTabMenu");
}

function updateRatioMenuLabel() {
  const menu = getRatioMenuEl();
  const btn = menu?.querySelector('[data-action="toggle-na-borders"]');
  if (!btn) return;
  btn.textContent = showNaBorders ? "Hide Lower-Right Borders" : "Show Lower-Right Borders";
}

function applyNaBorderVisibility() {
  const wrap = document.getElementById("ratioWrap");
  if (!wrap) return;
  wrap.classList.toggle("showNaBorders", showNaBorders);
}

function getAvgModalEl() {
  return document.getElementById("dfmAvgModal");
}

function hideAvgMenu() {
  const menu = getAvgMenuEl();
  if (menu) menu.style.display = "none";
}

function hideResultsTabMenu() {
  const menu = getResultsTabMenuEl();
  if (menu) menu.style.display = "none";
}

function showAvgMenu(x, y) {
  const menu = getAvgMenuEl();
  if (!menu) return;
  menu.style.display = "block";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

function showResultsTabMenu(x, y) {
  const menu = getResultsTabMenuEl();
  if (!menu) return;
  menu.style.display = "block";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

function openResultsInNewWindow() {
  const name = document.getElementById("dfmMethodName")?.value?.trim() || getDefaultMethodName();
  const title = `Results - ${name}`;
  const hostApi = getHostApi();
  if (!hostApi?.openDfmResultsWindow) {
    alert("Open in new window requires the desktop app.");
    return;
  }
  hostApi.openDfmResultsWindow({
    inst: ratioSyncInst,
    datasetId: ratioSyncParams.get("ds") || "",
    title,
  });
}

function getRatioSyncPayload() {
  return {
    type: "ratio-sync-state",
    source: ratioSyncSourceId,
    ts: Date.now(),
    strikes: Array.from(ratioStrikeSet),
    selected: Array.from(selectedSummaryByCol.entries()),
  };
}

function applyRatioSyncPayload(payload) {
  if (!payload || payload.source === ratioSyncSourceId) return;
  if (!Array.isArray(payload.strikes) || !Array.isArray(payload.selected)) return;

  ratioSyncMuted = true;
  try {
    ratioStrikeSet.clear();
    payload.strikes.forEach((key) => {
      if (typeof key === "string") ratioStrikeSet.add(key);
    });
    selectedSummaryByCol.clear();
    payload.selected.forEach((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) return;
      const col = Number(entry[0]);
      const rowId = String(entry[1] || "");
      if (!Number.isFinite(col) || !rowId) return;
      selectedSummaryByCol.set(col, rowId);
    });
  } finally {
    ratioSyncMuted = false;
  }

  const model = state.model;
  if (model) {
    const devs = getEffectiveDevLabelsForModel(model);
    const colCount = getRatioHeaderLabels(devs).length;
    ensureDefaultSummarySelectionForColumns(colCount);
  }

  if (isRatiosTabVisible()) renderRatioTable();
  if (document.getElementById("resultsWrap")) renderResultsTable();
}

function notifyRatioStateChanged() {
  if (ratioSyncMuted) return;
  if (ratioSyncChannel) {
    ratioSyncChannel.postMessage(getRatioSyncPayload());
  }
}

function requestRatioStateSync() {
  if (!ratioSyncChannel) return;
  ratioSyncChannel.postMessage({
    type: "ratio-sync-request",
    source: ratioSyncSourceId,
  });
}

function wireRatioSyncChannel() {
  if (!window.BroadcastChannel || ratioSyncChannel) return;
  try {
    ratioSyncChannel = new BroadcastChannel(ratioSyncChannelName);
  } catch {
    ratioSyncChannel = null;
  }
  if (!ratioSyncChannel) return;
  ratioSyncChannel.addEventListener("message", (e) => {
    const data = e?.data;
    if (!data || data.source === ratioSyncSourceId) return;
    if (data.type === "ratio-sync-request") {
      notifyRatioStateChanged();
      return;
    }
    if (data.type === "ratio-sync-state") {
      applyRatioSyncPayload(data);
    }
  });
}

function onRatioStateMutated() {
  if (document.getElementById("resultsWrap")) renderResultsTable();
  notifyRatioStateChanged();
}

function hideAvgModal() {
  const modal = getAvgModalEl();
  if (modal) modal.classList.remove("open");
}

function showAvgModal() {
  const modal = getAvgModalEl();
  if (!modal) return;
  const nameInput = modal.querySelector("#dfmAvgName");
  const baseSelect = modal.querySelector("#dfmAvgBase");
  const periodInput = modal.querySelector("#dfmAvgPeriods");
  const excludeInput = modal.querySelector("#dfmAvgExclude");
  if (nameInput) nameInput.value = "User Entry";
  if (baseSelect) baseSelect.value = "simple";
  if (periodInput) periodInput.value = "";
  if (excludeInput) excludeInput.value = "None";
  modal.classList.add("open");
}

function computeAutoName(base, periodsValue) {
  const label = base ? base.charAt(0).toUpperCase() + base.slice(1) : "User Entry";
  const p = String(periodsValue || "all").toLowerCase();
  const suffix = p === "all" ? "all" : p;
  return `${label} - ${suffix}`;
}

function parsePeriodsValue(raw) {
  if (!raw) return "all";
  const txt = String(raw).trim();
  if (!txt || txt.toLowerCase() === "all") return "all";
  const n = Number(txt);
  if (!Number.isFinite(n) || n <= 0) return "all";
  return Math.floor(n);
}

function parseExcludeValue(raw) {
  if (!raw) return 0;
  const txt = String(raw).trim();
  if (!txt) return 0;
  if (txt.toLowerCase() === "none") return 0;
  const n = Number(txt);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function computeAutoNameWithExclude(base, periodsValue, excludeValue) {
  const name = computeAutoName(base, periodsValue);
  const excludeCount = parseExcludeValue(excludeValue);
  if (excludeCount <= 0) return name;
  if (excludeCount === 1) return `${name} Ex hi/lo`;
  return `${name} Ex hi/lo x${excludeCount}`;
}

function wireAvgModal() {
  const modal = getAvgModalEl();
  if (!modal || modal.dataset.wired === "1") return;
  modal.dataset.wired = "1";

  const nameInput = modal.querySelector("#dfmAvgName");
  const baseSelect = modal.querySelector("#dfmAvgBase");
  const periodInput = modal.querySelector("#dfmAvgPeriods");
  const excludeInput = modal.querySelector("#dfmAvgExclude");
  const addBtn = modal.querySelector("#dfmAvgAdd");
  const cancelBtn = modal.querySelector("#dfmAvgCancel");

  const syncName = () => {
    const base = baseSelect?.value || "User Entry";
    const periods = parsePeriodsValue(periodInput?.value);
    const excludeCount = parseExcludeValue(excludeInput?.value);
    if (nameInput) nameInput.value = computeAutoNameWithExclude(base, periods, excludeCount);
  };

  const normalizePeriodsInput = () => {
    if (!periodInput) return;
    const raw = String(periodInput.value || "");
    if (!raw) return;
    if (/^all$/i.test(raw.trim())) {
      periodInput.value = "";
      return;
    }
    const digits = raw.replace(/[^\d]/g, "");
    if (digits !== raw) periodInput.value = digits;
  };

  const applyPeriodDelta = (dir) => {
    if (!periodInput) return;
    const raw = String(periodInput.value || "").trim();
    if (!raw) {
      periodInput.value = "2";
    } else {
      const current = parseInt(raw, 10);
      const base = Number.isFinite(current) ? current : 2;
      const next = Math.max(2, base + dir);
      periodInput.value = String(next);
    }
    syncName();
  };

  const normalizeExcludeInput = () => {
    if (!excludeInput) return;
    const raw = String(excludeInput.value || "").trim();
    if (!raw) return;
    if (/^none$/i.test(raw)) {
      excludeInput.value = "None";
      return;
    }
    const digits = raw.replace(/[^\d]/g, "");
    if (digits !== raw) excludeInput.value = digits;
  };

  baseSelect?.addEventListener("change", syncName);
  periodInput?.addEventListener("input", () => {
    normalizePeriodsInput();
    syncName();
  });
  periodInput?.addEventListener("change", () => {
    normalizePeriodsInput();
    syncName();
  });
  excludeInput?.addEventListener("input", () => {
    normalizeExcludeInput();
    syncName();
  });
  excludeInput?.addEventListener("change", () => {
    normalizeExcludeInput();
    syncName();
  });
  periodInput?.addEventListener("wheel", (e) => {
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    applyPeriodDelta(dir);
  }, { passive: false });

  cancelBtn?.addEventListener("click", () => hideAvgModal());
  modal.querySelector(".dfmModalBackdrop")?.addEventListener("click", () => hideAvgModal());

  addBtn?.addEventListener("click", () => {
    const base = (baseSelect?.value || "simple").toLowerCase();
    const periods = parsePeriodsValue(periodInput?.value);
    const excludeCount = parseExcludeValue(excludeInput?.value);
    const label = nameInput?.value?.trim() || computeAutoNameWithExclude(base, periods, excludeCount);
    const cfgKey = getSummaryConfigKey();
    if (!cfgKey) {
      hideAvgModal();
      return;
    }
    const customRows = loadCustomSummaryRows(cfgKey);
    const normalizedLabel = label.trim();
    const nameExists = summaryRowConfigs.some((row) =>
      String(row.label || "").trim().toLowerCase() === normalizedLabel.toLowerCase()
    );
    if (nameExists) {
      alert("Average formula name already exists.");
      return;
    }
    customRows.push({
      id: `custom_${Date.now()}`,
      label,
      base,
      periods,
      exclude: excludeCount,
    });
    saveCustomSummaryRows(cfgKey, customRows);
    hideAvgModal();
    renderRatioTable();
  });

}

function wireSummaryContextMenu(summaryTable) {
  if (!summaryTable || summaryTable.dataset.menuWired === "1") return;
  summaryTable.dataset.menuWired = "1";
  wireAvgModal();

  summaryTable.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const row = e.target?.closest?.("tr[data-row-id]");
    lastSummaryCtxRowId = row?.dataset?.rowId || null;
    const cfg = summaryRowMap.get(lastSummaryCtxRowId || "");
    const menu = getAvgMenuEl();
    if (menu) {
      const isBaseRow = BASE_SUMMARY_ROWS.some((row) => row.id === lastSummaryCtxRowId);
      const allowDeleteBase =
        lastSummaryCtxRowId === "volume_all" && summaryRowConfigs.length > 1;
      const disableRename = !cfg || isBaseRow;
      const disableDelete = !cfg || (isBaseRow && !allowDeleteBase);
      const renameBtn = menu.querySelector('[data-action="rename-average"]');
      const deleteBtn = menu.querySelector('[data-action="delete-average"]');
      if (renameBtn) renameBtn.disabled = disableRename;
      if (deleteBtn) deleteBtn.disabled = disableDelete;
    }
    showAvgMenu(e.clientX, e.clientY);
  });

  if (!avgMenuWired) {
    avgMenuWired = true;
    const menu = getAvgMenuEl();
    menu?.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      hideAvgMenu();
      if (action === "custom-average") {
        showAvgModal();
        return;
      }
      if (action === "rename-average") {
        if (!lastSummaryCtxRowId) return;
        const cfg = summaryRowMap.get(lastSummaryCtxRowId);
        if (!cfg) return;
        const newName = prompt("Rename average", cfg.label || "");
        if (!newName) return;
        const trimmed = newName.trim();
        if (!trimmed) return;
        const nameExists = summaryRowConfigs.some(
          (row) => String(row.label || "").trim().toLowerCase() === trimmed.toLowerCase()
        );
        if (nameExists && String(cfg.label || "").trim().toLowerCase() !== trimmed.toLowerCase()) {
          alert("Average formula name already exists.");
          return;
        }
        const cfgKey = getSummaryConfigKey();
        if (!cfgKey) return;
        const customRows = loadCustomSummaryRows(cfgKey);
        const idx = customRows.findIndex((r) => r.id === lastSummaryCtxRowId);
        if (idx === -1) {
          if (BASE_SUMMARY_ROWS.some((row) => row.id === lastSummaryCtxRowId)) return;
          customRows.push({ ...cfg, label: trimmed });
        } else {
          customRows[idx] = { ...customRows[idx], label: trimmed };
        }
        saveCustomSummaryRows(cfgKey, customRows);
        renderRatioTable();
        return;
      }
      if (action === "delete-average") {
        if (!lastSummaryCtxRowId) return;
        if (lastSummaryCtxRowId === "volume_all" && summaryRowConfigs.length <= 1) return;
        const cfgKey = getSummaryConfigKey();
        if (!cfgKey) return;
        const hiddenKey = getSummaryHiddenKey();
        if (BASE_SUMMARY_ROWS.some((row) => row.id === lastSummaryCtxRowId)) {
          const hidden = loadHiddenSummaryIds(hiddenKey);
          if (!hidden.includes(lastSummaryCtxRowId)) {
            hidden.push(lastSummaryCtxRowId);
            saveHiddenSummaryIds(hiddenKey, hidden);
          }
          renderRatioTable();
          return;
        }
        const customRows = loadCustomSummaryRows(cfgKey);
        const idx = customRows.findIndex((r) => r.id === lastSummaryCtxRowId);
        if (idx === -1) return;
        customRows.splice(idx, 1);
        saveCustomSummaryRows(cfgKey, customRows);
        renderRatioTable();
        return;
      }
    });

    document.addEventListener("mousedown", (e) => {
      const menuEl = getAvgMenuEl();
      if (menuEl && menuEl.style.display === "block" && !menuEl.contains(e.target)) {
        hideAvgMenu();
      }
      const ratioMenu = getRatioMenuEl();
      if (ratioMenu && ratioMenu.style.display === "block" && !ratioMenu.contains(e.target)) {
        ratioMenu.style.display = "none";
      }
      const resultsMenu = getResultsTabMenuEl();
      if (resultsMenu && resultsMenu.style.display === "block" && !resultsMenu.contains(e.target)) {
        resultsMenu.style.display = "none";
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        hideAvgMenu();
        hideAvgModal();
        const ratioMenu = getRatioMenuEl();
        if (ratioMenu) ratioMenu.style.display = "none";
        hideResultsTabMenu();
      }
    });
  }
}

function wireResultsTabContextMenu() {
  if (resultsMenuWired || resultsOnlyMode) return;
  resultsMenuWired = true;

  const resultsTab = document.querySelector('.dfmTabBar .dfmTab[data-page="results"]');
  if (!resultsTab) return;

  resultsTab.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showResultsTabMenu(e.clientX, e.clientY);
  });

  const menu = getResultsTabMenuEl();
  menu?.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "open-results-window") {
      hideResultsTabMenu();
      openResultsInNewWindow();
    }
  });

  document.addEventListener("mousedown", (e) => {
    const menuEl = getResultsTabMenuEl();
    if (menuEl && menuEl.style.display === "block" && !menuEl.contains(e.target)) {
      hideResultsTabMenu();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideResultsTabMenu();
  });
}

function wireResultsTitlebar() {
  if (!resultsOnlyMode) return;
  const bar = document.getElementById("resultsTitlebar");
  if (!bar || bar.dataset.wired === "1") return;
  bar.dataset.wired = "1";

  const hostApi = getHostApi();
  const minBtn = document.getElementById("resultsMinBtn");
  const maxBtn = document.getElementById("resultsMaxBtn");
  const closeBtn = document.getElementById("resultsCloseBtn");

  minBtn?.addEventListener("click", () => {
    if (hostApi?.minimizeWindow) {
      hostApi.minimizeWindow();
    }
  });

  maxBtn?.addEventListener("click", async () => {
    if (!hostApi?.isMaximized || !hostApi?.maximizeWindow || !hostApi?.restoreWindow) {
      return;
    }
    try {
      const isMax = await hostApi.isMaximized();
      if (isMax) await hostApi.restoreWindow();
      else await hostApi.maximizeWindow();
    } catch {}
  });

  closeBtn?.addEventListener("click", () => {
    try { window.close(); } catch {}
  });
}

function autoResizeResultsWindowOnce() {
  if (!resultsOnlyMode || resultsAutoResized) return;
  const hostApi = getHostApi();
  const resizeFn = hostApi?.resizeSelfWindow || hostApi?.resizeWindow;
  if (!resizeFn) return;

  const table = document.querySelector("#resultsWrap table");
  if (!table) return;

  requestAnimationFrame(() => {
    if (resultsAutoResized) return;
    const tableRect = table.getBoundingClientRect();
    if (!tableRect.width || !tableRect.height) return;
    const titleBar = document.getElementById("resultsTitlebar");
    const titleRect = titleBar?.getBoundingClientRect();
    const titleH = titleRect?.height || 0;

    const paddingX = 24;
    const paddingY = 32;
    const scale = 1.2;
    const width = Math.ceil((tableRect.width + paddingX) * scale);
    const height = Math.ceil((titleH + tableRect.height + paddingY) * scale);

    const maxW = Math.max(320, Number(window.screen?.availWidth || window.innerWidth || width));
    const maxH = Math.max(240, Number(window.screen?.availHeight || window.innerHeight || height));
    const nextW = Math.min(width, maxW);
    const nextH = Math.min(height, maxH);
    if (!Number.isFinite(nextW) || !Number.isFinite(nextH)) return;

    resizeFn(nextW, nextH);
    resultsAutoResized = true;
  });
}

function ensureSelectedRowValues(summaryTable, selectedTable) {
  if (!selectedTable) return;
  const selectedRow = selectedTable.querySelector('tr[data-row-id="selected"]');
  const cumulativeRow = selectedTable.querySelector('tr[data-row-id="cumulative"]');
  if (!selectedRow) return;
  const selectedCells = Array.from(selectedRow.querySelectorAll("td[data-col]"));
  const selectedValues = new Array(selectedCells.length).fill(null);

  selectedCells.forEach((td) => {
    const col = Number(td.dataset.col);
    const rowId = selectedSummaryByCol.get(col);
    if (!rowId) {
      td.textContent = "";
      return;
    }
    const cell = summaryTable?.querySelector(`td.summaryCell[data-r="${rowId}"][data-col="${col}"]`);
    if (!cell) {
      selectedSummaryByCol.delete(col);
      td.textContent = "";
      return;
    }
    const text = cell.textContent || "";
    td.textContent = text;
    const val = parseFloat(text);
    if (Number.isFinite(val)) selectedValues[col] = val;
  });

  if (cumulativeRow) {
    const cumCells = Array.from(cumulativeRow.querySelectorAll("td[data-col]"));
    let running = null;
    for (let i = selectedValues.length - 1; i >= 0; i--) {
      const selVal = selectedValues[i];
      const target = cumCells[i];
      if (!target) continue;
      if (!Number.isFinite(selVal)) {
        target.textContent = "";
        running = null;
        continue;
      }
      if (i === selectedValues.length - 1) {
        running = selVal;
      } else if (Number.isFinite(running)) {
        running = selVal * running;
      } else {
        target.textContent = "";
        running = null;
        continue;
      }
      const rounded = roundRatio(running, 6);
      target.textContent = formatRatio(rounded, 4);
    }
  }
}

function applySummarySelection(summaryTable, selectedTable) {
  if (!summaryTable) return;
  const cols = new Set();
  selectedSummaryByCol.forEach((_rowId, col) => cols.add(Number(col)));
  cols.forEach((col) => {
    const rowId = selectedSummaryByCol.get(col);
    const cell = summaryTable.querySelector(`td.summaryCell[data-r="${rowId}"][data-col="${col}"]`);
    if (!cell) {
      selectedSummaryByCol.delete(col);
      return;
    }
    summaryTable.querySelectorAll(`td.summaryCell[data-col="${col}"]`)
      .forEach((el) => el.classList.remove("ratioSelectedCell"));
    cell.classList.add("ratioSelectedCell");
  });
  ensureSelectedRowValues(summaryTable, selectedTable);
}

function initDefaultSummarySelection(summaryTable) {
  if (!summaryTable) return;
  const firstRow = summaryTable.querySelector("tr[data-row-id]");
  if (!firstRow) return;
  const rowId = String(firstRow.dataset.rowId || "");
  if (!rowId) return;
  const cols = summaryTable.querySelectorAll("td.summaryCell[data-col]");
  const maxCol = cols.length ? Math.max(...Array.from(cols).map((c) => Number(c.dataset.col))) : -1;
  if (maxCol < 0) return;
  for (let c = 0; c <= maxCol; c++) {
    if (!selectedSummaryByCol.has(c)) selectedSummaryByCol.set(c, rowId);
  }
}

function wireSummarySelection(summaryTable, selectedTable) {
  if (!summaryTable || summaryTable.dataset.selectionWired === "1") return;
  summaryTable.dataset.selectionWired = "1";
  let dragActive = false;
  let lastKey = null;

  const selectCell = (cell) => {
    if (!cell) return;
    const col = Number(cell.dataset.col);
    const rowId = String(cell.dataset.r || "");
    if (!Number.isFinite(col) || !rowId) return;
    selectedSummaryByCol.set(col, rowId);
    summaryTable.querySelectorAll(`td.summaryCell[data-col="${col}"]`)
      .forEach((el) => el.classList.remove("ratioSelectedCell"));
    cell.classList.add("ratioSelectedCell");
    ensureSelectedRowValues(summaryTable, selectedTable);
    onRatioStateMutated();
  };

  summaryTable.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const cell = e.target?.closest?.("td.summaryCell");
    if (!cell) return;
    e.preventDefault();
    dragActive = true;
    const key = `${cell.dataset.r || ""},${cell.dataset.col || ""}`;
    lastKey = key;
    selectCell(cell);
  });

  summaryTable.addEventListener("mousemove", (e) => {
    if (!dragActive) return;
    const cell = e.target?.closest?.("td.summaryCell");
    if (!cell) return;
    const key = `${cell.dataset.r || ""},${cell.dataset.col || ""}`;
    if (key === lastKey) return;
    lastKey = key;
    selectCell(cell);
  });

  window.addEventListener("mouseup", () => {
    dragActive = false;
    lastKey = null;
  });

  summaryTable.addEventListener("click", (e) => {
    if (dragActive) return;
    const cell = e.target?.closest?.("td.summaryCell");
    if (!cell) return;
    selectCell(cell);
  });
}

function wireRatioContextMenu() {
  const wrap = document.getElementById("ratioWrap");
  if (!wrap || wrap.dataset.ratioMenuWired === "1") return;
  wrap.dataset.ratioMenuWired = "1";

  wrap.addEventListener("contextmenu", (e) => {
    const table = e.target?.closest?.("table");
    if (!table || !table.classList.contains("ratioMainTable")) return;
    e.preventDefault();
    const menu = getRatioMenuEl();
    if (!menu) return;
    updateRatioMenuLabel();
    menu.style.display = "block";
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
  });

  const menu = getRatioMenuEl();
  menu?.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "toggle-na-borders") {
      showNaBorders = !showNaBorders;
      saveNaBorders(showNaBorders);
      applyNaBorderVisibility();
    }
    menu.style.display = "none";
  });
}

function getEffectiveDevLabelsForModel(model) {
  const devs = Array.isArray(model?.dev_labels) ? model.dev_labels : [];
  const vals = Array.isArray(model?.values) ? model.values : [];
  let maxCols = 0;
  for (const row of vals) {
    if (Array.isArray(row)) maxCols = Math.max(maxCols, row.length);
  }
  if (!maxCols || maxCols >= devs.length) return devs;
  return devs.slice(0, maxCols);
}

function toLabelNum(value) {
  const s = String(value ?? "").trim();
  const m = s.match(/[-+]?\d*\.?\d+/);
  return m ? m[0] : "";
}

function getRatioHeaderLabels(devs) {
  const labels = [];
  for (let c = 0; c < devs.length - 1; c++) {
    const left = toLabelNum(devs[c]);
    const right = toLabelNum(devs[c + 1]);
    if (left && right) {
      labels.push(`${left}-${right}`);
    } else {
      labels.push(`${String(devs[c] ?? "")}-${String(devs[c + 1] ?? "")}`);
    }
  }

  if (devs.length) {
    const lastRaw = devs[devs.length - 1];
    const lastNum = toLabelNum(lastRaw);
    const left = (lastNum || String(lastRaw ?? "").trim() || "Ult");
    if (String(left).trim().toLowerCase() === "ult") {
      labels.push("Ult");
    } else {
      labels.push(`${left} - Ult`);
    }
  }

  return labels;
}

function getOriginLabelTextForRatio() {
  const originLen = Number(document.getElementById("originLenSelect")?.value || 12);
  switch (originLen) {
    case 12: return "Accident Year";
    case 6: return "Accident Half-Year";
    case 3: return "Accident Quarter";
    case 1: return "Accident Month";
    default: return "Accident Period";
  }
}

function ensureDefaultSummarySelectionForColumns(colCount) {
  if (!colCount) return;
  const summaryRows = buildSummaryRows();
  const defaultRowId = summaryRows[0]?.id || "";
  if (!defaultRowId) return;
  for (let c = 0; c < colCount; c++) {
    if (!selectedSummaryByCol.has(c)) selectedSummaryByCol.set(c, defaultRowId);
  }
}

function getSelectedRatioValues(model, devs) {
  const ratioLabels = getRatioHeaderLabels(devs);
  const values = new Array(ratioLabels.length).fill(1);
  if (!ratioLabels.length) return values;

  const summaryRows = buildSummaryRows();
  const defaultRowId = summaryRows[0]?.id || "";

  for (let c = 0; c < ratioLabels.length; c++) {
    if (c >= devs.length - 1) {
      values[c] = 1;
      continue;
    }
    const rowId = selectedSummaryByCol.get(c) || defaultRowId;
    const cfg = rowId ? summaryRowMap.get(rowId) : null;
    if (!cfg) {
      values[c] = 1;
      continue;
    }
    const excluded = buildExcludedSetForColumn(model, c, cfg, ratioStrikeSet);
    const summary = computeAverageForColumn(model, c, excluded, cfg);
    if (summary.totalValid > 0 && summary.totalIncluded === 0) {
      values[c] = 1;
      continue;
    }
    const isVolume = String(cfg.base || "volume").toLowerCase() === "volume";
    const hasValue =
      summary.value !== null &&
      (isVolume ? summary.sumA : summary.totalIncluded > 0);
    values[c] = hasValue ? summary.value : 1;
  }

  return values;
}

function buildExcludedSetForColumn(model, col, cfg, baseExcludedSet) {
  const baseSet = baseExcludedSet || new Set();
  const excludeCount = parseExcludeValue(cfg?.exclude);
  if (!excludeCount) return baseSet;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) return baseSet;

  const vals = model.values;
  const mask = model.mask;
  const rowCount = Array.isArray(model.origin_labels) ? model.origin_labels.length : vals.length;
  const periodsRaw = cfg?.periods ?? "all";
  const periods = typeof periodsRaw === "string" && periodsRaw.toLowerCase() === "all"
    ? "all"
    : Number(periodsRaw);
  const lookback = Number.isFinite(periods) && periods > 0 ? Math.floor(periods) : null;

  const includeRow = (r) => {
    const hasA = !!(mask[r] && mask[r][col]);
    const hasB = !!(mask[r] && mask[r][col + 1]);
    if (!hasA || !hasB) return null;
    return calcRatio(vals?.[r]?.[col], vals?.[r]?.[col + 1]);
  };

  const candidates = [];
  if (lookback) {
    let picked = 0;
    for (let r = rowCount - 1; r >= 0; r--) {
      if (picked >= lookback) break;
      const ratio = includeRow(r);
      if (!Number.isFinite(ratio)) continue;
      if (baseSet && baseSet.has(`${r},${col}`)) continue;
      picked += 1;
      candidates.push({ r, ratio });
    }
  } else {
    for (let r = 0; r < rowCount; r++) {
      const ratio = includeRow(r);
      if (!Number.isFinite(ratio)) continue;
      if (baseSet && baseSet.has(`${r},${col}`)) continue;
      candidates.push({ r, ratio });
    }
  }

  const n = Math.min(excludeCount, Math.floor(candidates.length / 2));
  if (n <= 0) return baseSet;

  const sorted = [...candidates].sort((a, b) => a.ratio - b.ratio);
  const merged = new Set(baseSet);
  for (let i = 0; i < n; i++) {
    merged.add(`${sorted[i].r},${col}`);
    merged.add(`${sorted[sorted.length - 1 - i].r},${col}`);
  }
  return merged;
}

function getCumulativeFactors(model, devs) {
  const ratioValues = getSelectedRatioValues(model, devs);
  const cumulative = new Array(ratioValues.length).fill(null);
  let running = null;
  for (let i = ratioValues.length - 1; i >= 0; i--) {
    const v = ratioValues[i];
    if (!Number.isFinite(v)) {
      cumulative[i] = null;
      running = null;
      continue;
    }
    if (i === ratioValues.length - 1) {
      running = v;
    } else if (Number.isFinite(running)) {
      running = v * running;
    } else {
      cumulative[i] = null;
      running = null;
      continue;
    }
    cumulative[i] = running;
  }
  return cumulative;
}

function getLatestRowValue(vals, mask, rowIndex, maxCol) {
  if (!Array.isArray(vals) || !Array.isArray(mask) || maxCol < 0) return null;
  const rowVals = vals[rowIndex] || [];
  for (let c = maxCol; c >= 0; c--) {
    if (!(mask[rowIndex] && mask[rowIndex][c])) continue;
    const raw = rowVals[c];
    const n = (typeof raw === "number") ? raw : Number(raw);
    if (!Number.isFinite(n)) continue;
    return { value: n, col: c };
  }
  return null;
}

function renderResultsTable() {
  const wrap = document.getElementById("resultsWrap");
  if (!wrap) return;
  wrap.innerHTML = "";

  const model = state.model;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) {
    wrap.innerHTML = `<div class="small">No dataset loaded.</div>`;
    return;
  }

  const origins = model.origin_labels || [];
  const devs = getEffectiveDevLabelsForModel(model);
  if (!devs.length) {
    wrap.innerHTML = `<div class="small">Not enough data to compute results.</div>`;
    return;
  }

  const ratioLabels = getRatioHeaderLabels(devs);
  const colCount = ratioLabels.length || devs.length;
  ensureDefaultSummarySelectionForColumns(colCount);
  const cumulative = getCumulativeFactors(model, devs);

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.textContent = getOriginLabelTextForRatio();
  headRow.appendChild(corner);
  const ultHead = document.createElement("th");
  ultHead.textContent = "Ultimate";
  headRow.appendChild(ultHead);
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const vals = model.values;
  const mask = model.mask;
  for (let r = 0; r < origins.length; r++) {
    const tr = document.createElement("tr");
    const rowHead = document.createElement("th");
    rowHead.textContent = String(origins[r] ?? "");
    tr.appendChild(rowHead);

    const td = document.createElement("td");
    const maxCol = Math.min(devs.length - 1, (vals?.[r] || []).length - 1);
    const latest = getLatestRowValue(vals, mask, r, maxCol);
    if (latest && Number.isFinite(cumulative[latest.col])) {
      const ult = latest.value * cumulative[latest.col];
      td.textContent = formatCellValue(ult);
    } else {
      td.textContent = "";
    }
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  autoResizeResultsWindowOnce();
}

function isRatiosTabVisible() {
  const ratiosPage = document.getElementById("dfmRatiosPage");
  return !!ratiosPage && ratiosPage.style.display !== "none";
}

function isResultsTabVisible() {
  const resultsPage = document.getElementById("dfmResultsPage");
  return !!resultsPage && resultsPage.style.display !== "none";
}

function notifyDfmEditState() {
  const enabled = isRatiosTabVisible() && (activeRatioCol === "all" || Number.isFinite(activeRatioCol));
  window.parent.postMessage({ type: "adas:dfm-edit-state", enabled }, "*");
}

function updateRatioSummary() {
  const wrap = document.getElementById("ratioWrap");
  const model = state.model;
  if (!wrap || !model || !Array.isArray(model.values) || !Array.isArray(model.mask)) return;
  const cells = wrap.querySelectorAll('td.ratioCell[data-r]');
  if (!cells.length) return;

  const devs = getEffectiveDevLabelsForModel(model);

  cells.forEach((cell) => {
    const c = parseInt(cell.dataset.c, 10);
    const rowType = cell.dataset.r;
    const cfg = summaryRowMap.get(rowType);
    const isSummary = !!cfg;

    if (!Number.isFinite(c) || c < 0) return;
    if (c >= devs.length - 1) {
      if (isSummary) {
        cell.textContent = "1.0000";
        cell.classList.remove("na");
        cell.classList.add("ratioPlaceholder");
        cell.classList.remove("strike");
      } else {
        cell.textContent = "";
        cell.classList.add("na");
        cell.classList.remove("ratioPlaceholder");
        cell.classList.remove("strike");
      }
      return;
    }

    if (!cfg) return;
    ratioStrikeSet.delete(`${rowType},${c}`);
    const excluded = buildExcludedSetForColumn(model, c, cfg, ratioStrikeSet);
    const summary = computeAverageForColumn(model, c, excluded, cfg);
    if (summary.totalValid > 0 && summary.totalIncluded === 0) {
      cell.textContent = "1.0000";
      cell.classList.remove("na");
      cell.classList.remove("ratioPlaceholder");
      cell.classList.remove("strike");
      return;
    }
    const isVolume = String(cfg.base || "volume").toLowerCase() === "volume";
    const hasValue =
      summary.value !== null &&
      (isVolume ? summary.sumA : summary.totalIncluded > 0);
    if (hasValue) {
      const rounded = roundRatio(summary.value, 6);
      cell.textContent = formatRatio(rounded, 4);
      cell.classList.remove("na");
      cell.classList.remove("ratioPlaceholder");
    } else {
      cell.textContent = "1.0000";
      cell.classList.remove("na");
      cell.classList.add("ratioPlaceholder");
    }
    cell.classList.remove("strike");
  });

  const summaryTable = wrap.querySelector("table.ratioSummaryTable");
  const selectedTable = wrap.querySelector("table.ratioSelectedTable");
  if (summaryTable && selectedTable) {
    ensureSelectedRowValues(summaryTable, selectedTable);
  }
}

function scheduleRatioSummaryUpdate() {
  if (ratioSummaryRaf) return;
  ratioSummaryRaf = requestAnimationFrame(() => {
    ratioSummaryRaf = null;
    updateRatioSummary();
  });
}

function applyRatioColHighlight() {
  const wrap = document.getElementById("ratioWrap");
  if (!wrap) return;
  const allActive = activeRatioCol === "all";
  const cells = wrap.querySelectorAll("td[data-col]");
  cells.forEach((el) => {
    const col = Number(el.dataset.col);
    const on = allActive ? Number.isFinite(col) : (Number.isFinite(col) && col === activeRatioCol);
    el.classList.toggle("ratioColActive", on);
  });
  const headers = wrap.querySelectorAll("thead th[data-col]");
  headers.forEach((el) => {
    const colAttr = el.dataset.col;
    if (colAttr === "all") {
      el.classList.toggle("ratioColActiveHeader", allActive);
      return;
    }
    const col = Number(colAttr);
    const on = allActive ? Number.isFinite(col) : (Number.isFinite(col) && col === activeRatioCol);
    el.classList.toggle("ratioColActiveHeader", on);
  });
}

function renderRatioTable() {
  const wrap = document.getElementById("ratioWrap");
  if (!wrap) return;
  wrap.innerHTML = "";

  const model = state.model;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) {
    wrap.innerHTML = `<div class="small">No dataset loaded.</div>`;
    return;
  }

  const origins = model.origin_labels || [];
  const devs = getEffectiveDevLabelsForModel(model);
  const ratioLabels = getRatioHeaderLabels(devs);
  const vals = model.values;
  const mask = model.mask;

  if (devs.length < 2) {
    wrap.innerHTML = `<div class="small">Not enough columns to compute ratios.</div>`;
    return;
  }

  const table = document.createElement("table");
  table.classList.add("ratioMainTable");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.textContent = getOriginLabelTextForRatio();
  corner.dataset.col = "all";
  headRow.appendChild(corner);

  for (let c = 0; c < ratioLabels.length; c++) {
    const th = document.createElement("th");
    const label = ratioLabels[c] || "";
    if (c === ratioLabels.length - 1) {
      th.textContent = label || "Ult";
    } else {
      th.textContent = label ? `(${c + 1}) ${label}` : `(${c + 1})`;
    }
    th.dataset.col = String(c);
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const summaryTable = document.createElement("table");
  summaryTable.classList.add("ratioSummaryTable");
  const summaryBody = document.createElement("tbody");
  const summaryRows = buildSummaryRows();

  summaryRows.forEach((rowCfg) => {
    const tr = document.createElement("tr");
    tr.dataset.rowId = rowCfg.id;
    const th = document.createElement("th");
    th.textContent = rowCfg.label || "Custom";
    if ((th.textContent || "").length > 12) th.classList.add("wrapCell");
    th.classList.add("summaryDragHandle");
    th.draggable = false;
    tr.appendChild(th);
    for (let c = 0; c < ratioLabels.length; c++) {
      const td = document.createElement("td");
      td.classList.add("ratioCell", "summaryCell");
      td.dataset.r = rowCfg.id;
      td.dataset.c = String(c);
      td.dataset.col = String(c);
      td.style.textAlign = "right";
      ratioStrikeSet.delete(`${rowCfg.id},${c}`);
      tr.appendChild(td);
    }
    summaryBody.appendChild(tr);
  });

  const tbody = document.createElement("tbody");
  for (let r = 0; r < origins.length; r++) {
    const tr = document.createElement("tr");
    const rowHead = document.createElement("th");
    rowHead.textContent = String(origins[r] ?? "");
    tr.appendChild(rowHead);

    for (let c = 0; c < ratioLabels.length; c++) {
      const td = document.createElement("td");
      td.className = "cell ratioCell";
      td.dataset.r = String(r);
      td.dataset.c = String(c);
      td.dataset.col = String(c);
      const strikeKey = `${r},${c}`;

      if (c >= devs.length - 1) {
        td.textContent = "";
        td.classList.add("na");
        td.classList.remove("ratioPlaceholder");
        ratioStrikeSet.delete(strikeKey);
      } else {
        const hasA = !!(mask[r] && mask[r][c]);
        const hasB = !!(mask[r] && mask[r][c + 1]);
        if (hasA && hasB) {
          const ratio = calcRatio(vals?.[r]?.[c], vals?.[r]?.[c + 1]);
          if (Number.isFinite(ratio)) {
            const rounded = roundRatio(ratio, 6);
            td.textContent = formatRatio(rounded, 4);
            td.classList.remove("ratioPlaceholder");
          } else {
            td.textContent = "1.0000";
            td.classList.add("ratioPlaceholder");
            ratioStrikeSet.delete(strikeKey);
          }
          td.classList.remove("na");
        } else {
          td.textContent = "";
          td.classList.add("na");
          td.classList.remove("ratioPlaceholder");
          ratioStrikeSet.delete(strikeKey);
        }
        if (ratioStrikeSet.has(strikeKey)) td.classList.add("strike");
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  summaryTable.appendChild(summaryBody);

  const selectedTable = document.createElement("table");
  selectedTable.classList.add("ratioSelectedTable");
  const selectedBody = document.createElement("tbody");
  const selectedRow = document.createElement("tr");
  selectedRow.dataset.rowId = "selected";
  const selectedTh = document.createElement("th");
  selectedTh.textContent = "Selected";
  selectedRow.appendChild(selectedTh);
  for (let c = 0; c < ratioLabels.length; c++) {
    const td = document.createElement("td");
    td.dataset.col = String(c);
    td.style.textAlign = "right";
    selectedRow.appendChild(td);
  }
  selectedBody.appendChild(selectedRow);
  const cumulativeRow = document.createElement("tr");
  cumulativeRow.dataset.rowId = "cumulative";
  const cumulativeTh = document.createElement("th");
  cumulativeTh.textContent = "Cumulative";
  cumulativeRow.appendChild(cumulativeTh);
  for (let c = 0; c < ratioLabels.length; c++) {
    const td = document.createElement("td");
    td.dataset.col = String(c);
    td.style.textAlign = "right";
    cumulativeRow.appendChild(td);
  }
  selectedBody.appendChild(cumulativeRow);
  selectedTable.appendChild(selectedBody);

  wrap.appendChild(table);
  wrap.appendChild(summaryTable);
  wrap.appendChild(selectedTable);
  applyNaBorderVisibility();

  const orderKey = getSummaryOrderKey();
  const savedOrder = loadSummaryOrder(orderKey);
  if (savedOrder) applySummaryOrder(summaryBody, savedOrder);
  wireSummaryRowDrag(summaryBody, orderKey);
  wireSummaryContextMenu(summaryTable);

  requestAnimationFrame(() => {
    const headerCells = table.querySelectorAll("thead th");
    const summaryRows = summaryTable.querySelectorAll("tr");
    const selectedRows = selectedTable.querySelectorAll("tr");
    const allRows = [...summaryRows, ...selectedRows];
    if (!headerCells.length || !allRows.length) return;
    headerCells.forEach((cell, idx) => {
      const w = Math.round(cell.getBoundingClientRect().width);
      if (!w) return;
      allRows.forEach((row) => {
        const target = row.children[idx];
        if (!target) return;
        target.style.width = `${w}px`;
        target.style.minWidth = `${w}px`;
        target.style.maxWidth = `${w}px`;
      });
    });
  });

  updateRatioSummary();
  initDefaultSummarySelection(summaryTable);
  applySummarySelection(summaryTable, selectedTable);
  applyRatioColHighlight();
  wireSummarySelection(summaryTable, selectedTable);
}

function getActiveRatioCols(model) {
  const devs = getEffectiveDevLabelsForModel(model);
  const lastCol = devs.length - 2;
  if (lastCol < 0) return [];
  if (activeRatioCol === "all") {
    return Array.from({ length: lastCol + 1 }, (_, i) => i);
  }
  if (!Number.isFinite(activeRatioCol)) return [];
  const col = activeRatioCol;
  if (col < 0 || col > lastCol) return [];
  return [col];
}

function excludeExtremeInCol(model, col, mode) {
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) return;
  const devs = getEffectiveDevLabelsForModel(model);
  if (col < 0 || col >= devs.length - 1) return;

  const vals = model.values;
  const mask = model.mask;
  const origins = model.origin_labels || [];
  let best = null;
  let bestKey = null;

  for (let r = 0; r < origins.length; r++) {
    const key = `${r},${col}`;
    if (ratioStrikeSet.has(key)) continue;
    const hasA = !!(mask[r] && mask[r][col]);
    const hasB = !!(mask[r] && mask[r][col + 1]);
    if (!hasA || !hasB) continue;
    const ratio = calcRatio(vals?.[r]?.[col], vals?.[r]?.[col + 1]);
    if (!Number.isFinite(ratio)) continue;
    if (best === null) {
      best = ratio;
      bestKey = key;
      continue;
    }
    if (mode === "high" && ratio > best) {
      best = ratio;
      bestKey = key;
    } else if (mode === "low" && ratio < best) {
      best = ratio;
      bestKey = key;
    }
  }

  if (!bestKey) return;
  ratioStrikeSet.add(bestKey);
  const cell = document.querySelector(`#ratioWrap td.ratioCell[data-r="${bestKey.split(",")[0]}"][data-col="${col}"]`);
  if (cell) cell.classList.add("strike");
}

function excludeExtremeInActiveCol(mode) {
  const model = state.model;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) return;
  const cols = getActiveRatioCols(model);
  if (!cols.length) return;
  cols.forEach((col) => excludeExtremeInCol(model, col, mode));
  scheduleRatioSummaryUpdate();
  onRatioStateMutated();
}

function includeAllInActiveCol() {
  const model = state.model;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) return;
  const origins = model.origin_labels || [];
  const cols = getActiveRatioCols(model);
  const allCols = cols.length
    ? cols
    : Array.from({ length: Math.max(0, getEffectiveDevLabelsForModel(model).length - 1) }, (_, i) => i);
  allCols.forEach((col) => {
    for (let r = 0; r < origins.length; r++) {
      const key = `${r},${col}`;
      if (ratioStrikeSet.has(key)) {
        ratioStrikeSet.delete(key);
        const cell = document.querySelector(`#ratioWrap td.ratioCell[data-r="${r}"][data-col="${col}"]`);
        if (cell) cell.classList.remove("strike");
      }
    }
  });
  scheduleRatioSummaryUpdate();
  onRatioStateMutated();
}

function wireDfmSpinnerControls() {
  const spinners = Array.from(document.querySelectorAll(".dfmSpinner"));
  if (!spinners.length) return;
  const bumpSelect = (selectEl, delta) => {
    if (!selectEl || !selectEl.options?.length) return;
    const maxIdx = selectEl.options.length - 1;
    const current = Number.isFinite(selectEl.selectedIndex) ? selectEl.selectedIndex : 0;
    const getNum = (opt) => {
      const raw = opt?.value ?? opt?.text ?? "";
      const n = parseFloat(String(raw).replace(/[^\d.\-]/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    const first = getNum(selectEl.options[0]);
    const second = getNum(selectEl.options[1]);
    let ascending = true;
    if (first !== null && second !== null) {
      ascending = second > first;
    }
    const step = ascending ? delta : -delta;
    const next = Math.max(0, Math.min(maxIdx, current + step));
    if (next === current) return;
    selectEl.selectedIndex = next;
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const bumpNumber = (inputEl, delta) => {
    if (!inputEl) return;
    const stepRaw = parseFloat(inputEl.step);
    const step = Number.isFinite(stepRaw) && stepRaw > 0 ? stepRaw : 1;
    const minRaw = parseFloat(inputEl.min);
    const maxRaw = parseFloat(inputEl.max);
    const min = Number.isFinite(minRaw) ? minRaw : null;
    const max = Number.isFinite(maxRaw) ? maxRaw : null;
    const curRaw = parseFloat(inputEl.value);
    let next = Number.isFinite(curRaw) ? curRaw + step * delta : step * delta;
    if (min !== null) next = Math.max(min, next);
    if (max !== null) next = Math.min(max, next);
    inputEl.value = String(next);
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
  };

  spinners.forEach((spinner) => {
    if (spinner.dataset.wired === "1") return;
    spinner.dataset.wired = "1";
    const control = spinner.querySelector("select, input");
    const upBtn = spinner.querySelector(".dfmSpinBtn.up");
    const downBtn = spinner.querySelector(".dfmSpinBtn.down");
    if (!control || !upBtn || !downBtn) return;

    const bump = (delta) => {
      if (control.tagName?.toLowerCase() === "select") {
        bumpSelect(control, delta);
      } else {
        bumpNumber(control, delta);
      }
    };

    upBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      bump(1);
    });
    downBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      bump(-1);
    });
  });
}

function wireRatioStrikeToggle() {
  const wrap = document.getElementById("ratioWrap");
  if (!wrap || wrap.dataset.strikeWired === "1") return;
  wrap.dataset.strikeWired = "1";
  let dragActive = false;
  let lastKey = null;

  const toggleStrike = (cell) => {
    if (!cell || cell.classList.contains("na") || cell.classList.contains("ratioPlaceholder")) return;
    const r = cell.dataset.r;
    const c = cell.dataset.c;
    if (r == null || c == null) return;
    if (r === "sum") return;
    const key = `${r},${c}`;
    if (ratioStrikeSet.has(key)) {
      ratioStrikeSet.delete(key);
      cell.classList.remove("strike");
    } else {
      ratioStrikeSet.add(key);
      cell.classList.add("strike");
    }
    scheduleRatioSummaryUpdate();
    onRatioStateMutated();
  };

  wrap.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const cell = e.target?.closest?.("td.ratioCell");
    if (!cell || cell.classList.contains("na") || cell.classList.contains("ratioPlaceholder")) return;
    if (cell.dataset.r === "sum") return;
    e.preventDefault();
    dragActive = true;
    const key = `${cell.dataset.r},${cell.dataset.c}`;
    lastKey = key;
    toggleStrike(cell);
  });

  wrap.addEventListener("mousemove", (e) => {
    if (!dragActive) return;
    const cell = e.target?.closest?.("td.ratioCell");
    if (!cell) return;
    if (cell.dataset.r === "sum") return;
    const key = `${cell.dataset.r},${cell.dataset.c}`;
    if (key === lastKey) return;
    lastKey = key;
    toggleStrike(cell);
  });

  window.addEventListener("mouseup", () => {
    dragActive = false;
    lastKey = null;
  });

  wrap.addEventListener("click", (e) => {
    const th = e.target?.closest?.("th[data-col]");
    if (!th) return;
    const colRaw = th.dataset.col;
    if (colRaw === "all") {
      activeRatioCol = (activeRatioCol === "all") ? null : "all";
    } else {
      const col = Number(colRaw);
      if (!Number.isFinite(col)) return;
      activeRatioCol = (activeRatioCol === col) ? null : col;
    }
    applyRatioColHighlight();
    notifyDfmEditState();
  });
}

function handleDatasetUpdated() {
  if (isRatiosTabVisible()) renderRatioTable();
  if (isResultsTabVisible()) renderResultsTable();
  syncMethodNameFromInputs();
  scheduleRatioSelectionLoad("dataset-updated");
}

function moveDetailsControls() {
  // DFM now uses its own markup; nothing to move.
}

function initDfmTabs() {
  // Check required page elements exist
  const detailsPage = document.getElementById("dfmDetailsPage");
  const dataPage = document.getElementById("dfmDataPage");
  const ratiosPage = document.getElementById("dfmRatiosPage");
  const resultsPage = document.getElementById("dfmResultsPage");
  if (!detailsPage || !dataPage || !ratiosPage || !resultsPage) return;

  // Apply results-only mode classes
  if (resultsOnlyMode) {
    document.documentElement.classList.add("results-only");
    document.body.classList.add("results-only");
  }

  // Load saved preferences
  showNaBorders = loadNaBorders();

  // Wire up DFM-specific controls
  moveDetailsControls();
  wireDfmSpinnerControls();
  wireMethodName();
  wireRatioStrikeToggle();
  wireRatioContextMenu();
  wireResultsTabContextMenu();
  wireResultsTitlebar();

  // Determine initial tab
  const params = new URLSearchParams(window.location.search);
  const urlTab = params.get("tab");
  const initialTab = resultsOnlyMode
    ? "results"
    : ALLOWED_DFM_TABS.has(urlTab) ? urlTab : "details";

  // Create tab system using reusable component
  const tabSystem = createTabbedPage(document.body, {
    tabs: [
      { id: "details", label: "Details" },
      { id: "data", label: "Data" },
      { id: "ratios", label: "Ratios" },
      { id: "results", label: "Results" }
    ],
    cssPrefix: "dfm",
    initialTab,
    injectTabBar: false, // Use existing tab bar in HTML
    onTabChange: (tabId) => {
      currentDfmTab = tabId;
      if (tabId === "ratios") renderRatioTable();
      if (tabId === "results") renderResultsTable();
      if (tabId === "data") {
        // Data tab can be hidden while dataset renders; redraw after layout is visible.
        requestAnimationFrame(() => {
          requestAnimationFrame(redrawChartSafely);
        });
      }
      notifyDfmEditState();
      if (tabId === "details") syncMethodNameFromInputs();
    }
  });

  // Expose for external access if needed
  window.dfmTabSystem = tabSystem;
}

export function initDfmRatios() {
  initDfmTabs();
  notifyDfmEditState();
  syncMethodNameFromInputs();
  wireRatioSyncChannel();
  requestRatioStateSync();

  window.addEventListener("adas:dataset-updated", handleDatasetUpdated);

  window.addEventListener("message", (e) => {
    if (e?.data?.type === "adas:dfm-request-state" || e?.data?.type === "adas:dfm-tab-activated") {
      notifyDfmEditState();
      scheduleRatioSelectionLoad("tab-activated");
      return;
    }
    if (e?.data?.type === "adas:dfm-exclude-high") {
      const ratiosPage = document.getElementById("dfmRatiosPage");
      if (!ratiosPage || ratiosPage.style.display === "none") return;
      excludeExtremeInActiveCol("high");
      return;
    }
    if (e?.data?.type === "adas:dfm-exclude-low") {
      const ratiosPage = document.getElementById("dfmRatiosPage");
      if (!ratiosPage || ratiosPage.style.display === "none") return;
      excludeExtremeInActiveCol("low");
      return;
    }
    if (e?.data?.type === "adas:dfm-include-all") {
      const ratiosPage = document.getElementById("dfmRatiosPage");
      if (!ratiosPage || ratiosPage.style.display === "none") return;
      includeAllInActiveCol();
      return;
    }
    if (e?.data?.type === "adas:dfm-save") {
      saveRatioSelectionPattern(false);
      return;
    }
    if (e?.data?.type === "adas:dfm-save-as") {
      saveRatioSelectionPattern(true);
      return;
    }
  });

  window.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    const key = (e.key || "").toLowerCase();
    if (key !== "h" && key !== "l" && key !== "i") return;
    const tag = e.target?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || e.target?.isContentEditable) return;
    const ratiosPage = document.getElementById("dfmRatiosPage");
    if (!ratiosPage || ratiosPage.style.display === "none") return;
    e.preventDefault();
    if (key === "h") excludeExtremeInActiveCol("high");
    if (key === "l") excludeExtremeInActiveCol("low");
    if (key === "i") includeAllInActiveCol();
  }, { capture: true });
}

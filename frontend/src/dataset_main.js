// Entry point: orchestrates load/save/toggle and wires events.

import { state } from "./state.js";
import { config } from "./config.js";
import { $, logLine } from "./dom.js";
import { getDataset, patchDataset } from "./api.js";
import { parseFormulaInput } from "./formula.js";
import { renderTable, renderActiveCellUI, renderChart, redrawChartSafely} from "./render.js";

const ZOOM_STORAGE_KEY = "adas_ui_zoom_pct";
const ZOOM_MODE_KEY = "adas_zoom_mode";
const FONT_STORAGE_KEY = "adas_app_font";

function applyZoomValue(v) {
  try {
    if (localStorage.getItem(ZOOM_MODE_KEY) === "host") return;
  } catch {}
  const z = Number(v);
  if (!Number.isFinite(z)) return;
  const root = document.documentElement;
  const body = document.body;
  const scale = Math.max(0.5, Math.min(2, z / 100));
  if (root) root.style.zoom = String(scale);
  if (body) body.style.zoom = String(scale);
}

function buildFontStack(font) {
  const raw = String(font || "").trim();
  if (!raw) return "";
  if (raw.includes(",")) return raw;
  const primary = /\s/.test(raw) ? `"${raw.replace(/\"/g, "")}"` : raw;
  return `${primary}, "Segoe UI", "SegoeUI", Tahoma, Arial, sans-serif`;
}

function applyAppFont(font) {
  const stack = buildFontStack(font);
  if (!stack) return;
  const root = document.documentElement;
  if (root) root.style.setProperty("--app-font", stack);
  if (document.body) document.body.style.fontFamily = stack;
}

function loadAppFontFromStorage() {
  try {
    const raw = localStorage.getItem(FONT_STORAGE_KEY);
    if (raw && typeof raw === "string") return raw;
  } catch {}
  return "";
}

function loadZoomFromStorage() {
  try {
    const raw = localStorage.getItem(ZOOM_STORAGE_KEY);
    if (!raw) return 100;
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0) return v;
  } catch {}
  return 100;
}

applyZoomValue(loadZoomFromStorage());
applyAppFont(loadAppFontFromStorage());

function notifyDatasetUpdated() {
  window.dispatchEvent(new CustomEvent("adas:dataset-updated"));
}

window.addEventListener("message", (e) => {
  if (e?.data?.type === "adas:set-zoom") {
    applyZoomValue(e.data.zoom);
  }
  if (e?.data?.type === "adas:set-app-font") {
    applyAppFont(e.data.font);
  }
});

window.addEventListener("mousedown", () => {
  window.parent.postMessage({ type: "adas:close-shell-menus" }, "*");
}, { capture: true });

function requestCloseActiveTab() {
  window.parent.postMessage({ type: "adas:close-active-tab" }, "*");
}

window.addEventListener("keydown", (e) => {
  const key = (e.key || "").toLowerCase();
  if (e.altKey && key === "w") {
    e.preventDefault();
    e.stopPropagation();
    requestCloseActiveTab();
    return;
  }
  if (e.ctrlKey && key === "q") {
    e.preventDefault();
    e.stopPropagation();
    window.parent.postMessage({ type: "adas:hotkey", action: "app_shutdown" }, "*");
    return;
  }
  if (e.ctrlKey) {
    if (key === "s") {
      e.preventDefault();
      e.stopPropagation();
      const action = e.shiftKey ? "file_save_as" : "file_save";
      window.parent.postMessage({ type: "adas:hotkey", action }, "*");
      return;
    }
    if (key === "o") {
      e.preventDefault();
      e.stopPropagation();
      window.parent.postMessage({ type: "adas:hotkey", action: "file_import" }, "*");
      return;
    }
    if (key === "p") {
      e.preventDefault();
      e.stopPropagation();
      window.parent.postMessage({ type: "adas:hotkey", action: "file_print" }, "*");
      return;
    }
    if (e.shiftKey && key === "f") {
      e.preventDefault();
      e.stopPropagation();
      window.parent.postMessage({ type: "adas:hotkey", action: "view_toggle_nav" }, "*");
      return;
    }
  }
  if (e.altKey && key === "r" && e.ctrlKey) {
    e.preventDefault();
    e.stopPropagation();
    window.parent.postMessage({ type: "adas:hotkey", action: "file_restart" }, "*");
    return;
  }
}, { capture: true });

document.addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  window.parent.postMessage({ type: "adas:zoom", deltaY: e.deltaY }, "*");
}, { capture: true, passive: false });

// -----------------------------
// Persist dataset across refresh
// -----------------------------
const LS_DS_KEY = "adas_last_ds_id";
const LS_FORM_KEY = "adas_tri_inputs";

// Per-instance storage (e.g. workflow embeds)
const qs = new URLSearchParams(window.location.search);
const instanceId = qs.get("inst") || "default";
const stepId = instanceId.startsWith("step_") ? instanceId : null;
const scopedKey = (k) => `${k}::${instanceId}`;

let syncingLen = false;
let allProjects = [];
let lastProjectSelection = "";
let activeProjectIndex = -1;
let allDatasetTypes = [];
let activeDatasetIndex = -1;
let lastDatasetSelection = "";
let projectBookSheetName = "";
let projectBookValues = null;

function normalizeProjectText(s) {
  return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeSearchTokens(q) {
  return normalizeProjectText(q).split(" ").filter(Boolean);
}

function matchesProject(name, tokens) {
  if (!tokens.length) return true;
  const hay = normalizeProjectText(name);
  return tokens.every(t => hay.includes(t));
}

function getActiveProjectValue() {
  const list = document.getElementById("projectDropdown");
  if (!list) return "";
  const opt = list.children[activeProjectIndex];
  return opt?.dataset?.value || "";
}

function renderProjectOptions(projects, activeValue = "") {
  const list = document.getElementById("projectDropdown");
  if (!list) return;
  list.innerHTML = "";
  projects.forEach((p, i) => {
    const opt = document.createElement("div");
    opt.className = "projectOption";
    opt.textContent = p;
    opt.dataset.value = p;
    opt.dataset.index = String(i);
    opt.addEventListener("mouseenter", () => {
      setActiveProjectIndex(i);
    });
    opt.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const projectInput = document.getElementById("projectSelect");
      if (projectInput) projectInput.value = p;
      showProjectDropdown(false);
      void handleProjectSelection(p);
    });
    list.appendChild(opt);
  });

  activeProjectIndex = -1;
  if (projects.length) {
    const idx = activeValue ? Math.max(0, projects.indexOf(activeValue)) : 0;
    setActiveProjectIndex(idx);
  }
}

function showProjectDropdown(open) {
  const list = document.getElementById("projectDropdown");
  if (!list) return;
  const hasItems = !!list.children.length;
  if (open && hasItems) list.classList.add("open");
  else list.classList.remove("open");
}

function filterProjectOptions(query) {
  if (!allProjects.length) return;
  const tokens = normalizeSearchTokens(query);
  const filtered = tokens.length
    ? allProjects.filter(p => matchesProject(p, tokens))
    : allProjects;
  const activeValue = getActiveProjectValue();
  renderProjectOptions(filtered, activeValue);
  showProjectDropdown(true);
}

function getProjectOptionsList() {
  const list = document.getElementById("projectDropdown");
  if (!list) return [];
  return Array.from(list.children);
}

function setActiveProjectIndex(idx) {
  const opts = getProjectOptionsList();
  if (!opts.length) {
    activeProjectIndex = -1;
    return;
  }
  let next = idx;
  if (next < 0) next = opts.length - 1;
  if (next >= opts.length) next = 0;
  activeProjectIndex = next;
  opts.forEach((el, i) => el.classList.toggle("active", i === activeProjectIndex));
  opts[activeProjectIndex].scrollIntoView({ block: "nearest" });
}

function chooseActiveProject() {
  const opts = getProjectOptionsList();
  if (activeProjectIndex < 0 || activeProjectIndex >= opts.length) return false;
  const value = opts[activeProjectIndex].dataset.value || opts[activeProjectIndex].textContent;
  if (!value) return false;
  const projectInput = document.getElementById("projectSelect");
  if (projectInput) projectInput.value = value;
  showProjectDropdown(false);
  void handleProjectSelection(value);
  return true;
}

function findExactProjectMatch(value) {
  const v = normalizeProjectText(value);
  if (!v) return "";
  return allProjects.find(p => normalizeProjectText(p) === v) || "";
}

function getActiveDatasetValue() {
  const list = document.getElementById("datasetDropdown");
  if (!list) return "";
  const opt = list.children[activeDatasetIndex];
  return opt?.dataset?.value || "";
}

function renderDatasetOptions(items, activeValue = "") {
  const list = document.getElementById("datasetDropdown");
  if (!list) return;
  list.innerHTML = "";
  items.forEach((name, i) => {
    const opt = document.createElement("div");
    opt.className = "datasetOption";
    opt.textContent = name;
    opt.dataset.value = name;
    opt.dataset.index = String(i);
    opt.addEventListener("mouseenter", () => {
      setActiveDatasetIndex(i);
    });
    opt.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const triInput = document.getElementById("triInput");
      if (triInput) triInput.value = name;
      showDatasetDropdown(false);
      void handleDatasetSelection(name);
    });
    list.appendChild(opt);
  });

  activeDatasetIndex = -1;
  if (items.length) {
    const idx = activeValue ? Math.max(0, items.indexOf(activeValue)) : 0;
    setActiveDatasetIndex(idx);
  }
}

function showDatasetDropdown(open) {
  const list = document.getElementById("datasetDropdown");
  if (!list) return;
  const hasItems = !!list.children.length;
  if (open && hasItems) list.classList.add("open");
  else list.classList.remove("open");
}

function filterDatasetOptions(query) {
  if (!allDatasetTypes.length) {
    showDatasetDropdown(false);
    return;
  }
  const tokens = normalizeSearchTokens(query);
  const filtered = tokens.length
    ? allDatasetTypes.filter(name => matchesProject(name, tokens))
    : allDatasetTypes;
  const activeValue = getActiveDatasetValue();
  renderDatasetOptions(filtered, activeValue);
  showDatasetDropdown(true);
}

function getDatasetOptionsList() {
  const list = document.getElementById("datasetDropdown");
  if (!list) return [];
  return Array.from(list.children);
}

function setActiveDatasetIndex(idx) {
  const opts = getDatasetOptionsList();
  if (!opts.length) {
    activeDatasetIndex = -1;
    return;
  }
  let next = idx;
  if (next < 0) next = opts.length - 1;
  if (next >= opts.length) next = 0;
  activeDatasetIndex = next;
  opts.forEach((el, i) => el.classList.toggle("active", i === activeDatasetIndex));
  opts[activeDatasetIndex].scrollIntoView({ block: "nearest" });
}

function chooseActiveDataset() {
  const opts = getDatasetOptionsList();
  if (activeDatasetIndex < 0 || activeDatasetIndex >= opts.length) return false;
  const value = opts[activeDatasetIndex].dataset.value || opts[activeDatasetIndex].textContent;
  if (!value) return false;
  const triInput = document.getElementById("triInput");
  if (triInput) triInput.value = value;
  showDatasetDropdown(false);
  void handleDatasetSelection(value);
  return true;
}

function findExactDatasetMatch(value) {
  const v = normalizeProjectText(value);
  if (!v) return "";
  return allDatasetTypes.find(name => normalizeProjectText(name) === v) || "";
}

const LS_DATASET_TYPES_PREFIX = scopedKey("adas_dataset_types::");

function datasetTypesKey(project) {
  return `${LS_DATASET_TYPES_PREFIX}${normalizeProjectText(project)}`;
}

function loadDatasetTypesCache(project) {
  try {
    const raw = localStorage.getItem(datasetTypesKey(project)) || "";
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.items)) return null;
    return obj;
  } catch {
    return null;
  }
}

function saveDatasetTypesCache(project, items, settingsPath) {
  try {
    localStorage.setItem(
      datasetTypesKey(project),
      JSON.stringify({ items, settingsPath: settingsPath || "" })
    );
  } catch {
    // ignore
  }
}

async function ensureProjectBookLoaded() {
  if (projectBookValues && projectBookValues.length) return true;
  const metaRes = await fetch("/project_book/meta");
  if (!metaRes.ok) return false;
  const meta = await metaRes.json();
  projectBookSheetName = (meta.sheets || [])[0] || "";
  if (!projectBookSheetName) return false;

  const sheetRes = await fetch(`/project_book/sheet?sheet=${encodeURIComponent(projectBookSheetName)}`);
  if (!sheetRes.ok) return false;
  const out = await sheetRes.json();
  projectBookValues = out.values || [];
  return true;
}

function findProjectSettingsPath(project) {
  if (!projectBookValues || !projectBookValues.length) return "";
  const header = projectBookValues[0] || [];
  let projectCol = 0;
  let settingsCol = -1;

  for (let c = 0; c < header.length; c++) {
    const label = String(header[c] || "").trim().toLowerCase();
    if (label === "project name" || label === "projectname") projectCol = c;
    if (label === "project settings") settingsCol = c;
  }

  if (settingsCol < 0) return "";

  const target = normalizeProjectText(project);
  for (let r = 1; r < projectBookValues.length; r++) {
    const row = projectBookValues[r] || [];
    const name = normalizeProjectText(row[projectCol] || "");
    if (!name || name !== target) continue;
    const rawPath = row[settingsCol];
    const pathStr = rawPath === null || rawPath === undefined ? "" : String(rawPath).trim();
    return pathStr;
  }
  return "";
}

function parseDatasetTypes(values) {
  if (!values || !values.length) return [];
  const header = (values[0] || []).map(v => String(v || "").trim().toLowerCase());
  const nameCol = header.indexOf("name");
  const hasHeader = nameCol >= 0;
  const col = hasHeader ? nameCol : 0;
  const startRow = hasHeader ? 1 : 0;

  const out = [];
  const seen = new Set();
  for (let r = startRow; r < values.length; r++) {
    const v = values[r]?.[col];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

async function fetchDatasetTypesForProject(project) {
  const ok = await ensureProjectBookLoaded();
  if (!ok) return { items: [], settingsPath: "" };
  const settingsPath = findProjectSettingsPath(project);
  if (!settingsPath) return { items: [], settingsPath: "" };

  const res = await fetch("/book/sheet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ book_path: settingsPath, sheet: "Dataset Types" }),
  });
  if (!res.ok) return { items: [], settingsPath };
  const out = await res.json();
  const items = parseDatasetTypes(out.values || []);
  return { items, settingsPath };
}

async function refreshDatasetTypesForProject(project, useCache = true) {
  if (!project) {
    allDatasetTypes = [];
    renderDatasetOptions([]);
    showDatasetDropdown(false);
    return;
  }

  lastDatasetSelection = "";

  if (useCache) {
    const cached = loadDatasetTypesCache(project);
    if (cached && Array.isArray(cached.items)) {
      allDatasetTypes = cached.items;
      renderDatasetOptions(allDatasetTypes);
      showDatasetDropdown(false);
    } else {
      allDatasetTypes = [];
      renderDatasetOptions([]);
      showDatasetDropdown(false);
    }
  } else {
    allDatasetTypes = [];
    renderDatasetOptions([]);
    showDatasetDropdown(false);
  }

  const { items, settingsPath } = await fetchDatasetTypesForProject(project);
  if (items.length) {
    allDatasetTypes = items;
    renderDatasetOptions(items);
    showDatasetDropdown(false);
    saveDatasetTypesCache(project, items, settingsPath);
  }
}

async function handleDatasetSelection(value) {
  const name = findExactDatasetMatch(value);
  if (!name) return;
  if (name === lastDatasetSelection) return;
  lastDatasetSelection = name;

  const triInput = document.getElementById("triInput");
  if (triInput) triInput.value = name;
  showDatasetDropdown(false);
  saveTriInputsToStorage();
  scheduleAutoRun();
}

function isLenLinked() {
  return !!document.getElementById("linkLenChk")?.checked;
}

function syncLen(from) {
  const o = document.getElementById("originLenSelect");
  const d = document.getElementById("devLenSelect");
  if (!o || !d) return;
  if (!isLenLinked()) return;
  if (syncingLen) return;

  syncingLen = true;
  try {
    if (from === "origin") {
      d.value = o.value;
    } else if (from === "dev") {
      o.value = d.value;
    } else {
      // init / unknown
      d.value = o.value;
    }
  } finally {
    syncingLen = false;
  }
}

function saveLastDsId(dsId) {
  if (!dsId) return;
  try {
    localStorage.setItem(scopedKey(LS_DS_KEY), String(dsId));
  } catch {
    // ignore
  }
}

function loadLastDsId() {
  try {
    return localStorage.getItem(scopedKey(LS_DS_KEY)) || "";
  } catch {
    return "";
  }
}

// Persist ADASTri input controls so refresh doesn't reset them.
function saveTriInputsToStorage() {
  try {
    const payload = {
      project: document.getElementById("projectSelect")?.value || "",
      path: document.getElementById("pathInput")?.value || "",
      tri: document.getElementById("triInput")?.value || "",
      originLen: document.getElementById("originLenSelect")?.value || "",
      devLen: document.getElementById("devLenSelect")?.value || "",
      linkLen: document.getElementById("linkLenChk")?.checked || false,
      cumulative: document.getElementById("cumulativeChk")?.checked || true,
    };
    localStorage.setItem(scopedKey(LS_FORM_KEY), JSON.stringify(payload));
    try {
      window.parent.postMessage({
        type: "adas:dataset-settings-changed",
        stepId: instanceId,
        settings: payload,
      }, "*");
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
}

function restoreTriInputsFromStorage() {
  let raw = "";
  try {
    raw = localStorage.getItem(scopedKey(LS_FORM_KEY)) || "";
  } catch {
    raw = "";
  }
  if (!raw) return;

  let s = null;
  try {
    s = JSON.parse(raw);
  } catch {
    return;
  }
  if (!s || typeof s !== "object") return;

  const projectInput = document.getElementById("projectSelect");
  const pathInput = document.getElementById("pathInput");
  const triInput = document.getElementById("triInput");
  const originSel = document.getElementById("originLenSelect");
  const devSel = document.getElementById("devLenSelect");

  // Only restore if the saved value is valid in the current UI.
  if (projectInput && s.project) {
    const match = findExactProjectMatch(s.project);
    projectInput.value = match || s.project;
  }
  if (pathInput && typeof s.path === "string" && s.path.trim()) pathInput.value = s.path;
  if (triInput && typeof s.tri === "string" && s.tri.trim()) triInput.value = s.tri;

  if (originSel && s.originLen && [...originSel.options].some(o => o.value === String(s.originLen))) {
    originSel.value = String(s.originLen);
  }
  if (devSel && s.devLen && [...devSel.options].some(o => o.value === String(s.devLen))) {
    devSel.value = String(s.devLen);
  }

  const linkChk = document.getElementById("linkLenChk");
  if (linkChk && typeof s.linkLen === "boolean") linkChk.checked = s.linkLen;

  const cumChk = document.getElementById("cumulativeChk");
  if (cumChk && typeof s.cumulative === "boolean") cumChk.checked = s.cumulative;

}

// NEW: allow shell to specify dataset id via ?ds=xxx
const dsFromUrl = qs.get("ds");

// Priority:
//  1) ?ds=... in URL
//  2) localStorage persisted value
//  3) config default
if (dsFromUrl) {
  config.DS_ID = dsFromUrl;
  saveLastDsId(dsFromUrl);
} else {
  const saved = loadLastDsId();
  if (saved) config.DS_ID = saved;
}

const LEN_CHOICES = [12, 6, 3, 1];

function fillLenDropdowns() {
  const o = document.getElementById("originLenSelect");
  const d = document.getElementById("devLenSelect");
  if (!o || !d) return;

  o.innerHTML = "";
  d.innerHTML = "";

  for (const n of LEN_CHOICES) {
    const opt1 = document.createElement("option");
    opt1.value = String(n);
    opt1.textContent = String(n);
    o.appendChild(opt1);

    const opt2 = document.createElement("option");
    opt2.value = String(n);
    opt2.textContent = String(n);
    d.appendChild(opt2);
  }

  // defaults
  o.value = "12";
  d.value = "12";
}

async function loadProjectsDropdown() {
  const input = document.getElementById("projectSelect");
  const list = document.getElementById("projectDropdown");
  if (!input || !list) return;

  const resp = await fetch("/adas/projects");
  if (!resp.ok) return;

  const data = await resp.json();
  allProjects = data.projects || [];
  renderProjectOptions(allProjects);
  showProjectDropdown(false);

  // default values you requested
  const pathInput = document.getElementById("pathInput");
  const triInput = document.getElementById("triInput");
  if (pathInput && !pathInput.value) pathInput.value = "PRNJ - PA\\PA\\NJ\\Direct Group\\COL";
  if (triInput && !triInput.value) triInput.value = "Net Loss--Incurred";

  // pick default project if exists
  const defaultProj = "NJ_Annual_Prod_2025 Dec";
  if (allProjects.some(p => p === defaultProj)) input.value = defaultProj;
}

let autoRunTimer = null;
let lastAutoKey = "";
let runInFlight = false;

function getTriInputs() {
  const project = document.getElementById("projectSelect")?.value || "";
  const path = (document.getElementById("pathInput")?.value || "").trim();
  const tri = (document.getElementById("triInput")?.value || "").trim();
  const originLen = parseInt(document.getElementById("originLenSelect")?.value, 10);
  const devLen = parseInt(document.getElementById("devLenSelect")?.value, 10);
  const cumulative = !!document.getElementById("cumulativeChk")?.checked;

  return {
    project,
    path,
    tri,
    cumulative,
    originLen: Number.isFinite(originLen) ? originLen : 12,
    devLen: Number.isFinite(devLen) ? devLen : 12,
  };
}


function scheduleAutoRun(delayMs = 150) {
  if (autoRunTimer) clearTimeout(autoRunTimer);
  autoRunTimer = setTimeout(() => autoRun(), delayMs);
}

function bindAutoRunOnEnter(el) {
  if (!el) return;

  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;

    e.preventDefault();
    el.blur();
    scheduleAutoRun(0);
  });
}

async function autoRun() {
  const { project, path, tri, cumulative, originLen, devLen } = getTriInputs();

  if (!project || !path || !tri) return;

  const key = `${project}||${path}||${tri}||${cumulative}||${originLen}||${devLen}`;

  if (key === lastAutoKey) return;

  if (runInFlight) return;

  lastAutoKey = key;
  await runAdasTri();
}

async function runAdasTri() {
  if (runInFlight) return;
  runInFlight = true;

  const btn = document.getElementById("runAdasTriBtn");
  const status = document.getElementById("adasTriStatus");
  const { project, path, tri, cumulative, originLen, devLen } = getTriInputs();

  if (status) status.textContent = "Sending request...";
  if (btn) btn.disabled = true;

  try {
    const resp = await fetch("/adas/tri", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Path: path,
        TriangleName: tri,
        ProjectName: project,
        Cumulative: cumulative,
        OriginLength: originLen,
        DevelopmentLength: devLen,
        timeout_sec: 6.0,
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      logLine(`ADASTri failed: ${resp.status}`);
      if (status) status.textContent = `Error: ${resp.status}`;
      return;
    }

    if (!data.ok) {
      logLine(`ADASTri timeout. data_path=${data.data_path}`);
      if (status) status.textContent = "Timeout waiting for csv (try again).";
      return;
    }

    logLine(`ADASTri OK. ds_id=${data.ds_id}`);
    if (status) status.textContent = `OK: ${data.ds_id}`;

    // switch dataset and load (and persist)
    config.DS_ID = data.ds_id;
    saveLastDsId(config.DS_ID);
    await loadDataset();
  } finally {
    runInFlight = false;
    if (btn) btn.disabled = false;
  }
}

function updateCurrentTabTitle() {
  if (window.ADA_DFM_CONTEXT) return null;
  const triangleName = document.getElementById("triInput")?.value?.trim();
  if (!triangleName) return null;

  window.parent.postMessage(
    {
      type: "adas:update-active-tab-title",
      title: `${triangleName}`,
    },
    "*"
  );

  return triangleName;
}

function setStatus(text) {
  try {
    window.parent.postMessage({ type: "adas:status", text }, "*");
  } catch {
    // ignore
  }
}

async function loadDataset() {
  state.dirty.clear();

  const { ok, status, data } = await getDataset(config.DS_ID, config.START_YEAR);

  if (!ok) {
    logLine(`ERROR loading dataset: ${status}`);
    $("tableWrap").innerHTML = `<div style="color:#b00;"><b>Load failed:</b> ${status}</div>`;
    setStatus("Ready");
    return;
  }

  // persist the last successfully loaded dataset
  saveLastDsId(config.DS_ID);

  state.model = data;
  state.fileMtime = data.mtime;

  // Apply cached header labels, if available
  if (Array.isArray(state.headerLabels) && state.headerLabels.length) {
    state.model.origin_labels = state.headerLabels.map(String);
  }
  if (Array.isArray(state.devHeaderLabels) && state.devHeaderLabels.length) {
    // Do not truncate dev labels by the UI selector.
    // The triangle CSV may contain more columns than the current selector value.
    state.model.dev_labels = state.devHeaderLabels.map(String);
  }

  renderTable();
  notifyDatasetUpdated();
  applySelectionFromState();

  $("dsMeta").textContent =
    `id=${data.id} | origins=${data.origin_labels.length} | dev=${data.dev_labels.length} | mtime=${data.mtime}`;

  logLine("Loaded dataset");
  setStatus("Ready");
  const title = updateCurrentTabTitle() || config.DS_ID || "Dataset";

  if (stepId) {
    window.parent.postMessage(
      {
        type: "adas:update-workflow-step-title",
        stepId: stepId,
        title: title,
      },
      "*"
    );
  }
}

async function savePatch() {
  if (state.dirty.size === 0) {
    logLine("No changes to save.");
    return;
  }

  const items = [];
  for (const [key, value] of state.dirty.entries()) {
    const [r, c] = key.split(",").map((x) => parseInt(x, 10));
    items.push({ r, c, value });
  }

  const { status, data } = await patchDataset(items, state.fileMtime, config.DS_ID);

  if (status === 409) {
    logLine("Conflict: file changed on disk. Reload first.");
    return;
  }

  logLine(`Saved patch: applied=${data.applied}, rejected=${(data.rejected || []).length}, new_mtime=${data.mtime}`);
  await loadDataset();
}

function toggleBlanks() {
  state.showBlanks = !state.showBlanks;
  $("toggleBlankBtn").textContent = state.showBlanks ? "Hide blanks" : "Show blanks";
  renderTable(); // re-render only, no reload
  notifyDatasetUpdated();
  applySelectionFromState();
}

function enforceDevLenRule() {
  const o = document.getElementById("originLenSelect");
  const d = document.getElementById("devLenSelect");
  if (!o || !d) return;

  const origin = parseInt(o.value, 10);
  let dev = parseInt(d.value, 10);

  const ok =
    Number.isFinite(origin) &&
    Number.isFinite(dev) &&
    dev < origin &&
    origin % dev === 0;

  if (!ok) {
    d.value = String(origin);
  }
}

// -----------------------------
// Headers (year + dev) via GetDataset-like flow
// key = ProjectName + OriginLength
// -----------------------------

const LS_HEADER_PREFIX = scopedKey("adas_headers::");
let lastHeaderKey = "";

function headerKey(project, originLen) {
  return `${LS_HEADER_PREFIX}${String(project || "")}::${String(originLen || 12)}`;
}

function loadHeadersCache(project, originLen) {
  try {
    const raw = localStorage.getItem(headerKey(project, originLen)) || "";
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.labels)) return null;
    return obj.labels;
  } catch {
    return null;
  }
}

function saveHeadersCache(project, originLen, labels) {
  try {
    localStorage.setItem(headerKey(project, originLen), JSON.stringify({ labels }));
  } catch {
    // ignore
  }
}

const LS_DEV_HEADER_PREFIX = scopedKey("adas_dev_headers::");
let lastDevHeaderKey = "";

function devHeaderKey(project, originLen, devLen) {
  return `${LS_DEV_HEADER_PREFIX}${String(project || "")}::o${String(originLen || 12)}::d${String(devLen || 12)}`;
}

function loadDevHeadersCache(project, originLen, devLen) {
  try {
    const raw = localStorage.getItem(devHeaderKey(project, originLen, devLen)) || "";
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.labels)) return null;
    return obj.labels;
  } catch {
    return null;
  }
}

function saveDevHeadersCache(project, originLen, devLen, labels) {
  try {
    localStorage.setItem(devHeaderKey(project, originLen, devLen), JSON.stringify({ labels }));
  } catch {
    // ignore
  }
}

function getCurrentOriginLength() {
  const el = document.getElementById("originLenSelect");
  const v = parseInt(el?.value, 10);
  return Number.isFinite(v) ? v : 12;
}

function getCurrentDevLength() {
  const el = document.getElementById("devLenSelect");
  const v = parseInt(el?.value, 10);
  return Number.isFinite(v) ? v : 12;
}

async function fetchHeadersViaGetDataset(
  project,
  originLen,
  timeoutSec = 6.0,
  periodType = 0,
  transposed = false
) {
  const resp = await fetch("/adas/headers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      periodType: periodType,
      Transposed: transposed,
      PeriodLength: originLen,
      ProjectName: project,
      StoredPeriodLength: -1,
      timeout_sec: timeoutSec,
    }),
  });

  if (!resp.ok) return null;
  const data = await resp.json();

  if (data.ok && Array.isArray(data.labels)) return data.labels;
  if (data.status === "timeout") return "timeout";
  return null;
}

async function ensureHeadersForProject(project) {
  if (!project) return;

  const originLen = getCurrentOriginLength();
  const key = `${project}::${originLen}`;

  // Only refresh when (ProjectName + OriginLength) changes
  if (key === lastHeaderKey && Array.isArray(state.headerLabels) && state.headerLabels.length) return;

  // Try cache first
  const cached = loadHeadersCache(project, originLen);
  if (cached) {
    state.headerLabels = cached;
    lastHeaderKey = key;
    return;
  }

  // Send request + wait (like VBA GetDataset)
  for (let i = 0; i < 3; i++) {
    const labels = await fetchHeadersViaGetDataset(project, originLen, 6.0, 0, false);

    if (labels === "timeout") {
      await new Promise(r => setTimeout(r, 250));
      continue;
    }
    if (Array.isArray(labels)) {
      state.headerLabels = labels;
      saveHeadersCache(project, originLen, labels);
      lastHeaderKey = key;
      return;
    }
    break;
  }
}

async function ensureDevHeadersForProject(project) {
  if (!project) return;

  const originLen = getCurrentOriginLength();
  const devLen = getCurrentDevLength();
  const key = `${project}::o${originLen}::d${devLen}`;

  // Only refresh when (ProjectName + OriginLength) changes
  if (key === lastDevHeaderKey && Array.isArray(state.devHeaderLabels) && state.devHeaderLabels.length) return;

  // Try cache first
  const cached = loadDevHeadersCache(project, originLen, devLen);
  if (cached) {
    state.devHeaderLabels = cached;
    lastDevHeaderKey = key;
    return;
  }

  // periodType=1, Transposed=true (csv is still one line)
  for (let i = 0; i < 3; i++) {
    // periodType=1, Transposed=true (csv is still one line)
    // For dev headers, PeriodLength follows the UI "Development Length" selector.
    const labels = await fetchHeadersViaGetDataset(project, devLen, 6.0, 1, true);

    if (labels === "timeout") {
      await new Promise(r => setTimeout(r, 250));
      continue;
    }
    if (Array.isArray(labels)) {
      state.devHeaderLabels = labels;
      saveDevHeadersCache(project, originLen, devLen, labels);
      lastDevHeaderKey = key;
      return;
    }
    break;
  }
}

async function handleProjectSelection(value) {
  const project = findExactProjectMatch(value);
  if (!project) return;
  if (project === lastProjectSelection) return;

  lastProjectSelection = project;

  const projectInput = document.getElementById("projectSelect");
  if (projectInput) projectInput.value = project;
  showProjectDropdown(false);

  saveTriInputsToStorage();

  await ensureHeadersForProject(project);
  await ensureDevHeadersForProject(project);
  await refreshDatasetTypesForProject(project);

  scheduleAutoRun();
}

function wireArrowKeyNavigation() {
  if (window.__adasArrowNavWired) return;
  window.__adasArrowNavWired = true;

  document.addEventListener("keydown", (e) => {
    const isArrow = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key);
    if (!isArrow) return;

    // Don't steal keys while typing / selecting in controls
    if (isTypingTarget(e.target)) return;

    const model = state.model;
    if (!model) return;

    // If no active cell yet, pick (0,0)
    if (!state.activeCell) state.activeCell = { r: 0, c: 0 };

    const maxR = (model.origin_labels?.length || 0) - 1;
    const maxC = (model.dev_labels?.length || 0) - 1;
    if (maxR < 0 || maxC < 0) return;

    let { r, c } = state.activeCell;

    if (e.key === "ArrowUp") r -= 1;
    else if (e.key === "ArrowDown") r += 1;
    else if (e.key === "ArrowLeft") c -= 1;
    else if (e.key === "ArrowRight") c += 1;

    r = Math.max(0, Math.min(maxR, r));
    c = Math.max(0, Math.min(maxC, c));

    const same = r === state.activeCell.r && c === state.activeCell.c;
    if (same) return;

    e.preventDefault();

    // 1) move active cell
    state.activeCell = { r, c };
    renderActiveCellUI();

    // 2) clear previous rectangle selections (unless user is extending with Shift)
    //    - plain arrows: collapse selection to 1x1 at new active cell
    //    - Shift+arrows (future): you could extend selection; for now we keep simple
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
      state.selRanges = [normalizeRange(r, c, r, c)];
      applySelectionFromState();
    }

    // 3) keep visible
    const td = document.querySelector(`#tableWrap td[data-r="${r}"][data-c="${c}"]`);
    if (td && td.scrollIntoView) td.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}

function normalizeRange(r0, c0, r1, c1) {
  const rr0 = Math.min(r0, r1);
  const rr1 = Math.max(r0, r1);
  const cc0 = Math.min(c0, c1);
  const cc1 = Math.max(c0, c1);
  return { r0: rr0, c0: cc0, r1: rr1, c1: cc1 };
}

function rcFromTd(td) {
  const r = parseInt(td?.dataset?.r, 10);
  const c = parseInt(td?.dataset?.c, 10);
  if (!Number.isFinite(r) || !Number.isFinite(c)) return null;
  return { r, c };
}

function isTypingTarget(t) {
  if (!t) return false;

  const el = t.closest
    ? t.closest("input, textarea, select, option, button, [contenteditable='true'], #formulaBar")
    : null;

  if (el) return true;

  const tag = (t.tagName ? t.tagName.toLowerCase() : "");
  return tag === "input" || tag === "textarea" || tag === "select" || tag === "option" || tag === "button" ||
         !!t.isContentEditable || (t.id === "formulaBar");
}

function clearSelectionClasses() {
  document.querySelectorAll("#tableWrap td.sel").forEach(el => el.classList.remove("sel"));
}

function applyRangeClasses(range, add = true) {
  if (!range) return;
  const { r0, c0, r1, c1 } = range;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const td = document.querySelector(`#tableWrap td[data-r="${r}"][data-c="${c}"]`);
      if (!td) continue;
      if (add) td.classList.add("sel");
      else td.classList.remove("sel");
    }
  }
}

function applySelectionFromState() {
  // re-apply after re-render
  clearSelectionClasses();
  const ranges = state.selRanges || [];
  for (const rg of ranges) applyRangeClasses(rg, true);

  // mark active cell stronger
  if (state.activeCell) {
    const { r, c } = state.activeCell;
    const td = document.querySelector(`#tableWrap td[data-r="${r}"][data-c="${c}"]`);
    if (td && td.classList.contains("sel")) td.classList.add("active");
  }
}

function setActiveCell(r, c) {
  // If focus is still on a form control (select/input), arrow keys will be ignored.
  // Blur it when user starts interacting with the grid.
  const ae = document.activeElement;
  if (ae && isTypingTarget(ae) && ae.id !== "formulaBar") {
    try { ae.blur(); } catch {}
  }

  state.activeCell = { r, c };
  renderActiveCellUI();

  const td = document.querySelector(`#tableWrap td[data-r="${r}"][data-c="${c}"]`);
  if (td && td.scrollIntoView) td.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function buildTsvFromRange(range) {
  const model = state.model;
  if (!model) return "";

  const { r0, c0, r1, c1 } = range;
  const vals = model.values || [];
  const mask = model.mask || [];

  const lines = [];
  for (let r = r0; r <= r1; r++) {
    const row = [];
    for (let c = c0; c <= c1; c++) {
      const has = !!(mask[r] && mask[r][c]);
      if (!has) {
        row.push(""); // blank cell
      } else {
        const v = vals[r]?.[c];
        row.push(v === null || v === undefined ? "" : String(v));
      }
    }
    lines.push(row.join("\t"));
  }
  return lines.join("\n");
}

async function copyActiveRangeToClipboard() {
  const ranges = state.selRanges || [];
  if (!ranges.length) return;

  // Copy the most recent rectangle (Excel-like for our UI)
  const range = ranges[ranges.length - 1];
  const tsv = buildTsvFromRange(range);
  if (!tsv) return;

  try {
    await navigator.clipboard.writeText(tsv);
    logLine(`Copied range (${range.r0},${range.c0})-(${range.r1},${range.c1})`);
  } catch {
    // fallback for older browsers
    const ta = document.createElement("textarea");
    ta.value = tsv;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand("copy"); } catch {}
    document.body.removeChild(ta);
    logLine(`Copied range (fallback)`);
  }
}

function wireRectSelectionAndCopy() {
  if (window.__adasRectSelWired) return;
  window.__adasRectSelWired = true;

  // state containers
  if (!state.selRanges) state.selRanges = [];
  state.dragSel = null; // { anchor:{r,c}, cur:{r,c}, append:boolean }

  const wrap = document.getElementById("tableWrap");

  // start drag
  wrap.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (isTypingTarget(e.target)) return;

    // NEW: leave dropdown/input focus when interacting with grid
    const ae = document.activeElement;
    if (ae && isTypingTarget(ae) && ae.id !== "formulaBar") {
      try { ae.blur(); } catch {}
    }

    const td = e.target.closest('td[data-r][data-c]');
    if (!td) return;

    e.preventDefault(); // stop text selection

    const rc = rcFromTd(td);
    if (!rc) return;

    const append = !!e.ctrlKey;

    // if not appending, replace selection
    if (!append) state.selRanges = [];

    state.dragSel = {
      anchor: { r: rc.r, c: rc.c },
      cur: { r: rc.r, c: rc.c },
      append,
      lastApplied: null,
    };

    const rg = normalizeRange(rc.r, rc.c, rc.r, rc.c);
    state.selRanges.push(rg);

    setActiveCell(rc.r, rc.c);
    applySelectionFromState();
  });

  // drag over (use mouseover to avoid heavy mousemove)
  wrap.addEventListener("mouseover", (e) => {
    if (!state.dragSel) return;

    const td = e.target.closest('td[data-r][data-c]');
    if (!td) return;

    const rc = rcFromTd(td);
    if (!rc) return;

    const { anchor } = state.dragSel;
    state.dragSel.cur = { r: rc.r, c: rc.c };

    // update last range only
    const lastIdx = (state.selRanges?.length || 0) - 1;
    if (lastIdx < 0) return;

    state.selRanges[lastIdx] = normalizeRange(anchor.r, anchor.c, rc.r, rc.c);

    setActiveCell(rc.r, rc.c);
    applySelectionFromState();
  });

  // end drag anywhere
  document.addEventListener("mouseup", () => {
    state.dragSel = null;
  });

  // Ctrl+C copy
  document.addEventListener("keydown", (e) => {
    if (isTypingTarget(e.target)) return;

    const isCopy = (e.key === "c" || e.key === "C") && e.ctrlKey;
    if (!isCopy) return;

    if (!state.selRanges || !state.selRanges.length) return;

    e.preventDefault();
    copyActiveRangeToClipboard();
  });
}


function wireEvents() {
  document.getElementById("reloadBtn")?.addEventListener("click", loadDataset);
  $("saveBtn").addEventListener("click", savePatch);
  $("toggleBlankBtn").addEventListener("click", toggleBlanks);

  const pathInput = document.getElementById("pathInput");
  const triInput = document.getElementById("triInput");
  const projectSelect = document.getElementById("projectSelect");
  const originSel = document.getElementById("originLenSelect");
  const devSel = document.getElementById("devLenSelect");

  const cumulativeChk = document.getElementById("cumulativeChk");
  if (cumulativeChk) {
    cumulativeChk.addEventListener("change", () => {
      saveTriInputsToStorage();
      scheduleAutoRun(0);
    });
  }

  const dec = document.getElementById("decimalPlaces");
  if (dec) {
    dec.addEventListener("change", () => {
      renderTable();
      notifyDatasetUpdated();
      renderChart();
    });
    dec.addEventListener("input", () => {
      renderTable();
      notifyDatasetUpdated();
      renderChart();
    });
  }

  // change → auto run
  if (pathInput) pathInput.addEventListener("change", () => { saveTriInputsToStorage(); setStatus("Loading dataset..."); scheduleAutoRun(); });
  if (triInput) {
    triInput.addEventListener("focus", () => {
      filterDatasetOptions(triInput.value);
    });

    triInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const list = document.getElementById("datasetDropdown");
        if (!list || !list.classList.contains("open")) {
          filterDatasetOptions(triInput.value);
        }
        const dir = e.key === "ArrowDown" ? 1 : -1;
        if (activeDatasetIndex === -1) {
          setActiveDatasetIndex(dir > 0 ? 0 : -1);
        } else {
          setActiveDatasetIndex(activeDatasetIndex + dir);
        }
        e.preventDefault();
        return;
      }

      if (e.key === "Enter") {
        if (chooseActiveDataset()) {
          e.preventDefault();
          return;
        }
        saveTriInputsToStorage();
        setStatus("Loading dataset...");
        scheduleAutoRun(0);
        return;
      }

      if (e.key === "Escape") {
        showDatasetDropdown(false);
      }
    });

    triInput.addEventListener("input", () => {
      filterDatasetOptions(triInput.value);
      if (!triInput.value.trim()) lastDatasetSelection = "";
      void handleDatasetSelection(triInput.value);
    });

    triInput.addEventListener("change", () => {
      saveTriInputsToStorage();
      setStatus("Loading dataset...");
      scheduleAutoRun();
      showDatasetDropdown(false);
    });
  }

  if (projectSelect) {
    projectSelect.addEventListener("focus", () => {
      filterProjectOptions(projectSelect.value);
    });

    projectSelect.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const list = document.getElementById("projectDropdown");
        if (!list || !list.classList.contains("open")) {
          filterProjectOptions(projectSelect.value);
        }
        const dir = e.key === "ArrowDown" ? 1 : -1;
        if (activeProjectIndex === -1) {
          setActiveProjectIndex(dir > 0 ? 0 : -1);
        } else {
          setActiveProjectIndex(activeProjectIndex + dir);
        }
        e.preventDefault();
        return;
      }

      if (e.key === "Enter") {
        if (chooseActiveProject()) e.preventDefault();
        return;
      }

      if (e.key === "Escape") {
        showProjectDropdown(false);
      }
    });

    projectSelect.addEventListener("input", () => {
      filterProjectOptions(projectSelect.value);
      if (!projectSelect.value.trim()) lastProjectSelection = "";
      void handleProjectSelection(projectSelect.value);
    });

    projectSelect.addEventListener("change", async () => {
      if (!projectSelect.value.trim()) return;
      setStatus("Loading dataset...");
      await handleProjectSelection(projectSelect.value);
    });
  }

  document.addEventListener("mousedown", (e) => {
    const projectWrap = document.querySelector(".projectSelectWrap");
    if (projectWrap && !projectWrap.contains(e.target)) {
      showProjectDropdown(false);
    }
    const datasetWrap = document.querySelector(".datasetSelectWrap");
    if (datasetWrap && !datasetWrap.contains(e.target)) {
      showDatasetDropdown(false);
    }
  });

  // Origin change → (optional sync) → enforce rule → refresh headers → auto run
  if (originSel) {
    originSel.addEventListener("change", async () => {
      syncLen("origin");
      enforceDevLenRule();
      saveTriInputsToStorage();

      const project = document.getElementById("projectSelect")?.value || "";
      await ensureHeadersForProject(project);
      await ensureDevHeadersForProject(project);

      renderTable();
      notifyDatasetUpdated();
      setStatus("Loading dataset...");
      scheduleAutoRun(0);
      originSel.blur();
    });
  }

  const linkChk = document.getElementById("linkLenChk");
  if (linkChk) {
    linkChk.addEventListener("change", async () => {
      // Toggling link can change the effective period lengths (origin/dev),
      // so refresh both header label sets to keep them aligned with the data.
      const originBefore = document.getElementById("originLenSelect")?.value || "";
      const devBefore = document.getElementById("devLenSelect")?.value || "";
      if (isLenLinked()) syncLen("init");
      enforceDevLenRule();

      saveTriInputsToStorage();

      const project = document.getElementById("projectSelect")?.value || "";
      if (project) {
        await ensureHeadersForProject(project);
        await ensureDevHeadersForProject(project);
      }

      renderTable();
      notifyDatasetUpdated();
      const originAfter = document.getElementById("originLenSelect")?.value || "";
      const devAfter = document.getElementById("devLenSelect")?.value || "";
      const changed = originBefore !== originAfter || devBefore !== devAfter;
      if (changed) {
        setStatus("Loading dataset...");
        scheduleAutoRun(0);
      }
    });
  }

  // Dev change → (optional sync) → refresh dev headers → auto run
  if (devSel) {
    devSel.addEventListener("change", async () => {
      syncLen("dev");
      enforceDevLenRule();
      saveTriInputsToStorage();

      const project = document.getElementById("projectSelect")?.value || "";
      // If len is linked, origin may change too; ensure both headers are consistent.
      if (project) {
        await ensureHeadersForProject(project);
        await ensureDevHeadersForProject(project);
      }

      renderTable();
      notifyDatasetUpdated();
      setStatus("Loading dataset...");
      scheduleAutoRun(0);
      devSel.blur();
    });
  }

  // Enter → auto run
  bindAutoRunOnEnter(pathInput);
  bindAutoRunOnEnter(originSel);
  bindAutoRunOnEnter(devSel);

  // Run button still as fallback
  const runBtn = document.getElementById("runAdasTriBtn");
  if (runBtn) runBtn.addEventListener("click", runAdasTri);

  $("formulaBar").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (!state.activeCell) return;

    const { r, c } = state.activeCell;
    const key = `${r},${c}`;

    const parsed = parseFormulaInput($("formulaBar").value);
    if (!parsed.ok) {
      logLine(parsed.error);
      return;
    }

    state.dirty.set(key, parsed.value);
    logLine(`Set ${key} = ${parsed.value === null ? "null" : parsed.value}`);

    renderTable();
    notifyDatasetUpdated();
    renderActiveCellUI();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      // wait for layout to settle
      requestAnimationFrame(() => {
        requestAnimationFrame(redrawChartSafely);
      });
    }
  });

  window.addEventListener("resize", () => {
    requestAnimationFrame(redrawChartSafely);
  });

  window.addEventListener("message", (e) => {
    if (e?.data?.type === "adas:get-dataset-settings") {
      const settings = getTriInputs();
      window.parent.postMessage(
        {
          type: "adas:dataset-settings",
          requestId: e.data.requestId,
          stepId: instanceId,
          settings,
        },
        "*"
      );
      return;
    }

    if (e?.data?.type === "adas:tab-activated") {
      // Only redraw when THIS tab becomes active
      requestAnimationFrame(() => {
        requestAnimationFrame(redrawChartSafely);
      });
    }
  });

  wireArrowKeyNavigation();
  wireRectSelectionAndCopy();
}


async function boot() {
  fillLenDropdowns();
  await loadProjectsDropdown();

  // restore user inputs AFTER dropdown options are populated
  restoreTriInputsFromStorage();
  enforceDevLenRule();
  await refreshDatasetTypesForProject(document.getElementById("projectSelect")?.value || "");

  wireEvents();

  // If the restored controls are complete, trigger an immediate autoRun.
  // Otherwise, fall back to loading the last dataset.
  const { project, path, tri } = getTriInputs();
  if (project && path && tri) {
    await ensureHeadersForProject(project);
    await ensureDevHeadersForProject(project);
    scheduleAutoRun(0);
  } else {
    await loadDataset();
  }
}

boot();

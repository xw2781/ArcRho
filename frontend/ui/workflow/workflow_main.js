import { openContextMenu } from "/ui/shared/components/context_menu/context_menu.js";
import { openReservingClassPicker } from "/ui/shared/components/pickers/reserving_class_picker.js";
import { openProjectNameTreePicker } from "/ui/shared/components/pickers/project_name_tree_picker.js";
import { loadProjectUserPreferences } from "/ui/shared/services/project_user_preferences.js";
import "/ui/shared/integrations/zoom_bridge.js?v=20260521a";

const stepsEl = document.getElementById("steps");
const inspectorEl = document.getElementById("inspector");
const workspaceEl = document.getElementById("workspace");
const wsHintEl = document.getElementById("wsHint");
const addStepTile = document.getElementById("addStepTile");
const importWorkflowTile = document.getElementById("importWorkflowTile");
const sidebarResizer = document.getElementById("sidebarResizer");
const datasetEmbedCache = new Map();
const dfmEmbedCache = new Map();
const TRI_INPUTS_KEY = "arcrho_tri_inputs";
const GLOBAL_VAR_TYPE_PROJECT = "project";
const GLOBAL_VAR_TYPE_RESERVING_CLASS = "reservingClass";
const GLOBAL_VAR_TYPE_STRING = "string";
const DEFAULT_TOKEN = "__DEFAULT__";
const WORKFLOW_ITEM_FOLDER = "folder";
const MAX_FOLDER_DEPTH = 3;
const GLOBAL_VAR_TYPE_OPTIONS = [
  { value: GLOBAL_VAR_TYPE_PROJECT, label: "Project" },
  { value: GLOBAL_VAR_TYPE_RESERVING_CLASS, label: "Reserving Class" },
  { value: GLOBAL_VAR_TYPE_STRING, label: "Other" },
];

function getDefaultGlobalVarTypeForKey(key) {
  if (key === "project") return GLOBAL_VAR_TYPE_PROJECT;
  if (key === "reservingClass") return GLOBAL_VAR_TYPE_RESERVING_CLASS;
  return GLOBAL_VAR_TYPE_STRING;
}

function normalizeGlobalVarType(type, key = "") {
  const raw = String(type == null ? "" : type).trim().toLowerCase();
  if (raw === "project") return GLOBAL_VAR_TYPE_PROJECT;
  if (raw === "reservingclass" || raw === "reserving_class" || raw === "reserving class") {
    return GLOBAL_VAR_TYPE_RESERVING_CLASS;
  }
  if (raw === "string" || raw === "other") return GLOBAL_VAR_TYPE_STRING;
  return getDefaultGlobalVarTypeForKey(key);
}

const DEFAULT_GLOBAL_VARS = [
  { key: "project", name: "<Default Project>", type: GLOBAL_VAR_TYPE_PROJECT, value: "" },
  { key: "reservingClass", name: "Default Path", type: GLOBAL_VAR_TYPE_RESERVING_CLASS, value: "" },
];

const state = {
  steps: [],
  activeId: null,
  nextId: 1,
  globalControl: { vars: DEFAULT_GLOBAL_VARS.map((v) => ({ ...v })) }
};

const qs = new URLSearchParams(window.location.search);
const instanceId = qs.get("inst") || "default";
const isFresh = qs.get("fresh") === "1";
const STORAGE_KEY = `arcrho_workflow_state_v1::${instanceId}`;
const WF_TITLE_KEY = `arcrho_workflow_title_v1::${instanceId}`;
const WF_SIDEBAR_W_KEY = `arcrho_workflow_sidebar_w_v1::${instanceId}`;
const WF_SIDEBAR_COLLAPSED_KEY = `arcrho_workflow_sidebar_collapsed_v1::${instanceId}`;
const WF_LAST_PATH_KEY = `arcrho_workflow_last_path_v1::${instanceId}`;
const WF_GLOBAL_CTRL_KEY = `arcrho_workflow_global_ctrl_v1::${instanceId}`;
const FONT_STORAGE_KEY = "arcrho_app_font";
const LOCAL_PROJECT_PREFS_ENDPOINT = "/local-project/preferences";

let workflowDirty = false;
let saveInFlight = false;
let lastSaveSignature = "";
let suppressDirty = false;
let lastSavedPath = "";
let lastZoomValue = 100;
let lastStatusBarHeight = 24;

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
  for (const [, frame] of datasetEmbedCache) {
    if (!frame || !frame.contentWindow) continue;
    try {
      frame.contentWindow.postMessage({ type: "arcrho:set-app-font", font }, "*");
    } catch {
      // ignore
    }
  }
  for (const [, frame] of dfmEmbedCache) {
    if (!frame || !frame.contentWindow) continue;
    try {
      frame.contentWindow.postMessage({ type: "arcrho:set-app-font", font }, "*");
    } catch {
      // ignore
    }
  }
}

function loadAppFontFromStorage() {
  try {
    const raw = localStorage.getItem(FONT_STORAGE_KEY);
    if (raw && typeof raw === "string") return raw;
  } catch {}
  return "";
}

function broadcastZoomToEmbeddedDatasets() {
  for (const [, frame] of datasetEmbedCache) {
    if (!frame || !frame.contentWindow) continue;
    try {
      frame.contentWindow.postMessage(
        { type: "arcrho:set-zoom", zoom: lastZoomValue, statusBarHeight: lastStatusBarHeight },
        "*"
      );
    } catch {
      // ignore
    }
  }
  for (const [, frame] of dfmEmbedCache) {
    if (!frame || !frame.contentWindow) continue;
    try {
      frame.contentWindow.postMessage(
        { type: "arcrho:set-zoom", zoom: lastZoomValue, statusBarHeight: lastStatusBarHeight },
        "*"
      );
    } catch {
      // ignore
    }
  }
}

window.ArcRhoZoomBridge?.wirePageZoomBridge({
  onApplied: ({ zoom, statusBarHeight }) => {
    if (Number.isFinite(Number(zoom))) lastZoomValue = Number(zoom);
    if (Number.isFinite(Number(statusBarHeight))) lastStatusBarHeight = Number(statusBarHeight);
    broadcastZoomToEmbeddedDatasets();
  },
});
applyAppFont(loadAppFontFromStorage());

window.addEventListener("message", (e) => {
  if (e?.data?.type === "arcrho:set-app-font") {
    applyAppFont(e.data.font);
    return;
  }
  if (e?.data?.type === "arcrho:dfm-tab-changed") {
    const inst = e.data.inst;
    const tab = e.data.tab;
    if (inst && tab) {
      const step = state.steps.find((s) => s.id === inst);
      if (step) {
        step.dfmTab = tab;
        saveState();
      }
    }
  }
});

window.addEventListener("mousedown", () => {
  window.parent.postMessage({ type: "arcrho:close-shell-menus" }, "*");
}, { capture: true });

function applySidebarWidth(w) {
  const sidebar = document.getElementById("workflowSidebar");
  if (!sidebar) return;
  if (!Number.isFinite(w)) return;
  sidebar.style.width = `${w}px`;
}

function loadSidebarWidth() {
  try {
    const raw = localStorage.getItem(WF_SIDEBAR_W_KEY);
    if (!raw) return null;
    const w = Number(raw);
    return Number.isFinite(w) ? w : null;
  } catch {
    return null;
  }
}

function loadSidebarCollapsed() {
  try {
    return localStorage.getItem(WF_SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle("sidebar-collapsed", !!collapsed);
  if (toggleSidebarBtn) {
    toggleSidebarBtn.innerHTML = collapsed
      ? '<svg class="collapseIcon" viewBox="0 0 12 12" aria-hidden="true"><polyline points="4,3 7,6 4,9"></polyline></svg>'
      : '<svg class="collapseIcon" viewBox="0 0 12 12" aria-hidden="true"><polyline points="8,3 5,6 8,9"></polyline></svg>';
    toggleSidebarBtn.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
  }
  try { localStorage.setItem(WF_SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0"); } catch {}
}

function cloneDefaultGlobalVars() {
  return DEFAULT_GLOBAL_VARS.map((v) => ({
    key: v.key,
    name: v.name,
    type: normalizeGlobalVarType(v.type, v.key),
    value: v.value || "",
  }));
}

function getDefaultGlobalVarName(key) {
  if (key === "project") return "<Default Project>";
  if (key === "reservingClass") return "Default Path";
  return "";
}

function isWorkflowDefaultReference(value) {
  const raw = String(value == null ? "" : value).trim();
  const lower = raw.toLowerCase();
  return lower === DEFAULT_TOKEN.toLowerCase()
    || lower === "default"
    || lower === "default project"
    || lower === "<default project>"
    || lower === "default path"
    || (lower.startsWith("default project (") && lower.endsWith(")"))
    || (lower.startsWith("<default project> (") && lower.endsWith(")"))
    || (lower.startsWith("default path (") && lower.endsWith(")"));
}

function normalizeGlobalControl(input) {
  const obj = input && typeof input === "object" ? input : {};
  let vars = null;

  if (Array.isArray(obj.vars)) {
    vars = obj.vars;
  } else if ("project" in obj || "reservingClass" in obj) {
    const project = typeof obj.project === "string" ? obj.project : "";
    const reservingClass = typeof obj.reservingClass === "string" ? obj.reservingClass : "";
    vars = cloneDefaultGlobalVars().map((v) => {
      if (v.key === "project") return { ...v, value: project };
      if (v.key === "reservingClass") return { ...v, value: reservingClass };
      return v;
    });
  } else {
    vars = cloneDefaultGlobalVars();
  }

  const cleaned = [];
  for (const v of vars) {
    if (!v || typeof v !== "object") continue;
    const key = typeof v.key === "string" ? v.key.trim() : "";
    const name = typeof v.name === "string"
      ? v.name.trim()
      : getDefaultGlobalVarName(key);
    const type = normalizeGlobalVarType(v.type, key);
    const value = v.value == null ? "" : String(v.value);
    if (!key && !name && !value) continue;
    cleaned.push({ key, name, type, value });
  }

  const required = [
    { key: "project", name: "<Default Project>", type: GLOBAL_VAR_TYPE_PROJECT },
    { key: "reservingClass", name: "Default Path", type: GLOBAL_VAR_TYPE_RESERVING_CLASS },
  ];

  const ordered = [];
  for (const req of required) {
    const found = cleaned.find((v) => v.key === req.key);
    if (found) {
      ordered.push({
        ...found,
        name: req.name,
        type: normalizeGlobalVarType(found.type, req.key),
      });
    } else {
      ordered.push({ key: req.key, name: req.name, type: req.type, value: "" });
    }
  }
  for (const v of cleaned) {
    if (required.some((r) => r.key === v.key)) continue;
    ordered.push(v);
  }

  return { vars: ordered };
}

function loadGlobalControlFromStorage() {
  try {
    const raw = localStorage.getItem(WF_GLOBAL_CTRL_KEY) || "";
    if (!raw) return normalizeGlobalControl(null);
    const parsed = JSON.parse(raw);
    return normalizeGlobalControl(parsed);
  } catch {
    return normalizeGlobalControl(null);
  }
}

function normalizeLocalProjectPreference(raw) {
  const prefs = raw && typeof raw === "object" ? raw : {};
  return String(
    prefs.projectName
    || prefs.project_name
    || prefs.project
    || "",
  ).trim();
}

async function loadLastProjectNameFromUserPrefs() {
  try {
    const response = await fetch(LOCAL_PROJECT_PREFS_ENDPOINT, { cache: "no-store" });
    if (!response.ok) return "";
    const payload = await response.json().catch(() => ({}));
    return normalizeLocalProjectPreference(payload?.preferences || payload);
  } catch {
    return "";
  }
}

async function loadLastPathForProjectFromUserPrefs(projectName) {
  const project = String(projectName || "").trim();
  if (!project) return "";
  try {
    const prefs = await loadProjectUserPreferences(project, { forceReload: false });
    return String(prefs?.lastReservingClassPath || prefs?.last_reserving_class_path || "").trim();
  } catch {
    return "";
  }
}

async function buildInitialGlobalControlFromUserPrefs() {
  const project = await loadLastProjectNameFromUserPrefs();
  const reservingClass = await loadLastPathForProjectFromUserPrefs(project);
  const control = normalizeGlobalControl(null);
  for (const variable of control.vars || []) {
    if (variable.key === "project") variable.value = project;
    if (variable.key === "reservingClass") variable.value = reservingClass;
  }
  return normalizeGlobalControl(control);
}

function saveGlobalControlToStorage(value) {
  try {
    const payload = normalizeGlobalControl(value);
    localStorage.setItem(WF_GLOBAL_CTRL_KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

function broadcastGlobalControlChange() {
  const payload = normalizeGlobalControl(state.globalControl);
  const msg = { type: "arcrho:workflow-global-changed", globalControl: payload, wf: instanceId };
  const activeFrame = dfmEmbedCache.get(state.activeId) || datasetEmbedCache.get(state.activeId);
  if (activeFrame?.contentWindow) {
    try { activeFrame.contentWindow.postMessage(msg, "*"); } catch { /* ignore */ }
  }
}

function saveState() {
  try {
    enforceSingleGlobalControlStep(state.activeId || "");
    sanitizeFolderParents();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      steps: state.steps,
      activeId: state.activeId,
      nextId: state.nextId,
      globalControl: normalizeGlobalControl(state.globalControl),
    }));
    saveGlobalControlToStorage(state.globalControl);
    if (!suppressDirty) markWorkflowDirty();
  } catch {}
}

function setWorkflowTitle(title) {
  const el = document.getElementById("sidebarTitle");
  if (el) el.textContent = title;
  try { localStorage.setItem(WF_TITLE_KEY, title); } catch {}
  if (!suppressDirty) markWorkflowDirty();
  // Sync to shell tab
  window.parent.postMessage({ type: "arcrho:update-workflow-tab-title", title, inst: instanceId }, "*");
}

function getWorkflowTitle() {
  try { return localStorage.getItem(WF_TITLE_KEY) || "Workflow Designer"; } catch { return "Workflow Designer"; }
}

function loadLastSavedPath() {
  try { return localStorage.getItem(WF_LAST_PATH_KEY) || ""; } catch { return ""; }
}

function setLastSavedPath(p) {
  lastSavedPath = p || "";
  try { localStorage.setItem(WF_LAST_PATH_KEY, lastSavedPath); } catch {}
}

function getHostApi() {
  return window.ADAHost || null;
}

function getPathDir(p) {
  if (!p) return "";
  const lastSlash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return lastSlash > 0 ? p.slice(0, lastSlash) : "";
}

function setWorkflowDirty(next) {
  const dirty = !!next;
  if (workflowDirty === dirty) return;
  workflowDirty = dirty;
  window.parent.postMessage({ type: "arcrho:workflow-dirty", dirty, inst: instanceId }, "*");
}

function markWorkflowDirty() {
  setWorkflowDirty(true);
}

function sanitizeFilename(name) {
  const base = String(name || "").trim() || "workflow";
  return base.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/\s+/g, " ").trim();
}

function updateSaveStatus(msg) {
  const el = document.getElementById("saveStatus");
  if (el) el.textContent = msg || "";
}

function getSidebarWidth() {
  const sidebar = document.getElementById("workflowSidebar");
  if (!sidebar) return null;
  const rect = sidebar.getBoundingClientRect();
  return Math.round(rect.width);
}

function getDatasetSettingsFromStorage(stepId) {
  try {
    const raw = localStorage.getItem(`${TRI_INPUTS_KEY}::${stepId}`) || "";
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s !== "object") return null;
    return {
      cumulative: !!s.cumulative,
      project: s.project || "",
      path: s.path || "",
      tri: s.tri || "",
      originLen: s.originLen || "",
      devLen: s.devLen || "",
    };
  } catch {
    return null;
  }
}

function requestDatasetSettingsFromIframe(stepId) {
  return new Promise((resolve) => {
    const iframe = datasetEmbedCache.get(stepId);
    if (!iframe || !iframe.contentWindow) {
      resolve(null);
      return;
    }
    const requestId = `ds-settings-${stepId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const onMsg = (e) => {
      if (e?.data?.type !== "arcrho:dataset-settings") return;
      if (e.data.requestId !== requestId) return;
      window.removeEventListener("message", onMsg);
      resolve(e.data.settings || null);
    };
    window.addEventListener("message", onMsg);
    iframe.contentWindow.postMessage({ type: "arcrho:get-dataset-settings", requestId }, "*");
    setTimeout(() => {
      window.removeEventListener("message", onMsg);
      resolve(null);
    }, 800);
  });
}

async function collectDatasetSettings(step) {
  const fromIframe = await requestDatasetSettingsFromIframe(step.id);
  if (fromIframe) return fromIframe;
  return getDatasetSettingsFromStorage(step.id);
}

function requestDfmSettingsFromIframe(stepId) {
  return new Promise((resolve) => {
    const iframe = dfmEmbedCache.get(stepId);
    if (!iframe || !iframe.contentWindow) {
      resolve(null);
      return;
    }
    const requestId = `dfm-settings-${stepId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const onMsg = (e) => {
      if (e?.data?.type !== "arcrho:dfm-settings") return;
      if (e.data.requestId !== requestId) return;
      window.removeEventListener("message", onMsg);
      resolve(e.data.settings || null);
    };
    window.addEventListener("message", onMsg);
    iframe.contentWindow.postMessage({ type: "arcrho:get-dfm-settings", requestId }, "*");
    setTimeout(() => {
      window.removeEventListener("message", onMsg);
      resolve(null);
    }, 800);
  });
}

async function collectDfmSettings(step) {
  const fromIframe = await requestDfmSettingsFromIframe(step.id);
  if (fromIframe) return fromIframe;
  return step.dfmSettings || null;
}

async function buildWorkflowSnapshot() {
  const steps = await Promise.all(state.steps.map(async (s) => {
    if (isWorkflowFolder(s)) {
      return {
        id: s.id,
        itemType: WORKFLOW_ITEM_FOLDER,
        name: s.name || "New Folder",
        displayName: s.displayName || "",
        parentId: s.parentId || "",
        collapsed: !!s.collapsed,
      };
    }
    const datasetSettings = s.mode === "dataset" ? await collectDatasetSettings(s) : null;
    const dfmSettings = s.mode === "dfm" ? await collectDfmSettings(s) : null;
    return {
      id: s.id,
      itemType: "step",
      parentId: s.parentId || "",
      name: s.name,
      displayName: s.displayName || "",
      datasetTitle: s.datasetTitle || "",
      isCustomName: !!s.isCustomName,
      mode: s.mode || "picker",
      datasetId: s.datasetId || "",
      params: s.params || {},
      datasetSettings,
      dfmSettings,
      dfmTab: s.dfmTab || "",
    };
  }));

  return {
    version: 1,
    name: getWorkflowTitle(),
    updatedAt: new Date().toISOString(),
    sidebarWidth: getSidebarWidth(),
    steps,
    globalControl: normalizeGlobalControl(state.globalControl),
  };
}

async function saveWorkflowToDefaultDir({ force = false } = {}) {
  if (!force && !workflowDirty) return;
  if (saveInFlight) return;

  /* Tell all embedded DFM iframes to save their method settings to local JSON */
  for (const [, frame] of dfmEmbedCache) {
    try { frame?.contentWindow?.postMessage({ type: "arcrho:dfm-save" }, "*"); } catch {}
  }

  const snapshot = await buildWorkflowSnapshot();
  const signature = JSON.stringify(snapshot);
  if (!force && signature === lastSaveSignature) {
    setWorkflowDirty(false);
    return;
  }

  saveInFlight = true;
  updateSaveStatus("Saving...");
  try {
    const res = await fetch("/workflow/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: snapshot.name, data: snapshot, prev_path: lastSavedPath }),
    });
    if (!res.ok) {
      updateSaveStatus("Save failed");
      return;
    }
    const out = await res.json();
    lastSaveSignature = signature;
    setWorkflowDirty(false);
    if (out.path) setLastSavedPath(out.path);
    const savedPath = out.path || lastSavedPath;
    updateSaveStatus(`Saved: ${savedPath || ""}`);
    if (savedPath) {
      window.parent.postMessage({ type: "arcrho:workflow-saved", path: savedPath, inst: instanceId }, "*");
    }
  } catch {
    updateSaveStatus("Save failed");
  } finally {
    saveInFlight = false;
  }
}

async function saveWorkflowAs() {
  const snapshot = await buildWorkflowSnapshot();
    const filename = sanitizeFilename(snapshot.name) + ".arcwf";
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });

  const hostApi = getHostApi();
  if (hostApi?.pickSaveWorkflowFile) {
    try {
      const startDir = getPathDir(lastSavedPath);
      const picked = await hostApi.pickSaveWorkflowFile(filename, startDir);
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (path) {
        updateSaveStatus("Exporting...");
        const res = await fetch("/workflow/save_as", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, data: snapshot }),
        });
        if (!res.ok) {
          updateSaveStatus("Export failed");
          return;
        }
        const out = await res.json();
        if (out.path) setLastSavedPath(out.path);
        const exportedPath = out.path || lastSavedPath;
        lastSaveSignature = signature;
        setWorkflowDirty(false);
        updateSaveStatus(`Exported: ${exportedPath || ""}`);
        if (exportedPath) {
          window.parent.postMessage({ type: "arcrho:workflow-saved", path: exportedPath, inst: instanceId }, "*");
        }
        return;
      }
    } catch {
      // fall through
    }
  }

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "Workflow", accept: { "application/json": [".arcwf", ".json"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      setLastSavedPath("");
      lastSaveSignature = signature;
      setWorkflowDirty(false);
      updateSaveStatus("Exported");
      return;
    } catch {
      // user canceled or not allowed
    }
  }

  const path = window.prompt("Save workflow as (full path):", filename);
  if (!path) return;
  updateSaveStatus("Exporting...");
  try {
    const res = await fetch("/workflow/save_as", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, data: snapshot }),
    });
    if (!res.ok) {
      updateSaveStatus("Export failed");
      return;
    }
    const out = await res.json();
    if (out.path) setLastSavedPath(out.path);
    const exportedPath = out.path || lastSavedPath;
    lastSaveSignature = signature;
    setWorkflowDirty(false);
    updateSaveStatus(`Exported: ${exportedPath || ""}`);
    if (exportedPath) {
      window.parent.postMessage({ type: "arcrho:workflow-saved", path: exportedPath, inst: instanceId }, "*");
    }
  } catch {
    updateSaveStatus("Export failed");
  }
}

function normalizeLoadedStep(step, index) {
  const id = step?.id || `step_${index + 1}`;
  const itemType = step?.itemType === WORKFLOW_ITEM_FOLDER || step?.type === WORKFLOW_ITEM_FOLDER
    ? WORKFLOW_ITEM_FOLDER
    : "step";
  if (itemType === WORKFLOW_ITEM_FOLDER) {
    return {
      id,
      itemType: WORKFLOW_ITEM_FOLDER,
      name: step?.name || step?.displayName || "New Folder",
      displayName: step?.displayName || step?.name || "New Folder",
      parentId: step?.parentId || "",
      collapsed: !!step?.collapsed,
    };
  }
  const rawMode = step?.mode || "picker";
  const mode = rawMode === "new_method" ? "dfm" : rawMode;
  return {
    id,
    itemType: "step",
    parentId: step?.parentId || "",
    name: step?.name || `Step ${index + 1}`,
    displayName: step?.displayName || "",
    datasetTitle: step?.datasetTitle || "",
    isCustomName: !!step?.isCustomName,
    mode,
    datasetId: step?.datasetId || "",
    params: step?.params || {},
    datasetSettings: step?.datasetSettings || null,
    dfmSettings: step?.dfmSettings || null,
    dfmTab: step?.dfmTab || "",
  };
}

function computeNextId(steps) {
  let maxId = 0;
  for (const s of steps) {
    const m = String(s.id || "").match(/_(\d+)$/);
    if (m) maxId = Math.max(maxId, parseInt(m[1], 10));
  }
  return Math.max(maxId + 1, steps.length + 1);
}

function isWorkflowFolder(item) {
  return item?.itemType === WORKFLOW_ITEM_FOLDER;
}

function getWorkflowItem(itemId) {
  return state.steps.find((s) => s?.id === itemId) || null;
}

function getItemParentId(item) {
  const parentId = String(item?.parentId || "");
  if (!parentId) return "";
  const parent = getWorkflowItem(parentId);
  return isWorkflowFolder(parent) ? parentId : "";
}

function getChildren(parentId = "") {
  const normalized = String(parentId || "");
  return state.steps.filter((item) => getItemParentId(item) === normalized);
}

function isDescendantOf(itemId, ancestorId) {
  let current = getWorkflowItem(itemId);
  const target = String(ancestorId || "");
  while (current) {
    const parentId = getItemParentId(current);
    if (!parentId) return false;
    if (parentId === target) return true;
    current = getWorkflowItem(parentId);
  }
  return false;
}

function getFolderDepth(folderId) {
  const folder = getWorkflowItem(folderId);
  if (!isWorkflowFolder(folder)) return 0;
  let depth = 1;
  let current = folder;
  const seen = new Set([folderId]);
  while (current) {
    const parentId = getItemParentId(current);
    if (!parentId || seen.has(parentId)) break;
    const parent = getWorkflowItem(parentId);
    if (!isWorkflowFolder(parent)) break;
    seen.add(parentId);
    depth += 1;
    current = parent;
  }
  return depth;
}

function getRelativeFolderDepth(itemId) {
  const item = getWorkflowItem(itemId);
  if (!item) return 0;
  const ownDepth = isWorkflowFolder(item) ? 1 : 0;
  let maxChildDepth = 0;
  for (const child of getChildren(itemId)) {
    maxChildDepth = Math.max(maxChildDepth, getRelativeFolderDepth(child.id));
  }
  return Math.max(ownDepth, ownDepth + maxChildDepth, maxChildDepth);
}

function sanitizeFolderParents() {
  const folderIds = new Set(state.steps.filter(isWorkflowFolder).map((item) => item.id));
  for (const item of state.steps) {
    if (item.parentId && !folderIds.has(item.parentId)) item.parentId = "";
    if (isWorkflowFolder(item) && item.parentId && isDescendantOf(item.parentId, item.id)) {
      item.parentId = "";
    }
  }
  for (const folder of state.steps.filter(isWorkflowFolder)) {
    while (getFolderDepth(folder.id) > MAX_FOLDER_DEPTH) {
      folder.parentId = getItemParentId(getWorkflowItem(folder.parentId)) || "";
      if (!folder.parentId) break;
    }
  }
}

function getVisibleWorkflowItems(parentId = "", depth = 0, out = []) {
  const children = getChildren(parentId);
  for (const item of children) {
    out.push({ item, depth });
    if (isWorkflowFolder(item) && !item.collapsed) {
      getVisibleWorkflowItems(item.id, depth + 1, out);
    }
  }
  return out;
}

function getWorkflowItemsInTree(parentId = "", depth = 0, out = []) {
  const children = getChildren(parentId);
  for (const item of children) {
    out.push({ item, depth });
    if (isWorkflowFolder(item)) {
      getWorkflowItemsInTree(item.id, depth + 1, out);
    }
  }
  return out;
}

function getStepOrdinalMap() {
  const map = new Map();
  let ordinal = 1;
  for (const entry of getWorkflowItemsInTree()) {
    if (isWorkflowFolder(entry.item)) continue;
    map.set(entry.item.id, ordinal++);
  }
  return map;
}

function getFolderLabel(folder) {
  return folder?.displayName || folder?.name || "New Folder";
}

function getStepLabelText(step) {
  return step?.displayName || step?.datasetTitle || step?.name || "Step";
}

function renumberStepNames() {
  let ordinal = 1;
  for (const entry of getWorkflowItemsInTree()) {
    const item = entry.item;
    if (isWorkflowFolder(item)) continue;
    item.name = `Step ${ordinal++}`;
  }
}

function canPlaceItemInParent(itemId, parentId) {
  const item = getWorkflowItem(itemId);
  const parent = parentId ? getWorkflowItem(parentId) : null;
  if (!item) return false;
  if (parentId && !isWorkflowFolder(parent)) return false;
  if (parentId === itemId) return false;
  if (parentId && isDescendantOf(parentId, itemId)) return false;
  if (!isWorkflowFolder(item)) return true;
  const parentDepth = parentId ? getFolderDepth(parentId) : 0;
  return parentDepth + getRelativeFolderDepth(itemId) <= MAX_FOLDER_DEPTH;
}

function moveWorkflowItem(itemId, parentId = "", targetId = "", position = "end") {
  const item = getWorkflowItem(itemId);
  if (!item) return false;
  const nextParentId = String(parentId || "");
  if (!canPlaceItemInParent(itemId, nextParentId)) return false;

  item.parentId = nextParentId;

  const without = state.steps.filter((s) => s.id !== itemId);
  let insertIndex = without.length;
  const targetIndex = targetId ? without.findIndex((s) => s.id === targetId) : -1;
  if (targetIndex >= 0) {
    insertIndex = position === "after" ? targetIndex + 1 : targetIndex;
  } else if (position === "start") {
    insertIndex = without.findIndex((s) => getItemParentId(s) === nextParentId);
    if (insertIndex < 0) insertIndex = without.length;
  }
  without.splice(insertIndex, 0, item);
  state.steps = without;
  renumberStepNames();
  return true;
}

function getNextFolderName(parentId = "") {
  const existing = new Set(getChildren(parentId).filter(isWorkflowFolder).map((item) => getFolderLabel(item)));
  let i = 1;
  while (existing.has(`New Folder ${i}`)) i += 1;
  return `New Folder ${i}`;
}

function addWorkflowFolder(parentId = "") {
  const normalizedParentId = String(parentId || "");
  const parent = normalizedParentId ? getWorkflowItem(normalizedParentId) : null;
  if (normalizedParentId && !isWorkflowFolder(parent)) return null;
  if (normalizedParentId && getFolderDepth(normalizedParentId) >= MAX_FOLDER_DEPTH) {
    setHint("Workflow folders support up to 3 nested levels.");
    return null;
  }
  const id = `folder_${state.nextId++}`;
  const name = getNextFolderName(normalizedParentId);
  const folder = {
    id,
    itemType: WORKFLOW_ITEM_FOLDER,
    name,
    displayName: name,
    parentId: normalizedParentId,
    collapsed: false,
  };
  state.steps.push(folder);
  return folder;
}

function deleteWorkflowItem(itemId) {
  const item = getWorkflowItem(itemId);
  if (!item) return;
  if (isWorkflowFolder(item)) {
    const parentId = getItemParentId(item);
    for (const child of getChildren(item.id)) {
      child.parentId = parentId;
    }
  }
  const idx = state.steps.findIndex((s) => s.id === itemId);
  if (idx >= 0) state.steps.splice(idx, 1);
  if (state.activeId === itemId || !getWorkflowItem(state.activeId)) {
    state.activeId = state.steps.find((s) => !isWorkflowFolder(s))?.id || null;
  }
  renumberStepNames();
}

function normalizeActiveWorkflowItem() {
  const active = getWorkflowItem(state.activeId);
  if (active && !isWorkflowFolder(active)) return;
  state.activeId = state.steps.find((s) => !isWorkflowFolder(s))?.id || null;
}

function applyDatasetSettingsToStorage(stepId, settings) {
  if (!stepId || !settings) return;
  try {
    const payload = {
      project: settings.project || "",
      path: settings.path || "",
      tri: settings.tri || "",
      originLen: settings.originLen || "",
      devLen: settings.devLen || "",
      linkLen: !!settings.linkLen,
      cumulative: settings.cumulative !== undefined ? !!settings.cumulative : true,
    };
    localStorage.setItem(`${TRI_INPUTS_KEY}::${stepId}`, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

function resetWorkflowEmbeds() {
  datasetEmbedCache.clear();
  dfmEmbedCache.clear();
  const host = document.getElementById("embedHost");
  if (host) host.innerHTML = "";
}

async function loadWorkflowSnapshot(data) {
  if (!data || typeof data !== "object") return;

  suppressDirty = true;
  try {
    const rawSteps = Array.isArray(data.steps) ? data.steps : [];
    const steps = rawSteps.map((s, i) => normalizeLoadedStep(s, i));

    resetWorkflowEmbeds();

    state.steps = steps;
    state.activeId = data.activeId || (steps[0]?.id ?? null);
    state.nextId = data.nextId || computeNextId(steps);
    sanitizeFolderParents();
    normalizeActiveWorkflowItem();
    enforceSingleGlobalControlStep(state.activeId || "");
    state.globalControl = normalizeGlobalControl(data.globalControl);
    saveGlobalControlToStorage(state.globalControl);
    broadcastGlobalControlChange();

    if (data.name) setWorkflowTitle(String(data.name));

    if (Number.isFinite(data.sidebarWidth)) {
      applySidebarWidth(Number(data.sidebarWidth));
      try { localStorage.setItem(WF_SIDEBAR_W_KEY, String(Math.round(Number(data.sidebarWidth)))); } catch {}
    }

    for (const s of steps) {
      if (s.datasetSettings) {
        applyDatasetSettingsToStorage(s.id, s.datasetSettings);
      }
    }

    render();
    saveState();

    setWorkflowDirty(false);
    lastSaveSignature = JSON.stringify(data);
    setLastSavedPath("");
  } finally {
    suppressDirty = false;
  }
}

function beginWorkflowTitleEdit() {
  const el = document.getElementById("sidebarTitle");
  if (!el) return;
  const current = el.textContent || "Workflow Designer";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "wfTitleInput";
  input.value = current;

  const finish = (commit) => {
    if (commit) {
      const v = input.value.trim() || "Workflow Designer";
      setWorkflowTitle(v);
    }
    el.textContent = getWorkflowTitle();
    input.replaceWith(el);
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));

  el.replaceWith(input);
  input.focus();
  input.select();
}

async function loadState() {
  if (isFresh) {
    state.steps = [];
    state.activeId = null;
    state.nextId = 1;
    state.globalControl = await buildInitialGlobalControlFromUserPrefs();
    saveGlobalControlToStorage(state.globalControl);
    saveState();
    return;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      state.globalControl = await buildInitialGlobalControlFromUserPrefs();
      saveGlobalControlToStorage(state.globalControl);
      saveState();
      return;
    }
    const s = JSON.parse(raw);
    if (!s || !Array.isArray(s.steps)) return;
    state.steps = s.steps;
    state.activeId = s.activeId || (s.steps[0]?.id ?? null);
    state.nextId = s.nextId || (s.steps.length + 1);
    state.steps = state.steps.map((step, i) => normalizeLoadedStep(step, i));
    sanitizeFolderParents();
    normalizeActiveWorkflowItem();
    enforceSingleGlobalControlStep(state.activeId || "");
    state.globalControl = normalizeGlobalControl(s.globalControl || loadGlobalControlFromStorage());
    saveGlobalControlToStorage(state.globalControl);
  } catch {}
}

function getActiveStep() {
  const item = state.steps.find(s => s.id === state.activeId) || null;
  return item && !isWorkflowFolder(item) ? item : null;
}

function setHint(txt) {
  if (wsHintEl) wsHintEl.textContent = txt || "";
}

function getStepLabel(step) {
  const ordinal = getStepOrdinalMap().get(step?.id) || "";
  return ordinal ? `Step (${ordinal})` : "Step";
}

function findGlobalControlStep(excludeStepId = "") {
  for (const s of state.steps) {
    if (!s || s.mode !== "global_control") continue;
    if (excludeStepId && s.id === excludeStepId) continue;
    return s;
  }
  return null;
}

function enforceSingleGlobalControlStep(preferredStepId = "") {
  let keeper = null;
  if (preferredStepId) {
    keeper = state.steps.find((s) => s?.id === preferredStepId && s.mode === "global_control") || null;
  }
  let changed = false;
  for (const s of state.steps) {
    if (!s || s.mode !== "global_control") continue;
    if (!keeper) {
      keeper = s;
      continue;
    }
    if (s.id === keeper.id) continue;
    s.mode = "picker";
    changed = true;
  }
  return changed;
}

function clearWorkspace() {
  if (!workspaceEl) return;
  const host = ensureEmbedHost();
  for (const child of Array.from(workspaceEl.children)) {
    if (child !== host) child.remove();
  }
  if (host) host.style.display = "none";
}

function ensureEmbedHost() {
  if (!workspaceEl) return null;
  let host = document.getElementById("embedHost");
  if (!host) {
    host = document.createElement("div");
    host.id = "embedHost";
    host.style.width = "100%";
    host.style.height = "100%";
    host.style.display = "none";
    workspaceEl.appendChild(host);
  }
  return host;
}

function renderPickerCards(step) {
  clearWorkspace();
  setHint(`${getStepLabel(step)} — select an object`);

  const wrap = document.createElement("div");
  wrap.className = "cards";

  const mkCard = (title, desc, onClick, opts = {}) => {
    const disabled = !!opts.disabled;
    const c = document.createElement("div");
    c.className = disabled ? "card" : "card clickable";
    c.innerHTML = `<h3>${title}</h3><div class="muted">${desc}</div>`;
    if (disabled) {
      c.style.opacity = "0.55";
      c.style.cursor = "not-allowed";
    }
    c.addEventListener("click", () => {
      if (disabled) {
        if (typeof opts.onDisabledClick === "function") opts.onDisabledClick();
        return;
      }
      onClick();
    });
    return c;
  };

  // 1) Open Dataset -> embed dataset_viewer
  wrap.appendChild(
    mkCard(
      "Open Dataset",
      "Load a triangle or vector to this workspace.",
      () => {
        step.mode = "dataset";
        renderWorkspaceForStep(step);
        saveState();
      }
    )
  );

  // 2) placeholder
  wrap.appendChild(
    mkCard(
      "DFM",
      "Development factor method ...",
      () => {
        step.mode = "dfm";
        renderWorkspaceForStep(step);
        saveState();
      }
    )
  );

  // 3) placeholder
  wrap.appendChild(
    mkCard(
      "Result Selection",
      "Placeholder (future).",
      () => {
        step.mode = "result_selection";
        renderWorkspaceForStep(step);
      }
    )
  );

  // 4) global control
  const existingGlobalControl = findGlobalControlStep(step.id);
  wrap.appendChild(
    mkCard(
      "Global Control",
      existingGlobalControl
        ? `Already configured in ${getStepLabel(existingGlobalControl)}.`
        : "Set default project and reserving class for the workflow.",
      () => {
        const occupied = findGlobalControlStep(step.id);
        if (occupied) {
          setHint(`Global Control already exists in ${getStepLabel(occupied)}.`);
          return;
        }
        step.mode = "global_control";
        renderWorkspaceForStep(step);
        saveState();
      },
      {
        disabled: !!existingGlobalControl,
        onDisabledClick: () => {
          setHint(`Global Control already exists in ${getStepLabel(existingGlobalControl)}.`);
        },
      }
    )
  );

  workspaceEl.appendChild(wrap);
}

function renderEmbeddedDataset(step) {
  clearWorkspace();
  setHint(`${getStepLabel(step)} \u2014 View Dataset`);

  const host = ensureEmbedHost();
  if (!host) return;
  host.style.display = "";

  let iframe = datasetEmbedCache.get(step.id);
  if (!iframe) {
    iframe = document.createElement("iframe");
    iframe.className = "embedFrame";
    const params = new URLSearchParams();
    if (step.datasetId) params.set("ds", step.datasetId);
    params.set("inst", step.id || "step");
    params.set("wf", instanceId);
    iframe.src = `/ui/dataset_viewer/dataset_viewer.html?${params.toString()}`;
    iframe.addEventListener("load", () => {
      try {
        iframe.contentWindow?.postMessage(
          { type: "arcrho:set-zoom", zoom: lastZoomValue, statusBarHeight: lastStatusBarHeight },
          "*"
        );
      } catch {
        // ignore
      }
      try {
        iframe.contentWindow?.postMessage(
          { type: "arcrho:workflow-global-changed", globalControl: normalizeGlobalControl(state.globalControl), wf: instanceId },
          "*"
        );
      } catch {
        // ignore
      }
    });
    datasetEmbedCache.set(step.id, iframe);
    host.appendChild(iframe);
  } else {
    try {
      iframe.contentWindow?.postMessage(
        { type: "arcrho:workflow-global-changed", globalControl: normalizeGlobalControl(state.globalControl), wf: instanceId },
        "*"
      );
    } catch {
      // ignore
    }
  }

  for (const [id, frame] of datasetEmbedCache) {
    frame.style.display = id === step.id ? "block" : "none";
  }
  for (const [, frame] of dfmEmbedCache) {
    frame.style.display = "none";
  }
}

function renderEmbeddedDfm(step) {
  clearWorkspace();
  setHint(`${getStepLabel(step)} \u2014 Development Factor Method`);

  const host = ensureEmbedHost();
  if (!host) return;
  host.style.display = "";

  let iframe = dfmEmbedCache.get(step.id);
  if (!iframe) {
    iframe = document.createElement("iframe");
    iframe.className = "embedFrame";
    const params = new URLSearchParams();
    params.set("inst", step.id || "step");
    params.set("wf", instanceId);
    if (step.datasetId) params.set("ds", step.datasetId);
    if (step.dfmTab) params.set("tab", step.dfmTab);
    const proj = step.dfmSettings?.project || "";
    const rc = step.dfmSettings?.reservingClass || "";
    const outputType = step.dfmSettings?.outputType || "";
    if (proj && !isWorkflowDefaultReference(proj)) params.set("project", proj);
    if (rc && !isWorkflowDefaultReference(rc)) params.set("class", rc);
    if (outputType) params.set("output_type", outputType);
    iframe.src = `/ui/method_pages/dfm/dfm.html?${params.toString()}`;
    iframe.addEventListener("load", () => {
      try {
        iframe.contentWindow?.postMessage(
          { type: "arcrho:set-zoom", zoom: lastZoomValue, statusBarHeight: lastStatusBarHeight },
          "*"
        );
      } catch {
        // ignore
      }
      try {
        const font = loadAppFontFromStorage();
        if (font) {
          iframe.contentWindow?.postMessage({ type: "arcrho:set-app-font", font }, "*");
        }
      } catch {
        // ignore
      }
      try {
        iframe.contentWindow?.postMessage(
          { type: "arcrho:workflow-global-changed", globalControl: normalizeGlobalControl(state.globalControl), wf: instanceId },
          "*"
        );
      } catch {
        // ignore
      }
    });
    dfmEmbedCache.set(step.id, iframe);
    host.appendChild(iframe);
  } else {
    try {
      iframe.contentWindow?.postMessage(
        { type: "arcrho:workflow-global-changed", globalControl: normalizeGlobalControl(state.globalControl), wf: instanceId },
        "*"
      );
    } catch {
      // ignore
    }
  }

  for (const [id, frame] of dfmEmbedCache) {
    frame.style.display = id === step.id ? "block" : "none";
  }
  for (const [, frame] of datasetEmbedCache) {
    frame.style.display = "none";
  }
}

function renderPlaceholder(step, title) {
  clearWorkspace();
  setHint(`${getStepLabel(step)} — ${title}`);

  const box = document.createElement("div");
  box.className = "card";
  box.innerHTML = `
    <h3>${title}</h3>
    <div class="muted">Placeholder workspace. Later you can render a real UI here.</div>
    <div style="margin-top:10px;">
      <button id="backToPickerBtn">Back</button>
    </div>
  `;
  workspaceEl.appendChild(box);

  box.querySelector("#backToPickerBtn")?.addEventListener("click", () => {
    step.mode = "picker";
    renderWorkspaceForStep(step);
    saveState();
  });
}

/* ============================================================
   Reserving-class tree picker (floating draggable window)
   ============================================================ */

async function openReservingClassTree(projectName, targetInput, anchorElement = null) {
  await openReservingClassPicker({
    projectName,
    workflowId: instanceId,
    initialPath: targetInput?.value || "",
    anchorElement: anchorElement || targetInput || null,
    setStatus: setHint,
    title: "Reserving Class",
    onError: (err) => {
      console.error("Failed to load reserving class paths:", err);
      setHint("Error loading reserving class paths.");
    },
    onSelect: (path) => {
      if (targetInput) {
        targetInput.value = path;
        targetInput.dispatchEvent(new Event("input", { bubbles: true }));
        targetInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
  });
}

async function openProjectNameTree(targetInput, anchorElement = null) {
  await openProjectNameTreePicker({
    workflowId: instanceId,
    initialProject: targetInput?.value || "",
    anchorElement: anchorElement || targetInput || null,
    setStatus: setHint,
    title: "Select a Project",
    onError: (err) => {
      console.error("Failed to load project tree:", err);
      setHint("Error loading project tree.");
    },
    onSelect: (projectName) => {
      if (!targetInput) return;
      targetInput.value = String(projectName || "").trim();
      targetInput.dispatchEvent(new Event("input", { bubbles: true }));
      targetInput.dispatchEvent(new Event("change", { bubbles: true }));
    },
  });
}

function renderGlobalControl(step) {
  clearWorkspace();
  setHint("Global Control - defaults for this workflow");

  const box = document.createElement("div");
  box.className = "card wide";
  box.innerHTML = `
    <h3>Global Control</h3>
    <div class="muted">Set defaults for workflow Dataset and DFM objects.</div>
    <table class="gc-table">
      <thead>
        <tr>
          <th style="width: 30%;">Variable</th>
          <th style="width: 22%;">Type</th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody id="gcTableBody"></tbody>
    </table>
    <div id="gcTableCtxMenu" class="gcCtxMenu">
      <div class="gcCtxItem" data-action="add">Add Row</div>
      <div class="gcCtxItem" data-action="delete">Delete Row</div>
    </div>
    <div class="gc-hint">Right-click the table to add or delete rows. Changes save automatically.</div>
  `;
  workspaceEl.appendChild(box);

  const tbody = box.querySelector("#gcTableBody");
  const defaults = normalizeGlobalControl(state.globalControl);
  const rows = Array.isArray(defaults.vars) ? defaults.vars : [];

  const defaultNameForKey = (key) => getDefaultGlobalVarName(key);
  let pendingApplyTimer = null;
  let contextRow = null;

  /* ---- fetch project names for dropdown ---- */
  let _projectNames = [];
  const _projectNamesReady = fetch("/arcrho/projects")
    .then((r) => r.ok ? r.json() : { projects: [] })
    .then((d) => { _projectNames = (d.projects || []).slice().reverse(); })
    .catch(() => { _projectNames = []; });

  /** Build a custom filterable combo-box and return the wrapper element. */
  function buildProjectCombo(initialValue) {
    const wrap = document.createElement("div");
    wrap.className = "gc-combo";

    const inp = document.createElement("input");
    inp.className = "gc-value";
    inp.type = "text";
    inp.autocomplete = "off";
    inp.placeholder = "Loading...";

    const ul = document.createElement("ul");
    ul.className = "gc-combo-list";

    const pickerBtn = document.createElement("button");
    pickerBtn.type = "button";
    pickerBtn.className = "gc-tree-icon gc-project-tree-btn";
    pickerBtn.title = "Browse projects";
    pickerBtn.textContent = "...";

    wrap.appendChild(inp);
    wrap.appendChild(ul);
    wrap.appendChild(pickerBtn);

    let activeIdx = -1;

    const populateList = (filter) => {
      ul.innerHTML = "";
      activeIdx = -1;
      const q = (filter || "").toLowerCase();
      const filtered = q
        ? _projectNames.filter((p) => p.toLowerCase().includes(q))
        : _projectNames;
      filtered.forEach((p) => {
        const li = document.createElement("li");
        li.textContent = p;
        li.addEventListener("mousedown", (e) => {
          e.preventDefault();
          inp.value = p;
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          wrap.classList.remove("open");
        });
        ul.appendChild(li);
      });
    };

    const open = () => { populateList(inp.value); wrap.classList.add("open"); };
    const close = () => { wrap.classList.remove("open"); activeIdx = -1; };

    inp.addEventListener("focus", open);
    inp.addEventListener("input", () => { populateList(inp.value); wrap.classList.add("open"); });
    inp.addEventListener("blur", () => setTimeout(close, 150));
    inp.addEventListener("keydown", (e) => {
      const items = ul.querySelectorAll("li");
      if (!items.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        activeIdx = Math.min(activeIdx + 1, items.length - 1);
        items.forEach((li, i) => li.classList.toggle("active", i === activeIdx));
        items[activeIdx]?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        activeIdx = Math.max(activeIdx - 1, 0);
        items.forEach((li, i) => li.classList.toggle("active", i === activeIdx));
        items[activeIdx]?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (activeIdx >= 0 && items[activeIdx]) {
          inp.value = items[activeIdx].textContent;
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
        }
        close();
      } else if (e.key === "Escape") {
        close();
      }
    });

    pickerBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      close();
      void openProjectNameTree(inp, inp);
    });

    _projectNamesReady.then(() => {
      inp.placeholder = "";
      if (initialValue) inp.value = initialValue;
    });

    return wrap;
  }

  const renderRow = (row) => {
    const tr = document.createElement("tr");
    tr.dataset.key = row.key || "";

    const typeOptionsHtml = GLOBAL_VAR_TYPE_OPTIONS
      .map((opt) => `<option value="${opt.value}">${opt.label}</option>`)
      .join("");

    tr.innerHTML = `
      <td><input class="gc-name" type="text" /></td>
      <td><select class="gc-type">${typeOptionsHtml}</select></td>
      <td class="gc-value-cell"></td>
    `;

    const nameInput = tr.querySelector(".gc-name");
    const typeSelect = tr.querySelector(".gc-type");
    const valueCell = tr.querySelector(".gc-value-cell");

    if (nameInput) nameInput.value = row.name || defaultNameForKey(row.key);
    if (typeSelect) {
      typeSelect.value = normalizeGlobalVarType(row.type, row.key);
    }

    const getProjectInput = () => {
      const byKey = tbody?.querySelector('tr[data-key="project"] .gc-value');
      if (byKey) return byKey;
      const trs = tbody ? Array.from(tbody.querySelectorAll("tr")) : [];
      for (const rowEl of trs) {
        const key = rowEl.dataset.key || "";
        const type = normalizeGlobalVarType(rowEl.querySelector(".gc-type")?.value, key);
        if (type !== GLOBAL_VAR_TYPE_PROJECT) continue;
        const input = rowEl.querySelector(".gc-value");
        if (input) return input;
      }
      return null;
    };

    const renderValueInput = () => {
      if (!valueCell) return;
      const currentValue = tr.querySelector(".gc-value")?.value || row.value || "";
      const type = normalizeGlobalVarType(typeSelect?.value, row.key);
      valueCell.innerHTML = "";

      if (type === GLOBAL_VAR_TYPE_PROJECT) {
        valueCell.appendChild(buildProjectCombo(currentValue));
        return;
      }

      const valueInput = document.createElement("input");
      valueInput.className = "gc-value";
      valueInput.type = "text";
      valueInput.value = currentValue;

      if (type === GLOBAL_VAR_TYPE_RESERVING_CLASS) {
        const wrap = document.createElement("div");
        wrap.className = "gc-value-with-icon";
        wrap.appendChild(valueInput);

        const icon = document.createElement("button");
        icon.type = "button";
        icon.className = "gc-tree-icon";
        icon.title = "Browse reserving classes";
        icon.textContent = "...";
        icon.addEventListener("click", () => {
          const projInput = getProjectInput();
          const projName = projInput ? projInput.value.trim() : "";
          if (!projName) { setHint("Please select a project first."); return; }
          openReservingClassTree(projName, valueInput, valueInput);
        });
        wrap.appendChild(icon);
        valueCell.appendChild(wrap);
        return;
      }

      valueCell.appendChild(valueInput);
    };

    renderValueInput();
    typeSelect?.addEventListener("change", () => {
      renderValueInput();
      scheduleApply();
    });

    if (row.key) {
      if (nameInput) {
        nameInput.disabled = true;
        nameInput.title = "System variable";
      }
    }

    tbody?.appendChild(tr);
  };

  rows.forEach(renderRow);

  const collectRows = () => {
    const out = [];
    const trs = tbody ? Array.from(tbody.querySelectorAll("tr")) : [];
    for (const tr of trs) {
      const key = tr.dataset.key || "";
      const name = tr.querySelector(".gc-name")?.value?.trim() || "";
      const type = normalizeGlobalVarType(tr.querySelector(".gc-type")?.value, key);
      const value = tr.querySelector(".gc-value")?.value?.trim() || "";
      if (!key && !name && !value) continue;
      out.push({ key, name: key ? (name || defaultNameForKey(key)) : name, type, value });
    }
    return out;
  };

  const apply = () => {
    if (pendingApplyTimer) {
      clearTimeout(pendingApplyTimer);
      pendingApplyTimer = null;
    }
    const next = { vars: collectRows() };
    state.globalControl = normalizeGlobalControl(next);
    saveState();
    broadcastGlobalControlChange();
  };

  const scheduleApply = () => {
    if (pendingApplyTimer) clearTimeout(pendingApplyTimer);
    pendingApplyTimer = setTimeout(() => {
      apply();
      setHint("Global Control - defaults saved");
    }, 120);
  };

  const addRow = () => {
    renderRow({ key: "", name: "", type: GLOBAL_VAR_TYPE_STRING, value: "" });
    apply();
    setHint("Global Control - defaults saved");
  };

  const deleteRow = (rowEl) => {
    if (!rowEl) return;
    if (rowEl.dataset.key) {
      setHint("<Default Project> and Default Path rows cannot be deleted.");
      return;
    }
    rowEl.remove();
    apply();
    setHint("Global Control - defaults saved");
  };

  tbody?.addEventListener("input", scheduleApply);
  tbody?.addEventListener("change", scheduleApply);

  const ctxMenu = box.querySelector("#gcTableCtxMenu");
  box.querySelector(".gc-table")?.addEventListener("contextmenu", (event) => {
    if (!ctxMenu) return;
    event.preventDefault();
    contextRow = event.target?.closest?.("tr") || null;
    openContextMenu(ctxMenu, {
      clientX: event.clientX,
      clientY: event.clientY,
      openClass: "open",
      align: "top-left",
    });
  });

  ctxMenu?.addEventListener("click", (event) => {
    const item = event.target?.closest?.(".gcCtxItem");
    const action = item?.dataset?.action || "";
    ctxMenu.classList.remove("open");
    ctxMenu.style.display = "none";
    if (action === "add") addRow();
    if (action === "delete") deleteRow(contextRow);
  });

  window.addEventListener("mousedown", (event) => {
    if (ctxMenu?.contains(event.target)) return;
    ctxMenu?.classList.remove("open");
    if (ctxMenu) ctxMenu.style.display = "none";
  });
}

function bindDatasetTitleUpdates() {
  if (window.__workflowTitleWired) return;
  window.__workflowTitleWired = true;

  window.addEventListener("message", (e) => {
    if (e?.data?.type === "arcrho:dataset-settings-changed") {
      const stepId = e.data.stepId;
      if (!stepId) return;
      const step = state.steps.find(s => s.id === stepId);
      if (!step) return;
      step.datasetSettings = e.data.settings || null;
      markWorkflowDirty();
      return;
    }

    if (e?.data?.type === "arcrho:update-active-tab-title") {
      if (!e.data.userAction) return; // ignore sync/init, only react to user changes
      const inst = e.data.inst;
      const title = (e.data.title || "").trim();
      if (!inst || !title) return;
      const step = state.steps.find(s => s.id === inst);
      if (!step || step.mode !== "dfm") return;
      step.datasetTitle = title;
      if (!step.isCustomName) {
        step.displayName = title;
      }
      renderStepsList();
      if (step.id === state.activeId) {
        setHint(`${getStepLabel(step)} \u2014 Development Factor Method`);
      }
      saveState();
      return;
    }

    if (e?.data?.type !== "arcrho:update-workflow-step-title") return;
    const stepId = e.data.stepId;
    const title = (e.data.title || "").trim();
    if (!stepId || !title) return;

    const step = state.steps.find(s => s.id === stepId);
    if (!step) return;
    if (step.mode === "dfm") return;

    step.datasetTitle = title;
    if (!step.isCustomName) {
      step.displayName = title;
    }

    renderStepsList();
    saveState();
  });
}

function wireWorkflowCommands() {
  if (window.__workflowCmdWired) return;
  window.__workflowCmdWired = true;

  window.addEventListener("message", (e) => {
    const type = e?.data?.type;
    if (type === "arcrho:workflow-save") {
      void saveWorkflowToDefaultDir({ force: true });
    } else if (type === "arcrho:workflow-save-as") {
      void saveWorkflowAs();
    } else if (type === "arcrho:workflow-toggle-nav") {
      const collapsed = document.body.classList.contains("sidebar-collapsed");
      setSidebarCollapsed(!collapsed);
    } else if (type === "arcrho:workflow-load") {
      void loadWorkflowSnapshot(e.data.data);
    }
  });
}

function shouldIgnoreWorkflowHotkey(e) {
  const el = e.target;
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  return false;
}

function wireWorkflowHotkeys() {
  if (window.__workflowHotkeysWired) return;
  window.__workflowHotkeysWired = true;

  window.addEventListener("keydown", (e) => {
    const key = (e.key || "").toLowerCase();
    const hasMod = e.ctrlKey;

    if (e.altKey && key === "w") {
      e.preventDefault();
      e.stopPropagation();
      window.parent.postMessage({ type: "arcrho:close-active-tab" }, "*");
      return;
    }

    if (!hasMod) return;

    if (shouldIgnoreWorkflowHotkey(e)) return;

    if (key === "s") {
      e.preventDefault();
      e.stopPropagation();
      const action = e.shiftKey ? "file_save_as" : "file_save";
      window.parent.postMessage({ type: "arcrho:hotkey", action }, "*");
      return;
    }

    if (key === "o") {
      e.preventDefault();
      e.stopPropagation();
      window.parent.postMessage({ type: "arcrho:hotkey", action: "file_import" }, "*");
      return;
    }

    if (key === "p") {
      e.preventDefault();
      e.stopPropagation();
      window.parent.postMessage({ type: "arcrho:hotkey", action: "file_print" }, "*");
      return;
    }

    if (key === "q") {
      e.preventDefault();
      e.stopPropagation();
      window.parent.postMessage({ type: "arcrho:hotkey", action: "app_shutdown" }, "*");
      return;
    }

    if (e.shiftKey && key === "f") {
      e.preventDefault();
      e.stopPropagation();
      window.parent.postMessage({ type: "arcrho:hotkey", action: "view_toggle_nav" }, "*");
      return;
    }

    if (e.altKey && key === "r" && hasMod) {
      e.preventDefault();
      e.stopPropagation();
      window.parent.postMessage({ type: "arcrho:hotkey", action: "file_restart" }, "*");
    }
  }, { capture: true });
}

function renderWorkspaceForStep(step) {
  // debug
  if (inspectorEl) inspectorEl.textContent = JSON.stringify(step, null, 2);

  const mode = step.mode || "picker";
  if (mode === "dataset") return renderEmbeddedDataset(step);
  if (mode === "dfm" || mode === "new_method") return renderEmbeddedDfm(step);
  if (mode === "result_selection") return renderPlaceholder(step, "Result Selection");
  if (mode === "global_control") {
    const occupied = findGlobalControlStep(step.id);
    if (occupied) {
      step.mode = "picker";
      saveState();
      setHint(`Global Control already exists in ${getStepLabel(occupied)}.`);
      return renderPickerCards(step);
    }
    return renderGlobalControl(step);
  }
  return renderPickerCards(step);
}

let __stepCtx = { open: false, stepId: null };

function closeStepCtxMenu() {
  const menu = document.getElementById("stepCtxMenu");
  if (menu) {
    menu.classList.remove("open");
    menu.style.display = "none";
    menu.style.left = "";
    menu.style.top = "";
    menu.style.visibility = "";
    menu.style.transform = "";
  }
  __stepCtx.open = false;
  __stepCtx.stepId = null;
}

function openStepCtxMenu(stepId, anchorEl, x, y) {
  const menu = document.getElementById("stepCtxMenu");
  if (!menu) return;
  __stepCtx.open = true;
  __stepCtx.stepId = stepId;
  const item = getWorkflowItem(stepId);
  const canNestFolder = !item
    ? true
    : isWorkflowFolder(item)
      ? getFolderDepth(item.id) < MAX_FOLDER_DEPTH
      : true;
  menu.querySelectorAll(".stepCtxItem").forEach((menuItem) => {
    const action = menuItem.dataset.action || "";
    if (action === "new_folder") {
      menuItem.classList.toggle("disabled", !canNestFolder);
      return;
    }
    const disabled = !item || (action === "duplicate" && isWorkflowFolder(item));
    menuItem.classList.toggle("disabled", disabled);
  });

  openContextMenu(menu, {
    anchorEl,
    clientX: x,
    clientY: y,
    offset: 8,
    openClass: "open",
    align: "top-left",
  });
}

function runStepCtxAction(action) {
  const step = getWorkflowItem(__stepCtx.stepId);
  const contextParentId = step
    ? (isWorkflowFolder(step) ? step.id : getItemParentId(step))
    : "";

  if (action === "new_folder") {
    const folder = addWorkflowFolder(contextParentId);
    closeStepCtxMenu();
    if (!folder) return;
    render();
    saveState();
    beginInlineRename(folder.id);
    return;
  }

  if (!step) { closeStepCtxMenu(); return; }

  if (action === "rename") {
    closeStepCtxMenu();
    beginInlineRename(step.id);
    return;
  } else if (action === "duplicate") {
    if (isWorkflowFolder(step)) {
      closeStepCtxMenu();
      return;
    }
    const id = `step_${state.nextId++}`;
    const clone = JSON.parse(JSON.stringify(step));
    clone.id = id;
    if (clone.mode === "global_control") {
      clone.mode = "picker";
    }
    const base = (step.displayName || step.datasetTitle || step.name || "Step");
    clone.displayName = `${base} Copy`;
    clone.isCustomName = true;
    clone.parentId = getItemParentId(step);
    state.steps.push(clone);
    state.activeId = id;
  } else if (action === "delete") {
    deleteWorkflowItem(step.id);
  }

  closeStepCtxMenu();
  render();
  saveState();
}

function wireStepContextMenu() {
  const menu = document.getElementById("stepCtxMenu");
  if (!menu || menu.dataset.wired === "1") return;
  menu.dataset.wired = "1";
  const sidebar = document.getElementById("workflowSidebar");

  menu.addEventListener("click", (event) => {
    const item = event.target?.closest?.(".stepCtxItem");
    if (item?.classList?.contains("disabled")) return;
    const action = item?.dataset?.action;
    if (!action) return;
    runStepCtxAction(action);
  });

  window.addEventListener("click", () => closeStepCtxMenu());
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeStepCtxMenu(); });
  sidebar?.addEventListener("contextmenu", (event) => {
    if (event.target?.closest?.(".stepBtn")) return;
    if (event.target?.closest?.("#stepCtxMenu")) return;
    if (event.target?.closest?.("#sidebarHeader, #addStepTile, #importWorkflowTile")) return;
    event.preventDefault();
    openStepCtxMenu(null, sidebar, event.clientX, event.clientY);
  });
  const stepCtxHotkeys = {
    r: "rename",
    d: "delete",
    b: "duplicate",
    f: "new_folder",
  };
  window.addEventListener("keydown", (e) => {
    if (!__stepCtx.open) return;
    const key = (e.key || "").toLowerCase();
    const action = stepCtxHotkeys[key];
    if (!action) return;
    e.preventDefault();
    runStepCtxAction(action);
  });
}


function beginInlineRename(stepId) {
  const btn = stepsEl.querySelector(`[data-step-id="${stepId}"]`);
  if (!btn) return;

  const step = getWorkflowItem(stepId);
  if (!step) return;

  const current = isWorkflowFolder(step) ? getFolderLabel(step) : getStepLabelText(step);
  const input = document.createElement("input");
  input.type = "text";
  input.className = "stepRenameInput";
  input.value = current;
  input.dataset.stepId = stepId;
  input.style.marginLeft = `${Number(btn.dataset.depth || 0) * 16}px`;

  const finish = (commit) => {
    const val = input.value.trim();
    if (commit) {
      if (isWorkflowFolder(step)) {
        const next = val || "New Folder";
        step.displayName = next;
        step.name = next;
      } else if (val === "") {
        step.displayName = "";
        step.isCustomName = false;
      } else {
        step.displayName = val;
        step.isCustomName = true;
      }
    }
    render();
    saveState();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });

  input.addEventListener("blur", () => finish(true));

  btn.replaceWith(input);
  input.focus();
  input.select();
}

let __dragItemId = null;
let __dropHint = null;

function clearDropIndicators() {
  stepsEl?.querySelectorAll(".drop-before,.drop-after,.drop-into").forEach((el) => {
    el.classList.remove("drop-before", "drop-after", "drop-into");
  });
}

function computeDropHint(event) {
  if (!__dragItemId) return null;
  const targetEl = event.target?.closest?.(".stepBtn");
  if (!targetEl || !stepsEl.contains(targetEl)) {
    return { mode: "root-end", targetId: "" };
  }
  const targetId = targetEl.dataset.stepId || "";
  if (!targetId || targetId === __dragItemId) return null;
  const targetItem = getWorkflowItem(targetId);
  if (!targetItem) return null;
  const rect = targetEl.getBoundingClientRect();
  const offset = event.clientY - rect.top;
  const topZone = rect.height * 0.28;
  const bottomZone = rect.height * 0.72;
  if (isWorkflowFolder(targetItem) && offset >= topZone && offset <= bottomZone) {
    return { mode: "inside", targetId };
  }
  return { mode: offset < rect.height / 2 ? "before" : "after", targetId };
}

function applyDropHintClass(hint) {
  clearDropIndicators();
  if (!hint?.targetId) return;
  const targetEl = stepsEl?.querySelector(`[data-step-id="${hint.targetId}"]`);
  if (!targetEl) return;
  if (hint.mode === "inside") targetEl.classList.add("drop-into");
  if (hint.mode === "before") targetEl.classList.add("drop-before");
  if (hint.mode === "after") targetEl.classList.add("drop-after");
}

function applyDropHint(hint) {
  if (!__dragItemId || !hint) return false;
  if (hint.mode === "inside") {
    const target = getWorkflowItem(hint.targetId);
    if (!isWorkflowFolder(target)) return false;
    if (!canPlaceItemInParent(__dragItemId, target.id)) {
      setHint("Workflow folders support up to 3 nested levels.");
      return false;
    }
    target.collapsed = false;
    return moveWorkflowItem(__dragItemId, target.id, "", "end");
  }
  if (hint.mode === "before" || hint.mode === "after") {
    const target = getWorkflowItem(hint.targetId);
    if (!target) return false;
    const parentId = getItemParentId(target);
    if (!canPlaceItemInParent(__dragItemId, parentId)) {
      setHint("Workflow folders support up to 3 nested levels.");
      return false;
    }
    return moveWorkflowItem(__dragItemId, parentId, target.id, hint.mode);
  }
  return moveWorkflowItem(__dragItemId, "", "", "end");
}

function wireStepDnD() {
  if (stepsEl.dataset.dndWired === "1") return;
  stepsEl.dataset.dndWired = "1";

  stepsEl.addEventListener("dragover", (e) => {
    if (!__dragItemId) return;
    e.preventDefault();
    __dropHint = computeDropHint(e);
    applyDropHintClass(__dropHint);
    e.dataTransfer.dropEffect = "move";
  });

  stepsEl.addEventListener("drop", (e) => {
    if (!__dragItemId) return;
    e.preventDefault();
    const moved = applyDropHint(__dropHint || computeDropHint(e));
    __dragItemId = null;
    __dropHint = null;
    clearDropIndicators();
    if (!moved) {
      renderStepsList();
      return;
    }
    render();
    saveState();
  });

  stepsEl.addEventListener("dragleave", (e) => {
    if (stepsEl.contains(e.relatedTarget)) return;
    clearDropIndicators();
    __dropHint = null;
  });

  stepsEl.addEventListener("contextmenu", (e) => {
    if (e.target?.closest?.(".stepBtn")) return;
    e.preventDefault();
    openStepCtxMenu(null, stepsEl, e.clientX, e.clientY);
  });
}

function renderStepsList() {
  stepsEl.innerHTML = "";
  sanitizeFolderParents();
  const visibleItems = getVisibleWorkflowItems();
  const stepOrdinals = getStepOrdinalMap();

  for (const { item: s, depth } of visibleItems) {
    const isFolder = isWorkflowFolder(s);
    const btn = document.createElement("button");
    btn.className = isFolder ? "stepBtn folderBtn" : "stepBtn";
    btn.dataset.stepId = s.id;
    btn.dataset.depth = String(depth);
    btn.dataset.itemType = isFolder ? WORKFLOW_ITEM_FOLDER : "step";
    const stepIndex = stepOrdinals.get(s.id) || "";
    btn.dataset.stepIndex = String(stepIndex || "");
    btn.setAttribute("draggable", "true");
    btn.style.paddingLeft = `${10 + depth * 16}px`;
    btn.classList.toggle("active", !isFolder && s.id === state.activeId);
    btn.classList.toggle("collapsed", isFolder && !!s.collapsed);
    const label = isFolder ? getFolderLabel(s) : getStepLabelText(s);

    const indexEl = document.createElement("span");
    indexEl.className = "stepIndex";
    indexEl.textContent = isFolder ? "F" : String(stepIndex || "");

    if (isFolder) {
      const folderChevron = document.createElement("span");
      folderChevron.className = "folderChevron";
      folderChevron.textContent = s.collapsed ? "\u203a" : "\u2304";
      btn.appendChild(folderChevron);
    }

    const labelEl = document.createElement("span");
    labelEl.className = "stepLabel";
    labelEl.textContent = label;

    btn.appendChild(indexEl);
    btn.appendChild(labelEl);
    btn.addEventListener("click", () => {
      if (isFolder) {
        s.collapsed = !s.collapsed;
        renderStepsList();
        saveState();
        return;
      }
      state.activeId = s.id;
      render();
      saveState();
    });

    const sendHoverTooltip = (show, evt) => {
      if (!document.body.classList.contains("sidebar-collapsed")) {
        window.parent.postMessage({ type: "arcrho:tooltip", show: false }, "*");
        return;
      }
      if (!show) {
        window.parent.postMessage({ type: "arcrho:tooltip", show: false }, "*");
        return;
      }
      const targetEl = indexEl || btn;
      const rect = targetEl.getBoundingClientRect();
      const clientX = Number(evt?.clientX);
      const clientY = Number(evt?.clientY);
      const x = Number.isFinite(clientX) ? (clientX + 10) : (rect.right + 6);
      const y = Number.isFinite(clientY) ? clientY : (rect.top + rect.height / 2);
      window.parent.postMessage({
        type: "arcrho:tooltip",
        show: true,
        text: label,
        x,
        y,
        coord: "client",
      }, "*");
    };

    btn.addEventListener("mouseenter", (e) => sendHoverTooltip(true, e));
    btn.addEventListener("mousemove", (e) => sendHoverTooltip(true, e));
    btn.addEventListener("mouseleave", () => sendHoverTooltip(false));

    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openStepCtxMenu(s.id, btn, e.clientX, e.clientY);
    });

    btn.addEventListener("dragstart", (e) => {
      __dragItemId = s.id;
      btn.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", s.id); } catch {}
    });

    btn.addEventListener("dragend", () => {
      clearDropIndicators();
      btn.classList.remove("dragging");
      __dragItemId = null;
      __dropHint = null;
    });
    stepsEl.appendChild(btn);
  }

  if (importWorkflowTile) {
    importWorkflowTile.style.display = state.steps.length ? "none" : "block";
  }
}

const WF_RESIZE_DEBUG = false;

function wireSidebarResize() {
  const MIN_W = 220;
  const COLLAPSED_W = 36;
  const MAX_W = 620;
  const sidebar = document.getElementById("workflowSidebar");
  if (!sidebarResizer || !sidebar) return;

  let dragging = false;
  let startX = 0;
  let startW = 0;

  const onMove = (e) => {
    if (!dragging) return;
    if (document.body.classList.contains("sidebar-collapsed")) return;
    const dx = e.clientX - startX;
    let w = startW + dx;
    w = Math.max(MIN_W, Math.min(MAX_W, w));
    sidebar.style.width = `${w}px`;
    try { localStorage.setItem(WF_SIDEBAR_W_KEY, String(w)); } catch {}
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };

  sidebarResizer.addEventListener("mousedown", (e) => {
    if (document.body.classList.contains("sidebar-collapsed")) return;
    dragging = true;
    startX = e.clientX;
    startW = sidebar.getBoundingClientRect().width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    e.preventDefault();
  });

  sidebarResizer.addEventListener("pointerdown", (e) => {
    if (WF_RESIZE_DEBUG) console.debug('resize: pointerdown');
    if (document.body.classList.contains("sidebar-collapsed")) return;
    dragging = true;
    startX = e.clientX;
    startW = sidebar.getBoundingClientRect().width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    sidebarResizer.setPointerCapture?.(e.pointerId);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    e.preventDefault();
  });
}


function addStep() {
  const id = `step_${state.nextId++}`;
  const step = {
    id,
    name: `Step ${state.steps.length + 1}`,
    displayName: "",
    datasetTitle: "",
    isCustomName: false,
    mode: "picker",
    params: {}
  };

  state.steps.push(step);
  state.activeId = id;
  render();
  saveState();
}

function render() {
  renderStepsList();

  const step = getActiveStep();
  if (!step) {
    clearWorkspace();
    // setHint("Select a step to choose an action");
    if (inspectorEl) inspectorEl.textContent = "No step selected.";
    return;
  }

  renderWorkspaceForStep(step);
}


addStepTile?.addEventListener("click", () => {
  addStep();
});
importWorkflowTile?.addEventListener("click", () => {
  window.parent.postMessage({ type: "arcrho:workflow-import" }, "*");
});

// ===== Sidebar collapse logic =====
const toggleSidebarBtn = document.getElementById("toggleSidebarBtn");

const sidebarTitle = document.getElementById("sidebarTitle");
sidebarTitle?.addEventListener("click", () => beginWorkflowTitleEdit());
const workflowTitleRenameBtn = document.getElementById("workflowTitleRenameBtn");
workflowTitleRenameBtn?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  beginWorkflowTitleEdit();
});

toggleSidebarBtn?.addEventListener("click", () => {
  const collapsed = !document.body.classList.contains("sidebar-collapsed");
  setSidebarCollapsed(collapsed);
});

lastSavedPath = loadLastSavedPath();
await loadState();
bindDatasetTitleUpdates();
wireWorkflowCommands();
wireWorkflowHotkeys();
wireStepContextMenu();
wireStepDnD();
wireSidebarResize();
setWorkflowTitle(getWorkflowTitle());
const storedCollapsed = loadSidebarCollapsed();
setSidebarCollapsed(storedCollapsed);
if (!storedCollapsed) {
  const storedW = loadSidebarWidth();
  if (Number.isFinite(storedW)) applySidebarWidth(storedW);
}
render();

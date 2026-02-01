import { openContextMenu } from "./menu_utils.js";

const stepsEl = document.getElementById("steps");
const inspectorEl = document.getElementById("inspector");
const workspaceEl = document.getElementById("workspace");
const wsHintEl = document.getElementById("wsHint");
const addStepTile = document.getElementById("addStepTile");
const importWorkflowTile = document.getElementById("importWorkflowTile");
const sidebarResizer = document.getElementById("sidebarResizer");
const datasetEmbedCache = new Map();
const dfmEmbedCache = new Map();
const TRI_INPUTS_KEY = "adas_tri_inputs";

const state = {
  steps: [],
  activeId: null,
  nextId: 1
};

const qs = new URLSearchParams(window.location.search);
const instanceId = qs.get("inst") || "default";
const isFresh = qs.get("fresh") === "1";
const STORAGE_KEY = `adas_workflow_state_v1::${instanceId}`;
const WF_TITLE_KEY = `adas_workflow_title_v1::${instanceId}`;
const WF_SIDEBAR_W_KEY = `adas_workflow_sidebar_w_v1::${instanceId}`;
const WF_SIDEBAR_COLLAPSED_KEY = `adas_workflow_sidebar_collapsed_v1::${instanceId}`;
const WF_LAST_PATH_KEY = `adas_workflow_last_path_v1::${instanceId}`;
const WF_AUTOSAVE_MS = 60 * 1000;
const ZOOM_STORAGE_KEY = "adas_ui_zoom_pct";
const ZOOM_MODE_KEY = "adas_zoom_mode";
const STATUSBAR_H_KEY = "adas_statusbar_h";
const AUTOSAVE_KEY = "adas_autosave_enabled";
const FONT_STORAGE_KEY = "adas_app_font";

let workflowDirty = false;
let saveInFlight = false;
let lastSaveSignature = "";
let suppressDirty = false;
let lastSavedPath = "";
let lastZoomValue = 100;
let lastStatusBarHeight = 24;
let autoSaveEnabled = true;

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
      frame.contentWindow.postMessage({ type: "adas:set-app-font", font }, "*");
    } catch {
      // ignore
    }
  }
  for (const [, frame] of dfmEmbedCache) {
    if (!frame || !frame.contentWindow) continue;
    try {
      frame.contentWindow.postMessage({ type: "adas:set-app-font", font }, "*");
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

function loadAutoSaveEnabled() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw == null) return true;
    return raw === "1";
  } catch {}
  return true;
}

autoSaveEnabled = loadAutoSaveEnabled();

function broadcastZoomToEmbeddedDatasets() {
  for (const [, frame] of datasetEmbedCache) {
    if (!frame || !frame.contentWindow) continue;
    try {
      frame.contentWindow.postMessage(
        { type: "adas:set-zoom", zoom: lastZoomValue, statusBarHeight: lastStatusBarHeight },
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
        { type: "adas:set-zoom", zoom: lastZoomValue, statusBarHeight: lastStatusBarHeight },
        "*"
      );
    } catch {
      // ignore
    }
  }
}

function applyZoomValue(v, statusBarHeight) {
  try {
    if (localStorage.getItem(ZOOM_MODE_KEY) === "host") {
      const root = document.documentElement;
      const safe = Number(statusBarHeight);
      if (root && Number.isFinite(safe) && safe > 0) {
        root.style.setProperty("--app-safe-bottom", `${safe}px`);
      }
      if (root) root.style.setProperty("--ui-zoom", "1");
      return;
    }
  } catch {}
  const z = Number(v);
  if (!Number.isFinite(z)) return;
  const root = document.documentElement;
  const body = document.body;
  const scale = Math.max(0.5, Math.min(2, z / 100));
  if (root) root.style.zoom = String(scale);
  if (body) body.style.zoom = String(scale);
  if (root) {
    root.style.setProperty("--ui-zoom", String(scale));
    const safe = Number(statusBarHeight);
    if (Number.isFinite(safe) && safe > 0) {
      root.style.setProperty("--app-safe-bottom", `${safe / scale}px`);
    }
  }
  lastZoomValue = z;
  lastStatusBarHeight = Number.isFinite(statusBarHeight) ? Number(statusBarHeight) : lastStatusBarHeight;
  broadcastZoomToEmbeddedDatasets();
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

function loadStatusBarHeight() {
  try {
    const raw = localStorage.getItem(STATUSBAR_H_KEY);
    const v = Number(raw);
    if (Number.isFinite(v)) return v;
  } catch {}
  return 24;
}

applyZoomValue(loadZoomFromStorage(), loadStatusBarHeight());
applyAppFont(loadAppFontFromStorage());

window.addEventListener("message", (e) => {
  if (e?.data?.type === "adas:set-zoom") {
    applyZoomValue(e.data.zoom, e.data.statusBarHeight);
    return;
  }
  if (e?.data?.type === "adas:set-app-font") {
    applyAppFont(e.data.font);
    return;
  }
  if (e?.data?.type === "adas:autosave-toggle") {
    autoSaveEnabled = !!e.data.enabled;
    try { localStorage.setItem(AUTOSAVE_KEY, autoSaveEnabled ? "1" : "0"); } catch {}
  }
});

window.addEventListener("mousedown", () => {
  window.parent.postMessage({ type: "adas:close-shell-menus" }, "*");
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

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      steps: state.steps,
      activeId: state.activeId,
      nextId: state.nextId,
    }));
    if (!suppressDirty) markWorkflowDirty();
  } catch {}
}

function setWorkflowTitle(title) {
  const el = document.getElementById("sidebarTitle");
  if (el) el.textContent = title;
  try { localStorage.setItem(WF_TITLE_KEY, title); } catch {}
  if (!suppressDirty) markWorkflowDirty();
  // Sync to shell tab
  window.parent.postMessage({ type: "adas:update-workflow-tab-title", title, inst: instanceId }, "*");
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
  window.parent.postMessage({ type: "adas:workflow-dirty", dirty, inst: instanceId }, "*");
}

function markWorkflowDirty() {
  setWorkflowDirty(true);
}

function consumeRefreshAutosaveFlag() {
  try {
    const key = `adas_wf_autosave_on_load::${instanceId}`;
    const v = sessionStorage.getItem(key);
    if (v === "1") {
      sessionStorage.removeItem(key);
      return true;
    }
  } catch {}
  return false;
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
      if (e?.data?.type !== "adas:dataset-settings") return;
      if (e.data.requestId !== requestId) return;
      window.removeEventListener("message", onMsg);
      resolve(e.data.settings || null);
    };
    window.addEventListener("message", onMsg);
    iframe.contentWindow.postMessage({ type: "adas:get-dataset-settings", requestId }, "*");
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

async function buildWorkflowSnapshot() {
  const steps = await Promise.all(state.steps.map(async (s) => {
    const datasetSettings = s.mode === "dataset" ? await collectDatasetSettings(s) : null;
    return {
      id: s.id,
      name: s.name,
      displayName: s.displayName || "",
      datasetTitle: s.datasetTitle || "",
      isCustomName: !!s.isCustomName,
      mode: s.mode || "picker",
      datasetId: s.datasetId || "",
      params: s.params || {},
      datasetSettings,
    };
  }));

  return {
    version: 1,
    name: getWorkflowTitle(),
    updatedAt: new Date().toISOString(),
    sidebarWidth: getSidebarWidth(),
    steps,
  };
}

async function saveWorkflowToDefaultDir({ force = false, source = "auto" } = {}) {
  if (!force && !workflowDirty) return;
  if (saveInFlight) return;

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
      window.parent.postMessage({ type: "adas:workflow-saved", path: savedPath, source, inst: instanceId }, "*");
    }
  } catch {
    updateSaveStatus("Save failed");
  } finally {
    saveInFlight = false;
  }
}

async function saveWorkflowAs() {
  const snapshot = await buildWorkflowSnapshot();
  const filename = sanitizeFilename(snapshot.name) + ".adaswf";
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
          window.parent.postMessage({ type: "adas:workflow-saved", path: exportedPath, source: "manual", inst: instanceId }, "*");
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
        types: [{ description: "Workflow", accept: { "application/json": [".adaswf", ".json"] } }],
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
      window.parent.postMessage({ type: "adas:workflow-saved", path: exportedPath, source: "manual", inst: instanceId }, "*");
    }
  } catch {
    updateSaveStatus("Export failed");
  }
}

function normalizeLoadedStep(step, index) {
  const id = step?.id || `step_${index + 1}`;
  const rawMode = step?.mode || "picker";
  const mode = rawMode === "new_method" ? "dfm" : rawMode;
  return {
    id,
    name: step?.name || `Step ${index + 1}`,
    displayName: step?.displayName || "",
    datasetTitle: step?.datasetTitle || "",
    isCustomName: !!step?.isCustomName,
    mode,
    datasetId: step?.datasetId || "",
    params: step?.params || {},
    datasetSettings: step?.datasetSettings || null,
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
      void saveWorkflowToDefaultDir({ force: true });
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

function loadState() {
  if (isFresh) {
    state.steps = [];
    state.activeId = null;
    state.nextId = 1;
    saveState();
    return;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (!s || !Array.isArray(s.steps)) return;
    state.steps = s.steps;
    state.activeId = s.activeId || (s.steps[0]?.id ?? null);
    state.nextId = s.nextId || (s.steps.length + 1);
  } catch {}
}

function getActiveStep() {
  return state.steps.find(s => s.id === state.activeId) || null;
}

function setHint(txt) {
  if (wsHintEl) wsHintEl.textContent = txt || "";
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
  setHint(`${step.name} — select an object`);

  const wrap = document.createElement("div");
  wrap.className = "cards";

  const mkCard = (title, desc, onClick) => {
    const c = document.createElement("div");
    c.className = "card clickable";
    c.innerHTML = `<h3>${title}</h3><div class="muted">${desc}</div>`;
    c.addEventListener("click", onClick);
    return c;
  };

  // 1) Open Dataset -> embed dataset_viewer
  wrap.appendChild(
    mkCard(
      "Open Dataset",
      "Load a triangle or vector to this workspace.",
      () => {
        step.mode = "dataset";
        step.datasetId = step.datasetId || "paid_demo";
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

  workspaceEl.appendChild(wrap);
}

function renderEmbeddedDataset(step) {
  clearWorkspace();
  setHint(`Step: ${step.name} — dataset (${step.datasetId || ""})`);

  const host = ensureEmbedHost();
  if (!host) return;
  host.style.display = "";

  let iframe = datasetEmbedCache.get(step.id);
  if (!iframe) {
    iframe = document.createElement("iframe");
    iframe.className = "embedFrame";
    const ds = encodeURIComponent(step.datasetId || "paid_demo");
    const inst = encodeURIComponent(step.id || "step");
    iframe.src = `/ui/dataset_viewer.html?ds=${ds}&inst=${inst}`;
    iframe.addEventListener("load", () => {
      try {
        iframe.contentWindow?.postMessage(
          { type: "adas:set-zoom", zoom: lastZoomValue, statusBarHeight: lastStatusBarHeight },
          "*"
        );
      } catch {
        // ignore
      }
    });
    datasetEmbedCache.set(step.id, iframe);
    host.appendChild(iframe);
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
  setHint(`Step: ${step.name} â€” DFM`);

  const host = ensureEmbedHost();
  if (!host) return;
  host.style.display = "";

  let iframe = dfmEmbedCache.get(step.id);
  if (!iframe) {
    iframe = document.createElement("iframe");
    iframe.className = "embedFrame";
    const params = new URLSearchParams();
    params.set("inst", step.id || "step");
    if (step.datasetId) params.set("ds", step.datasetId);
    iframe.src = `/ui/DFM.html?${params.toString()}`;
    iframe.addEventListener("load", () => {
      try {
        iframe.contentWindow?.postMessage(
          { type: "adas:set-zoom", zoom: lastZoomValue, statusBarHeight: lastStatusBarHeight },
          "*"
        );
      } catch {
        // ignore
      }
      try {
        const font = loadAppFontFromStorage();
        if (font) {
          iframe.contentWindow?.postMessage({ type: "adas:set-app-font", font }, "*");
        }
      } catch {
        // ignore
      }
    });
    dfmEmbedCache.set(step.id, iframe);
    host.appendChild(iframe);
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
  setHint(`Step: ${step.name} — ${title}`);

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

function bindDatasetTitleUpdates() {
  if (window.__workflowTitleWired) return;
  window.__workflowTitleWired = true;

  window.addEventListener("message", (e) => {
    if (e?.data?.type === "adas:dataset-settings-changed") {
      const stepId = e.data.stepId;
      if (!stepId) return;
      const step = state.steps.find(s => s.id === stepId);
      if (!step) return;
      step.datasetSettings = e.data.settings || null;
      markWorkflowDirty();
      return;
    }

    if (e?.data?.type !== "adas:update-workflow-step-title") return;
    const stepId = e.data.stepId;
    const title = (e.data.title || "").trim();
    if (!stepId || !title) return;

    const step = state.steps.find(s => s.id === stepId);
    if (!step) return;

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
    if (type === "adas:workflow-save") {
      void saveWorkflowToDefaultDir({ force: true, source: "manual" });
    } else if (type === "adas:workflow-save-as") {
      void saveWorkflowAs();
    } else if (type === "adas:workflow-toggle-nav") {
      const collapsed = document.body.classList.contains("sidebar-collapsed");
      setSidebarCollapsed(!collapsed);
    } else if (type === "adas:workflow-load") {
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

  document.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    window.parent.postMessage({ type: "adas:zoom", deltaY: e.deltaY }, "*");
  }, { capture: true, passive: false });

  window.addEventListener("keydown", (e) => {
    const key = (e.key || "").toLowerCase();
    const hasMod = e.ctrlKey;

    if (e.altKey && key === "w") {
      e.preventDefault();
      e.stopPropagation();
      window.parent.postMessage({ type: "adas:close-active-tab" }, "*");
      return;
    }

    if (!hasMod) return;

    if (shouldIgnoreWorkflowHotkey(e)) return;

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

    if (key === "q") {
      e.preventDefault();
      e.stopPropagation();
      window.parent.postMessage({ type: "adas:hotkey", action: "app_shutdown" }, "*");
      return;
    }

    if (e.shiftKey && key === "f") {
      e.preventDefault();
      e.stopPropagation();
      window.parent.postMessage({ type: "adas:hotkey", action: "view_toggle_nav" }, "*");
      return;
    }

    if (e.altKey && key === "r" && hasMod) {
      e.preventDefault();
      e.stopPropagation();
      window.parent.postMessage({ type: "adas:hotkey", action: "file_restart" }, "*");
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
  const step = state.steps.find(s => s.id === __stepCtx.stepId);
  if (!step) { closeStepCtxMenu(); return; }

  if (action === "rename") {
    closeStepCtxMenu();
    beginInlineRename(step.id);
    return;
  } else if (action === "duplicate") {
    const id = `step_${state.nextId++}`;
    const clone = JSON.parse(JSON.stringify(step));
    clone.id = id;
    const base = (step.displayName || step.datasetTitle || step.name || "Step");
    clone.displayName = `${base} Copy`;
    clone.isCustomName = true;
    state.steps.push(clone);
    state.activeId = id;
  } else if (action === "delete") {
    const idx = state.steps.findIndex(s => s.id === step.id);
    if (idx >= 0) state.steps.splice(idx, 1);
    if (state.activeId === step.id) {
      state.activeId = state.steps[0]?.id || null;
    }
  }

  closeStepCtxMenu();
  render();
  saveState();
}

function wireStepContextMenu() {
  const menu = document.getElementById("stepCtxMenu");
  if (!menu || menu.dataset.wired === "1") return;
  menu.dataset.wired = "1";

  menu.addEventListener("click", (event) => {
    const item = event.target?.closest?.(".stepCtxItem");
    const action = item?.dataset?.action;
    if (!action) return;
    runStepCtxAction(action);
  });

  window.addEventListener("click", () => closeStepCtxMenu());
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeStepCtxMenu(); });
  const stepCtxHotkeys = {
    r: "rename",
    d: "delete",
    b: "duplicate",
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
  const btn = stepsEl.querySelector(`button[data-step-id="${stepId}"]`);
  if (!btn) return;

  const step = state.steps.find(s => s.id === stepId);
  if (!step) return;

  const current = (step.displayName || step.datasetTitle || step.name || "");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "stepRenameInput";
  input.value = current;
  input.dataset.stepId = stepId;

  const finish = (commit) => {
    const val = input.value.trim();
    if (commit) {
      if (val === "") {
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

let __dragStepId = null;
let __dragPlaceholderId = null;

function captureStepReflowAnimation() {
  if (!stepsEl) return () => {};
  const items = Array.from(
    stepsEl.querySelectorAll(".stepBtn:not(.dragging):not(.placeholder)")
  );
  const firstRects = new Map();
  items.forEach((el) => {
    firstRects.set(el, el.getBoundingClientRect());
  });
  return () => {
    items.forEach((el) => {
      const first = firstRects.get(el);
      if (!first) return;
      const last = el.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (!dx && !dy) return;
      if (el.animate) {
        el.animate(
          [
            { transform: `translate(${dx}px, ${dy}px)` },
            { transform: "translate(0, 0)" },
          ],
          { duration: 160, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }
        );
      } else {
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        el.getBoundingClientRect();
        el.style.transform = "";
      }
    });
  };
}

function reorderStepsByIds(ids) {
  const map = new Map(state.steps.map(s => [s.id, s]));
  const next = [];
  for (const id of ids) {
    const s = map.get(id);
    if (s) next.push(s);
  }
  // Append any missing (safety)
  for (const s of state.steps) {
    if (!next.some(x => x.id === s.id)) next.push(s);
  }
  state.steps = next;
}

function wireStepDnD() {
  if (stepsEl.dataset.dndWired === "1") return;
  stepsEl.dataset.dndWired = "1";

  stepsEl.addEventListener("dragover", (e) => {
    if (!__dragStepId) return;
    e.preventDefault();

    const overBtn = e.target.closest(".stepBtn");
    if (!overBtn || overBtn.dataset.stepId === __dragStepId) return;

    const rect = overBtn.getBoundingClientRect();
    const before = (e.clientY - rect.top) < (rect.height / 2);
    const placeholder = stepsEl.querySelector(`.stepBtn.placeholder`);
    if (!placeholder) return;

    const animate = captureStepReflowAnimation();
    if (before) {
      stepsEl.insertBefore(placeholder, overBtn);
    } else {
      stepsEl.insertBefore(placeholder, overBtn.nextSibling);
    }
    animate();
  });

  stepsEl.addEventListener("drop", (e) => {
    if (!__dragStepId) return;
    e.preventDefault();

    const placeholder = stepsEl.querySelector(`.stepBtn.placeholder`);
    if (!placeholder) return;

    // Build order from DOM, placing dragged id at placeholder position
    const ordered = [];
    for (const child of stepsEl.children) {
      if (child === placeholder) {
        ordered.push(__dragStepId);
      } else if (child.classList.contains('stepBtn') && !child.classList.contains('placeholder')) {
        const id = child.dataset.stepId;
        if (id && id !== __dragStepId) ordered.push(id);
      }
    }

    reorderStepsByIds(ordered);
    __dragStepId = null;
    render();
    saveState();
  });
}

function renderStepsList() {
  stepsEl.innerHTML = "";

  for (let i = 0; i < state.steps.length; i++) {
    const s = state.steps[i];
    const btn = document.createElement("button");
    btn.className = "stepBtn";
    btn.dataset.stepId = s.id;
    btn.dataset.stepIndex = String(i + 1);
    btn.setAttribute("draggable", "true");
    btn.classList.toggle("active", s.id === state.activeId);
    const label = (s.displayName || s.datasetTitle || s.name || "Step");

    const indexEl = document.createElement("span");
    indexEl.className = "stepIndex";
    indexEl.textContent = String(i + 1);

    const labelEl = document.createElement("span");
    labelEl.className = "stepLabel";
    labelEl.textContent = label;

    btn.appendChild(indexEl);
    btn.appendChild(labelEl);
    btn.addEventListener("click", () => {
      state.activeId = s.id;
      render();
      saveState();
    });

    const sendHoverTooltip = (show, evt) => {
      if (!document.body.classList.contains("sidebar-collapsed")) {
        window.parent.postMessage({ type: "adas:tooltip", show: false }, "*");
        return;
      }
      if (!show) {
        window.parent.postMessage({ type: "adas:tooltip", show: false }, "*");
        return;
      }
      const targetEl = indexEl || btn;
      const rect = targetEl.getBoundingClientRect();
      const clientX = Number(evt?.clientX);
      const clientY = Number(evt?.clientY);
      const x = Number.isFinite(clientX) ? (clientX + 10) : (rect.right + 6);
      const y = Number.isFinite(clientY) ? clientY : (rect.top + rect.height / 2);
      window.parent.postMessage({
        type: "adas:tooltip",
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
      openStepCtxMenu(s.id, btn, e.clientX, e.clientY);
    });

    btn.addEventListener("dragstart", (e) => {
      __dragStepId = s.id;
      btn.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";

      // create placeholder after dragged item
      const ph = document.createElement("button");
      ph.className = "stepBtn placeholder";
      ph.dataset.stepId = "__placeholder__";
      const phIndex = document.createElement("span");
      phIndex.className = "stepIndex";
      phIndex.textContent = btn.dataset.stepIndex || "";
      const phLabel = document.createElement("span");
      phLabel.className = "stepLabel";
      phLabel.textContent = label;
      const phHover = document.createElement("span");
      phHover.className = "stepHoverLabel";
      phHover.textContent = label;
      ph.appendChild(phIndex);
      ph.appendChild(phLabel);
      ph.appendChild(phHover);
      __dragPlaceholderId = ph.dataset.stepId;
      stepsEl.insertBefore(ph, btn.nextSibling);
    });

    btn.addEventListener("dragend", () => {
      const placeholder = stepsEl.querySelector(`.stepBtn.placeholder`);
      if (placeholder && placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
      btn.classList.remove("dragging");
      __dragStepId = null;
      __dragPlaceholderId = null;
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
  window.parent.postMessage({ type: "adas:workflow-import" }, "*");
});

// ===== Sidebar collapse logic =====
const toggleSidebarBtn = document.getElementById("toggleSidebarBtn");

const sidebarTitle = document.getElementById("sidebarTitle");
sidebarTitle?.addEventListener("click", () => beginWorkflowTitleEdit());

toggleSidebarBtn?.addEventListener("click", () => {
  const collapsed = !document.body.classList.contains("sidebar-collapsed");
  setSidebarCollapsed(collapsed);
});

lastSavedPath = loadLastSavedPath();
loadState();
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

setInterval(() => {
  if (!autoSaveEnabled) return;
  void saveWorkflowToDefaultDir();
}, WF_AUTOSAVE_MS);

const shouldAutoSaveOnLoad = consumeRefreshAutosaveFlag();
if (shouldAutoSaveOnLoad && autoSaveEnabled) {
  void saveWorkflowToDefaultDir({ force: true, source: "auto" });
}

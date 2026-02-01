// ui_shell.js - tab shell with iframe keep-alive (no reload on tab switch)
//
// Why you previously saw "go Home -> click Dataset tab -> page not updated until F5":
// - You were doing host.innerHTML = ... to render Home.
// - That replaces (destroys) the whole #content DOM, including any iframes.
// - Tab objects still held stale iframe references, so switching back couldn't show them.
//
// Fix:
// - Keep a persistent Home view element and a persistent iframe host container.
// - Never overwrite #content.innerHTML after initialization.
// - Create each iframe once per tab; switch tabs by display:none/block.


// ==========================
// Hotkey override (F5 / Reload)
// ==========================

function normalizeKeyCombo(e) {
  // Example outputs: "F5", "Ctrl+R", "Ctrl+Shift+R"
  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  let k = e.key;
  // normalize
  if (k === "r" || k === "R") k = "R";
  if (k === "F5") k = "F5";
  if (k && k.length === 1 && k >= "a" && k <= "z") k = k.toUpperCase();

  parts.push(k);
  return parts.join("+");
}

let __lastKeyCombo = "";
let __lastKeyTime = 0;
const datasetAutoRefreshDone = new Set();
const ZOOM_STORAGE_KEY = "adas_ui_zoom_pct";
const UI_VERSION_PARAM = new URLSearchParams(window.location.search).get("v") || String(Date.now());
const ZOOM_MIN = 70;
const ZOOM_MAX = 160;
const ZOOM_STEP = 10;
const AUTOSAVE_KEY = "adas_autosave_enabled";
const FONT_STORAGE_KEY = "adas_app_font";
let zoomPercent = 100;
let zoomToastTimer = null;
let zoomUiWired = false;
let zoomRangeDragging = false;
let autoSaveEnabled = true;
const hostZoomAvailable = () => typeof window.ADAHost?.setZoomFactor === "function";

window.__adas_should_intercept_close = function () {
  const isClose = __lastKeyCombo === "Ctrl+W";
  if (!isClose) return false;
  return (Date.now() - __lastKeyTime) < 900;
};

function shouldIgnoreHotkey(e) {
  // Don't hijack when user is typing in input/textarea/contenteditable
  const el = e.target;
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  return false;
}

function loadZoomPercent() {
  try {
    const raw = localStorage.getItem(ZOOM_STORAGE_KEY);
    if (!raw) return 100;
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0) return v;
  } catch {}
  return 100;
}

function loadAutoSaveEnabled() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw == null) return true;
    return raw === "1";
  } catch {}
  return true;
}

function loadAppFont() {
  try {
    const raw = localStorage.getItem(FONT_STORAGE_KEY);
    if (raw && typeof raw === "string") return raw;
  } catch {}
  return "";
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

applyAppFont(loadAppFont());

async function clearCacheAndReload() {
  const confirmed = await showAppConfirm({
    title: "Warning",
    message: "Clear cache and reload the app?",
    okText: "Reload",
    cancelText: "Cancel",
  });
  if (!confirmed) return;
  const hostApi = getHostApi();
  if (hostApi?.clearCacheAndReload) {
    try {
      await hostApi.clearCacheAndReload();
      return;
    } catch {
      // fallback below
    }
  }
  try {
    if (window.caches?.keys) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    // ignore
  }
  try {
    window.location.reload();
  } catch {
    // ignore
  }
}

function updateAutoSaveToggleUI() {
  const btn = $("autoSaveSwitch");
  const stateEl = $("autoSaveState");
  if (!btn) return;
  btn.classList.toggle("on", autoSaveEnabled);
  btn.classList.toggle("off", !autoSaveEnabled);
  btn.setAttribute("aria-checked", autoSaveEnabled ? "true" : "false");
  if (stateEl) stateEl.textContent = autoSaveEnabled ? "On" : "Off";
}

function broadcastAutoSaveToggle() {
  for (const t of state.tabs || []) {
    if (t.type !== "workflow") continue;
    if (!t.iframe || !t.iframe.contentWindow) continue;
    try {
      t.iframe.contentWindow.postMessage({ type: "adas:autosave-toggle", enabled: autoSaveEnabled }, "*");
    } catch {
      // ignore
    }
  }
}

function setAutoSaveEnabled(enabled, { persist = true, notify = true } = {}) {
  autoSaveEnabled = !!enabled;
  if (persist) {
    try { localStorage.setItem(AUTOSAVE_KEY, autoSaveEnabled ? "1" : "0"); } catch {}
  }
  updateAutoSaveToggleUI();
  if (notify) broadcastAutoSaveToggle();
}

function initAutoSaveToggle() {
  autoSaveEnabled = loadAutoSaveEnabled();
  updateAutoSaveToggleUI();
  const btn = $("autoSaveSwitch");
  if (!btn) return;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setAutoSaveEnabled(!autoSaveEnabled);
  });
}

let fontModalWired = false;

function updateFontPreview(value) {
  const preview = $("fontPreview");
  if (!preview) return;
  const stack = buildFontStack(value);
  preview.style.fontFamily = stack || "";
}

function openFontSettingsModal() {
  const overlay = $("fontSettingsOverlay");
  const input = $("fontInput");
  if (!overlay || !input) return;
  const current = loadAppFont() || "Arial";
  input.value = current;
  updateFontPreview(current);
  overlay.classList.add("open");
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function closeFontSettingsModal() {
  const overlay = $("fontSettingsOverlay");
  if (overlay) overlay.classList.remove("open");
}

function initFontSettingsModal() {
  if (fontModalWired) return;
  fontModalWired = true;
  const overlay = $("fontSettingsOverlay");
  const input = $("fontInput");
  const applyBtn = $("fontApplyBtn");
  const cancelBtn = $("fontCancelBtn");
  if (!overlay || !input || !applyBtn || !cancelBtn) return;

  input.addEventListener("input", () => updateFontPreview(input.value));
  applyBtn.addEventListener("click", () => {
    const raw = (input.value || "").trim() || "Segoe UI";
    try { localStorage.setItem(FONT_STORAGE_KEY, raw); } catch {}
    applyAppFont(raw);
    broadcastAppFont(raw);
    closeFontSettingsModal();
  });
  cancelBtn.addEventListener("click", () => closeFontSettingsModal());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeFontSettingsModal();
  });
  window.addEventListener("keydown", (e) => {
    if (!overlay.classList.contains("open")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeFontSettingsModal();
    } else if (e.key === "Enter") {
      e.preventDefault();
      applyBtn.click();
    }
  }, true);
}

// ---------- Root Path Settings Modal ----------
let rootPathModalWired = false;

async function openRootPathSettingsModal() {
  const overlay = $("rootPathSettingsOverlay");
  const input = $("rootPathInput");
  if (!overlay || !input) return;
  
  // Load current value from backend
  try {
    const res = await fetch("/ui_config");
    if (res.ok) {
      const data = await res.json();
      input.value = data.config?.root_path || "E:\\ADAS";
    } else {
      input.value = "E:\\ADAS";
    }
  } catch {
    input.value = "E:\\ADAS";
  }
  
  overlay.classList.add("open");
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function closeRootPathSettingsModal() {
  const overlay = $("rootPathSettingsOverlay");
  if (overlay) overlay.classList.remove("open");
}

function initRootPathSettingsModal() {
  if (rootPathModalWired) return;
  rootPathModalWired = true;
  const overlay = $("rootPathSettingsOverlay");
  const input = $("rootPathInput");
  const applyBtn = $("rootPathApplyBtn");
  const cancelBtn = $("rootPathCancelBtn");
  if (!overlay || !input || !applyBtn || !cancelBtn) return;

  applyBtn.addEventListener("click", async () => {
    const newPath = (input.value || "").trim();
    if (!newPath) {
      alert("Please enter a valid path.");
      return;
    }
    try {
      const res = await fetch("/ui_config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root_path: newPath })
      });
      if (res.ok) {
        closeRootPathSettingsModal();
        updateStatusBar("Root path updated. Restarting...");
        // Trigger app restart
        setTimeout(() => {
          fetch("/restart", { method: "POST" }).catch(() => {});
          setTimeout(() => location.reload(), 1500);
        }, 500);
      } else {
        alert("Failed to save root path.");
      }
    } catch (err) {
      alert("Error saving root path: " + err.message);
    }
  });
  
  cancelBtn.addEventListener("click", () => closeRootPathSettingsModal());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeRootPathSettingsModal();
  });
  window.addEventListener("keydown", (e) => {
    if (!overlay.classList.contains("open")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeRootPathSettingsModal();
    }
  }, true);
}

function applyZoom() {
  const root = document.documentElement;
  const body = document.body;
  const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(zoomPercent)));
  zoomPercent = z;
  if (hostZoomAvailable()) {
    try { localStorage.setItem("adas_zoom_mode", "host"); } catch {}
    window.ADAHost?.setZoomFactor?.(z / 100);
  } else {
    try { localStorage.setItem("adas_zoom_mode", "css"); } catch {}
    if (root) root.style.zoom = String(z / 100);
    if (body) body.style.zoom = String(z / 100);
  }
  const statusH = getStatusBarHeight();
  try { localStorage.setItem("adas_statusbar_h", String(statusH)); } catch {}
  try { localStorage.setItem(ZOOM_STORAGE_KEY, String(z)); } catch {}
  if (!hostZoomAvailable()) broadcastZoomToIframes();
  updateZoomUI();
}

function showZoomToast() {
  const el = $("zoomToast");
  if (!el) return;
  el.textContent = `${zoomPercent}%`;
  el.classList.add("show");
  if (zoomToastTimer) clearTimeout(zoomToastTimer);
  zoomToastTimer = setTimeout(() => {
    el.classList.remove("show");
  }, 1000);
}

function adjustZoomByDelta(deltaY) {
  const step = deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
  setZoomPercent(zoomPercent + step, true);
}

function setZoomPercent(value, showToast) {
  const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(Number(value) || 0)));
  if (!Number.isFinite(next)) return;
  zoomPercent = next;
  applyZoom();
  if (showToast) showZoomToast();
}

function updateZoomUI() {
  const range = $("zoomRange");
  const value = $("zoomValue");
  if (range && !zoomRangeDragging) range.value = String(zoomPercent);
  if (value) value.textContent = `${zoomPercent}%`;
}

function showGlobalTooltip(text, x, y) {
  const tip = $("globalTooltip");
  if (!tip) return;
  tip.textContent = String(text || "");
  tip.style.left = "0px";
  tip.style.top = "0px";
  tip.classList.add("show");

  const rect = tip.getBoundingClientRect();
  let left = Number(x) || 0;
  let top = Number(y) || 0;
  const pad = 8;
  if (left + rect.width > window.innerWidth - pad) {
    left = Math.max(pad, window.innerWidth - rect.width - pad);
  }
  if (top + rect.height > window.innerHeight - pad) {
    top = Math.max(pad + rect.height / 2, window.innerHeight - rect.height - pad);
  }
  if (left < pad) left = pad;
  if (top < pad + rect.height / 2) top = pad + rect.height / 2;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideGlobalTooltip() {
  const tip = $("globalTooltip");
  if (!tip) return;
  tip.classList.remove("show");
}

function initZoomControls() {
  if (zoomUiWired) return;
  zoomUiWired = true;
  const outBtn = $("zoomOutBtn");
  const inBtn = $("zoomInBtn");
  const range = $("zoomRange");
  outBtn?.addEventListener("click", () => setZoomPercent(zoomPercent - ZOOM_STEP, true));
  inBtn?.addEventListener("click", () => setZoomPercent(zoomPercent + ZOOM_STEP, true));
  if (range) {
    range.addEventListener("pointerdown", () => {
      zoomRangeDragging = true;
    });
    range.addEventListener("pointerup", () => {
      zoomRangeDragging = false;
    });
    range.addEventListener("input", () => {
      const preview = Number(range.value);
      const value = $("zoomValue");
      if (value && Number.isFinite(preview)) value.textContent = `${preview}%`;
    });
    range.addEventListener("change", () => {
      setZoomPercent(range.value, true);
    });
  }
  updateZoomUI();
}

function broadcastZoomToIframes() {
  const z = zoomPercent;
  const statusH = getStatusBarHeight();
  for (const t of state.tabs || []) {
    if (!t.iframe || !t.iframe.contentWindow) continue;
    try {
      t.iframe.contentWindow.postMessage(
        { type: "adas:set-zoom", zoom: z, statusBarHeight: statusH },
        "*"
      );
    } catch {
      // ignore
    }
  }
}

function broadcastAppFont(font) {
  if (!font) return;
  for (const t of state.tabs || []) {
    if (!t.iframe || !t.iframe.contentWindow) continue;
    try {
      t.iframe.contentWindow.postMessage(
        { type: "adas:set-app-font", font },
        "*"
      );
    } catch {
      // ignore
    }
  }
}

function getStatusBarHeight() {
  const bar = $("statusBar");
  if (bar) {
    const rect = bar.getBoundingClientRect();
    if (rect && rect.height) return Math.round(rect.height);
  }
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--statusbar-h");
    const v = parseFloat(raw);
    if (Number.isFinite(v) && v > 0) return v;
  } catch {}
  return 24;
}

// default mapping (can be overridden by user config)
const hotkeys = {
  "F5": "custom_refresh",
  "Ctrl+R": "custom_refresh",
  "Ctrl+Shift+R": "custom_hard_refresh",
  // Windows-only shortcuts
  "Ctrl+Shift+K": "clear_test_data",
  "Alt+W": "tab_close",
  "Ctrl+H": "dfm_exclude_high",
  "Ctrl+L": "dfm_exclude_low",
  "Ctrl+I": "dfm_include_all",
  "Ctrl+S": "file_save",
  "Ctrl+Shift+S": "file_save_as",
  "Ctrl+O": "file_import",
  "Ctrl+P": "file_print",
  "Ctrl+Shift+F": "view_toggle_nav",
  "Ctrl+Q": "app_shutdown",
  "Ctrl+Alt+R": "file_restart",
};

function runHotkeyAction(action) {
  if (action === "custom_refresh") {
    refreshActiveTab();
    return;
  }
  if (action === "custom_hard_refresh") {
    customHardRefresh();
    return;
  }
  if (action === "clear_test_data") {
    clearTestData();
    return;
  }
  if (action === "tab_close") {
    closeTab(state.activeId);
    return;
  }
  if (action === "dfm_exclude_high") {
    if (isActiveDFMTab()) sendDFMCommand("adas:dfm-exclude-high");
    return;
  }
  if (action === "dfm_exclude_low") {
    if (isActiveDFMTab()) sendDFMCommand("adas:dfm-exclude-low");
    return;
  }
  if (action === "dfm_include_all") {
    if (isActiveDFMTab()) sendDFMCommand("adas:dfm-include-all");
    return;
  }
  if (action === "file_save") {
    if (isActiveWorkflowTab()) {
      sendWorkflowCommand("adas:workflow-save");
    } else if (isActiveDFMTab()) {
      sendDFMCommand("adas:dfm-save");
    }
    return;
  }
  if (action === "file_save_as") {
    if (isActiveWorkflowTab()) {
      sendWorkflowCommand("adas:workflow-save-as");
    } else if (isActiveDFMTab()) {
      sendDFMCommand("adas:dfm-save-as");
    }
    return;
  }
  if (action === "file_import") {
    importWorkflow();
    return;
  }
  if (action === "file_print") {
    printActiveTab();
    return;
  }
  if (action === "view_toggle_nav") {
    toggleNavigationPanel();
    return;
  }
  if (action === "file_restart") {
    restartApplication();
    return;
  }
  if (action === "app_shutdown") {
    shutdownApplication();
    return;
  }
}

function refreshActiveTab() {
  const t = state.tabs.find(x => x.id === state.activeId);
  if (!t) return;

  // 1) iframe tab: refresh only the iframe (not the whole app)
  if (t.iframe && t.iframe.tagName === "IFRAME") {
    if (t.type === "workflow") {
      try {
        const inst = t.wfInst || t.id || "";
        if (inst) sessionStorage.setItem(`adas_wf_autosave_on_load::${inst}`, "1");
      } catch {
        // ignore
      }
    }
    try {
      // Normal reload
      t.iframe.contentWindow?.location?.reload();
    } catch (_) {
      // Fallback on cross-origin/security errors: reset src to trigger reload
      const src = t.iframe.getAttribute("src");
      if (src) t.iframe.setAttribute("src", src);
    }
    return;
  }

  render();
  saveState?.();
}


function customHardRefresh() {
  // Example: clear cache + rebuild UI
  // Adjust to your cache system
  try {
    localStorage.removeItem("adas_ui_state"); // 
  } catch (_) {}

  // You can also reset to the initial tabs
  // state.tabs = [...]; state.activeId=...;

  render();
  saveState();
}

window.addEventListener(
  "keydown",
  (e) => {
    if (!hostZoomAvailable() && e.ctrlKey && !e.altKey) {
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setZoomPercent(zoomPercent - ZOOM_STEP, true);
        return;
      }
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setZoomPercent(zoomPercent + ZOOM_STEP, true);
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        setZoomPercent(100, true);
        return;
      }
    }
    if (shouldIgnoreHotkey(e)) return;

    const combo = normalizeKeyCombo(e);
    __lastKeyCombo = combo;
    __lastKeyTime = Date.now();

    if (combo === "Ctrl+W") {
      e.preventDefault();
      e.stopPropagation();
      closeTab(state.activeId);
      return;
    }

    const action = hotkeys[combo];
    if (!action) return;

    // Intercept the browser's default refresh
    e.preventDefault();
    e.stopPropagation();

    runHotkeyAction(action);
  },
  { capture: true } // capture is more reliable, runs before browser/other listeners
);

window.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return;
    if (hostZoomAvailable()) return;
    e.preventDefault();
    adjustZoomByDelta(e.deltaY || 0);
  },
  { capture: true, passive: false }
);



const $ = (id) => document.getElementById(id);

function updateStatusBar(text) {
  const textEl = $("statusText");
  if (textEl) {
    textEl.textContent = text || "";
    return;
  }
  const el = $("statusBar");
  if (!el) return;
  el.textContent = text || "";
}

function clearSavedStatusOnDirty() {
  const textEl = $("statusText") || $("statusBar");
  if (!textEl) return;
  const current = String(textEl.textContent || "").trim();
  if (/^(auto-saved|saved)\s*:/i.test(current)) {
    updateStatusBar("Status: Ready");
  }
}

function autoRefreshDatasetOnce(tab) {
  if (!tab || tab.type !== "dataset") return false;
  const key = tab.id || tab.dsInst || "";
  if (!key || datasetAutoRefreshDone.has(key)) return false;
  datasetAutoRefreshDone.add(key);

  const iframe = tab.iframe;
  if (!iframe) return false;

  try {
    const cw = iframe.contentWindow;
    if (cw?.location?.reload) {
      cw.location.reload();
    } else {
      const src = iframe.getAttribute("src");
      if (src) iframe.setAttribute("src", src);
    }
  } catch {
    const src = iframe.getAttribute("src");
    if (src) iframe.setAttribute("src", src);
  }
  return true;
}

function initTitlebarControls() {
  const api = getHostApi();
  const minBtn = $("titlebarMinBtn");
  const maxBtn = $("titlebarMaxBtn");
  const closeBtn = $("titlebarCloseBtn");
  const titlebar = $("customTitlebar");
  const titleText = $("titlebarTitle");
  let dragRestoreArmed = false;
  let dragStartX = 0;
  let dragStartY = 0;

  if (minBtn) {
    minBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      api?.minimizeWindow?.();
    });
  }

  if (maxBtn) {
    maxBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!api?.isMaximized || !api?.restoreWindow) {
        api?.maximizeWindow?.();
        return;
      }
      api.isMaximized().then((isMax) => {
        if (isMax) api.restoreWindow?.();
        else api.maximizeWindow?.();
      }).catch(() => api?.maximizeWindow?.());
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      shutdownApplication();
    });
  }

  if (titlebar) {
    titlebar.addEventListener("mousedown", (e) => {
      const target = e.target;
      if (target && target.closest && target.closest(".host-nodrag")) return;
      if (!api?.isMaximized) return;
      api.isMaximized().then((isMax) => {
        if (!isMax) return;
        dragRestoreArmed = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
      }).catch(() => {});
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragRestoreArmed) return;
      const dx = Math.abs(e.clientX - dragStartX);
      const dy = Math.abs(e.clientY - dragStartY);
      if (dx < 5 && dy < 5) return;
      dragRestoreArmed = false;
      api?.restoreWindow?.();
    });

    window.addEventListener("mouseup", () => {
      dragRestoreArmed = false;
    });

    titlebar.addEventListener("dblclick", (e) => {
      if (!api?.isMaximized || !api?.restoreWindow) return;
      const target = e.target;
      if (target && target.closest && target.closest(".host-nodrag")) return;
      api.isMaximized().then((isMax) => {
        if (isMax) api.restoreWindow?.();
        else api.maximizeWindow?.();
      }).catch(() => api?.maximizeWindow?.());
    });
  }
}

function getLastWorkflowPath() {
  try { return localStorage.getItem(LAST_WF_PATH_KEY) || ""; } catch { return ""; }
}

function setLastWorkflowPath(path) {
  try { localStorage.setItem(LAST_WF_PATH_KEY, path || ""); } catch {}
}

function getLastWorkflowDir() {
  const p = getLastWorkflowPath();
  if (!p) return "";
  const lastSlash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (lastSlash <= 0) return "";
  return p.slice(0, lastSlash);
}

function getHostApi() {
  return window.ADAHost || null;
}

function pathBasename(p) {
  if (!p) return "";
  const lastSlash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return lastSlash >= 0 ? p.slice(lastSlash + 1) : p;
}

async function loadWorkflowFromPath(path) {
  const res = await fetch("/workflow/load", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error("Failed to load workflow");
  const out = await res.json();
  const name = pathBasename(out.path || path);
  return { text: JSON.stringify(out.data || {}), name };
}

function formatStatusTimestamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

// bump version because behavior changed
const STORAGE_KEY = "adas_ui_shell_state_v3";
const LAST_WF_PATH_KEY = "adas_last_workflow_path_v1";

let __isDragging = false;

// ---------- state ----------
const state = {
  tabs: [{ id: "home", title: "Home", type: "home" }],
  activeId: "home",
  nextId: 1,
};

zoomPercent = loadZoomPercent();
applyZoom();

function lockTabsOverflowDuringDrag() {
  const host = $("tabs");
  if (!host) return;
  if (host.dataset.prevOverflowX == null) {
    host.dataset.prevOverflowX = host.style.overflowX || "";
  }
  host.style.overflowX = "hidden";
}

function restoreTabsOverflowAfterDrag() {
  const host = $("tabs");
  if (!host) return;
  if (host.dataset.prevOverflowX != null) {
    host.style.overflowX = host.dataset.prevOverflowX;
    delete host.dataset.prevOverflowX;
  } else {
    host.style.overflowX = "";
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (!s || !Array.isArray(s.tabs) || !s.activeId) return;

    // Ensure home tab exists
    if (!s.tabs.some(t => t.id === "home")) {
      s.tabs.unshift({ id: "home", title: "Home", type: "home" });
    }

    state.tabs = s.tabs.map(t => ({
      id: t.id,
      title: t.title,
      type: t.type,
      datasetId: t.datasetId,
      dsInst: t.dsInst || (t.type === "dataset" ? `ds_${t.id}` : undefined),
      wfInst: t.wfInst,
      wfFresh: t.wfFresh,
      wfInst: t.wfInst,
      wfFresh: t.wfFresh,
      isDirty: false,
      // iframe is runtime-only
      iframe: null,
    }));
    state.activeId = s.activeId;
    state.nextId = s.nextId || 1;

    // Force Home invariant (title/type)
    for (const t of state.tabs) {
      if (t.id === "home") {
        t.type = "home";
        t.title = "Home";
        t.datasetId = undefined;
      }
    }

    // Keep nextId > max suffix
    const maxId = Math.max(
      0,
      ...state.tabs.map(t => {
        const m = String(t.id).match(/_(\d+)$/);
        return m ? parseInt(m[1], 10) : 0;
      })
    );
    state.nextId = Math.max(state.nextId, maxId + 1);
  } catch {
    // ignore
  }
}

function saveState() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tabs: state.tabs.map(t => ({
          id: t.id,
          title: t.title,
          type: t.type,
          datasetId: t.datasetId,
          dsInst: t.dsInst,
      wfInst: t.wfInst,
      wfFresh: t.wfFresh,
      wfInst: t.wfInst,
      wfFresh: t.wfFresh,
        })),
        activeId: state.activeId,
        nextId: state.nextId,
      })
    );
  } catch {
    // ignore quota / privacy errors
  }
}

// ---------- persistent DOM containers ----------
let homeView = null;
let iframeHost = null;

function ensureContentContainers() {
  const content = $("content");
  if (!content) return;

  if (!homeView) {
    homeView = document.createElement("div");
    homeView.id = "homeView";
    // Match your existing CSS class for spacing
    homeView.className = "home";
    content.appendChild(homeView);
  }

  if (!iframeHost) {
    iframeHost = document.createElement("div");
    iframeHost.id = "iframeHost";
    iframeHost.style.width = "100%";
    iframeHost.style.height = "100%";
    iframeHost.style.position = "relative";
    content.appendChild(iframeHost);
  }
}

let homeWired = false;
function renderHomeViewOnce() {
  if (!homeView) return;

  if (!homeView.dataset.rendered) {
    homeView.innerHTML = `
      <div class="homeGroup">
        <div class="groupTitle">Dataset</div>
        <div class="cards">
          <div class="card clickable" id="cardOpenDataset">
            <h3>Open Dataset</h3>
            <div class="muted">View a dataset in a new tab.</div>
          </div>
          <div class="card clickable" id="cardOpenDfm">
            <h3>DFM</h3>
            <div class="muted">Create a development factor method.</div>
          </div>
        </div>
      </div>

      <div class="homeGroup">
        <div class="groupTitle">Automations</div>
        <div class="cards">
          <div class="card clickable" id="cardNewWorkflow">
            <h3>New Workflow</h3>
            <div class="muted">Build or load a workflow tab.</div>
          </div>
          <div class="card clickable" id="cardScripting">
            <h3>Scripting</h3>
            <div class="muted">Write an ADAS script.</div>
          </div>
        </div>
      </div>

      <div class="homeGroup">
        <div class="groupTitle">General</div>
        <div class="cards">
          <div class="card clickable" id="cardProjectSettings">
            <h3>Project Explorer</h3>
            <div class="muted">Browse and manage projects.</div>
          </div>
          <div class="card clickable" id="cardBrowsingHistory">
            <h3>Browsing History</h3>
            <div class="muted">Pick up where you left off.</div>
          </div>
        </div>
      </div>
    `;
    homeView.dataset.rendered = "1";
  }

  if (!homeWired) {
    // wire only once
    const nd = document.getElementById("cardOpenDataset");
    if (nd) {
      nd.addEventListener("click", () => {
        openDatasetTab();
      });
    }

    const nw = document.getElementById("cardNewWorkflow");
    if (nw) {
      nw.addEventListener("click", () => {
        openWorkflowTab();
      });
    }

    const dfm = document.getElementById("cardOpenDfm");
    if (dfm) {
      dfm.addEventListener("click", () => {
        openDFMTab();
      });
    }

    const ps = document.getElementById("cardProjectSettings");
    if (ps) {
      ps.addEventListener("click", () => {
        openProjectSettingsTab();
      });
    }

    const bh = document.getElementById("cardBrowsingHistory");
    if (bh) {
      bh.addEventListener("click", () => {
        alert("Browsing History: TODO");
      });
    }

    homeWired = true;
  }
}

// ---------- File menu (top menubar) ----------
const fileMenuBtn = document.querySelector('.menu[data-menu="file"]');
const fileMenuDropdown = document.getElementById("fileMenuDropdown");
const editMenuBtn = document.querySelector('.menu[data-menu="edit"]');
const editMenuDropdown = document.getElementById("editMenuDropdown");
const viewMenuBtn = document.querySelector('.menu[data-menu="view"]');
const viewMenuDropdown = document.getElementById("viewMenuDropdown");
const settingsMenuBtn = document.querySelector('.menu[data-menu="settings"]');
const settingsMenuDropdown = document.getElementById("settingsMenuDropdown");
let dfmEditEnabled = false;

function positionFileMenu() {
  if (!fileMenuBtn || !fileMenuDropdown) return;
  const r = fileMenuBtn.getBoundingClientRect();
  fileMenuDropdown.style.left = `${Math.round(r.left)}px`;
  fileMenuDropdown.style.top = `${Math.round(r.bottom + 6)}px`;
}

function toggleFileMenu(forceOpen) {
  if (!fileMenuDropdown) return;
  const shouldOpen = (typeof forceOpen === "boolean")
    ? forceOpen
    : !fileMenuDropdown.classList.contains("open");
  fileMenuDropdown.classList.toggle("open", shouldOpen);
  if (shouldOpen) positionFileMenu();
}

function positionEditMenu() {
  if (!editMenuBtn || !editMenuDropdown) return;
  const r = editMenuBtn.getBoundingClientRect();
  editMenuDropdown.style.left = `${Math.round(r.left)}px`;
  editMenuDropdown.style.top = `${Math.round(r.bottom + 6)}px`;
}

function toggleEditMenu(forceOpen) {
  if (!editMenuDropdown) return;
  const shouldOpen = (typeof forceOpen === "boolean")
    ? forceOpen
    : !editMenuDropdown.classList.contains("open");
  editMenuDropdown.classList.toggle("open", shouldOpen);
  if (shouldOpen) positionEditMenu();
}

function positionViewMenu() {
  if (!viewMenuBtn || !viewMenuDropdown) return;
  const r = viewMenuBtn.getBoundingClientRect();
  viewMenuDropdown.style.left = `${Math.round(r.left)}px`;
  viewMenuDropdown.style.top = `${Math.round(r.bottom + 6)}px`;
}

function toggleViewMenu(forceOpen) {
  if (!viewMenuDropdown) return;
  const shouldOpen = (typeof forceOpen === "boolean")
    ? forceOpen
    : !viewMenuDropdown.classList.contains("open");
  viewMenuDropdown.classList.toggle("open", shouldOpen);
  if (shouldOpen) positionViewMenu();
}

function positionSettingsMenu() {
  if (!settingsMenuBtn || !settingsMenuDropdown) return;
  const r = settingsMenuBtn.getBoundingClientRect();
  settingsMenuDropdown.style.left = `${Math.round(r.left)}px`;
  settingsMenuDropdown.style.top = `${Math.round(r.bottom + 6)}px`;
}

function toggleSettingsMenu(forceOpen) {
  if (!settingsMenuDropdown) return;
  const shouldOpen = (typeof forceOpen === "boolean")
    ? forceOpen
    : !settingsMenuDropdown.classList.contains("open");
  settingsMenuDropdown.classList.toggle("open", shouldOpen);
  if (shouldOpen) positionSettingsMenu();
}

function closeAllShellMenus() {
  toggleFileMenu(false);
  toggleEditMenu(false);
  toggleViewMenu(false);
  toggleSettingsMenu(false);
  togglePlusMenu(false);
  closeTabCtxMenu();
}

function isActiveWorkflowTab() {
  const tab = state.tabs.find(t => t.id === state.activeId);
  return !!tab && tab.type === "workflow";
}

function isActiveDFMTab() {
  const tab = state.tabs.find(t => t.id === state.activeId);
  return !!tab && tab.type === "dfm";
}

function updateFileMenuState() {
  if (!fileMenuDropdown) return;
  const enabled = isActiveWorkflowTab() || isActiveDFMTab();
  fileMenuDropdown.querySelectorAll(".menuItem").forEach((el) => {
    const action = el.getAttribute("data-action") || "";
    const shouldDisable = (!enabled && (action === "save" || action === "save-as"))
      || (action === "close-tab" && state.activeId === "home");
    el.classList.toggle("disabled", shouldDisable);
  });
}

function updateEditMenuState() {
  if (!editMenuDropdown) return;
  const isDfm = isActiveDFMTab();
  const editEnabled = isDfm && dfmEditEnabled;
  editMenuDropdown.querySelectorAll(".menuItem").forEach((el) => {
    const action = el.getAttribute("data-action") || "";
    const shouldDisable = action === "dfm-include-all" ? !isDfm : !editEnabled;
    el.classList.toggle("disabled", shouldDisable);
  });
}

function updateViewMenuState() {
  if (!viewMenuDropdown) return;
  const enabled = isActiveWorkflowTab();
  viewMenuDropdown.querySelectorAll(".menuItem").forEach((el) => {
    const action = el.getAttribute("data-action") || "";
    const shouldDisable = !enabled && action === "toggle-nav";
    el.classList.toggle("disabled", shouldDisable);
  });
}

function sendWorkflowCommand(type) {
  const tab = state.tabs.find(t => t.id === state.activeId);
  if (!tab || tab.type !== "workflow") return;
  ensureIframe(tab);
  try {
    tab.iframe?.contentWindow?.postMessage({ type }, "*");
  } catch {
    // ignore
  }
}

function sendDFMCommand(type) {
  const tab = state.tabs.find(t => t.id === state.activeId);
  if (!tab || tab.type !== "dfm") return;
  ensureIframe(tab);
  try {
    tab.iframe?.contentWindow?.postMessage({ type }, "*");
  } catch {
    // ignore
  }
}

function toggleNavigationPanel() {
  sendWorkflowCommand("adas:workflow-toggle-nav");
}

function getWorkflowTabState(tab) {
  if (!tab || tab.type !== "workflow") return null;
  try {
    const raw = localStorage.getItem(`adas_workflow_state_v1::${tab.wfInst}`);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && typeof s === "object" ? s : null;
  } catch {
    return null;
  }
}

function isWorkflowTabEmpty(tab) {
  const s = getWorkflowTabState(tab);
  if (!s || !Array.isArray(s.steps)) return true;
  return s.steps.length === 0;
}

function postToWorkflowTab(tab, msg) {
  if (!tab || tab.type !== "workflow") return;
  ensureIframe(tab);
  const iframe = tab.iframe;
  if (!iframe) return;
  const send = () => {
    try {
      iframe.contentWindow?.postMessage(msg, "*");
    } catch {
      // ignore
    }
  };
  if (iframe.dataset.ready === "1") {
    send();
    return;
  }
  const onLoad = () => {
    iframe.dataset.ready = "1";
    iframe.removeEventListener("load", onLoad);
    send();
  };
  iframe.addEventListener("load", onLoad);
  send();
}

const WF_IMPORT_HANDLE_KEY = "workflow_import_handle";
const WF_IMPORT_PICKER_ID = "workflow_import_picker";

function openHandleDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("adas_handles", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("handles")) {
        db.createObjectStore("handles");
      }
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

async function getStoredHandle() {
  try {
    const db = await openHandleDb();
    return await new Promise((resolve) => {
      const tx = db.transaction("handles", "readonly");
      const store = tx.objectStore("handles");
      const req = store.get(WF_IMPORT_HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function getDefaultWorkflowDir() {
  try {
    const res = await fetch("/workflow/default_dir");
    if (!res.ok) return "";
    const out = await res.json();
    return out.path || "";
  } catch {
    return "";
  }
}

async function setStoredHandle(handle) {
  try {
    const db = await openHandleDb();
    await new Promise((resolve) => {
      const tx = db.transaction("handles", "readwrite");
      const store = tx.objectStore("handles");
      store.put(handle, WF_IMPORT_HANDLE_KEY);
      tx.oncomplete = () => resolve(null);
      tx.onerror = () => resolve(null);
    });
  } catch {
    // ignore
  }
}

async function pickWorkflowFile() {
  const hostApi = getHostApi();
  if (hostApi?.pickOpenWorkflowFile) {
    const lastDir = getLastWorkflowDir();
    try {
      const path = await hostApi.pickOpenWorkflowFile(lastDir);
      if (path) return await loadWorkflowFromPath(path);
    } catch {
      // fall through
    }
  }

  if (window.showOpenFilePicker) {
    const lastDir = getLastWorkflowDir();
    if (lastDir) {
      try {
        const [fileHandle] = await window.showOpenFilePicker({
          types: [{ description: "Workflow", accept: { "application/json": [".adaswf", ".json"] } }],
          multiple: false,
          startIn: lastDir,
          id: WF_IMPORT_PICKER_ID,
        });
        if (!fileHandle) return null;
        await setStoredHandle(fileHandle);
        const file = await fileHandle.getFile();
        const text = await file.text();
        return { text, name: file.name };
      } catch {
        // fall through
      }
    }
    let startIn = "documents";
    const handle = await getStoredHandle();
    if (handle) {
      startIn = handle;
    } else {
      const defaultDir = await getDefaultWorkflowDir();
      if (defaultDir) {
        try {
          const [fileHandle] = await window.showOpenFilePicker({
            types: [{ description: "Workflow JSON", accept: { "application/json": [".json"] } }],
            multiple: false,
            startIn: defaultDir,
            id: WF_IMPORT_PICKER_ID,
          });
          await setStoredHandle(fileHandle);
          const file = await fileHandle.getFile();
          const text = await file.text();
          return { text, name: file.name };
        } catch {
          // fall through to generic picker
        }
      }
    }
    const [fileHandle] = await window.showOpenFilePicker({
      types: [{ description: "Workflow", accept: { "application/json": [".adaswf", ".json"] } }],
      multiple: false,
      startIn,
      id: WF_IMPORT_PICKER_ID,
    });
    if (!fileHandle) return null;
    await setStoredHandle(fileHandle);
    const file = await fileHandle.getFile();
    const text = await file.text();
    return { text, name: file.name };
  }

  return await new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".adaswf,.json,application/json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const text = await file.text();
      resolve({ text, name: file.name });
    });
    input.click();
  });
}

async function importWorkflow() {
  let picked = null;
  try {
    picked = await pickWorkflowFile();
  } catch {
    // user cancelled or API not permitted
    return;
  }
  if (!picked || !picked.text) return;

  let data = null;
  try {
    data = JSON.parse(picked.text);
  } catch {
    alert("Import failed: invalid JSON.");
    return;
  }

  let targetTab = null;
  const active = state.tabs.find(t => t.id === state.activeId);
  if (active && active.type === "workflow" && isWorkflowTabEmpty(active)) {
    targetTab = active;
  } else {
    targetTab = openWorkflowTab();
  }

  if (!targetTab) return;
  postToWorkflowTab(targetTab, { type: "adas:workflow-load", data });
}

function waitForServerThenReload(timeoutMs = 15000) {
  const start = Date.now();
  const attempt = async () => {
    try {
      await fetch("/", { cache: "no-store" });
      window.location.reload();
      return;
    } catch {
      // ignore
    }
    if (Date.now() - start >= timeoutMs) {
      window.location.reload();
      return;
    }
    setTimeout(attempt, 800);
  };
  setTimeout(attempt, 800);
}

async function restartApplication() {
  window.__appRestarting = true;
  updateStatusBar("Restarting application...");
  try {
    await fetch("/app/restart", { method: "POST" });
  } catch {
    // ignore
  }
  try {
    await fetch("/app/restart_electron", { method: "POST" });
  } catch {
    // ignore
  }
  waitForServerThenReload();
}

let __appShutdownRequested = false;

function sendShutdownSignal() {
  const hostApi = getHostApi();
  if (hostApi?.shutdownApp) {
    try { hostApi.shutdownApp(); } catch {}
    return;
  }
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/app/shutdown");
      return;
    }
  } catch {
    // ignore
  }
  try {
    fetch("/app/shutdown", { method: "POST", keepalive: true });
  } catch {
    // ignore
  }
}

let __appConfirmPromise = null;

function showAppConfirm({ title, message, okText, cancelText } = {}) {
  if (__appConfirmPromise) return __appConfirmPromise;

  const overlay = $("appConfirmOverlay");
  const titleEl = $("appConfirmTitle");
  const messageEl = $("appConfirmMessage");
  const okBtn = $("appConfirmOk");
  const cancelBtn = $("appConfirmCancel");

  if (!overlay || !titleEl || !messageEl || !okBtn || !cancelBtn) {
    const fallbackMsg = message || "Quit the application?";
    return Promise.resolve(window.confirm(fallbackMsg));
  }

  titleEl.textContent = title || "Warning";
  messageEl.textContent = message || "Quit the application?";
  okBtn.textContent = okText || "Quit";
  cancelBtn.textContent = cancelText || "Cancel";

  overlay.classList.add("open");

  __appConfirmPromise = new Promise((resolve) => {
    const cleanup = () => {
      overlay.classList.remove("open");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("click", onOverlay);
      window.removeEventListener("keydown", onKey, true);
      __appConfirmPromise = null;
    };

    const finish = (result) => {
      cleanup();
      resolve(result);
    };

    const onOk = (e) => {
      e.preventDefault();
      finish(true);
    };
    const onCancel = (e) => {
      e.preventDefault();
      finish(false);
    };
    const onOverlay = (e) => {
      if (e.target === overlay) finish(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      }
    };

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("click", onOverlay);
    window.addEventListener("keydown", onKey, true);

    setTimeout(() => {
      try { cancelBtn.focus(); } catch {}
    }, 0);
  });

  return __appConfirmPromise;
}

function shutdownApplication() {
  if (__appShutdownRequested) return;
  showAppConfirm({ title: "Warning", message: "Quit the application?", okText: "Quit" })
    .then((ok) => {
      if (!ok) {
        updateStatusBar("Shutdown canceled.");
        return;
      }
      __appShutdownRequested = true;
      updateStatusBar("Shutting down...");
      sendShutdownSignal();
      setTimeout(() => {
        try { window.close(); } catch {}
      }, 200);
    })
    .catch(() => {
      updateStatusBar("Shutdown canceled.");
    });
}

window.__adas_confirm_app_shutdown = function () {
  return showAppConfirm({ title: "Warning", message: "Quit the application?", okText: "Quit" });
};

fileMenuBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleEditMenu(false);
  toggleViewMenu(false);
  toggleFileMenu();
});

editMenuBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleFileMenu(false);
  toggleViewMenu(false);
  toggleEditMenu();
});

viewMenuBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleFileMenu(false);
  toggleEditMenu(false);
  toggleViewMenu();
});

settingsMenuBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleFileMenu(false);
  toggleEditMenu(false);
  toggleViewMenu(false);
  toggleSettingsMenu();
});

fileMenuDropdown?.addEventListener("click", (e) => {
  const item = e.target?.closest?.(".menuItem");
  const action = item?.getAttribute("data-action");
  if (!action) return;
  if (item.classList.contains("disabled")) return;
  toggleFileMenu(false);
  if (action === "save-workflow") {
    updateStatusBar("Saving...");
    sendWorkflowCommand("adas:workflow-save");
  } else if (action === "save-workflow-as") {
    updateStatusBar("Saving as...");
    sendWorkflowCommand("adas:workflow-save-as");
  } else if (action === "save") {
    if (isActiveWorkflowTab()) {
      updateStatusBar("Saving...");
      sendWorkflowCommand("adas:workflow-save");
    } else if (isActiveDFMTab()) {
      updateStatusBar("Saving...");
      sendDFMCommand("adas:dfm-save");
    }
  } else if (action === "save-as") {
    if (isActiveWorkflowTab()) {
      updateStatusBar("Saving as...");
      sendWorkflowCommand("adas:workflow-save-as");
    } else if (isActiveDFMTab()) {
      updateStatusBar("Saving as...");
      sendDFMCommand("adas:dfm-save-as");
    }
  } else if (action === "import-workflow") {
    importWorkflow();
  } else if (action === "close-tab") {
    closeTab(state.activeId);
  } else if (action === "print") {
    printActiveTab();
  } else if (action === "restart-app") {
    restartApplication();
  } else if (action === "shutdown-app") {
    shutdownApplication();
  }
});

viewMenuDropdown?.addEventListener("click", (e) => {
  const item = e.target?.closest?.(".menuItem");
  const action = item?.getAttribute("data-action");
  if (!action) return;
  if (item.classList.contains("disabled")) return;
  toggleViewMenu(false);
  if (action === "toggle-nav") {
    toggleNavigationPanel();
  }
});

settingsMenuDropdown?.addEventListener("click", (e) => {
  const item = e.target?.closest?.(".menuItem");
  const action = item?.getAttribute("data-action");
  if (!action) return;
  toggleSettingsMenu(false);
  if (action === "font-settings") {
    openFontSettingsModal();
  } else if (action === "root-path-settings") {
    openRootPathSettingsModal();
  } else if (action === "clear-cache-reload") {
    clearCacheAndReload();
  }
});

editMenuDropdown?.addEventListener("click", (e) => {
  const item = e.target?.closest?.(".menuItem");
  const action = item?.getAttribute("data-action");
  if (!action) return;
  if (item.classList.contains("disabled")) return;
  toggleEditMenu(false);
  if (action === "dfm-exclude-high") {
    sendDFMCommand("adas:dfm-exclude-high");
  } else if (action === "dfm-exclude-low") {
    sendDFMCommand("adas:dfm-exclude-low");
  } else if (action === "dfm-include-all") {
    sendDFMCommand("adas:dfm-include-all");
  }
});

window.addEventListener("click", () => {
  closeAllShellMenus();
});
window.addEventListener("resize", () => {
  if (fileMenuDropdown?.classList.contains("open")) positionFileMenu();
  if (editMenuDropdown?.classList.contains("open")) positionEditMenu();
  if (viewMenuDropdown?.classList.contains("open")) positionViewMenu();
  if (settingsMenuDropdown?.classList.contains("open")) positionSettingsMenu();
});

window.addEventListener("beforeunload", () => {
  if (window.__appRestarting) return;
  if (__appShutdownRequested) return;
  sendShutdownSignal();
});

// ---------- tab actions ----------
function setActive(id) {
  state.activeId = id;
  if (!isActiveDFMTab()) {
    dfmEditEnabled = false;
  }
  render();
  saveState();
}

function closeTab(id) {
  if (id === "home") return;
  const idx = state.tabs.findIndex(t => t.id === id);
  if (idx < 0) return;

  const wasActive = state.activeId === id;
  const tab = state.tabs[idx];

  if (tab.iframe && tab.iframe.parentNode) {
    tab.iframe.parentNode.removeChild(tab.iframe);
  }

  state.tabs.splice(idx, 1);

  if (wasActive) {
    const fallback = state.tabs[Math.max(0, idx - 1)];
    state.activeId = fallback ? fallback.id : "home";
  }

  render();
  saveState();
}

function openDatasetTab() {
  const id = `ds_${state.nextId++}`;

  state.tabs.push({
    id,
    title: `Dataset View`,
    type: "dataset",
    iframe: null,
    dsInst: `ds_${id}_${Date.now()}`,
  });

  state.activeId = id;
  render();
  saveState();
}

function openDFMTab() {
  const id = `dfm_${state.nextId++}`;

  state.tabs.push({
    id,
    title: `DFM`,
    type: "dfm",
    iframe: null,
    dsInst: `dfm_${id}_${Date.now()}`,
  });

  state.activeId = id;
  render();
  saveState();
}


function openWorkflowTab() {
  const id = `wf_${state.nextId++}`;
  const wfInst = `wf_${state.nextId - 1}_${Date.now()}`;
    const tab = {
      id,
      title: `Workflow ${state.nextId - 1}`,
      type: "workflow",
      iframe: null,
      wfInst,
      isDirty: false,
    };
  state.tabs.push(tab);
  state.activeId = id;
  render();
  saveState();
  return tab;
}

function openProjectSettingsTab() {
  const existing = state.tabs.find(t => t.type === "project_settings");
  if (existing) {
    setActive(existing.id);
    return;
  }

  const id = `ps_${state.nextId++}`;
  state.tabs.push({
    id,
    title: "Project Explorer",
    type: "project_settings",
    iframe: null,
  });

  state.activeId = id;
  render();
  saveState();
}

// ---------- render ----------
// Drag reorder UX (JupyterLab-like preview):
// - While dragging, we show a placeholder tab where it will land.
// - A thin indicator bar previews the drop position.
// - Tabs are NOT reloaded; we only reorder state on drop.

let __draggedTabId = null;
let __dragEl = null;
let __placeholderEl = null;
let __dropIndicatorEl = null;
let __dragCommitted = false;

// Keep the tab bar height stable during drag (avoid flex-wrap row changes)
let __tabsHostPrevStyle = null;
let __pendingDrag = false;

// Make the dragged tab follow the pointer like a real browser tab:
// - remove it from the flex flow using position:absolute (tabs host is position:relative)
// - translateX with pointer delta while keeping a slight scale
let __dragElPrevStyle = null;
let __dragElBaseLeft = 0;
let __dragElBaseTop = 0;

// Pointer-drag (no HTML5 DnD) to avoid flicker/forbidden cursor and to lock to horizontal moves.
let __ptrActive = false;
let __ptrId = null;
let __ptrStartX = 0;
let __ptrStartY = 0;
let __ptrMoved = false;
const __DRAG_THRESHOLD_PX = 6;


function getTabElById(id) {
  return document.querySelector(`.tab[data-tab-id="${CSS.escape(id)}"]`);
}

function ensureDropIndicator(host) {
  if (__dropIndicatorEl && __dropIndicatorEl.isConnected) return __dropIndicatorEl;
  let el = document.getElementById("dropIndicator");
  if (!el) {
    el = document.createElement("div");
    el.id = "dropIndicator";
    host.appendChild(el);
  }
  __dropIndicatorEl = el;
  return el;
}

function showIndicatorAt(host, x) {
  const ind = ensureDropIndicator(host);
  const r = host.getBoundingClientRect();
  const left = Math.max(0, Math.min(r.width, x - r.left));
  ind.style.left = `${left}px`;
  ind.style.display = "block";
}

function hideIndicator() {
  if (__dropIndicatorEl) __dropIndicatorEl.style.display = "none";
}

function lockTabsHostLayout(host) {
  if (!host || __tabsHostPrevStyle) return;
  const r = host.getBoundingClientRect();
  __tabsHostPrevStyle = {
    height: host.style.height,
    minHeight: host.style.minHeight,
    flexWrap: host.style.flexWrap,
    overflowX: host.style.overflowX,
    overflowY: host.style.overflowY,
    alignItems: host.style.alignItems,
  };
  // Freeze current height so the whole topbar doesn't "jump".
  host.style.height = `${Math.ceil(r.height)}px`;
  host.style.minHeight = host.style.height;
  // During drag, force single-row layout (browser-like)
  host.style.flexWrap = "nowrap";
  host.style.overflowX = "auto";
  host.style.overflowY = "hidden";
  host.style.alignItems = "stretch";
}

function unlockTabsHostLayout() {
  const host = $("tabs");
  if (!host || !__tabsHostPrevStyle) return;
  host.style.height = __tabsHostPrevStyle.height;
  host.style.minHeight = __tabsHostPrevStyle.minHeight;
  host.style.flexWrap = __tabsHostPrevStyle.flexWrap;
  host.style.overflowX = __tabsHostPrevStyle.overflowX;
  host.style.overflowY = __tabsHostPrevStyle.overflowY;
  host.style.alignItems = __tabsHostPrevStyle.alignItems;
  __tabsHostPrevStyle = null;
}

function cleanupDragUI() {
  restoreTabsOverflowAfterDrag();
  hideIndicator();
  if (__dragEl) __dragEl.classList.remove("dragging");
  if (__placeholderEl && __placeholderEl.parentNode) __placeholderEl.parentNode.removeChild(__placeholderEl);
  __placeholderEl = null;

  // Restore the dragged tab's inline styles (so it re-joins the flex layout).
  if (__dragEl && __dragElPrevStyle) {
    __dragEl.style.position = __dragElPrevStyle.position;
    __dragEl.style.left = __dragElPrevStyle.left;
    __dragEl.style.top = __dragElPrevStyle.top;
    __dragEl.style.width = __dragElPrevStyle.width;
    __dragEl.style.height = __dragElPrevStyle.height;
    __dragEl.style.zIndex = __dragElPrevStyle.zIndex;
    __dragEl.style.pointerEvents = __dragElPrevStyle.pointerEvents;
    __dragEl.style.transform = __dragElPrevStyle.transform;
  }
  __dragElPrevStyle = null;
  __dragElBaseLeft = 0;
  __dragElBaseTop = 0;

  __dragEl = null;
  __draggedTabId = null;
  __ptrActive = false;
  __ptrId = null;
  __ptrMoved = false;
  __isDragging = false;
  __pendingDrag = false;
  
  __lastPlaceholderIndex = -1;

  unlockTabsHostLayout();

  // Restore cursor if we changed it
  try { document.body.style.cursor = ""; } catch {}

}

function startDragIfNeeded(host, el, pointerId) {
  if (!host || !el) return;
  if (__isDragging) return;

  __isDragging = true;
  __pendingDrag = false;

  lockTabsHostLayout(host);
  try { document.body.style.cursor = "grabbing"; } catch {}

  el.classList.add("dragging");

  // Detach the dragged tab from the flex layout and pin it visually.
  const hostRect = host.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  __dragElPrevStyle = {
    position: el.style.position,
    left: el.style.left,
    top: el.style.top,
    width: el.style.width,
    height: el.style.height,
    zIndex: el.style.zIndex,
    pointerEvents: el.style.pointerEvents,
    transform: el.style.transform,
  };

  // Include scrollLeft because we may force overflowX:auto during drag.
  __dragElBaseLeft = (r.left - hostRect.left) + host.scrollLeft;
  __dragElBaseTop = (r.top - hostRect.top);

  el.style.width = `${Math.ceil(r.width)}px`;
  el.style.height = `${Math.ceil(r.height)}px`;
  el.style.position = "absolute";
  el.style.left = `${Math.round(__dragElBaseLeft)}px`;
  el.style.top = `${Math.round(__dragElBaseTop)}px`;
  el.style.zIndex = "1000";
  el.style.pointerEvents = "none";
  // We'll drive transform in pointermove.
  el.style.transform = "translate3d(0px, 0px, 0px)";

  const ph = ensurePlaceholderFrom(el);
  // Insert placeholder at the dragged tab's original slot.
  host.insertBefore(ph, el);

  // Keep receiving moves even if pointer leaves the bar
  try { el.setPointerCapture(pointerId); } catch {}
}

function ensurePlaceholderFrom(el) {
  if (__placeholderEl && __placeholderEl.isConnected) return __placeholderEl;
  const r = el.getBoundingClientRect();
  const ph = document.createElement("div");
  ph.className = "tab placeholder";
  ph.innerHTML = "&nbsp;";
  ph.style.width = `${Math.ceil(r.width)}px`;
  ph.style.height = `${Math.ceil(r.height)}px`;
  __placeholderEl = ph;
  return ph;
}

function commitOrderFromDom() {
  const host = $("tabs");
  if (!host) return;
  if (!__draggedTabId || !__placeholderEl) return;

  // Build a list with a marker at the placeholder position.
  // IMPORTANT: While dragging we keep the dragged tab element in the DOM (but absolute).
  // If we include it here, the placeholder index will be off-by-one when moving left->right
  // (because the dragged element still sits at its original DOM position).
  // So we *skip* the dragged tab element entirely when computing the placeholder index.
  const seq = [];
  for (const child of host.children) {
    if (child === __placeholderEl) {
      seq.push("__PLACEHOLDER__");
      continue;
    }
    if (child.classList && child.classList.contains("tab")) {
      const id = child.getAttribute("data-tab-id");
      if (!id) continue;
      if (id === __draggedTabId) continue; // skip the absolute dragged element
      seq.push(id);
    }
  }

  const phIndex = seq.indexOf("__PLACEHOLDER__");
  if (phIndex < 0) return;

  // Remove placeholder marker
  const ids = seq.filter(x => x !== "__PLACEHOLDER__");

  // Insert dragged tab id into placeholder position (clamp)
  const insertAt = Math.max(0, Math.min(ids.length, phIndex));
  ids.splice(insertAt, 0, __draggedTabId);

  // Ensure home is fixed at index 0
  const home = state.tabs.find(t => t.id === "home");
  const map = new Map(state.tabs.map(t => [t.id, t]));
  const next = [];
  if (home) next.push(home);

  for (const id of ids) {
    if (id === "home") continue;
    const t = map.get(id);
    if (t) next.push(t);
  }

  // Append any tabs not represented (safety)
  for (const t of state.tabs) {
    if (t.id === "home") continue;
    if (!next.some(x => x.id === t.id)) next.push(t);
  }

  state.tabs = next;
}

function wireTabDnDHostOnce() {
  // Pointer-based dragging doesn't need host-level DnD wiring.
  const host = $("tabs");
  if (!host) return;
  if (host.dataset.dndWired === "1") return;
  host.dataset.dndWired = "1";
  ensureDropIndicator(host);
}

let __lastPlaceholderIndex = -1;

function flipAnimateTabs(host, beforeRects) {
  // Compute "after" rects (forces layout)
  const after = new Map();
  host.querySelectorAll('.tab[data-tab-id]').forEach(el => {
    const id = el.getAttribute("data-tab-id");
    if (!id) return;
    if (id === __draggedTabId) return; // dragged is absolute
    if (el.classList.contains("placeholder")) return;
    after.set(id, el.getBoundingClientRect());
  });

  host.querySelectorAll('.tab[data-tab-id]').forEach(el => {
    const id = el.getAttribute("data-tab-id");
    if (!id) return;
    if (id === __draggedTabId) return;
    if (el.classList.contains("placeholder")) return;

    const b = beforeRects.get(id);
    const a = after.get(id);
    if (!b || !a) return;

    const dx = b.left - a.left;
    if (Math.abs(dx) < 0.5) return;

    // Cancel previous animation to avoid jitter
    if (el.__flipAnim) {
      try { el.__flipAnim.cancel(); } catch {}
      el.__flipAnim = null;
    }

    // Animate from inverted position back to 0
    el.__flipAnim = el.animate(
      [
        { transform: `translateX(${dx}px)` },
        { transform: "translateX(0px)" },
      ],
      { duration: 140, easing: "ease-out" }
    );
  });
}

// ---------- "+" tab menu ----------
let __plusBtnEl = null;
let __plusMenuEl = null;

function positionPlusMenu() {
  if (!__plusMenuEl || !__plusBtnEl) return;
  const host = $("tabs");
  if (!host) return;

  const wasOpen = __plusMenuEl.classList.contains("open");
  if (!wasOpen) {
    __plusMenuEl.style.visibility = "hidden";
    __plusMenuEl.classList.add("open");
  }

  const btnRect = __plusBtnEl.getBoundingClientRect();
  const menuRect = __plusMenuEl.getBoundingClientRect();

  let left = btnRect.left;
  let top = btnRect.bottom + 6;

  const maxLeft = Math.max(8, window.innerWidth - menuRect.width - 8);
  left = Math.max(8, Math.min(left, maxLeft));

  __plusMenuEl.style.left = `${Math.round(left)}px`;
  __plusMenuEl.style.top = `${Math.round(top)}px`;
  __plusMenuEl.style.right = "auto";

  if (!wasOpen) {
    __plusMenuEl.classList.remove("open");
    __plusMenuEl.style.visibility = "";
  }
}

function ensurePlusMenu(host) {
  if (!host) return;

  if (!__plusBtnEl) {
    __plusBtnEl = document.createElement("div");
    __plusBtnEl.className = "plusTab";
    __plusBtnEl.id = "plusTabBtn";
    __plusBtnEl.textContent = "+";
    __plusBtnEl.title = "Add…";

    __plusBtnEl.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePlusMenu(true);
    });
  }

  if (!__plusMenuEl) {
    __plusMenuEl = document.createElement("div");
    __plusMenuEl.className = "tabMenu";
    __plusMenuEl.id = "plusTabMenu";
    __plusMenuEl.style.position = "fixed";
    __plusMenuEl.innerHTML = `
      <div class="tabMenuItem" data-action="add-dataset">Dataset</div>
      <div class="tabMenuItem" data-action="add-dfm">DFM</div>
      <div class="tabMenuItem" data-action="add-workflow">Workflow</div>
      <div class="tabMenuSep"></div>
      <div class="tabMenuItem" data-action="close-menu">Cancel</div>
    `;

    __plusMenuEl.addEventListener("click", (e) => {
      const item = e.target?.closest?.(".tabMenuItem");
      const action = item?.getAttribute("data-action");
      if (!action) return;

      if (action === "add-dataset") {
        togglePlusMenu(false);
        openDatasetTab();
        return;
      }

      if (action === "add-dfm") {
        togglePlusMenu(false);
        openDFMTab();
        return;
      }

      if (action === "add-workflow") {
        togglePlusMenu(false);
        openWorkflowTab();
        return;
      }

      if (action === "import-workflow") {
        togglePlusMenu(false);
        importWorkflow();
        return;
      }

      togglePlusMenu(false);
    });

    // click outside closes
    window.addEventListener("click", () => togglePlusMenu(false));
    // ESC closes
    window.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") togglePlusMenu(false);
    });
  }

  // Ensure attached AND always keep "+" at the far right.
  // appendChild on an existing node will MOVE it to the end.
  if (__plusMenuEl && __plusMenuEl.parentNode !== document.body) document.body.appendChild(__plusMenuEl);
  if (__plusBtnEl && __plusBtnEl.parentNode !== host) host.appendChild(__plusBtnEl);

  // Always move them to the end (rightmost)
  if (__plusMenuEl && __plusMenuEl.parentNode !== document.body) document.body.appendChild(__plusMenuEl);
  if (__plusBtnEl) host.appendChild(__plusBtnEl);

  if (document.body.dataset.plusMenuScrollWired !== "1") {
    document.body.dataset.plusMenuScrollWired = "1";
    window.addEventListener("scroll", () => {
      if (__plusMenuEl && __plusMenuEl.classList.contains("open")) positionPlusMenu();
    }, { passive: true });
    window.addEventListener("resize", () => {
      if (__plusMenuEl && __plusMenuEl.classList.contains("open")) positionPlusMenu();
    });
  }
}

function togglePlusMenu(forceOpen) {
  if (!__plusMenuEl) return;
  const shouldOpen = (typeof forceOpen === "boolean")
    ? forceOpen
    : !__plusMenuEl.classList.contains("open");

  __plusMenuEl.classList.toggle("open", shouldOpen);
  if (shouldOpen) positionPlusMenu();
}


function renderTabs() {
  const host = $("tabs");
  // Remove only tab nodes; keep drop indicator + event wiring
  host.querySelectorAll(".tab").forEach(n => n.remove());

  wireTabDnDHostOnce();
  ensureDropIndicator(host);

  for (const t of state.tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (t.id === state.activeId ? " active" : "");
    el.setAttribute("data-tab-id", t.id);
    el.addEventListener("click", () => { if (__isDragging) return; setActive(t.id); });    // Reorder tabs with pointer dragging (horizontal only).
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openTabCtxMenu(t.id, e.clientX, e.clientY);
    });
    if (t.id !== "home") {
      // Prevent native HTML5 drag (and its forbidden cursor)
      el.draggable = false;

      el.addEventListener("pointerdown", (e) => {
        // Don't start drag when clicking the close button
        if (e.target && e.target.closest && e.target.closest("button.x")) return;

        // Left mouse only
        if (e.button !== 0) return;

        __ptrActive = true;
        __ptrId = e.pointerId;
        __ptrStartX = e.clientX;
        __ptrStartY = e.clientY;
        __ptrMoved = false;

        // Don't mutate layout on pointerdown. We only enter drag mode
        // after the horizontal threshold is crossed.
        __pendingDrag = true;

        __draggedTabId = t.id;
        __dragEl = el;

        // Capture pointer now so we keep receiving moves even if the pointer
        // leaves the bar before the threshold is crossed.
        try { el.setPointerCapture(e.pointerId); } catch {}
      });

      el.addEventListener("pointermove", (e) => {
        if (!__ptrActive || __ptrId !== e.pointerId) return;
        if (!__draggedTabId || !__dragEl) return;

        const dx = e.clientX - __ptrStartX;
        const dy = e.clientY - __ptrStartY;

        // Ignore vertical movement completely; only horizontal drag counts.
        if (!__ptrMoved) {
          if (Math.abs(dx) < __DRAG_THRESHOLD_PX) return;
          __ptrMoved = true;
          // Now that we've committed to a drag, create placeholder + lock layout.
          const host0 = $("tabs");
          startDragIfNeeded(host0, __dragEl, e.pointerId);
          lockTabsOverflowDuringDrag();
        }

        if (!__placeholderEl) return;

        // Make the dragged tab follow the pointer (browser-like).
        // Use transform so we don't trigger layout/reflow.
        if (__dragEl) {
          __dragEl.style.transform = `translate3d(${dx}px, 0px, 0px)`;
        }

        e.preventDefault();

        const host = $("tabs");
        if (!host) return;

        // Find which tab we're currently over (by x), and position placeholder.
        const tabs = [...host.querySelectorAll('.tab[data-tab-id]')].filter(n => n.getAttribute("data-tab-id") !== __draggedTabId);
        let inserted = false;

        // --- compute where placeholder should go ---
        let targetNode = null;
        let indicatorX = null;

        for (const node of tabs) {
          const rect = node.getBoundingClientRect();
          const mid = rect.left + rect.width / 2;
          if (e.clientX < mid) {
            targetNode = node;
            indicatorX = rect.left;
            break;
          }
        }

        const beforeRects = new Map();
        host.querySelectorAll('.tab[data-tab-id]').forEach(el => {
          const id = el.getAttribute("data-tab-id");
          if (!id) return;
          if (id === __draggedTabId) return;
          if (el.classList.contains("placeholder")) return;
          beforeRects.set(id, el.getBoundingClientRect());
        });

        // --- move placeholder (only if needed) ---
        if (targetNode) {
          if (__placeholderEl.nextSibling !== targetNode) {
            host.insertBefore(__placeholderEl, targetNode);
          }
          showIndicatorAt(host, indicatorX);
        } else {
          // move to end
          if (__placeholderEl.parentNode !== host || __placeholderEl !== host.lastChild) {
            host.appendChild(__placeholderEl);
          }
          const hr = host.getBoundingClientRect();
          showIndicatorAt(host, hr.right - 2);
        }

        // --- animate tabs only when placeholder index changed ---
        const children = Array.from(host.children);
        const newIndex = children.indexOf(__placeholderEl);
        if (newIndex !== __lastPlaceholderIndex) {
          __lastPlaceholderIndex = newIndex;
          flipAnimateTabs(host, beforeRects);
        }

      });

      el.addEventListener("pointerup", (e) => {
        if (!__ptrActive || __ptrId !== e.pointerId) return;

        // If it was a click (no real move), allow normal click handler to run.
        if (!__ptrMoved) {
          cleanupDragUI();
          return;
        }

        // Commit order based on placeholder position.
        commitOrderFromDom();
        cleanupDragUI();

        render();
        saveState();
      });

      el.addEventListener("pointercancel", (e) => {
        if (!__ptrActive || __ptrId !== e.pointerId) return;
        cleanupDragUI();
      });
    }
    const label = document.createElement("span");
    label.textContent = t.title;
    el.appendChild(label);

    if (t.id !== "home") {
      const x = document.createElement("button");
      x.className = "x" + (t.isDirty ? " dirty" : "");
      x.textContent = "✕";
      if (t.isDirty) {
        const dot = document.createElement("span");
        dot.className = "dirtyDot";
        x.appendChild(dot);
        x.title = "Unsaved changes (close tab)";
      } else {
        x.title = "Close";
      }
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        closeTab(t.id);
      });
      el.appendChild(x);
    }

    host.appendChild(el);
  }

  // Add Jupyter-like "+" button + menu (not draggable)
  ensurePlusMenu(host);

}

function ensureIframe(tab) {
  if (!iframeHost) return;

  // If iframe was destroyed somehow (e.g., hot reload), recreate it.
  if (tab.iframe && !tab.iframe.isConnected) {
    tab.iframe = null;
  }

  if (tab.iframe) return;

  const iframe = document.createElement("iframe");
  iframe.style.width = "100%";
  iframe.style.height = "100%";
  iframe.style.border = "0";
  iframe.style.display = "none";

  if (tab.type === "dataset") {
    const params = new URLSearchParams();
    if (tab.datasetId) params.set("ds", tab.datasetId);
    const inst = tab.dsInst || tab.id || `ds_${Date.now()}`;
    params.set("inst", inst);
    iframe.src = `/ui/dataset_viewer.html?${params.toString()}`;
  } else if (tab.type === "dfm") {
    const params = new URLSearchParams();
    if (tab.datasetId) params.set("ds", tab.datasetId);
    const inst = tab.dsInst || tab.id || `dfm_${Date.now()}`;
    params.set("inst", inst);
    params.set("v", UI_VERSION_PARAM);
    iframe.src = `/ui/DFM.html?${params.toString()}`;
  } else if (tab.type === "workflow") {
    const inst = tab.wfInst || tab.id || `wf_${Date.now()}`;
    iframe.src = `/ui/workflow.html?inst=${encodeURIComponent(inst)}${tab.wfFresh ? '&fresh=1' : ''}`;
    tab.wfFresh = false;
    iframe.addEventListener("load", () => {
      try {
        iframe.contentWindow?.postMessage({ type: "adas:autosave-toggle", enabled: autoSaveEnabled }, "*");
      } catch {
        // ignore
      }
    }, { once: true });
  } else if (tab.type === "project_settings") {
    iframe.src = "/ui/project_settings.html";
  }

  iframeHost.appendChild(iframe);
  tab.iframe = iframe;
}

// ---------- tab context menu ----------
const tabCtxMenu = document.getElementById("tabCtxMenu");
let tabCtxId = null;

function closeTabCtxMenu() {
  if (!tabCtxMenu) return;
  tabCtxMenu.classList.remove("open");
  tabCtxId = null;
}

function positionTabCtxMenu(x, y) {
  if (!tabCtxMenu) return;
  const pad = 8;
  const maxX = window.innerWidth - tabCtxMenu.offsetWidth - pad;
  const maxY = window.innerHeight - tabCtxMenu.offsetHeight - pad;
  tabCtxMenu.style.left = `${Math.max(pad, Math.min(x, maxX))}px`;
  tabCtxMenu.style.top = `${Math.max(pad, Math.min(y, maxY))}px`;
}

function openTabCtxMenu(tabId, x, y) {
  if (!tabCtxMenu) return;
  tabCtxId = tabId;
  updateTabCtxMenuState(tabId);
  tabCtxMenu.classList.add("open");
  positionTabCtxMenu(x, y);
}

function updateTabCtxMenuState(tabId) {
  if (!tabCtxMenu) return;
  const isHome = tabId === "home";
  const tab = state.tabs.find(t => t.id === tabId);
  const canOpenWindow = !!tab && tab.type === "dataset";
  tabCtxMenu.querySelectorAll(".tabCtxItem").forEach((el) => {
    el.classList.toggle("disabled", isHome);
    const action = el.getAttribute("data-action") || "";
    if (action === "open-window") {
      el.classList.toggle("disabled", !canOpenWindow);
    }
  });
}

function removeTabById(id) {
  if (id === "home") return;
  const idx = state.tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  const tab = state.tabs[idx];
  if (tab.iframe && tab.iframe.parentNode) {
    tab.iframe.parentNode.removeChild(tab.iframe);
  }
  state.tabs.splice(idx, 1);
}

function closeTabsExcept(keepIds) {
  const keep = new Set(keepIds || []);
  keep.add("home");
  const toRemove = state.tabs.filter(t => !keep.has(t.id)).map(t => t.id);
  toRemove.forEach(removeTabById);

  if (!keep.has(state.activeId)) {
    const next = keepIds && keepIds.length ? keepIds[0] : "home";
    state.activeId = next;
  }

  render();
  saveState();
}

function clearTestData() {
  const ok = window.confirm("Clear test data (import handle cache)?");
  if (!ok) return;
  try {
    indexedDB.deleteDatabase("adas_handles");
  } catch {}
}

function renderContent() {
  ensureContentContainers();
  renderHomeViewOnce();

  const activeTab = state.tabs.find(t => t.id === state.activeId) || state.tabs[0];
  if (!activeTab) {
    state.activeId = "home";
    return;
  }

  // Create iframes for all non-home tabs and hide them by default
  for (const t of state.tabs) {
    if (t.type === "home") continue;
    ensureIframe(t);
    if (t.iframe) t.iframe.style.display = "none";
  }

  if (activeTab.type === "home") {
    if (homeView) homeView.style.display = "block";
    if (iframeHost) iframeHost.style.display = "none";
    return;
  }

  // non-home
  if (homeView) homeView.style.display = "none";
  if (iframeHost) iframeHost.style.display = "block";

  ensureIframe(activeTab);
  if (activeTab.iframe) activeTab.iframe.style.display = "block";

  // Notify iframe that it just became visible (important for canvas resize)
  if (activeTab.iframe && activeTab.type === "dataset") {
    if (autoRefreshDatasetOnce(activeTab)) return;
    try {
      activeTab.iframe.contentWindow.postMessage(
        { type: "adas:tab-activated" },
        "*"
      );
    } catch {
      // iframe may not be ready yet
    }
  }

  if (activeTab.iframe && activeTab.type === "dfm") {
    try {
      activeTab.iframe.contentWindow.postMessage(
        { type: "adas:dfm-tab-activated" },
        "*"
      );
    } catch {
      // ignore
    }
  }
}

function openTabInNewWindow(tabId) {
  const tab = state.tabs.find(t => t.id === tabId);
  if (!tab || tab.type !== "dataset") return;
  const hostApi = getHostApi();
  if (!hostApi?.openTabWindow) {
    updateStatusBar("Open in new window is not available.");
    return;
  }
  hostApi.openTabWindow({
    type: tab.type,
    datasetId: tab.datasetId || "",
    dsInst: tab.dsInst || tab.id || "",
    title: tab.title || "Dataset",
  });
}

function printActiveTab() {
  const t = state.tabs.find(x => x.id === state.activeId);
  if (!t) return;
  if (t.type === "home") {
    window.print();
    return;
  }
  if (t.iframe && t.iframe.contentWindow) {
    try {
      t.iframe.contentWindow.focus();
      t.iframe.contentWindow.print();
      return;
    } catch {
      // ignore
    }
  }
  window.print();
}

function render() {
  if (__isDragging) return; 
  renderTabs();
  renderContent();
  updateFileMenuState();
  updateEditMenuState();
  updateViewMenuState();
  saveState();
}


function wire() {

  initZoomControls();
  initAutoSaveToggle();
  initFontSettingsModal();
  initRootPathSettingsModal();

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (!msg) return;

    if (msg.type === "adas:close-shell-menus") {
      closeAllShellMenus();
      return;
    }

    if (msg.type === "adas:dfm-edit-state") {
      dfmEditEnabled = !!msg.enabled;
      updateEditMenuState();
      return;
    }

    if (msg.type === "adas:update-workflow-tab-title") {
      const title = String(msg.title || "").trim();
      const inst = String(msg.inst || "");
      if (!title || !inst) return;

      const tab = state.tabs.find(t => t.type === "workflow" && t.wfInst === inst);
      if (!tab) return;

      tab.title = title;
      render();
      saveState();
      return;
    }

    if (msg.type === "adas:workflow-saved") {
      const path = String(msg.path || "").trim();
      if (!path) return;
      const inst = String(msg.inst || "");
      if (inst) {
        const tab = state.tabs.find(t => t.type === "workflow" && t.wfInst === inst);
        if (!tab) return;
        tab.isDirty = false;
        renderTabs();
      }
      const label = msg.source === "auto" ? "Auto-saved" : "Saved";
      updateStatusBar(`${label}: ${path} (${formatStatusTimestamp()})`);
      setLastWorkflowPath(path);
      return;
    }

    if (msg.type === "adas:workflow-dirty") {
      const inst = String(msg.inst || "");
      if (!inst) return;
      const tab = state.tabs.find(t => t.type === "workflow" && t.wfInst === inst);
      if (!tab) return;
      const dirty = !!msg.dirty;
      if (tab.isDirty === dirty) return;
      tab.isDirty = dirty;
      if (dirty) clearSavedStatusOnDirty();
      renderTabs();
      saveState();
      return;
    }

    if (msg.type === "adas:zoom") {
      const deltaY = Number(msg.deltaY || 0);
      adjustZoomByDelta(deltaY);
      return;
    }

    if (msg.type === "adas:zoom-step") {
      const delta = Number(msg.delta || 0);
      if (!Number.isFinite(delta) || !delta) return;
      setZoomPercent(zoomPercent + delta * ZOOM_STEP, true);
      return;
    }

    if (msg.type === "adas:zoom-reset") {
      setZoomPercent(100, true);
      return;
    }

    if (msg.type === "adas:status") {
      const text = String(msg.text || "").trim();
      if (text) updateStatusBar(text);
      return;
    }

    if (msg.type === "adas:tooltip") {
      if (msg.show) {
        let x = Number(msg.x) || 0;
        let y = Number(msg.y) || 0;
        if (msg.coord === "client") {
          try {
            const active = state.tabs.find(t => t.id === state.activeId);
            const iframe = active?.iframe;
            if (iframe && iframe.getBoundingClientRect) {
              const rect = iframe.getBoundingClientRect();
              x += rect.left;
              y += rect.top;
            }
          } catch {}
        }
        if (msg.coord === "screen") {
          try {
            x = x - (window.screenX || 0);
            y = y - (window.screenY || 0);
          } catch {}
        }
        showGlobalTooltip(msg.text || "", x, y);
      } else {
        hideGlobalTooltip();
      }
      return;
    }

    if (msg.type === "adas:workflow-import") {
      importWorkflow();
      return;
    }

    if (msg.type === "adas:close-active-tab") {
      closeTab(state.activeId);
      return;
    }

    if (msg.type === "adas:app-shutdown") {
      shutdownApplication();
      return;
    }

    if (msg.type === "adas:hotkey") {
      const action = String(msg.action || "");
      if (action) runHotkeyAction(action);
      return;
    }

    if (msg.type !== "adas:update-active-tab-title") return;

    const title = String(msg.title || "").trim();
    if (!title) return;

    const tab = state.tabs.find(t => t.id === state.activeId);
    if (!tab) return;

    // Never allow ... to be renamed
    if (tab.type === "home") return;
    if (tab.type === "workflow") return;
    if (tab.type === "project_settings") return;

    // if (tab.type !== "dataset" && tab.type !== "workflow") return;

    tab.title = title;

    render();
    saveState();
  });

  tabCtxMenu?.addEventListener("click", (e) => {
    const item = e.target?.closest?.(".tabCtxItem");
    const action = item?.getAttribute("data-action");
    if (!action || item.classList.contains("disabled")) return;
    const id = tabCtxId;
    closeTabCtxMenu();
    if (!id) return;

    if (action === "open-window") {
      openTabInNewWindow(id);
      return;
    }
    if (action === "close") {
      closeTab(id);
      return;
    }
    if (action === "close-others") {
      closeTabsExcept([id]);
      return;
    }
    if (action === "close-all") {
      closeTabsExcept([]);
      return;
    }
  });

  window.addEventListener("click", () => {
    closeTabCtxMenu();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeTabCtxMenu();
  });

}

function initResizeHandle() {
  const api = getHostApi();
  const handle = $("resizeHandle");
  if (!handle || !api?.getWindowSize || !api?.resizeWindow) return;

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startW = 0;
  let startH = 0;
  let rafPending = false;
  let nextW = 0;
  let nextH = 0;
  let lastApplyTs = 0;

  const applyResize = () => {
    rafPending = false;
    const now = Date.now();
    if (now - lastApplyTs < 30) return;
    lastApplyTs = now;
    const w = Math.max(820, Math.round(nextW));
    const h = Math.max(620, Math.round(nextH));
    api.resizeWindow(w, h);
  };

  const onMove = (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    nextW = startW + dx;
    nextH = startH + dy;
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(applyResize);
    }
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("is-resizing");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };

  handle.addEventListener("mousedown", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const size = await api.getWindowSize();
      startW = Number(size?.width || size?.w || 0);
      startH = Number(size?.height || size?.h || 0);
    } catch {
      return;
    }
    if (!startW || !startH) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    document.body.classList.add("is-resizing");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function initClock() {
  const el = $("clockText");
  if (!el) return;

  const pad = (n) => String(n).padStart(2, "0");
  const tick = () => {
    const d = new Date();
    el.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  tick();
  setInterval(tick, 1000);
}

// ---------- boot ----------
loadState();
ensureContentContainers();
wire();
render();
  if (getHostApi()) initTitlebarControls();
  window.addEventListener("adaHostReady", () => initTitlebarControls());
  if (getHostApi()) initResizeHandle();
  window.addEventListener("adaHostReady", () => initResizeHandle());
initClock();

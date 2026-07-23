import { $, shell } from "./shell_context.js?v=20260510a";

const ZOOM_STORAGE_KEY = "arcrho_ui_zoom_pct";
const AUTOSAVE_KEY = "arcrho_autosave_enabled";
const FONT_STORAGE_KEY = "arcrho_app_font";
const FORCE_REBUILD_KEY = "arcrho_force_rebuild_enabled";
export const ZOOM_MIN = 70;
export const ZOOM_MAX = 160;
export const ZOOM_STEP = 10;

let zoomPercent = 100;
let zoomToastTimer = null;
let zoomUiWired = false;
let zoomRangeDragging = false;
let autoSaveEnabled = true;
let forceRebuildEnabled = false;
let colorTheme = "light";
let fontModalWired = false;
let forceRebuildModalWired = false;
let colorThemeEventsWired = false;

export const hostZoomAvailable = () => typeof window.ADAHost?.setZoomFactor === "function";

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

export function loadAppFont() {
  try {
    const raw = localStorage.getItem(FONT_STORAGE_KEY);
    if (raw && typeof raw === "string") return raw;
  } catch {}
  return "";
}

export function loadColorTheme() {
  return window.ArcRhoColorTheme?.readStoredTheme?.() || "light";
}

function loadForceRebuildEnabled() {
  try {
    const raw = localStorage.getItem(FORCE_REBUILD_KEY);
    if (raw == null) return false;
    return raw === "1";
  } catch {}
  return false;
}

function buildFontStack(font) {
  const raw = String(font || "").trim();
  if (!raw) return "";
  if (raw.includes(",")) return raw;
  const primary = /\s/.test(raw) ? `"${raw.replace(/\"/g, "")}"` : raw;
  return `${primary}, "Segoe UI", "SegoeUI", Tahoma, Arial, sans-serif`;
}

export function applyAppFont(font) {
  const stack = buildFontStack(font);
  if (!stack) return;
  const root = document.documentElement;
  if (root) root.style.setProperty("--app-font", stack);
  if (document.body) document.body.style.fontFamily = stack;
}

export function getAutoSaveEnabled() {
  return autoSaveEnabled;
}

export function getZoomPercent() {
  return zoomPercent;
}

export function getForceRebuildEnabled() {
  return forceRebuildEnabled;
}

export function getColorTheme() {
  return colorTheme;
}

export function updateColorThemeMenuState() {
  for (const theme of ["light", "dark"]) {
    const item = document.querySelector(`[data-action="color-theme-${theme}"]`);
    if (!item) continue;
    const selected = theme === colorTheme;
    item.setAttribute("aria-checked", selected ? "true" : "false");
    item.classList.toggle("selected", selected);
  }
}

export function broadcastColorTheme(theme = colorTheme) {
  const normalized = window.ArcRhoColorTheme?.normalizeTheme?.(theme) || "light";
  const messageType = window.ArcRhoColorTheme?.MESSAGE_TYPE || "arcrho:set-color-theme";
  for (const tab of shell.state?.tabs || []) {
    if (!tab.iframe?.contentWindow) continue;
    try {
      tab.iframe.contentWindow.postMessage({ type: messageType, theme: normalized }, "*");
    } catch {
      // Ignore frames that are unavailable while loading or closing.
    }
  }
}

export function setColorTheme(theme, { persist = true, notify = true } = {}) {
  const api = window.ArcRhoColorTheme;
  colorTheme = api?.normalizeTheme?.(theme) || "light";
  if (persist) {
    api?.setTheme?.(colorTheme, { notifyChildren: false, source: "shell" });
  } else {
    api?.applyTheme?.(colorTheme, { notifyChildren: false, persist: false, source: "shell" });
  }
  updateColorThemeMenuState();
  if (notify) broadcastColorTheme(colorTheme);
  return colorTheme;
}

export function initColorThemePreference() {
  colorTheme = loadColorTheme();
  window.ArcRhoColorTheme?.applyTheme?.(colorTheme, {
    notifyChildren: false,
    persist: false,
    source: "shell-bootstrap",
  });
  updateColorThemeMenuState();
  if (colorThemeEventsWired) return;
  colorThemeEventsWired = true;
  window.addEventListener("arcrho:color-theme-changed", (event) => {
    const nextTheme = window.ArcRhoColorTheme?.normalizeTheme?.(event?.detail?.theme) || "light";
    if (nextTheme === colorTheme) return;
    colorTheme = nextTheme;
    updateColorThemeMenuState();
  });
}

function broadcastForceRebuildToggle() {
  for (const t of shell.state?.tabs || []) {
    if (!t.iframe || !t.iframe.contentWindow) continue;
    try {
      t.iframe.contentWindow.postMessage(
        { type: "arcrho:force-rebuild-toggle", enabled: forceRebuildEnabled },
        "*",
      );
    } catch {
      // ignore
    }
  }
}

export function setForceRebuildEnabled(enabled, { persist = true, notify = true } = {}) {
  forceRebuildEnabled = !!enabled;
  if (persist) {
    try { localStorage.setItem(FORCE_REBUILD_KEY, forceRebuildEnabled ? "1" : "0"); } catch {}
  }
  if (notify) broadcastForceRebuildToggle();
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
  for (const t of shell.state?.tabs || []) {
    if (t.type !== "workflow") continue;
    if (!t.iframe || !t.iframe.contentWindow) continue;
    try {
      t.iframe.contentWindow.postMessage({ type: "arcrho:autosave-toggle", enabled: autoSaveEnabled }, "*");
    } catch {
      // ignore
    }
  }
}

export function setAutoSaveEnabled(enabled, { persist = true, notify = true } = {}) {
  autoSaveEnabled = !!enabled;
  if (persist) {
    try { localStorage.setItem(AUTOSAVE_KEY, autoSaveEnabled ? "1" : "0"); } catch {}
  }
  updateAutoSaveToggleUI();
  if (notify) broadcastAutoSaveToggle();
}

export function initAutoSaveToggle() {
  autoSaveEnabled = loadAutoSaveEnabled();
  updateAutoSaveToggleUI();
  const btn = $("autoSaveSwitch");
  if (!btn || btn.dataset.shellWired === "1") return;
  btn.dataset.shellWired = "1";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setAutoSaveEnabled(!autoSaveEnabled);
  });
}

function updateFontPreview(value) {
  const preview = $("fontPreview");
  if (!preview) return;
  const stack = buildFontStack(value);
  preview.style.fontFamily = stack || "";
}

export function openFontSettingsModal() {
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

export function closeFontSettingsModal() {
  const overlay = $("fontSettingsOverlay");
  if (overlay) overlay.classList.remove("open");
}

export function initFontSettingsModal() {
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

export function openForceRebuildSettingsModal() {
  const overlay = $("forceRebuildSettingsOverlay");
  const toggle = $("forceRebuildToggle");
  if (!overlay || !toggle) return;
  toggle.checked = loadForceRebuildEnabled();
  overlay.classList.add("open");
  requestAnimationFrame(() => toggle.focus());
}

export function closeForceRebuildSettingsModal() {
  const overlay = $("forceRebuildSettingsOverlay");
  if (overlay) overlay.classList.remove("open");
}

export function initForceRebuildSettingsModal() {
  if (forceRebuildModalWired) return;
  forceRebuildModalWired = true;
  const overlay = $("forceRebuildSettingsOverlay");
  const toggle = $("forceRebuildToggle");
  const applyBtn = $("forceRebuildApplyBtn");
  const cancelBtn = $("forceRebuildCancelBtn");
  if (!overlay || !toggle || !applyBtn || !cancelBtn) return;

  applyBtn.addEventListener("click", () => {
    setForceRebuildEnabled(!!toggle.checked);
    closeForceRebuildSettingsModal();
    shell.updateStatusBar?.(`Force Rebuild ${toggle.checked ? "enabled" : "disabled"}.`);
  });
  cancelBtn.addEventListener("click", () => closeForceRebuildSettingsModal());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeForceRebuildSettingsModal();
  });
  window.addEventListener("keydown", (e) => {
    if (!overlay.classList.contains("open")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeForceRebuildSettingsModal();
    } else if (e.key === "Enter") {
      e.preventDefault();
      applyBtn.click();
    }
  }, true);
}

export function applyZoom() {
  const root = document.documentElement;
  const body = document.body;
  const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(zoomPercent)));
  zoomPercent = z;
  if (hostZoomAvailable()) {
    try { localStorage.setItem("arcrho_zoom_mode", "host"); } catch {}
    window.ADAHost?.setZoomFactor?.(z / 100);
  } else {
    try { localStorage.setItem("arcrho_zoom_mode", "css"); } catch {}
    if (root) root.style.zoom = String(z / 100);
    if (body) body.style.zoom = String(z / 100);
  }
  const statusH = shell.getStatusBarHeight?.() || 24;
  try { localStorage.setItem("arcrho_statusbar_h", String(statusH)); } catch {}
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

export function adjustZoomByDelta(deltaY) {
  const step = deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
  setZoomPercent(zoomPercent + step, true);
}

export function setZoomPercent(value, showToast) {
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

export function initZoomControls() {
  if (zoomUiWired) return;
  zoomUiWired = true;
  const outBtn = $("zoomOutBtn");
  const inBtn = $("zoomInBtn");
  const range = $("zoomRange");
  outBtn?.addEventListener("click", () => setZoomPercent(zoomPercent - ZOOM_STEP, true));
  inBtn?.addEventListener("click", () => setZoomPercent(zoomPercent + ZOOM_STEP, true));
  if (range) {
    range.addEventListener("pointerdown", () => { zoomRangeDragging = true; });
    range.addEventListener("pointerup", () => { zoomRangeDragging = false; });
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

export function broadcastZoomToIframes() {
  const z = zoomPercent;
  const statusH = shell.getStatusBarHeight?.() || 24;
  for (const t of shell.state?.tabs || []) {
    if (!t.iframe || !t.iframe.contentWindow) continue;
    try {
      t.iframe.contentWindow.postMessage(
        { type: "arcrho:set-zoom", zoom: z, statusBarHeight: statusH },
        "*"
      );
    } catch {
      // ignore
    }
  }
}

export function broadcastAppFont(font) {
  if (!font) return;
  for (const t of shell.state?.tabs || []) {
    if (!t.iframe || !t.iframe.contentWindow) continue;
    try {
      t.iframe.contentWindow.postMessage(
        { type: "arcrho:set-app-font", font },
        "*"
      );
    } catch {
      // ignore
    }
  }
}

export function showGlobalTooltip(text, x, y) {
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
  if (left + rect.width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - rect.width - pad);
  if (top + rect.height > window.innerHeight - pad) top = Math.max(pad + rect.height / 2, window.innerHeight - rect.height - pad);
  if (left < pad) left = pad;
  if (top < pad + rect.height / 2) top = pad + rect.height / 2;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

export function hideGlobalTooltip() {
  const tip = $("globalTooltip");
  if (!tip) return;
  tip.classList.remove("show");
}

export function initShellPreferences() {
  initColorThemePreference();
  applyAppFont(loadAppFont());
  forceRebuildEnabled = loadForceRebuildEnabled();
  zoomPercent = loadZoomPercent();
  applyZoom();
}

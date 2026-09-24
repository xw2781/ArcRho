/*
===============================================================================
DFM Ratios Custom Colors - the live preference behind the Custom Colors window.

The colours are a local-user preference that every DFM window shares, kept in
`%APPDATA%\ArcRho\prefs\dfm_ratio_colors.json` through the desktop host. A copy
in localStorage paints a window at boot without waiting for the host, and is
all there is in a browser session without the host. A change is painted at
once, told to the other DFM windows over a BroadcastChannel, and written to the
host file shortly after the last edit.
===============================================================================
*/
import {
  DFM_RATIO_COLORS_ATTRIBUTE,
  dfmRatioColorCssState,
  normalizeDfmRatioColors,
} from "/ui/method_pages/dfm/dfm_ratio_colors_model.js?v=20260924a";

const STORAGE_KEY = "arcrho_dfm_ratio_colors";
const CHANNEL_NAME = "arcrho:dfm-ratio-colors";
const SAVE_DELAY_MS = 400;

const listeners = new Set();
let current = normalizeDfmRatioColors(null);
let appliedProperties = [];
let channel = null;
let saveTimer = 0;
let editedSinceBoot = false;
let booted = false;

/** The desktop host bridge; a nested page reaches it through its top window. */
function hostApi() {
  try {
    return window.ADAHost || window.top?.ADAHost || null;
  } catch {
    return null;
  }
}

function readCachedColors() {
  try {
    return normalizeDfmRatioColors(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null"));
  } catch {
    return normalizeDfmRatioColors(null);
  }
}

function writeCachedColors(prefs) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Blocked storage only costs the next window its early paint.
  }
}

function applyToDocument(prefs) {
  const root = document.documentElement;
  const { tokens, properties } = dfmRatioColorCssState(prefs);
  for (const name of appliedProperties) {
    if (!(name in properties)) root.style.removeProperty(name);
  }
  for (const [name, value] of Object.entries(properties)) root.style.setProperty(name, value);
  appliedProperties = Object.keys(properties);
  if (tokens.length) root.setAttribute(DFM_RATIO_COLORS_ATTRIBUTE, tokens.join(" "));
  else root.removeAttribute(DFM_RATIO_COLORS_ATTRIBUTE);
}

/** Paints `prefs` and tells the listeners; false when nothing changed. */
function adopt(prefs) {
  const next = normalizeDfmRatioColors(prefs);
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  current = next;
  applyToDocument(current);
  listeners.forEach((listener) => listener(current));
  return true;
}

function saveToHost() {
  saveTimer = 0;
  const save = hostApi()?.saveDfmRatioColorPreferences;
  if (typeof save !== "function") return;
  Promise.resolve(save(current)).catch(() => {
    // A host that cannot write keeps the colours for this session only.
  });
}

export function getDfmRatioColors() {
  return current;
}

export function subscribeDfmRatioColors(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setDfmRatioColors(prefs) {
  editedSinceBoot = true;
  if (!adopt(prefs)) return;
  writeCachedColors(current);
  channel?.postMessage(current);
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveToHost, SAVE_DELAY_MS);
}

function openCustomColorsWindow(event) {
  if (!event.target?.closest?.('[data-action="custom-colors"]')) return;
  void import("/ui/method_pages/dfm/dfm_ratio_colors_window.js?v=20260924a")
    .then((module) => module.openDfmRatioColorsWindow());
}

/**
 * Paints the stored colours, then keeps them current: the host file replaces
 * the local copy once it arrives, and other DFM windows' edits arrive over the
 * channel. Also wires the Custom Colors item of both Ratios context menus;
 * each menu's own handler closes it.
 */
export function bootDfmRatioColors() {
  if (booted) return;
  booted = true;
  adopt(readCachedColors());
  if (typeof BroadcastChannel === "function") {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event) => adopt(event.data);
  }
  window.addEventListener("pagehide", () => {
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveToHost();
    }
  });
  for (const menuId of ["dfmRatioMenu", "dfmAvgMenu"]) {
    document.getElementById(menuId)?.addEventListener("click", openCustomColorsWindow);
  }
  const load = hostApi()?.loadDfmRatioColorPreferences;
  if (typeof load !== "function") return;
  Promise.resolve(load())
    .then((result) => {
      if (editedSinceBoot || !result?.ok || !result.exists) return;
      if (adopt(result.preferences)) writeCachedColors(current);
    })
    .catch(() => {
      // Without the host file the local copy stands.
    });
}

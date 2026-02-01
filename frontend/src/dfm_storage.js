/**
 * DFM Storage Module
 * Handles all localStorage operations for DFM state persistence.
 */

const NA_BORDER_KEY = "adas_dfm_ratio_na_borders";

/**
 * Gets the base key for summary-related storage, based on current inputs.
 * @returns {string|null}
 */
export function getSummaryKeyBase() {
  const path = document.getElementById("pathInput")?.value?.trim();
  const tri = document.getElementById("triInput")?.value?.trim();
  const origin = document.getElementById("originLenSelect")?.value?.trim();
  if (!path || !tri || !origin) return null;
  return `${encodeURIComponent(path)}::${encodeURIComponent(tri)}::o${encodeURIComponent(origin)}`;
}

export function getSummaryOrderKey() {
  const base = getSummaryKeyBase();
  return base ? `adas_dfm_summary_order::${base}` : null;
}

export function getSummaryConfigKey() {
  const base = getSummaryKeyBase();
  return base ? `adas_dfm_summary_custom::${base}` : null;
}

export function getSummaryHiddenKey() {
  const base = getSummaryKeyBase();
  return base ? `adas_dfm_summary_hidden::${base}` : null;
}

export function getMethodNameKey() {
  const base = getSummaryKeyBase();
  return base ? `adas_dfm_method_name::${base}` : null;
}

export function getSavedMethodKey() {
  const base = getSummaryKeyBase();
  return base ? `adas_dfm_has_saved_method::${base}` : null;
}

export function getNaBorderKey() {
  return NA_BORDER_KEY;
}

// --- Load functions ---

export function loadHiddenSummaryIds(key) {
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function loadSummaryOrder(key) {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function loadCustomSummaryRows(key) {
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function loadMethodName(key) {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? String(raw) : null;
  } catch {
    return null;
  }
}

export function loadNaBorders() {
  try {
    return localStorage.getItem(NA_BORDER_KEY) === "1";
  } catch {
    return false;
  }
}

// --- Save functions ---

export function saveHiddenSummaryIds(key, ids) {
  if (!key || !Array.isArray(ids)) return;
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {}
}

export function saveSummaryOrder(key, order) {
  if (!key || !Array.isArray(order)) return;
  try {
    localStorage.setItem(key, JSON.stringify(order));
  } catch {}
}

export function saveCustomSummaryRows(key, rows) {
  if (!key || !Array.isArray(rows)) return;
  try {
    localStorage.setItem(key, JSON.stringify(rows));
  } catch {}
}

export function saveMethodName(key, name) {
  if (!key || !name) return;
  try {
    localStorage.setItem(key, name);
  } catch {}
}

export function saveNaBorders(value) {
  try {
    localStorage.setItem(NA_BORDER_KEY, value ? "1" : "0");
  } catch {}
}

// --- Method saved flag ---

export function hasSavedMethod() {
  const key = getSavedMethodKey();
  if (!key) return false;
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function markMethodSaved() {
  const key = getSavedMethodKey();
  if (!key) return;
  try {
    localStorage.setItem(key, "1");
  } catch {}
}

export function clearMethodSavedFlag() {
  const key = getSavedMethodKey();
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch {}
}

// --- Ratio selection persistence ---

export function getRatioSelectionKey() {
  const base = getSummaryKeyBase();
  return base ? `adas_dfm_ratio_selection::${base}` : null;
}

export function loadRatioSelection(key) {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveRatioSelection(key, data) {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {}
}

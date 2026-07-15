/**
 * DFM Storage Module
 * Handles all localStorage operations for DFM state persistence.
 */

const NA_BORDER_KEY = "arcrho_dfm_ratio_na_borders";
const RATIO_INTERACTION_MODE_KEY = "arcrho_dfm_ratio_interaction_mode";
let _storageInstanceId = "";

function getResolvedProjectNameForStorage() {
  try {
    if (typeof window.ADA_GET_DFM_INPUTS === "function") {
      const snap = window.ADA_GET_DFM_INPUTS();
      const resolved = String(snap?.resolved?.project || "").trim();
      if (resolved) return resolved;
    }
  } catch {
    // ignore
  }
  return document.getElementById("projectSelect")?.value?.trim() || "";
}

/**
 * Sets the instance ID used to scope all DFM storage keys.
 * Must be called once during initialization before any storage operations.
 * @param {string} id - The instance identifier (e.g., "step_1", "dfm_2")
 */
export function setStorageInstance(id) {
  _storageInstanceId = id || "";
}

/**
 * Gets the base key for summary-related storage, based on current inputs.
 * Scoped by instance ID so multiple DFM instances are independent.
 * @returns {string|null}
 */
export function getSummaryKeyBase() {
  const methodName = document.getElementById("dfmMethodName")?.value?.trim();
  const project = getResolvedProjectNameForStorage();
  const dev = document.getElementById("devLenSelect")?.value?.trim();
  const origin = document.getElementById("originLenSelect")?.value?.trim();
  if (!methodName || !project || !dev || !origin) return null;
  const base = `${encodeURIComponent(methodName)}::${encodeURIComponent(project)}::d${encodeURIComponent(dev)}::o${encodeURIComponent(origin)}`;
  return _storageInstanceId ? `${_storageInstanceId}::${base}` : base;
}

export function getSummaryConfigKey() {
  const base = getSummaryKeyBase();
  return base ? `arcrho_dfm_summary_custom::${base}` : null;
}

export function getSavedMethodKey() {
  const base = getSummaryKeyBase();
  return base ? `arcrho_dfm_has_saved_method::${base}` : null;
}

export function getNaBorderKey() {
  return NA_BORDER_KEY;
}

// --- Load functions ---

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

export function loadNaBorders() {
  try {
    const raw = localStorage.getItem(NA_BORDER_KEY);
    if (raw === null) return true;
    return raw === "1";
  } catch {
    return true;
  }
}

export function loadRatioInteractionMode() {
  try {
    const raw = localStorage.getItem(RATIO_INTERACTION_MODE_KEY);
    return raw === "select" || raw === "edit" ? raw : "edit";
  } catch {
    return "edit";
  }
}

// --- Save functions ---

export function saveCustomSummaryRows(key, rows) {
  if (!key || !Array.isArray(rows)) return;
  try {
    localStorage.setItem(key, JSON.stringify(rows));
  } catch {}
}

export function saveNaBorders(value) {
  try {
    localStorage.setItem(NA_BORDER_KEY, value ? "1" : "0");
  } catch {}
}

export function saveRatioInteractionMode(mode) {
  const normalized = mode === "select" ? "select" : "edit";
  try {
    localStorage.setItem(RATIO_INTERACTION_MODE_KEY, normalized);
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
  return base ? `arcrho_dfm_ratio_selection::${base}` : null;
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

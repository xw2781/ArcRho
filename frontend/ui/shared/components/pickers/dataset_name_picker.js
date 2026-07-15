import { fetchProjectDatasetTypeItems, parseDatasetTypesCalculatedFlag } from "/ui/shared/dataset/dataset_types_source.js";
import {
  buildDatasetTypeCalculatedOptions,
  buildDatasetTypeDataFormatOptions,
  buildDatasetTypeCategoryOptions,
  compareDatasetTypeItems,
  filterDatasetTypeItems,
  getDatasetTypeCalculatedLabel,
  groupDatasetTypeItemsByCategory,
  isDatasetTypeCategoryFilterActive,
  isDatasetTypeCategoryVisible,
  isDatasetTypeCalculatedVisible,
  isDatasetTypeDataFormatVisible,
  isDatasetTypeSelectionFilterActive,
  matchesDatasetTypeNameSearch,
  tokenizeDatasetTypeNameSearch,
} from "/ui/shared/dataset/dataset_types_view_model.js";
import {
  loadProjectUserPreferences,
  scheduleProjectUserPreferencesSave,
} from "/ui/shared/services/project_user_preferences.js";

const STYLE_ID = "arcrho-dataset-name-picker-style";
const WINDOW_MARGIN_PX = 8;
const PREFS_KEY = "arcrho_dataset_name_picker_prefs_v1";
const PROJECT_USER_PREFS_KEY = "datasetNamePicker";

let DATASET_NAME_CACHE = new Map();
let activeDatasetNamePicker = null;
let pickerPrefsCacheByProject = new Map();
let pickerPrefsLoadPromiseByProject = new Map();
let pickerPrefsLastSavedSigByProject = new Map();

function getDefaultPickerPrefs() {
  return {
    doubleClickToSelect: false,
    closeAfterSelection: true,
  };
}

function normalizePickerPrefs(rawPrefs) {
  const defaults = getDefaultPickerPrefs();
  const prefs = rawPrefs && typeof rawPrefs === "object" ? rawPrefs : {};
  return {
    doubleClickToSelect: typeof prefs.doubleClickToSelect === "boolean"
      ? prefs.doubleClickToSelect
      : defaults.doubleClickToSelect,
    closeAfterSelection: typeof prefs.closeAfterSelection === "boolean"
      ? prefs.closeAfterSelection
      : defaults.closeAfterSelection,
  };
}

function getPickerPrefsSignature(rawPrefs) {
  const prefs = normalizePickerPrefs(rawPrefs);
  return `${prefs.doubleClickToSelect ? "1" : "0"}|${prefs.closeAfterSelection ? "1" : "0"}`;
}

function loadPickerPrefsFromLocalStorage() {
  const defaults = getDefaultPickerPrefs();
  try {
    const raw = localStorage.getItem(PREFS_KEY) || "";
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return normalizePickerPrefs(parsed);
  } catch {
    return defaults;
  }
}

function savePickerPrefsToLocalStorage(rawPrefs) {
  const prefs = normalizePickerPrefs(rawPrefs);
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      doubleClickToSelect: prefs.doubleClickToSelect,
      closeAfterSelection: prefs.closeAfterSelection,
    }));
  } catch {
    // ignore
  }
}

async function loadPickerPrefs(projectName) {
  const project = toText(projectName);
  const cacheKey = normalizeKey(project);
  if (!project) return loadPickerPrefsFromLocalStorage();
  if (pickerPrefsCacheByProject.has(cacheKey)) {
    return normalizePickerPrefs(pickerPrefsCacheByProject.get(cacheKey));
  }
  if (pickerPrefsLoadPromiseByProject.has(cacheKey)) {
    return pickerPrefsLoadPromiseByProject.get(cacheKey);
  }

  const loadPromise = (async () => {
    const fallback = loadPickerPrefsFromLocalStorage();
    let normalized = normalizePickerPrefs(fallback);
    let hasProjectPrefs = false;

    try {
      const payload = await loadProjectUserPreferences(project);
      const hasKey = payload
        && typeof payload === "object"
        && Object.prototype.hasOwnProperty.call(payload, PROJECT_USER_PREFS_KEY);
      if (hasKey) {
        normalized = normalizePickerPrefs(payload?.[PROJECT_USER_PREFS_KEY]);
        hasProjectPrefs = true;
      }
    } catch {
      // keep local fallback
    }

    pickerPrefsCacheByProject.set(cacheKey, normalized);
    pickerPrefsLastSavedSigByProject.set(cacheKey, hasProjectPrefs ? getPickerPrefsSignature(normalized) : "");
    savePickerPrefsToLocalStorage(normalized);
    if (!hasProjectPrefs) schedulePickerPrefsSave(project, normalized);
    return normalizePickerPrefs(normalized);
  })();
  pickerPrefsLoadPromiseByProject.set(cacheKey, loadPromise);

  try {
    return await loadPromise;
  } finally {
    pickerPrefsLoadPromiseByProject.delete(cacheKey);
  }
}

function schedulePickerPrefsSave(projectName, rawPrefs) {
  const project = toText(projectName);
  const cacheKey = normalizeKey(project);
  const normalized = normalizePickerPrefs(rawPrefs);
  if (cacheKey) pickerPrefsCacheByProject.set(cacheKey, normalized);
  savePickerPrefsToLocalStorage(normalized);

  const signature = getPickerPrefsSignature(normalized);
  if (!project || signature === pickerPrefsLastSavedSigByProject.get(cacheKey)) return;
  pickerPrefsLastSavedSigByProject.set(cacheKey, signature);
  scheduleProjectUserPreferencesSave(project, {
    [PROJECT_USER_PREFS_KEY]: {
      doubleClickToSelect: normalized.doubleClickToSelect,
      closeAfterSelection: normalized.closeAfterSelection,
      updated_at: new Date().toISOString(),
    },
  });
}

function toText(value) {
  return String(value || "").trim();
}

function normalizeKey(value) {
  return toText(value).replace(/\s+/g, " ").toLowerCase();
}

function ensureStyles(doc) {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .dsp-window {
      position: fixed;
      top: 120px;
      left: 50%;
      transform: translateX(-50%);
      width: 820px;
      min-width: 560px;
      min-height: 260px;
      max-width: 96vw;
      max-height: 88vh;
      background: #fff;
      border: 1px solid #cfcfcf;
      border-radius: 8px;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.2);
      z-index: 5350;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      resize: both;
      overscroll-behavior: contain;
    }
    .dsp-titlebar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 12px;
      background: #f6f6f6;
      border-bottom: 1px solid #e1e1e1;
      user-select: none;
      cursor: grab;
      flex-shrink: 0;
    }
    .dsp-titlebar:active { cursor: grabbing; }
    .dsp-title {
      min-width: 0;
      font-weight: 600;
      font-size: 14px;
      color: #2e2e2e;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .dsp-tools {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
    .dsp-toolbtn {
      width: 28px;
      height: 28px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: #666;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }
    .dsp-toolbtn:hover { background: #e8e8e8; }
    .dsp-toolbtn.active {
      background: #e8f0fe;
      color: #1f4dc5;
    }
    .dsp-toolbtn svg {
      width: 16px;
      height: 16px;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.9;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .dsp-close {
      width: 28px;
      height: 28px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: #666;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }
    .dsp-close:hover { background: #e8e8e8; }
    .dsp-close svg {
      width: 18px;
      height: 18px;
      stroke: currentColor;
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .dsp-body {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
      background: #fff;
    }
    .dsp-table-head {
      display: grid;
      grid-template-columns: var(--dsp-col-template, 180px 180px 140px 120px 360px);
      align-items: center;
      gap: 0;
      padding: 0;
      border-bottom: 1px solid #e3e3e3;
      background: #f8f9fc;
      flex-shrink: 0;
      position: sticky;
      top: 0;
      z-index: 4;
      min-width: fit-content;
      width: fit-content;
      box-shadow: 0 1px 0 #e3e3e3;
    }
    .dsp-head-btn {
      border: none;
      background: transparent;
      color: #333;
      font-size: 12px;
      font-weight: 600;
      text-align: left;
      padding: 7px 10px;
      border-radius: 0;
      border-right: 1px solid #e3e3e3;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      position: relative;
    }
    .dsp-head-text {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dsp-head-btn:last-child { border-right: none; }
    .dsp-head-btn:hover { background: #e9eefc; }
    .dsp-head-btn.active {
      color: #1f4dc5;
      background: #e8f0fe;
    }
    .dsp-sort-ind {
      width: 12px;
      height: 12px;
      color: #6b7280;
      opacity: 0.9;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .dsp-head-btn.active .dsp-sort-ind {
      color: #1f4dc5;
    }
    .dsp-sort-ind svg {
      width: 100%;
      height: 100%;
      stroke: none;
      fill: currentColor;
    }
    .dsp-filter-btn {
      margin-left: auto;
      width: 16px;
      height: 16px;
      border-radius: 3px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: #6b7280;
      cursor: pointer;
      flex-shrink: 0;
    }
    .dsp-filter-btn:hover {
      background: #dbe5ff;
      color: #1f4dc5;
    }
    .dsp-filter-btn.active {
      background: #dbe5ff;
      color: #1f4dc5;
    }
    .dsp-filter-btn svg {
      width: 12px;
      height: 12px;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.9;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .dsp-col-resizer {
      position: absolute;
      top: 0;
      right: -4px;
      width: 8px;
      height: 100%;
      cursor: col-resize;
      z-index: 6;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .dsp-col-resizer::before {
      content: "";
      width: 1px;
      height: calc(100% - 8px);
      background: transparent;
      border-radius: 1px;
      transition: background 0.08s ease;
      pointer-events: none;
    }
    .dsp-col-resizer:hover::before,
    .dsp-col-resizer.active::before {
      background: #8aa7ea;
    }
    .dsp-name-search-btn {
      margin-left: auto;
      width: 16px;
      height: 16px;
      border-radius: 3px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: #6b7280;
      cursor: pointer;
      flex-shrink: 0;
    }
    .dsp-name-search-btn:hover {
      background: #dbe5ff;
      color: #1f4dc5;
    }
    .dsp-name-search-btn.active {
      background: #dbe5ff;
      color: #1f4dc5;
    }
    .dsp-name-search-btn svg {
      width: 13px;
      height: 13px;
      stroke: currentColor;
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .dsp-filter-pop {
      position: fixed;
      min-width: 220px;
      max-width: min(320px, 88vw);
      max-height: min(360px, 70vh);
      background: #fff;
      border: 1px solid #d0d0d0;
      border-radius: 8px;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
      padding: 8px;
      overflow: auto;
      z-index: 5460;
    }
    .dsp-filter-head {
      font-size: 12px;
      font-weight: 600;
      color: #333;
      margin-bottom: 6px;
    }
    .dsp-filter-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: #333;
      padding: 3px 2px;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }
    .dsp-filter-item:hover {
      background: #f3f6ff;
    }
    .dsp-filter-item input {
      width: 13px;
      height: 13px;
      margin: 0;
      accent-color: #2563eb;
      flex-shrink: 0;
    }
    .dsp-name-search-pop {
      position: fixed;
      min-width: 220px;
      max-width: min(340px, 88vw);
      background: #fff;
      border: 1px solid #d0d0d0;
      border-radius: 8px;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
      padding: 8px;
      z-index: 5460;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .dsp-name-search-head {
      font-size: 12px;
      font-weight: 600;
      color: #333;
    }
    .dsp-name-search-input {
      width: 100%;
      height: 28px;
      border: 1px solid #cfcfcf;
      border-radius: 6px;
      padding: 0 8px;
      box-sizing: border-box;
      font-size: 12px;
      color: #111827;
      background: #fff;
    }
    .dsp-name-search-input:focus {
      outline: none;
      border-color: #a7b7e8;
      box-shadow: 0 0 0 2px rgba(167, 183, 232, 0.18);
    }
    .dsp-name-search-foot {
      display: flex;
      justify-content: flex-end;
      align-items: center;
    }
    .dsp-name-search-clear {
      height: 24px;
      padding: 0 8px;
      border: 1px solid #d0d0d0;
      border-radius: 6px;
      background: #f7f7f7;
      color: #333;
      font-size: 12px;
      cursor: pointer;
    }
    .dsp-name-search-clear:hover:not(:disabled) {
      background: #efefef;
    }
    .dsp-name-search-clear:disabled {
      opacity: 0.55;
      cursor: default;
    }
    .dsp-scroll {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      padding: 0 0 8px 0;
      overscroll-behavior: contain;
      background: #fff;
      position: relative;
    }
    .dsp-content {
      min-width: fit-content;
      width: fit-content;
    }
    .dsp-pref-pop {
      position: fixed;
      min-width: 260px;
      background: #fff;
      border: 1px solid #d0d0d0;
      border-radius: 8px;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
      padding: 10px 10px 8px 10px;
      z-index: 5450;
    }
    .dsp-pref-title {
      font-size: 12px;
      font-weight: 600;
      color: #333;
      margin-bottom: 8px;
    }
    .dsp-pref-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 6px 2px;
    }
    .dsp-pref-label {
      font-size: 12px;
      color: #333;
      line-height: 1.3;
      user-select: none;
      cursor: pointer;
      flex: 1 1 auto;
    }
    .dsp-pref-toggle {
      width: 34px;
      height: 20px;
      border-radius: 999px;
      border: 1px solid #cfcfcf;
      background: #ececec;
      position: relative;
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
      transition: background 0.12s ease, border-color 0.12s ease;
      cursor: pointer;
    }
    .dsp-pref-toggle::after {
      content: "";
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
      margin-left: 2px;
      transition: margin-left 0.12s ease;
    }
    .dsp-pref-toggle.on {
      background: #3b82f6;
      border-color: #3b82f6;
    }
    .dsp-pref-toggle.on::after {
      margin-left: 16px;
    }
    .dsp-empty {
      padding: 12px;
      color: #6f6f6f;
      font-size: 13px;
      font-style: italic;
    }
    .dsp-group {
      margin-top: 4px;
    }
    .dsp-group-title {
      position: sticky;
      top: var(--dsp-group-sticky-top, 34px);
      z-index: 1;
      display: grid;
      grid-template-columns: var(--dsp-col-template, 180px 180px 140px 120px 360px);
      align-items: center;
      gap: 0;
      padding: 0;
      background: #f3f4f6;
      border-top: 1px solid #e5e7eb;
      border-bottom: 1px solid #e5e7eb;
      width: fit-content;
      min-width: fit-content;
      cursor: pointer;
      user-select: none;
    }
    .dsp-group-title.collapsed {
      border-bottom: 1px solid #e5e7eb;
    }
    .dsp-group-cell {
      min-width: 0;
      padding: 5px 10px;
      border-right: 1px solid #e3e7eb;
      box-sizing: border-box;
    }
    .dsp-group-cell:last-child {
      border-right: none;
    }
    .dsp-group-main {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 600;
      color: #444;
      min-width: 0;
    }
    .dsp-group-arrow {
      width: 10px;
      height: 10px;
      color: #7b7b7b;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transform: rotate(90deg);
      transition: transform 0.12s ease;
    }
    .dsp-group-arrow svg {
      width: 100%;
      height: 100%;
      fill: currentColor;
    }
    .dsp-group-title.collapsed .dsp-group-arrow {
      transform: rotate(0deg);
    }
    .dsp-group-count {
      min-width: 18px;
      height: 18px;
      border-radius: 999px;
      background: #e2e8f0;
      color: #475569;
      border: 1px solid #cbd5e1;
      font-size: 10px;
      line-height: 1;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 5px;
      box-sizing: border-box;
      flex-shrink: 0;
    }
    .dsp-row {
      display: grid;
      grid-template-columns: var(--dsp-col-template, 180px 180px 140px 120px 360px);
      align-items: stretch;
      gap: 0;
      padding: 0;
      font-size: 12px;
      color: #1f2937;
      cursor: pointer;
      border-bottom: 1px solid #f1f3f5;
    }
    .dsp-row:hover {
      background: #eef3ff;
    }
    .dsp-cell {
      display: inline-flex;
      align-items: center;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      padding: 6px 10px;
      border-right: 1px solid #eceff3;
    }
    .dsp-cell.dsp-cell-name {
      display: block;
      white-space: normal;
      overflow: visible;
      text-overflow: clip;
      line-height: 1.25;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .dsp-cell.dsp-cell-calculated {
      justify-content: center;
    }
    .dsp-cell.dsp-cell-calculated input[type="checkbox"] {
      width: 14px;
      height: 14px;
      margin: 0;
      accent-color: #2563eb;
      pointer-events: none;
      flex-shrink: 0;
    }
    .dsp-cell:last-child { border-right: none; }
    .dsp-status {
      padding: 6px 12px;
      color: #666;
      font-size: 12px;
      font-style: italic;
      border-top: 1px solid #ececec;
      flex-shrink: 0;
    }
  `;
  doc.head.appendChild(style);
}

function getViewportSize(doc) {
  const view = doc?.defaultView || window;
  const width = Number(view?.innerWidth || doc?.documentElement?.clientWidth || 0);
  const height = Number(view?.innerHeight || doc?.documentElement?.clientHeight || 0);
  return {
    width: Number.isFinite(width) && width > 0 ? width : 0,
    height: Number.isFinite(height) && height > 0 ? height : 0,
  };
}

function clampPosition(doc, widthIn, heightIn, leftIn, topIn, options = {}) {
  const viewport = getViewportSize(doc);
  const widthRaw = Number(widthIn);
  const heightRaw = Number(heightIn);
  const leftRaw = Number(leftIn);
  const topRaw = Number(topIn);
  const width = Number.isFinite(widthRaw) && widthRaw > 0 ? widthRaw : 560;
  const height = Number.isFinite(heightRaw) && heightRaw > 0 ? heightRaw : 300;
  const left = Number.isFinite(leftRaw) ? leftRaw : WINDOW_MARGIN_PX;
  const top = Number.isFinite(topRaw) ? topRaw : WINDOW_MARGIN_PX;

  const allowOverflowX = !!options?.allowOverflowX;
  const allowOverflowBottom = !!options?.allowOverflowBottom;

  const minLeft = WINDOW_MARGIN_PX;
  const minTop = WINDOW_MARGIN_PX;
  const maxLeft = viewport.width > 0
    ? Math.max(minLeft, viewport.width - width - WINDOW_MARGIN_PX)
    : minLeft;
  const maxTop = viewport.height > 0
    ? Math.max(minTop, viewport.height - height - WINDOW_MARGIN_PX)
    : minTop;

  return {
    left: allowOverflowX ? left : Math.min(Math.max(minLeft, left), maxLeft),
    top: allowOverflowBottom ? Math.max(minTop, top) : Math.min(Math.max(minTop, top), maxTop),
  };
}

function applyWindowPosition(doc, win, left, top, options = {}) {
  if (!doc || !win) return;
  const rect = typeof win.getBoundingClientRect === "function"
    ? win.getBoundingClientRect()
    : null;
  const width = Number(rect?.width || win.offsetWidth || 0);
  const height = Number(rect?.height || win.offsetHeight || 0);
  const next = clampPosition(doc, width, height, left, top, options);
  win.style.left = `${next.left}px`;
  win.style.top = `${next.top}px`;
  win.style.transform = "none";
}

function refreshPickerWindowMaxSize(doc, win, options = {}) {
  if (!doc || !win) return;
  const view = doc.defaultView || window;
  const viewportW = Number(view?.innerWidth || doc?.documentElement?.clientWidth || 0);
  const viewportH = Number(view?.innerHeight || doc?.documentElement?.clientHeight || 0);
  const margin = WINDOW_MARGIN_PX;

  if (viewportW > 0) {
    win.style.maxWidth = `${Math.max(360, viewportW - (margin * 2))}px`;
  }

  if (viewportH > 0) {
    // Vertical resize max follows host-window height instead of current top position,
    // so pickers opened lower on the page can still be stretched taller.
    win.style.maxHeight = `${Math.max(220, viewportH - (margin * 2))}px`;
  }
}

function clampWindowWithinViewport(doc, win, options = {}) {
  if (!doc || !win) return;
  const rectBefore = typeof win.getBoundingClientRect === "function"
    ? win.getBoundingClientRect()
    : null;
  if (options?.refreshMaxSize) {
    refreshPickerWindowMaxSize(doc, win, { top: Number(rectBefore?.top || 0) });
  }
  const rectAfter = typeof win.getBoundingClientRect === "function"
    ? win.getBoundingClientRect()
    : rectBefore;
  applyWindowPosition(doc, win, Number(rectAfter?.left || 0), Number(rectAfter?.top || 0));
}

function positionWindowBelowAnchor(doc, win, anchorEl) {
  if (!doc || !win || !anchorEl || typeof anchorEl.getBoundingClientRect !== "function") return;
  const view = doc.defaultView || window;
  const viewportW = Number(view?.innerWidth || doc.documentElement?.clientWidth || 0);
  const margin = WINDOW_MARGIN_PX;
  const gap = 8;
  const anchorRect = anchorEl.getBoundingClientRect();
  const winRect = win.getBoundingClientRect();

  let left = Number(anchorRect?.left || 0);
  if (left + winRect.width > viewportW - margin) {
    left = Math.max(margin, viewportW - winRect.width - margin);
  }

  const top = Math.max(margin, Number(anchorRect?.bottom || 0) + gap);
  refreshPickerWindowMaxSize(doc, win, { top });
  applyWindowPosition(doc, win, left, top);
}

function closeDatasetNamePicker(reason = "programmatic") {
  if (!activeDatasetNamePicker) return;
  const {
    doc,
    win,
    onEsc,
    onResize,
    cleanupDrag,
    cleanupPreferences,
    resizeObserver,
    onClose,
  } = activeDatasetNamePicker;

  if (doc && onEsc) doc.removeEventListener("keydown", onEsc, true);
  const view = doc?.defaultView || window;
  if (view && onResize) view.removeEventListener("resize", onResize);
  if (resizeObserver && typeof resizeObserver.disconnect === "function") {
    try { resizeObserver.disconnect(); } catch {}
  }
  if (typeof cleanupDrag === "function") {
    try { cleanupDrag(); } catch {}
  }
  if (typeof cleanupPreferences === "function") {
    try { cleanupPreferences(); } catch {}
  }
  if (win?.parentNode) win.parentNode.removeChild(win);
  activeDatasetNamePicker = null;
  if (typeof onClose === "function") {
    try { onClose(reason); } catch {}
  }
}

function makeDraggable(doc, win, handle) {
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  const onMove = (e) => {
    if (!dragging) return;
    applyWindowPosition(doc, win, e.clientX - offsetX, e.clientY - offsetY, {
      allowOverflowX: true,
      allowOverflowBottom: true,
    });
  };

  const onUp = () => {
    dragging = false;
    doc.removeEventListener("mousemove", onMove);
    doc.removeEventListener("mouseup", onUp);
  };

  const onDown = (e) => {
    if (e.button !== 0) return;
    if (e.target?.closest?.(".dsp-tools")) return;
    const rect = win.getBoundingClientRect();
    const resizeEdge = 16;
    if (e.clientX >= rect.right - resizeEdge && e.clientY >= rect.bottom - resizeEdge) return;
    dragging = true;
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    // Avoid snapping back to viewport bounds on drag start when the window is already partially off-screen.
    win.style.transform = "none";
    doc.addEventListener("mousemove", onMove);
    doc.addEventListener("mouseup", onUp);
    e.preventDefault();
  };

  handle.addEventListener("mousedown", onDown);

  return () => {
    handle.removeEventListener("mousedown", onDown);
    doc.removeEventListener("mousemove", onMove);
    doc.removeEventListener("mouseup", onUp);
  };
}

async function fetchDatasetNameData(projectName) {
  const out = await fetchProjectDatasetTypeItems(projectName, { fetchImpl: fetch });
  return {
    exists: out?.exists !== false,
    sourcePath: toText(out?.sourcePath),
    items: Array.isArray(out?.items) ? out.items : [],
  };
}

async function loadDatasetNameData(options = {}) {
  const projectName = toText(options?.projectName);
  const cacheKey = normalizeKey(projectName);
  const forceReload = !!options?.forceReload;
  if (!projectName) {
    return { projectName: "", sourcePath: "", exists: false, items: [] };
  }
  if (!forceReload && cacheKey && DATASET_NAME_CACHE.has(cacheKey)) {
    return DATASET_NAME_CACHE.get(cacheKey);
  }

  const fetched = await fetchDatasetNameData(projectName);
  const data = {
    projectName,
    sourcePath: fetched.sourcePath,
    exists: fetched.exists,
    items: fetched.items,
  };
  if (cacheKey) DATASET_NAME_CACHE.set(cacheKey, data);
  return data;
}

function getMeasureFont(doc) {
  const bodyStyle = doc?.defaultView?.getComputedStyle
    ? doc.defaultView.getComputedStyle(doc.body || doc.documentElement)
    : null;
  const fontSize = toText(bodyStyle?.fontSize) || "12px";
  const fontFamily = toText(bodyStyle?.fontFamily) || "Arial, sans-serif";
  const fontWeight = toText(bodyStyle?.fontWeight) || "400";
  return `${fontWeight} ${fontSize} ${fontFamily}`;
}

function measureTextWidth(doc, text, font) {
  const raw = toText(text);
  if (!raw) return 0;
  let canvas = measureTextWidth._canvas;
  if (!canvas) {
    canvas = doc.createElement("canvas");
    measureTextWidth._canvas = canvas;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return raw.length * 7;
  ctx.font = font;
  const measured = Number(ctx.measureText(raw).width || 0);
  return Number.isFinite(measured) ? measured : (raw.length * 7);
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function pickMeasuredWidth(widths, quantile = 1) {
  const safe = Array.isArray(widths)
    ? widths.filter((v) => Number.isFinite(v) && v > 0)
    : [];
  if (!safe.length) return 0;
  safe.sort((a, b) => a - b);
  const q = clampNumber(quantile, 0, 1);
  const idx = Math.min(safe.length - 1, Math.max(0, Math.floor((safe.length - 1) * q)));
  return safe[idx];
}

const PICKER_TABLE_COLUMNS = [
  { key: "name", label: "Name", min: 30, max: 300, quantile: 0.9, headerChrome: 40 },
  { key: "dataFormat", label: "Data Format", min: 30, max: 160, quantile: 0.95, headerChrome: 40 },
  { key: "category", label: "Category", min: 30, max: 160, quantile: 0.95, headerChrome: 40 },
  { key: "calculated", label: "Calculated", min: 30, max: 150, quantile: 1, headerChrome: 46 },
  { key: "formula", label: "Formula", min: 30, max: 720, quantile: 0.95, headerChrome: 18 },
];

function buildColumnTemplateFromWidths(widths) {
  const list = Array.isArray(widths) ? widths : [];
  if (!list.length) return "";
  return list.map((value) => `${Math.max(1, Math.round(Number(value) || 0))}px`).join(" ");
}

function parseColumnTemplatePx(template) {
  const raw = String(template || "").trim();
  if (!raw) return [];
  const out = raw
    .split(/\s+/g)
    .map((token) => {
      const m = String(token || "").match(/^(-?\d+(?:\.\d+)?)px$/i);
      return m ? Number(m[1]) : NaN;
    })
    .filter((v) => Number.isFinite(v) && v > 0);
  return out;
}

function computeColumnTemplate(doc, items) {
  const safeItems = Array.isArray(items) ? items : [];
  const font = getMeasureFont(doc);
  const columns = PICKER_TABLE_COLUMNS;

  const pxValues = columns.map((col) => {
    const measured = [measureTextWidth(doc, col.label, font)];
    for (const item of safeItems) {
      const value = col.key === "calculated"
        ? getDatasetTypeCalculatedLabel(item?.calculated)
        : toText(item?.[col.key]);
      if (!value) continue;
      measured.push(measureTextWidth(doc, value, font));
    }
    const picked = pickMeasuredWidth(measured, Number.isFinite(col.quantile) ? col.quantile : 1);
    const headerChrome = Number.isFinite(col.headerChrome) ? col.headerChrome : 0;
    return Math.ceil(clampNumber(picked + 20 + headerChrome, col.min, col.max));
  });

  return `${pxValues[0]}px ${pxValues[1]}px ${pxValues[2]}px ${pxValues[3]}px ${pxValues[4]}px`;
}

function getSortIndicatorSvg(sortDir = "asc") {
  if (String(sortDir || "").toLowerCase() === "desc") {
    return '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 11.75L3.5 5.25h9z"></path></svg>';
  }
  return '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 4.25l4.5 6.5h-9z"></path></svg>';
}

function renderTableBody(container, state, callbacks) {
  if (!container) return;
  container.innerHTML = "";

  const sourceItems = Array.isArray(state?.items) ? state.items : [];
  const items = sourceItems.filter((item) => {
    if (!isDatasetTypeDataFormatVisible(item?.dataFormat, state?.selectedDataFormatKeys, { blankKey: "__blank__" })) {
      return false;
    }
    if (!isDatasetTypeCategoryVisible(item?.category, state?.selectedCategoryKeys)) return false;
    if (!isDatasetTypeCalculatedVisible(item?.calculated, state?.selectedCalculatedKeys)) return false;
    if (!matchesDatasetTypeNameSearch(item, state?.nameSearchText || "")) return false;
    return true;
  });
  if (!items.length) {
    const empty = container.ownerDocument.createElement("div");
    empty.className = "dsp-empty";
    empty.textContent = "No dataset names match current filter.";
    container.appendChild(empty);
    return;
  }

  const doc = container.ownerDocument;
  const grouped = groupDatasetTypeItemsByCategory(items);
  const categories = Array.from(grouped.keys()).sort((a, b) =>
    String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base", numeric: true }),
  );
  if (state.sortKey === "category" && state.sortDir === "desc") categories.reverse();

  for (const category of categories) {
    const groupEl = doc.createElement("section");
    groupEl.className = "dsp-group";

    const groupTitle = doc.createElement("div");
    groupTitle.className = "dsp-group-title";
    const categoryKey = normalizeKey(category || "Uncategorized");
    const isCollapsed = !!(state?.collapsedCategoryKeys instanceof Set && state.collapsedCategoryKeys.has(categoryKey));
    if (isCollapsed) groupTitle.classList.add("collapsed");
    const count = Array.isArray(grouped.get(category)) ? grouped.get(category).length : 0;

    const firstCell = doc.createElement("div");
    firstCell.className = "dsp-group-cell";
    const mainWrap = doc.createElement("span");
    mainWrap.className = "dsp-group-main";
    const arrow = doc.createElement("span");
    arrow.className = "dsp-group-arrow";
    arrow.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/></svg>';
    const groupText = doc.createElement("span");
    groupText.textContent = String(category || "");
    const groupCount = doc.createElement("span");
    groupCount.className = "dsp-group-count";
    groupCount.textContent = String(count);
    mainWrap.appendChild(arrow);
    mainWrap.appendChild(groupText);
    mainWrap.appendChild(groupCount);
    firstCell.appendChild(mainWrap);
    groupTitle.appendChild(firstCell);

    for (let i = 0; i < 4; i++) {
      const emptyCell = doc.createElement("div");
      emptyCell.className = "dsp-group-cell";
      emptyCell.setAttribute("aria-hidden", "true");
      groupTitle.appendChild(emptyCell);
    }
    groupTitle.addEventListener("click", () => {
      if (typeof callbacks?.onToggleGroup === "function") {
        callbacks.onToggleGroup(category);
      }
    });
    groupEl.appendChild(groupTitle);

    const sortKey = state.sortKey === "category" ? "name" : state.sortKey;
    const sortDir = state.sortDir === "desc" ? -1 : 1;
    const rows = [...(grouped.get(category) || [])]
      .sort((a, b) => compareDatasetTypeItems(a, b, sortKey) * sortDir);

    if (isCollapsed) {
      container.appendChild(groupEl);
      continue;
    }

    rows.forEach((item) => {
      const row = doc.createElement("div");
      row.className = "dsp-row";
      const useDoubleClick = !!state?.prefs?.doubleClickToSelect;
      row.title = useDoubleClick
        ? "Double click to select this dataset name"
        : "Click to select this dataset name";

      const nameCell = doc.createElement("span");
      nameCell.className = "dsp-cell dsp-cell-name";
      nameCell.textContent = toText(item?.name);
      nameCell.title = toText(item?.name);
      row.appendChild(nameCell);

      const formatCell = doc.createElement("span");
      formatCell.className = "dsp-cell";
      formatCell.textContent = toText(item?.dataFormat);
      formatCell.title = toText(item?.dataFormat);
      row.appendChild(formatCell);

      const categoryCell = doc.createElement("span");
      categoryCell.className = "dsp-cell";
      categoryCell.textContent = toText(item?.category);
      categoryCell.title = toText(item?.category);
      row.appendChild(categoryCell);

      const calculatedCell = doc.createElement("span");
      calculatedCell.className = "dsp-cell dsp-cell-calculated";
      calculatedCell.title = getDatasetTypeCalculatedLabel(item?.calculated);
      const calculatedChk = doc.createElement("input");
      calculatedChk.type = "checkbox";
      calculatedChk.checked = !!parseDatasetTypesCalculatedFlag(item?.calculated);
      calculatedChk.disabled = true;
      calculatedChk.setAttribute("aria-label", getDatasetTypeCalculatedLabel(item?.calculated));
      calculatedCell.appendChild(calculatedChk);
      row.appendChild(calculatedCell);

      const formulaCell = doc.createElement("span");
      formulaCell.className = "dsp-cell";
      formulaCell.textContent = toText(item?.formula);
      formulaCell.title = toText(item?.formula);
      row.appendChild(formulaCell);

      row.addEventListener("click", () => {
        if (typeof callbacks?.onRowClick === "function") {
          callbacks.onRowClick(item);
        } else if (typeof callbacks?.onSelect === "function") {
          callbacks.onSelect(item);
        }
      });
      row.addEventListener("dblclick", () => {
        if (typeof callbacks?.onRowDoubleClick === "function") {
          callbacks.onRowDoubleClick(item);
        }
      });

      groupEl.appendChild(row);
    });

    container.appendChild(groupEl);
  }
}

function updateHeaderButtons(headEl, state) {
  if (!headEl) return;
  const buttons = headEl.querySelectorAll(".dsp-head-btn");
  buttons.forEach((btn) => {
    const key = btn.dataset?.key || "";
    const active = key === state.sortKey;
    btn.classList.toggle("active", active);
    const indicator = btn.querySelector(".dsp-sort-ind");
    if (indicator) {
      indicator.innerHTML = active ? getSortIndicatorSvg(state.sortDir) : "";
    }
    if (key === "category") {
      const filterBtn = btn.querySelector(".dsp-filter-btn");
      if (filterBtn) {
        filterBtn.classList.toggle(
          "active",
          isDatasetTypeCategoryFilterActive(state?.categoryOptions, state?.selectedCategoryKeys),
        );
      }
    }
    if (key === "dataFormat") {
      const filterBtn = btn.querySelector(".dsp-filter-btn");
      if (filterBtn) {
        filterBtn.classList.toggle(
          "active",
          isDatasetTypeSelectionFilterActive(state?.dataFormatOptions, state?.selectedDataFormatKeys),
        );
      }
    }
    if (key === "calculated") {
      const filterBtn = btn.querySelector(".dsp-filter-btn");
      if (filterBtn) {
        filterBtn.classList.toggle(
          "active",
          isDatasetTypeSelectionFilterActive(state?.calculatedOptions, state?.selectedCalculatedKeys),
        );
      }
    }
    if (key === "name") {
      const searchBtn = btn.querySelector(".dsp-name-search-btn");
      if (searchBtn) {
        const hasSearch = tokenizeDatasetTypeNameSearch(state?.nameSearchText || "").length > 0;
        searchBtn.classList.toggle("active", !!state?.nameSearchOpen || hasSearch);
      }
    }
  });
}

function createHeader(headEl, state, handlers = {}) {
  if (!headEl) return;
  const doc = headEl.ownerDocument;
  const cols = PICKER_TABLE_COLUMNS.map((col) => ({ key: col.key, label: col.label }));

  cols.forEach((col, colIdx) => {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "dsp-head-btn";
    btn.dataset.key = col.key;
    const text = doc.createElement("span");
    text.className = "dsp-head-text";
    text.textContent = col.label;
    btn.appendChild(text);

    const sortInd = doc.createElement("span");
    sortInd.className = "dsp-sort-ind";
    btn.appendChild(sortInd);

    if ((col.key === "category" || col.key === "dataFormat" || col.key === "calculated") && typeof handlers?.onColumnFilterClick === "function") {
      const filterBtn = doc.createElement("span");
      filterBtn.className = "dsp-filter-btn";
      filterBtn.setAttribute("role", "button");
      filterBtn.setAttribute("tabindex", "0");
      const filterLabel = col.key === "category"
        ? "Filter categories"
        : (col.key === "dataFormat" ? "Filter data formats" : "Filter calculated values");
      filterBtn.title = filterLabel;
      filterBtn.setAttribute("aria-label", filterLabel);
      filterBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v5l-4 2v-7L3 5z"/></svg>';
      filterBtn.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        handlers.onColumnFilterClick(col.key, filterBtn);
      });
      filterBtn.addEventListener("keydown", (evt) => {
        if (evt.key !== "Enter" && evt.key !== " ") return;
        evt.preventDefault();
        evt.stopPropagation();
        handlers.onColumnFilterClick(col.key, filterBtn);
      });
      btn.appendChild(filterBtn);
    }

    if (col.key === "name" && typeof handlers?.onNameSearchClick === "function") {
      const searchBtn = doc.createElement("span");
      searchBtn.className = "dsp-name-search-btn";
      searchBtn.setAttribute("role", "button");
      searchBtn.setAttribute("tabindex", "0");
      searchBtn.title = "Search names";
      searchBtn.setAttribute("aria-label", "Search names");
      searchBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5"></circle><path d="M15 15l4.5 4.5"></path></svg>';
      searchBtn.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        handlers.onNameSearchClick(searchBtn);
      });
      searchBtn.addEventListener("keydown", (evt) => {
        if (evt.key !== "Enter" && evt.key !== " ") return;
        evt.preventDefault();
        evt.stopPropagation();
        handlers.onNameSearchClick(searchBtn);
      });
      btn.appendChild(searchBtn);
    }

    if (colIdx < (cols.length - 1) && typeof handlers?.onColumnResizeStart === "function") {
      const resizer = doc.createElement("span");
      resizer.className = "dsp-col-resizer";
      resizer.setAttribute("role", "separator");
      resizer.setAttribute("aria-orientation", "vertical");
      resizer.title = `Resize ${col.label} column`;
      resizer.addEventListener("mousedown", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        handlers.onColumnResizeStart(colIdx, evt, resizer);
      });
      resizer.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
      });
      btn.appendChild(resizer);
    }

    btn.addEventListener("click", () => {
      if (typeof handlers?.onSortChange === "function") {
        handlers.onSortChange(col.key);
      }
    });
    headEl.appendChild(btn);
  });

  updateHeaderButtons(headEl, state);
}

export function clearDatasetNamePickerCache(projectName = "") {
  const key = normalizeKey(projectName);
  if (key) {
    DATASET_NAME_CACHE.delete(key);
    return;
  }
  DATASET_NAME_CACHE = new Map();
}

export async function openDatasetNamePicker(options = {}) {
  const setStatus = typeof options?.setStatus === "function" ? options.setStatus : () => {};
  const projectName = toText(options?.projectName);
  const initialName = toText(options?.initialName);
  const title = toText(options?.title) || "Select a Dataset Name";
  const emptyMessage = toText(options?.emptyMessage);
  const onSelect = typeof options?.onSelect === "function" ? options.onSelect : null;
  const onClose = typeof options?.onClose === "function" ? options.onClose : null;
  const onError = typeof options?.onError === "function" ? options.onError : null;
  const savedPrefs = await loadPickerPrefs(projectName);
  const initialPrefs = {
    doubleClickToSelect: typeof options?.doubleClickToSelect === "boolean"
      ? options.doubleClickToSelect
      : savedPrefs.doubleClickToSelect,
    closeAfterSelection: typeof options?.closeAfterSelection === "boolean"
      ? options.closeAfterSelection
      : (typeof options?.autoCloseOnSelect === "boolean"
        ? options.autoCloseOnSelect
        : savedPrefs.closeAfterSelection),
  };
  const doc = options?.document || window.document;
  const anchorElement = options?.anchorElement || null;

  if (!projectName) {
    setStatus("Select a project first.");
    return { ok: false, reason: "project_missing" };
  }

  try {
    const data = await loadDatasetNameData({
      projectName,
      forceReload: !!options?.forceReload,
    });

    const filteredItems = filterDatasetTypeItems(data?.items, options);

    if (!Array.isArray(filteredItems) || !filteredItems.length) {
      setStatus(data?.exists === false
        ? `dataset_types.json not found for project "${projectName}".`
        : (emptyMessage || "No dataset names found."));
      return { ok: false, reason: "empty", data: { ...data, items: filteredItems } };
    }

    closeDatasetNamePicker("replaced");
    ensureStyles(doc);

    const win = doc.createElement("div");
    win.className = "dsp-window";

    const titlebar = doc.createElement("div");
    titlebar.className = "dsp-titlebar";
    const titleEl = doc.createElement("div");
    titleEl.className = "dsp-title";
    titleEl.textContent = title;
    titlebar.appendChild(titleEl);

    const tools = doc.createElement("div");
    tools.className = "dsp-tools";

    const collapseAllBtn = doc.createElement("button");
    collapseAllBtn.type = "button";
    collapseAllBtn.className = "dsp-toolbtn";
    collapseAllBtn.title = "Collapse or expand all category groups";
    collapseAllBtn.setAttribute("aria-label", "Collapse or expand all category groups");
    collapseAllBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h8"></path><path d="M3.5 12h8"></path><path d="M3.5 17.5h8"></path><path d="M14.5 10l3-3 3 3"></path><path d="M14.5 16l3-3 3 3"></path></svg>';
    tools.appendChild(collapseAllBtn);

    const clearFiltersBtn = doc.createElement("button");
    clearFiltersBtn.type = "button";
    clearFiltersBtn.className = "dsp-toolbtn";
    clearFiltersBtn.title = "Clear all filters";
    clearFiltersBtn.setAttribute("aria-label", "Clear all filters");
    clearFiltersBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v5l-4 2v-7L3 5z"></path><path d="M16.5 7.5l4 4"></path><path d="M20.5 7.5l-4 4"></path></svg>';
    tools.appendChild(clearFiltersBtn);

    const prefBtn = doc.createElement("button");
    prefBtn.type = "button";
    prefBtn.className = "dsp-toolbtn";
    prefBtn.title = "Preferences";
    prefBtn.setAttribute("aria-label", "Preferences");
    prefBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.58.23-1.13.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.7 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.82 14.52a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.4 1.05.71 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.23 1.13-.54 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58z"/><circle cx="12" cy="12" r="3.5"/></svg>';
    tools.appendChild(prefBtn);

    const closeBtn = doc.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "dsp-close";
    closeBtn.title = "Close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
    closeBtn.addEventListener("click", () => closeDatasetNamePicker("close_button"));
    tools.appendChild(closeBtn);
    titlebar.appendChild(tools);
    win.appendChild(titlebar);

    const body = doc.createElement("div");
    body.className = "dsp-body";

    const scroll = doc.createElement("div");
    scroll.className = "dsp-scroll";
    const head = doc.createElement("div");
    head.className = "dsp-table-head";
    const content = doc.createElement("div");
    content.className = "dsp-content";
    scroll.appendChild(head);
    scroll.appendChild(content);
    body.appendChild(scroll);

    const status = doc.createElement("div");
    status.className = "dsp-status";
    status.textContent = `Project: ${projectName}`;
    body.appendChild(status);

    win.appendChild(body);
    doc.body.appendChild(win);

    const initialViewport = getViewportSize(doc);
    if (initialViewport.height > 0) {
      const targetHeight = Math.max(260, Math.round((initialViewport.height * 2) / 3));
      win.style.height = `${targetHeight}px`;
    }

    const state = {
      items: filteredItems,
      sortKey: "name",
      sortDir: "asc",
      initialName: normalizeKey(initialName),
      nameSearchText: "",
      nameSearchOpen: false,
      dataFormatOptions: [],
      selectedDataFormatKeys: new Set(),
      categoryOptions: [],
      selectedCategoryKeys: new Set(),
      calculatedOptions: [],
      selectedCalculatedKeys: new Set(),
      collapsedCategoryKeys: new Set(),
      prefs: {
        doubleClickToSelect: !!initialPrefs.doubleClickToSelect,
        closeAfterSelection: !!initialPrefs.closeAfterSelection,
      },
      columnWidths: [],
    };
    state.dataFormatOptions = buildDatasetTypeDataFormatOptions(state.items, { blankKey: "__blank__" });
    state.selectedDataFormatKeys = new Set();
    state.categoryOptions = buildDatasetTypeCategoryOptions(state.items);
    state.selectedCategoryKeys = new Set();
    state.calculatedOptions = buildDatasetTypeCalculatedOptions(state.items);
    state.selectedCalculatedKeys = new Set();
    const columnTemplate = computeColumnTemplate(doc, state.items);
    state.columnWidths = parseColumnTemplatePx(columnTemplate);
    const initialTemplate = state.columnWidths.length === PICKER_TABLE_COLUMNS.length
      ? buildColumnTemplateFromWidths(state.columnWidths)
      : columnTemplate;
    win.style.setProperty("--dsp-col-template", initialTemplate);

    const doSelect = (item) => {
      const name = toText(item?.name);
      if (!name) return;
      if (onSelect) onSelect(name, item);
      if (state.prefs.closeAfterSelection) {
        closeDatasetNamePicker("select");
      }
    };

    const rerender = () => {
      const hasAnyNameSearch = tokenizeDatasetTypeNameSearch(state?.nameSearchText || "").length > 0;
      const hasAnyColumnFilter =
        isDatasetTypeSelectionFilterActive(state?.dataFormatOptions, state?.selectedDataFormatKeys)
        || isDatasetTypeSelectionFilterActive(state?.categoryOptions, state?.selectedCategoryKeys)
        || isDatasetTypeSelectionFilterActive(state?.calculatedOptions, state?.selectedCalculatedKeys);
      clearFiltersBtn.classList.toggle("active", hasAnyNameSearch || hasAnyColumnFilter);

      const allCategoryKeys = Array.from(groupDatasetTypeItemsByCategory(state?.items || []).keys())
        .map((category) => normalizeKey(category || "Uncategorized"))
        .filter(Boolean);
      const allCollapsed = allCategoryKeys.length > 0
        && allCategoryKeys.every((key) => state.collapsedCategoryKeys.has(key));
      collapseAllBtn.classList.toggle("active", allCollapsed);

      updateHeaderButtons(head, state);
      renderTableBody(content, state, {
        onRowClick: (item) => {
          if (state.prefs.doubleClickToSelect) return;
          doSelect(item);
        },
        onRowDoubleClick: (item) => {
          if (!state.prefs.doubleClickToSelect) return;
          doSelect(item);
        },
        onToggleGroup: (category) => {
          const key = normalizeKey(category || "Uncategorized");
          if (state.collapsedCategoryKeys.has(key)) state.collapsedCategoryKeys.delete(key);
          else state.collapsedCategoryKeys.add(key);
          rerender();
        },
      });
      const headHeight = Number(head.getBoundingClientRect()?.height || head.offsetHeight || 34);
      win.style.setProperty("--dsp-group-sticky-top", `${Math.max(30, Math.round(headHeight))}px`);
      if (!state.initialName) return;
      const target = Array.from(content.querySelectorAll(".dsp-row")).find((row) => {
        const firstCell = row.querySelector(".dsp-cell");
        return normalizeKey(firstCell?.textContent || "") === state.initialName;
      });
      if (target && typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ block: "nearest" });
      }
      state.initialName = "";
    };

    let prefPopup = null;
    let onPrefMouseDown = null;
    let nameSearchPopup = null;
    let onNameSearchMouseDown = null;
    let nameSearchAnchor = null;
    let categoryFilterPopup = null;
    let onCategoryFilterMouseDown = null;
    let categoryFilterAnchor = null;
    let categoryFilterColumnKey = "category";
    let onColumnResizeMouseMove = null;
    let onColumnResizeMouseUp = null;
    let activeColumnResizerEl = null;

    const setPref = (key, value) => {
      state.prefs[key] = !!value;
      schedulePickerPrefsSave(projectName, state.prefs);
      rerender();
    };

    const applyCurrentColumnWidths = () => {
      if (!Array.isArray(state.columnWidths) || state.columnWidths.length !== PICKER_TABLE_COLUMNS.length) return;
      win.style.setProperty("--dsp-col-template", buildColumnTemplateFromWidths(state.columnWidths));
    };

    const stopColumnResize = () => {
      if (activeColumnResizerEl) activeColumnResizerEl.classList.remove("active");
      activeColumnResizerEl = null;
      if (onColumnResizeMouseMove) {
        doc.removeEventListener("mousemove", onColumnResizeMouseMove, true);
        onColumnResizeMouseMove = null;
      }
      if (onColumnResizeMouseUp) {
        doc.removeEventListener("mouseup", onColumnResizeMouseUp, true);
        onColumnResizeMouseUp = null;
      }
    };

    const beginColumnResize = (colIdx, startEvt, resizerEl) => {
      const widths = Array.isArray(state.columnWidths) ? state.columnWidths : [];
      const lastIdx = widths.length - 1;
      if (!widths.length || lastIdx <= 0) return;
      if (!Number.isInteger(colIdx) || colIdx < 0 || colIdx >= lastIdx) return;

      stopColumnResize();
      activeColumnResizerEl = resizerEl || null;
      if (activeColumnResizerEl) activeColumnResizerEl.classList.add("active");

      const startX = Number(startEvt?.clientX || 0);
      const startWidths = widths.slice();
      const leftSpec = PICKER_TABLE_COLUMNS[colIdx] || {};
      const lastSpec = PICKER_TABLE_COLUMNS[lastIdx] || {};
      const leftMin = Math.max(1, Number(leftSpec?.min || 30));
      const lastMin = Math.max(1, Number(lastSpec?.min || 30));
      const leftMax = Number.isFinite(Number(leftSpec?.max)) ? Number(leftSpec.max) : Infinity;

      onColumnResizeMouseMove = (moveEvt) => {
        const deltaRaw = Number(moveEvt?.clientX || 0) - startX;
        if (!Number.isFinite(deltaRaw)) return;
        let delta = deltaRaw;
        delta = Math.max(delta, leftMin - startWidths[colIdx]);
        delta = Math.min(delta, startWidths[lastIdx] - lastMin);
        if (Number.isFinite(leftMax)) delta = Math.min(delta, leftMax - startWidths[colIdx]);

        const next = startWidths.slice();
        const nextLeft = Math.max(leftMin, Math.round(startWidths[colIdx] + delta));
        next[colIdx] = nextLeft;
        next[lastIdx] = Math.max(lastMin, Math.round(startWidths[lastIdx] - (nextLeft - startWidths[colIdx])));
        state.columnWidths = next;
        applyCurrentColumnWidths();
        moveEvt.preventDefault();
        moveEvt.stopPropagation();
      };

      onColumnResizeMouseUp = (upEvt) => {
        upEvt.preventDefault();
        upEvt.stopPropagation();
        stopColumnResize();
      };

      doc.addEventListener("mousemove", onColumnResizeMouseMove, true);
      doc.addEventListener("mouseup", onColumnResizeMouseUp, true);
    };

    const positionPrefPopup = (popup) => {
      if (!popup) return;
      const btnRect = prefBtn.getBoundingClientRect();
      const popRect = popup.getBoundingClientRect();
      const viewport = getViewportSize(doc);
      const margin = WINDOW_MARGIN_PX;

      let left = btnRect.right - popRect.width;
      let top = btnRect.bottom + 6;
      if (left < margin) left = margin;
      if (left + popRect.width > viewport.width - margin) {
        left = Math.max(margin, viewport.width - popRect.width - margin);
      }
      if (top + popRect.height > viewport.height - margin) {
        top = Math.max(margin, btnRect.top - popRect.height - 6);
      }
      popup.style.left = `${Math.round(left)}px`;
      popup.style.top = `${Math.round(top)}px`;
    };

    const closePrefPopup = () => {
      if (onPrefMouseDown) {
        doc.removeEventListener("mousedown", onPrefMouseDown, true);
        onPrefMouseDown = null;
      }
      if (prefPopup?.parentNode) prefPopup.parentNode.removeChild(prefPopup);
      prefPopup = null;
      prefBtn.classList.remove("active");
    };

    const closeNameSearchPopup = () => {
      state.nameSearchOpen = false;
      if (onNameSearchMouseDown) {
        doc.removeEventListener("mousedown", onNameSearchMouseDown, true);
        onNameSearchMouseDown = null;
      }
      if (nameSearchPopup?.parentNode) nameSearchPopup.parentNode.removeChild(nameSearchPopup);
      nameSearchPopup = null;
      nameSearchAnchor = null;
      updateHeaderButtons(head, state);
    };

    const closeCategoryFilterPopup = () => {
      if (onCategoryFilterMouseDown) {
        doc.removeEventListener("mousedown", onCategoryFilterMouseDown, true);
        onCategoryFilterMouseDown = null;
      }
      if (categoryFilterPopup?.parentNode) categoryFilterPopup.parentNode.removeChild(categoryFilterPopup);
      categoryFilterPopup = null;
      categoryFilterAnchor = null;
      categoryFilterColumnKey = "category";
    };

    const positionCategoryFilterPopup = (popup, anchorEl) => {
      if (!popup || !anchorEl) return;
      const margin = WINDOW_MARGIN_PX;
      const anchorRect = anchorEl.getBoundingClientRect();
      const popRect = popup.getBoundingClientRect();
      const viewport = getViewportSize(doc);

      let left = anchorRect.left;
      let top = anchorRect.bottom + 6;
      if (left + popRect.width > viewport.width - margin) {
        left = Math.max(margin, viewport.width - popRect.width - margin);
      }
      if (top + popRect.height > viewport.height - margin) {
        top = Math.max(margin, anchorRect.top - popRect.height - 6);
      }
      popup.style.left = `${Math.round(left)}px`;
      popup.style.top = `${Math.round(top)}px`;
    };

    const positionNameSearchPopup = (popup, anchorEl) => {
      if (!popup || !anchorEl) return;
      const margin = WINDOW_MARGIN_PX;
      const anchorRect = anchorEl.getBoundingClientRect();
      const popRect = popup.getBoundingClientRect();
      const viewport = getViewportSize(doc);

      let left = anchorRect.left;
      let top = anchorRect.bottom + 6;
      if (left + popRect.width > viewport.width - margin) {
        left = Math.max(margin, viewport.width - popRect.width - margin);
      }
      if (top + popRect.height > viewport.height - margin) {
        top = Math.max(margin, anchorRect.top - popRect.height - 6);
      }
      popup.style.left = `${Math.round(left)}px`;
      popup.style.top = `${Math.round(top)}px`;
    };

    const getPickerColumnFilterMeta = (colKey) => {
      const key = String(colKey || "").trim();
      if (key === "dataFormat") {
        return {
          title: "Data Format Filter",
          options: Array.isArray(state.dataFormatOptions) ? state.dataFormatOptions : [],
          getSelectedKeys: () => (state.selectedDataFormatKeys instanceof Set ? state.selectedDataFormatKeys : new Set()),
          setSelectedKeys: (next) => {
            state.selectedDataFormatKeys = next instanceof Set ? next : new Set();
          },
        };
      }
      if (key === "calculated") {
        return {
          title: "Calculated Filter",
          options: Array.isArray(state.calculatedOptions) ? state.calculatedOptions : [],
          getSelectedKeys: () => (state.selectedCalculatedKeys instanceof Set ? state.selectedCalculatedKeys : new Set()),
          setSelectedKeys: (next) => {
            state.selectedCalculatedKeys = next instanceof Set ? next : new Set();
          },
        };
      }
      return {
        title: "Category Filter",
        options: Array.isArray(state.categoryOptions) ? state.categoryOptions : [],
        getSelectedKeys: () => (state.selectedCategoryKeys instanceof Set ? state.selectedCategoryKeys : new Set()),
        setSelectedKeys: (next) => {
          state.selectedCategoryKeys = next instanceof Set ? next : new Set();
        },
      };
    };

    const buildCategoryFilterPopup = () => {
      if (!categoryFilterPopup) return;
      categoryFilterPopup.innerHTML = "";
      const meta = getPickerColumnFilterMeta(categoryFilterColumnKey);
      const options = Array.isArray(meta?.options) ? meta.options : [];
      const selectedKeys = meta?.getSelectedKeys instanceof Function ? meta.getSelectedKeys() : new Set();

      const title = doc.createElement("div");
      title.className = "dsp-filter-head";
      title.textContent = String(meta?.title || "Filter");
      categoryFilterPopup.appendChild(title);

      const allItem = doc.createElement("label");
      allItem.className = "dsp-filter-item";
      const allChk = doc.createElement("input");
      allChk.type = "checkbox";
      const optionCount = options.length;
      const selectedCount = selectedKeys.size;
      allChk.checked = selectedCount === 0;
      allChk.indeterminate = selectedCount > 0 && selectedCount < optionCount;
      const allText = doc.createElement("span");
      allText.textContent = "(All)";
      allItem.appendChild(allChk);
      allItem.appendChild(allText);
      allChk.addEventListener("change", () => {
        // "(All)" means no filter is applied, represented by an empty set.
        meta.setSelectedKeys(new Set());
        rerender();
        buildCategoryFilterPopup();
      });
      categoryFilterPopup.appendChild(allItem);

      options.forEach((opt) => {
        const row = doc.createElement("label");
        row.className = "dsp-filter-item";
        const chk = doc.createElement("input");
        chk.type = "checkbox";
        chk.checked = selectedKeys.has(opt.key);
        row.addEventListener("contextmenu", (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          const allKeys = options.map((item) => item.key);
          const current = meta.getSelectedKeys();
          const nextSelected = new Set();
          for (const key of allKeys) {
            if (!current.has(key)) nextSelected.add(key);
          }
          meta.setSelectedKeys(nextSelected);
          rerender();
          buildCategoryFilterPopup();
        });
        const text = doc.createElement("span");
        text.textContent = String(opt.label || "");
        row.appendChild(chk);
        row.appendChild(text);
        chk.addEventListener("change", () => {
          const nextSelected = new Set(meta.getSelectedKeys());
          if (chk.checked) nextSelected.add(opt.key);
          else nextSelected.delete(opt.key);
          meta.setSelectedKeys(nextSelected);
          rerender();
          buildCategoryFilterPopup();
        });
        categoryFilterPopup.appendChild(row);
      });
    };

    const openCategoryFilterPopup = (colKey, anchorEl) => {
      if (!anchorEl) return;
      const nextColKey = String(colKey || "category").trim() || "category";
      if (categoryFilterPopup && categoryFilterAnchor === anchorEl && categoryFilterColumnKey === nextColKey) {
        closeCategoryFilterPopup();
        return;
      }
      closeCategoryFilterPopup();
      closeNameSearchPopup();
      closePrefPopup();

      const popup = doc.createElement("div");
      popup.className = "dsp-filter-pop";
      popup.addEventListener("mousedown", (evt) => evt.stopPropagation());
      popup.addEventListener("click", (evt) => evt.stopPropagation());
      doc.body.appendChild(popup);

      categoryFilterPopup = popup;
      categoryFilterAnchor = anchorEl;
      categoryFilterColumnKey = nextColKey;
      buildCategoryFilterPopup();
      positionCategoryFilterPopup(popup, anchorEl);

      onCategoryFilterMouseDown = (evt) => {
        const t = evt.target;
        if (categoryFilterPopup && categoryFilterPopup.contains(t)) return;
        if (categoryFilterAnchor && categoryFilterAnchor.contains(t)) return;
        closeCategoryFilterPopup();
      };
      doc.addEventListener("mousedown", onCategoryFilterMouseDown, true);
    };

    const buildNameSearchPopup = () => {
      if (!nameSearchPopup) return;
      nameSearchPopup.innerHTML = "";

      const title = doc.createElement("div");
      title.className = "dsp-name-search-head";
      title.textContent = "Name Search";
      nameSearchPopup.appendChild(title);

      const input = doc.createElement("input");
      input.type = "text";
      input.className = "dsp-name-search-input";
      input.placeholder = "keyword(s)";
      input.value = toText(state.nameSearchText);
      input.addEventListener("mousedown", (evt) => evt.stopPropagation());
      input.addEventListener("click", (evt) => evt.stopPropagation());
      input.addEventListener("keydown", (evt) => {
        evt.stopPropagation();
        if (evt.key === "Escape") {
          evt.preventDefault();
          closeNameSearchPopup();
          return;
        }
        if (evt.key === "Enter") {
          evt.preventDefault();
          closeNameSearchPopup();
        }
      });
      input.addEventListener("input", () => {
        state.nameSearchText = input.value;
        rerender();
        clearBtn.disabled = !toText(state.nameSearchText);
      });
      nameSearchPopup.appendChild(input);

      const footer = doc.createElement("div");
      footer.className = "dsp-name-search-foot";
      const clearBtn = doc.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "dsp-name-search-clear";
      clearBtn.textContent = "Clear";
      clearBtn.disabled = !toText(state.nameSearchText);
      clearBtn.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        state.nameSearchText = "";
        input.value = "";
        clearBtn.disabled = true;
        rerender();
      });
      footer.appendChild(clearBtn);
      nameSearchPopup.appendChild(footer);

      setTimeout(() => {
        try {
          input.focus({ preventScroll: true });
          const len = input.value.length;
          input.setSelectionRange(len, len);
        } catch {
          try { input.focus(); } catch {}
        }
      }, 0);
    };

    const openNameSearchPopup = (anchorEl) => {
      if (!anchorEl) return;
      if (nameSearchPopup && nameSearchAnchor === anchorEl) {
        closeNameSearchPopup();
        return;
      }
      closeNameSearchPopup();
      closeCategoryFilterPopup();
      closePrefPopup();

      const popup = doc.createElement("div");
      popup.className = "dsp-name-search-pop";
      popup.addEventListener("mousedown", (evt) => evt.stopPropagation());
      popup.addEventListener("click", (evt) => evt.stopPropagation());
      doc.body.appendChild(popup);

      nameSearchPopup = popup;
      nameSearchAnchor = anchorEl;
      state.nameSearchOpen = true;
      updateHeaderButtons(head, state);
      buildNameSearchPopup();
      positionNameSearchPopup(popup, anchorEl);

      onNameSearchMouseDown = (evt) => {
        const t = evt.target;
        if (nameSearchPopup && nameSearchPopup.contains(t)) return;
        if (nameSearchAnchor && nameSearchAnchor.contains(t)) return;
        closeNameSearchPopup();
      };
      doc.addEventListener("mousedown", onNameSearchMouseDown, true);
    };

    const makePrefToggleRow = (labelText, checked, onToggle) => {
      const row = doc.createElement("div");
      row.className = "dsp-pref-row";

      const label = doc.createElement("label");
      label.className = "dsp-pref-label";
      label.textContent = labelText;

      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = `dsp-pref-toggle${checked ? " on" : ""}`;
      btn.setAttribute("aria-pressed", checked ? "true" : "false");
      btn.title = checked ? "Enabled" : "Disabled";
      btn.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        onToggle();
      });

      label.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        onToggle();
      });

      row.appendChild(label);
      row.appendChild(btn);
      return row;
    };

    const openPrefPopup = () => {
      if (prefPopup) {
        closePrefPopup();
        return;
      }
      closeCategoryFilterPopup();
      closeNameSearchPopup();

      const popup = doc.createElement("div");
      popup.className = "dsp-pref-pop";
      popup.addEventListener("mousedown", (evt) => {
        evt.stopPropagation();
      });
      popup.addEventListener("click", (evt) => {
        evt.stopPropagation();
      });

      const titleRow = doc.createElement("div");
      titleRow.className = "dsp-pref-title";
      titleRow.textContent = "Picker Preferences";
      popup.appendChild(titleRow);

      popup.appendChild(makePrefToggleRow(
        "Double Click to Select",
        !!state.prefs.doubleClickToSelect,
        () => {
          setPref("doubleClickToSelect", !state.prefs.doubleClickToSelect);
          closePrefPopup();
          openPrefPopup();
        },
      ));

      popup.appendChild(makePrefToggleRow(
        "Close Window after Selection",
        !!state.prefs.closeAfterSelection,
        () => {
          setPref("closeAfterSelection", !state.prefs.closeAfterSelection);
          closePrefPopup();
          openPrefPopup();
        },
      ));

      doc.body.appendChild(popup);
      prefPopup = popup;
      prefBtn.classList.add("active");
      positionPrefPopup(popup);

      onPrefMouseDown = (evt) => {
        const t = evt.target;
        if (prefBtn.contains(t)) return;
        if (prefPopup && prefPopup.contains(t)) return;
        closePrefPopup();
      };
      doc.addEventListener("mousedown", onPrefMouseDown, true);
    };

    prefBtn.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      openPrefPopup();
    });

    collapseAllBtn.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      const allCategoryKeys = Array.from(groupDatasetTypeItemsByCategory(state?.items || []).keys())
        .map((category) => normalizeKey(category || "Uncategorized"))
        .filter(Boolean);
      const allCollapsed = allCategoryKeys.length > 0
        && allCategoryKeys.every((key) => state.collapsedCategoryKeys.has(key));
      state.collapsedCategoryKeys = allCollapsed ? new Set() : new Set(allCategoryKeys);
      rerender();
    });

    clearFiltersBtn.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      state.selectedDataFormatKeys = new Set();
      state.selectedCategoryKeys = new Set();
      state.selectedCalculatedKeys = new Set();
      state.nameSearchText = "";
      closeCategoryFilterPopup();
      closeNameSearchPopup();
      rerender();
    });

    createHeader(head, state, {
      onSortChange: (key) => {
        const nextKey = String(key || "");
        if (!nextKey) return;
        if (state.sortKey === nextKey) {
          state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        } else {
          state.sortKey = nextKey;
          state.sortDir = "asc";
        }
        rerender();
      },
      onColumnFilterClick: (colKey, anchorEl) => {
        openCategoryFilterPopup(colKey, anchorEl);
      },
      onNameSearchClick: (anchorEl) => {
        openNameSearchPopup(anchorEl);
      },
      onColumnResizeStart: (colIdx, evt, resizerEl) => {
        beginColumnResize(colIdx, evt, resizerEl);
      },
    });
    rerender();

    const cleanupDrag = makeDraggable(doc, win, titlebar);

    const onEsc = (e) => {
      if (e.key !== "Escape") return;
      if (nameSearchPopup) {
        e.preventDefault();
        e.stopPropagation();
        closeNameSearchPopup();
        return;
      }
      if (categoryFilterPopup) {
        e.preventDefault();
        e.stopPropagation();
        closeCategoryFilterPopup();
        return;
      }
      if (prefPopup) {
        e.preventDefault();
        e.stopPropagation();
        closePrefPopup();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      closeDatasetNamePicker("escape");
    };
    doc.addEventListener("keydown", onEsc, true);

    const onResize = () => {
      clampWindowWithinViewport(doc, win, { refreshMaxSize: true });
      if (prefPopup) positionPrefPopup(prefPopup);
      if (nameSearchPopup && nameSearchAnchor) {
        positionNameSearchPopup(nameSearchPopup, nameSearchAnchor);
      }
      if (categoryFilterPopup && categoryFilterAnchor) {
        positionCategoryFilterPopup(categoryFilterPopup, categoryFilterAnchor);
      }
    };
    const view = doc.defaultView || window;
    view.addEventListener("resize", onResize);

    let resizeObserver = null;
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(() => {
        clampWindowWithinViewport(doc, win);
      });
      try { resizeObserver.observe(win); } catch {}
    }

    if (anchorElement) {
      positionWindowBelowAnchor(doc, win, anchorElement);
    } else {
      const rect = win.getBoundingClientRect();
      const viewport = getViewportSize(doc);
      const left = Math.max(WINDOW_MARGIN_PX, Math.round((viewport.width - rect.width) / 2));
      applyWindowPosition(doc, win, left, 120);
    }

    activeDatasetNamePicker = {
      doc,
      win,
      onEsc,
      onResize,
      cleanupDrag,
      cleanupPreferences: () => {
        closePrefPopup();
        closeNameSearchPopup();
        closeCategoryFilterPopup();
        stopColumnResize();
      },
      resizeObserver,
      onClose,
    };

    return {
      ok: true,
      picker: {
        element: win,
        close: () => closeDatasetNamePicker("api"),
      },
      data,
    };
  } catch (err) {
    if (onError) onError(err);
    else setStatus("Failed to load dataset names.");
    return { ok: false, reason: "error", error: err };
  }
}

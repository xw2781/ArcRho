import { fetchProjectDatasetTypes } from "/ui/dataset/dataset_types_source.js";
import {
  loadProjectUserPreferences,
  scheduleProjectUserPreferencesSave,
} from "/ui/shared/project_user_preferences.js";
import { openLazyReservingClassPicker } from "/ui/shared/reserving_class_lazy_picker.js?v=20260517a";
import "/ui/shared/zoom_bridge.js?v=20260521a";

const qs = new URLSearchParams(window.location.search);
const projectName = String(qs.get("project") || "").trim();

const els = {
  root: document.getElementById("projectInstanceRoot"),
  toolbar: document.querySelector(".pi-toolbar"),
  layout: document.querySelector(".pi-layout"),
  leftPanel: document.querySelector(".pi-left"),
  rightPanel: document.querySelector(".pi-right"),
  leftPanelResizer: document.getElementById("leftPanelResizer"),
  pathTree: document.getElementById("pathTree"),
  selectedPathText: document.getElementById("selectedPathText"),
  hiddenTabsWrap: document.getElementById("hiddenTabsWrap"),
  hiddenTabsList: document.getElementById("hiddenTabsList"),
  hiddenTabsButton: document.getElementById("hiddenTabsButton"),
  hiddenTabsLabel: document.getElementById("hiddenTabsLabel"),
  hiddenTabsMenu: document.getElementById("hiddenTabsMenu"),
  hiddenDropBanner: document.getElementById("hiddenDropBanner"),
  cachedDatasetToggle: document.getElementById("cachedDatasetToggle"),
  datasetActiveFilters: document.getElementById("datasetActiveFilters"),
  cachedDatasetStatus: document.getElementById("cachedDatasetStatus"),
  diskChangeReloadAlert: document.getElementById("diskChangeReloadAlert"),
  pageLoadingOverlay: document.getElementById("pageLoadingOverlay"),
  pageLoadingTitle: document.getElementById("pageLoadingTitle"),
  pageLoadingMessage: document.getElementById("pageLoadingMessage"),
  pageLoadingElapsed: document.getElementById("pageLoadingElapsed"),
  datasetTableWrap: document.getElementById("datasetTableWrap"),
  datasetTableSurface: document.getElementById("datasetTableSurface"),
  datasetTableContextMenu: document.getElementById("datasetTableContextMenu"),
  datasetGroupContextMenu: document.getElementById("datasetGroupContextMenu"),
  datasetRowContextMenu: document.getElementById("datasetRowContextMenu"),
  datasetTableFilterPopover: document.getElementById("datasetTableFilterPopover"),
  datasetDeleteConfirmOverlay: document.getElementById("datasetDeleteConfirmOverlay"),
  datasetDeleteConfirmBox: document.getElementById("datasetDeleteConfirmBox"),
  datasetDeleteConfirmMessage: document.getElementById("datasetDeleteConfirmMessage"),
  datasetDeleteConfirmList: document.getElementById("datasetDeleteConfirmList"),
  datasetDeleteConfirmDelete: document.getElementById("datasetDeleteConfirmDelete"),
  datasetDeleteConfirmCancel: document.getElementById("datasetDeleteConfirmCancel"),
  datasetDeleteConfirmClose: document.getElementById("datasetDeleteConfirmClose"),
  windowLayer: document.getElementById("datasetWindowLayer"),
};

const DATASET_TABLE_COLUMNS = Object.freeze([
  { key: "name", label: "Name", minWidth: 150 },
  { key: "datasetTypeName", label: "Dataset Type Name", minWidth: 150 },
  { key: "dataFormat", label: "Data Format", minWidth: 120 },
  { key: "formula", label: "Formula", minWidth: 160 },
  { key: "category", label: "Category", minWidth: 120 },
  { key: "methodType", label: "Method Type", minWidth: 110 },
  { key: "lastModified", label: "Last Modified", minWidth: 130 },
  { key: "created", label: "Created", minWidth: 110 },
  { key: "user", label: "User", minWidth: 110 },
]);
const DATASET_COLUMNS = DATASET_TABLE_COLUMNS.length;
const DATASET_TABLE_DEFAULT_WIDTHS = Object.freeze({
  name: 180,
  datasetTypeName: 180,
  dataFormat: 140,
  formula: 180,
  category: 140,
  methodType: 120,
  lastModified: 140,
  created: 120,
  user: 120,
});
const DATASET_TABLE_AUTOFIT_MAX_WIDTH = 460;
const DATASET_TABLE_AUTOFIT_CELL_EXTRA_WIDTH = 38;
const DATASET_TABLE_AUTOFIT_HEADER_EXTRA_WIDTH = 76;
const DATASET_TABLE_BLANK_LABEL = "(Blank)";
const DATASET_FILTER_CHIP_VALUE_LIMIT = 2;
const LEFT_PANEL_DEFAULT_WIDTH = 400;
const LEFT_PANEL_MIN_WIDTH = 200;
const LEFT_PANEL_MAX_WIDTH = 600;
const LEFT_PANEL_COLLAPSE_THRESHOLD = 200;
const LEFT_PANEL_RIGHT_MIN_WIDTH = 420;
const LEFT_PANEL_KEYBOARD_STEP = 24;
const DATASET_WINDOW_MIN_WIDTH = 420;
const DATASET_WINDOW_MIN_HEIGHT = 280;
const DATASET_WINDOW_DEFAULT_WIDTH_RATIO = 0.8;
const DATASET_WINDOW_DEFAULT_HEIGHT_RATIO = 0.8;
const DATASET_WINDOW_DOCK_ANIMATION_MS = 520;
const DATASET_WINDOW_RESTORE_ANIMATION_MS = 280;
const DATASET_WINDOW_EDGE_VISIBLE_WIDTH = 80;
const DATASET_WINDOW_TITLEBAR_HEIGHT = 30;
const HIDDEN_TABS_HOVER_CLOSE_MS = 1000;
const ACTIVE_PATH_FOLDER_WATCH_INTERVAL_MS = 8000;
let selectedPath = "";
let datasetRows = [];
let nextWindowZ = 1;
let windowSeq = 1;
let lastExpandedLeftWidth = LEFT_PANEL_DEFAULT_WIDTH;
let lastDatasetWindowSize = null;
let activeDatasetWindow = null;
let lastDatasetWindowShortcutCloseAt = 0;
const hiddenWindows = new Map();
const datasetWindows = new Map();
let lastZoomDetail = null;
const pageLoadingTasks = new Set();
let hiddenTabsHoverCloseTimer = 0;
let hiddenTabsMenuPinned = false;
let minimizedTabTooltip = null;
let datasetFilterTooltip = null;
let pageLoadingFrameTimer = 0;
let pageLoadingStartedAt = 0;
let pendingProjectInstanceRestoreState = null;
let projectInstanceBootComplete = false;
let datasetTablePreferencesLoaded = false;
const datasetTablePreferenceWidthKeys = new Set();
const datasetTableView = {
  groupBy: [],
  columns: DATASET_TABLE_COLUMNS.map((col) => col.key),
  widths: { ...DATASET_TABLE_DEFAULT_WIDTHS },
  filters: new Map(),
  collapsedGroups: new Set(),
  sort: {
    key: "",
    dir: "asc",
  },
};
const cachedDatasetFilter = {
  enabled: true,
  loading: false,
  loadedPath: "",
  names: new Set(),
  metadataByName: new Map(),
  methodTypesByName: new Map(),
  visibleCount: 0,
  error: "",
  requestSeq: 0,
};
const cachedDatasetSnapshotRequests = new Map();
const activePathFolderWatch = {
  timer: 0,
  path: "",
  signature: "",
  instanceSignature: "",
  requestSeq: 0,
  noticeShown: false,
};
let datasetTableFilterColumn = "";
let datasetTableFilterAnchor = null;
let datasetTableColumnDragStarted = false;
let datasetGroupContextId = "";
let datasetRowContextKey = "";
let datasetTableVisibleRecords = [];
const datasetTableSelection = {
  selectedKeys: new Set(),
  anchorKey: "",
};
let datasetDeleteConfirmResolve = null;
let lastDatasetSelectionStatusCount = 0;
let datasetTableMeasureCanvas = null;

function postZoomToDatasetFrame(iframe, detail = lastZoomDetail) {
  if (!iframe?.contentWindow || !detail) return;
  try {
    iframe.contentWindow.postMessage({
      type: "arcrho:set-zoom",
      zoom: detail.zoom,
      statusBarHeight: detail.statusBarHeight,
    }, "*");
  } catch {
    // ignore nested iframe zoom sync failures
  }
}

function broadcastZoomToDatasetWindows(detail = lastZoomDetail) {
  for (const frame of datasetWindows.values()) {
    postZoomToDatasetFrame(frame?.querySelector?.("iframe"), detail);
  }
}

window.ArcRhoZoomBridge?.wirePageZoomBridge({
  onApplied: (detail) => {
    lastZoomDetail = detail;
    broadcastZoomToDatasetWindows(detail);
  },
});

async function applyHostFrameCornerStyle() {
  let isWin11 = false;
  try {
    isWin11 = !!window.parent?.document?.body?.classList?.contains("win11-frame");
  } catch {
    isWin11 = false;
  }

  if (!isWin11 && typeof window.ADAHost?.isWindows11 === "function") {
    try {
      isWin11 = !!(await window.ADAHost.isWindows11());
    } catch {
      isWin11 = false;
    }
  }

  document.body.classList.toggle("win11-frame", isWin11);
  document.body.classList.toggle("win10-borders", !isWin11);
}

function toText(value) {
  return String(value ?? "").trim();
}

function normalizeLookupKey(value) {
  return toText(value).replace(/\s+/g, " ").toLowerCase();
}

function normalizePath(value) {
  return toText(value)
    .split("\\")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\\");
}

function sanitizeDatasetFileName(value, fallback = "Dataset") {
  const text = String(value ?? "").trim()
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}

function getCachedDatasetKey(value) {
  return sanitizeDatasetFileName(value, "").toLowerCase();
}

function setStatus(text, isError = false) {
  if (isError) console.warn(toText(text));
}

function postProjectInstanceStatus(text, tone = "") {
  const statusText = toText(text);
  if (!statusText) return;
  try {
    window.parent?.postMessage({
      type: "arcrho:status",
      text: statusText,
      ...(tone ? { tone } : {}),
    }, "*");
  } catch {}
}

function syncCachedDatasetToolbar() {
  const btn = els.cachedDatasetToggle;
  if (btn) {
    btn.classList.toggle("active", cachedDatasetFilter.enabled);
    btn.setAttribute("aria-pressed", cachedDatasetFilter.enabled ? "true" : "false");
    btn.disabled = cachedDatasetFilter.enabled && cachedDatasetFilter.loading;
    if (cachedDatasetFilter.enabled) {
      btn.title = "Show all datasets";
    } else {
      btn.title = "Show only datasets with cached CSV or JSON files";
    }
  }
  if (!els.cachedDatasetStatus) return;
  if (!selectedPath) {
    els.cachedDatasetStatus.textContent = "";
    return;
  }
  if (cachedDatasetFilter.loading) {
    els.cachedDatasetStatus.textContent = "Checking cached datasets...";
    return;
  }
  if (cachedDatasetFilter.error) {
    els.cachedDatasetStatus.textContent = "Cached dataset check failed";
    return;
  }
  const count = Number.isFinite(cachedDatasetFilter.visibleCount)
    ? cachedDatasetFilter.visibleCount
    : cachedDatasetFilter.names.size;
  els.cachedDatasetStatus.textContent = count === 1 ? "1 cached dataset" : `${count} cached datasets`;
}

function syncDiskChangeToolbarAlert() {
  const alert = els.diskChangeReloadAlert;
  if (!alert) return;
  alert.hidden = !activePathFolderWatch.noticeShown;
}

function getDatasetFilterActiveValues(key, context = null) {
  if (!context) {
    const selected = datasetTableView.filters.get(key);
    return selected instanceof Set ? Array.from(selected).map((value) => String(value)) : [];
  }
  const options = getDatasetColumnOptions(key, context);
  if (!options.length) return [];
  const selected = context?.selectionsByKey?.get?.(key) || getDatasetFilterSelection(key, options);
  if (!(selected instanceof Set) || selected.size === 0 || selected.size === options.length) return [];
  const optionLabels = new Map(options.map((opt) => [opt.key, opt.label]));
  return options
    .filter((opt) => selected.has(opt.key))
    .map((opt) => opt.label || opt.key)
    .concat(
      Array.from(selected)
        .filter((keyValue) => !optionLabels.has(keyValue))
        .map((keyValue) => String(keyValue))
    );
}

function getDatasetActiveFilterSummaries(context = null) {
  const summaries = [];
  for (const col of DATASET_TABLE_COLUMNS) {
    const values = getDatasetFilterActiveValues(col.key, context);
    if (!values.length) continue;
    const visible = values.slice(0, DATASET_FILTER_CHIP_VALUE_LIMIT).join(", ");
    summaries.push({
      key: col.key,
      label: col.label,
      text: `${col.label}: ${visible}${values.length > DATASET_FILTER_CHIP_VALUE_LIMIT ? "..." : ""}`,
      title: `${col.label}: ${values.join(", ")}`,
    });
  }
  return summaries;
}

function clearDatasetColumnFilter(key) {
  const normalized = toText(key);
  if (!getDatasetColumn(normalized) || !datasetTableView.filters.has(normalized)) return;
  hideDatasetFilterTooltip();
  datasetTableView.filters.delete(normalized);
  closeDatasetTableFilterPopover();
  saveDatasetTablePreferences();
  renderDatasetTable();
}

function ensureDatasetFilterTooltip() {
  if (datasetFilterTooltip?.isConnected) return datasetFilterTooltip;
  datasetFilterTooltip = document.createElement("div");
  datasetFilterTooltip.className = "dataset-filter-chip-tooltip";
  datasetFilterTooltip.setAttribute("role", "tooltip");
  datasetFilterTooltip.setAttribute("aria-hidden", "true");
  document.body.appendChild(datasetFilterTooltip);
  return datasetFilterTooltip;
}

function positionDatasetFilterTooltip(chip) {
  if (!datasetFilterTooltip?.classList?.contains("active") || !chip?.getBoundingClientRect) return;
  const chipRect = chip.getBoundingClientRect();
  const tooltipRect = datasetFilterTooltip.getBoundingClientRect();
  const pad = 8;
  const left = Math.max(pad, Math.min(chipRect.left, window.innerWidth - tooltipRect.width - pad));
  const top = Math.max(pad, Math.min(chipRect.bottom + 6, window.innerHeight - tooltipRect.height - pad));
  datasetFilterTooltip.style.left = `${Math.round(left)}px`;
  datasetFilterTooltip.style.top = `${Math.round(top)}px`;
}

function showDatasetFilterTooltip(chip) {
  const text = toText(chip?.dataset?.tooltip);
  if (!text) return;
  const tooltip = ensureDatasetFilterTooltip();
  tooltip.textContent = text;
  tooltip.classList.add("active");
  tooltip.setAttribute("aria-hidden", "false");
  window.requestAnimationFrame(() => positionDatasetFilterTooltip(chip));
}

function hideDatasetFilterTooltip() {
  if (!datasetFilterTooltip) return;
  datasetFilterTooltip.classList.remove("active");
  datasetFilterTooltip.setAttribute("aria-hidden", "true");
}

function syncDatasetActiveFiltersToolbar(context = null) {
  const wrap = els.datasetActiveFilters;
  if (!wrap) return;
  hideDatasetFilterTooltip();
  const summaries = getDatasetActiveFilterSummaries(context);
  wrap.replaceChildren();
  wrap.hidden = summaries.length === 0;
  for (const item of summaries) {
    const chip = document.createElement("span");
    chip.className = "dataset-filter-chip";
    chip.dataset.filterKey = item.key;
    chip.dataset.tooltip = item.title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "dataset-filter-chip-close";
    close.dataset.filterKey = item.key;
    close.setAttribute("aria-label", `Clear ${item.label} filter`);
    close.textContent = "x";
    const label = document.createElement("span");
    label.className = "dataset-filter-chip-label";
    label.textContent = item.text;
    chip.append(close, label);
    chip.addEventListener("mouseenter", () => showDatasetFilterTooltip(chip));
    chip.addEventListener("mousemove", () => positionDatasetFilterTooltip(chip));
    chip.addEventListener("mouseleave", hideDatasetFilterTooltip);
    wrap.appendChild(chip);
  }
}

function shouldUseCachedDatasetFilter() {
  return (
    !cachedDatasetFilter.loading
    && !cachedDatasetFilter.error
    && selectedPath
    && normalizePath(cachedDatasetFilter.loadedPath).toLowerCase() === normalizePath(selectedPath).toLowerCase()
  );
}

function hasCachedDatasetMetadataForSelectedPath() {
  return (
    selectedPath
    && normalizePath(cachedDatasetFilter.loadedPath).toLowerCase() === normalizePath(selectedPath).toLowerCase()
    && cachedDatasetFilter.metadataByName instanceof Map
  );
}

function hasCachedDatasetSnapshotForSelectedPath() {
  return (
    hasCachedDatasetMetadataForSelectedPath()
    && !cachedDatasetFilter.loading
    && !cachedDatasetFilter.error
  );
}

function isDatasetRecordCached(record) {
  if (!hasCachedDatasetSnapshotForSelectedPath()) return false;
  const key = getCachedDatasetKey(record?.datasetName || getDatasetName(record?.row));
  return !!key && cachedDatasetFilter.names.has(key);
}

function getDatasetRecordKey(record) {
  const rowIndex = Number(record?.rowIndex);
  if (Number.isInteger(rowIndex) && rowIndex >= 0) return `row-${rowIndex}`;
  const name = toText(record?.datasetName);
  return name ? `name-${name.toLowerCase()}` : "";
}

function pruneDatasetTableSelection() {
  const visibleKeys = new Set(datasetTableVisibleRecords.map(getDatasetRecordKey).filter(Boolean));
  for (const key of Array.from(datasetTableSelection.selectedKeys)) {
    if (!visibleKeys.has(key)) datasetTableSelection.selectedKeys.delete(key);
  }
  if (!visibleKeys.has(datasetTableSelection.anchorKey)) {
    datasetTableSelection.anchorKey = datasetTableSelection.selectedKeys.values().next().value || "";
  }
  updateDatasetSelectionStatusBar();
}

function getSelectedDatasetRecords() {
  pruneDatasetTableSelection();
  return datasetTableVisibleRecords.filter((record) => datasetTableSelection.selectedKeys.has(getDatasetRecordKey(record)));
}

function getDatasetRecordByKey(key) {
  const normalized = toText(key);
  return datasetTableVisibleRecords.find((record) => getDatasetRecordKey(record) === normalized) || null;
}

function getDatasetRecordIndexByKey(key) {
  const normalized = toText(key);
  if (!normalized) return -1;
  return datasetTableVisibleRecords.findIndex((record) => getDatasetRecordKey(record) === normalized);
}

function setDatasetRecordSelected(key, selected) {
  const normalized = toText(key);
  if (!normalized) return;
  if (selected) datasetTableSelection.selectedKeys.add(normalized);
  else datasetTableSelection.selectedKeys.delete(normalized);
}

function focusDatasetTableSurface() {
  const surface = els.datasetTableSurface;
  if (!surface) return;
  if (surface.tabIndex < 0) surface.tabIndex = 0;
  surface.focus?.({ preventScroll: true });
}

function scrollDatasetRecordIntoView(key) {
  const normalized = toText(key);
  if (!normalized) return;
  const row = els.datasetTableSurface?.querySelector?.(`tr[data-record-key="${CSS.escape(normalized)}"]`);
  row?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

function getActiveDatasetSelectionIndex() {
  const anchorIndex = getDatasetRecordIndexByKey(datasetTableSelection.anchorKey);
  if (
    anchorIndex >= 0
    && datasetTableSelection.selectedKeys.has(datasetTableSelection.anchorKey)
  ) {
    return anchorIndex;
  }
  for (const key of datasetTableSelection.selectedKeys) {
    const selectedIndex = getDatasetRecordIndexByKey(key);
    if (selectedIndex >= 0) return selectedIndex;
  }
  return -1;
}

function selectDatasetRecordAtIndex(index) {
  if (!datasetTableVisibleRecords.length) return false;
  const clamped = Math.max(0, Math.min(datasetTableVisibleRecords.length - 1, Number(index)));
  const record = datasetTableVisibleRecords[clamped];
  const key = getDatasetRecordKey(record);
  if (!key) return false;
  datasetTableSelection.selectedKeys.clear();
  datasetTableSelection.selectedKeys.add(key);
  datasetTableSelection.anchorKey = key;
  syncDatasetTableSelectionDom();
  scrollDatasetRecordIntoView(key);
  focusDatasetTableSurface();
  return true;
}

function applyDatasetRowSelection(record, event = {}) {
  const key = getDatasetRecordKey(record);
  if (!key) return;
  const visibleKeys = datasetTableVisibleRecords.map(getDatasetRecordKey).filter(Boolean);
  const clickedIndex = visibleKeys.indexOf(key);
  const anchorIndex = visibleKeys.indexOf(datasetTableSelection.anchorKey);
  const additive = !!(event.ctrlKey || event.metaKey);

  if (event.shiftKey && clickedIndex >= 0 && anchorIndex >= 0) {
    const [start, end] = clickedIndex < anchorIndex ? [clickedIndex, anchorIndex] : [anchorIndex, clickedIndex];
    if (!additive) datasetTableSelection.selectedKeys.clear();
    for (const rangeKey of visibleKeys.slice(start, end + 1)) {
      datasetTableSelection.selectedKeys.add(rangeKey);
    }
  } else if (additive) {
    setDatasetRecordSelected(key, !datasetTableSelection.selectedKeys.has(key));
    datasetTableSelection.anchorKey = key;
  } else {
    if (datasetTableSelection.selectedKeys.has(key) && datasetTableSelection.selectedKeys.size === 1) {
      datasetTableSelection.selectedKeys.delete(key);
    } else {
      datasetTableSelection.selectedKeys.clear();
      datasetTableSelection.selectedKeys.add(key);
    }
    datasetTableSelection.anchorKey = key;
  }
  syncDatasetTableSelectionDom();
}

function handleDatasetTableKeyDown(event) {
  if (event.key === "Enter") {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const activeIndex = getActiveDatasetSelectionIndex();
    if (activeIndex < 0) return;
    event.preventDefault();
    event.stopPropagation();
    openDatasetRecord(datasetTableVisibleRecords[activeIndex]);
    return;
  }
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const activeIndex = getActiveDatasetSelectionIndex();
  if (activeIndex < 0) return;
  const nextIndex = activeIndex + (event.key === "ArrowDown" ? 1 : -1);
  if (nextIndex < 0 || nextIndex >= datasetTableVisibleRecords.length) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  selectDatasetRecordAtIndex(nextIndex);
}

function syncDatasetTableSelectionDom() {
  for (const tr of els.datasetTableSurface?.querySelectorAll?.("tr[data-record-key]") || []) {
    const selected = datasetTableSelection.selectedKeys.has(toText(tr.dataset.recordKey));
    tr.classList.toggle("selected", selected);
    tr.setAttribute("aria-selected", selected ? "true" : "false");
  }
  updateDatasetSelectionStatusBar();
}

function updateDatasetSelectionStatusBar() {
  const count = datasetTableSelection.selectedKeys.size;
  if (count > 1) {
    if (lastDatasetSelectionStatusCount !== count) {
      postProjectInstanceStatus(`${count} datasets selected`);
    }
    lastDatasetSelectionStatusCount = count;
    return;
  }
  if (lastDatasetSelectionStatusCount > 1) {
    postProjectInstanceStatus("Status: Ready");
  }
  lastDatasetSelectionStatusCount = count;
}

function splitLengthScopedDatasetName(value) {
  const text = toText(value);
  const parts = text.split("@");
  if (parts.length >= 3 && /^\d+$/.test(parts[parts.length - 1]) && /^\d+$/.test(parts[parts.length - 2])) {
    return parts.slice(0, -2).join("@").trim();
  }
  return text;
}

function getCachedFileDatasetNames(item) {
  const names = [];
  const add = (value) => {
    const text = splitLengthScopedDatasetName(value);
    if (text) names.push(text);
  };
  if (Array.isArray(item?.dataset_names)) {
    for (const name of item.dataset_names) add(name);
  }
  add(item?.dataset_name);
  add(item?.instance_name);
  add(item?.dataset_type);
  add(item?.dataset_type_name);

  const filename = toText(item?.name);
  const stem = filename.replace(/\.[^.]*$/u, "");
  if (stem.startsWith("ArcRhoTriNotes@")) add(stem.slice("ArcRhoTriNotes@".length));
  else if (stem.startsWith("DFM@")) add(stem.slice("DFM@".length));
  else add(stem);

  const seen = new Set();
  return names.filter((name) => {
    const key = getCachedDatasetKey(name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getTimestampNumber(value) {
  const text = toText(value);
  if (!text) return 0;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1000000000000 ? numeric / 1000 : numeric;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed / 1000 : 0;
}

function formatCachedTimestamp(value) {
  const text = toText(value);
  if (!text) return "";
  const numeric = Number(text);
  const date = Number.isFinite(numeric) && numeric > 0
    ? new Date(numeric > 1000000000000 ? numeric : numeric * 1000)
    : new Date(text);
  if (!Number.isNaN(date.getTime())) {
    const pad = (part) => String(part).padStart(2, "0");
    const hours = date.getHours();
    const hour12 = hours % 12 || 12;
    const suffix = hours >= 12 ? "PM" : "AM";
    return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()} ${hour12}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${suffix}`;
  }
  return text
    .replace("T", " ")
    .replace(/\.\d+(?=Z?$)/u, "")
    .replace(/Z$/u, "")
    .slice(0, 16);
}

function mergeCachedDatasetMetadata(existing, item) {
  const meta = existing || {
    lastModified: "",
    created: "",
    user: "",
    _lastModifiedTs: 0,
    _createdTs: 0,
    _userModifiedTs: 0,
  };

  const lastModifiedRaw = item?.last_modified || item?.last_modified_timestamp || item?.mtime || item?.metadata_last_modified;
  const lastModified = formatCachedTimestamp(lastModifiedRaw);
  const lastModifiedTs = getTimestampNumber(lastModifiedRaw) || getTimestampNumber(item?.last_modified_timestamp) || getTimestampNumber(item?.mtime);
  if (lastModified && (!meta.lastModified || lastModifiedTs >= meta._lastModifiedTs)) {
    meta.lastModified = lastModified;
    meta._lastModifiedTs = lastModifiedTs;
  }

  const createdRaw = item?.created || item?.created_timestamp || item?.metadata_created;
  const created = formatCachedTimestamp(createdRaw);
  const createdTs = getTimestampNumber(createdRaw) || getTimestampNumber(item?.created_timestamp);
  if (created && (!meta.created || !meta._createdTs || (createdTs && createdTs < meta._createdTs))) {
    meta.created = created;
    meta._createdTs = createdTs;
  }

  const user = toText(item?.user);
  if (user && (!meta.user || lastModifiedTs >= meta._userModifiedTs)) {
    meta.user = user;
    meta._userModifiedTs = lastModifiedTs;
  }
  return meta;
}

function normalizeCachedDatasetSnapshot(payload) {
  const names = Array.isArray(payload?.dataset_names) ? payload.dataset_names : [];
  const metadataByName = new Map();
  const methodTypesByName = new Map();
  const addMethodType = (name, methodType) => {
    const key = normalizeLookupKey(name);
    const type = toText(methodType);
    if (key && type) methodTypesByName.set(key, type);
  };
  for (const item of Array.isArray(payload?.files) ? payload.files : []) {
    const itemNames = getCachedFileDatasetNames(item);
    for (const name of itemNames) {
      const key = getCachedDatasetKey(name);
      if (!key) continue;
      metadataByName.set(key, mergeCachedDatasetMetadata(metadataByName.get(key), item));
    }
    if (item?.method_type) {
      for (const name of itemNames) addMethodType(name, item.method_type);
    }
  }
  return {
    names: new Set(names.map((name) => getCachedDatasetKey(name)).filter(Boolean)),
    metadataByName,
    methodTypesByName,
  };
}

function getCachedDatasetSnapshotSignature(payload) {
  const direct = toText(payload?.folder_signature);
  if (direct) return direct;
  const files = Array.isArray(payload?.files) ? payload.files : [];
  return JSON.stringify({
    exists: payload?.exists !== false,
    files: files
      .map((item) => ({
        storage: toText(item?.storage),
        name: toText(item?.name),
        size: Number(item?.size) || 0,
        mtime_ns: Number(item?.mtime_ns) || 0,
      }))
      .sort((a, b) => `${a.storage}\u0001${a.name}`.localeCompare(`${b.storage}\u0001${b.name}`, undefined, { sensitivity: "base" })),
  });
}

function getCachedDatasetInstanceSignature(payload) {
  const names = Array.isArray(payload?.dataset_names) ? payload.dataset_names : [];
  const keys = Array.from(new Set(names.map((name) => getCachedDatasetKey(name)).filter(Boolean)));
  keys.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
  return JSON.stringify(keys);
}

async function fetchCachedDatasetSnapshot(path) {
  const normalizedPath = normalizePath(path);
  const requestKey = `${normalizeLookupKey(projectName)}\u0001${normalizedPath.toLowerCase()}`;
  const existing = cachedDatasetSnapshotRequests.get(requestKey);
  if (existing) return existing;

  const request = (async () => {
    const url = new URL("/datasets/cached", window.location.origin);
    url.searchParams.set("project_name", projectName);
    url.searchParams.set("reserving_class", normalizedPath);
    const resp = await fetch(url.toString(), { cache: "no-store" });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || payload?.ok === false) {
      throw new Error(payload?.detail || `Cached dataset lookup failed (${resp.status})`);
    }
    return payload;
  })();

  cachedDatasetSnapshotRequests.set(requestKey, request);
  try {
    return await request;
  } finally {
    if (cachedDatasetSnapshotRequests.get(requestKey) === request) {
      cachedDatasetSnapshotRequests.delete(requestKey);
    }
  }
}

function rememberActivePathFolderSignature(payload, path = selectedPath) {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath || normalizePath(selectedPath).toLowerCase() !== normalizedPath.toLowerCase()) return;
  if (activePathFolderWatch.noticeShown) return;
  const signature = getCachedDatasetSnapshotSignature(payload);
  if (!signature) return;
  const instanceSignature = getCachedDatasetInstanceSignature(payload);
  if (normalizePath(activePathFolderWatch.path).toLowerCase() !== normalizedPath.toLowerCase()) {
    activePathFolderWatch.path = normalizedPath;
    activePathFolderWatch.signature = signature;
    activePathFolderWatch.instanceSignature = instanceSignature;
    return;
  }
  if (!activePathFolderWatch.signature) activePathFolderWatch.signature = signature;
  if (!activePathFolderWatch.instanceSignature) activePathFolderWatch.instanceSignature = instanceSignature;
}

function clearDiskChangeNotice() {
  syncDiskChangeToolbarAlert();
}

function reloadProjectInstanceAfterDiskChange() {
  if (!activePathFolderWatch.noticeShown) return;
  window.location.reload();
}

function showDiskChangeNotice() {
  if (activePathFolderWatch.noticeShown) return;
  activePathFolderWatch.noticeShown = true;
  if (activePathFolderWatch.timer) {
    window.clearInterval(activePathFolderWatch.timer);
    activePathFolderWatch.timer = 0;
  }
  syncDiskChangeToolbarAlert();
  setStatus("New dataset instances were detected on disk. Reload the Project Instance page to update the table.");
}

async function checkActivePathFolderSnapshot() {
  const path = normalizePath(selectedPath);
  if (!projectName || !path || activePathFolderWatch.noticeShown) return;
  if (normalizePath(activePathFolderWatch.path).toLowerCase() !== path.toLowerCase()) {
    activePathFolderWatch.path = path;
    activePathFolderWatch.signature = "";
  }
  const seq = activePathFolderWatch.requestSeq + 1;
  activePathFolderWatch.requestSeq = seq;
  try {
    const payload = await fetchCachedDatasetSnapshot(path);
    if (seq !== activePathFolderWatch.requestSeq) return;
    const signature = getCachedDatasetSnapshotSignature(payload);
    if (!signature) return;
    const instanceSignature = getCachedDatasetInstanceSignature(payload);
    if (!activePathFolderWatch.signature) {
      activePathFolderWatch.signature = signature;
      activePathFolderWatch.instanceSignature = instanceSignature;
      return;
    }
    if (signature !== activePathFolderWatch.signature) {
      if (instanceSignature !== activePathFolderWatch.instanceSignature) {
        showDiskChangeNotice();
        return;
      }
      activePathFolderWatch.signature = signature;
      activePathFolderWatch.instanceSignature = instanceSignature;
    }
  } catch (err) {
    if (seq !== activePathFolderWatch.requestSeq) return;
    console.warn("Failed to check active reserving-class folder:", err);
  }
}

function resetActivePathFolderWatch(path = selectedPath, options = {}) {
  activePathFolderWatch.path = normalizePath(path);
  activePathFolderWatch.signature = "";
  activePathFolderWatch.instanceSignature = "";
  activePathFolderWatch.requestSeq += 1;
  activePathFolderWatch.noticeShown = false;
  clearDiskChangeNotice();
  if (!projectName || !activePathFolderWatch.path) {
    if (activePathFolderWatch.timer) {
      window.clearInterval(activePathFolderWatch.timer);
      activePathFolderWatch.timer = 0;
    }
    return;
  }
  ensureActivePathFolderWatch();
  if (options?.skipInitialCheck) return;
  void checkActivePathFolderSnapshot();
}

function ensureActivePathFolderWatch() {
  if (activePathFolderWatch.noticeShown) return;
  if (activePathFolderWatch.timer) return;
  activePathFolderWatch.timer = window.setInterval(() => {
    void checkActivePathFolderSnapshot();
  }, ACTIVE_PATH_FOLDER_WATCH_INTERVAL_MS);
}

async function loadCachedDatasetFilterForSelectedPath() {
  const path = normalizePath(selectedPath);
  const seq = cachedDatasetFilter.requestSeq + 1;
  cachedDatasetFilter.requestSeq = seq;
  cachedDatasetFilter.error = "";
  cachedDatasetFilter.names = new Set();
  cachedDatasetFilter.metadataByName = new Map();
  cachedDatasetFilter.methodTypesByName = new Map();
  cachedDatasetFilter.loadedPath = path;

  if (!projectName || !path) {
    cachedDatasetFilter.loading = false;
    syncCachedDatasetToolbar();
    renderDatasetTable();
    return;
  }

  cachedDatasetFilter.loading = true;
  syncCachedDatasetToolbar();
  renderDatasetTable();

  try {
    const payload = await fetchCachedDatasetSnapshot(path);
    if (seq !== cachedDatasetFilter.requestSeq) return;
    const snapshot = normalizeCachedDatasetSnapshot(payload);
    cachedDatasetFilter.names = snapshot.names;
    cachedDatasetFilter.metadataByName = snapshot.metadataByName;
    cachedDatasetFilter.methodTypesByName = snapshot.methodTypesByName;
    cachedDatasetFilter.loadedPath = path;
    cachedDatasetFilter.error = "";
    rememberActivePathFolderSignature(payload, path);
  } catch (err) {
    if (seq !== cachedDatasetFilter.requestSeq) return;
    cachedDatasetFilter.names = new Set();
    cachedDatasetFilter.metadataByName = new Map();
    cachedDatasetFilter.methodTypesByName = new Map();
    cachedDatasetFilter.error = toText(err?.message) || "Cached dataset lookup failed.";
    setStatus(cachedDatasetFilter.error, true);
  } finally {
    if (seq !== cachedDatasetFilter.requestSeq) return;
    cachedDatasetFilter.loading = false;
    syncCachedDatasetToolbar();
    renderDatasetTable();
  }
}

function setCachedDatasetFilterEnabled(enabled) {
  const next = !!enabled;
  if (cachedDatasetFilter.enabled === next) return;
  cachedDatasetFilter.enabled = next;
  closeDatasetTableFilterPopover();
  syncCachedDatasetToolbar();
  renderDatasetTable();
}

function saveLastSelectedPath(path) {
  const normalized = normalizePath(path);
  if (!projectName || !normalized) return;
  scheduleProjectUserPreferencesSave(projectName, {
    lastReservingClassPath: normalized,
  });
}

async function loadLastSelectedPath() {
  if (!projectName) return "";
  try {
    const prefs = await loadProjectUserPreferences(projectName);
    const path = normalizePath(prefs?.lastReservingClassPath || prefs?.last_reserving_class_path || "");
    return path;
  } catch (err) {
    console.warn("Failed to load last project instance path:", err);
    return "";
  }
}

function getDatasetWindowKey(datasetName, path = selectedPath) {
  return `${normalizePath(path)}\u0001${toText(datasetName).toLowerCase()}`;
}

function getDatasetTablePreferencePayload() {
  const known = new Set(DATASET_TABLE_COLUMNS.map((col) => col.key));
  const columns = datasetTableView.columns.filter((key) => known.has(key));
  const widths = {};
  for (const col of DATASET_TABLE_COLUMNS) {
    const width = Number(datasetTableView.widths[col.key]);
    if (Number.isFinite(width)) widths[col.key] = Math.round(Math.max(col.minWidth || 80, width));
  }
  const filters = {};
  for (const col of DATASET_TABLE_COLUMNS) {
    const key = col.key;
    const selected = datasetTableView.filters.get(key);
    if (!known.has(key) || !(selected instanceof Set) || selected.size === 0) {
      filters[key] = [];
      continue;
    }
    const options = getDatasetColumnOptions(key);
    if (options.length && selected.size === options.length && options.every((opt) => selected.has(opt.key))) {
      filters[key] = [];
      continue;
    }
    filters[key] = Array.from(selected).map((value) => String(value)).sort();
  }
  const groupBy = getDatasetGroupByKeys();
  const collapsedGroups = Array.from(datasetTableView.collapsedGroups || [])
    .map((id) => String(id || ""))
    .filter(Boolean)
    .sort();
  const sortKey = toText(datasetTableView.sort?.key);
  const sort = known.has(sortKey)
    ? { key: sortKey, dir: datasetTableView.sort?.dir === "desc" ? "desc" : "asc" }
    : { key: "", dir: "asc" };
  return { columns, widths, filters, groupBy, collapsedGroups, sort };
}

function saveDatasetTablePreferences() {
  if (!datasetTablePreferencesLoaded || !projectName) return;
  scheduleProjectUserPreferencesSave(projectName, {
    projectInstance: {
      datasetTable: getDatasetTablePreferencePayload(),
    },
  }, 500);
}

function getDatasetTablePreferencesSource(prefs) {
  const candidates = [
    prefs?.projectInstance?.datasetTable,
    prefs?.project_instance?.dataset_table,
    prefs?.datasetTableView,
  ];
  return candidates.find((item) => item && typeof item === "object" && !Array.isArray(item)) || null;
}

function applyDatasetTablePreferences(source) {
  datasetTablePreferenceWidthKeys.clear();
  const prefs = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  const known = new Set(DATASET_TABLE_COLUMNS.map((col) => col.key));
  if (Array.isArray(prefs.columns)) {
    const columns = [];
    prefs.columns.forEach((key) => {
      const normalized = toText(key);
      if (known.has(normalized) && !columns.includes(normalized)) columns.push(normalized);
    });
    DATASET_TABLE_COLUMNS.forEach((col) => {
      if (!columns.includes(col.key)) columns.push(col.key);
    });
    if (columns.length) datasetTableView.columns = columns;
  }
  const widths = prefs.widths && typeof prefs.widths === "object" && !Array.isArray(prefs.widths) ? prefs.widths : {};
  for (const col of DATASET_TABLE_COLUMNS) {
    const width = Number(widths[col.key]);
    if (!Number.isFinite(width)) continue;
    datasetTableView.widths[col.key] = Math.max(col.minWidth || 80, Math.round(width));
    datasetTablePreferenceWidthKeys.add(col.key);
  }
  datasetTableView.filters.clear();
  const filters = prefs.filters && typeof prefs.filters === "object" && !Array.isArray(prefs.filters) ? prefs.filters : {};
  Object.entries(filters).forEach(([key, values]) => {
    const normalized = toText(key);
    if (!known.has(normalized) || !Array.isArray(values)) return;
    const selected = new Set(values.map((value) => String(value)).filter(Boolean));
    if (selected.size) datasetTableView.filters.set(normalized, selected);
  });
  if (Array.isArray(prefs.groupBy)) {
    datasetTableView.groupBy = prefs.groupBy.map(toText).filter((key) => ["dataFormat", "category"].includes(key)).slice(0, 2);
  }
  datasetTableView.collapsedGroups = new Set(
    Array.isArray(prefs.collapsedGroups)
      ? prefs.collapsedGroups.map((id) => String(id || "")).filter(Boolean)
      : []
  );
  const sortKey = toText(prefs.sort?.key);
  datasetTableView.sort = {
    key: known.has(sortKey) ? sortKey : "",
    dir: prefs.sort?.dir === "desc" ? "desc" : "asc",
  };
}

async function loadDatasetTablePreferences() {
  if (!projectName || datasetTablePreferencesLoaded) {
    datasetTablePreferencesLoaded = true;
    return;
  }
  try {
    const prefs = await loadProjectUserPreferences(projectName);
    applyDatasetTablePreferences(getDatasetTablePreferencesSource(prefs));
  } catch (err) {
    console.warn("Failed to load project instance dataset table preferences:", err);
  } finally {
    datasetTablePreferencesLoaded = true;
  }
}

function getDfmWindowKey(datasetName, path = selectedPath) {
  return `dfm\u0001${normalizePath(path)}\u0001${toText(datasetName).toLowerCase()}`;
}

function getWindowPath(frame) {
  return normalizePath(frame?.dataset?.windowPath || "");
}

function isWindowOnSelectedPath(frame) {
  const windowPath = getWindowPath(frame);
  const currentPath = normalizePath(selectedPath);
  return !!windowPath && !!currentPath && windowPath.toLowerCase() === currentPath.toLowerCase();
}

function getWindowFullTitle(frame) {
  return toText(frame?.dataset?.windowTitle || frame?.getAttribute?.("aria-label") || frame?.dataset?.windowDatasetName || "Dataset");
}

function getWindowShortTitle(frame) {
  return toText(frame?.dataset?.windowDatasetName || frame?.dataset?.windowItemName || getWindowFullTitle(frame));
}

function updateDatasetWindowTitle(frame) {
  if (!frame) return;
  const fullTitle = getWindowFullTitle(frame);
  const displayTitle = isWindowOnSelectedPath(frame) ? getWindowShortTitle(frame) : fullTitle;
  const titleEl = frame.querySelector?.(".pi-window-title");
  if (titleEl) {
    titleEl.textContent = displayTitle;
    titleEl.removeAttribute("title");
  }
  frame.dataset.windowDisplayTitle = displayTitle;
  frame.setAttribute("aria-label", fullTitle);
}

function syncDatasetWindowChrome() {
  const active = getActiveDatasetWindow();
  for (const frame of datasetWindows.values()) {
    if (!frame?.isConnected) continue;
    const visible = frame.dataset.hidden !== "1" && frame.style.display !== "none";
    frame.classList.toggle("active", visible && frame === active);
    updateDatasetWindowTitle(frame);
  }
}

function getFrameRect(frame) {
  return {
    x: Number.parseFloat(frame.style.left) || 0,
    y: Number.parseFloat(frame.style.top) || 0,
    width: Number.parseFloat(frame.style.width) || frame.getBoundingClientRect().width || DATASET_WINDOW_MIN_WIDTH,
    height: Number.parseFloat(frame.style.height) || frame.getBoundingClientRect().height || DATASET_WINDOW_MIN_HEIGHT,
  };
}

function getProjectInstanceWindowSnapshot(frame) {
  if (!frame?.isConnected) return null;
  const kind = isDfmWindow(frame) ? "dfm" : "dataset";
  const name = toText(frame.dataset.windowItemName || frame.dataset.windowDatasetName || "");
  if (!name) return null;
  const active = getActiveDatasetWindow() === frame;
  const hiddenItem = hiddenWindows.get(frame.dataset.windowId || "");
  return {
    kind,
    name,
    title: toText(frame.dataset.windowTitle || frame.getAttribute("aria-label") || name),
    hidden: frame.dataset.hidden === "1" || frame.style.display === "none",
    active,
    maximized: frame.dataset.maximized === "1",
    dirty: frame.dataset.dirty === "1",
    dfmTab: kind === "dfm" ? toText(frame.dataset.dfmTab || "") : "",
    rect: hiddenItem?.restoreRect || getFrameRect(frame),
  };
}

function buildProjectInstanceStateSnapshot() {
  const windows = [];
  for (const frame of datasetWindows.values()) {
    const snapshot = getProjectInstanceWindowSnapshot(frame);
    if (snapshot) windows.push(snapshot);
  }
  windows.sort((a, b) => {
    if (a.active && !b.active) return -1;
    if (b.active && !a.active) return 1;
    return a.title.localeCompare(b.title);
  });
  const active = windows.find((item) => item.active);
  const state = {
    selectedPath,
    windows,
  };
  if (active) state.activeWindow = { kind: active.kind, name: active.name };
  return state;
}

function notifyProjectInstanceStateChanged() {
  try {
    window.parent?.postMessage({
      type: "arcrho:project-instance-state",
      state: buildProjectInstanceStateSnapshot(),
    }, "*");
  } catch {}
}

function clearHiddenTabsHoverCloseTimer() {
  if (!hiddenTabsHoverCloseTimer) return;
  window.clearTimeout(hiddenTabsHoverCloseTimer);
  hiddenTabsHoverCloseTimer = 0;
}

function setHiddenTabsMenuOpen(open, { pinned = hiddenTabsMenuPinned } = {}) {
  if (!els.hiddenTabsWrap || !els.hiddenTabsButton) return;
  if (open) clearHiddenTabsHoverCloseTimer();
  hiddenTabsMenuPinned = !!open && !!pinned;
  els.hiddenTabsWrap.classList.toggle("open", !!open);
  els.hiddenTabsButton.setAttribute("aria-expanded", open ? "true" : "false");
}

function scheduleHiddenTabsHoverClose() {
  if (hiddenTabsMenuPinned) return;
  clearHiddenTabsHoverCloseTimer();
  hiddenTabsHoverCloseTimer = window.setTimeout(() => {
    hiddenTabsHoverCloseTimer = 0;
    if (els.hiddenTabsWrap?.matches?.(":hover") || els.hiddenTabsMenu?.matches?.(":hover")) return;
    setHiddenTabsMenuOpen(false, { pinned: false });
  }, HIDDEN_TABS_HOVER_CLOSE_MS);
}

function ensureMinimizedTabTooltip() {
  if (minimizedTabTooltip?.isConnected) return minimizedTabTooltip;
  minimizedTabTooltip = document.createElement("div");
  minimizedTabTooltip.className = "pi-minimized-tab-tooltip";
  minimizedTabTooltip.setAttribute("role", "tooltip");
  minimizedTabTooltip.setAttribute("aria-hidden", "true");
  document.body.appendChild(minimizedTabTooltip);
  return minimizedTabTooltip;
}

function positionMinimizedTabTooltip(tab) {
  if (!minimizedTabTooltip?.classList?.contains("active") || !tab?.getBoundingClientRect) return;
  const rect = tab.getBoundingClientRect();
  const tooltipRect = minimizedTabTooltip.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - tooltipRect.width - 8, rect.left + (rect.width - tooltipRect.width) / 2));
  const top = Math.max(8, rect.bottom + 8);
  minimizedTabTooltip.style.left = `${Math.round(left)}px`;
  minimizedTabTooltip.style.top = `${Math.round(top)}px`;
}

function showMinimizedTabTooltip(tab, text) {
  const tooltipText = toText(text);
  if (!tooltipText) return;
  const tooltip = ensureMinimizedTabTooltip();
  tooltip.textContent = tooltipText;
  tooltip.setAttribute("aria-hidden", "false");
  tooltip.classList.add("active");
  window.requestAnimationFrame(() => positionMinimizedTabTooltip(tab));
}

function hideMinimizedTabTooltip() {
  if (!minimizedTabTooltip) return;
  minimizedTabTooltip.classList.remove("active");
  minimizedTabTooltip.setAttribute("aria-hidden", "true");
}

function updateHiddenTabsArea() {
  const count = hiddenWindows.size;
  hideMinimizedTabTooltip();
  if (els.hiddenTabsLabel) {
    els.hiddenTabsLabel.textContent = `${count} hidden`;
  }
  if (els.hiddenTabsList) {
    els.hiddenTabsList.innerHTML = "";
    for (const [id, item] of hiddenWindows) {
      const fullTitle = item.fullTitle || item.title;
      const tab = document.createElement("div");
      tab.className = "pi-minimized-tab";
      tab.classList.toggle("dirty", item.frame?.dataset?.dirty === "1");
      tab.dataset.windowId = id;
      tab.dataset.fullTitle = fullTitle;
      tab.addEventListener("mouseenter", () => showMinimizedTabTooltip(tab, fullTitle));
      tab.addEventListener("mousemove", () => positionMinimizedTabTooltip(tab));
      tab.addEventListener("mouseleave", hideMinimizedTabTooltip);
      tab.addEventListener("focusin", () => showMinimizedTabTooltip(tab, fullTitle));
      tab.addEventListener("focusout", hideMinimizedTabTooltip);
      const restoreBtn = document.createElement("button");
      restoreBtn.type = "button";
      restoreBtn.className = "pi-minimized-tab-restore";
      restoreBtn.setAttribute("aria-label", item.title);
      restoreBtn.textContent = item.title;
      restoreBtn.addEventListener("click", () => restoreHiddenWindow(id));
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "pi-minimized-tab-close";
      closeBtn.title = `Close ${item.title}`;
      closeBtn.setAttribute("aria-label", `Close ${item.title}`);
      closeBtn.textContent = "x";
      closeBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeHiddenWindow(id);
      });
      tab.append(restoreBtn, closeBtn);
      els.hiddenTabsList.appendChild(tab);
    }
  }
  if (!els.hiddenTabsMenu) return;
  els.hiddenTabsMenu.innerHTML = "";
  const actions = document.createElement("div");
  actions.className = "pi-hidden-tabs-actions";
  const resumeAllBtn = document.createElement("button");
  resumeAllBtn.type = "button";
  resumeAllBtn.className = "pi-hidden-tabs-action";
  resumeAllBtn.textContent = "Resume all tabs";
  resumeAllBtn.addEventListener("click", () => {
    void restoreAllHiddenWindows();
  });
  const closeAllBtn = document.createElement("button");
  closeAllBtn.type = "button";
  closeAllBtn.className = "pi-hidden-tabs-action danger";
  closeAllBtn.textContent = "Close all tabs";
  closeAllBtn.addEventListener("click", () => {
    closeAllHiddenWindows();
  });
  actions.append(resumeAllBtn, closeAllBtn);
  els.hiddenTabsMenu.appendChild(actions);
  if (!count) {
    const empty = document.createElement("div");
    empty.className = "pi-hidden-tabs-empty";
    empty.textContent = "No hidden tabs.";
    els.hiddenTabsMenu.appendChild(empty);
    return;
  }
  for (const [id, item] of hiddenWindows) {
    const row = document.createElement("div");
    row.className = "pi-hidden-tab-row";
    row.classList.toggle("dirty", item.frame?.dataset?.dirty === "1");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pi-hidden-tab-item";
    button.setAttribute("role", "menuitem");
    const fullTitle = item.fullTitle || item.title;
    button.title = fullTitle;
    button.innerHTML = `
      <svg class="pi-hidden-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="5" y="5" width="14" height="14" rx="2"></rect>
        <path d="M9 9h6"></path>
        <path d="M9 13h6"></path>
      </svg>
      <span class="pi-hidden-tab-name"></span>
    `;
    button.querySelector(".pi-hidden-tab-name").textContent = fullTitle;
    button.addEventListener("click", () => restoreHiddenWindow(id));
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "pi-hidden-tab-delete";
    deleteBtn.title = `Close ${fullTitle}`;
    deleteBtn.setAttribute("aria-label", `Close ${fullTitle}`);
    deleteBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 7h16"></path>
        <path d="M10 11v6"></path>
        <path d="M14 11v6"></path>
        <path d="M6 7l1 13h10l1-13"></path>
        <path d="M9 7V5h6v2"></path>
      </svg>
    `;
    deleteBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeHiddenWindow(id);
    });
    row.append(button, deleteBtn);
    els.hiddenTabsMenu.appendChild(row);
  }
}

function isPointInHiddenDropZone(x, y) {
  const rootRect = els.root?.getBoundingClientRect?.();
  const layoutRect = els.layout?.getBoundingClientRect?.();
  if (!rootRect || !layoutRect) return false;
  return x >= rootRect.left && x <= rootRect.right && y >= rootRect.top && y < layoutRect.top;
}

function setHiddenDropActive(active, frame = null) {
  els.hiddenTabsWrap?.classList?.toggle("drop-active", !!active);
  els.hiddenDropBanner?.classList?.toggle("active", !!active);
  els.hiddenDropBanner?.setAttribute("aria-hidden", active ? "false" : "true");
  for (const highlighted of els.windowLayer?.querySelectorAll?.(".pi-window.drop-target-active") || []) {
    if (!active || highlighted !== frame) highlighted.classList.remove("drop-target-active");
  }
  frame?.classList?.toggle("drop-target-active", !!active);
}

function prefersReducedMotion() {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  } catch {
    return false;
  }
}

function getMinimizedTabElement(frameOrId) {
  const id = typeof frameOrId === "string" ? frameOrId : frameOrId?.dataset?.windowId || "";
  if (!id || !els.hiddenTabsList) return null;
  for (const tab of els.hiddenTabsList.querySelectorAll(".pi-minimized-tab")) {
    if (tab.dataset.windowId === id) return tab;
  }
  return null;
}

function getHiddenDockTargetRect(frameOrId = null) {
  const target = getMinimizedTabElement(frameOrId) || els.hiddenTabsButton || els.hiddenTabsWrap;
  const targetRect = target?.getBoundingClientRect?.();
  const rootRect = els.root?.getBoundingClientRect?.();
  if (!targetRect || !rootRect) return null;
  return {
    x: targetRect.left - rootRect.left,
    y: targetRect.top - rootRect.top,
    width: Math.max(1, targetRect.width),
    height: Math.max(1, targetRect.height),
  };
}

function getFrameTransformToRect(frameRect, targetRect) {
  const scaleX = Math.max(0.08, targetRect.width / Math.max(1, frameRect.width));
  const scaleY = Math.max(0.08, targetRect.height / Math.max(1, frameRect.height));
  return {
    x: targetRect.x - frameRect.x,
    y: targetRect.y - frameRect.y,
    scaleX,
    scaleY,
  };
}

async function animateWindowToDock(frame, dockRect = getHiddenDockTargetRect(frame)) {
  const frameRect = getFrameRect(frame);
  if (!dockRect || prefersReducedMotion() || typeof frame.animate !== "function") return;
  const transform = getFrameTransformToRect(frameRect, dockRect);
  frame.style.pointerEvents = "none";
  frame.style.transformOrigin = "top left";
  try {
    const animation = frame.animate(
      [
        {
          transform: "translate(0, 0) scale(1, 1)",
          opacity: 1,
          offset: 0,
        },
        {
          transform: `translate(${Math.round(transform.x * 0.72)}px, ${Math.round(transform.y * 0.34)}px) scale(0.72, 0.82)`,
          opacity: 0.86,
          offset: 0.52,
        },
        {
          transform: `translate(${Math.round(transform.x)}px, ${Math.round(transform.y)}px) scale(${transform.scaleX}, ${transform.scaleY})`,
          opacity: 0.08,
          offset: 1,
        },
      ],
      {
        duration: DATASET_WINDOW_DOCK_ANIMATION_MS,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      }
    );
    await animation.finished;
  } catch {
    // Best-effort visual polish only.
  } finally {
    frame.style.transformOrigin = "";
    frame.style.pointerEvents = "";
  }
}

async function animateWindowFromDock(frame, dockRect = getHiddenDockTargetRect(frame)) {
  const frameRect = getFrameRect(frame);
  if (!dockRect || prefersReducedMotion() || typeof frame.animate !== "function") return;
  const transform = getFrameTransformToRect(frameRect, dockRect);
  frame.style.pointerEvents = "none";
  frame.style.transformOrigin = "top left";
  try {
    const animation = frame.animate(
      [
        {
          transform: `translate(${Math.round(transform.x)}px, ${Math.round(transform.y)}px) scale(${transform.scaleX}, ${transform.scaleY})`,
          opacity: 0.08,
          offset: 0,
        },
        {
          transform: `translate(${Math.round(transform.x * 0.2)}px, ${Math.round(transform.y * 0.58)}px) scale(1.03, 0.96)`,
          opacity: 0.92,
          offset: 0.78,
        },
        {
          transform: "translate(0, 0) scale(1, 1)",
          opacity: 1,
          offset: 1,
        },
      ],
      {
        duration: DATASET_WINDOW_RESTORE_ANIMATION_MS,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      }
    );
    await animation.finished;
  } catch {
    // Best-effort visual polish only.
  } finally {
    frame.style.transformOrigin = "";
    frame.style.pointerEvents = "";
  }
}

async function hideDatasetWindow(frame, restoreRect) {
  const id = frame?.dataset?.windowId || "";
  if (!id) return;
  const title = frame.dataset.windowDatasetName || frame.dataset.windowTitle || frame.getAttribute("aria-label") || "Dataset";
  hiddenWindows.set(id, {
    frame,
    title,
    fullTitle: frame.dataset.windowTitle || frame.getAttribute("aria-label") || title,
    restoreRect: restoreRect || getFrameRect(frame),
  });
  frame.dataset.hidden = "1";
  if (activeDatasetWindow === frame) activeDatasetWindow = null;
  setHiddenDropActive(false, frame);
  syncDatasetWindowChrome();
  updateHiddenTabsArea();
  await animateWindowToDock(frame);
  frame.style.display = "none";
  notifyActiveDfmWindowState();
  notifyProjectInstanceStateChanged();
  setStatus(`Hidden ${title}`);
}

async function restoreHiddenWindow(id) {
  const item = hiddenWindows.get(id);
  if (!item?.frame) return;
  const dockRect = getHiddenDockTargetRect(id);
  hiddenWindows.delete(id);
  item.frame.dataset.hidden = "0";
  item.frame.style.display = "flex";
  applyWindowRect(item.frame, item.restoreRect || getFrameRect(item.frame));
  raiseWindow(item.frame);
  updateHiddenTabsArea();
  setHiddenTabsMenuOpen(hiddenWindows.size > 0);
  await animateWindowFromDock(item.frame, dockRect);
  notifyProjectInstanceStateChanged();
  setStatus(`Restored ${item.title}`);
}

function closeHiddenWindow(id) {
  const item = hiddenWindows.get(id);
  if (!item?.frame) return;
  const title = item.title || item.frame.dataset.windowTitle || "dataset window";
  closeDatasetWindow(item.frame, { status: false });
  if (!hiddenWindows.size) setHiddenTabsMenuOpen(false, { pinned: false });
  setStatus(`Closed ${title}`);
}

function closeAllHiddenWindows() {
  const ids = Array.from(hiddenWindows.keys());
  const count = ids.length;
  if (!count) return;
  const dirtyCount = ids.reduce((total, id) => {
    const frame = hiddenWindows.get(id)?.frame;
    return total + (frame?.dataset?.dirty === "1" ? 1 : 0);
  }, 0);
  if (dirtyCount) {
    const ok = window.confirm(`${dirtyCount} hidden DFM ${dirtyCount === 1 ? "window has" : "windows have"} unsaved changes. Close anyway?`);
    if (!ok) return;
  }
  for (const id of Array.from(hiddenWindows.keys())) {
    const item = hiddenWindows.get(id);
    if (!item?.frame) {
      hiddenWindows.delete(id);
      continue;
    }
    datasetWindows.delete(item.frame.dataset.windowKey || "");
    item.frame.remove();
    hiddenWindows.delete(id);
  }
  syncDatasetWindowChrome();
  updateHiddenTabsArea();
  setHiddenTabsMenuOpen(false, { pinned: false });
  notifyProjectInstanceDirtyState();
  notifyActiveDfmWindowState();
  notifyProjectInstanceStateChanged();
  setStatus(`Closed ${count} hidden ${count === 1 ? "tab" : "tabs"}`);
}

async function restoreAllHiddenWindows() {
  const ids = Array.from(hiddenWindows.keys());
  if (!ids.length) return;
  for (const id of ids) {
    await restoreHiddenWindow(id);
  }
  setHiddenTabsMenuOpen(false, { pinned: false });
}

async function activateDatasetWindow(frame) {
  if (!frame?.isConnected) return false;
  if (frame.dataset.hidden === "1" || frame.style.display === "none") {
    await restoreHiddenWindow(frame.dataset.windowId || "");
  } else {
    frame.style.display = "flex";
    raiseWindow(frame);
    setStatus(`Activated ${frame.dataset.windowTitle || frame.getAttribute("aria-label") || "dataset window"}`);
  }
  notifyProjectInstanceStateChanged();
  return true;
}

function getPageLoadingMessage() {
  const loadingPaths = pageLoadingTasks.has("paths");
  const loadingDatasets = pageLoadingTasks.has("datasets");
  if (loadingPaths && loadingDatasets) return "Loading reserving class paths and dataset types...";
  if (loadingPaths) return "Loading reserving class paths...";
  if (loadingDatasets) return "Loading dataset types...";
  return "Loading project contents...";
}

function updatePageLoadingText() {
  if (els.pageLoadingTitle) els.pageLoadingTitle.textContent = "Loading Project Instance";
  if (els.pageLoadingMessage) els.pageLoadingMessage.textContent = getPageLoadingMessage();
}

function stopPageLoadingTimer() {
  if (!pageLoadingFrameTimer) return;
  cancelAnimationFrame(pageLoadingFrameTimer);
  pageLoadingFrameTimer = 0;
}

function tickPageLoadingElapsed() {
  if (!els.pageLoadingOverlay?.classList?.contains("open")) {
    stopPageLoadingTimer();
    return;
  }
  const sec = (performance.now() - pageLoadingStartedAt) / 1000;
  if (els.pageLoadingElapsed) els.pageLoadingElapsed.textContent = `Elapsed: ${sec.toFixed(1)}s`;
  pageLoadingFrameTimer = requestAnimationFrame(tickPageLoadingElapsed);
}

function beginPageLoading(task) {
  if (!els.pageLoadingOverlay) return;
  const wasEmpty = pageLoadingTasks.size === 0;
  pageLoadingTasks.add(task);
  updatePageLoadingText();
  if (!wasEmpty) return;
  pageLoadingStartedAt = performance.now();
  if (els.pageLoadingElapsed) els.pageLoadingElapsed.textContent = "Elapsed: 0.0s";
  els.pageLoadingOverlay.classList.add("open");
  stopPageLoadingTimer();
  pageLoadingFrameTimer = requestAnimationFrame(tickPageLoadingElapsed);
}

function finishPageLoading(task) {
  if (!task) pageLoadingTasks.clear();
  else pageLoadingTasks.delete(task);
  updatePageLoadingText();
  if (pageLoadingTasks.size > 0) return;
  els.pageLoadingOverlay?.classList?.remove("open");
  stopPageLoadingTimer();
}

function setEmptyTable(message) {
  if (!els.datasetTableSurface) return;
  els.datasetTableSurface.innerHTML = "";
  syncDatasetActiveFiltersToolbar();
  const table = document.createElement("table");
  table.className = "pi-table";
  const tbody = document.createElement("tbody");
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.className = "pi-table-empty";
  td.colSpan = DATASET_COLUMNS;
  td.textContent = message;
  tr.appendChild(td);
  tbody.appendChild(tr);
  table.appendChild(tbody);
  els.datasetTableSurface.appendChild(table);
}

function getDatasetName(row) {
  return toText(row?.[0]);
}

function getMethodType(row) {
  if (!selectedPath) return "None";
  if (normalizePath(cachedDatasetFilter.loadedPath).toLowerCase() !== normalizePath(selectedPath).toLowerCase()) {
    return "None";
  }
  return cachedDatasetFilter.methodTypesByName.get(normalizeLookupKey(getDatasetName(row))) || "None";
}

function getCachedDatasetMetadata(row) {
  if (!hasCachedDatasetMetadataForSelectedPath()) return null;
  const key = getCachedDatasetKey(getDatasetName(row));
  return key ? cachedDatasetFilter.metadataByName.get(key) || null : null;
}

function getDatasetColumn(key) {
  return DATASET_TABLE_COLUMNS.find((col) => col.key === key) || null;
}

function getOrderedDatasetColumns() {
  const known = new Set(DATASET_TABLE_COLUMNS.map((col) => col.key));
  const ordered = datasetTableView.columns.filter((key) => known.has(key));
  for (const col of DATASET_TABLE_COLUMNS) {
    if (!ordered.includes(col.key)) ordered.push(col.key);
  }
  datasetTableView.columns = ordered;
  return ordered.map(getDatasetColumn).filter(Boolean);
}

function getDatasetGroupByKeys() {
  const raw = Array.isArray(datasetTableView.groupBy)
    ? datasetTableView.groupBy
    : [datasetTableView.groupBy];
  const allowed = new Set(["dataFormat", "category"]);
  const keys = [];
  for (const key of raw) {
    const normalized = toText(key);
    if (!allowed.has(normalized) || keys.includes(normalized)) continue;
    keys.push(normalized);
    if (keys.length >= 2) break;
  }
  datasetTableView.groupBy = keys;
  return keys;
}

function setDatasetGroupByKey(key) {
  const normalized = toText(key);
  if (!["dataFormat", "category"].includes(normalized)) return;
  const keys = getDatasetGroupByKeys();
  const next = keys.includes(normalized)
    ? keys.filter((item) => item !== normalized)
    : [...keys, normalized].slice(-2);
  datasetTableView.groupBy = next;
  datasetTableView.collapsedGroups.clear();
  closeDatasetTableContextMenu();
  saveDatasetTablePreferences();
  renderDatasetTable();
}

function getDatasetCellValue(row, key) {
  const datasetName = getDatasetName(row);
  switch (key) {
    case "name":
    case "datasetTypeName":
      return datasetName;
    case "dataFormat":
      return toText(row?.[1]);
    case "formula":
      return toText(row?.[4]);
    case "category":
      return toText(row?.[2]);
    case "methodType":
      return getMethodType(row);
    case "lastModified":
      return getCachedDatasetMetadata(row)?.lastModified || "";
    case "created":
      return getCachedDatasetMetadata(row)?.created || "";
    case "user":
      return getCachedDatasetMetadata(row)?.user || "";
    default:
      return "";
  }
}

function getDatasetFilterKey(value) {
  const text = toText(value);
  return text || DATASET_TABLE_BLANK_LABEL;
}

function compareTextValues(a, b) {
  return String(a || "").localeCompare(String(b || ""), undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

function buildDatasetRecord(row, rowIndex) {
  const values = {};
  for (const col of DATASET_TABLE_COLUMNS) {
    values[col.key] = getDatasetCellValue(row, col.key);
  }
  const datasetName = values.name || getDatasetName(row);
  return { row, rowIndex, datasetName, values };
}

function getDatasetRecordValue(record, key) {
  return toText(record?.values?.[key] ?? getDatasetCellValue(record?.row, key));
}

function isDfmDatasetRecord(record) {
  return normalizeLookupKey(getDatasetRecordValue(record, "methodType")) === "dfm";
}

function openDfmTabForDataset(record) {
  const datasetName = toText(record?.datasetName);
  if (!datasetName || !selectedPath) return;
  openDfmWindow(datasetName);
}

function recordSelectedDfmObject(methodName) {
  const name = toText(methodName);
  if (!projectName || !selectedPath || !name) return;
  scheduleProjectUserPreferencesSave(projectName, {
    lastReservingClassPath: selectedPath,
    dfmObject: {
      methodName: name,
      outputVector: name,
      updated_at: new Date().toISOString(),
    },
  });
}

function measureDatasetTableText(text) {
  if (!datasetTableMeasureCanvas) {
    datasetTableMeasureCanvas = document.createElement("canvas");
  }
  const ctx = datasetTableMeasureCanvas.getContext?.("2d");
  if (!ctx) return String(text || "").length * 7;
  ctx.font = "12px Segoe UI, Arial, sans-serif";
  return ctx.measureText(String(text || "")).width;
}

function clampInitialDatasetTableWidth(width, col) {
  const minWidth = col?.minWidth || 80;
  const measured = Math.ceil(Number(width) || minWidth);
  return Math.max(minWidth, Math.min(DATASET_TABLE_AUTOFIT_MAX_WIDTH, measured));
}

function getInitialDatasetTableColumnWidth(col, rows = datasetRows) {
  if (!col) return 120;
  let width = measureDatasetTableText(col.label) + DATASET_TABLE_AUTOFIT_HEADER_EXTRA_WIDTH;
  const sourceRows = Array.isArray(rows) ? rows : [];
  for (const row of sourceRows) {
    const value = getDatasetCellValue(row, col.key);
    if (!value) continue;
    width = Math.max(width, measureDatasetTableText(value) + DATASET_TABLE_AUTOFIT_CELL_EXTRA_WIDTH);
    if (width >= DATASET_TABLE_AUTOFIT_MAX_WIDTH) return DATASET_TABLE_AUTOFIT_MAX_WIDTH;
  }
  return clampInitialDatasetTableWidth(width, col);
}

function autoFitInitialDatasetTableWidths(rows = datasetRows) {
  for (const col of DATASET_TABLE_COLUMNS) {
    if (datasetTablePreferenceWidthKeys.has(col.key)) continue;
    datasetTableView.widths[col.key] = getInitialDatasetTableColumnWidth(col, rows);
  }
}

function buildDatasetTableRenderContext() {
  const records = datasetRows
    .map((row, rowIndex) => buildDatasetRecord(row, rowIndex))
    .filter((record) => record.datasetName)
    .filter((record) => !cachedDatasetFilter.enabled || isDatasetRecordCached(record));
  const optionsByKey = new Map();
  const selectionsByKey = new Map();

  for (const col of DATASET_TABLE_COLUMNS) {
    const seen = new Set();
    const options = [];
    for (const record of records) {
      const optionKey = getDatasetFilterKey(getDatasetRecordValue(record, col.key));
      if (seen.has(optionKey)) continue;
      seen.add(optionKey);
      options.push({
        key: optionKey,
        label: optionKey,
      });
    }
    options.sort((a, b) => {
      if (a.key === DATASET_TABLE_BLANK_LABEL) return 1;
      if (b.key === DATASET_TABLE_BLANK_LABEL) return -1;
      return compareTextValues(a.label, b.label);
    });
    optionsByKey.set(col.key, options);
    selectionsByKey.set(col.key, getDatasetFilterSelection(col.key, options));
  }

  return { records, optionsByKey, selectionsByKey };
}

function compareDatasetRecords(a, b) {
  const sortKey = toText(datasetTableView.sort?.key);
  const dir = datasetTableView.sort?.dir === "desc" ? -1 : 1;
  if (!getDatasetColumn(sortKey)) return (a?.rowIndex ?? 0) - (b?.rowIndex ?? 0);
  const cmp = compareTextValues(
    getDatasetRecordValue(a, sortKey),
    getDatasetRecordValue(b, sortKey)
  );
  if (cmp !== 0) return cmp * dir;
  return (a?.rowIndex ?? 0) - (b?.rowIndex ?? 0);
}

function sortDatasetRecords(records) {
  const list = Array.isArray(records) ? records.slice() : [];
  if (!getDatasetColumn(datasetTableView.sort?.key)) return list;
  return list.sort(compareDatasetRecords);
}

function toggleDatasetTableSort(key) {
  if (!getDatasetColumn(key)) return;
  const currentKey = toText(datasetTableView.sort?.key);
  const currentDir = datasetTableView.sort?.dir === "desc" ? "desc" : "asc";
  datasetTableView.sort = {
    key,
    dir: currentKey === key && currentDir === "asc" ? "desc" : "asc",
  };
  saveDatasetTablePreferences();
  renderDatasetTable();
}

function getSortIconSvg(dir) {
  const isDesc = dir === "desc";
  return isDesc
    ? `<svg class="pi-table-sort-icon" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M6 9.5L2.2 4h7.6L6 9.5z"></path></svg>`
    : `<svg class="pi-table-sort-icon" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M6 2.5L9.8 8H2.2L6 2.5z"></path></svg>`;
}

function getDatasetColumnOptions(key, context = null) {
  const cached = context?.optionsByKey?.get?.(key);
  if (cached) return cached;
  const seen = new Set();
  const options = [];
  for (const row of datasetRows) {
    const value = getDatasetCellValue(row, key);
    const optionKey = getDatasetFilterKey(value);
    if (seen.has(optionKey)) continue;
    seen.add(optionKey);
    options.push({
      key: optionKey,
      label: optionKey,
    });
  }
  options.sort((a, b) => {
    if (a.key === DATASET_TABLE_BLANK_LABEL) return 1;
    if (b.key === DATASET_TABLE_BLANK_LABEL) return -1;
    return compareTextValues(a.label, b.label);
  });
  return options;
}

function getDatasetFilterSelection(key, options = getDatasetColumnOptions(key)) {
  const optionKeys = new Set(options.map((opt) => opt.key));
  let selected = datasetTableView.filters.get(key);
  if (!(selected instanceof Set)) {
    selected = new Set();
    datasetTableView.filters.set(key, selected);
    return selected;
  }
  for (const selectedKey of Array.from(selected)) {
    if (!optionKeys.has(selectedKey)) selected.delete(selectedKey);
  }
  return selected;
}

function isDatasetColumnFilterActive(key, context = null) {
  const options = getDatasetColumnOptions(key, context);
  if (!options.length) return false;
  const selected = context?.selectionsByKey?.get?.(key) || getDatasetFilterSelection(key, options);
  if (!(selected instanceof Set) || selected.size === 0) return false;
  if (selected.size !== options.length) return true;
  return options.some((opt) => !selected.has(opt.key));
}

function rowMatchesDatasetTableFilters(record, context) {
  for (const col of DATASET_TABLE_COLUMNS) {
    const options = getDatasetColumnOptions(col.key, context);
    if (!options.length) continue;
    const selected = context?.selectionsByKey?.get?.(col.key) || getDatasetFilterSelection(col.key, options);
    if (!(selected instanceof Set) || selected.size === 0 || selected.size === options.length) continue;
    if (!selected.has(getDatasetFilterKey(getDatasetRecordValue(record, col.key)))) return false;
  }
  return true;
}

function getDatasetTableWidth(key) {
  const col = getDatasetColumn(key);
  const width = Number(datasetTableView.widths[key]);
  return Math.max(col?.minWidth || 80, Number.isFinite(width) ? width : col?.minWidth || 120);
}

function getDatasetTableTotalWidth() {
  return getOrderedDatasetColumns().reduce((sum, col) => sum + getDatasetTableWidth(col.key), 0);
}

function syncDatasetTableTotalWidth() {
  const width = Math.max(1, Math.round(getDatasetTableTotalWidth()));
  for (const table of els.datasetTableSurface?.querySelectorAll?.(".pi-table") || []) {
    table.style.width = `${width}px`;
    table.style.minWidth = `${width}px`;
  }
}

function setDatasetTableColumnWidth(key, width) {
  const col = getDatasetColumn(key);
  if (!col) return;
  const next = Math.max(col.minWidth || 80, Math.round(Number(width) || col.minWidth || 120));
  datasetTableView.widths[key] = next;
  for (const colEl of els.datasetTableSurface?.querySelectorAll?.(`col[data-col-key="${CSS.escape(key)}"]`) || []) {
    colEl.style.width = `${next}px`;
  }
  syncDatasetTableTotalWidth();
}

function getDatasetTableRecords(context) {
  const records = Array.isArray(context?.records) ? context.records : datasetRows.map((row, rowIndex) => buildDatasetRecord(row, rowIndex));
  return records.filter((item) => (
    item.datasetName
    && (!cachedDatasetFilter.enabled || isDatasetRecordCached(item))
    && rowMatchesDatasetTableFilters(item, context)
  ));
}

function clearDatasetColumnDragIndicators() {
  for (const header of els.datasetTableSurface?.querySelectorAll?.(".pi-table th.pi-col-drag-before, .pi-table th.pi-col-drag-after") || []) {
    header.classList.remove("pi-col-drag-before", "pi-col-drag-after");
  }
}

function updateDatasetColumnDragIndicator(targetHeader, sourceKey, targetKey) {
  clearDatasetColumnDragIndicators();
  if (!targetHeader || !sourceKey || !targetKey || sourceKey === targetKey) return;
  const columns = datasetTableView.columns.slice();
  const sourceIndex = columns.indexOf(sourceKey);
  const targetIndex = columns.indexOf(targetKey);
  if (sourceIndex < 0 || targetIndex < 0) return;
  targetHeader.classList.add(sourceIndex < targetIndex ? "pi-col-drag-after" : "pi-col-drag-before");
}

function createDatasetTableHeaderCell(col, colIndex, context = null) {
  const th = document.createElement("th");
  th.dataset.colKey = col.key;
  th.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types?.includes("text/x-pi-column")) return;
    event.preventDefault();
    updateDatasetColumnDragIndicator(th, event.dataTransfer?.getData("text/x-pi-column") || "", col.key);
  });
  th.addEventListener("dragleave", () => th.classList.remove("pi-col-drag-before", "pi-col-drag-after"));
  th.addEventListener("drop", (event) => {
    const sourceKey = event.dataTransfer?.getData("text/x-pi-column") || "";
    clearDatasetColumnDragIndicators();
    if (!sourceKey || sourceKey === col.key) return;
    event.preventDefault();
    moveDatasetTableColumn(sourceKey, col.key);
  });

  const cell = document.createElement("div");
  cell.className = "pi-table-header-cell";

  const label = document.createElement("span");
  label.className = "pi-table-col-label";
  label.title = "Click to sort. Drag to reorder columns.";
  label.draggable = true;
  const labelText = document.createElement("span");
  labelText.className = "pi-table-col-label-text";
  labelText.textContent = col.label;
  label.appendChild(labelText);
  const isSorted = datasetTableView.sort?.key === col.key;
  if (isSorted) {
    label.insertAdjacentHTML("beforeend", getSortIconSvg(datasetTableView.sort?.dir));
  }
  label.addEventListener("click", (event) => {
    if (datasetTableColumnDragStarted) return;
    event.preventDefault();
    event.stopPropagation();
    toggleDatasetTableSort(col.key);
  });
  label.addEventListener("dragstart", (event) => {
    datasetTableColumnDragStarted = true;
    event.dataTransfer?.setData("text/x-pi-column", col.key);
    event.dataTransfer.effectAllowed = "move";
  });
  label.addEventListener("dragend", () => {
    clearDatasetColumnDragIndicators();
    window.setTimeout(() => {
      datasetTableColumnDragStarted = false;
    }, 0);
  });
  cell.appendChild(label);

  const filterBtn = document.createElement("button");
  filterBtn.type = "button";
  filterBtn.className = "pi-table-filter-btn";
  filterBtn.title = `${col.label} Filter`;
  filterBtn.classList.toggle("active", isDatasetColumnFilterActive(col.key, context));
  filterBtn.innerHTML = `
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2 3h12L9.5 8v4l-3 1V8z"></path>
    </svg>
  `;
  filterBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleDatasetTableFilterPopover(col.key, filterBtn);
  });
  cell.appendChild(filterBtn);

  const resizer = document.createElement("div");
  resizer.className = "pi-table-col-resizer";
  resizer.title = "Resize column";
  resizer.addEventListener("mousedown", (event) => startDatasetTableColumnResize(event, col.key));
  resizer.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    autoFitDatasetTableColumn(col.key, colIndex);
  });
  cell.appendChild(resizer);
  th.appendChild(cell);
  return th;
}

function createDatasetRecordRow(item, columns) {
  datasetTableVisibleRecords.push(item);
  const tr = document.createElement("tr");
  const recordKey = getDatasetRecordKey(item);
  if (recordKey) {
    tr.dataset.recordKey = recordKey;
    tr.classList.toggle("selected", datasetTableSelection.selectedKeys.has(recordKey));
    tr.setAttribute("aria-selected", datasetTableSelection.selectedKeys.has(recordKey) ? "true" : "false");
  }
  for (const col of columns) {
    const value = getDatasetRecordValue(item, col.key);
    const td = document.createElement("td");
    const text = document.createElement("span");
    text.className = "pi-table-cell-text";
    text.textContent = value;
    td.appendChild(text);
    tr.appendChild(td);
  }
  tr.addEventListener("dblclick", () => {
    if (isDfmDatasetRecord(item)) {
      openDfmTabForDataset(item);
      return;
    }
    openDatasetWindow(item.datasetName);
  });
  tr.addEventListener("click", (event) => {
    applyDatasetRowSelection(item, event);
    focusDatasetTableSurface();
  });
  tr.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!recordKey) return;
    if (!datasetTableSelection.selectedKeys.has(recordKey)) {
      datasetTableSelection.selectedKeys.clear();
      datasetTableSelection.selectedKeys.add(recordKey);
      datasetTableSelection.anchorKey = recordKey;
      syncDatasetTableSelectionDom();
    }
    focusDatasetTableSurface();
    showDatasetRowContextMenu(recordKey, event.clientX, event.clientY);
  });
  return tr;
}

function getDatasetGroupId(parts) {
  return JSON.stringify(parts.map((part) => [part.key, part.valueKey]));
}

function createDatasetGroupRow(part, depth, columns) {
  const groupId = getDatasetGroupId(part.path);
  const collapsed = datasetTableView.collapsedGroups.has(groupId);
  const tr = document.createElement("tr");
  tr.className = `pi-table-group-row depth-${Math.min(1, depth)}`;
  tr.classList.toggle("collapsed", collapsed);
  tr.dataset.groupId = groupId;
  const td = document.createElement("td");
  td.colSpan = columns.length;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pi-table-group-button";
  btn.innerHTML = `
    <svg class="pi-table-group-caret" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M3.2 4.2h5.6L6 7.7z"></path>
    </svg>
    <span class="pi-table-group-text"></span>
  `;
  const text = btn.querySelector(".pi-table-group-text");
  if (text) {
    text.textContent = `${part.label}: ${part.valueLabel}`;
  }
  if (depth === 0) {
    const count = document.createElement("span");
    count.className = "pi-table-group-count";
    count.textContent = String(part.records.length);
    count.title = `${part.records.length} records`;
    btn.appendChild(count);
  }
  btn.addEventListener("click", () => {
    if (datasetTableView.collapsedGroups.has(groupId)) datasetTableView.collapsedGroups.delete(groupId);
    else datasetTableView.collapsedGroups.add(groupId);
    saveDatasetTablePreferences();
    renderDatasetTable();
  });
  btn.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    showDatasetGroupContextMenu(groupId, event.clientX, event.clientY);
  });
  td.appendChild(btn);
  tr.appendChild(td);
  return tr;
}

function buildDatasetGroupParts(records, groupKeys, depth = 0, path = []) {
  const groupKey = groupKeys[depth];
  const col = getDatasetColumn(groupKey);
  if (!col) return [];
  const groups = new Map();
  for (const record of records) {
    const valueKey = getDatasetFilterKey(getDatasetRecordValue(record, groupKey));
    if (!groups.has(valueKey)) groups.set(valueKey, []);
    groups.get(valueKey).push(record);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => {
      if (a === DATASET_TABLE_BLANK_LABEL) return 1;
      if (b === DATASET_TABLE_BLANK_LABEL) return -1;
      return compareTextValues(a, b);
    })
    .map(([valueKey, groupRecords]) => ({
      key: groupKey,
      label: col.label,
      valueKey,
      valueLabel: valueKey,
      records: groupRecords,
      path: [...path, { key: groupKey, valueKey }],
    }));
}

function appendGroupedDatasetRows(tbody, records, groupKeys, columns, depth = 0, path = []) {
  if (depth >= groupKeys.length) {
    for (const item of sortDatasetRecords(records)) {
      tbody.appendChild(createDatasetRecordRow(item, columns));
    }
    return;
  }
  for (const part of buildDatasetGroupParts(records, groupKeys, depth, path)) {
    tbody.appendChild(createDatasetGroupRow(part, depth, columns));
    const groupId = getDatasetGroupId(part.path);
    if (datasetTableView.collapsedGroups.has(groupId)) continue;
    appendGroupedDatasetRows(tbody, part.records, groupKeys, columns, depth + 1, part.path);
  }
}

function createDatasetTable(records, context = null) {
  datasetTableVisibleRecords = [];
  const group = document.createElement("div");
  group.className = "pi-table-group";

  const table = document.createElement("table");
  table.className = "pi-table";
  const tableWidth = Math.max(1, Math.round(getDatasetTableTotalWidth()));
  table.style.width = `${tableWidth}px`;
  table.style.minWidth = `${tableWidth}px`;
  const colgroup = document.createElement("colgroup");
  const columns = getOrderedDatasetColumns();
  columns.forEach((col) => {
    const colEl = document.createElement("col");
    colEl.dataset.colKey = col.key;
    colEl.style.width = `${getDatasetTableWidth(col.key)}px`;
    colgroup.appendChild(colEl);
  });
  table.appendChild(colgroup);

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  columns.forEach((col, colIndex) => headerRow.appendChild(createDatasetTableHeaderCell(col, colIndex, context)));
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  if (!records.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.className = "pi-table-empty";
    td.colSpan = columns.length;
    td.textContent = cachedDatasetFilter.enabled
      ? "No cached datasets match the selected table filters."
      : "No rows for selected filters.";
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    const groupKeys = getDatasetGroupByKeys();
    if (groupKeys.length) appendGroupedDatasetRows(tbody, records, groupKeys, columns);
    else for (const item of sortDatasetRecords(records)) tbody.appendChild(createDatasetRecordRow(item, columns));
  }
  syncDatasetActiveFiltersToolbar(context);
  pruneDatasetTableSelection();
  syncDatasetTableSelectionDom();
  table.appendChild(tbody);
  group.appendChild(table);
  return group;
}

function moveDatasetTableColumn(sourceKey, targetKey) {
  const columns = datasetTableView.columns.slice();
  const from = columns.indexOf(sourceKey);
  const to = columns.indexOf(targetKey);
  if (from < 0 || to < 0 || from === to) return;
  columns.splice(from, 1);
  columns.splice(to, 0, sourceKey);
  datasetTableView.columns = columns;
  saveDatasetTablePreferences();
  renderDatasetTable();
}

function startDatasetTableColumnResize(event, key) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  closeDatasetTableFilterPopover();
  const startX = event.clientX;
  const startWidth = getDatasetTableWidth(key);
  document.body.classList.add("pi-resizing-table-column");

  const onMove = (moveEvent) => {
    setDatasetTableColumnWidth(key, startWidth + moveEvent.clientX - startX);
  };
  const onUp = () => {
    document.body.classList.remove("pi-resizing-table-column");
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mouseup", onUp, true);
    datasetTablePreferenceWidthKeys.add(key);
    saveDatasetTablePreferences();
  };
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("mouseup", onUp, true);
}

function autoFitDatasetTableColumn(key, colIndex) {
  const col = getDatasetColumn(key);
  if (!col) return;
  let width = col.minWidth || 80;
  const rows = els.datasetTableSurface?.querySelectorAll?.(".pi-table tbody tr") || [];
  for (const tr of rows) {
    const td = tr.children[colIndex];
    if (!td || td.classList.contains("pi-table-empty")) continue;
    width = Math.max(
      width,
      Math.min(
        DATASET_TABLE_AUTOFIT_MAX_WIDTH,
        measureDatasetTableText(td.textContent || "") + DATASET_TABLE_AUTOFIT_CELL_EXTRA_WIDTH
      )
    );
  }
  width = Math.max(
    width,
    Math.min(
      DATASET_TABLE_AUTOFIT_MAX_WIDTH,
      measureDatasetTableText(col.label) + DATASET_TABLE_AUTOFIT_HEADER_EXTRA_WIDTH
    )
  );
  setDatasetTableColumnWidth(key, width);
  datasetTablePreferenceWidthKeys.add(key);
  saveDatasetTablePreferences();
}

function renderDatasetTable() {
  if (!els.datasetTableSurface) return;
  datasetTableVisibleRecords = [];
  if (!datasetRows.length) {
    cachedDatasetFilter.visibleCount = 0;
    syncCachedDatasetToolbar();
    els.datasetTableSurface.innerHTML = "";
    pruneDatasetTableSelection();
    setEmptyTable("No dataset types are defined for this project.");
    return;
  }
  if (cachedDatasetFilter.enabled && !selectedPath) {
    cachedDatasetFilter.visibleCount = 0;
    syncCachedDatasetToolbar();
    els.datasetTableSurface.innerHTML = "";
    pruneDatasetTableSelection();
    setEmptyTable("Select a reserving class path to show cached datasets.");
    return;
  }
  if (selectedPath) {
    if (cachedDatasetFilter.loading) {
      cachedDatasetFilter.visibleCount = 0;
      syncCachedDatasetToolbar();
      els.datasetTableSurface.innerHTML = "";
      pruneDatasetTableSelection();
      setEmptyTable("Loading cached dataset list...");
      return;
    }
    if (cachedDatasetFilter.error) {
      cachedDatasetFilter.visibleCount = 0;
      syncCachedDatasetToolbar();
      els.datasetTableSurface.innerHTML = "";
      pruneDatasetTableSelection();
      setEmptyTable(cachedDatasetFilter.error);
      return;
    }
    if (!shouldUseCachedDatasetFilter()) {
      void loadCachedDatasetFilterForSelectedPath();
      cachedDatasetFilter.visibleCount = 0;
      syncCachedDatasetToolbar();
      els.datasetTableSurface.innerHTML = "";
      pruneDatasetTableSelection();
      setEmptyTable("Loading cached dataset list...");
      return;
    }
    if (cachedDatasetFilter.enabled && cachedDatasetFilter.names.size === 0) {
      cachedDatasetFilter.visibleCount = 0;
      syncCachedDatasetToolbar();
      els.datasetTableSurface.innerHTML = "";
      pruneDatasetTableSelection();
      setEmptyTable("No dataset found in this path.");
      return;
    }
  }

  const context = buildDatasetTableRenderContext();
  const records = getDatasetTableRecords(context);
  cachedDatasetFilter.visibleCount = records.filter(isDatasetRecordCached).length;
  syncCachedDatasetToolbar();
  if (!records.length) {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(createDatasetTable([], context));
    els.datasetTableSurface.replaceChildren(fragment);
    return;
  }

  const fragment = document.createDocumentFragment();
  fragment.appendChild(createDatasetTable(records, context));
  els.datasetTableSurface.replaceChildren(fragment);
}

function positionFixedMenu(el, x, y) {
  if (!el) return;
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
  const rect = el.getBoundingClientRect();
  const pad = 8;
  const left = Math.max(pad, Math.min(rect.left, window.innerWidth - rect.width - pad));
  const top = Math.max(pad, Math.min(rect.top, window.innerHeight - rect.height - pad));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function closeDatasetTableContextMenu() {
  els.datasetTableContextMenu?.classList?.remove("open");
  els.datasetTableContextMenu?.setAttribute("aria-hidden", "true");
}

function closeDatasetGroupContextMenu() {
  els.datasetGroupContextMenu?.classList?.remove("open");
  els.datasetGroupContextMenu?.setAttribute("aria-hidden", "true");
  datasetGroupContextId = "";
}

function closeDatasetRowContextMenu() {
  els.datasetRowContextMenu?.classList?.remove("open");
  els.datasetRowContextMenu?.setAttribute("aria-hidden", "true");
  datasetRowContextKey = "";
}

function showDatasetTableContextMenu(x, y) {
  const menu = els.datasetTableContextMenu;
  if (!menu) return;
  closeDatasetTableFilterPopover();
  closeDatasetGroupContextMenu();
  closeDatasetRowContextMenu();
  const groupKeys = getDatasetGroupByKeys();
  for (const item of menu.querySelectorAll("[data-group-key]")) {
    item.classList.toggle("active", groupKeys.includes(toText(item.dataset.groupKey)));
  }
  menu.classList.add("open");
  menu.setAttribute("aria-hidden", "false");
  positionFixedMenu(menu, x, y);
}

function showDatasetGroupContextMenu(groupId, x, y) {
  const menu = els.datasetGroupContextMenu;
  if (!menu || !groupId) return;
  datasetGroupContextId = groupId;
  closeDatasetTableContextMenu();
  closeDatasetRowContextMenu();
  closeDatasetTableFilterPopover();
  menu.classList.add("open");
  menu.setAttribute("aria-hidden", "false");
  positionFixedMenu(menu, x, y);
}

function showDatasetRowContextMenu(recordKey, x, y) {
  const menu = els.datasetRowContextMenu;
  if (!menu || !recordKey) return;
  datasetRowContextKey = recordKey;
  closeDatasetTableContextMenu();
  closeDatasetGroupContextMenu();
  closeDatasetTableFilterPopover();
  const selectedCount = getSelectedDatasetRecords().length;
  const deleteItem = menu.querySelector("[data-row-action='delete']");
  if (deleteItem) deleteItem.disabled = selectedCount === 0;
  menu.classList.add("open");
  menu.setAttribute("aria-hidden", "false");
  positionFixedMenu(menu, x, y);
}

function parseDatasetGroupId(groupId) {
  try {
    const parsed = JSON.parse(groupId);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        key: toText(Array.isArray(item) ? item[0] : item?.key),
        valueKey: toText(Array.isArray(item) ? item[1] : item?.valueKey),
      }))
      .filter((item) => item.key && item.valueKey);
  } catch {
    return [];
  }
}

function collectDatasetSameLevelGroupIds(records, groupKeys, depth, targetDepth, path, out) {
  if (depth > targetDepth || depth >= groupKeys.length) return;
  for (const part of buildDatasetGroupParts(records, groupKeys, depth, path)) {
    const id = getDatasetGroupId(part.path);
    if (depth === targetDepth) out.push(id);
    else collectDatasetSameLevelGroupIds(part.records, groupKeys, depth + 1, targetDepth, part.path, out);
  }
}

function getDatasetSameLevelGroupIds(groupId) {
  const path = parseDatasetGroupId(groupId);
  if (!path.length) return [];
  const groupKeys = getDatasetGroupByKeys();
  const targetDepth = path.length - 1;
  if (targetDepth < 0 || targetDepth >= groupKeys.length) return [];
  const context = buildDatasetTableRenderContext();
  const records = getDatasetTableRecords(context);
  const ids = [];
  collectDatasetSameLevelGroupIds(records, groupKeys, 0, targetDepth, [], ids);
  return ids;
}

function applyDatasetGroupContextAction(action) {
  const ids = getDatasetSameLevelGroupIds(datasetGroupContextId);
  if (action === "collapse-all") {
    for (const id of ids) datasetTableView.collapsedGroups.add(id);
  } else if (action === "expand-all") {
    for (const id of ids) datasetTableView.collapsedGroups.delete(id);
  }
  closeDatasetGroupContextMenu();
  saveDatasetTablePreferences();
  renderDatasetTable();
}

function openDatasetRecord(record) {
  if (!record) return;
  if (isDfmDatasetRecord(record)) {
    openDfmTabForDataset(record);
    return;
  }
  openDatasetWindow(record.datasetName);
}

function getDatasetRowActionRecords() {
  const contextRecord = getDatasetRecordByKey(datasetRowContextKey);
  const selectedRecords = getSelectedDatasetRecords();
  if (contextRecord && selectedRecords.some((record) => getDatasetRecordKey(record) === datasetRowContextKey)) {
    return selectedRecords;
  }
  return contextRecord ? [contextRecord] : selectedRecords;
}

function getDatasetRowViewRecord() {
  return getDatasetRecordByKey(datasetRowContextKey) || getSelectedDatasetRecords()[0] || null;
}

function resolveDatasetDeleteConfirm(value) {
  const overlay = els.datasetDeleteConfirmOverlay;
  const resolve = datasetDeleteConfirmResolve;
  datasetDeleteConfirmResolve = null;
  overlay?.setAttribute("hidden", "");
  if (resolve) resolve(!!value);
}

function showDatasetDeleteConfirm(records) {
  if (datasetDeleteConfirmResolve) return Promise.resolve(false);
  const names = records.map((record) => toText(record?.datasetName)).filter(Boolean);
  if (!names.length) return Promise.resolve(false);
  const countText = names.length === 1 ? "1 selected dataset" : `${names.length} selected datasets`;
  if (els.datasetDeleteConfirmMessage) {
    els.datasetDeleteConfirmMessage.textContent = `Delete cached files related to ${countText} for the selected reserving-class path?`;
  }
  if (els.datasetDeleteConfirmList) {
    els.datasetDeleteConfirmList.replaceChildren();
    for (const name of names.slice(0, 8)) {
      const item = document.createElement("div");
      item.className = "pi-delete-confirm-item";
      item.textContent = name;
      els.datasetDeleteConfirmList.appendChild(item);
    }
    if (names.length > 8) {
      const more = document.createElement("div");
      more.className = "pi-delete-confirm-more";
      more.textContent = `+${names.length - 8} more`;
      els.datasetDeleteConfirmList.appendChild(more);
    }
  }
  if (els.datasetDeleteConfirmBox) {
    els.datasetDeleteConfirmBox.style.left = "50%";
    els.datasetDeleteConfirmBox.style.top = "50%";
    els.datasetDeleteConfirmBox.style.transform = "translate(-50%, -50%)";
  }
  els.datasetDeleteConfirmOverlay?.removeAttribute("hidden");
  els.datasetDeleteConfirmDelete?.focus?.();
  return new Promise((resolve) => {
    datasetDeleteConfirmResolve = resolve;
  });
}

async function deleteSelectedDatasetRows(records) {
  const names = records.map((record) => toText(record?.datasetName)).filter(Boolean);
  if (!projectName || !selectedPath || !names.length) return;
  const confirmed = await showDatasetDeleteConfirm(records);
  if (!confirmed) return;
  setStatus(`Deleting cached files for ${names.length === 1 ? names[0] : `${names.length} datasets`}...`);
  try {
    const resp = await fetch("/datasets/cached/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: projectName,
        reserving_class: selectedPath,
        dataset_names: names,
      }),
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || payload?.ok === false) {
      throw new Error(payload?.detail || payload?.message || `Delete failed (${resp.status})`);
    }
    datasetTableSelection.selectedKeys.clear();
    datasetTableSelection.anchorKey = "";
    activePathFolderWatch.noticeShown = false;
    activePathFolderWatch.path = normalizePath(selectedPath);
    activePathFolderWatch.signature = "";
    activePathFolderWatch.instanceSignature = "";
    syncDiskChangeToolbarAlert();
    await loadCachedDatasetFilterForSelectedPath();
    renderDatasetTable();
    const deletedCount = Number(payload?.deleted_count || 0);
    setStatus(
      deletedCount
        ? `Deleted ${deletedCount} cached ${deletedCount === 1 ? "file" : "files"}.`
        : "No matching cached files were found."
    );
  } catch (err) {
    setStatus(toText(err?.message) || "Failed to delete cached dataset files.", true);
  }
}

function applyDatasetRowContextAction(action) {
  const normalized = toText(action);
  const records = getDatasetRowActionRecords();
  const viewRecord = getDatasetRowViewRecord();
  closeDatasetRowContextMenu();
  if (normalized === "view") {
    openDatasetRecord(viewRecord);
  } else if (normalized === "add") {
    setStatus("Add dataset is not available yet.");
  } else if (normalized === "delete") {
    void deleteSelectedDatasetRows(records);
  }
}

function closeDatasetTableFilterPopover() {
  const pop = els.datasetTableFilterPopover;
  if (!pop) return;
  pop.classList.remove("open");
  pop.setAttribute("aria-hidden", "true");
  pop.innerHTML = "";
  datasetTableFilterColumn = "";
  datasetTableFilterAnchor = null;
}

function positionDatasetTableFilterPopover() {
  const pop = els.datasetTableFilterPopover;
  const anchor = datasetTableFilterAnchor;
  if (!pop?.classList?.contains("open") || !anchor?.getBoundingClientRect) return;
  const rect = anchor.getBoundingClientRect();
  positionFixedMenu(pop, rect.left, rect.bottom + 6);
}

function openDatasetTableFilterPopover(key, anchor) {
  const col = getDatasetColumn(key);
  const pop = els.datasetTableFilterPopover;
  if (!col || !pop) return;
  closeDatasetTableContextMenu();
  closeDatasetGroupContextMenu();
  closeDatasetRowContextMenu();
  const options = getDatasetColumnOptions(key);
  const selected = getDatasetFilterSelection(key, options);
  pop.innerHTML = "";

  const title = document.createElement("div");
  title.className = "pi-table-filter-title";
  title.textContent = `${col.label} Filter`;
  pop.appendChild(title);

  const clearAllBtn = document.createElement("button");
  clearAllBtn.type = "button";
  clearAllBtn.className = "pi-table-filter-clear-all";
  clearAllBtn.textContent = "Clear All";
  clearAllBtn.disabled = selected.size === 0;
  clearAllBtn.addEventListener("click", () => {
    selected.clear();
    saveDatasetTablePreferences();
    renderDatasetTable();
    const nextAnchor = findDatasetFilterButton(key);
    if (nextAnchor) openDatasetTableFilterPopover(key, nextAnchor);
  });
  pop.appendChild(clearAllBtn);

  const list = document.createElement("div");
  list.className = "pi-table-filter-list";
  pop.appendChild(list);

  for (const opt of options) {
    const row = document.createElement("label");
    row.className = "pi-table-filter-option";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(opt.key);
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(opt.key);
      else selected.delete(opt.key);
      saveDatasetTablePreferences();
      renderDatasetTable();
      const nextAnchor = findDatasetFilterButton(key);
      if (nextAnchor) openDatasetTableFilterPopover(key, nextAnchor);
    });
    const text = document.createElement("span");
    text.textContent = opt.label;
    row.append(cb, text);
    list.appendChild(row);
  }

  if (!options.length) {
    const empty = document.createElement("div");
    empty.className = "pi-table-filter-empty";
    empty.textContent = "No values";
    list.appendChild(empty);
  }

  datasetTableFilterColumn = key;
  datasetTableFilterAnchor = anchor || findDatasetFilterButton(key);
  pop.classList.add("open");
  pop.setAttribute("aria-hidden", "false");
  positionDatasetTableFilterPopover();
}

function toggleDatasetTableFilterPopover(key, anchor) {
  const pop = els.datasetTableFilterPopover;
  if (
    pop?.classList?.contains("open")
    && datasetTableFilterColumn === key
  ) {
    closeDatasetTableFilterPopover();
    return;
  }
  openDatasetTableFilterPopover(key, anchor);
}

function findDatasetFilterButton(key) {
  const th = els.datasetTableSurface?.querySelector?.(`th[data-col-key="${CSS.escape(key)}"]`);
  return th?.querySelector?.(".pi-table-filter-btn") || null;
}

function initDatasetTableInteractions() {
  if (els.rightPanel?.dataset?.tableInteractionsWired === "1") return;
  if (els.rightPanel) els.rightPanel.dataset.tableInteractionsWired = "1";
  if (els.datasetTableSurface) {
    els.datasetTableSurface.tabIndex = 0;
    els.datasetTableSurface.addEventListener("keydown", handleDatasetTableKeyDown);
  }
  els.datasetTableSurface?.addEventListener("contextmenu", (event) => {
    if (!event.target?.closest?.(".pi-table thead th")) return;
    event.preventDefault();
    event.stopPropagation();
    showDatasetTableContextMenu(event.clientX, event.clientY);
  });
  els.datasetTableContextMenu?.addEventListener("click", (event) => {
    const item = event.target?.closest?.("[data-group-key]");
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    setDatasetGroupByKey(item.dataset.groupKey);
  });
  els.datasetGroupContextMenu?.addEventListener("click", (event) => {
    const item = event.target?.closest?.("[data-group-action]");
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    applyDatasetGroupContextAction(item.dataset.groupAction);
  });
  els.datasetRowContextMenu?.addEventListener("click", (event) => {
    const item = event.target?.closest?.("[data-row-action]");
    if (!item || item.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    applyDatasetRowContextAction(item.dataset.rowAction);
  });
  els.datasetActiveFilters?.addEventListener("click", (event) => {
    const close = event.target?.closest?.(".dataset-filter-chip-close");
    if (!close) return;
    event.preventDefault();
    event.stopPropagation();
    clearDatasetColumnFilter(close.dataset.filterKey);
  });
  els.datasetActiveFilters?.addEventListener("contextmenu", (event) => {
    const chip = event.target?.closest?.(".dataset-filter-chip");
    if (!chip) return;
    event.preventDefault();
    event.stopPropagation();
    clearDatasetColumnFilter(chip.dataset.filterKey);
  });
  document.addEventListener("mousedown", (event) => {
    if (els.datasetTableContextMenu?.contains(event.target)) return;
    if (els.datasetGroupContextMenu?.contains(event.target)) return;
    if (els.datasetRowContextMenu?.contains(event.target)) return;
    if (els.datasetTableFilterPopover?.contains(event.target)) return;
    if (event.target?.closest?.(".pi-table-filter-btn")) return;
    closeDatasetTableContextMenu();
    closeDatasetGroupContextMenu();
    closeDatasetRowContextMenu();
    closeDatasetTableFilterPopover();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!els.datasetDeleteConfirmOverlay?.hasAttribute?.("hidden")) {
      resolveDatasetDeleteConfirm(false);
    }
    closeDatasetTableContextMenu();
    closeDatasetGroupContextMenu();
    closeDatasetRowContextMenu();
    closeDatasetTableFilterPopover();
  }, true);
  window.addEventListener("resize", () => {
    closeDatasetTableContextMenu();
    closeDatasetGroupContextMenu();
    closeDatasetRowContextMenu();
    positionDatasetTableFilterPopover();
  });
  els.datasetTableWrap?.addEventListener("scroll", positionDatasetTableFilterPopover, true);
  initDatasetDeleteConfirmInteractions();
}

function initDatasetDeleteConfirmInteractions() {
  if (!els.datasetDeleteConfirmOverlay || els.datasetDeleteConfirmOverlay.dataset.wired === "1") return;
  els.datasetDeleteConfirmOverlay.dataset.wired = "1";
  els.datasetDeleteConfirmDelete?.addEventListener("click", () => resolveDatasetDeleteConfirm(true));
  els.datasetDeleteConfirmCancel?.addEventListener("click", () => resolveDatasetDeleteConfirm(false));
  els.datasetDeleteConfirmClose?.addEventListener("click", () => resolveDatasetDeleteConfirm(false));
  els.datasetDeleteConfirmOverlay.addEventListener("mousedown", (event) => {
    if (event.target === event.currentTarget) resolveDatasetDeleteConfirm(false);
  });
  const box = els.datasetDeleteConfirmBox;
  const header = box?.querySelector?.(".pi-delete-confirm-header");
  if (!box || !header) return;
  header.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = box.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = rect.left;
    const startTop = rect.top;
    box.style.transform = "none";
    box.style.left = `${Math.round(startLeft)}px`;
    box.style.top = `${Math.round(startTop)}px`;
    const onMove = (moveEvent) => {
      const pad = 10;
      const nextLeft = Math.max(pad, Math.min(startLeft + moveEvent.clientX - startX, window.innerWidth - rect.width - pad));
      const nextTop = Math.max(pad, Math.min(startTop + moveEvent.clientY - startY, window.innerHeight - rect.height - pad));
      box.style.left = `${Math.round(nextLeft)}px`;
      box.style.top = `${Math.round(nextTop)}px`;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
  });
}

function setSelectedPath(path, options = {}) {
  selectedPath = normalizePath(path);
  datasetTableSelection.selectedKeys.clear();
  datasetTableSelection.anchorKey = "";
  resetActivePathFolderWatch(selectedPath, { skipInitialCheck: true });
  if (els.selectedPathText) {
    els.selectedPathText.textContent = selectedPath || "Select a reserving class path.";
    els.selectedPathText.title = selectedPath;
  }
  syncDatasetWindowChrome();
  void loadCachedDatasetFilterForSelectedPath();
  renderDatasetTable();
  if (options?.persist !== false) saveLastSelectedPath(selectedPath);
  notifyProjectInstanceStateChanged();
}

function waitForPathTreeRender() {
  return new Promise((resolve) => {
    window.setTimeout(() => {
      window.requestAnimationFrame(() => resolve());
    }, 0);
  });
}

function markPathTreeActive(path) {
  const normalized = normalizePath(path);
  if (!els.pathTree || !normalized) return;
  const candidates = els.pathTree.querySelectorAll(".ptree-favorite-row, .ptree-leaf, .ptree-folder");
  for (const el of candidates) {
    const elPath = normalizePath(el.getAttribute("title") || el.dataset?.path || "");
    el.classList.toggle("active-path", !!elPath && elPath.toLowerCase() === normalized.toLowerCase());
  }
}

function getFirstShortcutPath() {
  if (!els.pathTree) return "";
  const shortcutRows = els.pathTree.querySelectorAll(".ptree-section-favorites .ptree-favorite-row[title]");
  for (const row of shortcutRows) {
    const path = normalizePath(row.getAttribute("title") || "");
    if (path) return path;
  }
  return "";
}

async function selectStartupFallbackPath() {
  await waitForPathTreeRender();
  if (selectedPath) {
    markPathTreeActive(selectedPath);
    return;
  }
  const shortcutPath = getFirstShortcutPath();
  if (!shortcutPath) {
    return;
  }
  setSelectedPath(shortcutPath, { persist: false });
  markPathTreeActive(shortcutPath);
}

function getLeftPanelMaxWidth() {
  const layoutWidth = Math.max(0, Number(els.layout?.clientWidth || 0));
  const splitterWidth = Math.max(0, Number(els.leftPanelResizer?.offsetWidth || 0));
  if (!layoutWidth) return LEFT_PANEL_MAX_WIDTH;
  const availableWidth = layoutWidth - splitterWidth - LEFT_PANEL_RIGHT_MIN_WIDTH;
  return Math.max(LEFT_PANEL_MIN_WIDTH, Math.min(LEFT_PANEL_MAX_WIDTH, availableWidth));
}

function getCurrentLeftPanelWidth() {
  const width = Number(els.leftPanel?.getBoundingClientRect?.().width || 0);
  return Number.isFinite(width) && width > 0 ? width : 0;
}

function clampLeftPanelWidth(width) {
  const raw = Number(width);
  const maxWidth = getLeftPanelMaxWidth();
  if (!Number.isFinite(raw)) return Math.min(lastExpandedLeftWidth, maxWidth);
  return Math.max(LEFT_PANEL_MIN_WIDTH, Math.min(raw, maxWidth));
}

function setLeftPanelCollapsed(collapsed) {
  if (!els.layout) return;
  els.layout.classList.toggle("left-collapsed", !!collapsed);
  els.layout.style.setProperty("--pi-left-width", collapsed ? "0px" : `${Math.round(lastExpandedLeftWidth)}px`);
  if (els.leftPanelResizer) {
    els.leftPanelResizer.setAttribute("aria-valuenow", collapsed ? "0" : String(Math.round(lastExpandedLeftWidth)));
    els.leftPanelResizer.setAttribute("aria-expanded", collapsed ? "false" : "true");
    els.leftPanelResizer.title = collapsed
      ? "Drag right or double-click to expand reserving class panel"
      : "Drag to resize or double-click to collapse reserving class panel";
  }
}

function setLeftPanelWidth(width) {
  const next = clampLeftPanelWidth(width);
  lastExpandedLeftWidth = next;
  setLeftPanelCollapsed(false);
}

function resizeLeftPanel(width) {
  const raw = Number(width);
  if (!Number.isFinite(raw) || raw <= LEFT_PANEL_COLLAPSE_THRESHOLD) {
    setLeftPanelCollapsed(true);
    return;
  }
  setLeftPanelWidth(raw);
}

function toggleLeftPanelCollapsed() {
  const collapsed = !!els.layout?.classList.contains("left-collapsed");
  if (collapsed) setLeftPanelWidth(lastExpandedLeftWidth);
  else setLeftPanelCollapsed(true);
}

function initLeftPanelResizer() {
  const { layout, leftPanel, leftPanelResizer } = els;
  if (!layout || !leftPanel || !leftPanelResizer || leftPanelResizer.dataset.wired === "1") return;
  leftPanelResizer.dataset.wired = "1";
  lastExpandedLeftWidth = clampLeftPanelWidth(getCurrentLeftPanelWidth() || LEFT_PANEL_DEFAULT_WIDTH);
  setLeftPanelWidth(lastExpandedLeftWidth);

  const startDrag = (event) => {
    if (event.button !== 0) return;
    const layoutRect = layout.getBoundingClientRect();
    const leftEdge = Number(layoutRect?.left || 0);
    leftPanelResizer.classList.add("dragging");
    document.body.classList.add("resizing-left-panel");
    let pendingWidth = getCurrentLeftPanelWidth() || lastExpandedLeftWidth;
    let resizeFrame = 0;

    const flushResize = () => {
      resizeFrame = 0;
      resizeLeftPanel(pendingWidth);
    };

    const scheduleResize = (width) => {
      pendingWidth = width;
      if (resizeFrame) return;
      resizeFrame = window.requestAnimationFrame(flushResize);
    };

    const onMove = (moveEvent) => {
      scheduleResize(Number(moveEvent.clientX || 0) - leftEdge);
    };
    const onUp = () => {
      if (resizeFrame) {
        window.cancelAnimationFrame(resizeFrame);
        flushResize();
      }
      leftPanelResizer.classList.remove("dragging");
      document.body.classList.remove("resizing-left-panel");
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
    event.preventDefault();
  };

  leftPanelResizer.addEventListener("mousedown", startDrag);
  leftPanelResizer.addEventListener("dblclick", (event) => {
    event.preventDefault();
    toggleLeftPanelCollapsed();
  });
  leftPanelResizer.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleLeftPanelCollapsed();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const baseWidth = layout.classList.contains("left-collapsed")
      ? LEFT_PANEL_COLLAPSE_THRESHOLD
      : getCurrentLeftPanelWidth();
    resizeLeftPanel(baseWidth + direction * LEFT_PANEL_KEYBOARD_STEP);
  });
  window.addEventListener("resize", () => {
    if (layout.classList.contains("left-collapsed")) return;
    setLeftPanelWidth(lastExpandedLeftWidth);
  });
}

async function loadPathTree() {
  if (!els.pathTree) return;
  beginPageLoading("paths");
  if (!projectName) {
    els.pathTree.innerHTML = '<div class="ptree-empty">Project name is missing.</div>';
    finishPageLoading("paths");
    return;
  }

  try {
    const initialPath = await loadLastSelectedPath();
    if (initialPath) {
      setSelectedPath(initialPath, { persist: false });
    }
    const result = await openLazyReservingClassPicker({
      projectName,
      inlineContainer: els.pathTree,
      initialPath,
      setStatus: (message) => setStatus(message),
      title: "Reserving Class",
      onProjectMissing: (name) => {
        els.pathTree.innerHTML = `<div class="ptree-empty">Project "${name}" does not exist.</div>`;
        setStatus(`Project "${name}" does not exist.`, true);
      },
      onError: (err) => {
        console.error("Failed to load reserving class paths:", err);
        els.pathTree.innerHTML = '<div class="ptree-empty">Failed to load reserving class paths.</div>';
        setStatus(toText(err?.message) || "Failed to load reserving class paths.", true);
      },
      onSelect: (path) => setSelectedPath(path),
    });
    if (!result?.ok && !els.pathTree.querySelector(".ptree-window")) {
      els.pathTree.innerHTML = '<div class="ptree-empty">No reserving class paths found.</div>';
    }
    await selectStartupFallbackPath();
  } catch (err) {
    console.error("Failed to load reserving class paths:", err);
    els.pathTree.innerHTML = '<div class="ptree-empty">Failed to load reserving class paths.</div>';
    setStatus(toText(err?.message) || "Failed to load reserving class paths.", true);
  } finally {
    finishPageLoading("paths");
  }
}

async function loadDatasets() {
  beginPageLoading("datasets");
  if (!projectName) {
    setEmptyTable("Project name is missing.");
    finishPageLoading("datasets");
    return;
  }
  try {
    const fetched = await fetchProjectDatasetTypes(projectName);
    datasetRows = Array.isArray(fetched?.data?.rows)
      ? fetched.data.rows.filter((row) => getDatasetName(row))
      : [];
    autoFitInitialDatasetTableWidths(datasetRows);
    renderDatasetTable();
  } catch (err) {
    console.error("Failed to load dataset types:", err);
    setEmptyTable("Failed to load dataset types.");
    setStatus(toText(err?.message) || "Failed to load dataset types.", true);
  } finally {
    finishPageLoading("datasets");
  }
}

function getWindowBounds() {
  const rect = els.root?.getBoundingClientRect?.();
  return {
    width: Math.max(480, Number(rect?.width || window.innerWidth || 900)),
    height: Math.max(360, Number(rect?.height || window.innerHeight || 640)),
  };
}

function getWindowTopLimit() {
  const rootRect = els.root?.getBoundingClientRect?.();
  const toolbarRect = els.toolbar?.getBoundingClientRect?.();
  if (!rootRect || !toolbarRect) return 0;
  return Math.max(0, Math.round(toolbarRect.bottom - rootRect.top));
}

function getWindowHorizontalLimits(width, bounds = getWindowBounds()) {
  const visibleWidth = Math.min(DATASET_WINDOW_EDGE_VISIBLE_WIDTH, Math.max(1, Number(width) || 1));
  return {
    minX: Math.min(0, visibleWidth - width),
    maxX: Math.max(0, bounds.width - visibleWidth),
  };
}

function clampWindowRect(rect) {
  const bounds = getWindowBounds();
  const minY = getWindowTopLimit();
  const maxHeight = Math.max(DATASET_WINDOW_MIN_HEIGHT, bounds.height - minY);
  const width = Math.max(DATASET_WINDOW_MIN_WIDTH, Math.min(Number(rect.width) || 760, bounds.width));
  const height = Math.max(DATASET_WINDOW_MIN_HEIGHT, Math.min(Number(rect.height) || 500, maxHeight));
  const { minX, maxX } = getWindowHorizontalLimits(width, bounds);
  const maxY = Math.max(minY, bounds.height - DATASET_WINDOW_TITLEBAR_HEIGHT);
  const x = Math.max(minX, Math.min(Number(rect.x) || 0, maxX));
  const y = Math.max(minY, Math.min(Number(rect.y) || minY, maxY));
  return { x, y, width, height };
}

function rememberDatasetWindowSize(rect) {
  const width = Number(rect?.width);
  const height = Number(rect?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  lastDatasetWindowSize = {
    width: Math.max(DATASET_WINDOW_MIN_WIDTH, Math.round(width)),
    height: Math.max(DATASET_WINDOW_MIN_HEIGHT, Math.round(height)),
  };
}

function applyWindowRect(frame, rect, options = {}) {
  const next = clampWindowRect(rect);
  frame.style.left = `${Math.round(next.x)}px`;
  frame.style.top = `${Math.round(next.y)}px`;
  frame.style.width = `${Math.round(next.width)}px`;
  frame.style.height = `${Math.round(next.height)}px`;
  if (
    frame?.classList?.contains("pi-window")
    && frame.dataset.maximized !== "1"
    && options.rememberSize !== false
  ) {
    rememberDatasetWindowSize(next);
  }
  return next;
}

function isDatasetWindowMaximized(frame) {
  return frame?.dataset?.maximized === "1";
}

function getMaximizedWindowRect() {
  const bounds = getWindowBounds();
  const minY = getWindowTopLimit();
  return {
    x: 0,
    y: minY,
    width: bounds.width,
    height: Math.max(DATASET_WINDOW_MIN_HEIGHT, bounds.height - minY),
  };
}

function getPointerRestoreRect(frame, pointerEvent, restoreRect) {
  const rootRect = els.root?.getBoundingClientRect?.();
  const currentRect = frame?.getBoundingClientRect?.();
  if (!rootRect || !currentRect || !pointerEvent) return restoreRect;
  const pointerX = pointerEvent.clientX - rootRect.left;
  const pointerY = pointerEvent.clientY - rootRect.top;
  const ratioX = clampNumber(
    (pointerEvent.clientX - currentRect.left) / Math.max(1, currentRect.width),
    0.12,
    0.88
  );
  const titleOffsetY = clampNumber(pointerEvent.clientY - currentRect.top, 8, 24);
  return {
    ...restoreRect,
    x: pointerX - restoreRect.width * ratioX,
    y: pointerY - titleOffsetY,
  };
}

function maximizeDatasetWindow(frame) {
  if (!frame) return;
  if (!isDatasetWindowMaximized(frame)) {
    frame.__piRestoreRect = getFrameRect(frame);
  }
  frame.dataset.maximized = "1";
  applyWindowRect(frame, getMaximizedWindowRect(), { rememberSize: false });
  updateDatasetWindowMaximizeControl(frame);
  raiseWindow(frame);
  notifyProjectInstanceStateChanged();
}

function restoreDatasetWindow(frame, pointerEvent = null) {
  if (!frame) return;
  const stored = frame.__piRestoreRect || getNextDatasetWindowRect(0);
  const restoreRect = pointerEvent
    ? getPointerRestoreRect(frame, pointerEvent, stored)
    : stored;
  frame.dataset.maximized = "0";
  applyWindowRect(frame, restoreRect);
  updateDatasetWindowMaximizeControl(frame);
  raiseWindow(frame);
  notifyProjectInstanceStateChanged();
}

function toggleDatasetWindowMaximized(frame) {
  if (isDatasetWindowMaximized(frame)) {
    restoreDatasetWindow(frame);
  } else {
    maximizeDatasetWindow(frame);
  }
}

function syncMaximizedDatasetWindows() {
  for (const frame of datasetWindows.values()) {
    if (!frame?.isConnected || frame.dataset.hidden === "1" || !isDatasetWindowMaximized(frame)) continue;
    applyWindowRect(frame, getMaximizedWindowRect(), { rememberSize: false });
  }
}

function updateDatasetWindowMaximizeControl(frame) {
  const button = frame?.querySelector?.(".pi-window-maximize");
  if (!button) return;
  const maximized = isDatasetWindowMaximized(frame);
  button.title = maximized ? "Restore" : "Maximize";
  button.setAttribute("aria-label", maximized ? "Restore" : "Maximize");
}

function getNextDatasetWindowRect(offset = 0) {
  const bounds = getWindowBounds();
  const minY = getWindowTopLimit();
  const availableHeight = Math.max(DATASET_WINDOW_MIN_HEIGHT, bounds.height - minY);
  const preferredWidth = lastDatasetWindowSize?.width
    || Math.round(bounds.width * DATASET_WINDOW_DEFAULT_WIDTH_RATIO);
  const preferredHeight = lastDatasetWindowSize?.height
    || Math.round(availableHeight * DATASET_WINDOW_DEFAULT_HEIGHT_RATIO);
  const width = Math.max(DATASET_WINDOW_MIN_WIDTH, Math.min(preferredWidth, bounds.width));
  const height = Math.max(DATASET_WINDOW_MIN_HEIGHT, Math.min(preferredHeight, availableHeight));
  return clampWindowRect({
    x: Math.round((bounds.width - width) / 2) + offset,
    y: Math.round(minY + (availableHeight - height) / 2) + offset,
    width,
    height,
  });
}

function raiseWindow(frame) {
  frame.style.zIndex = String(++nextWindowZ);
  if (frame?.classList?.contains("pi-window") && frame.dataset.hidden !== "1") {
    activeDatasetWindow = frame;
  }
  syncDatasetWindowChrome();
  notifyActiveDfmWindowState();
  notifyProjectInstanceStateChanged();
}

function getActiveDatasetWindow() {
  if (
    activeDatasetWindow?.isConnected
    && activeDatasetWindow.dataset.hidden !== "1"
    && activeDatasetWindow.style.display !== "none"
  ) {
    return activeDatasetWindow;
  }
  let nextActive = null;
  let topZ = -1;
  for (const frame of datasetWindows.values()) {
    if (!frame?.isConnected || frame.dataset.hidden === "1" || frame.style.display === "none") continue;
    const z = Number.parseInt(frame.style.zIndex || "0", 10);
    if (z >= topZ) {
      topZ = z;
      nextActive = frame;
    }
  }
  activeDatasetWindow = nextActive;
  return nextActive;
}

function closeDatasetWindow(frame, { status = true } = {}) {
  if (!frame?.isConnected) return false;
  const iframe = getWindowIframe(frame);
  if (iframe?.contentWindow) {
    try {
      const requestClose = iframe.contentWindow.__arcrho_request_close;
      if (typeof requestClose === "function" && requestClose() === true) return false;
    } catch {}
  }
  if (frame.dataset.dirty === "1") {
    const titleForPrompt = frame.dataset.windowDatasetName || frame.dataset.windowTitle || "Dataset window";
    const ok = window.confirm(`${titleForPrompt} has unsaved changes. Close it anyway?`);
    if (!ok) return false;
  }
  const title = frame.dataset.windowDatasetName || frame.dataset.windowTitle || frame.getAttribute("aria-label") || "dataset window";
  hiddenWindows.delete(frame.dataset.windowId || "");
  datasetWindows.delete(frame.dataset.windowKey || "");
  if (activeDatasetWindow === frame) activeDatasetWindow = null;
  frame.remove();
  syncDatasetWindowChrome();
  updateHiddenTabsArea();
  notifyProjectInstanceDirtyState();
  notifyActiveDfmWindowState();
  notifyProjectInstanceStateChanged();
  if (status) setStatus(`Closed ${title}`);
  return true;
}

function isDfmWindow(frame) {
  return frame?.dataset?.windowKind === "dfm";
}

function findWindowByInstance(inst) {
  const id = toText(inst);
  if (!id) return null;
  for (const frame of datasetWindows.values()) {
    if (frame?.dataset?.windowId === id) return frame;
  }
  return null;
}

function findWindowByMessageSource(source) {
  if (!source) return null;
  for (const frame of datasetWindows.values()) {
    const iframe = getWindowIframe(frame);
    if (iframe?.contentWindow === source) return frame;
  }
  return null;
}

function getWindowIframe(frame) {
  return frame?.querySelector?.(".pi-window-body iframe") || null;
}

function setWindowDirtyState(frame, dirty) {
  if (!frame) return;
  frame.dataset.dirty = dirty ? "1" : "0";
  frame.classList.toggle("dirty", !!dirty);
  const closeBtn = frame.querySelector(".pi-window-close");
  if (closeBtn) {
    closeBtn.title = dirty ? "Unsaved changes (close)" : "Close";
    closeBtn.setAttribute("aria-label", dirty ? "Unsaved changes (close)" : "Close");
  }
  if (frame.dataset.hidden === "1") updateHiddenTabsArea();
  notifyProjectInstanceDirtyState();
  notifyProjectInstanceStateChanged();
}

function hasDirtyDfmWindow() {
  for (const frame of datasetWindows.values()) {
    if (frame?.dataset?.dirty === "1") return true;
  }
  return false;
}

function notifyProjectInstanceDirtyState() {
  try {
    window.parent?.postMessage({
      type: "arcrho:project-instance-dirty",
      dirty: hasDirtyDfmWindow(),
    }, "*");
  } catch {}
}

function notifyActiveDfmWindowState() {
  const frame = getActiveDfmWindow();
  try {
    window.parent?.postMessage({
      type: "arcrho:project-instance-dfm-active-state",
      active: !!frame,
      inst: frame?.dataset?.windowId || "",
      title: frame?.dataset?.windowTitle || "",
      tab: frame?.dataset?.dfmTab || "",
      canUndo: frame?.dataset?.dfmCanUndo === "1",
      canRedo: frame?.dataset?.dfmCanRedo === "1",
      editEnabled: frame?.dataset?.dfmEditEnabled === "1",
    }, "*");
  } catch {}
}

function getActiveDfmWindow() {
  const active = getActiveDatasetWindow();
  if (isDfmWindow(active)) return active;
  let topDfm = null;
  let topZ = -1;
  for (const frame of datasetWindows.values()) {
    if (!isDfmWindow(frame) || !frame?.isConnected || frame.dataset.hidden === "1" || frame.style.display === "none") continue;
    const z = Number.parseInt(frame.style.zIndex || "0", 10);
    if (z >= topZ) {
      topZ = z;
      topDfm = frame;
    }
  }
  return topDfm;
}

function routeDfmWindowCommand(type) {
  let command = toText(type);
  const frame = getActiveDfmWindow();
  if (!frame) {
    setStatus("No active DFM window.", true);
    return false;
  }
  if (command === "arcrho:dfm-save-as" && toText(frame.dataset.dfmTab).toLowerCase() === "details") {
    command = "arcrho:dfm-save-template";
  }
  const iframe = getWindowIframe(frame);
  try {
    iframe?.contentWindow?.postMessage({ type: command }, "*");
    const statusByCommand = {
      "arcrho:dfm-save": "Saving DFM...",
      "arcrho:dfm-save-as": "Saving DFM as...",
      "arcrho:dfm-save-template": "Saving DFM template...",
      "arcrho:dfm-open-method-json": "Opening DFM JSON...",
      "arcrho:dfm-undo": "Undoing ratio change...",
      "arcrho:dfm-redo": "Redoing ratio change...",
      "arcrho:dfm-exclude-high": "Excluding highest ratio...",
      "arcrho:dfm-exclude-low": "Excluding lowest ratio...",
      "arcrho:dfm-include-all": "Including ratios...",
    };
    setStatus(statusByCommand[command] || "Sent DFM command.");
    return true;
  } catch {
    setStatus("Failed to send command to the DFM window.", true);
    return false;
  }
}

function forwardRequestToActiveDfm(message, resultType, fallbackContext, timeoutMs = 3000) {
  const requestId = toText(message?.requestId) || `pi_dfm_request_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const frame = getActiveDfmWindow();
  const iframe = getWindowIframe(frame);
  if (!frame || !iframe?.contentWindow) {
    try {
      window.parent?.postMessage({ type: resultType, requestId, ...fallbackContext }, "*");
    } catch {}
    return false;
  }
  let done = false;
  const finish = (payload) => {
    if (done) return;
    done = true;
    window.removeEventListener("message", onMessage);
    try {
      window.parent?.postMessage(payload, "*");
    } catch {}
  };
  const onMessage = (event) => {
    if (event.source !== iframe.contentWindow) return;
    const msg = event.data || {};
    if (msg.type !== resultType || toText(msg.requestId) !== requestId) return;
    finish(msg);
  };
  window.addEventListener("message", onMessage);
  try {
    iframe.contentWindow.postMessage({ ...message, requestId }, "*");
  } catch {
    finish({ type: resultType, requestId, ...fallbackContext });
    return false;
  }
  window.setTimeout(() => finish({ type: resultType, requestId, ...fallbackContext }), timeoutMs);
  return true;
}

function isCloseActiveWindowShortcut(event) {
  return !!event?.ctrlKey
    && !event.altKey
    && !event.metaKey
    && !event.shiftKey
    && String(event.key || "").toLowerCase() === "w";
}

function routeDfmRatioHotkey(event) {
  if (!event?.ctrlKey || event.altKey || event.metaKey) return false;
  const tag = event.target?.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || event.target?.isContentEditable) return false;
  const key = String(event.key || "").toLowerCase();
  const commandByKey = {
    h: "arcrho:dfm-exclude-high",
    l: "arcrho:dfm-exclude-low",
    i: "arcrho:dfm-include-all",
    z: "arcrho:dfm-undo",
    y: "arcrho:dfm-redo",
  };
  const command = commandByKey[key];
  if (!command) return false;
  event.preventDefault();
  event.stopPropagation();
  return routeDfmWindowCommand(command);
}

function closeActiveDatasetWindowFromShortcut(event, frame = getActiveDatasetWindow()) {
  if (!isCloseActiveWindowShortcut(event) || !frame?.isConnected) return false;
  event.preventDefault();
  event.stopPropagation();
  lastDatasetWindowShortcutCloseAt = Date.now();
  closeDatasetWindow(frame);
  return true;
}

function consumeCloseShortcutFromShell() {
  if (Date.now() - lastDatasetWindowShortcutCloseAt < 900) return true;
  const frame = getActiveDatasetWindow();
  if (!frame?.isConnected) return false;
  lastDatasetWindowShortcutCloseAt = Date.now();
  closeDatasetWindow(frame);
  return true;
}

function clampNumber(value, min, max) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return min;
  return Math.max(min, Math.min(raw, max));
}

function resizeRectFromCorner(start, corner, dx, dy) {
  const bounds = getWindowBounds();
  const minY = getWindowTopLimit();
  const { minX } = getWindowHorizontalLimits(start.width, bounds);
  const next = {
    x: start.x,
    y: start.y,
    width: start.width,
    height: start.height,
  };

  if (corner.includes("e")) {
    next.width = clampNumber(start.width + dx, DATASET_WINDOW_MIN_WIDTH, bounds.width);
  }
  if (corner.includes("s")) {
    next.height = clampNumber(start.height + dy, DATASET_WINDOW_MIN_HEIGHT, bounds.height - minY);
  }
  if (corner.includes("w")) {
    const right = start.x + start.width;
    next.x = clampNumber(start.x + dx, minX, right - DATASET_WINDOW_MIN_WIDTH);
    next.width = right - next.x;
  }
  if (corner.includes("n")) {
    const bottom = start.y + start.height;
    next.y = clampNumber(start.y + dy, minY, bottom - DATASET_WINDOW_MIN_HEIGHT);
    next.height = bottom - next.y;
  }

  return next;
}

function lockDatasetViewerInputs(iframe, datasetName) {
  let doc = null;
  try {
    doc = iframe.contentDocument || iframe.contentWindow?.document || null;
  } catch {
    return;
  }
  if (!doc) return;

  const projectInput = doc.getElementById("projectSelect");
  const pathInput = doc.getElementById("pathInput");
  const triInput = doc.getElementById("triInput");
  if (projectInput) {
    projectInput.value = projectName;
    projectInput.readOnly = true;
    projectInput.title = "Project is set by the project instance tab.";
  }
  if (pathInput) {
    pathInput.value = selectedPath;
    pathInput.readOnly = true;
    pathInput.title = "Reserving class path is set by the project instance tab.";
  }
  if (triInput && datasetName) {
    triInput.value = datasetName;
  }
  for (const id of ["projectTreeBtn", "pathTreeBtn"]) {
    const button = doc.getElementById(id);
    if (button) {
      button.disabled = true;
      button.title = "Set by the project instance tab";
    }
  }
}

function wireDatasetViewerWindowShortcuts(iframe, frame) {
  let doc = null;
  try {
    doc = iframe.contentDocument || iframe.contentWindow?.document || null;
  } catch {
    return;
  }
  if (!doc || doc.__piWindowShortcutsWired) return;
  doc.__piWindowShortcutsWired = true;
  doc.addEventListener("mousedown", () => raiseWindow(frame), true);
  doc.addEventListener("focusin", () => raiseWindow(frame), true);
  doc.addEventListener("keydown", (event) => {
    if (isDfmWindow(frame) && routeDfmRatioHotkey(event)) return;
    if (
      isDfmWindow(frame)
      && event.ctrlKey
      && !event.altKey
      && !event.metaKey
      && String(event.key || "").toLowerCase() === "s"
    ) {
      event.preventDefault();
      event.stopPropagation();
      routeDfmWindowCommand(event.shiftKey ? "arcrho:dfm-save-as" : "arcrho:dfm-save");
      return;
    }
    closeActiveDatasetWindowFromShortcut(event, frame);
  }, true);
}

function buildDatasetViewerUrl(datasetName, inst) {
  const params = new URLSearchParams();
  params.set("project", projectName);
  params.set("path", selectedPath);
  params.set("tri", datasetName);
  params.set("inst", inst);
  params.set("project_instance", "1");
  params.set("v", String(Date.now()));
  return `/ui/dataset/dataset_viewer.html?${params.toString()}`;
}

function buildDfmViewerUrl(datasetName, inst, initialTab = "ratios") {
  const params = new URLSearchParams();
  params.set("project", projectName);
  params.set("class", selectedPath);
  params.set("method_name", datasetName);
  params.set("output_type", datasetName);
  params.set("tab", toText(initialTab) || "ratios");
  params.set("inst", inst);
  params.set("project_instance", "1");
  params.set("v", String(Date.now()));
  return `/ui/dfm/dfm.html?${params.toString()}`;
}

function beginWindowDragCapture(mode) {
  const shield = document.createElement("div");
  shield.className = `pi-window-drag-shield ${mode || "moving"}`;
  els.windowLayer?.appendChild(shield);
  return () => {
    if (shield.parentNode) shield.parentNode.removeChild(shield);
  };
}

function startMove(frame, event) {
  if (event.button !== 0) return;
  raiseWindow(frame);
  const releaseDragCapture = beginWindowDragCapture("moving");
  const getStart = (sourceEvent) => {
    const startRect = frame.getBoundingClientRect();
    const rootRect = els.root.getBoundingClientRect();
    return {
      x: startRect.left - rootRect.left,
      y: startRect.top - rootRect.top,
      width: startRect.width,
      height: startRect.height,
      px: sourceEvent.clientX,
      py: sourceEvent.clientY,
    };
  };
  let start = getStart(event);

  const onMove = (e) => {
    if (isDatasetWindowMaximized(frame)) {
      restoreDatasetWindow(frame, e);
      start = getStart(e);
    }
    applyWindowRect(frame, {
      x: start.x + e.clientX - start.px,
      y: start.y + e.clientY - start.py,
      width: start.width,
      height: start.height,
    });
    setHiddenDropActive(isPointInHiddenDropZone(e.clientX, e.clientY), frame);
  };
  const onUp = (e) => {
    releaseDragCapture();
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mouseup", onUp, true);
    if (isPointInHiddenDropZone(e.clientX, e.clientY)) {
      hideDatasetWindow(frame, {
        x: start.x,
        y: start.y,
        width: start.width,
        height: start.height,
      });
      return;
    }
    setHiddenDropActive(false, frame);
    notifyProjectInstanceStateChanged();
  };
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("mouseup", onUp, true);
  event.preventDefault();
}

function startResize(frame, event, corner = "se") {
  if (event.button !== 0) return;
  if (isDatasetWindowMaximized(frame)) {
    restoreDatasetWindow(frame);
  }
  raiseWindow(frame);
  const resizeCorner = String(corner || "se").toLowerCase();
  const releaseDragCapture = beginWindowDragCapture(`resizing-${resizeCorner}`);
  const startRect = frame.getBoundingClientRect();
  const rootRect = els.root.getBoundingClientRect();
  const start = {
    x: startRect.left - rootRect.left,
    y: startRect.top - rootRect.top,
    width: startRect.width,
    height: startRect.height,
    px: event.clientX,
    py: event.clientY,
  };

  const onMove = (e) => {
    applyWindowRect(
      frame,
      resizeRectFromCorner(start, resizeCorner, e.clientX - start.px, e.clientY - start.py)
    );
  };
  const onUp = () => {
    releaseDragCapture();
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mouseup", onUp, true);
    notifyProjectInstanceStateChanged();
  };
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("mouseup", onUp, true);
  event.preventDefault();
}

function createFloatingContentWindow(options = {}) {
  const name = toText(options.name);
  const title = toText(options.title) || name;
  const windowKey = toText(options.windowKey);
  const inst = toText(options.inst) || `pi_window_${Date.now()}_${windowSeq++}`;
  const iframeSrc = toText(options.iframeSrc);
  if (!name || !title || !windowKey || !iframeSrc) return null;

  const existing = datasetWindows.get(windowKey);
  if (existing?.isConnected) {
    void activateDatasetWindow(existing);
    return existing;
  }
  datasetWindows.delete(windowKey);

  const frame = document.createElement("section");
  frame.className = "pi-window";
  frame.dataset.windowId = inst;
  frame.dataset.windowKey = windowKey;
  frame.dataset.windowDatasetName = name;
  frame.dataset.windowItemName = toText(options.itemName) || name;
  frame.dataset.windowPath = normalizePath(options.path || selectedPath);
  frame.dataset.windowTitle = title;
  frame.dataset.windowKind = toText(options.kind) || "dataset";
  if (frame.dataset.windowKind === "dfm") frame.dataset.dfmTab = "ratios";
  frame.setAttribute("aria-label", title);
  frame.innerHTML = `
    <header class="pi-window-titlebar">
      <span class="pi-window-title"></span>
      <span class="pi-window-dirty" title="Unsaved changes" aria-hidden="true"></span>
      <div class="pi-window-titlebar-controls">
        <button class="pi-window-titlebar-btn pi-window-minimize" type="button" title="Minimize" aria-label="Minimize">
          <svg class="pi-window-titlebar-icon" viewBox="0 0 10 10" aria-hidden="true">
            <line x1="2" y1="7" x2="8" y2="7"></line>
          </svg>
        </button>
        <button class="pi-window-titlebar-btn pi-window-maximize" type="button" title="Maximize" aria-label="Maximize">
          <svg class="pi-window-titlebar-icon" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="2" y="2" width="6" height="6" rx="0.6"></rect>
          </svg>
        </button>
        <button class="pi-window-titlebar-btn pi-window-close" type="button" title="Close" aria-label="Close">
          <svg class="pi-window-titlebar-icon" viewBox="0 0 10 10" aria-hidden="true">
            <line x1="2" y1="2" x2="8" y2="8"></line>
            <line x1="8" y1="2" x2="2" y2="8"></line>
          </svg>
        </button>
      </div>
    </header>
    <div class="pi-window-body"></div>
    <div class="pi-window-resize pi-window-resize-nw" data-corner="nw" title="Resize"></div>
    <div class="pi-window-resize pi-window-resize-edge pi-window-resize-n" data-corner="n" title="Resize"></div>
    <div class="pi-window-resize pi-window-resize-ne" data-corner="ne" title="Resize"></div>
    <div class="pi-window-resize pi-window-resize-edge pi-window-resize-e" data-corner="e" title="Resize"></div>
    <div class="pi-window-resize pi-window-resize-se" data-corner="se" title="Resize"></div>
    <div class="pi-window-resize pi-window-resize-edge pi-window-resize-s" data-corner="s" title="Resize"></div>
    <div class="pi-window-resize pi-window-resize-sw" data-corner="sw" title="Resize"></div>
    <div class="pi-window-resize pi-window-resize-edge pi-window-resize-w" data-corner="w" title="Resize"></div>
  `;

  updateDatasetWindowTitle(frame);

  const body = frame.querySelector(".pi-window-body");
  const iframe = document.createElement("iframe");
  iframe.src = iframeSrc;
  iframe.addEventListener("load", () => {
    wireDatasetViewerWindowShortcuts(iframe, frame);
    postZoomToDatasetFrame(iframe);
    if (isDfmWindow(frame)) {
      try { iframe.contentWindow?.postMessage({ type: "arcrho:dfm-request-state" }, "*"); } catch {}
      notifyActiveDfmWindowState();
    }
    if (typeof options.onIframeLoad === "function") {
      options.onIframeLoad(iframe, frame);
    }
  });
  body.appendChild(iframe);

  const titlebar = frame.querySelector(".pi-window-titlebar");
  titlebar?.addEventListener("mousedown", (e) => {
    if (e.target.closest("button")) return;
    if (Number(e.detail) >= 2) {
      e.preventDefault();
      frame.__piLastTitlebarToggle = Date.now();
      toggleDatasetWindowMaximized(frame);
      return;
    }
    startMove(frame, e);
  });
  titlebar?.addEventListener("dblclick", (e) => {
    if (e.target.closest("button")) return;
    if (Number(frame.__piLastTitlebarToggle || 0) && Date.now() - frame.__piLastTitlebarToggle < 400) return;
    e.preventDefault();
    toggleDatasetWindowMaximized(frame);
  });
  for (const handle of frame.querySelectorAll(".pi-window-resize")) {
    handle.addEventListener("mousedown", (e) => {
      startResize(frame, e, handle.getAttribute("data-corner") || "se");
    });
  }
  frame.querySelector(".pi-window-minimize")?.addEventListener("click", () => {
    hideDatasetWindow(frame, getFrameRect(frame));
  });
  frame.querySelector(".pi-window-maximize")?.addEventListener("click", () => {
    toggleDatasetWindowMaximized(frame);
  });
  frame.querySelector(".pi-window-close")?.addEventListener("click", () => closeDatasetWindow(frame));
  frame.addEventListener("mousedown", () => raiseWindow(frame));

  const offset = ((windowSeq - 1) % 5) * 26;
  els.windowLayer.appendChild(frame);
  datasetWindows.set(windowKey, frame);
  applyWindowRect(frame, getNextDatasetWindowRect(offset));
  raiseWindow(frame);
  notifyProjectInstanceStateChanged();
  setStatus(`Opened ${title}`);
  return frame;
}

function openDatasetWindow(datasetName) {
  const name = toText(datasetName);
  if (!name) return;
  if (!selectedPath) {
    setStatus("Select a reserving class path before opening a dataset.", true);
    return;
  }

  const windowKey = getDatasetWindowKey(name);
  const title = `${selectedPath}\\${name}`;
  const inst = `pi_ds_${Date.now()}_${windowSeq++}`;
  return createFloatingContentWindow({
    kind: "dataset",
    name,
    itemName: name,
    title,
    windowKey,
    inst,
    iframeSrc: buildDatasetViewerUrl(name, inst),
    onIframeLoad: (iframe) => {
      lockDatasetViewerInputs(iframe, name);
      window.setTimeout(() => lockDatasetViewerInputs(iframe, name), 250);
    },
  });
}

function openDfmWindow(datasetName, options = {}) {
  const name = toText(datasetName);
  if (!name) return;
  if (!selectedPath) {
    setStatus("Select a reserving class path before opening a DFM object.", true);
    return;
  }

  recordSelectedDfmObject(name);
  const windowKey = getDfmWindowKey(name);
  const title = `${selectedPath}\\DFM\\${name}`;
  const initialTab = toText(options.initialTab || options.dfmTab || "ratios") || "ratios";
  const inst = `pi_dfm_${Date.now()}_${windowSeq++}`;
  return createFloatingContentWindow({
    kind: "dfm",
    name: `DFM: ${name}`,
    itemName: name,
    title,
    windowKey,
    inst,
    iframeSrc: buildDfmViewerUrl(name, inst, initialTab),
  });
}

function applyRestoredWindowState(frame, item = {}) {
  if (!frame?.isConnected) return;
  const rect = item?.rect && typeof item.rect === "object" ? item.rect : null;
  if (!item?.maximized) {
    frame.dataset.maximized = "0";
    delete frame.__piRestoreRect;
    updateDatasetWindowMaximizeControl(frame);
  }
  if (rect) applyWindowRect(frame, rect);
  if (item?.maximized) maximizeDatasetWindow(frame);
  if (toText(item?.dfmTab) && isDfmWindow(frame)) {
    frame.dataset.dfmTab = toText(item.dfmTab);
  }
  const id = frame.dataset.windowId || "";
  if (item?.hidden) {
    hiddenWindows.set(id, {
      frame,
      title: frame.dataset.windowDatasetName || frame.dataset.windowTitle || "Dataset",
      fullTitle: frame.dataset.windowTitle || frame.getAttribute("aria-label") || "Dataset",
      restoreRect: rect || getFrameRect(frame),
    });
    frame.dataset.hidden = "1";
    frame.style.display = "none";
    if (activeDatasetWindow === frame) activeDatasetWindow = null;
  } else {
    hiddenWindows.delete(id);
    frame.dataset.hidden = "0";
    frame.style.display = "";
  }
}

async function applyProjectInstanceRestoreState(rawState) {
  const state = rawState && typeof rawState === "object" ? rawState : {};
  const path = normalizePath(state.selectedPath || state.path || "");
  if (path) {
    setSelectedPath(path, { persist: false });
    await waitForPathTreeRender();
    markPathTreeActive(path);
  }
  const windows = Array.isArray(state.windows) ? state.windows : [];
  let activeTarget = null;
  for (const item of windows) {
    const kind = toText(item?.kind).toLowerCase() === "dfm" ? "dfm" : "dataset";
    const name = toText(item?.name || item?.datasetName || item?.methodName);
    if (!name) continue;
    const frame = kind === "dfm" ? openDfmWindow(name, { initialTab: item?.dfmTab }) : openDatasetWindow(name);
    applyRestoredWindowState(frame, item);
    if (item?.active) activeTarget = frame;
  }
  updateHiddenTabsArea();
  if (activeTarget?.isConnected && activeTarget.dataset.hidden !== "1") {
    raiseWindow(activeTarget);
  } else {
    notifyActiveDfmWindowState();
  }
  notifyProjectInstanceStateChanged();
}

function initHiddenTabsArea() {
  if (!els.hiddenTabsButton || els.hiddenTabsButton.dataset.wired === "1") return;
  els.hiddenTabsButton.dataset.wired = "1";
  updateHiddenTabsArea();
  els.hiddenTabsButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const nextOpen = !els.hiddenTabsWrap?.classList?.contains("open");
    setHiddenTabsMenuOpen(nextOpen, { pinned: nextOpen });
  });
  els.hiddenTabsButton.addEventListener("mouseenter", () => {
    setHiddenTabsMenuOpen(true, { pinned: hiddenTabsMenuPinned });
  });
  els.hiddenTabsButton.addEventListener("mouseleave", () => {
    scheduleHiddenTabsHoverClose();
  });
  els.hiddenTabsMenu?.addEventListener("mouseenter", () => {
    setHiddenTabsMenuOpen(true, { pinned: hiddenTabsMenuPinned });
  });
  els.hiddenTabsMenu?.addEventListener("mouseleave", () => {
    scheduleHiddenTabsHoverClose();
  });
  document.addEventListener("mousedown", (event) => {
    if (els.hiddenTabsWrap?.contains(event.target)) return;
    setHiddenTabsMenuOpen(false, { pinned: false });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setHiddenTabsMenuOpen(false, { pinned: false });
  });
}

function initCachedDatasetToolbar() {
  if (!els.cachedDatasetToggle || els.cachedDatasetToggle.dataset.wired === "1") return;
  els.cachedDatasetToggle.dataset.wired = "1";
  syncCachedDatasetToolbar();
  syncDiskChangeToolbarAlert();
  els.cachedDatasetToggle.addEventListener("click", () => {
    setCachedDatasetFilterEnabled(!cachedDatasetFilter.enabled);
  });
  els.diskChangeReloadAlert?.addEventListener("click", () => {
    reloadProjectInstanceAfterDiskChange();
  });
}

function initDatasetWindowShortcuts() {
  if (document.body.dataset.piWindowShortcutsWired === "1") return;
  document.body.dataset.piWindowShortcutsWired = "1";
  window.__arcrho_consume_close_shortcut = consumeCloseShortcutFromShell;
  document.addEventListener("keydown", (event) => {
    if (routeDfmRatioHotkey(event)) return;
    if (
      event.ctrlKey
      && !event.altKey
      && !event.metaKey
      && String(event.key || "").toLowerCase() === "s"
    ) {
      event.preventDefault();
      event.stopPropagation();
      routeDfmWindowCommand(event.shiftKey ? "arcrho:dfm-save-as" : "arcrho:dfm-save");
      return;
    }
    closeActiveDatasetWindowFromShortcut(event);
  }, true);
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "arcrho:project-instance-restore-state") {
    pendingProjectInstanceRestoreState = msg.state && typeof msg.state === "object" ? msg.state : null;
    if (projectInstanceBootComplete && pendingProjectInstanceRestoreState) {
      const state = pendingProjectInstanceRestoreState;
      pendingProjectInstanceRestoreState = null;
      void applyProjectInstanceRestoreState(state);
    }
    return;
  }
  if (msg.type === "arcrho:tab-activated") {
    notifyActiveDfmWindowState();
    notifyProjectInstanceStateChanged();
    const frame = getActiveDfmWindow();
    const iframe = getWindowIframe(frame);
    try { iframe?.contentWindow?.postMessage({ type: "arcrho:dfm-tab-activated" }, "*"); } catch {}
    return;
  }
  if (
    msg.type === "arcrho:dfm-save"
    || msg.type === "arcrho:dfm-save-as"
    || msg.type === "arcrho:dfm-save-template"
    || msg.type === "arcrho:dfm-open-method-json"
    || msg.type === "arcrho:dfm-exclude-high"
    || msg.type === "arcrho:dfm-exclude-low"
    || msg.type === "arcrho:dfm-include-all"
    || msg.type === "arcrho:dfm-undo"
    || msg.type === "arcrho:dfm-redo"
  ) {
    routeDfmWindowCommand(msg.type);
    return;
  }
  if (msg.type === "arcrho:assistant-context-request") {
    forwardRequestToActiveDfm(msg, "arcrho:assistant-context-result", {
      context: {
        available: false,
        pageType: "project_instance",
        error: "No active DFM window is available in the Project Instance page.",
      },
    }, 1500);
    return;
  }
  if (msg.type === "arcrho:dfm-apply-method-payload") {
    forwardRequestToActiveDfm(msg, "arcrho:dfm-apply-method-payload-result", {
      ok: false,
      error: "No active DFM window is available in the Project Instance page.",
    }, 3000);
    return;
  }
  if (msg.type === "arcrho:dfm-edit-state") {
    const frame = findWindowByMessageSource(event.source);
    if (frame && isDfmWindow(frame)) {
      frame.dataset.dfmEditEnabled = msg.enabled ? "1" : "0";
      notifyActiveDfmWindowState();
    }
    return;
  }
  if (msg.type === "arcrho:dfm-history-state") {
    const frame = findWindowByInstance(msg.inst) || findWindowByMessageSource(event.source);
    if (frame && isDfmWindow(frame)) {
      frame.dataset.dfmCanUndo = msg.canUndo ? "1" : "0";
      frame.dataset.dfmCanRedo = msg.canRedo ? "1" : "0";
      notifyActiveDfmWindowState();
    }
    return;
  }
  if (msg.type === "arcrho:dfm-history-session") {
    const frame = findWindowByInstance(msg.inst) || findWindowByMessageSource(event.source);
    if (frame && isDfmWindow(frame)) {
      frame.dataset.dfmHistoryDir = toText(msg.dir);
      notifyActiveDfmWindowState();
    }
    return;
  }
  if (msg.type === "arcrho:dfm-dirty") {
    const frame = findWindowByInstance(msg.inst);
    if (frame) {
      setWindowDirtyState(frame, !!msg.dirty);
      notifyActiveDfmWindowState();
    }
    return;
  }
  if (msg.type === "arcrho:dataset-dirty") {
    const frame = findWindowByInstance(msg.inst) || findWindowByMessageSource(event.source);
    if (frame) setWindowDirtyState(frame, !!msg.dirty);
    return;
  }
  if (msg.type === "arcrho:dataset-close-confirmed") {
    const frame = findWindowByInstance(msg.inst) || findWindowByMessageSource(event.source);
    if (frame) {
      setWindowDirtyState(frame, false);
      closeDatasetWindow(frame);
    }
    return;
  }
  if (msg.type === "arcrho:dfm-tab-changed") {
    const frame = findWindowByInstance(msg.inst);
    if (frame) {
      frame.dataset.dfmTab = toText(msg.tab || "");
      notifyActiveDfmWindowState();
      notifyProjectInstanceStateChanged();
    }
    return;
  }
  if (msg.type === "arcrho:hotkey") {
    const action = toText(msg.action);
    if (action === "file_save") {
      routeDfmWindowCommand("arcrho:dfm-save");
      return;
    }
    if (action === "file_save_as") {
      routeDfmWindowCommand("arcrho:dfm-save-as");
      return;
    }
    if (action === "dfm_undo") {
      routeDfmWindowCommand("arcrho:dfm-undo");
      return;
    }
    if (action === "dfm_redo") {
      routeDfmWindowCommand("arcrho:dfm-redo");
      return;
    }
    if (action === "dfm_exclude_high") {
      routeDfmWindowCommand("arcrho:dfm-exclude-high");
      return;
    }
    if (action === "dfm_exclude_low") {
      routeDfmWindowCommand("arcrho:dfm-exclude-low");
      return;
    }
    if (action === "dfm_include_all") {
      routeDfmWindowCommand("arcrho:dfm-include-all");
      return;
    }
  }
  if (msg.type === "arcrho:status" || msg.type === "arcrho:tooltip") {
    try { window.parent.postMessage(msg, "*"); } catch {}
  }
});

async function boot() {
  await applyHostFrameCornerStyle();
  initHiddenTabsArea();
  initCachedDatasetToolbar();
  initLeftPanelResizer();
  initDatasetTableInteractions();
  initDatasetWindowShortcuts();
  window.addEventListener("resize", syncMaximizedDatasetWindows);
  if (!projectName) {
    setStatus("Project name is missing.", true);
    setEmptyTable("Project name is missing.");
    if (els.pathTree) els.pathTree.innerHTML = '<div class="ptree-empty">Project name is missing.</div>';
    finishPageLoading();
    return;
  }
  await loadDatasetTablePreferences();
  await Promise.all([loadPathTree(), loadDatasets()]);
  projectInstanceBootComplete = true;
  if (pendingProjectInstanceRestoreState) {
    const state = pendingProjectInstanceRestoreState;
    pendingProjectInstanceRestoreState = null;
    await applyProjectInstanceRestoreState(state);
  } else {
    notifyProjectInstanceStateChanged();
  }
}

boot();

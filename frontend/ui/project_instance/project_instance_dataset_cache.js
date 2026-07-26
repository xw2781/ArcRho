import { attachArcrhoTooltip } from "/ui/shared/components/tooltip/tooltip.js?v=20260715a";
import { publishProjectInstanceDatasetSnapshot } from "/ui/shared/dataset/project_instance_dataset_snapshot.js?v=20260725a";

export function installProjectInstanceDatasetCache(ctx) {
  const { api, els, projectName, state } = ctx;
  const { cachedDatasetFilter, cachedDatasetSnapshotRequests, datasetIndexWatch } = state;
  const captureDatasetTableSelection = (...args) => api.captureDatasetTableSelection(...args);
  const closeDatasetTableFilterPopover = (...args) => api.closeDatasetTableFilterPopover(...args);
  const getCachedDatasetKey = (...args) => api.getCachedDatasetKey(...args);
  const getDatasetName = (...args) => api.getDatasetName(...args);
  const normalizeLookupKey = (...args) => api.normalizeLookupKey(...args);
  const normalizePath = (...args) => api.normalizePath(...args);
  const renderDatasetTable = (...args) => api.renderDatasetTable(...args);
  const restoreDatasetTableSelection = (...args) => api.restoreDatasetTableSelection(...args);
  const setStatus = (...args) => api.setStatus(...args);
  const toText = (...args) => api.toText(...args);

function isTemporaryDatasetView() {
  return state.datasetViewMode === "temporary";
}

function createTemporaryDatasetSessionId() {
  try {
    if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  } catch {}
  const randomHex = (length) => {
    let out = "";
    while (out.length < length) out += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
    return out.slice(0, length);
  };
  return `${randomHex(8)}-${randomHex(4)}-4${randomHex(3)}-8${randomHex(3)}-${randomHex(12)}`;
}

function captureNormalDatasetTableFilters() {
  const filters = new Map();
  const source = state.datasetTableView?.filters;
  if (source instanceof Map) {
    for (const [key, values] of source.entries()) {
      filters.set(key, values instanceof Set ? new Set(values) : new Set());
    }
  }
  return {
    filters,
    explicitAllFilterKeys: new Set(state.datasetTableExplicitAllFilterKeys || []),
  };
}

function restoreNormalDatasetTableFilters() {
  const saved = state.temporaryDatasetTableFilterState;
  state.temporaryDatasetTableFilterState = null;
  if (!saved || !(state.datasetTableView?.filters instanceof Map)) return;
  state.datasetTableView.filters.clear();
  for (const [key, values] of saved.filters || []) {
    state.datasetTableView.filters.set(key, values instanceof Set ? new Set(values) : new Set());
  }
  state.datasetTableExplicitAllFilterKeys?.clear?.();
  for (const key of saved.explicitAllFilterKeys || []) {
    state.datasetTableExplicitAllFilterKeys?.add?.(key);
  }
}

function syncDatasetIndexUpdatePrompt() {
  const btn = els.datasetIndexUpdateBtn;
  if (!btn) return;
  const show = !!datasetIndexWatch.pending && !!state.selectedPath && !cachedDatasetFilter.loading;
  btn.hidden = !show;
  btn.disabled = cachedDatasetFilter.loading || !state.selectedPath;
}

function syncCachedDatasetToolbar() {
  const temporaryView = isTemporaryDatasetView();
  const indexWarning = toText(cachedDatasetFilter.warning);
  if (els.datasetTempViewBtn) {
    els.datasetTempViewBtn.disabled = cachedDatasetFilter.loading || !state.selectedPath;
    els.datasetTempViewBtn.classList.toggle("active", temporaryView);
    els.datasetTempViewBtn.setAttribute("aria-pressed", temporaryView ? "true" : "false");
    const label = temporaryView ? "Return to normal dataset view" : "Show temporary dataset view";
    els.datasetTempViewBtn.setAttribute("aria-label", label);
  }
  if (els.datasetTempViewTooltipTitle) {
    els.datasetTempViewTooltipTitle.textContent = temporaryView
      ? "Temporary view is enabled"
      : "Temporary view is disabled";
  }
  if (els.datasetTempViewTooltipDescription) {
    els.datasetTempViewTooltipDescription.textContent = temporaryView
      ? "Temporary view shows all datasets that can be generated. Click to return to Normal view."
      : "Normal view shows saved datasets only. Click to enable Temporary view.";
  }
  if (els.datasetRefreshBtn) {
    els.datasetRefreshBtn.disabled = cachedDatasetFilter.loading || !state.selectedPath;
  }
  syncDatasetIndexUpdatePrompt();
  if (!els.cachedDatasetStatus) return;
  if (indexWarning) {
    els.cachedDatasetStatus.setAttribute("aria-label", indexWarning);
  } else {
    els.cachedDatasetStatus.removeAttribute("aria-label");
  }
  if (!state.selectedPath) {
    els.cachedDatasetStatus.textContent = "";
    return;
  }
  if (cachedDatasetFilter.loading) {
    els.cachedDatasetStatus.textContent = temporaryView
      ? "Checking dataset index..."
      : "Checking cached datasets...";
    return;
  }
  if (cachedDatasetFilter.error) {
    els.cachedDatasetStatus.textContent = temporaryView
      ? "Dataset index check failed"
      : "Cached dataset check failed";
    return;
  }
  const count = Number.isFinite(cachedDatasetFilter.visibleCount)
    ? cachedDatasetFilter.visibleCount
    : cachedDatasetFilter.names.size;
  if (temporaryView) {
    els.cachedDatasetStatus.textContent = `Temporary view | ${count} ${count === 1 ? "dataset" : "datasets"}${indexWarning ? " | Warning: index not saved" : ""}`;
    return;
  }
  els.cachedDatasetStatus.textContent = `(${count} ${count === 1 ? "record" : "records"}${indexWarning ? " | Warning: index not saved" : ""})`;
}

function getSnapshotFolderPaths(payload) {
  const raw = payload?.folder_paths && typeof payload.folder_paths === "object"
    ? payload.folder_paths
    : payload?.folderPaths && typeof payload.folderPaths === "object"
      ? payload.folderPaths
      : {};
  return raw && typeof raw === "object" ? raw : {};
}

function getSnapshotDataFolder(payload) {
  const folderPaths = getSnapshotFolderPaths(payload);
  return toText(folderPaths.data || payload?.folder_path || payload?.folderPath);
}

function ensureDatasetIndexWatchListener() {
  if (datasetIndexWatch.unsubscribe || typeof window.ADAHost?.onProjectInstanceIndexChanged !== "function") return;
  datasetIndexWatch.unsubscribe = window.ADAHost.onProjectInstanceIndexChanged((payload) => {
    if (!payload || payload.watchId !== datasetIndexWatch.watchId) return;
    if (payload.error) {
      datasetIndexWatch.error = toText(payload.error);
      datasetIndexWatch.pending = false;
      syncDatasetIndexUpdatePrompt();
      return;
    }
    if (Date.now() < Number(datasetIndexWatch.suppressUntil || 0)) return;
    datasetIndexWatch.pending = true;
    datasetIndexWatch.error = "";
    syncDatasetIndexUpdatePrompt();
  });
}

async function stopDatasetIndexWatch(options = {}) {
  const watchId = toText(datasetIndexWatch.watchId);
  datasetIndexWatch.watchId = "";
  datasetIndexWatch.path = "";
  datasetIndexWatch.selectedPath = "";
  datasetIndexWatch.error = "";
  datasetIndexWatch.suppressUntil = 0;
  if (options?.clearPending !== false) datasetIndexWatch.pending = false;
  if (watchId && typeof window.ADAHost?.stopProjectInstanceIndexWatch === "function") {
    try {
      await window.ADAHost.stopProjectInstanceIndexWatch({ watchId });
    } catch {
      // Manual refresh remains available if a host watcher cannot be stopped.
    }
  }
  syncDatasetIndexUpdatePrompt();
}

async function startDatasetIndexWatchForSnapshot(payload, selectedPath) {
  const folderPath = getSnapshotDataFolder(payload);
  const indexFileName = toText(payload?.index_file_name || payload?.indexFileName);
  const normalizedSelectedPath = normalizePath(selectedPath);
  if (!folderPath || !indexFileName || !normalizedSelectedPath || typeof window.ADAHost?.startProjectInstanceIndexWatch !== "function") {
    await stopDatasetIndexWatch();
    return;
  }
  if (
    datasetIndexWatch.watchId
    && datasetIndexWatch.path === folderPath
    && normalizePath(datasetIndexWatch.selectedPath).toLowerCase() === normalizedSelectedPath.toLowerCase()
  ) {
    return;
  }
  await stopDatasetIndexWatch();
  ensureDatasetIndexWatchListener();
  try {
    const result = await window.ADAHost.startProjectInstanceIndexWatch({
      path: folderPath,
      indexFileName,
    });
    if (normalizePath(state.selectedPath).toLowerCase() !== normalizedSelectedPath.toLowerCase()) {
      if (result?.watchId && typeof window.ADAHost?.stopProjectInstanceIndexWatch === "function") {
        try { await window.ADAHost.stopProjectInstanceIndexWatch({ watchId: result.watchId }); } catch {}
      }
      return;
    }
    if (!result?.ok || !result.watchId) {
      datasetIndexWatch.error = toText(result?.error);
      syncDatasetIndexUpdatePrompt();
      return;
    }
    datasetIndexWatch.watchId = toText(result.watchId);
    datasetIndexWatch.path = toText(result.path) || folderPath;
    datasetIndexWatch.selectedPath = normalizedSelectedPath;
    datasetIndexWatch.pending = false;
    datasetIndexWatch.error = "";
    syncDatasetIndexUpdatePrompt();
  } catch (err) {
    datasetIndexWatch.error = toText(err?.message) || "Could not watch dataset index.";
    syncDatasetIndexUpdatePrompt();
  }
}


function shouldUseCachedDatasetFilter() {
  return (
    !cachedDatasetFilter.loading
    && !cachedDatasetFilter.error
    && state.selectedPath
    && normalizePath(cachedDatasetFilter.loadedPath).toLowerCase() === normalizePath(state.selectedPath).toLowerCase()
  );
}

function hasCachedDatasetMetadataForSelectedPath() {
  return (
    state.selectedPath
    && normalizePath(cachedDatasetFilter.loadedPath).toLowerCase() === normalizePath(state.selectedPath).toLowerCase()
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


function getCachedFileDatasetNames(item) {
  const names = [];
  const add = (value) => {
    const text = toText(value);
    if (text) names.push(text);
  };
  add(item?.name);

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
    formula: "",
    status: 0,
    _lastModifiedTs: 0,
    _createdTs: 0,
    _userModifiedTs: 0,
    _formulaModifiedTs: 0,
  };

  const lastModifiedRaw = item?.last_modified || item?.last_modified_timestamp || item?.mtime;
  const lastModified = formatCachedTimestamp(lastModifiedRaw);
  const lastModifiedTs = getTimestampNumber(lastModifiedRaw) || getTimestampNumber(item?.last_modified_timestamp) || getTimestampNumber(item?.mtime);
  if (lastModified && (!meta.lastModified || lastModifiedTs >= meta._lastModifiedTs)) {
    meta.lastModified = lastModified;
    meta._lastModifiedTs = lastModifiedTs;
  }

  const createdRaw = item?.created || item?.created_timestamp;
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

  const formula = toText(item?.formula);
  if (formula && (!meta.formula || lastModifiedTs >= meta._formulaModifiedTs)) {
    meta.formula = formula;
    meta._formulaModifiedTs = lastModifiedTs;
  }

  const originLength = Number(item?.origin_length);
  if (Number.isFinite(originLength) && originLength > 0 && (!meta.originLength || lastModifiedTs >= (meta._originLengthModifiedTs || 0))) {
    meta.originLength = Math.trunc(originLength);
    meta._originLengthModifiedTs = lastModifiedTs;
  }
  const developmentLength = Number(item?.development_length);
  if (
    Number.isFinite(developmentLength)
    && developmentLength > 0
    && (!meta.developmentLength || lastModifiedTs >= (meta._developmentLengthModifiedTs || 0))
  ) {
    meta.developmentLength = Math.trunc(developmentLength);
    meta._developmentLengthModifiedTs = lastModifiedTs;
  }
  const status = Number(item?.status);
  if (Number.isFinite(status) && (status === 0 || status === 2) && (!meta._statusModifiedTs || lastModifiedTs >= meta._statusModifiedTs)) {
    meta.status = status;
    meta._statusModifiedTs = lastModifiedTs;
  }
  return meta;
}

function normalizeCachedDatasetSnapshot(payload) {
  const files = Array.isArray(payload?.files) ? payload.files : [];
  const metadataByName = new Map();
  const methodTypesByName = new Map();
  const datasetKeys = new Set();
  const addDatasetKey = (name) => {
    const key = getCachedDatasetKey(name);
    if (key) datasetKeys.add(key);
  };
  const addMethodType = (name, methodType) => {
    const key = normalizeLookupKey(name);
    const type = toText(methodType);
    if (key && type) methodTypesByName.set(key, type);
  };
  for (const item of files) {
    const itemNames = getCachedFileDatasetNames(item);
    for (const name of itemNames) {
      addDatasetKey(name);
      const key = getCachedDatasetKey(name);
      if (!key) continue;
      metadataByName.set(key, mergeCachedDatasetMetadata(metadataByName.get(key), item));
    }
    if (item?.method_type) {
      for (const name of itemNames) addMethodType(name, item.method_type);
    }
  }
  return {
    names: datasetKeys,
    instanceRows: files,
    metadataByName,
    methodTypesByName,
  };
}

async function fetchCachedDatasetSnapshot(path, options = {}) {
  const normalizedPath = normalizePath(path);
  const refresh = !!options?.refresh;
  const requestKey = `${normalizeLookupKey(projectName)}\u0001${normalizedPath.toLowerCase()}\u0001${refresh ? "refresh" : "cached"}`;
  const existing = cachedDatasetSnapshotRequests.get(requestKey);
  if (existing) return existing;

  const request = (async () => {
    const url = new URL("/datasets/cached", window.location.origin);
    url.searchParams.set("project_name", projectName);
    url.searchParams.set("reserving_class", normalizedPath);
    if (refresh) url.searchParams.set("refresh", "true");
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

function applyCachedDatasetSnapshot(payload, path = state.selectedPath) {
  const normalizedPath = normalizePath(path);
  const snapshot = normalizeCachedDatasetSnapshot(payload);
  publishProjectInstanceDatasetSnapshot(projectName, normalizedPath, payload);
  cachedDatasetFilter.names = snapshot.names;
  cachedDatasetFilter.instanceRows = snapshot.instanceRows;
  cachedDatasetFilter.metadataByName = snapshot.metadataByName;
  cachedDatasetFilter.methodTypesByName = snapshot.methodTypesByName;
  cachedDatasetFilter.loadedPath = normalizedPath;
  cachedDatasetFilter.error = "";
  cachedDatasetFilter.warning = payload?.index_persisted === false
    ? toText(payload?.index_warning) || "Dataset table loaded, but index.json could not be updated."
    : "";
  void startDatasetIndexWatchForSnapshot(payload, normalizedPath);
}

async function loadCachedDatasetFilterForSelectedPath(options = {}) {
  const path = normalizePath(state.selectedPath);
  const seq = cachedDatasetFilter.requestSeq + 1;
  cachedDatasetFilter.requestSeq = seq;
  cachedDatasetFilter.error = "";
  cachedDatasetFilter.warning = "";
  cachedDatasetFilter.names = new Set();
  cachedDatasetFilter.instanceRows = [];
  cachedDatasetFilter.metadataByName = new Map();
  cachedDatasetFilter.methodTypesByName = new Map();
  cachedDatasetFilter.loadedPath = path;
  if (!path || normalizePath(datasetIndexWatch.selectedPath).toLowerCase() !== path.toLowerCase()) {
    await stopDatasetIndexWatch();
  }

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
    const payload = await fetchCachedDatasetSnapshot(path, { refresh: !!options?.refresh });
    if (seq !== cachedDatasetFilter.requestSeq) return;
    applyCachedDatasetSnapshot(payload, path);
  } catch (err) {
    if (seq !== cachedDatasetFilter.requestSeq) return;
    cachedDatasetFilter.names = new Set();
    cachedDatasetFilter.instanceRows = [];
    cachedDatasetFilter.metadataByName = new Map();
    cachedDatasetFilter.methodTypesByName = new Map();
    cachedDatasetFilter.error = toText(err?.message) || "Cached dataset lookup failed.";
    cachedDatasetFilter.warning = "";
    setStatus(cachedDatasetFilter.error, true);
  } finally {
    if (seq !== cachedDatasetFilter.requestSeq) return;
    cachedDatasetFilter.loading = false;
    syncCachedDatasetToolbar();
    renderDatasetTable();
  }
}

async function refreshCachedDatasetTableFromDisk() {
  if (!state.selectedPath) {
    setStatus("Select a reserving-class path before refreshing the dataset table.", true);
    return false;
  }
  const scrollState = {
    left: Number(els.datasetTableWrap?.scrollLeft) || 0,
    top: Number(els.datasetTableWrap?.scrollTop) || 0,
  };
  const selectionState = captureDatasetTableSelection();
  closeDatasetTableFilterPopover();
  datasetIndexWatch.suppressUntil = Date.now() + 1500;
  setStatus(isTemporaryDatasetView()
    ? "Refreshing dataset index status..."
    : "Refreshing dataset table...");
  await loadCachedDatasetFilterForSelectedPath({ refresh: true });
  restoreDatasetTableSelection(selectionState);
  restoreDatasetTableScroll(scrollState);
  if (!cachedDatasetFilter.error) {
    datasetIndexWatch.pending = false;
    syncDatasetIndexUpdatePrompt();
    if (cachedDatasetFilter.warning) {
      setStatus(cachedDatasetFilter.warning, true);
      return true;
    }
    setStatus(isTemporaryDatasetView()
      ? "Dataset index status refreshed."
      : "Dataset table refreshed.");
    return true;
  }
  return false;
}

async function enterTemporaryDatasetView() {
  if (!state.selectedPath) {
    setStatus("Select a reserving class path before opening temporary view.", true);
    return false;
  }
  state.temporaryDatasetTableFilterState = captureNormalDatasetTableFilters();
  state.datasetTableView?.filters?.clear?.();
  state.datasetTableExplicitAllFilterKeys?.clear?.();
  state.datasetViewMode = "temporary";
  state.temporaryDatasetSessionId = createTemporaryDatasetSessionId();
  state.datasetTableSelection?.selectedKeys?.clear?.();
  if (state.datasetTableSelection) state.datasetTableSelection.anchorKey = "";
  syncCachedDatasetToolbar();
  renderDatasetTable();
  if (!shouldUseCachedDatasetFilter()) await loadCachedDatasetFilterForSelectedPath();
  setStatus("Temporary view is active. Opened datasets are read-only; generated CSV caches are retained without sidecars or index entries.");
  return true;
}

async function leaveTemporaryDatasetView() {
  if (!isTemporaryDatasetView()) return true;
  const sessionId = toText(state.temporaryDatasetSessionId);
  const closeTemporaryDatasetWindows = api.closeTemporaryDatasetWindows;
  if (typeof closeTemporaryDatasetWindows === "function") {
    const closed = closeTemporaryDatasetWindows(sessionId);
    if (closed === false) {
      setStatus("Close the temporary dataset window before leaving temporary view.", true);
      return false;
    }
  }
  state.datasetViewMode = "normal";
  state.temporaryDatasetSessionId = "";
  restoreNormalDatasetTableFilters();
  state.datasetTableSelection?.selectedKeys?.clear?.();
  if (state.datasetTableSelection) state.datasetTableSelection.anchorKey = "";
  syncCachedDatasetToolbar();
  renderDatasetTable();
  setStatus("Returned to normal dataset view.");
  return true;
}

async function toggleDatasetViewMode() {
  return isTemporaryDatasetView()
    ? leaveTemporaryDatasetView()
    : enterTemporaryDatasetView();
}

function restoreDatasetTableScroll(scrollState) {
  const wrap = els.datasetTableWrap;
  if (!wrap || !scrollState) return;
  const apply = () => {
    const maxLeft = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
    const maxTop = Math.max(0, wrap.scrollHeight - wrap.clientHeight);
    wrap.scrollLeft = Math.max(0, Math.min(Number(scrollState.left) || 0, maxLeft));
    wrap.scrollTop = Math.max(0, Math.min(Number(scrollState.top) || 0, maxTop));
  };
  apply();
  window.requestAnimationFrame(apply);
}

function initCachedDatasetToolbar() {
  if (els.datasetRefreshBtn && els.datasetRefreshBtn.dataset.wired !== "1") {
    els.datasetRefreshBtn.dataset.wired = "1";
    attachArcrhoTooltip(els.datasetRefreshBtn, "Refresh Dataset Table");
    els.datasetRefreshBtn.addEventListener("click", () => {
      void refreshCachedDatasetTableFromDisk();
    });
  }
  if (els.datasetTempViewBtn && els.datasetTempViewBtn.dataset.wired !== "1") {
    els.datasetTempViewBtn.dataset.wired = "1";
    els.datasetTempViewBtn.addEventListener("click", () => {
      void toggleDatasetViewMode();
    });
  }
  if (els.datasetIndexUpdateBtn && els.datasetIndexUpdateBtn.dataset.wired !== "1") {
    els.datasetIndexUpdateBtn.dataset.wired = "1";
    els.datasetIndexUpdateBtn.addEventListener("click", () => {
      void refreshCachedDatasetTableFromDisk();
    });
  }
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => {
      if (datasetIndexWatch.unsubscribe) {
        try { datasetIndexWatch.unsubscribe(); } catch {}
        datasetIndexWatch.unsubscribe = null;
      }
      void stopDatasetIndexWatch();
    }, { once: true });
  }
  syncCachedDatasetToolbar();
}

  Object.assign(api, {
    applyCachedDatasetSnapshot,
    fetchCachedDatasetSnapshot,
    formatCachedTimestamp,
    getCachedFileDatasetNames,
    getTimestampNumber,
    hasCachedDatasetMetadataForSelectedPath,
    hasCachedDatasetSnapshotForSelectedPath,
    initCachedDatasetToolbar,
    isDatasetRecordCached,
    loadCachedDatasetFilterForSelectedPath,
    mergeCachedDatasetMetadata,
    normalizeCachedDatasetSnapshot,
    refreshCachedDatasetTableFromDisk,
    startDatasetIndexWatchForSnapshot,
    shouldUseCachedDatasetFilter,
    stopDatasetIndexWatch,
    syncCachedDatasetToolbar,
    toggleDatasetViewMode,
    isTemporaryDatasetView,
  });
}

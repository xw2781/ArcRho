export function installProjectInstanceDatasetCache(ctx) {
  const { api, els, projectName, state } = ctx;
  const { ACTIVE_PATH_FOLDER_WATCH_INTERVAL_MS } = ctx.constants;
  const { cachedDatasetFilter, cachedDatasetSnapshotRequests, activePathFolderWatch } = state;
  const closeDatasetTableFilterPopover = (...args) => api.closeDatasetTableFilterPopover(...args);
  const getCachedDatasetKey = (...args) => api.getCachedDatasetKey(...args);
  const getDatasetName = (...args) => api.getDatasetName(...args);
  const normalizeLookupKey = (...args) => api.normalizeLookupKey(...args);
  const normalizePath = (...args) => api.normalizePath(...args);
  const renderDatasetTable = (...args) => api.renderDatasetTable(...args);
  const setStatus = (...args) => api.setStatus(...args);
  const toText = (...args) => api.toText(...args);

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
  if (!state.selectedPath) {
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

function rememberActivePathFolderSignature(payload, path = state.selectedPath) {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath || normalizePath(state.selectedPath).toLowerCase() !== normalizedPath.toLowerCase()) return;
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
  const path = normalizePath(state.selectedPath);
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

function resetActivePathFolderWatch(path = state.selectedPath, options = {}) {
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
  const path = normalizePath(state.selectedPath);
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

  Object.assign(api, {
    checkActivePathFolderSnapshot,
    clearDiskChangeNotice,
    ensureActivePathFolderWatch,
    fetchCachedDatasetSnapshot,
    formatCachedTimestamp,
    getCachedDatasetInstanceSignature,
    getCachedDatasetSnapshotSignature,
    getCachedFileDatasetNames,
    getTimestampNumber,
    hasCachedDatasetMetadataForSelectedPath,
    hasCachedDatasetSnapshotForSelectedPath,
    initCachedDatasetToolbar,
    isDatasetRecordCached,
    loadCachedDatasetFilterForSelectedPath,
    mergeCachedDatasetMetadata,
    normalizeCachedDatasetSnapshot,
    reloadProjectInstanceAfterDiskChange,
    rememberActivePathFolderSignature,
    resetActivePathFolderWatch,
    setCachedDatasetFilterEnabled,
    shouldUseCachedDatasetFilter,
    showDiskChangeNotice,
    splitLengthScopedDatasetName,
    syncCachedDatasetToolbar,
    syncDiskChangeToolbarAlert
  });
}

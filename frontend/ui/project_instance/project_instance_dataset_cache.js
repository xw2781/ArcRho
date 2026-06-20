export function installProjectInstanceDatasetCache(ctx) {
  const { api, els, projectName, state } = ctx;
  const { cachedDatasetFilter, cachedDatasetSnapshotRequests } = state;
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
  if (els.datasetRefreshBtn) {
    els.datasetRefreshBtn.disabled = cachedDatasetFilter.loading || !state.selectedPath;
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
  els.cachedDatasetStatus.textContent = `(${count} ${count === 1 ? "record" : "records"})`;
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


function stripDatasetCacheVariantSuffix(value) {
  const text = toText(value);
  const parts = text.split("@");
  if (
    parts.length >= 5
    && /^(dev|cal)$/i.test(parts[parts.length - 1])
    && /^(cum|inc)$/i.test(parts[parts.length - 2])
    && /^\d+$/.test(parts[parts.length - 3])
    && /^\d+$/.test(parts[parts.length - 4])
  ) {
    return parts.slice(0, -4).join("@").trim();
  }
  return text;
}

function getCachedFileDatasetNames(item) {
  const names = [];
  const add = (value) => {
    const text = stripDatasetCacheVariantSuffix(value);
    if (text) names.push(text);
  };
  if (Array.isArray(item?.dataset_names)) {
    for (const name of item.dataset_names) add(name);
  }
  add(item?.dataset_name);
  add(item?.instance_name);

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
    formula: "",
    status: 0,
    _lastModifiedTs: 0,
    _createdTs: 0,
    _userModifiedTs: 0,
    _formulaModifiedTs: 0,
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
  if (Array.isArray(item?.origin_labels) && item.origin_labels.length && (!meta.originLabels?.length || lastModifiedTs >= (meta._originLabelsModifiedTs || 0))) {
    meta.originLabels = item.origin_labels.map((label) => String(label));
    meta._originLabelsModifiedTs = lastModifiedTs;
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
  if (Array.isArray(payload?.dataset_names)) {
    for (const name of payload.dataset_names) addDatasetKey(name);
  }
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
  cachedDatasetFilter.names = snapshot.names;
  cachedDatasetFilter.instanceRows = snapshot.instanceRows;
  cachedDatasetFilter.metadataByName = snapshot.metadataByName;
  cachedDatasetFilter.methodTypesByName = snapshot.methodTypesByName;
  cachedDatasetFilter.loadedPath = normalizedPath;
  cachedDatasetFilter.error = "";
}

async function loadCachedDatasetFilterForSelectedPath(options = {}) {
  const path = normalizePath(state.selectedPath);
  const seq = cachedDatasetFilter.requestSeq + 1;
  cachedDatasetFilter.requestSeq = seq;
  cachedDatasetFilter.error = "";
  cachedDatasetFilter.names = new Set();
  cachedDatasetFilter.instanceRows = [];
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
  setStatus("Refreshing dataset table...");
  await loadCachedDatasetFilterForSelectedPath({ refresh: true });
  restoreDatasetTableSelection(selectionState);
  restoreDatasetTableScroll(scrollState);
  if (!cachedDatasetFilter.error) {
    setStatus("Dataset table refreshed.");
    return true;
  }
  return false;
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

function setCachedDatasetFilterEnabled(enabled) {
  const next = !!enabled;
  if (cachedDatasetFilter.enabled === next) return;
  cachedDatasetFilter.enabled = next;
  closeDatasetTableFilterPopover();
  syncCachedDatasetToolbar();
  renderDatasetTable();
}


function initCachedDatasetToolbar() {
  if (els.cachedDatasetToggle && els.cachedDatasetToggle.dataset.wired !== "1") {
    els.cachedDatasetToggle.dataset.wired = "1";
    els.cachedDatasetToggle.addEventListener("click", () => {
      setCachedDatasetFilterEnabled(!cachedDatasetFilter.enabled);
    });
  }
  if (els.datasetRefreshBtn && els.datasetRefreshBtn.dataset.wired !== "1") {
    els.datasetRefreshBtn.dataset.wired = "1";
    els.datasetRefreshBtn.addEventListener("click", () => {
      void refreshCachedDatasetTableFromDisk();
    });
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
    setCachedDatasetFilterEnabled,
    shouldUseCachedDatasetFilter,
    stripDatasetCacheVariantSuffix,
    syncCachedDatasetToolbar
  });
}

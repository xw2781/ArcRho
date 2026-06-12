export function installProjectInstanceDatasetTable(ctx) {
  const { api, els, projectName, state } = ctx;
  const {
    fetchProjectDatasetTypes,
    loadProjectUserPreferences,
    scheduleProjectUserPreferencesSave,
  } = ctx;
  const { DATASET_TABLE_COLUMNS, DATASET_COLUMNS, DATASET_TABLE_AUTOFIT_MAX_WIDTH, DATASET_TABLE_AUTOFIT_CELL_EXTRA_WIDTH, DATASET_TABLE_AUTOFIT_HEADER_EXTRA_WIDTH, DATASET_TABLE_BLANK_LABEL, DATASET_FILTER_CHIP_VALUE_LIMIT } = ctx.constants;
  const { datasetTablePreferenceWidthKeys, datasetTableView, cachedDatasetFilter, datasetTableSelection } = state;
  const beginPageLoading = (...args) => api.beginPageLoading(...args);
  const finishPageLoading = (...args) => api.finishPageLoading(...args);
  const getCachedDatasetKey = (...args) => api.getCachedDatasetKey(...args);
  const hasCachedDatasetMetadataForSelectedPath = (...args) => api.hasCachedDatasetMetadataForSelectedPath(...args);
  const isDatasetRecordCached = (...args) => api.isDatasetRecordCached(...args);
  const loadCachedDatasetFilterForSelectedPath = (...args) => api.loadCachedDatasetFilterForSelectedPath(...args);
  const normalizeLookupKey = (...args) => api.normalizeLookupKey(...args);
  const normalizePath = (...args) => api.normalizePath(...args);
  const openDatasetWindow = (...args) => api.openDatasetWindow(...args);
  const openDfmWindow = (...args) => api.openDfmWindow(...args);
  const postProjectInstanceStatus = (...args) => api.postProjectInstanceStatus(...args);
  const setStatus = (...args) => api.setStatus(...args);
  const shouldUseCachedDatasetFilter = (...args) => api.shouldUseCachedDatasetFilter(...args);
  const showDatasetAddPicker = (...args) => api.showDatasetAddPicker(...args);
  const syncCachedDatasetToolbar = (...args) => api.syncCachedDatasetToolbar(...args);
  const toText = (...args) => api.toText(...args);

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
  if (state.datasetFilterTooltip?.isConnected) return state.datasetFilterTooltip;
  state.datasetFilterTooltip = document.createElement("div");
  state.datasetFilterTooltip.className = "dataset-filter-chip-tooltip";
  state.datasetFilterTooltip.setAttribute("role", "tooltip");
  state.datasetFilterTooltip.setAttribute("aria-hidden", "true");
  document.body.appendChild(state.datasetFilterTooltip);
  return state.datasetFilterTooltip;
}

function positionDatasetFilterTooltip(chip) {
  if (!state.datasetFilterTooltip?.classList?.contains("active") || !chip?.getBoundingClientRect) return;
  const chipRect = chip.getBoundingClientRect();
  const tooltipRect = state.datasetFilterTooltip.getBoundingClientRect();
  const pad = 8;
  const left = Math.max(pad, Math.min(chipRect.left, window.innerWidth - tooltipRect.width - pad));
  const top = Math.max(pad, Math.min(chipRect.bottom + 6, window.innerHeight - tooltipRect.height - pad));
  state.datasetFilterTooltip.style.left = `${Math.round(left)}px`;
  state.datasetFilterTooltip.style.top = `${Math.round(top)}px`;
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
  if (!state.datasetFilterTooltip) return;
  state.datasetFilterTooltip.classList.remove("active");
  state.datasetFilterTooltip.setAttribute("aria-hidden", "true");
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


function getDatasetRecordKey(record) {
  const rowIndex = Number(record?.rowIndex);
  if (Number.isInteger(rowIndex) && rowIndex >= 0) return `row-${rowIndex}`;
  const name = toText(record?.datasetName);
  return name ? `name-${name.toLowerCase()}` : "";
}

function getDatasetSelectionName(record) {
  return normalizeLookupKey(record?.datasetName || getDatasetRecordValue(record, "name"));
}

function captureDatasetTableSelection() {
  pruneDatasetTableSelection();
  const selectedNames = [];
  for (const record of getSelectedDatasetRecords()) {
    const name = getDatasetSelectionName(record);
    if (name) selectedNames.push(name);
  }
  return {
    selectedNames,
    anchorName: getDatasetSelectionName(getDatasetRecordByKey(datasetTableSelection.anchorKey)),
    selectedKeys: Array.from(datasetTableSelection.selectedKeys),
    anchorKey: datasetTableSelection.anchorKey,
  };
}

function restoreDatasetTableSelection(selectionState) {
  if (!selectionState) return;
  const selectedNames = new Set(
    (Array.isArray(selectionState.selectedNames) ? selectionState.selectedNames : [])
      .map((name) => normalizeLookupKey(name))
      .filter(Boolean)
  );
  const oldSelectedKeys = new Set(
    (Array.isArray(selectionState.selectedKeys) ? selectionState.selectedKeys : [])
      .map((key) => toText(key))
      .filter(Boolean)
  );
  const anchorName = normalizeLookupKey(selectionState.anchorName);
  const oldAnchorKey = toText(selectionState.anchorKey);
  let nextAnchorKey = "";

  datasetTableSelection.selectedKeys.clear();
  datasetTableSelection.anchorKey = "";

  for (const record of state.datasetTableVisibleRecords) {
    const recordKey = getDatasetRecordKey(record);
    if (!recordKey) continue;
    const name = getDatasetSelectionName(record);
    const selected = (name && selectedNames.has(name)) || (!selectedNames.size && oldSelectedKeys.has(recordKey));
    if (!selected) continue;
    datasetTableSelection.selectedKeys.add(recordKey);
    if (!nextAnchorKey && ((anchorName && name === anchorName) || (!anchorName && recordKey === oldAnchorKey))) {
      nextAnchorKey = recordKey;
    }
  }

  datasetTableSelection.anchorKey = nextAnchorKey || datasetTableSelection.selectedKeys.values().next().value || "";
  syncDatasetTableSelectionDom();
}

function pruneDatasetTableSelection() {
  const visibleKeys = new Set(state.datasetTableVisibleRecords.map(getDatasetRecordKey).filter(Boolean));
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
  return state.datasetTableVisibleRecords.filter((record) => datasetTableSelection.selectedKeys.has(getDatasetRecordKey(record)));
}

function getDatasetRecordByKey(key) {
  const normalized = toText(key);
  return state.datasetTableVisibleRecords.find((record) => getDatasetRecordKey(record) === normalized) || null;
}

function getDatasetRecordIndexByKey(key) {
  const normalized = toText(key);
  if (!normalized) return -1;
  return state.datasetTableVisibleRecords.findIndex((record) => getDatasetRecordKey(record) === normalized);
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
  if (!state.datasetTableVisibleRecords.length) return false;
  const clamped = Math.max(0, Math.min(state.datasetTableVisibleRecords.length - 1, Number(index)));
  const record = state.datasetTableVisibleRecords[clamped];
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

function selectDatasetRecordByName(datasetName) {
  const targetKey = normalizeLookupKey(datasetName);
  if (!targetKey) return false;
  const record = state.datasetTableVisibleRecords.find((item) => normalizeLookupKey(item?.datasetName) === targetKey);
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
  const visibleKeys = state.datasetTableVisibleRecords.map(getDatasetRecordKey).filter(Boolean);
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
    openDatasetRecord(state.datasetTableVisibleRecords[activeIndex]);
    return;
  }
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const activeIndex = getActiveDatasetSelectionIndex();
  if (activeIndex < 0) return;
  const nextIndex = activeIndex + (event.key === "ArrowDown" ? 1 : -1);
  if (nextIndex < 0 || nextIndex >= state.datasetTableVisibleRecords.length) {
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
    if (state.lastDatasetSelectionStatusCount !== count) {
      postProjectInstanceStatus(`${count} datasets selected`);
    }
    state.lastDatasetSelectionStatusCount = count;
    return;
  }
  if (state.lastDatasetSelectionStatusCount > 1) {
    postProjectInstanceStatus("Status: Ready");
  }
  state.lastDatasetSelectionStatusCount = count;
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
  if (!state.datasetTablePreferencesLoaded || !projectName) return;
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
  if (!projectName || state.datasetTablePreferencesLoaded) {
    state.datasetTablePreferencesLoaded = true;
    return;
  }
  try {
    const prefs = await loadProjectUserPreferences(projectName);
    applyDatasetTablePreferences(getDatasetTablePreferencesSource(prefs));
  } catch (err) {
    console.warn("Failed to load project instance dataset table preferences:", err);
  } finally {
    state.datasetTablePreferencesLoaded = true;
  }
}


function setEmptyTable(message, options = {}) {
  if (!els.datasetTableSurface) return;
  els.datasetTableSurface.innerHTML = "";
  if (options.allowAddDataset) {
    els.datasetTableSurface.dataset.emptyAddDataset = "1";
  } else {
    delete els.datasetTableSurface.dataset.emptyAddDataset;
  }
  syncDatasetActiveFiltersToolbar();
  const table = document.createElement("table");
  table.className = "pi-table";
  const tbody = document.createElement("tbody");
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.className = "pi-table-empty";
  if (options.allowAddDataset) {
    td.dataset.emptyAction = "add-dataset";
    td.title = "Right-click to add a dataset";
  }
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

function getDatasetTypeRowByName(name) {
  const key = normalizeLookupKey(name);
  if (!key) return null;
  return state.datasetRows.find((row) => normalizeLookupKey(getDatasetName(row)) === key) || null;
}

function getInstanceDatasetName(item) {
  return stripDatasetCacheVariantSuffix(toText(item?.dataset_name || item?.instance_name || item?.name));
}

function getInstanceDatasetTypeName(item, instanceName = "") {
  return toText(item?.dataset_type_name || item?.dataset_type || item?.datasetTypeName || item?.datasetType) || instanceName;
}

function parseDatasetGeneratedFlag(value) {
  if (typeof value === "boolean") return value;
  const text = toText(value).toLowerCase();
  return text === "true" || text === "1" || text === "yes" || text === "y";
}

function getDatasetGenerated(row) {
  return parseDatasetGeneratedFlag(row?.[5]);
}

function getMethodType(row) {
  if (!state.selectedPath) return "None";
  if (normalizePath(cachedDatasetFilter.loadedPath).toLowerCase() !== normalizePath(state.selectedPath).toLowerCase()) {
    return "None";
  }
  return cachedDatasetFilter.methodTypesByName.get(normalizeLookupKey(getDatasetName(row))) || "None";
}

function getCachedDatasetMetadata(row) {
  if (!hasCachedDatasetMetadataForSelectedPath()) return null;
  const key = getCachedDatasetKey(getDatasetName(row));
  return key ? cachedDatasetFilter.metadataByName.get(key) || null : null;
}

function getCachedDatasetMetadataByName(name) {
  if (!hasCachedDatasetMetadataForSelectedPath()) return null;
  const key = getCachedDatasetKey(name);
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

function getDatasetRecordCellValue(row, key, instance = null) {
  const instanceName = instance ? getInstanceDatasetName(instance) : getDatasetName(row);
  const datasetTypeName = instance ? getInstanceDatasetTypeName(instance, instanceName) : getDatasetName(row);
  const meta = instance ? getCachedDatasetMetadataByName(instanceName) : getCachedDatasetMetadata(row);
  switch (key) {
    case "name":
      return instanceName;
    case "datasetTypeName":
      return datasetTypeName;
    case "dataFormat":
      return toText(row?.[1]);
    case "formula":
      return instance ? (meta?.formula || toText(instance?.formula)) : toText(row?.[4]);
    case "category":
      return toText(row?.[2]);
    case "methodType":
      return instance?.method_type || cachedDatasetFilter.methodTypesByName.get(normalizeLookupKey(instanceName)) || getMethodType(row);
    case "lastModified":
      return meta?.lastModified || "";
    case "created":
      return meta?.created || "";
    case "user":
      return meta?.user || "";
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

function getDatasetRecordTimestamp(record, key) {
  const meta = record?.meta || getCachedDatasetMetadata(record?.row);
  const raw = key === "lastModified"
    ? meta?._lastModifiedTs
    : key === "created"
      ? meta?._createdTs
      : 0;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function compareTimestampValues(a, b, key, dir) {
  const left = getDatasetRecordTimestamp(a, key);
  const right = getDatasetRecordTimestamp(b, key);
  if (left && right && left !== right) return (left - right) * dir;
  if (left && !right) return -1;
  if (!left && right) return 1;
  return 0;
}

function buildDatasetRecord(row, rowIndex, instance = null) {
  const instanceName = instance ? getInstanceDatasetName(instance) : getDatasetName(row);
  const datasetTypeName = instance ? getInstanceDatasetTypeName(instance, instanceName) : getDatasetName(row);
  const typeRow = instance ? (getDatasetTypeRowByName(datasetTypeName) || row || []) : row;
  const values = {};
  for (const col of DATASET_TABLE_COLUMNS) {
    values[col.key] = getDatasetRecordCellValue(typeRow, col.key, instance);
  }
  const datasetName = values.name || instanceName || getDatasetName(typeRow);
  const generated = parseDatasetGeneratedFlag(instance?.generated) || getDatasetGenerated(typeRow);
  const meta = getCachedDatasetMetadataByName(datasetName);
  return {
    row: typeRow,
    rowIndex,
    instance,
    datasetName,
    datasetTypeName,
    generated,
    values,
    meta,
  };
}

function getDatasetRecordValue(record, key) {
  return toText(record?.values?.[key] ?? getDatasetCellValue(record?.row, key));
}

function isDfmDatasetRecord(record) {
  return normalizeLookupKey(getDatasetRecordValue(record, "methodType")) === "dfm";
}

function openDfmTabForDataset(record) {
  const datasetName = toText(record?.datasetName);
  if (!datasetName || !state.selectedPath) return;
  openDfmWindow(datasetName);
}

function recordSelectedDfmObject(methodName) {
  const name = toText(methodName);
  if (!projectName || !state.selectedPath || !name) return;
  scheduleProjectUserPreferencesSave(projectName, {
    lastReservingClassPath: state.selectedPath,
    dfmObject: {
      methodName: name,
      outputVector: name,
      updated_at: new Date().toISOString(),
    },
  });
}

function measureDatasetTableText(text) {
  if (!state.datasetTableMeasureCanvas) {
    state.datasetTableMeasureCanvas = document.createElement("canvas");
  }
  const ctx = state.datasetTableMeasureCanvas.getContext?.("2d");
  if (!ctx) return String(text || "").length * 7;
  ctx.font = "12px Segoe UI, Arial, sans-serif";
  return ctx.measureText(String(text || "")).width;
}

function clampInitialDatasetTableWidth(width, col) {
  const minWidth = col?.minWidth || 80;
  const measured = Math.ceil(Number(width) || minWidth);
  return Math.max(minWidth, Math.min(DATASET_TABLE_AUTOFIT_MAX_WIDTH, measured));
}

function getInitialDatasetTableColumnWidth(col, rows = state.datasetRows) {
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

function autoFitInitialDatasetTableWidths(rows = state.datasetRows) {
  for (const col of DATASET_TABLE_COLUMNS) {
    if (datasetTablePreferenceWidthKeys.has(col.key)) continue;
    datasetTableView.widths[col.key] = getInitialDatasetTableColumnWidth(col, rows);
  }
}

function buildDatasetTableRenderContext() {
  const sourceRecords = cachedDatasetFilter.enabled && shouldUseCachedDatasetFilter()
    ? (Array.isArray(cachedDatasetFilter.instanceRows) ? cachedDatasetFilter.instanceRows : [])
      .map((item, rowIndex) => {
        const instanceName = getInstanceDatasetName(item);
        const datasetTypeName = getInstanceDatasetTypeName(item, instanceName);
        return buildDatasetRecord(getDatasetTypeRowByName(datasetTypeName) || [], rowIndex, item);
      })
    : state.datasetRows.map((row, rowIndex) => buildDatasetRecord(row, rowIndex));
  const records = sourceRecords.filter((record) => record.datasetName);
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
  if (sortKey === "lastModified" || sortKey === "created") {
    const timestampCmp = compareTimestampValues(a, b, sortKey, dir);
    if (timestampCmp !== 0) return timestampCmp;
  } else {
    const cmp = compareTextValues(
      getDatasetRecordValue(a, sortKey),
      getDatasetRecordValue(b, sortKey)
    );
    if (cmp !== 0) return cmp * dir;
  }
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
  const records = state.datasetRows.map((row, rowIndex) => buildDatasetRecord(row, rowIndex));
  for (const record of records) {
    const value = getDatasetRecordValue(record, key);
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
  const records = Array.isArray(context?.records) ? context.records : state.datasetRows.map((row, rowIndex) => buildDatasetRecord(row, rowIndex));
  return records.filter((item) => (
    item.datasetName
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
    if (state.datasetTableColumnDragStarted) return;
    event.preventDefault();
    event.stopPropagation();
    toggleDatasetTableSort(col.key);
  });
  label.addEventListener("dragstart", (event) => {
    state.datasetTableColumnDragStarted = true;
    event.dataTransfer?.setData("text/x-pi-column", col.key);
    event.dataTransfer.effectAllowed = "move";
  });
  label.addEventListener("dragend", () => {
    clearDatasetColumnDragIndicators();
    window.setTimeout(() => {
      state.datasetTableColumnDragStarted = false;
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
  state.datasetTableVisibleRecords.push(item);
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
    openDatasetWindow(item.datasetName, {
      datasetTypeName: getDatasetRecordValue(item, "datasetTypeName"),
      readOnly: !!item.generated,
      generated: !!item.generated,
    });
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
  state.datasetTableVisibleRecords = [];
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
  state.datasetTableVisibleRecords = [];
  delete els.datasetTableSurface.dataset.emptyAddDataset;
  if (!state.datasetRows.length) {
    cachedDatasetFilter.visibleCount = 0;
    syncCachedDatasetToolbar();
    els.datasetTableSurface.innerHTML = "";
    pruneDatasetTableSelection();
    setEmptyTable("No dataset types are defined for this project.");
    return;
  }
  if (cachedDatasetFilter.enabled && !state.selectedPath) {
    cachedDatasetFilter.visibleCount = 0;
    syncCachedDatasetToolbar();
    els.datasetTableSurface.innerHTML = "";
    pruneDatasetTableSelection();
    setEmptyTable("Select a reserving class path to show cached datasets.");
    return;
  }
  if (state.selectedPath) {
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
      setEmptyTable("No dataset found in this path.", { allowAddDataset: true });
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
  state.datasetGroupContextId = "";
}

function closeDatasetRowContextMenu() {
  els.datasetRowContextMenu?.classList?.remove("open");
  els.datasetRowContextMenu?.setAttribute("aria-hidden", "true");
  state.datasetRowContextKey = "";
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
  state.datasetGroupContextId = groupId;
  closeDatasetTableContextMenu();
  closeDatasetRowContextMenu();
  closeDatasetTableFilterPopover();
  menu.classList.add("open");
  menu.setAttribute("aria-hidden", "false");
  positionFixedMenu(menu, x, y);
}

function showDatasetRowContextMenu(recordKey, x, y, options = {}) {
  const menu = els.datasetRowContextMenu;
  const emptyContext = !!options.emptyContext;
  if (!menu || (!recordKey && !emptyContext)) return;
  state.datasetRowContextKey = recordKey || "";
  closeDatasetTableContextMenu();
  closeDatasetGroupContextMenu();
  closeDatasetTableFilterPopover();
  const viewItem = menu.querySelector("[data-row-action='view']");
  if (viewItem) viewItem.disabled = emptyContext || !getDatasetRowViewRecord();
  const selectedCount = emptyContext ? 0 : getSelectedDatasetRecords().length;
  const deleteItem = menu.querySelector("[data-row-action='delete']");
  if (deleteItem) deleteItem.disabled = selectedCount === 0;
  menu.classList.add("open");
  menu.setAttribute("aria-hidden", "false");
  positionFixedMenu(menu, x, y);
}

function canShowDatasetEmptyAddContextMenu() {
  return (
    els.datasetTableSurface?.dataset?.emptyAddDataset === "1"
    && !!projectName
    && !!state.selectedPath
  );
}

function showDatasetEmptyAddContextMenu(x, y) {
  if (!canShowDatasetEmptyAddContextMenu()) return false;
  datasetTableSelection.selectedKeys.clear();
  datasetTableSelection.anchorKey = "";
  syncDatasetTableSelectionDom();
  focusDatasetTableSurface();
  showDatasetRowContextMenu("", x, y, { emptyContext: true });
  return true;
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
  const ids = getDatasetSameLevelGroupIds(state.datasetGroupContextId);
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
  openDatasetWindow(record.datasetName, {
    datasetTypeName: getDatasetRecordValue(record, "datasetTypeName"),
    readOnly: !!record.generated,
    generated: !!record.generated,
  });
}

function getDatasetRowActionRecords() {
  const contextRecord = getDatasetRecordByKey(state.datasetRowContextKey);
  const selectedRecords = getSelectedDatasetRecords();
  if (contextRecord && selectedRecords.some((record) => getDatasetRecordKey(record) === state.datasetRowContextKey)) {
    return selectedRecords;
  }
  return contextRecord ? [contextRecord] : selectedRecords;
}

function getDatasetRowViewRecord() {
  return getDatasetRecordByKey(state.datasetRowContextKey) || getSelectedDatasetRecords()[0] || null;
}

function buildAddDatasetTriPayload(record, lengths) {
  const originLen = Number(lengths?.originLen) || 12;
  const devLen = Number(lengths?.devLen) || 12;
  return {
    Path: state.selectedPath,
    TriangleName: record.datasetName,
    DatasetTypeName: record.datasetName,
    ProjectName: projectName,
    InstanceName: record.datasetName,
    Cumulative: true,
    Calendar: false,
    OriginLength: originLen,
    DevelopmentLength: devLen,
    timeout_sec: 6.0,
  };
}

async function getAddDatasetDefaultLengths() {
  return { originLen: 12, devLen: 12 };
}

async function refreshDatasetsAfterAdd(datasetName = "") {
  await loadCachedDatasetFilterForSelectedPath();
  renderDatasetTable();
  return selectDatasetRecordByName(datasetName);
}

async function addGeneratedDataset(record, lengths) {
  setStatus(`Requesting generated dataset ${record.datasetName}...`);
  const res = await fetch("/arcrho/tri/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildAddDatasetTriPayload(record, lengths)),
  });
  const out = await res.json().catch(() => ({}));
  if (res.ok && out?.ok === false && toText(out?.request_file)) {
    await refreshDatasetsAfterAdd(record.datasetName);
    setStatus(`Generated dataset request sent for ${record.datasetName}. Waiting for data engine output.`);
    return;
  }
  if (!res.ok || out?.ok === false) {
    const detail = toText(out?.detail || out?.status) || `HTTP ${res.status}`;
    throw new Error(detail);
  }
  const selected = await refreshDatasetsAfterAdd(record.datasetName);
  setStatus(selected
    ? `Generated dataset request completed for ${record.datasetName}. Selected the new dataset.`
    : `Generated dataset request completed for ${record.datasetName}.`);
}

async function addEmptyEditableDataset(record, lengths) {
  setStatus(`Creating empty dataset ${record.datasetName}...`);
  const res = await fetch("/datasets/cached/empty", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_name: projectName,
      reserving_class: state.selectedPath,
      dataset_type: record.datasetName,
      instance_name: record.datasetName,
      data_format: getDatasetRecordValue(record, "dataFormat") || "Triangle",
      origin_length: lengths.originLen,
      development_length: lengths.devLen,
      cumulative: true,
      calendar: false,
    }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out?.ok === false) {
    const detail = toText(out?.detail || out?.status) || `HTTP ${res.status}`;
    throw new Error(detail);
  }
  const selected = await refreshDatasetsAfterAdd(record.datasetName);
  setStatus(selected
    ? `Created empty editable dataset ${record.datasetName}. Selected the new dataset.`
    : `Created empty editable dataset ${record.datasetName}.`);
}

async function addDatasetFromTypePicker() {
  if (!projectName || !state.selectedPath) {
    setStatus("Select a reserving class path before adding a dataset.", true);
    return;
  }
  const selected = await showDatasetAddPicker();
  const datasetName = toText(selected?.datasetName);
  if (!datasetName) return;
  try {
    const lengths = await getAddDatasetDefaultLengths();
    if (selected.generated) {
      await addGeneratedDataset(selected, lengths);
    } else {
      await addEmptyEditableDataset(selected, lengths);
    }
  } catch (err) {
    setStatus(`Add dataset failed: ${toText(err?.message) || "Unknown error."}`, true);
  }
}

function resolveDatasetDeleteConfirm(value) {
  const overlay = els.datasetDeleteConfirmOverlay;
  const resolve = state.datasetDeleteConfirmResolve;
  state.datasetDeleteConfirmResolve = null;
  overlay?.setAttribute("hidden", "");
  if (resolve) resolve(!!value);
}

function showDatasetDeleteConfirm(records) {
  if (state.datasetDeleteConfirmResolve) return Promise.resolve(false);
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
    state.datasetDeleteConfirmResolve = resolve;
  });
}

async function deleteSelectedDatasetRows(records) {
  const names = records.map((record) => toText(record?.datasetName)).filter(Boolean);
  if (!projectName || !state.selectedPath || !names.length) return;
  const confirmed = await showDatasetDeleteConfirm(records);
  if (!confirmed) return;
  setStatus(`Deleting cached files for ${names.length === 1 ? names[0] : `${names.length} datasets`}...`);
  try {
    const resp = await fetch("/datasets/cached/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: projectName,
        reserving_class: state.selectedPath,
        dataset_names: names,
      }),
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || payload?.ok === false) {
      throw new Error(payload?.detail || payload?.message || `Delete failed (${resp.status})`);
    }
    datasetTableSelection.selectedKeys.clear();
    datasetTableSelection.anchorKey = "";
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
  } else if (normalized === "add-dataset") {
    void addDatasetFromTypePicker();
  } else if (normalized === "add-dfm") {
    setStatus("Development Factor Method is a placeholder.");
  } else if (normalized === "add-bsm") {
    setStatus("Berquist Sherman Method is a placeholder.");
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
  state.datasetTableFilterColumn = "";
  state.datasetTableFilterAnchor = null;
}

function positionDatasetTableFilterPopover() {
  const pop = els.datasetTableFilterPopover;
  const anchor = state.datasetTableFilterAnchor;
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

  const list = document.createElement("div");
  list.className = "pi-table-filter-list";
  pop.appendChild(list);

  const allRow = document.createElement("label");
  allRow.className = "pi-table-filter-option";
  const allCb = document.createElement("input");
  allCb.type = "checkbox";
  allCb.checked = selected.size === 0;
  allCb.addEventListener("change", () => {
    selected.clear();
    saveDatasetTablePreferences();
    renderDatasetTable();
    const nextAnchor = findDatasetFilterButton(key);
    if (nextAnchor) openDatasetTableFilterPopover(key, nextAnchor);
  });
  const allText = document.createElement("span");
  allText.textContent = "All";
  allRow.append(allCb, allText);
  list.appendChild(allRow);

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

  state.datasetTableFilterColumn = key;
  state.datasetTableFilterAnchor = anchor || findDatasetFilterButton(key);
  pop.classList.add("open");
  pop.setAttribute("aria-hidden", "false");
  positionDatasetTableFilterPopover();
}

function toggleDatasetTableFilterPopover(key, anchor) {
  const pop = els.datasetTableFilterPopover;
  if (
    pop?.classList?.contains("open")
    && state.datasetTableFilterColumn === key
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
    if (event.target?.closest?.(".pi-table thead th")) {
      event.preventDefault();
      event.stopPropagation();
      showDatasetTableContextMenu(event.clientX, event.clientY);
      return;
    }
    if (!showDatasetEmptyAddContextMenu(event.clientX, event.clientY)) return;
    event.preventDefault();
    event.stopPropagation();
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
    if (els.datasetAddPickerOverlay?.contains(event.target)) return;
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


async function loadDatasets() {
  beginPageLoading("datasets");
  if (!projectName) {
    setEmptyTable("Project name is missing.");
    finishPageLoading("datasets");
    return;
  }
  try {
    const fetched = await fetchProjectDatasetTypes(projectName);
    state.datasetRows = Array.isArray(fetched?.data?.rows)
      ? fetched.data.rows.filter((row) => getDatasetName(row))
      : [];
    autoFitInitialDatasetTableWidths(state.datasetRows);
    renderDatasetTable();
  } catch (err) {
    console.error("Failed to load dataset types:", err);
    setEmptyTable("Failed to load dataset types.");
    setStatus(toText(err?.message) || "Failed to load dataset types.", true);
  } finally {
    finishPageLoading("datasets");
  }
}

  Object.assign(api, {
    appendGroupedDatasetRows,
    applyDatasetGroupContextAction,
    applyDatasetRowContextAction,
    applyDatasetRowSelection,
    applyDatasetTablePreferences,
    autoFitDatasetTableColumn,
    autoFitInitialDatasetTableWidths,
    buildDatasetGroupParts,
    buildDatasetRecord,
    buildDatasetTableRenderContext,
    captureDatasetTableSelection,
    clampInitialDatasetTableWidth,
    clearDatasetColumnDragIndicators,
    clearDatasetColumnFilter,
    closeDatasetGroupContextMenu,
    closeDatasetRowContextMenu,
    closeDatasetTableContextMenu,
    closeDatasetTableFilterPopover,
    collectDatasetSameLevelGroupIds,
    compareDatasetRecords,
    compareTextValues,
    createDatasetGroupRow,
    createDatasetRecordRow,
    createDatasetTable,
    createDatasetTableHeaderCell,
    deleteSelectedDatasetRows,
    ensureDatasetFilterTooltip,
    findDatasetFilterButton,
    focusDatasetTableSurface,
    getActiveDatasetSelectionIndex,
    getCachedDatasetMetadata,
    getDatasetActiveFilterSummaries,
    getDatasetCellValue,
    getDatasetColumn,
    getDatasetColumnOptions,
    getDatasetFilterActiveValues,
    getDatasetFilterKey,
    getDatasetFilterSelection,
    getDatasetGroupByKeys,
    getDatasetGroupId,
    getDatasetName,
    getDatasetRecordByKey,
    getDatasetRecordIndexByKey,
    getDatasetRecordKey,
    getDatasetRecordValue,
    getDatasetRowActionRecords,
    getDatasetRowViewRecord,
    getDatasetSameLevelGroupIds,
    getDatasetTablePreferencePayload,
    getDatasetTablePreferencesSource,
    getDatasetTableRecords,
    getDatasetTableTotalWidth,
    getDatasetTableWidth,
    getInitialDatasetTableColumnWidth,
    getMethodType,
    getOrderedDatasetColumns,
    getSelectedDatasetRecords,
    getSortIconSvg,
    handleDatasetTableKeyDown,
    hideDatasetFilterTooltip,
    initDatasetDeleteConfirmInteractions,
    initDatasetTableInteractions,
    isDatasetColumnFilterActive,
    isDfmDatasetRecord,
    loadDatasetTablePreferences,
    loadDatasets,
    measureDatasetTableText,
    moveDatasetTableColumn,
    openDatasetRecord,
    addDatasetFromTypePicker,
    openDatasetTableFilterPopover,
    openDfmTabForDataset,
    parseDatasetGroupId,
    positionDatasetFilterTooltip,
    positionDatasetTableFilterPopover,
    positionFixedMenu,
    pruneDatasetTableSelection,
    recordSelectedDfmObject,
    renderDatasetTable,
    resolveDatasetDeleteConfirm,
    restoreDatasetTableSelection,
    rowMatchesDatasetTableFilters,
    saveDatasetTablePreferences,
    scrollDatasetRecordIntoView,
    selectDatasetRecordByName,
    selectDatasetRecordAtIndex,
    setDatasetGroupByKey,
    setDatasetRecordSelected,
    setDatasetTableColumnWidth,
    setEmptyTable,
    showDatasetDeleteConfirm,
    showDatasetFilterTooltip,
    showDatasetGroupContextMenu,
    showDatasetRowContextMenu,
    showDatasetTableContextMenu,
    sortDatasetRecords,
    startDatasetTableColumnResize,
    syncDatasetActiveFiltersToolbar,
    syncDatasetTableSelectionDom,
    syncDatasetTableTotalWidth,
    toggleDatasetTableFilterPopover,
    toggleDatasetTableSort,
    updateDatasetColumnDragIndicator,
    updateDatasetSelectionStatusBar
  });
}

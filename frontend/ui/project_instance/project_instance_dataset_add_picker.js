export function installProjectInstanceDatasetAddPicker(ctx) {
  const { api, els, state } = ctx;
  const { DATASET_TABLE_BLANK_LABEL } = ctx.constants;
  const { datasetAddPickerView } = state;
  const DATASET_ADD_PICKER_COLUMNS = Object.freeze([
    { key: "datasetTypeName", label: "Dataset Type Name", searchable: true },
    { key: "dataFormat", label: "Data Format", filterable: true },
    { key: "category", label: "Category", filterable: true },
    { key: "generated", label: "Generated", filterable: true },
  ]);
  const buildDatasetRecord = (...args) => api.buildDatasetRecord(...args);
  const closeDatasetGroupContextMenu = (...args) => api.closeDatasetGroupContextMenu(...args);
  const closeDatasetRowContextMenu = (...args) => api.closeDatasetRowContextMenu(...args);
  const closeDatasetTableContextMenu = (...args) => api.closeDatasetTableContextMenu(...args);
  const closeDatasetTableFilterPopover = (...args) => api.closeDatasetTableFilterPopover(...args);
  const compareTextValues = (...args) => api.compareTextValues(...args);
  const getDatasetFilterKey = (...args) => api.getDatasetFilterKey(...args);
  const getDatasetName = (...args) => api.getDatasetName(...args);
  const getDatasetRecordValue = (...args) => api.getDatasetRecordValue(...args);
  const getSortIconSvg = (...args) => api.getSortIconSvg(...args);
  const normalizeLookupKey = (...args) => api.normalizeLookupKey(...args);
  const positionDatasetTableFilterPopover = (...args) => api.positionDatasetTableFilterPopover(...args);
  const positionFixedMenu = (...args) => api.positionFixedMenu(...args);
  const setStatus = (...args) => api.setStatus(...args);
  const toText = (...args) => api.toText(...args);
  let sourceRecordsCacheRows = null;
  let sourceRecordsCacheLength = -1;
  let sourceRecordsCache = null;
  let scheduledRenderFrame = 0;

function closeDatasetAddPicker() {
  if (scheduledRenderFrame) {
    window.cancelAnimationFrame(scheduledRenderFrame);
    scheduledRenderFrame = 0;
  }
  closeDatasetAddPickerFilterPopover();
  if (state.datasetAddPickerResolve) {
    state.datasetAddPickerResolve(null);
    state.datasetAddPickerResolve = null;
  }
  els.datasetAddPickerOverlay?.setAttribute("hidden", "");
}

function getDatasetAddPickerViewportLimits() {
  const maxWidth = Math.max(260, window.innerWidth - 24);
  const maxHeight = Math.max(180, window.innerHeight - 24);
  return {
    pad: 12,
    minWidth: Math.min(420, maxWidth),
    minHeight: Math.min(220, maxHeight),
    maxWidth,
    maxHeight,
  };
}

function applyDatasetAddPickerRect(rect) {
  const box = els.datasetAddPickerBox;
  if (!box) return;
  const limits = getDatasetAddPickerViewportLimits();
  const width = Math.max(limits.minWidth, Math.min(Number(rect?.width) || limits.minWidth, limits.maxWidth));
  const height = Math.max(limits.minHeight, Math.min(Number(rect?.height) || limits.minHeight, limits.maxHeight));
  const left = Math.max(limits.pad, Math.min(Number(rect?.left) || limits.pad, window.innerWidth - width - limits.pad));
  const top = Math.max(limits.pad, Math.min(Number(rect?.top) || limits.pad, window.innerHeight - height - limits.pad));
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(top)}px`;
  box.style.right = "auto";
  box.style.width = `${Math.round(width)}px`;
  box.style.height = `${Math.round(height)}px`;
  box.style.maxHeight = "none";
  box.dataset.positioned = "1";
}

function ensureDatasetAddPickerPositioned() {
  const box = els.datasetAddPickerBox;
  if (!box) return;
  if (box.dataset.positioned === "1") {
    clampDatasetAddPickerToViewport();
    return;
  }
  const rect = box.getBoundingClientRect();
  applyDatasetAddPickerRect({
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  });
}

function clampDatasetAddPickerToViewport() {
  const box = els.datasetAddPickerBox;
  if (!box || els.datasetAddPickerOverlay?.hasAttribute?.("hidden")) return;
  const rect = box.getBoundingClientRect();
  applyDatasetAddPickerRect({
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  });
}

function initDatasetAddPickerDragResize() {
  const box = els.datasetAddPickerBox;
  if (!box || box.dataset.dragResizeWired === "1") return;
  box.dataset.dragResizeWired = "1";

  const startInteraction = (event, mode, edge = "") => {
    if (event.button !== 0) return;
    const rect = box.getBoundingClientRect();
    ensureDatasetAddPickerPositioned();
    const startRect = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    const startX = Number(event.clientX || 0);
    const startY = Number(event.clientY || 0);
    box.classList.toggle("dragging", mode === "drag");
    box.classList.toggle("resizing", mode === "resize");

    const onMove = (moveEvent) => {
      const dx = Number(moveEvent.clientX || 0) - startX;
      const dy = Number(moveEvent.clientY || 0) - startY;
      if (mode === "drag") {
        applyDatasetAddPickerRect({
          left: startRect.left + dx,
          top: startRect.top + dy,
          width: startRect.width,
          height: startRect.height,
        });
        return;
      }

      let nextLeft = startRect.left;
      let nextTop = startRect.top;
      let nextWidth = startRect.width;
      let nextHeight = startRect.height;
      if (edge.includes("e")) nextWidth = startRect.width + dx;
      if (edge.includes("s")) nextHeight = startRect.height + dy;
      if (edge.includes("w")) {
        nextLeft = startRect.left + dx;
        nextWidth = startRect.width - dx;
      }
      if (edge.includes("n")) {
        nextTop = startRect.top + dy;
        nextHeight = startRect.height - dy;
      }
      applyDatasetAddPickerRect({
        left: nextLeft,
        top: nextTop,
        width: nextWidth,
        height: nextHeight,
      });
    };

    const onUp = () => {
      box.classList.remove("dragging", "resizing");
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
    event.preventDefault();
    event.stopPropagation();
  };

  box.querySelector(".pi-add-picker-header")?.addEventListener("mousedown", (event) => {
    if (event.target?.closest?.("button")) return;
    startInteraction(event, "drag");
  });

  for (const handle of box.querySelectorAll(".pi-add-picker-resize[data-edge]")) {
    handle.addEventListener("mousedown", (event) => {
      startInteraction(event, "resize", String(handle.dataset.edge || ""));
    });
  }
}

function getDatasetAddPickerSourceRecords() {
  const rows = state.datasetRows;
  if (
    sourceRecordsCache
    && sourceRecordsCacheRows === rows
    && sourceRecordsCacheLength === rows.length
  ) {
    return sourceRecordsCache;
  }
  sourceRecordsCacheRows = rows;
  sourceRecordsCacheLength = rows.length;
  sourceRecordsCache = rows
    .map((row, rowIndex) => buildDatasetRecord(row, rowIndex))
    .filter((record) => record.datasetName);
  return sourceRecordsCache;
}

function buildDatasetAddPickerRenderContext() {
  const sourceRecords = getDatasetAddPickerSourceRecords();
  const optionsByKey = new Map();
  const selectionsByKey = new Map();
  for (const col of DATASET_ADD_PICKER_COLUMNS) {
    if (!col.filterable) continue;
    const options = getDatasetAddPickerFilterOptions(col.key, sourceRecords);
    optionsByKey.set(col.key, options);
    selectionsByKey.set(col.key, getDatasetAddPickerFilterSelection(col.key, options));
  }
  const records = sortDatasetAddPickerRecords(
    sourceRecords.filter((record) => rowMatchesDatasetAddPickerFilters(record, { optionsByKey, selectionsByKey }))
  );
  return { sourceRecords, optionsByKey, selectionsByKey, records };
}

function getDatasetAddPickerRecords(context = null) {
  if (Array.isArray(context?.records)) return context.records;
  return buildDatasetAddPickerRenderContext().records;
}

function getDatasetAddPickerColumn(key) {
  const normalized = toText(key);
  return DATASET_ADD_PICKER_COLUMNS.find((col) => col.key === normalized) || null;
}

function getDatasetAddPickerValue(record, key) {
  if (key === "generated") return record?.generated ? "Yes" : "No";
  return getDatasetRecordValue(record, key);
}

function getDatasetAddPickerFilterOptions(key, records = getDatasetAddPickerSourceRecords()) {
  const seen = new Set();
  const options = [];
  for (const record of records) {
    const optionKey = getDatasetFilterKey(getDatasetAddPickerValue(record, key));
    if (seen.has(optionKey)) continue;
    seen.add(optionKey);
    options.push({ key: optionKey, label: optionKey });
  }
  options.sort((a, b) => {
    if (a.key === DATASET_TABLE_BLANK_LABEL) return 1;
    if (b.key === DATASET_TABLE_BLANK_LABEL) return -1;
    return compareTextValues(a.label, b.label);
  });
  return options;
}

function getDatasetAddPickerFilterSelection(key, options = getDatasetAddPickerFilterOptions(key)) {
  const optionKeys = new Set(options.map((opt) => opt.key));
  let selected = datasetAddPickerView.filters.get(key);
  if (!(selected instanceof Set)) {
    selected = new Set();
    datasetAddPickerView.filters.set(key, selected);
    return selected;
  }
  for (const selectedKey of Array.from(selected)) {
    if (!optionKeys.has(selectedKey)) selected.delete(selectedKey);
  }
  return selected;
}

function isDatasetAddPickerFilterActive(key, context = null) {
  const col = getDatasetAddPickerColumn(key);
  if (!col?.filterable) return false;
  const options = context?.optionsByKey?.get?.(key) || getDatasetAddPickerFilterOptions(key);
  if (!options.length) return false;
  const selected = context?.selectionsByKey?.get?.(key) || getDatasetAddPickerFilterSelection(key, options);
  return selected.size > 0 && selected.size !== options.length;
}

function rowMatchesDatasetAddPickerFilters(record, context = null) {
  const search = normalizeLookupKey(datasetAddPickerView.search);
  if (search && !normalizeLookupKey(getDatasetAddPickerValue(record, "datasetTypeName")).includes(search)) return false;
  for (const col of DATASET_ADD_PICKER_COLUMNS) {
    if (!col.filterable) continue;
    const options = context?.optionsByKey?.get?.(col.key) || getDatasetAddPickerFilterOptions(col.key);
    const selected = context?.selectionsByKey?.get?.(col.key) || getDatasetAddPickerFilterSelection(col.key, options);
    if (!(selected instanceof Set) || selected.size === 0 || selected.size === options.length) continue;
    if (!selected.has(getDatasetFilterKey(getDatasetAddPickerValue(record, col.key)))) return false;
  }
  return true;
}

function sortDatasetAddPickerRecords(records) {
  const list = Array.isArray(records) ? records.slice() : [];
  const col = getDatasetAddPickerColumn(datasetAddPickerView.sort?.key);
  if (!col) return list;
  const dir = datasetAddPickerView.sort?.dir === "desc" ? -1 : 1;
  return list.sort((a, b) => {
    const cmp = compareTextValues(getDatasetAddPickerValue(a, col.key), getDatasetAddPickerValue(b, col.key));
    if (cmp !== 0) return cmp * dir;
    return (a?.rowIndex ?? 0) - (b?.rowIndex ?? 0);
  });
}

function toggleDatasetAddPickerSort(key) {
  const col = getDatasetAddPickerColumn(key);
  if (!col) return;
  const currentKey = toText(datasetAddPickerView.sort?.key);
  const currentDir = datasetAddPickerView.sort?.dir === "desc" ? "desc" : "asc";
  datasetAddPickerView.sort = {
    key: col.key,
    dir: currentKey === col.key && currentDir === "asc" ? "desc" : "asc",
  };
  renderDatasetAddPickerRows();
}

function getFilterIconSvg() {
  return `
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2 3h12L9.5 8v4l-3 1V8z"></path>
    </svg>
  `;
}

function renderDatasetAddPickerHeader(context = null) {
  for (const th of els.datasetAddPickerTable?.querySelectorAll?.("thead th[data-add-picker-col]") || []) {
    const col = getDatasetAddPickerColumn(th.dataset.addPickerCol);
    if (!col) continue;
    th.replaceChildren();
    const sorted = datasetAddPickerView.sort?.key === col.key;
    th.setAttribute("aria-sort", sorted ? (datasetAddPickerView.sort?.dir === "desc" ? "descending" : "ascending") : "none");

    const cell = document.createElement("div");
    cell.className = "pi-add-picker-header-cell";
    const sortBtn = document.createElement("button");
    sortBtn.type = "button";
    sortBtn.className = "pi-add-picker-sort";
    sortBtn.title = `Sort by ${col.label}`;
    sortBtn.innerHTML = `<span class="pi-add-picker-sort-text"></span>${sorted ? getSortIconSvg(datasetAddPickerView.sort?.dir) : ""}`;
    const text = sortBtn.querySelector(".pi-add-picker-sort-text");
    if (text) text.textContent = col.label;
    sortBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleDatasetAddPickerSort(col.key);
    });
    cell.appendChild(sortBtn);

    if (col.filterable) {
      const filterBtn = document.createElement("button");
      filterBtn.type = "button";
      filterBtn.className = "pi-table-filter-btn";
      filterBtn.title = `${col.label} Filter`;
      filterBtn.classList.toggle("active", isDatasetAddPickerFilterActive(col.key, context));
      filterBtn.innerHTML = getFilterIconSvg();
      filterBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleDatasetAddPickerFilterPopover(col.key, filterBtn);
      });
      cell.appendChild(filterBtn);
    }
    th.appendChild(cell);
  }
}

function closeDatasetAddPickerFilterPopover() {
  const pop = els.datasetAddPickerFilterPopover;
  if (!pop) return;
  pop.classList.remove("open");
  pop.setAttribute("aria-hidden", "true");
  pop.innerHTML = "";
  datasetAddPickerView.filterColumn = "";
  datasetAddPickerView.filterAnchor = null;
}

function positionDatasetAddPickerFilterPopover() {
  const pop = els.datasetAddPickerFilterPopover;
  const anchor = datasetAddPickerView.filterAnchor;
  if (!pop?.classList?.contains("open") || !anchor?.getBoundingClientRect) return;
  const rect = anchor.getBoundingClientRect();
  positionFixedMenu(pop, rect.left, rect.bottom + 6);
}

function openDatasetAddPickerFilterPopover(key, anchor) {
  const col = getDatasetAddPickerColumn(key);
  const pop = els.datasetAddPickerFilterPopover;
  if (!col?.filterable || !pop) return;
  closeDatasetTableContextMenu();
  closeDatasetGroupContextMenu();
  closeDatasetRowContextMenu();
  closeDatasetTableFilterPopover();
  const options = getDatasetAddPickerFilterOptions(col.key);
  const selected = getDatasetAddPickerFilterSelection(col.key, options);
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
    renderDatasetAddPickerRows();
    const nextAnchor = findDatasetAddPickerFilterButton(col.key);
    if (nextAnchor) openDatasetAddPickerFilterPopover(col.key, nextAnchor);
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
      renderDatasetAddPickerRows();
      const nextAnchor = findDatasetAddPickerFilterButton(col.key);
      if (nextAnchor) openDatasetAddPickerFilterPopover(col.key, nextAnchor);
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

  datasetAddPickerView.filterColumn = col.key;
  datasetAddPickerView.filterAnchor = anchor || findDatasetAddPickerFilterButton(col.key);
  pop.classList.add("open");
  pop.setAttribute("aria-hidden", "false");
  positionDatasetAddPickerFilterPopover();
}

function toggleDatasetAddPickerFilterPopover(key, anchor) {
  const pop = els.datasetAddPickerFilterPopover;
  if (
    pop?.classList?.contains("open")
    && datasetAddPickerView.filterColumn === key
  ) {
    closeDatasetAddPickerFilterPopover();
    return;
  }
  openDatasetAddPickerFilterPopover(key, anchor);
}

function findDatasetAddPickerFilterButton(key) {
  const th = els.datasetAddPickerTable?.querySelector?.(`th[data-add-picker-col="${CSS.escape(key)}"]`);
  return th?.querySelector?.(".pi-table-filter-btn") || null;
}

function renderDatasetAddPickerRows() {
  if (scheduledRenderFrame) {
    window.cancelAnimationFrame(scheduledRenderFrame);
    scheduledRenderFrame = 0;
  }
  const tbody = els.datasetAddPickerTable?.querySelector?.("tbody");
  if (!tbody) return;
  tbody.replaceChildren();
  const context = buildDatasetAddPickerRenderContext();
  renderDatasetAddPickerHeader(context);
  const records = getDatasetAddPickerRecords(context);
  const total = context.sourceRecords.length;
  if (els.datasetAddPickerStatus) {
    els.datasetAddPickerStatus.textContent = `(${records.length} ${records.length === 1 ? "record" : "records"})`;
  }
  if (els.datasetAddPickerEmpty) {
    els.datasetAddPickerEmpty.textContent = total
      ? "No dataset types match the selected filters."
      : "No dataset types are available.";
    els.datasetAddPickerEmpty.toggleAttribute("hidden", records.length > 0);
  }
  if (els.datasetAddPickerTable) els.datasetAddPickerTable.hidden = records.length === 0;
  if (els.datasetAddPickerTableWrap) els.datasetAddPickerTableWrap.hidden = records.length === 0;

  for (const record of records) {
    const tr = document.createElement("tr");
    tr.tabIndex = 0;
    tr.dataset.datasetName = record.datasetName;
    for (const key of ["datasetTypeName", "dataFormat", "category"]) {
      const td = document.createElement("td");
      td.textContent = getDatasetAddPickerValue(record, key);
      tr.appendChild(td);
    }
    const generatedTd = document.createElement("td");
    generatedTd.className = "pi-add-generated-cell";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !!record.generated;
    checkbox.disabled = true;
    checkbox.setAttribute("aria-label", record.generated ? "Generated" : "Not generated");
    generatedTd.appendChild(checkbox);
    tr.appendChild(generatedTd);
    const choose = () => {
      if (state.datasetAddPickerResolve) {
        const resolve = state.datasetAddPickerResolve;
        state.datasetAddPickerResolve = null;
        resolve(record);
      }
      els.datasetAddPickerOverlay?.setAttribute("hidden", "");
    };
    tr.addEventListener("click", choose);
    tr.addEventListener("dblclick", choose);
    tr.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      choose();
    });
    tbody.appendChild(tr);
  }
}

function scheduleDatasetAddPickerRender() {
  if (scheduledRenderFrame) window.cancelAnimationFrame(scheduledRenderFrame);
  scheduledRenderFrame = window.requestAnimationFrame(() => {
    scheduledRenderFrame = 0;
    renderDatasetAddPickerRows();
  });
}

function showDatasetAddPicker() {
  if (!els.datasetAddPickerOverlay) {
    setStatus("Dataset type picker is not available.", true);
    return Promise.resolve(null);
  }
  closeDatasetRowContextMenu();
  closeDatasetTableContextMenu();
  closeDatasetGroupContextMenu();
  closeDatasetTableFilterPopover();
  closeDatasetAddPickerFilterPopover();
  if (els.datasetAddPickerNameSearch) {
    els.datasetAddPickerNameSearch.value = datasetAddPickerView.search;
  }
  renderDatasetAddPickerRows();
  els.datasetAddPickerOverlay.removeAttribute("hidden");
  ensureDatasetAddPickerPositioned();
  els.datasetAddPickerNameSearch?.focus?.({ preventScroll: true });
  return new Promise((resolve) => {
    state.datasetAddPickerResolve = resolve;
  });
}

function initDatasetAddPickerInteractions() {
  if (els.datasetAddPickerBox?.dataset?.pickerInteractionsWired === "1") return;
  if (els.datasetAddPickerBox) els.datasetAddPickerBox.dataset.pickerInteractionsWired = "1";
  initDatasetAddPickerDragResize();
  els.datasetAddPickerClose?.addEventListener("click", closeDatasetAddPicker);
  els.datasetAddPickerNameSearch?.addEventListener("input", (event) => {
    datasetAddPickerView.search = toText(event.target?.value);
    closeDatasetAddPickerFilterPopover();
    scheduleDatasetAddPickerRender();
  });
  els.datasetAddPickerNameSearch?.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown") return;
    const firstRow = els.datasetAddPickerTable?.querySelector?.("tbody tr");
    if (!firstRow) return;
    event.preventDefault();
    firstRow.focus?.();
  });
  els.datasetAddPickerOverlay?.addEventListener("mousedown", (event) => {
    if (event.target === event.currentTarget) closeDatasetAddPicker();
  });
  document.addEventListener("mousedown", (event) => {
    if (els.datasetAddPickerFilterPopover?.contains(event.target)) return;
    if (els.datasetAddPickerOverlay?.contains(event.target)) {
      if (!event.target?.closest?.(".pi-table-filter-btn")) closeDatasetAddPickerFilterPopover();
      return;
    }
    closeDatasetAddPickerFilterPopover();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!els.datasetAddPickerOverlay?.hasAttribute?.("hidden")) {
      closeDatasetAddPicker();
    }
    closeDatasetAddPickerFilterPopover();
  }, true);
  window.addEventListener("resize", () => {
    closeDatasetAddPickerFilterPopover();
    clampDatasetAddPickerToViewport();
    positionDatasetTableFilterPopover();
  });
  els.datasetAddPickerTableWrap?.addEventListener("scroll", positionDatasetAddPickerFilterPopover, true);
}

  Object.assign(api, {
    applyDatasetAddPickerRect,
    clampDatasetAddPickerToViewport,
    closeDatasetAddPicker,
    closeDatasetAddPickerFilterPopover,
    ensureDatasetAddPickerPositioned,
    findDatasetAddPickerFilterButton,
    getDatasetAddPickerColumn,
    getDatasetAddPickerFilterOptions,
    getDatasetAddPickerFilterSelection,
    getDatasetAddPickerRecords,
    getDatasetAddPickerValue,
    initDatasetAddPickerDragResize,
    initDatasetAddPickerInteractions,
    isDatasetAddPickerFilterActive,
    openDatasetAddPickerFilterPopover,
    positionDatasetAddPickerFilterPopover,
    renderDatasetAddPickerHeader,
    renderDatasetAddPickerRows,
    rowMatchesDatasetAddPickerFilters,
    scheduleDatasetAddPickerRender,
    showDatasetAddPicker,
    sortDatasetAddPickerRecords,
    toggleDatasetAddPickerFilterPopover,
    toggleDatasetAddPickerSort,
  });
}

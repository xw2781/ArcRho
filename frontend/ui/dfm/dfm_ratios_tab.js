/*
===============================================================================
DFM Ratios Tab - ratio table rendering, summary rows, context menus,
drag reorder, column activation, strike toggling
===============================================================================
*/
import {
  state,
  calcRatio, roundRatio, formatRatio,
  ratioStrikeSet, activeRatioCols, summaryRowConfigs,
  getRatioColAllActive, setRatioColAllActive,
  getShowNaBorders, setShowNaBorders,
  getEffectiveDevLabelsForModel, getRatioHeaderLabels,
  getOriginLabelTextForRatio, buildSummaryRows, getDfmDecimalPlaces,
  markDfmDirty, notifyDfmEditState,
} from "/ui/dfm/dfm_state.js";
import {
  saveNaBorders,
} from "/ui/dfm/dfm_storage.js";
import { renderResultsTable } from "/ui/dfm/dfm_results_tab.js";
import { openContextMenu } from "/ui/shared/menu_utils.js";
import { wireSelectableTable } from "/ui/shared/table_selection.js";
import { wirePercentDevelopedCurveMenu } from "/ui/dfm/dfm_percent_developed_curve_window.js?v=20260514e";
import {
  buildRatioSelectionPattern,
  buildAverageSelectionPayload,
  applyRatioSelectionPattern,
  applySelectedSummaryFromSaved,
  applyAverageSelectionFromSaved,
  wireSummaryRowDrag,
  wireSummaryContextMenu,
  wireSummarySelection,
  initDefaultSummarySelection,
  applySummarySelection,
  recalculateUserEntryDependencies,
  updateRatioSummary,
  scheduleRatioSummaryUpdate,
  setSummaryTableCallbacks,
  resetSummaryFormulaEditState,
  refreshAllExcelLinks,
} from "/ui/dfm/dfm_ratios_summary_table.js?v=20260529a";
import {
  wireRatioChartModal,
  isRatioChartOpen,
  scheduleRatioChartRender,
  showRatioColumnChart,
  resetRatioChartThresholds,
  setRatioChartCallbacks,
} from "/ui/dfm/dfm_ratios_chart.js";
import {
  applyDfmCellNoteMarkers,
  clearDfmCellNote,
  hasDfmCellNote,
  showDfmCellNoteEditor,
  wireDfmCellNotes,
} from "/ui/dfm/dfm_cell_notes.js";
import {
  beginRatioHistoryAction,
  cancelRatioHistoryAction,
  commitRatioHistoryAction,
} from "/ui/dfm/dfm_ratio_history.js";

export {
  buildRatioSelectionPattern,
  buildAverageSelectionPayload,
  applyRatioSelectionPattern,
  applySelectedSummaryFromSaved,
  applyAverageSelectionFromSaved,
  updateRatioSummary,
  scheduleRatioSummaryUpdate,
} from "/ui/dfm/dfm_ratios_summary_table.js?v=20260529a";
export {
  wireRatioChartModal,
  isRatioChartOpen,
  scheduleRatioChartRender,
  showRatioColumnChart,
  resetRatioChartThresholds,
} from "/ui/dfm/dfm_ratios_chart.js";



// =============================================================================
// Ratio Context Menu
// =============================================================================
function getRatioMenuEl() {
  return document.getElementById("dfmRatioMenu");
}

let ratioTableSelection = null;
let selectedRatioTableSelection = null;
let ratioContextCell = null;

function updateRatioMenuLabel() {
  const menu = getRatioMenuEl();
  const btn = menu?.querySelector('[data-action="toggle-na-borders"]');
  if (btn) btn.textContent = getShowNaBorders() ? "Hide N/A Borders" : "Show N/A Borders";
}

function applyNaBorderVisibility() {
  const wrap = document.getElementById("ratioWrap");
  if (!wrap) return;
  wrap.classList.toggle("showNaBorders", !!getShowNaBorders());
}

export function wireRatioContextMenu() {
  const wrap = document.getElementById("ratioWrap");
  if (!wrap || wrap.dataset.ratioMenuWired === "1") return;
  wrap.dataset.ratioMenuWired = "1";

  ratioTableSelection = wireSelectableTable({
    container: wrap,
    selectedClass: "dfmTableSel",
    activeClass: "dfmTableActive",
    canStartPointerSelection: (event) => !!(event.shiftKey || event.ctrlKey || event.metaKey),
    isSelectableCell: (cell) => !!cell.closest("table.ratioMainTable"),
    onContextMenu: (event, cell, api) => {
      event.preventDefault();
      ratioTableSelection = api;
      ratioContextCell = cell;
      const menu = getRatioMenuEl();
      if (!menu) return;
      const hasNote = hasDfmCellNote(cell);
      const noteBtn = menu.querySelector('[data-action="add-ratio-cell-note"]');
      if (noteBtn) noteBtn.textContent = hasNote ? "Edit Cell Notes" : "Add Cell Notes";
      const clearNoteBtn = menu.querySelector('[data-action="clear-ratio-cell-note"]');
      if (clearNoteBtn) clearNoteBtn.disabled = !hasNote;
      updateRatioMenuLabel();
      openContextMenu(menu, {
        anchorEl: cell,
        clientX: event.clientX,
        clientY: event.clientY,
        offset: 8,
        align: "top-left",
      });
    },
  });

  const menu = getRatioMenuEl();
  menu?.addEventListener("click", async (e) => {
    const btn = e.target?.closest?.("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "copy-ratio-value") {
      await ratioTableSelection?.copySelection?.();
    } else if (btn.dataset.action === "add-ratio-cell-note") {
      showDfmCellNoteEditor(ratioContextCell, { focus: true });
    } else if (btn.dataset.action === "clear-ratio-cell-note") {
      clearDfmCellNote(ratioContextCell);
    } else if (btn.dataset.action === "toggle-na-borders") {
      setShowNaBorders(!getShowNaBorders());
      saveNaBorders(getShowNaBorders());
      applyNaBorderVisibility();
    } else if (btn.dataset.action === "copy-ratio-patterns") {
      copyRatioPatterns();
    } else if (btn.dataset.action === "apply-ratio-patterns") {
      applyRatioPatternsFromClipboard();
    }
    menu.style.display = "none";
  });
}

function copyRatioPatterns() {
  const pattern = buildRatioSelectionPattern();
  if (!pattern || !pattern.length) {
    alert("No ratio patterns to copy.");
    return;
  }
  localStorage.setItem("dfmRatioPatterns", JSON.stringify(pattern));
}

function getCompactRatioPatternShape(pattern) {
  if (!Array.isArray(pattern)) return null;
  let cols = 0;
  const rowLengths = [];
  for (const row of pattern) {
    if (!Array.isArray(row)) return null;
    cols = Math.max(cols, row.length);
    rowLengths.push(row.length);
  }
  return { rows: pattern.length, cols, rowLengths };
}

function applyRatioPatternsFromClipboard() {
  const stored = localStorage.getItem("dfmRatioPatterns");
  if (!stored) {
    alert("You haven't copied any ratio patterns.");
    return;
  }
  let pattern;
  try {
    pattern = JSON.parse(stored);
  } catch {
    alert("Invalid stored ratio patterns.");
    return;
  }
  if (!Array.isArray(pattern) || !pattern.length) {
    alert("You haven't copied any ratio patterns.");
    return;
  }
  const model = state.model;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) {
    alert("No ratio triangle data available.");
    return;
  }
  const origins = model.origin_labels || [];
  const devs = getEffectiveDevLabelsForModel(model);
  const expectedRows = origins.length;
  const expectedShape = getCompactRatioPatternShape(buildRatioSelectionPattern());
  const storedShape = getCompactRatioPatternShape(pattern);
  if (!storedShape || !expectedShape) {
    alert("Invalid stored ratio patterns.");
    return;
  }
  const sameCompactShape =
    storedShape.rows === expectedRows &&
    storedShape.rows === expectedShape.rows &&
    storedShape.cols === expectedShape.cols &&
    storedShape.rowLengths.every((len, idx) => len === expectedShape.rowLengths[idx]);
  if (!sameCompactShape) {
    alert(`Invalid triangle size. Stored pattern is ${storedShape.rows}x${storedShape.cols}, but current compact triangle is ${expectedShape.rows}x${expectedShape.cols}.`);
    return;
  }
  beginRatioHistoryAction("apply-ratio-patterns");
  const activeCols = getActiveRatioCols(model);
  const ratioColCount = Math.max(0, devs.length - 1);
  if (activeCols.length > 0) {
    const colSet = new Set(activeCols);
    for (let r = 0; r < expectedRows; r++) {
      const row = Array.isArray(pattern[r]) ? pattern[r] : [];
      for (const c of colSet) {
        if (c >= ratioColCount) continue;
        const key = `${r},${c}`;
        if (row[c] === 1) {
          ratioStrikeSet.add(key);
        } else {
          ratioStrikeSet.delete(key);
        }
      }
    }
  } else {
    applyRatioSelectionPattern(pattern);
  }
  renderRatioTable();
  scheduleRatioSummaryUpdate();
  onRatioStateMutated();
  commitRatioHistoryAction("apply-ratio-patterns");
}

// =============================================================================
// Ratio Column Activation + Extreme Exclusion
// =============================================================================
export function applyRatioColHighlight() {
  const wrap = document.getElementById("ratioWrap");
  if (!wrap) return;
  const cells = wrap.querySelectorAll("td[data-col]");
  cells.forEach((el) => {
    const col = Number(el.dataset.col);
    const on = getRatioColAllActive() ? Number.isFinite(col) : activeRatioCols.has(col);
    el.classList.toggle("ratioColActive", on);
  });
}

export function getActiveRatioCols(model) {
  const devs = getEffectiveDevLabelsForModel(model);
  const lastCol = devs.length - 2;
  if (lastCol < 0) return [];
  if (getRatioColAllActive()) {
    return Array.from({ length: lastCol + 1 }, (_, i) => i);
  }
  if (activeRatioCols.size === 0) return [];
  return [...activeRatioCols].filter((c) => c >= 0 && c <= lastCol).sort((a, b) => a - b);
}

function excludeExtremeInCol(model, col, mode) {
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) return;
  const devs = getEffectiveDevLabelsForModel(model);
  if (col < 0 || col >= devs.length - 1) return;

  const vals = model.values;
  const mask = model.mask;
  const origins = model.origin_labels || [];
  let best = null;
  let bestKey = null;

  for (let r = 0; r < origins.length; r++) {
    const key = `${r},${col}`;
    if (ratioStrikeSet.has(key)) continue;
    const hasA = !!(mask[r] && mask[r][col]);
    const hasB = !!(mask[r] && mask[r][col + 1]);
    if (!hasA || !hasB) continue;
    const ratio = calcRatio(vals?.[r]?.[col], vals?.[r]?.[col + 1]);
    if (!Number.isFinite(ratio)) continue;
    if (best === null) {
      best = ratio;
      bestKey = key;
      continue;
    }
    if (mode === "high" && ratio > best) {
      best = ratio;
      bestKey = key;
    } else if (mode === "low" && ratio < best) {
      best = ratio;
      bestKey = key;
    }
  }

  if (!bestKey) return;
  ratioStrikeSet.add(bestKey);
  const cell = document.querySelector(`#ratioWrap td.ratioCell[data-r="${bestKey.split(",")[0]}"][data-col="${col}"]`);
  if (cell) cell.classList.add("strike");
}

export function excludeExtremeInActiveCol(mode) {
  const model = state.model;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) return;
  const cols = getActiveRatioCols(model);
  if (!cols.length) return;
  beginRatioHistoryAction(`exclude-${mode}`);
  cols.forEach((col) => excludeExtremeInCol(model, col, mode));
  scheduleRatioSummaryUpdate();
  onRatioStateMutated();
  commitRatioHistoryAction(`exclude-${mode}`);
}

export function includeAllInActiveCol() {
  const model = state.model;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) return;
  const origins = model.origin_labels || [];
  const cols = getActiveRatioCols(model);
  const allCols = cols.length
    ? cols
    : Array.from({ length: Math.max(0, getEffectiveDevLabelsForModel(model).length - 1) }, (_, i) => i);
  beginRatioHistoryAction("include-all");
  allCols.forEach((col) => {
    for (let r = 0; r < origins.length; r++) {
      const key = `${r},${col}`;
      if (ratioStrikeSet.has(key)) {
        ratioStrikeSet.delete(key);
        const cell = document.querySelector(`#ratioWrap td.ratioCell[data-r="${r}"][data-col="${col}"]`);
        if (cell) cell.classList.remove("strike");
      }
    }
  });
  scheduleRatioSummaryUpdate();
  onRatioStateMutated();
  commitRatioHistoryAction("include-all");
}

// =============================================================================
// Ratio State Mutation Callback
// =============================================================================
export function onRatioStateMutated() {
  recalculateUserEntryDependencies();
  if (document.getElementById("resultsWrap")) renderResultsTable();
  if (isRatioChartOpen()) scheduleRatioChartRender();
  notifyRatioStateChanged();
  markDfmDirty();
}

// Forward declaration - will be set by sync module
let _notifyRatioStateChanged = () => {};
export function setNotifyRatioStateChanged(fn) { _notifyRatioStateChanged = fn; }
function notifyRatioStateChanged() { _notifyRatioStateChanged(); }
setSummaryTableCallbacks({ renderRatioTable, onRatioStateMutated });
setRatioChartCallbacks({ onRatioStateMutated });


// =============================================================================
// Main Ratio Table Rendering
// =============================================================================
let pendingExternalChangeHighlights = null;

function normalizeHighlightCells(cells) {
  if (!Array.isArray(cells)) return [];
  return cells
    .map((cell) => ({
      r: String(cell?.r ?? ""),
      c: Number(cell?.c),
      label: String(cell?.label || "").trim(),
    }))
    .filter((cell) => Number.isFinite(cell.c) && cell.c >= 0 && (cell.r || cell.label));
}

export function restoreRatioHistoryUi() {
  renderRatioTable();
  scheduleRatioSummaryUpdate();
  onRatioStateMutated();
}

function restartCellFlash(cell) {
  if (!cell) return;
  cell.classList.remove("dfmExternalJsonChanged");
  void cell.offsetWidth;
  cell.classList.add("dfmExternalJsonChanged");
  window.setTimeout(() => {
    cell.classList.remove("dfmExternalJsonChanged");
  }, 2400);
}

function applyPendingExternalChangeHighlights() {
  const pending = pendingExternalChangeHighlights;
  pendingExternalChangeHighlights = null;
  if (!pending) return;
  window.requestAnimationFrame(() => {
    const wrap = document.getElementById("ratioWrap");
    if (!wrap) return;
    normalizeHighlightCells(pending.ratioCells).forEach((cell) => {
      const target = wrap.querySelector(
        `table.ratioMainTable td.ratioCell[data-r="${CSS.escape(cell.r)}"][data-col="${cell.c}"]`,
      );
      restartCellFlash(target);
    });

    const rowIdByLabel = new Map();
    summaryRowConfigs.forEach((cfg) => {
      const id = String(cfg?.id || "");
      if (!id) return;
      rowIdByLabel.set(String(cfg?.label || id).trim(), id);
      rowIdByLabel.set(id, id);
    });
    normalizeHighlightCells(pending.averageCells).forEach((cell) => {
      const rowId = cell.r || rowIdByLabel.get(cell.label) || "";
      if (!rowId) return;
      const target = wrap.querySelector(
        `table.ratioSummaryTable td.summaryCell[data-r="${CSS.escape(rowId)}"][data-col="${cell.c}"]`,
      );
      restartCellFlash(target);
    });
  });
}

export function queueDfmExternalChangeHighlights(changes = {}) {
  const ratioCells = normalizeHighlightCells(changes.ratioCells);
  const averageCells = normalizeHighlightCells(changes.averageCells);
  if (!ratioCells.length && !averageCells.length) return;
  pendingExternalChangeHighlights = { ratioCells, averageCells };
}

export function renderRatioTable() {
  const wrap = document.getElementById("ratioWrap");
  if (!wrap) return;
  wrap.innerHTML = "";
  const formulaBar = document.getElementById("dfmSummaryFormulaBar");
  if (formulaBar) formulaBar.remove();
  resetSummaryFormulaEditState();

  const model = state.model;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) {
    wrap.innerHTML = `<div class="small">No dataset loaded.</div>`;
    return;
  }

  const origins = model.origin_labels || [];
  const devs = getEffectiveDevLabelsForModel(model);
  const ratioLabels = getRatioHeaderLabels(devs);
  const vals = model.values;
  const mask = model.mask;

  if (devs.length < 2) {
    wrap.innerHTML = `<div class="small">Not enough columns to compute ratios.</div>`;
    return;
  }

  const table = document.createElement("table");
  table.classList.add("ratioMainTable");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.textContent = getOriginLabelTextForRatio();
  corner.dataset.col = "all";
  headRow.appendChild(corner);

  for (let c = 0; c < ratioLabels.length; c++) {
    const th = document.createElement("th");
    const label = ratioLabels[c] || "";
    if (c === ratioLabels.length - 1) {
      th.textContent = label || "Ult";
    } else {
      th.textContent = label ? `(${c + 1}) ${label}` : `(${c + 1})`;
    }
    th.dataset.col = String(c);
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const summaryTable = document.createElement("table");
  summaryTable.classList.add("ratioSummaryTable");
  const summaryBody = document.createElement("tbody");
  const summaryRows = buildSummaryRows();

  summaryRows.forEach((rowCfg, rowIndex) => {
    const tr = document.createElement("tr");
    tr.dataset.rowId = rowCfg.id;
    const th = document.createElement("th");
    th.textContent = rowCfg.label || "Custom";
    if ((th.textContent || "").length > 12) th.classList.add("wrapCell");
    th.classList.add("summaryDragHandle");
    th.draggable = false;
    tr.appendChild(th);
    for (let c = 0; c < ratioLabels.length; c++) {
      const td = document.createElement("td");
      td.classList.add("ratioCell", "summaryCell");
      td.dataset.r = rowCfg.id;
      td.dataset.c = String(c);
      td.dataset.col = String(c);
      td.dataset.copyR = String(rowIndex);
      td.dataset.copyC = String(c);
      td.style.textAlign = "right";
      ratioStrikeSet.delete(`${rowCfg.id},${c}`);
      tr.appendChild(td);
    }
    summaryBody.appendChild(tr);
  });

  const tbody = document.createElement("tbody");
  for (let r = 0; r < origins.length; r++) {
    const tr = document.createElement("tr");
    const rowHead = document.createElement("th");
    rowHead.textContent = String(origins[r] ?? "");
    rowHead.dataset.r = String(r);
    rowHead.classList.add("ratioRowHeader");
    tr.appendChild(rowHead);

    for (let c = 0; c < ratioLabels.length; c++) {
      const td = document.createElement("td");
      td.className = "cell ratioCell";
      td.dataset.r = String(r);
      td.dataset.c = String(c);
      td.dataset.col = String(c);
      const strikeKey = `${r},${c}`;

      if (c >= devs.length - 1) {
        td.textContent = "";
        td.classList.add("na");
        td.classList.remove("ratioPlaceholder");
        ratioStrikeSet.delete(strikeKey);
      } else {
        const hasA = !!(mask[r] && mask[r][c]);
        const hasB = !!(mask[r] && mask[r][c + 1]);
        if (hasA && hasB) {
          const ratio = calcRatio(vals?.[r]?.[c], vals?.[r]?.[c + 1]);
          if (Number.isFinite(ratio)) {
            const rounded = roundRatio(ratio, 6);
            td.textContent = formatRatio(rounded, getDfmDecimalPlaces());
            td.classList.remove("ratioPlaceholder");
          } else {
            td.textContent = formatRatio(1, getDfmDecimalPlaces());
            td.classList.add("ratioPlaceholder");
            ratioStrikeSet.delete(strikeKey);
          }
          td.classList.remove("na");
        } else {
          td.textContent = "";
          td.classList.add("na");
          td.classList.remove("ratioPlaceholder");
          ratioStrikeSet.delete(strikeKey);
        }
        if (ratioStrikeSet.has(strikeKey)) td.classList.add("strike");
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  summaryTable.appendChild(summaryBody);

  const selectedTable = document.createElement("table");
  selectedTable.classList.add("ratioSelectedTable");
  const selectedBody = document.createElement("tbody");
  const selectedRow = document.createElement("tr");
  selectedRow.dataset.rowId = "selected";
  const selectedTh = document.createElement("th");
  selectedTh.textContent = "Selected";
  selectedRow.appendChild(selectedTh);
  for (let c = 0; c < ratioLabels.length; c++) {
    const td = document.createElement("td");
    td.dataset.col = String(c);
    td.dataset.copyR = "0";
    td.dataset.copyC = String(c);
    td.style.textAlign = "right";
    selectedRow.appendChild(td);
  }
  selectedBody.appendChild(selectedRow);
  const cumulativeRow = document.createElement("tr");
  cumulativeRow.dataset.rowId = "cumulative";
  const cumulativeTh = document.createElement("th");
  cumulativeTh.textContent = "Cumulative";
  cumulativeRow.appendChild(cumulativeTh);
  for (let c = 0; c < ratioLabels.length; c++) {
    const td = document.createElement("td");
    td.dataset.col = String(c);
    td.dataset.copyR = "1";
    td.dataset.copyC = String(c);
    td.style.textAlign = "right";
    cumulativeRow.appendChild(td);
  }
  selectedBody.appendChild(cumulativeRow);
  const developedRow = document.createElement("tr");
  developedRow.dataset.rowId = "percent-developed";
  const developedTh = document.createElement("th");
  developedTh.textContent = "% Developed";
  developedRow.appendChild(developedTh);
  for (let c = 0; c < ratioLabels.length; c++) {
    const td = document.createElement("td");
    td.dataset.col = String(c);
    td.dataset.copyR = "2";
    td.dataset.copyC = String(c);
    td.style.textAlign = "right";
    developedRow.appendChild(td);
  }
  selectedBody.appendChild(developedRow);
  selectedTable.appendChild(selectedBody);

  wrap.appendChild(table);
  wrap.appendChild(summaryTable);
  wrap.appendChild(selectedTable);
  applyNaBorderVisibility();

  wireSummaryRowDrag(summaryBody);
  wireSummaryContextMenu(summaryTable);
  wirePercentDevelopedCurveMenu(selectedTable);
  wireDfmCellNotes({
    container: wrap,
    onChange: () => {
      markDfmDirty();
    },
  });
  selectedRatioTableSelection = wireSelectableTable({
    container: selectedTable,
    rowKey: "copyR",
    colKey: "copyC",
    selectedClass: "dfmTableSel",
    activeClass: "dfmTableActive",
    onContextMenu: (_event, _cell, api) => {
      selectedRatioTableSelection = api;
      window.__arcRhoCopyActiveGridSelection = api.copySelection;
    },
  }) || selectedRatioTableSelection;

  requestAnimationFrame(() => {
    const headerCells = table.querySelectorAll("thead th");
    const sRows = summaryTable.querySelectorAll("tr");
    const selRows = selectedTable.querySelectorAll("tr");
    const allRows = [...sRows, ...selRows];
    if (!headerCells.length || !allRows.length) return;
    headerCells.forEach((cell, idx) => {
      const w = Math.round(cell.getBoundingClientRect().width);
      if (!w) return;
      allRows.forEach((row) => {
        const target = row.children[idx];
        if (!target) return;
        target.style.width = `${w}px`;
        target.style.minWidth = `${w}px`;
        target.style.maxWidth = `${w}px`;
      });
    });
  });

  updateRatioSummary();
  refreshAllExcelLinks();
  initDefaultSummarySelection(summaryTable);
  applySummarySelection(summaryTable, selectedTable);
  applyRatioColHighlight();
  applyDfmCellNoteMarkers(wrap);
  wireSummarySelection(summaryTable, selectedTable);
  applyPendingExternalChangeHighlights();
}

// =============================================================================
// Strike Toggle + Column Selection Wiring
// =============================================================================
export function wireRatioStrikeToggle() {
  const wrap = document.getElementById("ratioWrap");
  if (!wrap || wrap.dataset.strikeWired === "1") return;
  wrap.dataset.strikeWired = "1";
  let dragActive = false;
  let lastKey = null;
  const isDataRow = (rowId) => /^\d+$/.test(String(rowId || ""));

  const finishRatioCellDrag = () => {
    if (dragActive) {
      commitRatioHistoryAction("ratio-cell-click");
    }
    dragActive = false;
    lastKey = null;
  };

  const toggleRatioRowExclusions = (rowHead) => {
    if (!rowHead) return;
    const rRaw = rowHead.dataset.r;
    if (!isDataRow(rRaw)) return;
    const r = Number(rRaw);
    if (!Number.isInteger(r) || r < 0) return;
    const row = rowHead.closest("tr");
    if (!row) return;
    const cells = Array.from(row.querySelectorAll("td.ratioCell")).filter((cell) => {
      if (cell.classList.contains("na") || cell.classList.contains("ratioPlaceholder")) return false;
      const c = Number(cell.dataset.c);
      return Number.isFinite(c);
    });
    if (!cells.length) return;
    const allExcluded = cells.every((cell) => ratioStrikeSet.has(`${r},${cell.dataset.c}`));
    beginRatioHistoryAction("ratio-row-click");
    cells.forEach((cell) => {
      const key = `${r},${cell.dataset.c}`;
      if (allExcluded) {
        ratioStrikeSet.delete(key);
        cell.classList.remove("strike");
      } else {
        ratioStrikeSet.add(key);
        cell.classList.add("strike");
      }
    });
    scheduleRatioSummaryUpdate();
    onRatioStateMutated();
    commitRatioHistoryAction("ratio-row-click");
  };

  const toggleStrike = (cell) => {
    if (!cell || cell.classList.contains("na") || cell.classList.contains("ratioPlaceholder")) return;
    const r = cell.dataset.r;
    const c = cell.dataset.c;
    if (r == null || c == null) return;
    if (!isDataRow(r)) return;
    if (r === "sum") return;
    const key = `${r},${c}`;
    if (ratioStrikeSet.has(key)) {
      ratioStrikeSet.delete(key);
      cell.classList.remove("strike");
    } else {
      ratioStrikeSet.add(key);
      cell.classList.add("strike");
    }
    scheduleRatioSummaryUpdate();
    onRatioStateMutated();
  };

  wrap.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey) return;
    const cell = e.target?.closest?.("td.ratioCell");
    if (!cell) return;
    ratioTableSelection?.selectCell?.(cell, false);
    if (cell.classList.contains("na") || cell.classList.contains("ratioPlaceholder")) return;
    if (!isDataRow(cell.dataset.r)) return;
    if (cell.dataset.r === "sum") return;
    e.preventDefault();
    dragActive = true;
    beginRatioHistoryAction("ratio-cell-click");
    const key = `${cell.dataset.r},${cell.dataset.c}`;
    lastKey = key;
    toggleStrike(cell);
  });

  wrap.addEventListener("mousemove", (e) => {
    if (!dragActive) return;
    const cell = e.target?.closest?.("td.ratioCell");
    if (!cell) return;
    if (!isDataRow(cell.dataset.r)) return;
    if (cell.dataset.r === "sum") return;
    const key = `${cell.dataset.r},${cell.dataset.c}`;
    if (key === lastKey) return;
    lastKey = key;
    toggleStrike(cell);
  });

  window.addEventListener("mouseup", finishRatioCellDrag);
  window.addEventListener("blur", finishRatioCellDrag);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) finishRatioCellDrag();
  });

  wrap.addEventListener("click", (e) => {
    if (e.detail > 1) return;
    const rowHead = e.target?.closest?.("tbody th.ratioRowHeader[data-r]");
    if (rowHead) {
      e.preventDefault();
      toggleRatioRowExclusions(rowHead);
      return;
    }
    const th = e.target?.closest?.("th[data-col]");
    if (!th) return;
    e.preventDefault();
    const colRaw = th.dataset.col;
    beginRatioHistoryAction("ratio-column-click");
    if (colRaw === "all") {
      setRatioColAllActive(!getRatioColAllActive());
      activeRatioCols.clear();
    } else {
      const col = Number(colRaw);
      if (!Number.isFinite(col)) {
        cancelRatioHistoryAction();
        return;
      }
      setRatioColAllActive(false);
      if (e.ctrlKey || e.metaKey) {
        if (activeRatioCols.has(col)) {
          activeRatioCols.delete(col);
        } else {
          activeRatioCols.add(col);
        }
      } else if (e.shiftKey && activeRatioCols.size > 0) {
        const existing = [...activeRatioCols];
        const lo = Math.min(col, ...existing);
        const hi = Math.max(col, ...existing);
        activeRatioCols.clear();
        for (let i = lo; i <= hi; i++) activeRatioCols.add(i);
      } else {
        const wasActive = activeRatioCols.size === 1 && activeRatioCols.has(col);
        activeRatioCols.clear();
        if (!wasActive) activeRatioCols.add(col);
      }
    }
    const ratiosPage = document.getElementById("dfmRatiosPage");
    const keepTop = ratiosPage ? ratiosPage.scrollTop : 0;
    const keepLeft = ratiosPage ? ratiosPage.scrollLeft : 0;
    applyRatioColHighlight();
    if (ratiosPage) {
      requestAnimationFrame(() => {
        ratiosPage.scrollTop = keepTop;
        ratiosPage.scrollLeft = keepLeft;
      });
    }
    notifyDfmEditState();
    commitRatioHistoryAction("ratio-column-click");
  });

  wrap.addEventListener("dblclick", (e) => {
    const th = e.target?.closest?.("th[data-col]");
    if (!th) return;
    const colRaw = th.dataset.col;
    if (colRaw === "all") return;
    const col = Number(colRaw);
    if (!Number.isFinite(col)) return;
    showRatioColumnChart(col);
  });
}

// =============================================================================
// Spinner Controls (Details page but wired from init)
// =============================================================================
export function wireDfmSpinnerControls() {
  const spinners = Array.from(document.querySelectorAll(".dfmSpinner"));
  if (!spinners.length) return;
  const bumpSelect = (selectEl, delta) => {
    if (!selectEl || !selectEl.options?.length) return;
    const maxIdx = selectEl.options.length - 1;
    const current = Number.isFinite(selectEl.selectedIndex) ? selectEl.selectedIndex : 0;
    const getNum = (opt) => {
      const raw = opt?.value ?? opt?.text ?? "";
      const n = parseFloat(String(raw).replace(/[^\d.\-]/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    const first = getNum(selectEl.options[0]);
    const second = getNum(selectEl.options[1]);
    let ascending = true;
    if (first !== null && second !== null) {
      ascending = second > first;
    }
    const step = ascending ? delta : -delta;
    const next = Math.max(0, Math.min(maxIdx, current + step));
    if (next === current) return;
    selectEl.selectedIndex = next;
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const bumpNumber = (inputEl, delta) => {
    if (!inputEl) return;
    const stepRaw = parseFloat(inputEl.step);
    const step = Number.isFinite(stepRaw) && stepRaw > 0 ? stepRaw : 1;
    const minRaw = parseFloat(inputEl.min);
    const maxRaw = parseFloat(inputEl.max);
    const min = Number.isFinite(minRaw) ? minRaw : null;
    const max = Number.isFinite(maxRaw) ? maxRaw : null;
    const curRaw = parseFloat(inputEl.value);
    let next = Number.isFinite(curRaw) ? curRaw + step * delta : step * delta;
    if (min !== null) next = Math.max(min, next);
    if (max !== null) next = Math.min(max, next);
    inputEl.value = String(next);
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
  };

  spinners.forEach((spinner) => {
    if (spinner.dataset.wired === "1") return;
    spinner.dataset.wired = "1";
    const control = spinner.querySelector("select, input");
    const upBtn = spinner.querySelector(".dfmSpinBtn.up");
    const downBtn = spinner.querySelector(".dfmSpinBtn.down");
    if (!control || !upBtn || !downBtn) return;

    const bump = (delta) => {
      if (control.tagName?.toLowerCase() === "select") {
        bumpSelect(control, delta);
      } else {
        bumpNumber(control, delta);
      }
    };

    upBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      bump(1);
    });
    downBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      bump(-1);
    });
  });

  const decimalInput = document.getElementById("decimalPlaces");
  if (decimalInput && decimalInput.dataset.dfmDecimalWired !== "1") {
    decimalInput.dataset.dfmDecimalWired = "1";
    let lastCommitted = String(getDfmDecimalPlaces());
    const applyDecimalPlaces = () => {
      const normalized = String(getDfmDecimalPlaces());
      if (decimalInput.value !== normalized) decimalInput.value = normalized;
      const changed = normalized !== lastCommitted;
      const programmatic = decimalInput.dataset.programmatic === "1";
      if (programmatic) delete decimalInput.dataset.programmatic;
      if (!changed) return;
      lastCommitted = normalized;
      if (!programmatic) markDfmDirty();
      if (document.getElementById("dfmRatiosPage")?.style.display !== "none") {
        renderRatioTable();
      }
      if (isRatioChartOpen()) scheduleRatioChartRender();
    };
    decimalInput.addEventListener("change", applyDecimalPlaces);
    decimalInput.addEventListener("blur", applyDecimalPlaces);
  }
}


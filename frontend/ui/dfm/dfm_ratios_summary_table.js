/*
===============================================================================
DFM Ratios Summary Table - extracted summary table logic
===============================================================================
*/
import {
  state,
  calcRatio, roundRatio, formatRatio, computeAverageForColumn,
  ratioStrikeSet, selectedSummaryByCol, summaryRowConfigs, summaryRowMap, BASE_SUMMARY_ROWS,
  getShowNaBorders,
  getRatioSummaryRaf, setRatioSummaryRaf,
  getLastSummaryCtxRowId, setLastSummaryCtxRowId,
  getEffectiveDevLabelsForModel, getRatioHeaderLabels, buildSummaryRows,
  buildExcludedSetForColumn, parsePeriodsValue, parseExcludeValue, getDfmDecimalPlaces,
} from "/ui/dfm/dfm_state.js";
import {
  getSummaryConfigKey,
  loadCustomSummaryRows, saveCustomSummaryRows,
} from "/ui/dfm/dfm_storage.js";
import {
  getExcelActiveSelection, readExcelCell, readExcelCellsBatch, openExcelWorkbook, excelWaitForEnter,
} from "/ui/shared/api.js";
import { wireSelectableTable } from "/ui/shared/table_selection.js";
import { openDfmSummaryPlotWindow } from "/ui/dfm/dfm_summary_plot_window.js?v=20260514g";
import {
  clearDfmCellNote,
  hasDfmCellNote,
  showDfmCellNoteEditor,
} from "/ui/dfm/dfm_cell_notes.js";
import {
  beginRatioHistoryAction,
  commitRatioHistoryAction,
} from "/ui/dfm/dfm_ratio_history.js";

// =============================================================================
// Excel Cell Reference Utilities
// =============================================================================
// Matches standalone: ='dir\[filename.xlsx]Sheet'!A1  (with or without leading =, quotes)
const EXCEL_REF_RE = /^\s*=?\s*'?([^[]*)\[([^\]]+)\]([^'!]+)'?!([A-Z]+[0-9]+)\s*$/i;
// Non-anchored: finds Excel refs embedded within larger expressions
const EXCEL_REF_INLINE_RE = /'([^[]*)\[([^\]]+)\]([^'!]+)'!([A-Z]+[0-9]+)/gi;

function parseExcelRef(text) {
  const m = EXCEL_REF_RE.exec(String(text || ""));
  if (!m) return null;
  const dir = m[1];            // e.g. "E:\ArcRho\Demo\"
  const filename = m[2];       // e.g. "Freq w. New Renewal.xlsx"
  const sheet = m[3];          // e.g. "Annual"
  const cell = m[4].toUpperCase();
  const bookPath = dir + filename;
  return { bookPath, dir, filename, sheet, cell };
}


/** Find all Excel ref occurrences within an expression string. */
function findExcelRefsInline(text) {
  const refs = [];
  EXCEL_REF_INLINE_RE.lastIndex = 0;
  let m;
  while ((m = EXCEL_REF_INLINE_RE.exec(text)) !== null) {
    refs.push({
      match: m[0],                        // the full matched substring
      bookPath: m[1] + m[2],              // dir + filename
      sheet: m[3],
      cell: m[4].toUpperCase(),
    });
  }
  return refs;
}

/** Returns true if the text contains any Excel ref (standalone or inline). */
function containsExcelRef(text) {
  const s = String(text || "");
  if (EXCEL_REF_RE.test(s)) return true;
  EXCEL_REF_INLINE_RE.lastIndex = 0;
  return EXCEL_REF_INLINE_RE.test(s);
}

/**
 * Resolve all Excel refs in an expression to numeric values, then evaluate
 * the resulting math expression with row references.
 * Returns { ok, value, error? }.
 */
async function resolveExcelRefsInExpression(raw, referenceValues) {
  let expr = String(raw || "").trim();
  if (expr.startsWith("=")) expr = expr.slice(1).trim();

  // Find all inline Excel refs
  const refs = findExcelRefsInline("=" + expr); // prepend = to normalise
  if (!refs.length) return { ok: false, error: "No Excel refs found." };

  // Resolve each unique ref
  const resolvedMap = new Map();
  for (const ref of refs) {
    if (resolvedMap.has(ref.match)) continue;
    const result = await readExcelCell(ref.bookPath, ref.sheet, ref.cell);
    if (!result.ok) return { ok: false, error: `Excel read error for ${ref.match}: ${result.error}` };
    if (!Number.isFinite(result.value)) return { ok: false, error: `Non-numeric value from ${ref.match}: ${result.value}` };
    resolvedMap.set(ref.match, String(result.value));
    _xlCellValueCache.set(ref.match, result.value);
  }

  // Substitute Excel refs with their numeric values in the expression
  let substituted = "=" + expr;
  for (const [matchStr, numStr] of resolvedMap) {
    substituted = substituted.split(matchStr).join(numStr);
  }

  // Now evaluate using the existing math evaluator (handles row references + arithmetic)
  const parsed = evaluateSimpleMathExpression(substituted, referenceValues);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { ok: false, error: null }; // let caller show standard error
  }
  return { ok: true, value: parsed };
}

function formatExcelRef(bookPath, sheet, cell) {
  // Split full path into dir + filename to match Excel convention
  const lastSep = Math.max(bookPath.lastIndexOf("\\"), bookPath.lastIndexOf("/"));
  const dir = lastSep >= 0 ? bookPath.slice(0, lastSep + 1) : "";
  const filename = lastSep >= 0 ? bookPath.slice(lastSep + 1) : bookPath;
  return `='${dir}[${filename}]${sheet}'!${cell}`;
}

// Cache of last-resolved Excel cell values, keyed by ref match string (e.g. "'dir\[file]Sheet'!A1")
const _xlCellValueCache = new Map();

let _xlLinkMode = false;
let _xlLinkFocusHandler = null;
let _xlLinkEscHandler = null;
let _xlLinkAbortController = null;

let _renderRatioTable = () => {};
let _onRatioStateMutated = () => {};
let summaryContextCellForNote = null;
let formulaBarResizeObserver = null;
let formulaBarScrollHost = null;
let formulaBarResizeWired = false;
let formulaBarResizeRaf = 0;
const SUMMARY_FORMULA_BAR_FRAME_INSET_PX = 14;

export function setSummaryTableCallbacks({ renderRatioTable, onRatioStateMutated } = {}) {
  if (typeof renderRatioTable === "function") _renderRatioTable = renderRatioTable;
  if (typeof onRatioStateMutated === "function") _onRatioStateMutated = onRatioStateMutated;
}

export function resetSummaryFormulaEditState() {
  summaryFormulaEditState = null;
}

// =============================================================================
// Ratio Selection Pattern + Average Selection
// =============================================================================
function trimTrailingMaskCells(row) {
  const out = Array.isArray(row) ? row.slice() : [];
  while (out.length && out[out.length - 1] === 2) {
    out.pop();
  }
  return out;
}

export function buildRatioSelectionPattern() {
  const model = state.model;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) return [];
  const origins = model.origin_labels || [];
  const devs = getEffectiveDevLabelsForModel(model);
  const ratioLabels = getRatioHeaderLabels(devs);
  const colCount = ratioLabels.length;
  const vals = model.values;
  const mask = model.mask;
  const pattern = [];

  for (let r = 0; r < origins.length; r++) {
    const row = [];
    for (let c = 0; c < colCount; c++) {
      const strikeKey = `${r},${c}`;
      if (c >= devs.length - 1) {
        row.push(2);
        continue;
      }
      const hasA = !!(mask[r] && mask[r][c]);
      const hasB = !!(mask[r] && mask[r][c + 1]);
      if (!hasA || !hasB) {
        row.push(2);
        continue;
      }
      const ratio = calcRatio(vals?.[r]?.[c], vals?.[r]?.[c + 1]);
      if (!Number.isFinite(ratio)) {
        row.push(2);
        continue;
      }
      row.push(ratioStrikeSet.has(strikeKey) ? 1 : 0);
    }
    pattern.push(trimTrailingMaskCells(row));
  }
  return pattern;
}

export function buildAverageSelectionPayload() {
  const model = state.model;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) {
    return { formulas: [], matrix: [] };
  }
  const devs = getEffectiveDevLabelsForModel(model);
  const ratioLabels = getRatioHeaderLabels(devs);
  const colCount = ratioLabels.length;
  const formulas = summaryRowConfigs.map((row) => String(row.label || row.id));
  const matrix = formulas.map(() => new Array(colCount).fill(0));

  for (let c = 0; c < colCount; c++) {
    const rowId = selectedSummaryByCol.get(c) || "";
    const idx = summaryRowConfigs.findIndex((cfg) => String(cfg.id) === String(rowId));
    if (idx >= 0 && matrix[idx]) matrix[idx][c] = 1;
  }

  return { formulas, matrix };
}

export function applyRatioSelectionPattern(pattern) {
  if (!Array.isArray(pattern)) return false;
  const model = state.model;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) return false;
  const devs = getEffectiveDevLabelsForModel(model);
  const ratioLabels = getRatioHeaderLabels(devs);
  const rowCount = Math.min(pattern.length, (model.origin_labels || []).length);
  const colCount = Math.min(ratioLabels.length, devs.length - 1);
  if (!rowCount || colCount <= 0) return false;

  ratioStrikeSet.clear();
  for (let r = 0; r < rowCount; r++) {
    const row = Array.isArray(pattern[r]) ? pattern[r] : [];
    for (let c = 0; c < colCount; c++) {
      if (row[c] === 1) ratioStrikeSet.add(`${r},${c}`);
    }
  }
  return true;
}

export function applySelectedSummaryFromSaved(selected, colCount) {
  if (!selected) return;
  selectedSummaryByCol.clear();
  if (Array.isArray(selected)) {
    if (selected.length && Array.isArray(selected[0])) {
      selected.forEach((entry) => {
        const col = Number(entry?.[0]);
        const rowId = entry?.[1];
        if (Number.isFinite(col) && typeof rowId === "string" && rowId) {
          selectedSummaryByCol.set(col, rowId);
        }
      });
      return;
    }
    for (let c = 0; c < Math.min(selected.length, colCount); c++) {
      const rowId = selected[c];
      if (typeof rowId === "string" && rowId) {
        selectedSummaryByCol.set(c, rowId);
      }
    }
  }
}

export function applyAverageSelectionFromSaved(formulas, matrix) {
  if (!Array.isArray(formulas) || !Array.isArray(matrix)) return;
  selectedSummaryByCol.clear();
  const formulaList = formulas.map((f) => String(f));
  const rowCount = matrix.length;
  let colCount = 0;
  for (let r = 0; r < rowCount; r++) {
    if (Array.isArray(matrix[r])) colCount = Math.max(colCount, matrix[r].length);
  }
  for (let c = 0; c < colCount; c++) {
    let idx = -1;
    for (let r = 0; r < rowCount; r++) {
      const row = Array.isArray(matrix[r]) ? matrix[r] : [];
      if (Number(row[c]) === 1) {
        idx = r;
        break;
      }
    }
    if (idx >= 0 && formulaList[idx]) {
      const label = formulaList[idx];
      const cfg = summaryRowConfigs.find((rowCfg) =>
        String(rowCfg.label || "") === label || String(rowCfg.id || "") === label
      );
      if (cfg?.id) selectedSummaryByCol.set(c, String(cfg.id));
    }
  }
}
// =============================================================================
// Summary Rows Ordering
// =============================================================================
function getCurrentSummaryOrder(summaryBody) {
  return Array.from(summaryBody.querySelectorAll("tr[data-row-id]"))
    .map((row) => row.dataset.rowId)
    .filter(Boolean);
}

function saveSummaryRowsInCurrentOrder(summaryBody) {
  const cfgKey = getSummaryConfigKey();
  if (!cfgKey) return;
  const order = getCurrentSummaryOrder(summaryBody);
  if (!order.length) return;
  const byId = new Map(summaryRowConfigs.map((row) => [String(row.id), row]));
  const used = new Set();
  const nextRows = [];
  order.forEach((id) => {
    const row = byId.get(String(id));
    if (!row || used.has(String(id))) return;
    nextRows.push({ ...row });
    used.add(String(id));
  });
  summaryRowConfigs.forEach((row) => {
    const id = String(row.id || "");
    if (!id || used.has(id)) return;
    nextRows.push({ ...row });
  });
  if (!nextRows.length) return;
  saveCustomSummaryRows(cfgKey, nextRows);
  buildSummaryRows();
}

// =============================================================================
// Summary Interactions (Drag, Context Menu, Avg Modal)
// =============================================================================
export function wireSummaryRowDrag(summaryBody) {
  if (!summaryBody || summaryBody.dataset.dragWired === "1") return;
  summaryBody.dataset.dragWired = "1";

  let dragRow = null;
  let dragGhost = null;
  let dragOverRow = null;
  let dropBefore = true;
  let dragStartIndex = -1;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragMoved = false;
  let offsetY = 0;
  let fixedLeft = 0;

  const animateLayoutChange = (body, fn) => {
    const rows = Array.from(body.querySelectorAll("tr[data-row-id]"));
    const first = new Map(rows.map((row) => [row, row.getBoundingClientRect()]));
    fn();
    const last = new Map(rows.map((row) => [row, row.getBoundingClientRect()]));
    rows.forEach((row) => {
      const a = first.get(row);
      const b = last.get(row);
      if (!a || !b) return;
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (!dx && !dy) return;
      row.style.transform = `translate(${dx}px, ${dy}px)`;
      row.style.transition = "none";
    });
    body.offsetHeight; // force reflow
    rows.forEach((row) => {
      if (!row.style.transform) return;
      row.style.transition = "";
      row.style.transform = "";
    });
    window.setTimeout(() => {
      rows.forEach((row) => {
        row.style.transition = "";
        row.style.transform = "";
      });
    }, 180);
  };

  const clearDropTarget = () => {
    if (dragOverRow) dragOverRow.classList.remove("summaryDropTarget");
    dragOverRow = null;
    dropBefore = true;
  };

  const updateDropTarget = (clientY) => {
    const rows = Array.from(summaryBody.querySelectorAll("tr[data-row-id]"));
    let target = null;
    let before = true;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (clientY <= rect.bottom) {
        target = row;
        before = true;
        break;
      }
    }
    if (!target && rows.length) {
      target = rows[rows.length - 1];
      before = false;
    }
    if (target && dragStartIndex >= 0) {
      const targetIndex = rows.indexOf(target);
      if (targetIndex !== -1) {
        before = dragStartIndex < targetIndex ? false : true;
      }
    }
    if (dragOverRow && dragOverRow !== target) {
      dragOverRow.classList.remove("summaryDropTarget");
    }
    dragOverRow = target;
    dropBefore = before;
    if (dragOverRow) dragOverRow.classList.add("summaryDropTarget");
  };

  const onMouseMove = (e) => {
    if (!dragRow) return;
    if (!dragMoved) {
      const dx = Math.abs(e.clientX - dragStartX);
      const dy = Math.abs(e.clientY - dragStartY);
      if (dx < 4 && dy < 4) return;
      dragMoved = true;
      clearDropTarget();
      const rect = dragRow.getBoundingClientRect();
      offsetY = dragStartY - rect.top;
      fixedLeft = rect.left;
      const ghostTable = document.createElement("table");
      ghostTable.classList.add("summaryDragGhostTable");
      ghostTable.style.width = `${rect.width}px`;
      ghostTable.style.left = `${fixedLeft}px`;
      ghostTable.style.top = `${rect.top}px`;
      const ghostBody = document.createElement("tbody");
      const ghostRow = dragRow.cloneNode(true);
      ghostRow.classList.add("summaryDragGhostRow");
      const srcCells = Array.from(dragRow.children);
      const ghostCells = Array.from(ghostRow.children);
      srcCells.forEach((cell, idx) => {
        const w = Math.round(cell.getBoundingClientRect().width);
        const gc = ghostCells[idx];
        if (!gc || !w) return;
        gc.style.width = `${w}px`;
        gc.style.minWidth = `${w}px`;
        gc.style.maxWidth = `${w}px`;
      });
      ghostBody.appendChild(ghostRow);
      ghostTable.appendChild(ghostBody);
      dragGhost = ghostTable;
      document.body.appendChild(dragGhost);
      dragRow.classList.add("dragging");
    }
    if (!dragGhost) return;
    const top = e.clientY - offsetY;
    dragGhost.style.top = `${top}px`;
    dragGhost.style.left = `${fixedLeft}px`;
    updateDropTarget(e.clientY);
  };

  const endDrag = (commit) => {
    if (!dragRow) return;
    if (!dragMoved) {
      clearDropTarget();
      dragRow = null;
      dragStartIndex = -1;
      dragStartX = 0;
      dragStartY = 0;
      dragMoved = false;
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("mouseup", onMouseUp, true);
      return;
    }
    if (dragGhost) {
      dragGhost.remove();
      dragGhost = null;
    }
    dragRow.classList.remove("dragging");
    if (commit && dragOverRow && dragOverRow !== dragRow) {
      animateLayoutChange(summaryBody, () => {
        const insertBeforeNode = dropBefore ? dragOverRow : dragOverRow.nextSibling;
        summaryBody.insertBefore(dragRow, insertBeforeNode);
      });
      saveSummaryRowsInCurrentOrder(summaryBody);
    }
    clearDropTarget();
    dragRow = null;
    offsetY = 0;
    fixedLeft = 0;
    dragStartIndex = -1;
    dragStartX = 0;
    dragStartY = 0;
    dragMoved = false;
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("mouseup", onMouseUp, true);
  };

  const onMouseUp = (e) => {
    if (e) updateDropTarget(e.clientY);
    endDrag(true);
  };

  summaryBody.addEventListener("mousedown", (e) => {
    const th = e.target?.closest?.("th.summaryDragHandle");
    if (!th) return;
    if (e.button !== 0) return;
    const row = th.closest("tr");
    if (!row || !row.dataset?.rowId) return;
    e.preventDefault();
    dragRow = row;
    const rows = Array.from(summaryBody.querySelectorAll("tr[data-row-id]"));
    dragStartIndex = rows.indexOf(row);
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragMoved = false;
    dragOverRow = row;
    dropBefore = true;
    row.classList.add("summaryDropTarget");
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseup", onMouseUp, true);
  });
}

let avgMenuWired = false;
let summaryCopySelection = null;

function getAvgMenuEl() {
  return document.getElementById("dfmAvgMenu");
}

function getRatioMenuEl() {
  return document.getElementById("dfmRatioMenu");
}

function getResultsTabMenuEl() {
  return document.getElementById("dfmResultsTabMenu");
}

function updateRatioMenuLabel() {
  const menu = getRatioMenuEl();
  const btn = menu?.querySelector('[data-action="toggle-na-borders"]');
  if (!btn) return;
  btn.textContent = getShowNaBorders() ? "Hide Lower-Right Borders" : "Show Lower-Right Borders";
}

function applyNaBorderVisibility() {
  const wrap = document.getElementById("ratioWrap");
  if (!wrap) return;
  wrap.classList.toggle("showNaBorders", getShowNaBorders());
}

function getAvgModalEl() {
  return document.getElementById("dfmAvgModal");
}

function hideAvgMenu() {
  const menu = getAvgMenuEl();
  if (menu) menu.style.display = "none";
}

function hideResultsTabMenu() {
  const menu = getResultsTabMenuEl();
  if (menu) menu.style.display = "none";
}

function showAvgMenu(x, y) {
  const menu = getAvgMenuEl();
  if (!menu) return;
  menu.style.display = "block";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

let summaryActiveCellState = { rowId: "", col: -1 };
let summaryFormulaEditState = null;
let summaryFormulaBarSkipBlurCommit = false;
let summaryReferenceDragState = null;

function normalizeAverageType(value) {
  const txt = String(value || "").trim().toLowerCase();
  return txt === "user_entry" ? "user_entry" : "custom";
}

export function isUserEntryConfig(cfg) {
  return normalizeAverageType(cfg?.averageType) === "user_entry";
}

function getCurrentRatioColumnCount() {
  const model = state.model;
  const devs = getEffectiveDevLabelsForModel(model || {});
  return getRatioHeaderLabels(devs).length;
}

function sanitizeUserEntryValue(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return n;
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findReferencedLabels(formula, allLabels) {
  const labels = Array.isArray(allLabels) ? allLabels : [];
  if (!labels.length) return [];

  const referencedNames = new Set(
    tokenizeFormula(formula)
      .filter((token) => token.type === "ref")
      .map((token) => token.text.slice(1, -1).trim().toLowerCase())
      .filter(Boolean)
  );
  if (!referencedNames.size) return [];

  return labels.filter((label) => referencedNames.has(String(label || "").trim().toLowerCase()));
}

function getSummaryLabelToIdMap() {
  const rows = Array.isArray(summaryRowConfigs) ? summaryRowConfigs : [];
  return new Map(
    rows
      .map((cfg) => [String(cfg?.label || cfg?.id || "").trim(), String(cfg?.id || "").trim()])
      .filter(([label, rowId]) => label && rowId)
  );
}

function getSummaryCellRowLabel(cell) {
  return String(cell?.parentElement?.querySelector?.("th")?.textContent || "").trim();
}

function getFormulaReferencedLabels(raw) {
  const labelToId = getSummaryLabelToIdMap();
  if (!labelToId.size) return [];
  return findReferencedLabels(raw, Array.from(labelToId.keys()));
}

function replaceFormulaReferenceLabel(raw, oldLabel, newLabel) {
  const oldText = String(oldLabel || "").trim();
  const nextText = String(newLabel || "").trim();
  const source = String(raw || "");
  if (!oldText || !nextText || oldText.toLowerCase() === nextText.toLowerCase()) {
    return { changed: false, value: source };
  }

  const tokens = tokenizeFormula(source);
  for (const token of tokens) {
    if (token.type !== "ref") continue;
    const quote = token.text[0];
    const inner = token.text.slice(1, -1);
    if (inner.toLowerCase() !== oldText.toLowerCase()) continue;
    token.text = `${quote}${nextText}${quote}`;
    return { changed: true, value: tokens.map((item) => item.text).join("") };
  }

  const lit = escapeRegExp(oldText);
  const bare = new RegExp(lit, "i");
  if (!bare.test(source)) return { changed: false, value: source };
  return { changed: true, value: source.replace(bare, `"${nextText}"`) };
}

function updateActiveSummaryFormulaReferenceUi(summaryTable) {
  if (!summaryTable) return;
  summaryTable.querySelectorAll("td.summaryCell.summaryFormulaActiveRefCell")
    .forEach((el) => el.classList.remove("summaryFormulaActiveRefCell"));

  const state = summaryFormulaEditState;
  const input = state?.input;
  if (!state || state.summaryTable !== summaryTable || !input || !document.body.contains(input)) return;
  if (!String(input.value || "").includes("=")) return;

  const editCol = Number(state.col);
  const editCell = state.cell;
  if (!Number.isFinite(editCol) || editCol < 0 || !editCell) return;

  const labelToId = getSummaryLabelToIdMap();
  getFormulaReferencedLabels(input.value).forEach((label) => {
    const rowId = labelToId.get(label);
    if (!rowId) return;
    const refCell = summaryTable.querySelector(
      `td.summaryCell[data-r="${CSS.escape(rowId)}"][data-col="${editCol}"]`
    );
    if (!refCell || refCell === editCell) return;
    refCell.classList.add("summaryFormulaActiveRefCell");
  });
}

function applyUserEntryReferenceHighlights(summaryTable) {
  if (!summaryTable) return;
  summaryTable.querySelectorAll("td.summaryCell.summaryFormulaReferencedCell")
    .forEach((el) => el.classList.remove("summaryFormulaReferencedCell"));

  const labelToId = getSummaryLabelToIdMap();
  if (!labelToId.size) return;
  const labels = Array.from(labelToId.keys());

  summaryRowConfigs.forEach((cfg) => {
    if (!isUserEntryConfig(cfg)) return;
    const sourceRowId = String(cfg?.id || "");
    const colCount = getCurrentRatioColumnCount();
    for (let col = 0; col < colCount; col++) {
      const inputRaw = String(getUserEntryInputForCol(cfg, col) || "").trim();
      if (!inputRaw) continue;
      const referencedLabels = findReferencedLabels(inputRaw, labels);
      referencedLabels.forEach((label) => {
        const refRowId = labelToId.get(label);
        if (!refRowId || refRowId === sourceRowId) return;
        const refCell = summaryTable.querySelector(
          `td.summaryCell[data-r="${CSS.escape(refRowId)}"][data-col="${col}"]`
        );
        if (refCell) refCell.classList.add("summaryFormulaReferencedCell");
      });
    }
  });
}

function evaluateSimpleMathExpression(raw, referenceValues) {
  const txt = String(raw || "").trim();
  if (!txt) return null;
  let expr = txt.startsWith("=") ? txt.slice(1).trim() : txt;
  if (!expr) return null;
  if (referenceValues instanceof Map && referenceValues.size) {
    const entries = Array.from(referenceValues.entries())
      .filter(([label, value]) => String(label || "").trim() && Number.isFinite(Number(value)))
      .sort((a, b) => String(b[0]).length - String(a[0]).length);
    entries.forEach(([label, value]) => {
      const lit = escapeRegExp(String(label));
      const numeric = String(Number(value));
      expr = expr.replace(new RegExp(`"${lit}"`, "g"), numeric);
      expr = expr.replace(new RegExp(`'${lit}'`, "g"), numeric);
      expr = expr.replace(new RegExp(lit, "g"), numeric);
    });
  }
  if (!/^[0-9+\-*/().\s]+$/.test(expr)) return null;
  if (expr.includes("**")) return null;
  try {
    const out = Function(`"use strict"; return (${expr});`)();
    return Number.isFinite(out) ? Number(out) : null;
  } catch {
    return null;
  }
}

function stripFormulaEquals(raw) {
  const text = String(raw || "").trim();
  return text.startsWith("=") ? text.slice(1).trim() : text;
}

function splitFormulaTopLevel(raw, separator) {
  const text = String(raw || "");
  const parts = [];
  let current = "";
  let quote = "";
  let depthParen = 0;
  let depthBrace = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") {
      depthParen += 1;
      current += ch;
      continue;
    }
    if (ch === ")") {
      depthParen = Math.max(0, depthParen - 1);
      current += ch;
      continue;
    }
    if (ch === "{") {
      depthBrace += 1;
      current += ch;
      continue;
    }
    if (ch === "}") {
      depthBrace = Math.max(0, depthBrace - 1);
      current += ch;
      continue;
    }
    if (ch === separator && depthParen === 0 && depthBrace === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts;
}

function stripSingleOuterParens(raw) {
  const text = String(raw || "").trim();
  if (!text.startsWith("(") || !text.endsWith(")")) return null;
  let quote = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (depth === 0 && i < text.length - 1) return null;
  }
  return depth === 0 ? text.slice(1, -1).trim() : null;
}

function parseArrayConstant(raw) {
  const text = String(raw || "").trim();
  if (!text.startsWith("{") || !text.endsWith("}")) {
    return { ok: false, error: "Array formulas must use an Excel-style array constant like ={1,2,3}." };
  }
  const inner = text.slice(1, -1).trim();
  if (!inner) return { ok: false, error: "Array formula is empty." };
  const rows = splitFormulaTopLevel(inner, ";").map((rowText) => splitFormulaTopLevel(rowText, ","));
  if (!rows.length || rows.some((row) => !row.length || row.some((item) => !String(item || "").trim()))) {
    return { ok: false, error: "Array formula contains an empty item." };
  }
  const width = rows[0].length;
  if (rows.some((row) => row.length !== width)) {
    return { ok: false, error: "Array formula rows must have the same length." };
  }
  return { ok: true, rows };
}

function parseSummaryArrayFormula(raw) {
  const expr = stripFormulaEquals(raw);
  if (!expr) return null;
  const transposeMatch = /^TRANSPOSE\s*/i.exec(expr);
  if (transposeMatch) {
    const args = stripSingleOuterParens(expr.slice(transposeMatch[0].length).trim());
    if (args == null) {
      return { ok: false, error: "TRANSPOSE array formulas must look like =TRANSPOSE({1;2;3})." };
    }
    const parsed = parseArrayConstant(args);
    if (!parsed.ok) return parsed;
    if (!parsed.rows.length || parsed.rows.some((row) => row.length !== 1)) {
      return { ok: false, error: "TRANSPOSE array formulas must contain a single-column array, like =TRANSPOSE({1;2;3})." };
    }
    return { ok: true, expressions: parsed.rows.map((row) => row[0]) };
  }
  if (!expr.startsWith("{")) return null;
  const parsed = parseArrayConstant(expr);
  if (!parsed.ok) return parsed;
  if (parsed.rows.length !== 1) {
    return { ok: false, error: "Use a 1-row array like ={1,2,3}, or wrap a single-column array with TRANSPOSE({1;2;3})." };
  }
  return { ok: true, expressions: parsed.rows[0] };
}

function normalizeUserEntryValues(values, minLength = 0) {
  const arr = Array.isArray(values) ? values.slice() : [];
  for (let i = 0; i < arr.length; i++) arr[i] = sanitizeUserEntryValue(arr[i]);
  while (arr.length < minLength) arr.push(1);
  return arr;
}

function normalizeUserEntryInputs(inputs, values, minLength = 0) {
  const arr = Array.isArray(inputs) ? inputs.slice() : [];
  const valueArr = Array.isArray(values) ? values : [];
  for (let i = 0; i < arr.length; i++) {
    arr[i] = String(arr[i] ?? "").trim();
  }
  while (arr.length < minLength) {
    const fallback = Number(valueArr[arr.length]);
    arr.push(Number.isFinite(fallback) && fallback > 0 ? String(fallback) : "1");
  }
  return arr;
}

export function getUserEntryValueForCol(cfg, col) {
  if (!isUserEntryConfig(cfg)) return 1;
  const values = normalizeUserEntryValues(cfg?.values, Math.max(0, col + 1));
  return sanitizeUserEntryValue(values[col]);
}

function getUserEntryInputForCol(cfg, col) {
  if (!isUserEntryConfig(cfg)) return "";
  const values = normalizeUserEntryValues(cfg?.values, Math.max(0, col + 1));
  const inputs = normalizeUserEntryInputs(cfg?.inputs ?? cfg?.formulas, values, Math.max(0, col + 1));
  const txt = String(inputs[col] ?? "").trim();
  if (txt) return txt;
  const fallback = sanitizeUserEntryValue(values[col]);
  return String(fallback);
}

function summaryTableHasUserEntryRows(summaryTable) {
  if (!summaryTable) return false;
  const rows = Array.from(summaryTable.querySelectorAll("tr[data-row-id]"));
  return rows.some((row) => {
    const rowId = String(row.dataset.rowId || "");
    const cfg = summaryRowMap.get(rowId);
    return !!cfg && isUserEntryConfig(cfg);
  });
}

function scrollSummaryFormulaInputToEnd(inputEl) {
  if (!inputEl) return;
  window.requestAnimationFrame(() => {
    try {
      inputEl.scrollLeft = inputEl.scrollWidth;
    } catch (_err) {
      // no-op: some browsers may not expose scroll metrics on detached inputs
    }
  });
}

/**
 * Tokenise a formula string into typed segments.
 * Recognises Excel refs, quoted row references, operators, and plain text.
 */
function tokenizeFormula(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return [];

  // Ensure leading '='
  let remaining = text.startsWith("=") ? text : "=" + text;
  const tokens = [];

  while (remaining.length > 0) {
    // Excel ref: 'dir\[file.xlsx]Sheet'!A1
    const xlMatch = /^'([^[]*)\[([^\]]+)\]([^'!]+)'![A-Z]+[0-9]+/i.exec(remaining);
    if (xlMatch) {
      tokens.push({ type: "excel", text: xlMatch[0] });
      remaining = remaining.slice(xlMatch[0].length);
      continue;
    }
    // Quoted row reference: "Some Label" or 'Some Label'
    const quotedMatch = /^(["'])(.+?)\1/.exec(remaining);
    if (quotedMatch) {
      tokens.push({ type: "ref", text: quotedMatch[0] });
      remaining = remaining.slice(quotedMatch[0].length);
      continue;
    }
    // Operator
    const opMatch = /^[+\-*/]/.exec(remaining);
    if (opMatch) {
      tokens.push({ type: "op", text: opMatch[0] });
      remaining = remaining.slice(1);
      continue;
    }
    // Plain text (one char at a time)
    tokens.push({ type: "plain", text: remaining[0] });
    remaining = remaining.slice(1);
  }

  // Merge consecutive plain tokens
  const merged = [];
  for (const tok of tokens) {
    if (tok.type === "plain" && merged.length > 0 && merged[merged.length - 1].type === "plain") {
      merged[merged.length - 1].text += tok.text;
    } else {
      merged.push({ ...tok });
    }
  }
  return merged;
}

/**
 * Format a raw formula string with proper spacing around operators
 * and ensure leading '='. Does not alter content inside Excel refs
 * or quoted references.
 */
function formatFormulaText(rawText) {
  const tokens = tokenizeFormula(rawText);
  if (!tokens.length) return String(rawText || "").trim();
  let out = "";
  for (const tok of tokens) {
    if (tok.type === "op") {
      out = out.replace(/\s+$/, "");
      out += " " + tok.text + " ";
    } else if (tok.type === "plain") {
      out += tok.text.trim();
    } else {
      out += tok.text;
    }
  }
  const formatted = out.replace(/\s+$/, "");
  if (formatted.startsWith("=")) return `= ${formatted.slice(1).trimStart()}`;
  return formatted;
}

/**
 * Render colorized formula display in the overlay div.
 * - Excel refs → dark green
 * - Quoted row references → blue
 * - Operators get spaces around them
 * - Always shows leading '='
 */
function renderFormulaBarDisplay(displayEl, rawText) {
  if (!displayEl) return;
  const tokens = tokenizeFormula(rawText);
  if (!tokens.length) {
    displayEl.textContent = "";
    return;
  }

  displayEl.innerHTML = "";
  for (const tok of tokens) {
    if (tok.type === "excel") {
      const span = document.createElement("span");
      span.className = "fmtExcelRef";
      span.textContent = tok.text;
      displayEl.appendChild(span);
    } else if (tok.type === "ref") {
      const span = document.createElement("span");
      span.className = "fmtRowRef";
      span.textContent = tok.text;
      displayEl.appendChild(span);
    } else if (tok.type === "op") {
      displayEl.appendChild(document.createTextNode(" " + tok.text + " "));
    } else {
      const t = tok.text.trim();
      if (t) displayEl.appendChild(document.createTextNode(t));
    }
  }
}

/** Show/hide display overlay vs input based on focus state. */
function updateFormulaBarDisplayMode(barEl, isEditing) {
  if (!barEl) return;
  const input = barEl.querySelector("#dfmSummaryFormulaBarInput");
  const display = barEl.querySelector("#dfmSummaryFormulaBarDisplay");
  if (!input || !display) return;
  if (isEditing) {
    input.style.display = "";
    display.style.display = "none";
  } else {
    // Format the raw input with proper spacing and leading '='
    const raw = String(input.value || "").trim();
    if (raw) {
      input.value = formatFormulaText(raw);
    }
    input.style.display = "none";
    display.style.display = "";
    renderFormulaBarDisplay(display, input.value);
  }
}

function syncSummaryFormulaBarWidth(barEl, summaryTable) {
  if (!barEl || !summaryTable) return;
  const host = summaryTable.closest("#ratioWrapHost") || document.getElementById("ratioWrapHost");
  const hostWidth = Number(host?.clientWidth || 0);
  const tableWidth = Number(summaryTable.getBoundingClientRect?.().width || 0);
  const frameWidth = Math.max(0, Math.ceil(tableWidth || hostWidth));
  if (!frameWidth) return;
  const viewportWidth = Math.max(0, Math.ceil(Math.min(frameWidth, hostWidth || frameWidth)));
  const contentWidth = Math.max(0, viewportWidth - SUMMARY_FORMULA_BAR_FRAME_INSET_PX);
  const contentOffset = Math.min(
    Math.max(0, Number(host?.scrollLeft || 0)),
    Math.max(0, frameWidth - contentWidth)
  );
  const px = `${frameWidth}px`;
  barEl.style.width = px;
  barEl.style.minWidth = px;
  barEl.style.maxWidth = px;
  barEl.style.setProperty(
    "--dfm-summary-formula-bar-content-width",
    `${contentWidth}px`
  );
  barEl.style.setProperty(
    "--dfm-summary-formula-bar-content-x",
    `${contentOffset}px`
  );
}

function scheduleSummaryFormulaBarResizeRefresh() {
  if (formulaBarResizeRaf) return;
  formulaBarResizeRaf = window.requestAnimationFrame(() => {
    formulaBarResizeRaf = 0;
    refreshSummaryFormulaBar();
  });
}

function wireSummaryFormulaBarResizeWatcher(summaryTable) {
  const host = summaryTable?.closest?.("#ratioWrapHost") || document.getElementById("ratioWrapHost");
  if (formulaBarScrollHost && formulaBarScrollHost !== host) {
    formulaBarScrollHost.removeEventListener("scroll", scheduleSummaryFormulaBarResizeRefresh);
    formulaBarScrollHost = null;
  }
  if (host && formulaBarScrollHost !== host) {
    host.addEventListener("scroll", scheduleSummaryFormulaBarResizeRefresh, { passive: true });
    formulaBarScrollHost = host;
  }
  if (host && window.ResizeObserver) {
    if (formulaBarResizeObserver?.target !== host) {
      formulaBarResizeObserver?.observer?.disconnect?.();
      const observer = new ResizeObserver(scheduleSummaryFormulaBarResizeRefresh);
      observer.observe(host);
      formulaBarResizeObserver = { observer, target: host };
    }
  }
  if (!formulaBarResizeWired) {
    formulaBarResizeWired = true;
    window.addEventListener("resize", scheduleSummaryFormulaBarResizeRefresh);
  }
}

function ensureSummaryFormulaBarEl(summaryTable) {
  let el = document.getElementById("dfmSummaryFormulaBar");
  if (!el) {
    el = document.createElement("div");
    el.id = "dfmSummaryFormulaBar";
    el.className = "dfmSummaryFormulaBar";
    const fxIcon = document.createElement("span");
    fxIcon.className = "dfmSummaryFormulaBarFxIcon";
    fxIcon.textContent = "fx";
    fxIcon.title = "Formula Bar";
    const label = document.createElement("span");
    label.id = "dfmSummaryFormulaBarLabelText";
    label.className = "dfmSummaryFormulaBarLabel";
    label.textContent = "f(x)";
    const input = document.createElement("input");
    input.id = "dfmSummaryFormulaBarInput";
    input.className = "dfmSummaryFormulaBarInput";
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    const xlBtn = document.createElement("button");
    xlBtn.id = "dfmSummaryFormulaBarXlLink";
    xlBtn.className = "dfmSummaryFormulaBarXlBtn";
    xlBtn.title = "Link to Excel cell";
    xlBtn.textContent = "XL";
    xlBtn.type = "button";
    const refreshBtn = document.createElement("button");
    refreshBtn.id = "dfmSummaryFormulaBarRefresh";
    refreshBtn.className = "dfmSummaryFormulaBarRefreshBtn";
    refreshBtn.title = "Refresh all Excel-linked values";
    refreshBtn.textContent = "\u21BB";
    refreshBtn.type = "button";
    const openBtn = document.createElement("button");
    openBtn.id = "dfmSummaryFormulaBarOpenXl";
    openBtn.className = "dfmSummaryFormulaBarOpenBtn";
    openBtn.title = "Open source workbook in Excel";
    openBtn.textContent = "\uD83D\uDCC2";
    openBtn.type = "button";
    const display = document.createElement("div");
    display.id = "dfmSummaryFormulaBarDisplay";
    display.className = "dfmSummaryFormulaBarDisplay";
    const content = document.createElement("div");
    content.className = "dfmSummaryFormulaBarContent";
    content.appendChild(fxIcon);
    content.appendChild(label);
    content.appendChild(input);
    content.appendChild(display);
    content.appendChild(xlBtn);
    content.appendChild(refreshBtn);
    content.appendChild(openBtn);
    el.appendChild(content);
  }
  if (el.dataset.wired !== "1") {
    const input = el.querySelector("#dfmSummaryFormulaBarInput");
    const FORMULA_PREFIX = "= ";
    const PREFIX_LEN = FORMULA_PREFIX.length; // 2
    input?.addEventListener("focus", () => {
      updateFormulaBarDisplayMode(el, true);
      // Ensure leading "= " prefix is present
      if (!input.value.startsWith(FORMULA_PREFIX)) {
        const body = input.value.replace(/^=\s*/, "");
        input.value = FORMULA_PREFIX + body;
      }
      const summaryTableEl = document.querySelector("#ratioWrap table.ratioSummaryTable");
      const rowId = String(input.dataset.rowId || "");
      const col = Number(input.dataset.col);
      if (!summaryTableEl || !rowId || !Number.isFinite(col) || col < 0) return;
      const cell = summaryTableEl.querySelector(`td.summaryCell[data-r="${rowId}"][data-col="${col}"]`);
      if (!cell) return;
      beginSummaryFormulaEditSession(summaryTableEl, cell, input, col);
      updateActiveSummaryFormulaReferenceUi(summaryTableEl);
      scrollSummaryFormulaInputToEnd(input);
    });
    // Prevent cursor from moving before the prefix
    input?.addEventListener("click", () => {
      if (input.selectionStart < PREFIX_LEN) input.setSelectionRange(PREFIX_LEN, PREFIX_LEN);
    });
    input?.addEventListener("input", () => {
      // Keep the leading "= " undeletable
      if (!input.value.startsWith(FORMULA_PREFIX)) {
        const cleaned = input.value.replace(/^=\s*/, "");
        input.value = FORMULA_PREFIX + cleaned;
        input.setSelectionRange(PREFIX_LEN, PREFIX_LEN);
      }
      const summaryTableEl = document.querySelector("#ratioWrap table.ratioSummaryTable");
      const rowId = String(input.dataset.rowId || "");
      const col = Number(input.dataset.col);
      if (summaryTableEl && rowId && Number.isFinite(col) && col >= 0) {
        const cell = summaryTableEl.querySelector(`td.summaryCell[data-r="${rowId}"][data-col="${col}"]`);
        if (cell) {
          beginSummaryFormulaEditSession(summaryTableEl, cell, input, col);
          updateSummaryFormulaBarForCell(cell);
          updateActiveSummaryFormulaReferenceUi(summaryTableEl);
        }
      }
    });
    input?.addEventListener("keydown", (e) => {
      // Prevent deleting the leading "= " prefix
      if (e.key === "Backspace" && input.selectionStart <= PREFIX_LEN && input.selectionEnd <= PREFIX_LEN) {
        e.preventDefault();
        return;
      }
      if (e.key === "Delete" && input.selectionStart < PREFIX_LEN && input.selectionEnd <= PREFIX_LEN) {
        e.preventDefault();
        return;
      }
      // Prevent selecting/replacing the prefix via Home or Ctrl+A
      if (e.key === "Home") {
        e.preventDefault();
        input.setSelectionRange(PREFIX_LEN, e.shiftKey ? input.selectionEnd : PREFIX_LEN);
        return;
      }
      if (e.key === "ArrowLeft" && input.selectionStart <= PREFIX_LEN && !e.shiftKey) {
        e.preventDefault();
        return;
      }
      if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        input.setSelectionRange(PREFIX_LEN, input.value.length);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const ok = commitSummaryFormulaInput(input);
        if (ok) {
          summaryFormulaBarSkipBlurCommit = true;
          input.blur();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelSummaryFormulaEditSession();
        summaryFormulaBarSkipBlurCommit = true;
        input.blur();
      }
    });
    input?.addEventListener("blur", () => {
      if (summaryFormulaBarSkipBlurCommit) {
        summaryFormulaBarSkipBlurCommit = false;
        updateFormulaBarDisplayMode(el, false);
        return;
      }
      const ok = commitSummaryFormulaInput(input);
      if (!ok) {
        input.focus();
        input.select();
        return;
      }
      updateFormulaBarDisplayMode(el, false);
    });
    const displayDiv = el.querySelector("#dfmSummaryFormulaBarDisplay");
    displayDiv?.addEventListener("click", () => {
      if (input && !input.disabled) {
        updateFormulaBarDisplayMode(el, true);
        input.focus();
      }
    });
    const xlBtn = el.querySelector("#dfmSummaryFormulaBarXlLink");
    xlBtn?.addEventListener("mousedown", () => {
      // Prevent blur from committing the formula when clicking XL button
      summaryFormulaBarSkipBlurCommit = true;
    });
    xlBtn?.addEventListener("click", () => {
      const rowId = String(input?.dataset.rowId || "");
      const col = Number(input?.dataset.col);
      if (!rowId || !Number.isFinite(col) || col < 0) return;
      enterXlLinkMode(el, input, rowId, col);
    });
    const refreshBtn = el.querySelector("#dfmSummaryFormulaBarRefresh");
    refreshBtn?.addEventListener("click", () => {
      refreshAllExcelLinks();
    });
    const openBtn = el.querySelector("#dfmSummaryFormulaBarOpenXl");
    openBtn?.addEventListener("click", async () => {
      // Find Excel ref in the current formula
      const raw = String(input?.value || "").trim();
      const refs = findExcelRefsInline(raw.startsWith("=") ? raw : "=" + raw);
      if (!refs.length) {
        alert("No Excel reference found in current formula.");
        return;
      }
      openBtn.disabled = true;
      try {
        const result = await openExcelWorkbook(refs[0].bookPath, refs[0].sheet, refs[0].cell);
        if (!result.ok) {
          alert(result.error || "Failed to open workbook.");
        }
      } catch (err) {
        alert(`Failed to open workbook: ${err.message || err}`);
      }
      openBtn.disabled = false;
    });
    el.dataset.wired = "1";
  }
  const parent = summaryTable?.parentElement;
  if (parent && el.parentElement !== parent) {
    parent.insertBefore(el, summaryTable);
  } else if (parent && summaryTable && el.nextElementSibling !== summaryTable) {
    parent.insertBefore(el, summaryTable);
  }
  wireSummaryFormulaBarResizeWatcher(summaryTable);
  return el;
}

function setStatusBarText(text) {
  // Status bar lives in the parent document (DFM runs in an iframe)
  const doc = window.parent?.document || document;
  const el = doc.getElementById("statusText") || doc.getElementById("statusBar");
  if (el) el.textContent = text || "";
}

// =============================================================================
// Excel Link Mode + Refresh
// =============================================================================

function exitXlLinkMode(barEl) {
  _xlLinkMode = false;
  if (_xlLinkFocusHandler) {
    window.removeEventListener("focus", _xlLinkFocusHandler);
    _xlLinkFocusHandler = null;
  }
  if (_xlLinkEscHandler) {
    document.removeEventListener("keydown", _xlLinkEscHandler);
    _xlLinkEscHandler = null;
  }
  if (_xlLinkAbortController) {
    _xlLinkAbortController.abort();
    _xlLinkAbortController = null;
  }
  if (barEl) barEl.classList.remove("xlLinkMode");
  const input = barEl?.querySelector?.("#dfmSummaryFormulaBarInput");
  if (input && input.placeholder === "Select a cell in Excel, press Enter to confirm...") {
    input.placeholder = "Enter value or formula";
  }
}

function enterXlLinkMode(barEl, inputEl, rowId, col) {
  if (_xlLinkMode) {
    exitXlLinkMode(barEl);
    return;
  }
  _xlLinkMode = true;
  barEl.classList.add("xlLinkMode");
  const savedValue = inputEl.value;
  inputEl.value = "";
  inputEl.placeholder = "Select a cell in Excel, press Enter to confirm...";
  inputEl.disabled = true;

  _xlLinkEscHandler = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      exitXlLinkMode(barEl);
      inputEl.disabled = false;
      inputEl.placeholder = "Enter value or formula";
      inputEl.value = savedValue;
    }
  };
  document.addEventListener("keydown", _xlLinkEscHandler);

  // Also support the old focus-return flow as fallback
  _xlLinkFocusHandler = () => {
    // If the polling already resolved, ignore
    if (!_xlLinkMode) return;
  };
  window.addEventListener("focus", _xlLinkFocusHandler);

  // Start polling: wait for Enter key in Excel (cell moves)
  _xlLinkAbortController = new AbortController();
  const abortSignal = _xlLinkAbortController.signal;
  (async () => {
    try {
      const result = await excelWaitForEnter();
      if (abortSignal.aborted) return;
      exitXlLinkMode(barEl);
      inputEl.disabled = false;
      inputEl.placeholder = "Enter value or formula";
      if (!result.ok) {
        inputEl.value = savedValue;
        alert(result.error || "Could not read from Excel.");
        return;
      }
      if (!result.confirmed) {
        // Timeout — no Enter pressed within 30s, restore previous value
        inputEl.value = savedValue;
        return;
      }
      // Populate formula bar with Excel ref and enter edit mode
      const ref = formatExcelRef(result.book_path, result.sheet, result.cell);
      inputEl.value = ref;
      inputEl.dataset.rowId = rowId;
      inputEl.dataset.col = String(col);
      // Bring our Electron window to front and focus formula bar in edit mode
      if (window.ADAHost?.focusWindow) await window.ADAHost.focusWindow();
      updateFormulaBarDisplayMode(barEl, true);
      inputEl.focus();
      scrollSummaryFormulaInputToEnd(inputEl);
      // Start an edit session so Enter commits / Escape cancels
      const summaryTableEl = document.querySelector("#ratioWrap table.ratioSummaryTable");
      if (summaryTableEl) {
        const cell = summaryTableEl.querySelector(`td.summaryCell[data-r="${rowId}"][data-col="${col}"]`);
        if (cell) beginSummaryFormulaEditSession(summaryTableEl, cell, inputEl, col);
      }
    } catch (err) {
      if (abortSignal.aborted) return;
      exitXlLinkMode(barEl);
      inputEl.disabled = false;
      inputEl.placeholder = "Enter value or formula";
      inputEl.value = savedValue;
    }
  })();
}

async function commitExcelFormulaAsync(inputEl, rowId, col, raw) {
  const prevDisabled = inputEl.disabled;
  inputEl.disabled = true;
  try {
    const summaryTable = document.querySelector("#ratioWrap table.ratioSummaryTable");
    const selectedTable = document.querySelector("#ratioWrap table.ratioSelectedTable");
    const refValues = summaryTable ? buildSummaryReferenceValues(summaryTable, col) : new Map();

    const result = await resolveExcelRefsInExpression(raw, refValues);
    if (!result.ok) {
      if (result.error) {
        alert(result.error);
      } else {
        alert("Enter a number > 0, or a formula like =\"Simple - 5\"*2.");
      }
      inputEl.disabled = prevDisabled;
      inputEl.focus();
      return;
    }
    const nextValue = roundRatio(result.value, 6);
    setUserEntryCellEntry(rowId, col, raw, nextValue);
    const cell = summaryTable?.querySelector(`td.summaryCell[data-r="${rowId}"][data-col="${col}"]`);
    if (cell) {
      setUserEntryCellDisplayValue(cell, nextValue);
      cell.classList.add("excelLinked");
      cell.title = raw;
    }
    if (selectedTable && summaryTable) ensureSelectedRowValues(summaryTable, selectedTable);
    applyUserEntryReferenceHighlights(summaryTable);
    clearSummaryReferenceUi(summaryTable);
    summaryFormulaEditState = null;
    updateSummaryFormulaBarForCell(cell);
    _onRatioStateMutated();
  } catch (err) {
    alert(`Failed to evaluate Excel formula: ${err.message || err}`);
    inputEl.disabled = prevDisabled;
    inputEl.focus();
  }
}

export async function refreshAllExcelLinks() {
  // Collect all cells that contain Excel refs (standalone or within formulas)
  const batchItems = [];
  const batchMeta = [];  // each entry: { rowId, col, inputRaw, refMatch, batchIdx }
  const cellsToRefresh = []; // { rowId, col, inputRaw }

  for (const cfg of summaryRowConfigs) {
    if (!isUserEntryConfig(cfg)) continue;
    const inputs = cfg.inputs || [];
    for (let col = 0; col < inputs.length; col++) {
      const inputRaw = String(inputs[col] || "").trim();
      if (!containsExcelRef(inputRaw)) continue;
      // Find all Excel refs in this input (could be multiple in a formula)
      const inlineRefs = findExcelRefsInline(inputRaw.startsWith("=") ? inputRaw : "=" + inputRaw);
      for (const ref of inlineRefs) {
        batchItems.push({ book_path: ref.bookPath, sheet: ref.sheet, cell: ref.cell });
        batchMeta.push({ rowId: cfg.id, col, inputRaw, refMatch: ref.match });
      }
      cellsToRefresh.push({ rowId: cfg.id, col, inputRaw });
    }
  }
  if (!batchItems.length) return;

  setStatusBarText("Refreshing linked Excel values...");
  const result = await readExcelCellsBatch(batchItems);
  if (!result.ok) {
    setStatusBarText("Excel refresh failed.");
    alert("Batch refresh failed.");
    return;
  }

  // Build a map from refMatch string -> resolved numeric value
  const resolvedMap = new Map();
  for (let i = 0; i < result.results.length; i++) {
    const r = result.results[i];
    if (r.ok && Number.isFinite(r.value)) {
      resolvedMap.set(batchMeta[i].refMatch, r.value);
      _xlCellValueCache.set(batchMeta[i].refMatch, r.value);
    }
  }

  let anyChanged = false;
  const summaryTable = document.querySelector("#ratioWrap table.ratioSummaryTable");
  const selectedTable = document.querySelector("#ratioWrap table.ratioSelectedTable");

  for (const { rowId, col, inputRaw } of cellsToRefresh) {
    // Substitute all resolved Excel refs in the expression
    let expr = inputRaw.startsWith("=") ? inputRaw : "=" + inputRaw;
    let allResolved = true;
    const refs = findExcelRefsInline(expr);
    for (const ref of refs) {
      if (resolvedMap.has(ref.match)) {
        expr = expr.split(ref.match).join(String(resolvedMap.get(ref.match)));
      } else {
        allResolved = false;
      }
    }
    if (!allResolved) continue;

    // Evaluate the substituted expression
    const refValues = summaryTable ? buildSummaryReferenceValues(summaryTable, col) : new Map();
    const parsed = evaluateSimpleMathExpression(expr, refValues);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;

    const nextValue = roundRatio(parsed, 6);
    const cfg = summaryRowMap.get(rowId);
    if (!cfg) continue;
    const currentValue = getUserEntryValueForCol(cfg, col);
    if (Math.abs(currentValue - nextValue) < 1e-10) continue;
    setUserEntryCellEntry(rowId, col, inputRaw, nextValue);
    anyChanged = true;
    const cell = summaryTable?.querySelector(`td.summaryCell[data-r="${rowId}"][data-col="${col}"]`);
    if (cell) {
      setUserEntryCellDisplayValue(cell, nextValue);
      cell.classList.add("excelLinked");
      cell.title = inputRaw;
    }
  }

  if (anyChanged && summaryTable && selectedTable) {
    ensureSelectedRowValues(summaryTable, selectedTable);
    applyUserEntryReferenceHighlights(summaryTable);
    _onRatioStateMutated();
  }
  const count = cellsToRefresh.length;
  setStatusBarText(anyChanged
    ? `Excel refresh: ${count} linked cell${count > 1 ? "s" : ""} updated.`
    : `Excel refresh: ${count} linked cell${count > 1 ? "s" : ""} unchanged.`);
}

function hideSummaryFormulaBar() {
  const el = document.getElementById("dfmSummaryFormulaBar");
  if (el) {
    el.classList.remove("fxVisible");
  }
}

function setUserEntryCellDisplayValue(cell, value) {
  if (!cell) return;
  cell.textContent = formatRatio(roundRatio(value, 6), getDfmDecimalPlaces());
  cell.classList.remove("na");
  cell.classList.remove("ratioPlaceholder");
  cell.classList.remove("strike");
  cell.classList.remove("excelLinked");
  cell.classList.add("userEntryEditable");
  cell.title = "";
}

function commitUserEntryArrayFormula(summaryTable, selectedTable, rowId, startCol, raw) {
  const parsedArray = parseSummaryArrayFormula(raw);
  if (!parsedArray) return { handled: false, ok: true };
  if (!parsedArray.ok) return { handled: true, ok: false, error: parsedArray.error };
  if (containsExcelRef(raw)) {
    return {
      handled: true,
      ok: false,
      error: "Array formulas currently support numbers and DFM row-reference math, but not Excel cell links inside the array.",
    };
  }

  const row = summaryTable?.querySelector(`tr[data-row-id="${CSS.escape(String(rowId))}"]`);
  const availableCells = Array.from(row?.querySelectorAll("td.summaryCell[data-col]") || [])
    .map((cell) => ({ cell, col: Number(cell.dataset.col) }))
    .filter((item) => Number.isFinite(item.col) && item.col >= startCol)
    .sort((a, b) => a.col - b.col);
  const applyCount = Math.min(parsedArray.expressions.length, availableCells.length);
  if (applyCount <= 0) {
    return { handled: true, ok: false, error: "Array formula has no cells available to fill." };
  }

  const nextEntries = [];
  for (let i = 0; i < applyCount; i++) {
    const targetCol = availableCells[i].col;
    const expr = String(parsedArray.expressions[i] || "").trim();
    const refValues = buildSummaryReferenceValues(summaryTable, targetCol);
    const value = evaluateSimpleMathExpression(expr, refValues);
    if (!Number.isFinite(value) || value <= 0) {
      return {
        handled: true,
        ok: false,
        error: "Each array formula item must evaluate to a number > 0.",
      };
    }
    const nextValue = roundRatio(value, 6);
    nextEntries.push({
      cell: availableCells[i].cell,
      col: targetCol,
      value: nextValue,
      input: i === 0 ? String(raw || "").trim() : String(nextValue),
    });
  }

  nextEntries.forEach((entry) => {
    setUserEntryCellEntry(rowId, entry.col, entry.input, entry.value, { persist: false });
    setUserEntryCellDisplayValue(entry.cell, entry.value);
    selectedSummaryByCol.set(entry.col, String(rowId));
    summaryTable.querySelectorAll(`td.summaryCell[data-col="${entry.col}"]`)
      .forEach((el) => el.classList.remove("ratioSelectedCell"));
    entry.cell.classList.add("ratioSelectedCell");
  });
  persistUserEntryRowsFromState();

  const firstCell = nextEntries[0]?.cell || null;
  summaryTable.querySelectorAll("td.summaryCell.summaryActiveCell")
    .forEach((el) => el.classList.remove("summaryActiveCell"));
  if (firstCell) {
    firstCell.classList.add("summaryActiveCell");
    summaryCopySelection?.selectCell?.(firstCell, false);
    summaryActiveCellState = { rowId: String(rowId), col: nextEntries[0].col };
  }
  if (selectedTable) ensureSelectedRowValues(summaryTable, selectedTable);
  applyUserEntryReferenceHighlights(summaryTable);
  clearSummaryReferenceUi(summaryTable);
  summaryFormulaEditState = null;
  updateSummaryFormulaBarForCell(firstCell);
  _onRatioStateMutated();
  return { handled: true, ok: true };
}

function commitSummaryFormulaInput(inputEl) {
  const summaryTable = document.querySelector("#ratioWrap table.ratioSummaryTable");
  const selectedTable = document.querySelector("#ratioWrap table.ratioSelectedTable");
  if (!inputEl || !summaryTable) return true;
  const rowId = String(inputEl.dataset.rowId || "");
  const col = Number(inputEl.dataset.col);
  if (!rowId || !Number.isFinite(col) || col < 0) return true;
  const cfg = summaryRowMap.get(rowId);
  if (!cfg || !isUserEntryConfig(cfg)) return true;
  const raw = String(inputEl.value || "").trim();
  const arrayCommit = commitUserEntryArrayFormula(summaryTable, selectedTable, rowId, col, raw);
  if (arrayCommit.handled) {
    if (!arrayCommit.ok) alert(arrayCommit.error || "Could not apply array formula.");
    return !!arrayCommit.ok;
  }
  // Check if expression contains any Excel references (standalone or inline)
  if (containsExcelRef(raw)) {
    commitExcelFormulaAsync(inputEl, rowId, col, raw);
    return true;
  }
  const refValues = buildSummaryReferenceValues(summaryTable, col);
  const parsed = raw ? evaluateSimpleMathExpression(raw, refValues) : 1;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    alert("Enter a number > 0, or a formula like =\"Simple - 5\"*2.");
    return false;
  }
  const nextValue = roundRatio(parsed, 6);
  setUserEntryCellEntry(rowId, col, raw || String(nextValue), nextValue);
  const cell = summaryTable.querySelector(`td.summaryCell[data-r="${rowId}"][data-col="${col}"]`);
  if (cell) setUserEntryCellDisplayValue(cell, nextValue);
  if (selectedTable) ensureSelectedRowValues(summaryTable, selectedTable);
  applyUserEntryReferenceHighlights(summaryTable);
  clearSummaryReferenceUi(summaryTable);
  summaryFormulaEditState = null;
  updateSummaryFormulaBarForCell(cell);
  _onRatioStateMutated();
  return true;
}

function updateSummaryFormulaBarForCell(cell) {
  const summaryTable =
    cell?.closest?.("table.ratioSummaryTable") ||
    document.querySelector("#ratioWrap table.ratioSummaryTable");
  if (!summaryTable) {
    hideSummaryFormulaBar();
    return;
  }
  if (!summaryTableHasUserEntryRows(summaryTable)) {
    hideSummaryFormulaBar();
    return;
  }

  const el = ensureSummaryFormulaBarEl(summaryTable);
  const inputEl = el.querySelector("#dfmSummaryFormulaBarInput");
  let inputRaw = "";
  let targetCell = cell;
  if (!targetCell || !summaryTable.contains(targetCell)) {
    const stateCell = summaryTable.querySelector(
      `td.summaryCell[data-r="${summaryActiveCellState.rowId}"][data-col="${summaryActiveCellState.col}"]`
    );
    targetCell = stateCell || null;
  }
  if (targetCell) {
    const rowId = String(targetCell.dataset.r || "");
    const col = Number(targetCell.dataset.col);
    if (rowId && Number.isFinite(col) && col >= 0) {
      const cfg = summaryRowMap.get(rowId);
      if (cfg && isUserEntryConfig(cfg)) {
        inputRaw = String(getUserEntryInputForCol(cfg, col) || "").trim();
        const labelEl = el.querySelector("#dfmSummaryFormulaBarLabelText");
        if (labelEl) {
          const rowLabel = String(cfg.label || cfg.id || "f(x)");
          labelEl.textContent = rowLabel;
        }
        if (inputEl) {
          const inputHasFocus = document.activeElement === inputEl;
          const sameTarget =
            String(inputEl.dataset.rowId || "") === rowId &&
            Number(inputEl.dataset.col) === col;
          if (!inputHasFocus || !sameTarget) {
            const body = (inputRaw || "").replace(/^=\s*/, "");
            inputEl.value = "= " + body;
            scrollSummaryFormulaInputToEnd(inputEl);
          }
          inputEl.dataset.rowId = rowId;
          inputEl.dataset.col = String(col);
          inputEl.disabled = false;
          inputEl.placeholder = "Enter value or formula";
        }
      } else {
        hideSummaryFormulaBar();
        return;
      }
    }
  } else {
    hideSummaryFormulaBar();
    return;
  }

  el.classList.add("fxVisible");
  const isEditing = inputEl && document.activeElement === inputEl;
  updateFormulaBarDisplayMode(el, isEditing);
  syncSummaryFormulaBarWidth(el, summaryTable);
  window.requestAnimationFrame(() => syncSummaryFormulaBarWidth(el, summaryTable));
  el.style.left = "";
  el.style.top = "";
  el.style.transform = "";
}

function refreshSummaryFormulaBar() {
  updateSummaryFormulaBarForCell(null);
}

function clearSummaryReferenceUi(summaryTable) {
  if (!summaryTable) return;
  summaryTable.querySelectorAll("td.summaryCell.summaryRefHover")
    .forEach((el) => el.classList.remove("summaryRefHover"));
  summaryTable.querySelectorAll("td.summaryCell.summaryRefCandidate")
    .forEach((el) => el.classList.remove("summaryRefCandidate"));
  summaryTable.querySelectorAll("td.summaryCell.summaryFormulaActiveRefCell")
    .forEach((el) => el.classList.remove("summaryFormulaActiveRefCell"));
  summaryTable.querySelectorAll("td.summaryCell.summaryFormulaRefDragTarget")
    .forEach((el) => el.classList.remove("summaryFormulaRefDragTarget"));
}

function buildSummaryReferenceValues(summaryTable, col) {
  const out = new Map();
  if (!summaryTable || !Number.isFinite(col) || col < 0) return out;
  const rows = Array.from(summaryTable.querySelectorAll("tr[data-row-id]"));
  rows.forEach((row) => {
    const rowId = String(row.dataset.rowId || "");
    if (!rowId) return;
    const th = row.querySelector("th");
    const label = String(th?.textContent || "").trim();
    if (!label) return;
    const cfg = summaryRowMap.get(rowId);
    let v = null;
    if (cfg && isUserEntryConfig(cfg)) {
      v = getUserEntryValueForCol(cfg, col);
    } else {
      const td = row.querySelector(`td.summaryCell[data-col="${col}"]`);
      const raw = String(td?.textContent || "").trim();
      const n = Number(raw);
      if (Number.isFinite(n)) v = n;
    }
    if (Number.isFinite(v)) out.set(label, Number(v));
  });
  return out;
}

function insertAtInputCursor(input, text) {
  if (!input) return;
  const start = Number.isFinite(input.selectionStart) ? input.selectionStart : input.value.length;
  const end = Number.isFinite(input.selectionEnd) ? input.selectionEnd : input.value.length;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  input.value = `${before}${text}${after}`;
  const nextPos = start + text.length;
  input.setSelectionRange(nextPos, nextPos);
}

function beginSummaryFormulaEditSession(summaryTable, cell, input, col) {
  if (!summaryTable || !cell || !input) return;
  if (!Number.isFinite(col) || col < 0) return;
  const rowId = String(cell.dataset.r || "");
  if (!rowId) return;
  const cfg = summaryRowMap.get(rowId);
  const fallbackOriginal = cfg && isUserEntryConfig(cfg)
    ? String(getUserEntryInputForCol(cfg, col) || "").trim()
    : "";
  const keepOriginal =
    summaryFormulaEditState &&
    summaryFormulaEditState.summaryTable === summaryTable &&
    summaryFormulaEditState.cell === cell &&
    Number(summaryFormulaEditState.col) === col
      ? String(summaryFormulaEditState.originalInput ?? fallbackOriginal)
      : fallbackOriginal;
  summaryFormulaEditState = {
    summaryTable,
    cell,
    input,
    col,
    rowId,
    originalInput: keepOriginal,
  };
  updateActiveSummaryFormulaReferenceUi(summaryTable);
}

function cancelSummaryFormulaEditSession() {
  const state = summaryFormulaEditState;
  if (!state) return;
  const { summaryTable, cell, input, originalInput } = state;
  if (input && document.body.contains(input)) {
    input.value = String(originalInput ?? "");
  }
  clearSummaryReferenceUi(summaryTable);
  summaryFormulaEditState = null;
  updateSummaryFormulaBarForCell(cell);
}

function setUserEntryCellEntry(rowId, col, inputRaw, value, options = {}) {
  const persist = options?.persist !== false;
  if (!rowId || !Number.isFinite(col) || col < 0) return false;
  const cfg = summaryRowMap.get(String(rowId));
  if (!cfg || !isUserEntryConfig(cfg)) return false;

  const nextInput = String(inputRaw ?? "").trim() || "1";
  const nextValue = sanitizeUserEntryValue(value);
  const colCount = getCurrentRatioColumnCount();
  const values = normalizeUserEntryValues(cfg.values, Math.max(colCount, col + 1));
  const inputs = normalizeUserEntryInputs(cfg.inputs ?? cfg.formulas, values, Math.max(colCount, col + 1));
  values[col] = nextValue;
  inputs[col] = nextInput;
  cfg.values = values;
  cfg.inputs = inputs;
  if (Object.prototype.hasOwnProperty.call(cfg, "formulas")) delete cfg.formulas;

  if (!persist) return true;
  const cfgKey = getSummaryConfigKey();
  if (!cfgKey) return true;
  const customRows = loadCustomSummaryRows(cfgKey);
  const idx = customRows.findIndex((row) => String(row?.id || "") === String(rowId));
  if (idx < 0) return true;
  const { formulas: _legacyFormulas, ...baseRow } = customRows[idx] || {};
  customRows[idx] = {
    ...baseRow,
    averageType: "user_entry",
    base: "simple",
    periods: "all",
    exclude: 0,
    values,
    inputs,
  };
  saveCustomSummaryRows(cfgKey, customRows);
  return true;
}

function persistUserEntryRowsFromState() {
  const cfgKey = getSummaryConfigKey();
  if (!cfgKey) return;
  const customRows = loadCustomSummaryRows(cfgKey);
  if (!Array.isArray(customRows) || !customRows.length) return;
  let changed = false;
  const colCount = getCurrentRatioColumnCount();
  const nextRows = customRows.map((row) => {
    const rowId = String(row?.id || "");
    const cfg = summaryRowMap.get(rowId);
    if (!cfg || !isUserEntryConfig(cfg)) return row;
    const values = normalizeUserEntryValues(cfg.values, colCount);
    const inputs = normalizeUserEntryInputs(cfg.inputs ?? cfg.formulas, values, colCount);
    const { formulas: _legacyFormulas, ...baseRow } = row || {};
    const nextRow = {
      ...baseRow,
      averageType: "user_entry",
      base: "simple",
      periods: "all",
      exclude: 0,
      values,
      inputs,
    };
    if (!changed) changed = JSON.stringify(row) !== JSON.stringify(nextRow);
    return nextRow;
  });
  if (changed) saveCustomSummaryRows(cfgKey, nextRows);
}

function computeSummaryRowValueForColumn(model, col, rowId, cache, visiting, labelToId, lastCol) {
  const key = String(rowId || "");
  if (!key) return 1;
  if (cache.has(key)) return cache.get(key);
  if (visiting.has(key)) return 1;
  if (col >= lastCol) {
    cache.set(key, 1);
    return 1;
  }

  const cfg = summaryRowMap.get(key);
  if (!cfg) {
    cache.set(key, 1);
    return 1;
  }

  let value = 1;
  if (isUserEntryConfig(cfg)) {
    const inputRaw = String(getUserEntryInputForCol(cfg, col) || "").trim();
    // Determine which labels are actually referenced in this formula
    const allLabels = Array.from(labelToId.keys());
    const referencedLabels = findReferencedLabels(inputRaw, allLabels);

    if (containsExcelRef(inputRaw)) {
      // Substitute Excel refs with cached values, then evaluate with current row refs
      let expr = inputRaw.startsWith("=") ? inputRaw : "=" + inputRaw;
      const xlRefs = findExcelRefsInline(expr);
      let allCached = true;
      for (const ref of xlRefs) {
        if (_xlCellValueCache.has(ref.match)) {
          expr = expr.split(ref.match).join(String(_xlCellValueCache.get(ref.match)));
        } else {
          allCached = false;
        }
      }
      if (allCached) {
        visiting.add(key);
        const refValues = new Map();
        for (const label of referencedLabels) {
          const depId = labelToId.get(label);
          if (!depId || String(depId) === key) continue;
          const depValue = computeSummaryRowValueForColumn(model, col, depId, cache, visiting, labelToId, lastCol);
          if (Number.isFinite(depValue)) refValues.set(label, depValue);
        }
        visiting.delete(key);
        const parsed = evaluateSimpleMathExpression(expr, refValues);
        value = Number.isFinite(parsed) && parsed > 0 ? roundRatio(parsed, 6) : sanitizeUserEntryValue(getUserEntryValueForCol(cfg, col));
      } else {
        // No cached Excel values yet; keep the stored value
        value = sanitizeUserEntryValue(getUserEntryValueForCol(cfg, col));
      }
    } else {
      visiting.add(key);
      const refValues = new Map();
      for (const label of referencedLabels) {
        const depId = labelToId.get(label);
        if (!depId || String(depId) === key) continue;
        const depValue = computeSummaryRowValueForColumn(model, col, depId, cache, visiting, labelToId, lastCol);
        if (Number.isFinite(depValue)) refValues.set(label, depValue);
      }
      visiting.delete(key);
      const parsed = inputRaw ? evaluateSimpleMathExpression(inputRaw, refValues) : 1;
      if (Number.isFinite(parsed) && parsed > 0) {
        value = roundRatio(parsed, 6);
      } else {
        // If evaluation failed (e.g. dependency has Excel ref not yet cached),
        // keep the current stored value instead of resetting to 1
        const stored = sanitizeUserEntryValue(getUserEntryValueForCol(cfg, col));
        value = stored;
      }
    }
  } else {
    const excluded = buildExcludedSetForColumn(model, col, cfg, ratioStrikeSet);
    const summary = computeAverageForColumn(model, col, excluded, cfg);
    if (summary.totalValid > 0 && summary.totalIncluded === 0) {
      value = 1;
    } else {
      const isVolume = String(cfg.base || "volume").toLowerCase() === "volume";
      const hasValue =
        summary.value !== null &&
        (isVolume ? summary.sumA : summary.totalIncluded > 0);
      value = hasValue ? roundRatio(summary.value, 6) : 1;
    }
  }

  cache.set(key, value);
  return value;
}

export function recalculateUserEntryDependencies() {
  if (summaryFormulaEditState?.input && document.body.contains(summaryFormulaEditState.input)) {
    return false;
  }
  const model = state.model;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) return false;
  const rows = Array.isArray(summaryRowConfigs) ? summaryRowConfigs : [];
  const userRows = rows.filter((cfg) => isUserEntryConfig(cfg));
  if (!userRows.length) return false;

  const devs = getEffectiveDevLabelsForModel(model);
  const colCount = getRatioHeaderLabels(devs).length;
  const lastCol = Math.max(0, devs.length - 1);
  const labelToId = new Map(
    rows.map((cfg) => [String(cfg?.label || cfg?.id || ""), String(cfg?.id || "")]).filter(([k, v]) => k && v)
  );
  let changed = false;

  for (let col = 0; col < colCount; col++) {
    const cache = new Map();
    const visiting = new Set();
    rows.forEach((cfg) => {
      const rowId = String(cfg?.id || "");
      if (!rowId) return;
      computeSummaryRowValueForColumn(model, col, rowId, cache, visiting, labelToId, lastCol);
    });
    userRows.forEach((cfg) => {
      const rowId = String(cfg?.id || "");
      if (!rowId) return;
      const nextValue = sanitizeUserEntryValue(cache.get(rowId));
      const currentValue = sanitizeUserEntryValue(getUserEntryValueForCol(cfg, col));
      const inputRaw = String(getUserEntryInputForCol(cfg, col) || "").trim() || String(currentValue);
      if (Math.abs(nextValue - currentValue) > 1e-12) changed = true;
      setUserEntryCellEntry(rowId, col, inputRaw, nextValue, { persist: false });
    });
  }

  if (changed) persistUserEntryRowsFromState();
  return changed;
}

let _renameModalCallback = null;

function showRenameModal(currentName, onCommit) {
  const modal = document.getElementById("dfmRenameModal");
  if (!modal) return;
  const nameInput = modal.querySelector("#dfmRenameName");
  if (nameInput) {
    nameInput.value = currentName || "";
  }
  _renameModalCallback = onCommit;
  modal.classList.add("open");
  if (!modal.dataset.wired) {
    modal.dataset.wired = "1";
    const okBtn = modal.querySelector("#dfmRenameOk");
    const cancelBtn = modal.querySelector("#dfmRenameCancel");
    const backdrop = modal.querySelector(".dfmModalBackdrop");
    const commitRename = () => {
      const input = modal.querySelector("#dfmRenameName");
      const trimmed = String(input?.value || "").trim();
      if (!trimmed) return;
      if (_renameModalCallback) {
        const ok = _renameModalCallback(trimmed);
        if (ok === false) return;
      }
      _renameModalCallback = null;
      modal.classList.remove("open");
    };
    const cancelRename = () => {
      _renameModalCallback = null;
      modal.classList.remove("open");
    };
    okBtn?.addEventListener("click", commitRename);
    cancelBtn?.addEventListener("click", cancelRename);
    backdrop?.addEventListener("click", cancelRename);
    nameInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commitRename(); }
      else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
    });
  }
  window.requestAnimationFrame(() => {
    if (nameInput) { nameInput.focus(); nameInput.select(); }
  });
}

function hideAvgModal() {
  const modal = getAvgModalEl();
  if (modal) modal.classList.remove("open");
}

function showAvgModal() {
  const modal = getAvgModalEl();
  if (!modal) return;
  const nameInput = modal.querySelector("#dfmAvgName");
  const typeSelect = modal.querySelector("#dfmAvgType");
  const baseSelect = modal.querySelector("#dfmAvgBase");
  const periodInput = modal.querySelector("#dfmAvgPeriods");
  const excludeInput = modal.querySelector("#dfmAvgExclude");
  if (nameInput) nameInput.value = "User Entry";
  if (typeSelect) typeSelect.value = "custom";
  if (baseSelect) baseSelect.value = "simple";
  if (periodInput) periodInput.value = "";
  if (excludeInput) excludeInput.value = "None";
  const isUserEntry = normalizeAverageType(typeSelect?.value) === "user_entry";
  [baseSelect, periodInput, excludeInput].forEach((el) => {
    if (el) el.disabled = isUserEntry;
  });
  [baseSelect, periodInput, excludeInput].forEach((el) => {
    const field = el?.closest?.(".dfmModalField");
    if (field) field.classList.toggle("disabled", isUserEntry);
  });
  modal.classList.add("open");
}

function computeAutoName(base, periodsValue) {
  const label = base ? base.charAt(0).toUpperCase() + base.slice(1) : "User Entry";
  const p = String(periodsValue || "all").toLowerCase();
  const suffix = p === "all" ? "all" : p;
  return `${label} - ${suffix}`;
}

function computeAutoNameWithExclude(base, periodsValue, excludeValue) {
  const name = computeAutoName(base, periodsValue);
  const excludeCount = parseExcludeValue(excludeValue);
  if (excludeCount <= 0) return name;
  if (excludeCount === 1) return `${name} Ex hi/lo`;
  return `${name} Ex hi/lo x${excludeCount}`;
}

function wireAvgModal() {
  const modal = getAvgModalEl();
  if (!modal || modal.dataset.wired === "1") return;
  modal.dataset.wired = "1";

  const nameInput = modal.querySelector("#dfmAvgName");
  const typeSelect = modal.querySelector("#dfmAvgType");
  const baseSelect = modal.querySelector("#dfmAvgBase");
  const periodInput = modal.querySelector("#dfmAvgPeriods");
  const excludeInput = modal.querySelector("#dfmAvgExclude");
  const addBtn = modal.querySelector("#dfmAvgAdd");
  const cancelBtn = modal.querySelector("#dfmAvgCancel");

  const syncName = () => {
    if (normalizeAverageType(typeSelect?.value) === "user_entry") return;
    const base = baseSelect?.value || "User Entry";
    const periods = parsePeriodsValue(periodInput?.value);
    const excludeCount = parseExcludeValue(excludeInput?.value);
    if (nameInput) nameInput.value = computeAutoNameWithExclude(base, periods, excludeCount);
  };

  const applyTypeState = () => {
    const isUserEntry = normalizeAverageType(typeSelect?.value) === "user_entry";
    [baseSelect, periodInput, excludeInput].forEach((el) => {
      if (el) el.disabled = isUserEntry;
    });
    [baseSelect, periodInput, excludeInput].forEach((el) => {
      const field = el?.closest?.(".dfmModalField");
      if (field) field.classList.toggle("disabled", isUserEntry);
    });
    if (isUserEntry) {
      if (baseSelect) baseSelect.value = "simple";
      if (periodInput) periodInput.value = "";
      if (excludeInput) excludeInput.value = "None";
      if (nameInput && !String(nameInput.value || "").trim()) nameInput.value = "User Entry";
      return;
    }
    syncName();
  };

  const normalizePeriodsInput = () => {
    if (!periodInput) return;
    const raw = String(periodInput.value || "");
    if (!raw) return;
    if (/^all$/i.test(raw.trim())) {
      periodInput.value = "";
      return;
    }
    const digits = raw.replace(/[^\d]/g, "");
    if (digits !== raw) periodInput.value = digits;
  };

  const applyPeriodDelta = (dir) => {
    if (!periodInput) return;
    const raw = String(periodInput.value || "").trim();
    if (!raw) {
      periodInput.value = "2";
    } else {
      const current = parseInt(raw, 10);
      const base = Number.isFinite(current) ? current : 2;
      const next = Math.max(2, base + dir);
      periodInput.value = String(next);
    }
    syncName();
  };

  const normalizeExcludeInput = () => {
    if (!excludeInput) return;
    const raw = String(excludeInput.value || "").trim();
    if (!raw) return;
    if (/^none$/i.test(raw)) {
      excludeInput.value = "None";
      return;
    }
    const digits = raw.replace(/[^\d]/g, "");
    if (digits !== raw) excludeInput.value = digits;
  };

  typeSelect?.addEventListener("change", applyTypeState);
  baseSelect?.addEventListener("change", syncName);
  periodInput?.addEventListener("input", () => {
    normalizePeriodsInput();
    syncName();
  });
  periodInput?.addEventListener("change", () => {
    normalizePeriodsInput();
    syncName();
  });
  excludeInput?.addEventListener("input", () => {
    normalizeExcludeInput();
    syncName();
  });
  excludeInput?.addEventListener("change", () => {
    normalizeExcludeInput();
    syncName();
  });
  periodInput?.addEventListener("wheel", (e) => {
    if (periodInput.disabled) return;
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    applyPeriodDelta(dir);
  }, { passive: false });

  applyTypeState();

  cancelBtn?.addEventListener("click", () => hideAvgModal());
  modal.querySelector(".dfmModalBackdrop")?.addEventListener("click", () => hideAvgModal());

  addBtn?.addEventListener("click", () => {
    const averageType = normalizeAverageType(typeSelect?.value);
    const isUserEntry = averageType === "user_entry";
    const base = isUserEntry ? "simple" : (baseSelect?.value || "simple").toLowerCase();
    const periods = isUserEntry ? "all" : parsePeriodsValue(periodInput?.value);
    const excludeCount = isUserEntry ? 0 : parseExcludeValue(excludeInput?.value);
    const fallbackName = isUserEntry ? "User Entry" : computeAutoNameWithExclude(base, periods, excludeCount);
    const label = nameInput?.value?.trim() || fallbackName;
    const cfgKey = getSummaryConfigKey();
    if (!cfgKey) {
      hideAvgModal();
      return;
    }
    const customRows = summaryRowConfigs.length
      ? summaryRowConfigs.map((row) => ({ ...row }))
      : BASE_SUMMARY_ROWS.map((row) => ({ ...row }));
    const normalizedLabel = label.trim();
    const nameExists = summaryRowConfigs.some((row) =>
      String(row.label || "").trim().toLowerCase() === normalizedLabel.toLowerCase()
    );
    if (nameExists) {
      alert("Average formula name already exists.");
      return;
    }
    const nextRow = {
      id: `custom_${Date.now()}`,
      label,
      averageType,
      base,
      periods,
      exclude: excludeCount,
    };
    if (isUserEntry) {
      const colCount = getCurrentRatioColumnCount();
      nextRow.values = new Array(Math.max(0, colCount)).fill(1);
      nextRow.inputs = new Array(Math.max(0, colCount)).fill("1");
    }
    customRows.push(nextRow);
    saveCustomSummaryRows(cfgKey, customRows);
    hideAvgModal();
    _renderRatioTable();
  });
}

export function wireSummaryContextMenu(summaryTable) {
  if (!summaryTable || summaryTable.dataset.menuWired === "1") return;
  summaryTable.dataset.menuWired = "1";
  wireAvgModal();
  summaryCopySelection = wireSelectableTable({
    container: summaryTable,
    rowKey: "copyR",
    colKey: "copyC",
    selectedClass: "dfmTableSel",
    activeClass: "dfmTableActive",
    canStartPointerSelection: (event) => !!(event.shiftKey || event.ctrlKey || event.metaKey),
  }) || summaryCopySelection;

  summaryTable.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const row = e.target?.closest?.("tr[data-row-id]");
    const noteCell = e.target?.closest?.("td.summaryCell");
    const onLabelCell = !!e.target?.closest?.("th.summaryDragHandle");
    summaryContextCellForNote = noteCell || null;
    setLastSummaryCtxRowId(row?.dataset?.rowId || null);
    const lastId = getLastSummaryCtxRowId();
    const cfg = summaryRowMap.get(lastId || "");
    const menu = getAvgMenuEl();
    if (menu) {
      const disableRename = !cfg;
      const disableDelete = !cfg || summaryRowConfigs.length <= 1;
      const renameBtn = menu.querySelector('[data-action="rename-average"]');
      const deleteBtn = menu.querySelector('[data-action="delete-average"]');
      const customBtn = menu.querySelector('[data-action="custom-average"]');
      const noteBtn = menu.querySelector('[data-action="add-summary-cell-note"]');
      const clearNoteBtn = menu.querySelector('[data-action="clear-summary-cell-note"]');
      const hasNote = !!(noteCell && hasDfmCellNote(noteCell));
      menu.querySelectorAll("[data-label-only], .dfmCtxSep[data-label-only]").forEach((item) => {
        item.style.display = onLabelCell ? "" : "none";
      });
      if (renameBtn) renameBtn.disabled = disableRename;
      if (deleteBtn) deleteBtn.disabled = disableDelete;
      if (customBtn) customBtn.disabled = !onLabelCell;
      if (noteBtn) {
        noteBtn.disabled = !noteCell;
        noteBtn.textContent = hasNote ? "Edit Cell Notes" : "Add Cell Notes";
      }
      if (clearNoteBtn) clearNoteBtn.disabled = !hasNote;
    }
    showAvgMenu(e.clientX, e.clientY);
  });

  if (!avgMenuWired) {
    avgMenuWired = true;
    const menu = getAvgMenuEl();
    menu?.addEventListener("click", async (e) => {
      const btn = e.target?.closest?.("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      hideAvgMenu();
      if (action === "copy-summary-value") {
        await summaryCopySelection?.copySelection?.();
        return;
      }
      if (action === "add-summary-cell-note") {
        showDfmCellNoteEditor(summaryContextCellForNote, { focus: true });
        return;
      }
      if (action === "clear-summary-cell-note") {
        clearDfmCellNote(summaryContextCellForNote);
        return;
      }
      if (action === "custom-average") {
        showAvgModal();
        return;
      }
      if (action === "plot-summary-table") {
        const table = document.querySelector("#ratioWrap table.ratioSummaryTable");
        openDfmSummaryPlotWindow(table, {
          onSelectAveragePoint: ({ rowId, col }) => selectSummaryCell(table, rowId, col),
        });
        return;
      }
      if (action === "rename-average") {
        const lastId = getLastSummaryCtxRowId();
        if (!lastId) return;
        const cfg = summaryRowMap.get(lastId);
        if (!cfg) return;
        showRenameModal(cfg.label || "", (trimmed) => {
          const nameExists = summaryRowConfigs.some(
            (row) => String(row.label || "").trim().toLowerCase() === trimmed.toLowerCase()
          );
          if (nameExists && String(cfg.label || "").trim().toLowerCase() !== trimmed.toLowerCase()) {
            alert("Average formula name already exists.");
            return false;
          }
          const cfgKey = getSummaryConfigKey();
          if (!cfgKey) return true;
          const nextRows = summaryRowConfigs.map((row) =>
            String(row.id) === String(lastId) ? { ...row, label: trimmed } : { ...row }
          );
          saveCustomSummaryRows(cfgKey, nextRows);
          _renderRatioTable();
          return true;
        });
        return;
      }
      if (action === "delete-average") {
        const lastId = getLastSummaryCtxRowId();
        if (!lastId) return;
        if (summaryRowConfigs.length <= 1) return;
        const cfgKey = getSummaryConfigKey();
        if (!cfgKey) return;
        const nextRows = summaryRowConfigs
          .filter((row) => String(row.id) !== String(lastId))
          .map((row) => ({ ...row }));
        if (!nextRows.length) return;
        saveCustomSummaryRows(cfgKey, nextRows);
        for (const [col, rowId] of selectedSummaryByCol.entries()) {
          if (String(rowId) === String(lastId)) selectedSummaryByCol.delete(col);
        }
        _renderRatioTable();
        return;
      }
    });

    document.addEventListener("mousedown", (e) => {
      const menuEl = getAvgMenuEl();
      if (menuEl && menuEl.style.display === "block" && !menuEl.contains(e.target)) {
        hideAvgMenu();
      }
      const ratioMenu = getRatioMenuEl();
      if (ratioMenu && ratioMenu.style.display === "block" && !ratioMenu.contains(e.target)) {
        ratioMenu.style.display = "none";
      }
      const resultsMenu = getResultsTabMenuEl();
      if (resultsMenu && resultsMenu.style.display === "block" && !resultsMenu.contains(e.target)) {
        resultsMenu.style.display = "none";
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        hideAvgMenu();
        hideAvgModal();
        const ratioMenu = getRatioMenuEl();
        if (ratioMenu) ratioMenu.style.display = "none";
        hideResultsTabMenu();
      }
    });
  }
}

// =============================================================================
// Summary Selection
// =============================================================================
function formatPercentDeveloped(value) {
  if (!Number.isFinite(value)) return "";
  return `${(value * 100).toFixed(1)}%`;
}

function ensureSelectedRowValues(summaryTable, selectedTable) {
  if (!selectedTable) return;
  const selectedRow = selectedTable.querySelector('tr[data-row-id="selected"]');
  const cumulativeRow = selectedTable.querySelector('tr[data-row-id="cumulative"]');
  const developedRow = selectedTable.querySelector('tr[data-row-id="percent-developed"]');
  if (!selectedRow) return;
  const selectedCells = Array.from(selectedRow.querySelectorAll("td[data-col]"));
  const selectedValues = new Array(selectedCells.length).fill(null);
  const cumulativeValues = new Array(selectedCells.length).fill(null);

  selectedCells.forEach((td) => {
    const col = Number(td.dataset.col);
    const rowId = selectedSummaryByCol.get(col);
    if (!rowId) {
      td.textContent = "";
      return;
    }
    const cell = summaryTable?.querySelector(`td.summaryCell[data-r="${rowId}"][data-col="${col}"]`);
    if (!cell) {
      selectedSummaryByCol.delete(col);
      td.textContent = "";
      return;
    }
    const text = cell.textContent || "";
    td.textContent = text;
    const val = parseFloat(text);
    if (Number.isFinite(val)) selectedValues[col] = val;
  });

  if (cumulativeRow) {
    const cumCells = Array.from(cumulativeRow.querySelectorAll("td[data-col]"));
    let running = null;
    for (let i = selectedValues.length - 1; i >= 0; i--) {
      const selVal = selectedValues[i];
      const target = cumCells[i];
      if (!target) continue;
      if (!Number.isFinite(selVal)) {
        target.textContent = "";
        running = null;
        continue;
      }
      if (i === selectedValues.length - 1) {
        running = selVal;
      } else if (Number.isFinite(running)) {
        running = selVal * running;
      } else {
        target.textContent = "";
        running = null;
        continue;
      }
      const rounded = roundRatio(running, 6);
      cumulativeValues[i] = rounded;
      target.textContent = formatRatio(rounded, getDfmDecimalPlaces());
    }
  }

  if (developedRow) {
    const developedCells = Array.from(developedRow.querySelectorAll("td[data-col]"));
    developedCells.forEach((target) => {
      const col = Number(target.dataset.col);
      const cumulativeValue = cumulativeValues[col];
      if (!Number.isFinite(cumulativeValue) || cumulativeValue === 0) {
        target.textContent = "";
        return;
      }
      target.textContent = formatPercentDeveloped(roundRatio(1 / cumulativeValue, 6));
    });
  }
}

export function applySummarySelection(summaryTable, selectedTable) {
  if (!summaryTable) return;
  const cols = new Set();
  selectedSummaryByCol.forEach((_rowId, col) => cols.add(Number(col)));
  cols.forEach((col) => {
    const rowId = selectedSummaryByCol.get(col);
    const cell = summaryTable.querySelector(`td.summaryCell[data-r="${rowId}"][data-col="${col}"]`);
    if (!cell) {
      selectedSummaryByCol.delete(col);
      return;
    }
    summaryTable.querySelectorAll(`td.summaryCell[data-col="${col}"]`)
      .forEach((el) => el.classList.remove("ratioSelectedCell"));
    cell.classList.add("ratioSelectedCell");
  });
  ensureSelectedRowValues(summaryTable, selectedTable);
}

export function selectSummaryCell(summaryTable, rowId, col) {
  if (!summaryTable) return false;
  const rowKey = String(rowId || "");
  const colIndex = Number(col);
  if (!rowKey || !Number.isFinite(colIndex) || colIndex < 0) return false;
  const cell = summaryTable.querySelector(`td.summaryCell[data-r="${CSS.escape(rowKey)}"][data-col="${colIndex}"]`);
  if (!cell) return false;
  beginRatioHistoryAction("summary-cell-click");
  const selectedTable = summaryTable.closest("#ratioWrap")?.querySelector("table.ratioSelectedTable");
  selectedSummaryByCol.set(colIndex, rowKey);
  summaryTable.querySelectorAll(`td.summaryCell[data-col="${colIndex}"]`)
    .forEach((el) => el.classList.remove("ratioSelectedCell"));
  cell.classList.add("ratioSelectedCell");
  summaryTable.querySelectorAll("td.summaryCell.summaryActiveCell")
    .forEach((el) => el.classList.remove("summaryActiveCell"));
  cell.classList.add("summaryActiveCell");
  summaryActiveCellState = { rowId: rowKey, col: colIndex };
  ensureSelectedRowValues(summaryTable, selectedTable);
  updateSummaryFormulaBarForCell(cell);
  _onRatioStateMutated();
  commitRatioHistoryAction("summary-cell-click");
  return true;
}

export function initDefaultSummarySelection(summaryTable) {
  if (!summaryTable) return;
  const firstRow = summaryTable.querySelector("tr[data-row-id]");
  if (!firstRow) return;
  const rowId = String(firstRow.dataset.rowId || "");
  if (!rowId) return;
  const cols = summaryTable.querySelectorAll("td.summaryCell[data-col]");
  const maxCol = cols.length ? Math.max(...Array.from(cols).map((c) => Number(c.dataset.col))) : -1;
  if (maxCol < 0) return;
  for (let c = 0; c <= maxCol; c++) {
    if (!selectedSummaryByCol.has(c)) selectedSummaryByCol.set(c, rowId);
  }
}

function beginUserEntryCellEdit(cell, summaryTable, selectedTable) {
  if (!cell || cell.querySelector("input.summaryCellEditInput")) return;
  const rowId = String(cell.dataset.r || "");
  const col = Number(cell.dataset.col);
  if (!rowId || !Number.isFinite(col) || col < 0) return;
  const cfg = summaryRowMap.get(rowId);
  if (!isUserEntryConfig(cfg)) return;

  const currentValue = getUserEntryValueForCol(cfg, col);
  const input = document.createElement("input");
  input.type = "text";
  input.className = "summaryCellEditInput";
  input.value = formatRatio(roundRatio(currentValue, 6), getDfmDecimalPlaces());
  const original = cell.textContent;
  cell.textContent = "";
  cell.appendChild(input);
  input.focus();
  input.select();
  beginSummaryFormulaEditSession(summaryTable, cell, input, col);

  let finished = false;
  const restore = (nextValue) => {
    cell.textContent = formatRatio(roundRatio(nextValue, 6), getDfmDecimalPlaces());
    cell.classList.remove("na");
    cell.classList.remove("ratioPlaceholder");
    cell.classList.remove("strike");
    cell.classList.add("userEntryEditable");
  };
  const finish = (commit) => {
    if (finished) return;
    finished = true;
    clearSummaryReferenceUi(summaryTable);
    summaryFormulaEditState = null;
    if (!commit) {
      cell.textContent = original;
      updateSummaryFormulaBarForCell(cell);
      return;
    }
    const raw = String(input.value || "").trim();
    const arrayCommit = commitUserEntryArrayFormula(summaryTable, selectedTable, rowId, col, raw);
    if (arrayCommit.handled) {
      if (!arrayCommit.ok) {
        alert(arrayCommit.error || "Could not apply array formula.");
        finished = false;
        beginSummaryFormulaEditSession(summaryTable, cell, input, col);
        input.focus();
        input.select();
      }
      return;
    }
    const refValues = buildSummaryReferenceValues(summaryTable, col);
    const parsed = raw ? evaluateSimpleMathExpression(raw, refValues) : 1;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      alert("Enter a number > 0, or a formula like =\"Simple - 5\"*2.");
      finished = false;
      beginSummaryFormulaEditSession(summaryTable, cell, input, col);
      input.focus();
      input.select();
      return;
    }
    const nextValue = roundRatio(parsed, 6);
    setUserEntryCellEntry(rowId, col, raw || String(nextValue), nextValue);
    restore(nextValue);
    ensureSelectedRowValues(summaryTable, selectedTable);
    applyUserEntryReferenceHighlights(summaryTable);
    updateSummaryFormulaBarForCell(cell);
    _onRatioStateMutated();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("input", () => {
    updateSummaryFormulaBarForCell(cell);
  });
  input.addEventListener("blur", () => finish(true));
}

export function wireSummarySelection(summaryTable, selectedTable) {
  if (!summaryTable || summaryTable.dataset.selectionWired === "1") return;
  summaryTable.dataset.selectionWired = "1";
  let dragActive = false;
  let lastKey = null;

  const finishSummaryCellDrag = () => {
    if (dragActive) {
      commitRatioHistoryAction("summary-cell-click");
    }
    dragActive = false;
    lastKey = null;
  };

  const isSummaryEditSessionActive = () => {
    if (!summaryFormulaEditState) return false;
    if (summaryFormulaEditState.summaryTable !== summaryTable) return false;
    const input = summaryFormulaEditState.input;
    return !!input && document.body.contains(input);
  };

  const isFormulaReferenceMode = () => {
    if (!isSummaryEditSessionActive()) return false;
    const input = summaryFormulaEditState?.input;
    if (!input) return false;
    return String(input.value || "").includes("=");
  };

  const updateReferenceHoverUi = (hoverCell) => {
    clearSummaryReferenceUi(summaryTable);
    if (!isFormulaReferenceMode()) return;
    const editState = summaryFormulaEditState;
    const editCol = Number(editState?.col);
    const editCell = editState?.cell;
    if (!Number.isFinite(editCol) || !editCell) return;
    summaryTable.querySelectorAll(`td.summaryCell[data-col="${editCol}"]`).forEach((cell) => {
      if (cell === editCell) return;
      cell.classList.add("summaryRefCandidate");
    });
    if (hoverCell && hoverCell !== editCell) {
      const hoverCol = Number(hoverCell.dataset.col);
      if (hoverCol === editCol) hoverCell.classList.add("summaryRefHover");
    }
    updateActiveSummaryFormulaReferenceUi(summaryTable);
  };

  const isNearCellBorder = (e, cell) => {
    const rect = cell?.getBoundingClientRect?.();
    if (!rect) return false;
    const tolerance = 6;
    const left = Math.abs(e.clientX - rect.left);
    const right = Math.abs(e.clientX - rect.right);
    const top = Math.abs(e.clientY - rect.top);
    const bottom = Math.abs(e.clientY - rect.bottom);
    return Math.min(left, right, top, bottom) <= tolerance;
  };

  const getReferenceDragTarget = (e) => {
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const cell = target?.closest?.("td.summaryCell");
    const dragState = summaryReferenceDragState;
    if (!cell || !dragState || !summaryTable.contains(cell)) return null;
    if (cell === dragState.editCell) return null;
    const col = Number(cell.dataset.col);
    return col === dragState.col ? cell : null;
  };

  const clearReferenceDragTargetUi = () => {
    summaryTable.querySelectorAll("td.summaryCell.summaryFormulaRefDragTarget")
      .forEach((cell) => cell.classList.remove("summaryFormulaRefDragTarget"));
  };

  const applyReferenceDragTarget = (cell) => {
    const dragState = summaryReferenceDragState;
    if (!dragState || !cell) return;
    const nextLabel = getSummaryCellRowLabel(cell);
    if (!nextLabel) return;
    const replaced = replaceFormulaReferenceLabel(dragState.input.value, dragState.currentLabel, nextLabel);
    clearReferenceDragTargetUi();
    cell.classList.add("summaryFormulaRefDragTarget");
    if (!replaced.changed) return;
    dragState.input.value = replaced.value;
    dragState.currentLabel = nextLabel;
    dragState.currentCell = cell;
    beginSummaryFormulaEditSession(summaryTable, dragState.editCell, dragState.input, dragState.col);
    updateSummaryFormulaBarForCell(dragState.editCell);
    updateActiveSummaryFormulaReferenceUi(summaryTable);
    scrollSummaryFormulaInputToEnd(dragState.input);
  };

  const finishReferenceDrag = () => {
    if (!summaryReferenceDragState) return;
    const input = summaryReferenceDragState.input;
    summaryReferenceDragState = null;
    clearReferenceDragTargetUi();
    updateActiveSummaryFormulaReferenceUi(summaryTable);
    input?.focus?.();
    window.removeEventListener("mousemove", onReferenceDragMove, true);
    window.removeEventListener("mouseup", onReferenceDragUp, true);
    window.removeEventListener("blur", finishReferenceDrag, true);
  };

  function onReferenceDragMove(e) {
    if (!summaryReferenceDragState) return;
    e.preventDefault();
    const targetCell = getReferenceDragTarget(e);
    if (targetCell) applyReferenceDragTarget(targetCell);
  }

  function onReferenceDragUp(e) {
    if (summaryReferenceDragState && e) {
      const targetCell = getReferenceDragTarget(e);
      if (targetCell) applyReferenceDragTarget(targetCell);
    }
    finishReferenceDrag();
  }

  const tryStartReferenceDrag = (e) => {
    if (!isFormulaReferenceMode()) return false;
    const cell = e.target?.closest?.("td.summaryCell.summaryFormulaActiveRefCell");
    if (!cell || !isNearCellBorder(e, cell)) return false;
    const editState = summaryFormulaEditState;
    const input = editState?.input;
    const editCol = Number(editState?.col);
    const editCell = editState?.cell;
    const currentLabel = getSummaryCellRowLabel(cell);
    if (!input || !Number.isFinite(editCol) || !editCell || !currentLabel) return false;
    e.preventDefault();
    e.stopPropagation();
    summaryReferenceDragState = {
      summaryTable,
      input,
      editCell,
      col: editCol,
      currentCell: cell,
      currentLabel,
    };
    cell.classList.add("summaryFormulaRefDragTarget");
    window.addEventListener("mousemove", onReferenceDragMove, true);
    window.addEventListener("mouseup", onReferenceDragUp, true);
    window.addEventListener("blur", finishReferenceDrag, true);
    return true;
  };

  const tryInsertReferenceFromEvent = (e) => {
    if (!isFormulaReferenceMode()) return false;
    const editState = summaryFormulaEditState;
    const editCol = Number(editState?.col);
    const editCell = editState?.cell;
    const input = editState?.input;
    if (!Number.isFinite(editCol) || !editCell || !input) return false;
    const cell = e.target?.closest?.("td.summaryCell");
    if (!cell || cell === editCell) return false;
    const col = Number(cell.dataset.col);
    if (!Number.isFinite(col) || col !== editCol) return false;
    const rowLabel = String(cell.parentElement?.querySelector("th")?.textContent || "").trim();
    if (!rowLabel) return false;
    e.preventDefault();
    e.stopPropagation();
    if (cell.classList.contains("summaryFormulaActiveRefCell")) {
      input.focus();
      updateReferenceHoverUi(cell);
      return true;
    }
    insertAtInputCursor(input, `"${rowLabel}"`);
    input.focus();
    updateReferenceHoverUi(cell);
    updateSummaryFormulaBarForCell(editCell);
    return true;
  };

  const selectCell = (cell) => {
    if (!cell) return;
    if (isSummaryEditSessionActive()) return;
    const col = Number(cell.dataset.col);
    const rowId = String(cell.dataset.r || "");
    if (!Number.isFinite(col) || !rowId) return;
    selectedSummaryByCol.set(col, rowId);
    summaryTable.querySelectorAll(`td.summaryCell[data-col="${col}"]`)
      .forEach((el) => el.classList.remove("ratioSelectedCell"));
    cell.classList.add("ratioSelectedCell");
    ensureSelectedRowValues(summaryTable, selectedTable);
    _onRatioStateMutated();
  };

  const setActiveCell = (cell, syncSelection) => {
    if (!cell) {
      summaryActiveCellState = { rowId: "", col: -1 };
      summaryTable.querySelectorAll("td.summaryCell.summaryActiveCell")
        .forEach((el) => el.classList.remove("summaryActiveCell"));
      updateSummaryFormulaBarForCell(null);
      return;
    }
    if (isSummaryEditSessionActive() && summaryFormulaEditState?.cell !== cell) {
      updateSummaryFormulaBarForCell(summaryFormulaEditState.cell);
      return;
    }
    const rowId = String(cell.dataset.r || "");
    const col = Number(cell.dataset.col);
    if (!rowId || !Number.isFinite(col) || col < 0) return;
    summaryTable.querySelectorAll("td.summaryCell.summaryActiveCell")
      .forEach((el) => el.classList.remove("summaryActiveCell"));
    cell.classList.add("summaryActiveCell");
    summaryCopySelection?.selectCell?.(cell, false);
    summaryActiveCellState = { rowId, col };
    if (syncSelection) selectCell(cell);
    updateSummaryFormulaBarForCell(cell);
  };

  const selectFormulaRow = (row) => {
    if (!row || isSummaryEditSessionActive()) return;
    const rowId = String(row.dataset.rowId || "");
    if (!rowId) return;
    const cells = Array.from(row.querySelectorAll("td.summaryCell[data-col]"));
    if (!cells.length) return;
    const selectedCells = [];
    let changed = false;
    cells.forEach((cell) => {
      const col = Number(cell.dataset.col);
      if (!Number.isFinite(col)) return;
      selectedCells.push(cell);
      if (selectedSummaryByCol.get(col) !== rowId) changed = true;
    });
    const firstCell = selectedCells[0] || null;
    if (!changed) {
      setActiveCell(firstCell, false);
      return;
    }
    beginRatioHistoryAction("summary-row-click");
    selectedCells.forEach((cell) => {
      const col = Number(cell.dataset.col);
      if (!Number.isFinite(col)) return;
      selectedSummaryByCol.set(col, rowId);
    });
    summaryTable.querySelectorAll("td.summaryCell.ratioSelectedCell")
      .forEach((el) => el.classList.remove("ratioSelectedCell"));
    selectedCells.forEach((cell) => cell.classList.add("ratioSelectedCell"));
    ensureSelectedRowValues(summaryTable, selectedTable);
    setActiveCell(firstCell, false);
    _onRatioStateMutated();
    commitRatioHistoryAction("summary-row-click");
  };

  const getCurrentActiveCell = () => {
    const { rowId, col } = summaryActiveCellState;
    if (rowId && Number.isFinite(col) && col >= 0) {
      const byState = summaryTable.querySelector(`td.summaryCell[data-r="${rowId}"][data-col="${col}"]`);
      if (byState) return byState;
    }
    return summaryTable.querySelector("td.summaryCell.summaryActiveCell");
  };

  const moveActiveCell = (rowDelta, colDelta) => {
    const rows = Array.from(summaryTable.querySelectorAll("tr[data-row-id]"));
    if (!rows.length) return;
    const current = getCurrentActiveCell();
    if (!current) return;
    const currentRowId = String(current.dataset.r || "");
    const currentCol = Number(current.dataset.col);
    if (!currentRowId || !Number.isFinite(currentCol)) return;

    const rowIndex = Math.max(0, rows.findIndex((row) => String(row.dataset.rowId || "") === currentRowId));
    const rowCount = rows.length;
    const colCount = rows[0]?.querySelectorAll("td.summaryCell").length || 0;
    if (!colCount) return;

    const nextRow = Math.max(0, Math.min(rowCount - 1, rowIndex + rowDelta));
    const nextCol = Math.max(0, Math.min(colCount - 1, currentCol + colDelta));
    const nextCell = rows[nextRow]?.querySelector(`td.summaryCell[data-col="${nextCol}"]`);
    if (!nextCell) return;
    setActiveCell(nextCell, false);
    nextCell.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  summaryTable.addEventListener("mousedown", (e) => {
    if (tryStartReferenceDrag(e)) return;
    if (tryInsertReferenceFromEvent(e)) return;
    if (e.button !== 0) return;
    if (e.target?.closest?.("input.summaryCellEditInput")) return;
    const cell = e.target?.closest?.("td.summaryCell");
    if (!cell) return;
    e.preventDefault();
    dragActive = true;
    beginRatioHistoryAction("summary-cell-click");
    const key = `${cell.dataset.r || ""},${cell.dataset.col || ""}`;
    lastKey = key;
    setActiveCell(cell, true);
  });

  summaryTable.addEventListener("mousemove", (e) => {
    if (summaryReferenceDragState) return;
    const hoverCell = e.target?.closest?.("td.summaryCell");
    updateReferenceHoverUi(hoverCell || null);
    if (!dragActive) return;
    const cell = e.target?.closest?.("td.summaryCell");
    if (!cell) return;
    const key = `${cell.dataset.r || ""},${cell.dataset.col || ""}`;
    if (key === lastKey) return;
    lastKey = key;
    setActiveCell(cell, true);
  });

  window.addEventListener("mouseup", finishSummaryCellDrag);
  window.addEventListener("blur", finishSummaryCellDrag);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) finishSummaryCellDrag();
  });

  summaryTable.addEventListener("click", (e) => {
    if (e.defaultPrevented) return;
    if (dragActive) return;
    if (e.target?.closest?.("input.summaryCellEditInput")) return;
    const rowHead = e.target?.closest?.("th.summaryDragHandle");
    if (rowHead) {
      e.preventDefault();
      selectFormulaRow(rowHead.closest("tr[data-row-id]"));
      return;
    }
    const cell = e.target?.closest?.("td.summaryCell");
    if (!cell) return;
    setActiveCell(cell, true);
  });

  summaryTable.addEventListener("dblclick", (e) => {
    const cell = e.target?.closest?.("td.summaryCell");
    if (!cell) return;
    setActiveCell(cell, true);
    beginUserEntryCellEdit(cell, summaryTable, selectedTable);
    updateReferenceHoverUi(null);
  });

  summaryTable.addEventListener("mouseleave", () => {
    updateReferenceHoverUi(null);
  });

  document.addEventListener("keydown", (e) => {
    if (!document.body.contains(summaryTable)) return;
    if (!summaryTable.querySelector("td.summaryCell.summaryActiveCell")) return;
    const target = e.target;
    if (target?.closest?.("input, textarea, [contenteditable='true']")) return;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActiveCell(-1, 0);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActiveCell(1, 0);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      moveActiveCell(0, -1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      moveActiveCell(0, 1);
    } else if (e.key === "=" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const cell = getCurrentActiveCell();
      if (!cell) return;
      const rowId = String(cell.dataset.r || "");
      const cfg = summaryRowMap.get(rowId);
      if (!cfg || !isUserEntryConfig(cfg)) return;
      e.preventDefault();
      const barEl = document.getElementById("dfmSummaryFormulaBar");
      const barInput = barEl?.querySelector("#dfmSummaryFormulaBarInput");
      if (barInput && !barInput.disabled) {
        barInput.value = "= ";
        updateFormulaBarDisplayMode(barEl, true);
        barInput.focus();
        const col = Number(cell.dataset.col);
        if (Number.isFinite(col) && col >= 0) {
          beginSummaryFormulaEditSession(summaryTable, cell, barInput, col);
        }
      }
    }
  });

  const initCell = summaryTable.querySelector(
    `td.summaryCell[data-r="${summaryActiveCellState.rowId}"][data-col="${summaryActiveCellState.col}"]`
  );
  setActiveCell(initCell || null, false);
}
// =============================================================================
// Summary Update
// =============================================================================
export function updateRatioSummary() {
  const wrap = document.getElementById("ratioWrap");
  const model = state.model;
  if (!wrap || !model || !Array.isArray(model.values) || !Array.isArray(model.mask)) return;
  recalculateUserEntryDependencies();
  const cells = wrap.querySelectorAll('td.ratioCell[data-r]');
  if (!cells.length) return;

  const devs = getEffectiveDevLabelsForModel(model);

  cells.forEach((cell) => {
    const c = parseInt(cell.dataset.c, 10);
    const rowType = cell.dataset.r;
    const cfg = summaryRowMap.get(rowType);
    const isSummary = !!cfg;

    if (!Number.isFinite(c) || c < 0) return;
    cell.classList.remove("userEntryEditable");
    cell.classList.remove("excelLinked");
    cell.title = "";
    if (cfg && isUserEntryConfig(cfg)) {
      const value = getUserEntryValueForCol(cfg, c);
      cell.textContent = formatRatio(roundRatio(value, 6), getDfmDecimalPlaces());
      cell.classList.remove("na");
      cell.classList.remove("ratioPlaceholder");
      cell.classList.remove("strike");
      cell.classList.add("userEntryEditable");
      const inputText = String(getUserEntryInputForCol(cfg, c) || "");
      if (containsExcelRef(inputText)) {
        cell.classList.add("excelLinked");
        cell.title = inputText;
      }
      return;
    }
    if (c >= devs.length - 1) {
      if (isSummary) {
        cell.textContent = "1.0000";
        cell.classList.remove("na");
        cell.classList.add("ratioPlaceholder");
        cell.classList.remove("strike");
      } else {
        cell.textContent = "";
        cell.classList.add("na");
        cell.classList.remove("ratioPlaceholder");
        cell.classList.remove("strike");
      }
      return;
    }

    if (!cfg) return;
    ratioStrikeSet.delete(`${rowType},${c}`);
    const excluded = buildExcludedSetForColumn(model, c, cfg, ratioStrikeSet);
    const summary = computeAverageForColumn(model, c, excluded, cfg);
    if (summary.totalValid > 0 && summary.totalIncluded === 0) {
      cell.textContent = "1.0000";
      cell.classList.remove("na");
      cell.classList.remove("ratioPlaceholder");
      cell.classList.remove("strike");
      return;
    }
    const isVolume = String(cfg.base || "volume").toLowerCase() === "volume";
    const hasValue =
      summary.value !== null &&
      (isVolume ? summary.sumA : summary.totalIncluded > 0);
    if (hasValue) {
      const rounded = roundRatio(summary.value, 6);
      cell.textContent = formatRatio(rounded, getDfmDecimalPlaces());
      cell.classList.remove("na");
      cell.classList.remove("ratioPlaceholder");
    } else {
      cell.textContent = "1.0000";
      cell.classList.remove("na");
      cell.classList.add("ratioPlaceholder");
    }
    cell.classList.remove("strike");
  });

  const summaryTable = wrap.querySelector("table.ratioSummaryTable");
  const selectedTable = wrap.querySelector("table.ratioSelectedTable");
  if (summaryTable && selectedTable) {
    ensureSelectedRowValues(summaryTable, selectedTable);
    applyUserEntryReferenceHighlights(summaryTable);
  }
}

export function scheduleRatioSummaryUpdate() {
  if (getRatioSummaryRaf()) return;
  setRatioSummaryRaf(requestAnimationFrame(() => {
    setRatioSummaryRaf(null);
    updateRatioSummary();
  }));
}

// Rendering only: read state.model + state.showBlanks and produce DOM.

import { state } from "/ui/shared/state.js";
import { $ } from "/ui/shared/dom.js";
import { openContextMenu } from "/ui/shared/menu_utils.js";
import { renderChart as renderChartCanvas, setupChartHover } from "/ui/dataset/dataset_chart.js";
import {
  clampDatasetDecimalPlaces,
  formatDatasetNumberValue,
  normalizeDatasetNumberFormat,
} from "/ui/dataset/dataset_number_format.js";

let ctxMenuWired = false;
let renderNumberFormatSettings = null;
let renderVectorColumnLabel = "";
let gridEditConfig = null;

function normalizeRenderNumberFormatSettings(settings = null) {
  if (!settings || typeof settings !== "object") return null;
  return {
    numberFormat: normalizeDatasetNumberFormat(
      settings.number_format ?? settings.numberFormat ?? settings.num_format,
    ),
    decimalPlaces: clampDatasetDecimalPlaces(settings.decimal_places ?? settings.decimalPlaces),
  };
}

export function setDatasetRenderNumberFormatSettings(settings = null) {
  renderNumberFormatSettings = normalizeRenderNumberFormatSettings(settings);
}

export function setDatasetRenderVectorColumnLabel(label = "") {
  renderVectorColumnLabel = String(label || "").trim();
}

export function setDatasetGridEditConfig(config = null) {
  gridEditConfig = config && typeof config === "object" ? config : null;
}

// --- keyboard focus sink: make sure this document receives keydown after clicking a cell ---
function ensureKeySink() {
  let el = document.getElementById("keySink");
  if (el) return el;

  el = document.createElement("div");
  el.id = "keySink";
  el.tabIndex = 0;                 // make it focusable
  el.setAttribute("aria-hidden", "true");
  el.style.position = "fixed";
  el.style.left = "-9999px";
  el.style.top = "0";
  el.style.width = "1px";
  el.style.height = "1px";
  el.style.opacity = "0";
  document.body.appendChild(el);
  return el;
}

function claimDatasetFocus() {
  try { window.focus(); } catch {}
  const sink = ensureKeySink();
  try { sink.focus({ preventScroll: true }); } catch { try { sink.focus(); } catch {} }
}

const fmt0 = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const DFM_PERCENT_DECIMAL_PLACES = 1;

function isPercentTriangle() {
  const triInput = document.getElementById("triInput");
  return triInput && triInput.value.includes("%");
}

const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function formatOriginLabel(label, originLen) {
  if (Number(originLen) !== 1) return label;
  const s = String(label);
  if (!/^\d{6}$/.test(s)) return label;
  const mm = parseInt(s.slice(4), 10);
  return `${MONTH_ABBR[mm - 1]} ${s.slice(0, 4)}`;
}

function getOriginLabelText(originLen) {
  switch (Number(originLen)) {
    case 12: return "Accident Year";
    case 6:  return "Accident Half-Year";
    case 3:  return "Accident Quarter";
    case 1:  return "Accident Month";
    default: return "Accident Period";
  }
}

function normalizeDatasetTypeKey(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function shouldHideTotalRowByFormula() {
  const tri = String(document.getElementById("triInput")?.value || "").trim();
  if (!tri) return false;
  const key = normalizeDatasetTypeKey(tri);
  if (!key) return false;
  const formulaMap = state.datasetTypeFormulaByKey instanceof Map ? state.datasetTypeFormulaByKey : null;
  if (!formulaMap) return false;
  const formulaExpr = String(formulaMap.get(key) || "").trim();
  return /[*/]/.test(formulaExpr);
}

function numericCellValue(value) {
  const n = (typeof value === "number") ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function sumDisplayRow(vals, mask, rowIndex, columnCount) {
  let sum = 0;
  let count = 0;
  for (let c = 0; c < columnCount; c++) {
    if (!(mask[rowIndex] && mask[rowIndex][c])) continue;
    const n = numericCellValue(vals[rowIndex]?.[c]);
    if (n == null) continue;
    sum += n;
    count += 1;
  }
  return count > 0 ? sum : null;
}

function ensureCtxMenuWired() {
  if (ctxMenuWired) return;
  ctxMenuWired = true;

  const menu = document.getElementById("ctxMenu");
  if (!menu) return;

  menu.addEventListener("click", async (e) => {
    const btn = e.target.closest(".ctx-item");
    if (!btn) return;
    const action = btn.dataset.action || "";
    if (action === "copy_value" && typeof window.__arcRhoCopyActiveGridSelection === "function") {
      await window.__arcRhoCopyActiveGridSelection();
    } else if (gridEditConfig?.onContextAction) {
      try {
        await gridEditConfig.onContextAction(action);
      } catch (error) {
        console.error("Dataset grid context action failed", error);
      }
    }
    hideCtxMenu();
    claimDatasetFocus();
  });

  // Click anywhere else -> hide
  document.addEventListener("mousedown", (e) => {
    if (!menu.contains(e.target)) hideCtxMenu();
  });

  // ESC -> hide
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideCtxMenu();
  });

  // Scroll/resize -> hide (prevents "floating" menu)
  window.addEventListener("scroll", hideCtxMenu, true);
  window.addEventListener("resize", hideCtxMenu);
}

function showCtxMenu(anchorEl, clientX, clientY) {
  const menu = document.getElementById("ctxMenu");
  if (!menu) return;
  const pasteButton = menu.querySelector('[data-action="paste"]');
  if (pasteButton) pasteButton.hidden = !gridEditConfig?.canPasteSelection?.();
  openContextMenu(menu, {
    anchorEl,
    clientX,
    clientY,
    offset: 8,
    align: "top-left",
  });
}

function hideCtxMenu() {
  const menu = document.getElementById("ctxMenu");
  if (!menu) return;
  menu.style.display = "none";
}

function getDecimalPlaces() {
  if (renderNumberFormatSettings) return renderNumberFormatSettings.decimalPlaces;
  if (!document.getElementById("numberFormatSelect")) return 1;
  const el = document.getElementById("decimalPlaces");
  const n = parseInt(el?.value, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(6, n)); // clamp 0..6
}

function getNumberFormatPattern() {
  if (renderNumberFormatSettings) return renderNumberFormatSettings.numberFormat;
  const input = document.getElementById("numberFormatSelect");
  return input ? normalizeDatasetNumberFormat(input.value) : "";
}

function getPercentDecimalPlaces() {
  return window.ADA_DFM_CONTEXT ? DFM_PERCENT_DECIMAL_PLACES : getDecimalPlaces();
}

function detectNumberMode() {
  // 1) name contains % => percent
  if (isPercentTriangle()) return "percent";

  const model = state.model;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) {
    return "int";
  }

  const vals = model.values;
  const mask = model.mask;

  // 2) scan dataset: all non-zero numeric values in (0,1) => decimal
  let sawNonZero = false;

  for (let r = 0; r < vals.length; r++) {
    for (let c = 0; c < (vals[r] || []).length; c++) {
      if (!mask[r] || !mask[r][c]) continue;

      const v = vals[r][c];
      if (v === null || v === undefined || v === "") continue;

      const n = (typeof v === "number") ? v : Number(v);
      if (!Number.isFinite(n)) continue;

      if (n === 0) continue; // exclude 0 from the check (allowed to exist)

      sawNonZero = true;

      // if ANY non-zero value is outside (0,1), it's not a ratio-like dataset
      const abs = Math.abs(n);
      if (!(abs > 0 && abs < 1)) return "int";
    }
  }

  return sawNonZero ? "decimal" : "int";
}

export function formatCellValue(v) {
  if (v === null || v === undefined || v === "") return "";

  const n = (typeof v === "number") ? v : Number(v);
  if (!Number.isFinite(n)) return "";

  const pattern = getNumberFormatPattern();
  if (pattern) return formatDatasetNumberValue(n, pattern, getDecimalPlaces());

  const mode = detectNumberMode();
  const dp = getDecimalPlaces();

  if (mode === "percent") {
    return (n * 100).toFixed(getPercentDecimalPlaces()) + "%";
  }

  if (mode === "decimal") {
    return n.toFixed(dp); // 0.000 style (no comma)
  }

  // default: 0,000
  return fmt0.format(n);
}

function getEffectiveDevLabels(model) {
  const devs = Array.isArray(model?.dev_labels) ? model.dev_labels : [];
  const vals = Array.isArray(model?.values) ? model.values : [];
  let maxCols = 0;
  for (const row of vals) {
    if (Array.isArray(row)) maxCols = Math.max(maxCols, row.length);
  }
  if (!maxCols) return devs;
  if (devs.length >= maxCols) return devs.slice(0, maxCols);
  return devs.concat(Array(maxCols - devs.length).fill(""));
}

function isTransposedView() {
  return document.getElementById("transposedChk")?.checked === true;
}

function transposeMatrix(matrix) {
  const rows = Array.isArray(matrix) ? matrix : [];
  let maxCols = 0;
  for (const row of rows) {
    if (Array.isArray(row)) maxCols = Math.max(maxCols, row.length);
  }
  const out = [];
  for (let c = 0; c < maxCols; c++) {
    const next = [];
    for (let r = 0; r < rows.length; r++) {
      next.push(rows[r]?.[c]);
    }
    out.push(next);
  }
  return out;
}

export function getDisplayDatasetModel() {
  const model = state.model;
  if (!model || !isTransposedView()) return model;

  return {
    ...model,
    origin_labels: getEffectiveDevLabels(model),
    dev_labels: Array.isArray(model.origin_labels) ? model.origin_labels.map(String) : [],
    values: transposeMatrix(model.values),
    mask: transposeMatrix(model.mask).map((row) => row.map(Boolean)),
  };
}

function captureRenderedColumnWidths(wrap) {
  const headers = Array.from(wrap?.querySelectorAll?.("thead tr:first-child > th") || []);
  if (!headers.length) return [];
  return headers.map((cell) => {
    const width = cell.getBoundingClientRect?.().width;
    return Number.isFinite(width) && width > 0 ? Math.ceil(width) : 0;
  });
}

function applyColumnWidthLock(table, widths, expectedCount) {
  if (!table || !Array.isArray(widths) || widths.length !== expectedCount) return;
  if (widths.some((width) => !Number.isFinite(width) || width <= 0)) return;
  const colgroup = document.createElement("colgroup");
  let totalWidth = 0;
  for (const width of widths) {
    totalWidth += width;
    const col = document.createElement("col");
    col.style.width = `${width}px`;
    colgroup.appendChild(col);
  }
  table.appendChild(colgroup);
  table.style.width = `${totalWidth}px`;
}

export function renderTable() {

  const wrap = $("tableWrap");
  const lockedColumnWidths = state.editingCell ? captureRenderedColumnWidths(wrap) : [];
  wrap.innerHTML = "";
  ensureCtxMenuWired();

  const model = getDisplayDatasetModel();
  if (!model) {
    wrap.innerHTML = `<div class="small">No dataset loaded.</div>`;
    return;
  }

  const origins = model.origin_labels;
  const devs = getEffectiveDevLabels(model);
  const vals = model.values;
  const mask = model.mask; // True=has value, False=blank/missing

  if (!Array.isArray(mask)) {
    wrap.innerHTML = `<div style="color:#b00;"><b>UI Error:</b> mask is missing. Update get_dataset to return mask.</div>`;
    return;
  }

  if (state.activeCell) {
    const maxR = (origins?.length || 0) - 1;
    const maxC = (devs?.length || 0) - 1;
    if (maxR < 0 || maxC < 0) {
      state.activeCell = null;
    } else {
      const r = Math.max(0, Math.min(state.activeCell.r, maxR));
      const c = Math.max(0, Math.min(state.activeCell.c, maxC));
      state.activeCell = { r, c };
    }
  }

  const tbl = document.createElement("table");
  tbl.classList.add("arSpreadsheetTable");
  const transposed = isTransposedView();
  const showTotalRow = !shouldHideTotalRowByFormula();
  const showRightSideTotal = showTotalRow && transposed;
  applyColumnWidthLock(tbl, lockedColumnWidths, devs.length + 1 + (showRightSideTotal ? 1 : 0));

  // header
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");

  const th0 = document.createElement("th");
  const originLen = document.getElementById("originLenSelect")?.value || 12;
  const calendar = document.querySelector('input[name="timeMode"][value="calendar"]')?.checked === true;
  th0.textContent = transposed ? (calendar ? "Calendar Period" : "Development Period") : getOriginLabelText(originLen);
  trh.appendChild(th0);

  devs.forEach((d, c) => {
    const th = document.createElement("th");
    th.textContent = !transposed && devs.length === 1 && renderVectorColumnLabel
      ? renderVectorColumnLabel
      : (transposed ? formatOriginLabel(d, originLen) : d);

    th.classList.add("colhdr");
    th.dataset.c = String(c);

    trh.appendChild(th);
  });

  if (showRightSideTotal) {
    const th = document.createElement("th");
    th.textContent = "Total";
    th.classList.add("totalColHdr");
    trh.appendChild(th);
  }

  thead.appendChild(trh);
  tbl.appendChild(thead);

  // body
  const tbody = document.createElement("tbody");

  for (let r = 0; r < origins.length; r++) {
    const tr = document.createElement("tr");

    const th = document.createElement("th");
    th.textContent = formatOriginLabel(origins[r], originLen);

    th.classList.add("rowhdr");
    th.dataset.r = String(r);

    tr.appendChild(th);

    for (let c = 0; c < devs.length; c++) {
      const td = document.createElement("td");
      const key = `${r},${c}`;

      const hasValue = !!(mask[r] && mask[r][c]);
      td.classList.add("cell");
      td.dataset.r = String(r);
      td.dataset.c = String(c);
      td.setAttribute("aria-selected", "false");

      td.addEventListener("click", (event) => {
        if (event.target?.closest?.(".dsCellInput")) return;
        claimDatasetFocus();
      });

      td.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        gridEditConfig?.onCellContextMenu?.(r, c);
        showCtxMenu(td, e.clientX, e.clientY);
      });

      if (!hasValue) {
        td.textContent = "";
        if (!state.showBlanks) {
          td.classList.add("na");        // visually hidden
        }
      } else {
        const v = vals[r][c];
        if (gridEditConfig?.isEditableCell?.(r, c) && gridEditConfig?.isEditingCell?.(r, c)) {
          const input = document.createElement("input");
          input.className = "dsCellInput";
          input.type = "text";
          input.inputMode = "decimal";
          input.value = formatCellValue(v);
          input.classList.toggle("dsCellInputBlank", v == null);
          input.dataset.r = String(r);
          input.dataset.c = String(c);
          input.addEventListener("focus", () => gridEditConfig?.onCellFocus?.(r, c));
          input.addEventListener("mousedown", (event) => event.stopPropagation());
          input.addEventListener("keydown", (event) => gridEditConfig?.onCellKeyDown?.(r, c, event));
          input.addEventListener("input", () => gridEditConfig?.onCellInput?.(r, c, input.value, input, td));
          input.addEventListener("paste", (event) => gridEditConfig?.onCellPaste?.(r, c, event));
          input.addEventListener("change", () => gridEditConfig?.onCellCommit?.(r, c, input.value, input, td));
          input.addEventListener("blur", () => gridEditConfig?.onCellCommit?.(r, c, input.value, input, td));
          td.appendChild(input);
        } else {
          td.textContent = formatCellValue(v);
        }
      }

      tr.appendChild(td);
    }

    if (showRightSideTotal) {
      const td = document.createElement("td");
      td.className = "totalCell";
      const sum = sumDisplayRow(vals, mask, r, devs.length);
      td.textContent = sum == null ? "" : formatCellValue(sum);
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }

  tbl.appendChild(tbody);

  tbl.classList.toggle("has-total-row", showTotalRow && !showRightSideTotal);
  tbl.classList.toggle("has-total-column", showRightSideTotal);

  if (showTotalRow && !showRightSideTotal) {
    // Footer totals: sum each development column across all origin rows.
    const tfoot = document.createElement("tfoot");
    const trf = document.createElement("tr");
    const totalLabel = document.createElement("th");
    totalLabel.textContent = "Total";
    trf.appendChild(totalLabel);

    for (let c = 0; c < devs.length; c++) {
      const td = document.createElement("td");
      let sum = 0;
      let count = 0;
      for (let r = 0; r < origins.length; r++) {
        if (!(mask[r] && mask[r][c])) continue;
        const n = numericCellValue(vals[r]?.[c]);
        if (n == null) continue;
        sum += n;
        count += 1;
      }
      td.textContent = count > 0 ? formatCellValue(sum) : "";
      trf.appendChild(td);
    }
    tfoot.appendChild(trf);
    tbl.appendChild(tfoot);
  }

  wrap.appendChild(tbl);

  if (gridEditConfig?.onTableRendered) gridEditConfig.onTableRendered();
  renderChart();
}

export function renderChart() {
  const canvas = document.getElementById("devChart");
  if (!canvas) return;
  setupChartHover(canvas);
  const legendEl = document.getElementById("devChartLegend");
  const originLen = document.getElementById("originLenSelect")?.value || 12;

  // Update title
  const titleEl = document.getElementById("chartTitle");
  if (titleEl) {
    titleEl.textContent = state.chartMode === "byCol"
      ? "By Column (Dev Period)" : "Development Curves";
  }

  // Update toggle active state
  document.querySelectorAll("#chartModeToggle .chartToggleBtn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === state.chartMode);
  });

  const oLen = Number(originLen) || 12;

  renderChartCanvas(canvas, getDisplayDatasetModel(), {
    mode: state.chartMode === "byCol" ? "byCol" : "byRow",
    activeCell: state.activeCell,
    formatValue: formatNum,
    legendEl,
    formatOriginLabel: (l) => formatOriginLabel(l, originLen),
    originLen: oLen,
  });
}

export function redrawChartSafely() {
  const panel = document.getElementById("chartPanel");
  if (!panel) return;

  const rect = panel.getBoundingClientRect();

  // If hidden or collapsed, skip
  if (rect.width < 50 || rect.height < 50) return;

  renderChart();
}

function formatNum(x) {
  if (!isFinite(x)) return "";
  const pattern = getNumberFormatPattern();
  if (pattern) return formatDatasetNumberValue(x, pattern, getDecimalPlaces());
  if (isPercentTriangle()) {
    const dp = getPercentDecimalPlaces();
    return (x * 100).toFixed(dp) + "%";
  }
  const abs = Math.abs(x);
  if (abs >= 1000) return fmt0.format(x);
  return fmt0.format(x);
}

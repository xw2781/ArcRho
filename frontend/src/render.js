// Rendering only: read state.model + state.showBlanks and produce DOM.

import { state } from "./state.js";
import { $ , logLine } from "./dom.js";
import { openContextMenu } from "./menu_utils.js";
import { renderDevChart } from "./chart.js";

let ctxMenuWired = false;

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

function isPercentTriangle() {
  const triInput = document.getElementById("triInput");
  return triInput && triInput.value.includes("%");
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

function ensureCtxMenuWired() {
  if (ctxMenuWired) return;
  ctxMenuWired = true;

  const menu = document.getElementById("ctxMenu");
  if (!menu) return;

  // Click menu item (no real action yet)
  menu.addEventListener("click", (e) => {
    const btn = e.target.closest(".ctx-item");
    if (!btn) return;
    const action = btn.dataset.action || "";
    // Placeholder only
    logLine(`Context menu: ${action}`);
    hideCtxMenu();
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
  const el = document.getElementById("decimalPlaces");
  const n = parseInt(el?.value, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(6, n)); // clamp 0..6
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

  const mode = detectNumberMode();
  const dp = getDecimalPlaces();

  if (mode === "percent") {
    return (n * 100).toFixed(dp) + "%";
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
  if (!maxCols || maxCols >= devs.length) return devs;
  return devs.slice(0, maxCols);
}

export function renderTable() {

  const wrap = $("tableWrap");
  wrap.innerHTML = "";
  ensureCtxMenuWired();

  const model = state.model;
  if (!model) {
    wrap.innerHTML = `<div class="small">No dataset loaded.</div>`;
    return;
  }

  const metaEl = document.getElementById("tableMeta");
  if (metaEl) {
    const path = (document.getElementById("pathInput")?.value || "").trim();
    const tri = (document.getElementById("triInput")?.value || "").trim();
    metaEl.textContent = `${path || ""} | ${tri || ""}`;
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

  // header
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");

  const th0 = document.createElement("th");
  const originLen = document.getElementById("originLenSelect")?.value || 12;
  th0.textContent = getOriginLabelText(originLen);
  trh.appendChild(th0);

  devs.forEach((d, c) => {
    const th = document.createElement("th");
    th.textContent = d;

    th.classList.add("colhdr");
    th.dataset.c = String(c);

    trh.appendChild(th);
  });

  thead.appendChild(trh);
  tbl.appendChild(thead);

  // body
  const tbody = document.createElement("tbody");

  for (let r = 0; r < origins.length; r++) {
    const tr = document.createElement("tr");

    const th = document.createElement("th");
    th.textContent = origins[r];

    th.classList.add("rowhdr");
    th.dataset.r = String(r);

    tr.appendChild(th);

    for (let c = 0; c < devs.length; c++) {
      const td = document.createElement("td");
      const key = `${r},${c}`;

      const hasValue = !!(mask[r] && mask[r][c]);

      if (!hasValue) {
        td.textContent = "";
        if (!state.showBlanks) {
          td.classList.add("na");        // visually hidden
        } else {
          td.style.background = "#fafafa";
        }
      } else {
        const v = vals[r][c];
        td.textContent = formatCellValue(v);

        td.classList.add("cell");
        td.dataset.r = String(r);
        td.dataset.c = String(c);

        td.addEventListener("click", () => {
          state.activeCell = { r, c };
          renderActiveCellUI(); // update formula bar + highlight
          claimDatasetFocus(); 
        });

        td.addEventListener("contextmenu", (e) => {
          e.preventDefault();

          // Optional: right click also selects the cell
          state.activeCell = { r, c };
          renderActiveCellUI();

          showCtxMenu(td, e.clientX, e.clientY);
        });
      }

      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }

  tbl.appendChild(tbody);
  wrap.appendChild(tbl);

  renderActiveCellUI();
  renderChart();
}

export function renderActiveCellUI() {
  const model = state.model;
  if (!model) return;

  const bar = $("formulaBar");
  const ref = $("cellRef");
  const meta = $("cellMeta");

  // clear old active class
  document.querySelectorAll("td.active").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll("th.activeRow").forEach((el) => el.classList.remove("activeRow"));
  document.querySelectorAll("th.activeCol").forEach((el) => el.classList.remove("activeCol"));

  if (!state.activeCell) {
    ref.textContent = "Formula";
    meta.textContent = "";
    bar.value = "";
    return;
  }

  const { r, c } = state.activeCell;

  // highlight selected cell
  const td = document.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
  if (td) td.classList.add("active");

  const rowTh = document.querySelector(`th.rowhdr[data-r="${r}"]`);
  if (rowTh) rowTh.classList.add("activeRow");

  const colTh = document.querySelector(`th.colhdr[data-c="${c}"]`);
  if (colTh) colTh.classList.add("activeCol");

  ref.textContent = `(${model.origin_labels[r]}, ${model.dev_labels[c]})`;
  meta.textContent = `r=${r}, c=${c}`;

  const key = `${r},${c}`;
  if (state.dirty.has(key)) {
    const dv = state.dirty.get(key);
    bar.value = dv === null ? "" : String(dv);
  } else {
    const v = model.values[r][c];
    bar.value = v === null ? "" : String(v);
  }
}

export function renderChart() {
  const canvas = document.getElementById("devChart");
  if (!canvas) return;
  const legendEl = document.getElementById("devChartLegend");
  renderDevChart(canvas, state.model, {
    activeCell: state.activeCell,
    formatValue: formatNum,
    legendEl,
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
  if (isPercentTriangle()) {
    const dp = getDecimalPlaces();
    return (x * 100).toFixed(dp) + "%";
  }
  const abs = Math.abs(x);
  if (abs >= 1000) return fmt0.format(x);
  return fmt0.format(x);
}

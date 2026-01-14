// Rendering only: read state.model + state.showBlanks and produce DOM.

import { state } from "./state.js";
import { $ , logLine } from "./dom.js";

let ctxMenuWired = false;

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

function showCtxMenu(clientX, clientY) {
  const menu = document.getElementById("ctxMenu");
  if (!menu) return;

  menu.style.display = "block";

  // Position with viewport clamp
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Temporarily measure
  const rect = menu.getBoundingClientRect();
  let x = clientX;
  let y = clientY;

  if (x + rect.width > vw) x = Math.max(8, vw - rect.width - 8);
  if (y + rect.height > vh) y = Math.max(8, vh - rect.height - 8);

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

function hideCtxMenu() {
  const menu = document.getElementById("ctxMenu");
  if (!menu) return;
  menu.style.display = "none";
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

  const origins = model.origin_labels;
  const devs = model.dev_labels;
  const vals = model.values;
  const mask = model.mask; // True=has value, False=blank/missing

  if (!Array.isArray(mask)) {
    wrap.innerHTML = `<div style="color:#b00;"><b>UI Error:</b> mask is missing. Update get_dataset to return mask.</div>`;
    return;
  }

  const tbl = document.createElement("table");

  // header
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");

  const th0 = document.createElement("th");
  th0.textContent = "Accident Year";
  trh.appendChild(th0);

  devs.forEach((d, c) => {
    const th = document.createElement("th");
    th.textContent = d;
    th.style.textAlign = "right";

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

      const hasValue = !!mask[r][c];

      if (!hasValue) {
        td.textContent = "";
        if (!state.showBlanks) {
          td.classList.add("na");        // visually hidden
        } else {
          td.style.background = "#fafafa";
        }
      } else {
        const v = vals[r][c];
        td.textContent = (v === null ? "" : String(v));

        td.classList.add("cell");
        td.dataset.r = String(r);
        td.dataset.c = String(c);

        td.addEventListener("click", () => {
          state.activeCell = { r, c };
          renderActiveCellUI(); // update formula bar + highlight
        });

        td.addEventListener("contextmenu", (e) => {
          e.preventDefault();

          // Optional: right click also selects the cell
          state.activeCell = { r, c };
          renderActiveCellUI();

          showCtxMenu(e.clientX, e.clientY);
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
    ref.textContent = "Cell";
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

  const model = state.model;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) {
    const ctx = canvas.getContext("2d");
    resizeCanvasToCSS(canvas);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = "12px Arial";
    ctx.fillText("No data.", 10, 20);
    return;
  }

  const origins = model.origin_labels || [];
  const devs = model.dev_labels || [];
  const vals = model.values;
  const mask = model.mask;

  resizeCanvasToCSS(canvas);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Plot area
  const W = canvas.width;
  const H = canvas.height;
  const padL = 20, padR = 10, padT = 10, padB = 24;
  const x0 = padL, y0 = padT, x1 = W - padR, y1 = H - padB;

  // Collect points and y-range
  let yMin = Infinity, yMax = -Infinity;
  for (let r = 0; r < vals.length; r++) {
    for (let c = 0; c < (vals[r] || []).length; c++) {
      if (mask[r] && mask[r][c]) {
        const v = vals[r][c];
        if (typeof v === "number" && isFinite(v)) {
          yMin = Math.min(yMin, v);
          yMax = Math.max(yMax, v);
        }
      }
    }
  }

  if (!isFinite(yMin) || !isFinite(yMax) || devs.length < 2) {
    ctx.font = "12px Arial";
    ctx.fillText("Not enough data to plot.", 10, 20);
    return;
  }

  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }

  // Axes
  ctx.strokeStyle = "#999";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x0, y1);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  // Y ticks
  ctx.fillStyle = "#333";
  ctx.font = "11px Arial";
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const t = i / yTicks;
    const y = y1 - t * (y1 - y0);
    const v = yMin + t * (yMax - yMin);

    ctx.strokeStyle = "#eee";
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();

    ctx.fillStyle = "#333";
    ctx.fillText(formatNum(v), 6, y + 4);
  }

  // X ticks (use dev labels, but draw a few)
  const xTicks = Math.min(6, devs.length - 1);
  for (let i = 0; i <= xTicks; i++) {
    const idx = Math.round(i * (devs.length - 1) / xTicks);
    const x = x0 + (idx / (devs.length - 1)) * (x1 - x0);

    ctx.strokeStyle = "#eee";
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();

    ctx.fillStyle = "#333";
    ctx.fillText(String(devs[idx]), x - 10, H - 8);
  }

  // Draw curves (one line per origin)
  const palette = ["#d62728","#1f77b4","#2ca02c","#ff7f0e","#9467bd","#8c564b","#e377c2","#7f7f7f","#bcbd22","#17becf"];

  for (let r = 0; r < vals.length; r++) {
    // build curve points
    const pts = [];
    for (let c = 0; c < devs.length; c++) {
      if (mask[r] && mask[r][c]) {
        const v = vals[r][c];
        if (typeof v === "number" && isFinite(v)) {
          const x = x0 + (c / (devs.length - 1)) * (x1 - x0);
          const y = y1 - ((v - yMin) / (yMax - yMin)) * (y1 - y0);
          pts.push([x, y]);
        }
      }
    }
    if (pts.length < 2) continue;

    const color = palette[r % palette.length];

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();

    // draw label at curve end
    const last = pts[pts.length - 1];
    const label = String(origins[r] ?? r);

    if (isFinite(last[0]) && isFinite(last[1])) {
      ctx.font = "12px Arial";
      ctx.fillStyle = color;
      ctx.fillText(label, last[0] + 6, last[1] + 4);
    }
  }

  // If a cell is active, highlight its origin curve point
  if (state.activeCell) {
    const { r, c } = state.activeCell;
    if (mask[r] && mask[r][c] && typeof vals[r][c] === "number") {
      const v = vals[r][c];
      const x = x0 + (c / (devs.length - 1)) * (x1 - x0);
      const y = y1 - ((v - yMin) / (yMax - yMin)) * (y1 - y0);

      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.font = "12px Arial";
      ctx.fillText(`${origins[r] ?? r} @ ${devs[c]} = ${formatNum(v)}`, x0 + 8, y0 + 16);
    }
  }
}

function resizeCanvasToCSS(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function formatNum(x) {
  if (!isFinite(x)) return "";
  // compact-ish formatting
  const abs = Math.abs(x);
  if (abs >= 1000) return Math.round(x).toLocaleString();
  return (Math.round(x * 100) / 100).toString();
}

// Shared chart rendering (dataset-style development curves).

const DEFAULT_PALETTE = [
  "#d62728","#1f77b4","#2ca02c","#ff7f0e","#9467bd",
  "#8c564b","#e377c2","#7f7f7f","#bcbd22","#17becf"
];

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

export function renderDevChart(canvas, model, opts = {}) {
  if (!canvas) return;

  const formatValue = typeof opts.formatValue === "function"
    ? opts.formatValue
    : (v) => (Number.isFinite(v) ? String(v) : "");
  const palette = Array.isArray(opts.palette) && opts.palette.length
    ? opts.palette
    : DEFAULT_PALETTE;
  const legendEnabled = opts.showLegend !== false;
  const legendWidth = Number.isFinite(opts.legendWidth) ? opts.legendWidth : 140;
  const legendEl = opts.legendEl || null;
  const legendState = legendEl ? getLegendState(legendEl) : null;
  if (legendEl) {
    legendEl.__chartLastRender = () => renderDevChart(canvas, model, opts);
  }

  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) {
    const ctx = canvas.getContext("2d");
    resizeCanvasToCSS(canvas);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = "12px Arial";
    ctx.fillText("No data.", 10, 20);
    return;
  }

  const origins = model.origin_labels || [];
  const devs = getEffectiveDevLabels(model);
  const vals = model.values;
  const mask = model.mask;

  resizeCanvasToCSS(canvas);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const W = canvas.width;
  const H = canvas.height;
  const padL = 20, padR = 10, padT = 10, padB = 24;
  const legendPad = legendEnabled ? legendWidth : 0;
  const x0 = padL, y0 = padT, x1 = W - padR - legendPad, y1 = H - padB;

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
    ctx.fillText(formatValue(v), 6, y + 4);
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
  for (let r = 0; r < vals.length; r++) {
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

    const selectedIndex = legendState?.selectedIndex ?? null;
    const hoverIndex = legendState?.hoverIndex ?? null;
    if (selectedIndex !== null && r !== selectedIndex) {
      continue;
    }

    const color = palette[r % palette.length];

    let alpha = 1;
    if (selectedIndex === null && hoverIndex !== null && r !== hoverIndex) {
      alpha = 0.15;
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = r === hoverIndex || r === selectedIndex ? 2.5 : 2;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    ctx.restore();

    if (!legendEl) {
      const last = pts[pts.length - 1];
      const label = String(origins[r] ?? r);
      if (isFinite(last[0]) && isFinite(last[1])) {
        ctx.font = "12px Arial";
        ctx.fillStyle = color;
        const pad = 6;
        let labelX = x1 + pad;
        ctx.textAlign = "left";
        if (labelX > W - pad) {
          labelX = W - pad;
          ctx.textAlign = "right";
        }
        ctx.fillText(label, labelX, last[1] + 4);
        ctx.textAlign = "left";
      }
    }
  }

  // Legend panel (right side)
  if (legendEnabled && !legendEl) {
    const panelX0 = x1 + 10;
    const panelX1 = W - padR;
    const panelW = Math.max(0, panelX1 - panelX0);
    if (panelW > 30) {
      ctx.save();
      ctx.fillStyle = "#fafafa";
      ctx.strokeStyle = "#e5e5e5";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(panelX0, y0, panelW, y1 - y0);
      ctx.fill();
      ctx.stroke();

      const rowH = 16;
      const swatch = 10;
      const textX = panelX0 + swatch + 10;
      let y = y0 + 14;
      ctx.font = "11px Arial";
      ctx.fillStyle = "#333";

      for (let r = 0; r < origins.length; r++) {
        if (y > y1 - 6) break;
        const color = palette[r % palette.length];
        ctx.fillStyle = color;
        ctx.fillRect(panelX0 + 6, y - 8, swatch, swatch);
        ctx.fillStyle = "#333";
        const label = String(origins[r] ?? r);
        ctx.fillText(label, textX, y);
        y += rowH;
      }
      ctx.restore();
    }
  }

  // HTML legend panel (preferred, supports scrolling)
  if (legendEnabled && legendEl) {
    const rows = origins.length || 0;
    const availH = legendEl.clientHeight || 0;
    let rowH = 16;
    if (availH > 0 && rows > 0) {
      rowH = Math.max(12, Math.floor(availH / rows));
    }
    const fontSize = Math.min(14, Math.max(9, rowH - 4));
    legendEl.style.fontSize = `${fontSize}px`;
    legendEl.innerHTML = "";
    for (let r = 0; r < origins.length; r++) {
      const item = document.createElement("div");
      item.className = "legendItem";
      item.style.height = `${rowH}px`;
      item.dataset.index = String(r);
      if (legendState?.selectedIndex === r) item.classList.add("is-selected");
      if (legendState?.hoverIndex === r) item.classList.add("is-hover");
      const swatch = document.createElement("span");
      swatch.className = "legendSwatch";
      swatch.style.background = palette[r % palette.length];
      const label = document.createElement("span");
      label.className = "legendLabel";
      label.textContent = String(origins[r] ?? r);
      item.appendChild(swatch);
      item.appendChild(label);
      legendEl.appendChild(item);
    }
  }

  // Active cell highlight
  const active = opts.activeCell;
  if (active && Number.isFinite(active.r) && Number.isFinite(active.c)) {
    const r = active.r;
    const c = active.c;
    if (mask[r] && mask[r][c] && typeof vals[r][c] === "number") {
      const v = vals[r][c];
      const x = x0 + (c / (devs.length - 1)) * (x1 - x0);
      const y = y1 - ((v - yMin) / (yMax - yMin)) * (y1 - y0);

      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.font = "12px Arial";
      ctx.fillText(`${origins[r] ?? r} @ ${devs[c]} = ${formatValue(v)}`, x0 + 8, y0 + 16);
    }
  }
}

function getLegendState(legendEl) {
  if (!legendEl) return null;
  if (!legendEl.__chartLegendState) {
    legendEl.__chartLegendState = {
      hoverIndex: null,
      selectedIndex: null,
    };
    legendEl.addEventListener("mouseover", (event) => {
      const item = event.target.closest(".legendItem");
      if (!item || !legendEl.contains(item)) return;
      const idx = Number(item.dataset.index);
      const state = legendEl.__chartLegendState;
      if (!Number.isFinite(idx)) return;
      if (state.selectedIndex !== null) return;
      if (state.hoverIndex === idx) return;
      state.hoverIndex = idx;
      triggerLegendRedraw(legendEl);
    });
    legendEl.addEventListener("mouseout", (event) => {
      const related = event.relatedTarget;
      if (related && legendEl.contains(related)) return;
      const state = legendEl.__chartLegendState;
      if (state.hoverIndex === null) return;
      state.hoverIndex = null;
      triggerLegendRedraw(legendEl);
    });
    legendEl.addEventListener("click", (event) => {
      const item = event.target.closest(".legendItem");
      if (!item || !legendEl.contains(item)) return;
      const idx = Number(item.dataset.index);
      if (!Number.isFinite(idx)) return;
      const state = legendEl.__chartLegendState;
      state.selectedIndex = state.selectedIndex === idx ? null : idx;
      state.hoverIndex = null;
      triggerLegendRedraw(legendEl);
    });
  }
  return legendEl.__chartLegendState;
}

function triggerLegendRedraw(legendEl) {
  if (legendEl.__chartLastRender) {
    legendEl.__chartLastRender();
  }
}

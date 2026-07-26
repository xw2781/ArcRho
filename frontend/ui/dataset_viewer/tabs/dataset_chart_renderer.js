// Dataset Viewer chart renderer.

import { renderChartLegend } from "../../shared/components/chart_legend/chart_legend.js?v=20260724a";

const DEFAULT_PALETTE = [
  "#d62728","#1f77b4","#2ca02c","#ff7f0e","#9467bd",
  "#8c564b","#e377c2","#7f7f7f","#bcbd22","#17becf"
];
const renderedChartCanvases = new Set();

function getChartColor(propertyName, fallback) {
  return window.ArcRhoColorTheme?.getCssColor?.(propertyName, fallback) || fallback;
}

function paintChartBackground(ctx, width, height) {
  ctx.fillStyle = getChartColor("--ar-chart-background", "#ffffff");
  ctx.fillRect(0, 0, width, height);
}

window.addEventListener("arcrho:color-theme-changed", () => {
  for (const canvas of renderedChartCanvases) {
    if (!canvas.isConnected) {
      renderedChartCanvases.delete(canvas);
      continue;
    }
    canvas.__chartRedraw?.();
  }
});

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

// --- Shared: measure left padding needed for Y-axis labels ---
function measurePadL(ctx, yTicks, formatValue) {
  ctx.font = "11px Arial";
  let maxW = 0;
  for (const v of yTicks) {
    const w = ctx.measureText(formatValue(v)).width;
    if (w > maxW) maxW = w;
  }
  return Math.ceil(maxW) + 8; // 8px gap after label
}

// --- Shared: draw X-axis labels, rotated 90° if rotated=true ---
function drawXLabels(ctx, labels, indices, getX, H, x0, x1, rotated) {
  ctx.fillStyle = getChartColor("--ar-chart-dataset-text", "#333333");
  ctx.font = "11px Arial";
  if (rotated) {
    for (const idx of indices) {
      const x = getX(idx);
      const text = String(labels[idx]);
      ctx.save();
      ctx.translate(x + 4, H - 6);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "left";
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
  } else {
    for (const idx of indices) {
      const x = getX(idx);
      const text = String(labels[idx]);
      const tw = ctx.measureText(text).width;
      let tx = x - tw / 2;
      if (tx < 2) tx = 2;
      if (tx + tw > x1 + 10) tx = x1 + 10 - tw;
      ctx.fillText(text, tx, H - 8);
    }
  }
}

// --- Shared: measure max X-label width (for rotated padding) ---
function measureMaxXLabelWidth(ctx, labels) {
  ctx.font = "11px Arial";
  let maxW = 0;
  for (const l of labels) {
    const w = ctx.measureText(String(l)).width;
    if (w > maxW) maxW = w;
  }
  return Math.ceil(maxW);
}

// --- Shared: compute nice tick step for ~targetTicks labels ---
function niceStep(range, targetTicks) {
  const rough = range / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  let step;
  if (norm <= 1)        step = 1 * mag;
  else if (norm <= 2)   step = 2 * mag;
  else if (norm <= 2.5) step = 2.5 * mag;
  else if (norm <= 5)   step = 5 * mag;
  else                  step = 10 * mag;
  return step;
}

// --- Shared: compute nice y-axis ticks (array of values) ---
function computeNiceTicks(yMin, yMax, targetTicks) {
  if (!isFinite(yMin) || !isFinite(yMax) || yMin >= yMax) return null;
  const step = niceStep(yMax - yMin, targetTicks);
  const niceMin = Math.floor(yMin / step) * step;
  const niceMax = Math.ceil(yMax / step) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step * 0.001; v += step) {
    ticks.push(v);
  }
  return { ticks, niceMin, niceMax };
}

// --- Shared: compute y-range with 5% margin, respecting hidden lines ---
function computeYRange(vals, mask, lineCount, pointCount, getRC, hiddenSet) {
  let yMin = Infinity, yMax = -Infinity;
  for (let line = 0; line < lineCount; line++) {
    if (hiddenSet.has(line)) continue;
    for (let pt = 0; pt < pointCount; pt++) {
      const { r, c } = getRC(line, pt);
      if (mask[r] && mask[r][c]) {
        const v = vals[r][c];
        if (typeof v === "number" && isFinite(v)) {
          yMin = Math.min(yMin, v);
          yMax = Math.max(yMax, v);
        }
      }
    }
  }
  if (!isFinite(yMin) || !isFinite(yMax)) return null;
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  // Add 5% margin, then snap to nice ticks
  const margin = (yMax - yMin) * 0.05;
  const nice = computeNiceTicks(yMin - margin, yMax + margin, 10);
  if (!nice) return null;
  return { yMin: nice.niceMin, yMax: nice.niceMax, yTicks: nice.ticks };
}

// --- Shared: store hit-test points for hover tooltip ---
function storeHitPoints(canvas, allPts) {
  canvas.__chartHitPts = allPts; // [{px, py, label, value}]
}

// --- Shared: draw markers on each data point ---
function drawMarkers(ctx, pts, color, radius) {
  ctx.fillStyle = color;
  for (const [x, y] of pts) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ============================================================
//  renderChart  (unified: byRow or byCol)
//
//  mode "byRow" = one line per origin (X = dev periods)
//  mode "byCol" = one line per dev period (X = origins)
// ============================================================
export function renderChart(canvas, model, opts = {}) {
  if (!canvas) return;
  renderedChartCanvases.add(canvas);
  canvas.__chartRedraw = () => renderChart(canvas, model, opts);

  const mode = opts.mode || "byRow"; // "byRow" | "byCol"
  const byCol = mode === "byCol";

  const formatValue = typeof opts.formatValue === "function"
    ? opts.formatValue
    : (v) => (Number.isFinite(v) ? String(v) : "");
  const palette = Array.isArray(opts.palette) && opts.palette.length
    ? opts.palette
    : DEFAULT_PALETTE;
  const legendEnabled = opts.showLegend !== false;
  const legendEl = opts.legendEl || null;
  const legendState = legendEl ? getLegendState(legendEl) : null;
  if (legendEl) {
    // Strip _skipLegend so stored closures always use clean opts
    const { _skipLegend: _, ...baseOpts } = opts;
    legendEl.__chartLastRender = () => renderChart(canvas, model, baseOpts);
    legendEl.__chartRedrawCanvas = () => renderChart(canvas, model, { ...baseOpts, _skipLegend: true });
  }
  const formatOriginLabel = opts.formatOriginLabel || ((l) => l);
  const hiddenSet = legendState?.hiddenSet || new Set();
  const originLen = Number(opts.originLen) || 12;
  const rotateX = originLen <= 6;

  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) {
    const ctx = canvas.getContext("2d");
    resizeCanvasToCSS(canvas);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    paintChartBackground(ctx, canvas.width, canvas.height);
    ctx.font = "12px Arial";
    ctx.fillStyle = getChartColor("--ar-chart-dataset-status-text", "#000000");
    ctx.fillText("No data.", 10, 20);
    return;
  }

  const origins = model.origin_labels || [];
  const devs = getEffectiveDevLabels(model);
  const vals = model.values;
  const mask = model.mask;

  // Dimension mapping based on mode
  const lines      = byCol ? devs : origins;       // one line per...
  const lineCount  = lines.length;

  // byRow: prepend a dummy "0m" column so curves start from 0
  const ptOffset   = byCol ? 0 : 1; // data point index offset (1 for dummy col)
  const xLabels    = byCol ? origins : ["0m", ...devs];
  const pointCount = xLabels.length;
  const getRC      = byCol
    ? (line, pt) => ({ r: pt, c: line })
    : (line, pt) => ({ r: line, c: pt - ptOffset });

  // Format X-axis labels (apply origin formatting when byCol)
  const formattedXLabels = byCol
    ? origins.map(o => formatOriginLabel(String(o)))
    : xLabels.map(String);

  resizeCanvasToCSS(canvas);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  paintChartBackground(ctx, canvas.width, canvas.height);

  const W = canvas.width;
  const H = canvas.height;
  const padR = 10, padT = 10;
  const padB = rotateX ? (measureMaxXLabelWidth(ctx, formattedXLabels) + 10) : 24;

  // y-range based on visible lines only (with nice ticks)
  // For byRow, compute range from actual data columns only, then include 0
  const dataPointCount = byCol ? pointCount : devs.length;
  const dataGetRC = byCol ? getRC : (line, pt) => ({ r: line, c: pt });
  const yRange = computeYRange(vals, mask, lineCount, dataPointCount, dataGetRC, hiddenSet);
  if (yRange && !byCol) {
    // Ensure 0 is included in the range (for the dummy "0m" column)
    yRange.yMin = Math.min(yRange.yMin, 0);
    if (yRange.yMax < 0) yRange.yMax = 0;
    // Recompute nice ticks with 0 included
    const nice = computeNiceTicks(yRange.yMin, yRange.yMax, 10);
    if (nice) {
      yRange.yMin = nice.niceMin;
      yRange.yMax = nice.niceMax;
      yRange.yTicks = nice.ticks;
    }
  }

  if (!yRange || pointCount < 2) {
    ctx.font = "12px Arial";
    ctx.fillStyle = getChartColor("--ar-chart-dataset-status-text", "#000000");
    ctx.fillText("Not enough data to plot.", 10, 20);
    return;
  }
  const { yMin, yMax, yTicks } = yRange;

  const padL = measurePadL(ctx, yTicks, formatValue);
  const x0 = padL, y0 = padT, x1 = W - padR, y1 = H - padB;
  const getX = (idx) => x0 + (idx / (pointCount - 1)) * (x1 - x0);

  // Axes
  ctx.strokeStyle = getChartColor("--ar-chart-dataset-axis", "#999999");
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, y0); ctx.lineTo(x0, y1); ctx.lineTo(x1, y1);
  ctx.stroke();

  // Y ticks
  ctx.fillStyle = getChartColor("--ar-chart-dataset-text", "#333333"); ctx.font = "11px Arial";
  for (const v of yTicks) {
    const t = (v - yMin) / (yMax - yMin);
    const y = y1 - t * (y1 - y0);
    ctx.strokeStyle = getChartColor("--ar-chart-dataset-grid", "#eeeeee");
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    ctx.fillStyle = getChartColor("--ar-chart-dataset-text", "#333333");
    ctx.fillText(formatValue(v), 6, y + 4);
  }

  // X ticks (limit to 40 labels max)
  const MAX_X_LABELS = 40;
  const xIndices = [];
  if (pointCount <= MAX_X_LABELS) {
    for (let i = 0; i < pointCount; i++) xIndices.push(i);
  } else {
    for (let i = 0; i < MAX_X_LABELS; i++) {
      xIndices.push(Math.round(i * (pointCount - 1) / (MAX_X_LABELS - 1)));
    }
  }
  for (const idx of xIndices) {
    const x = getX(idx);
    ctx.strokeStyle = getChartColor("--ar-chart-dataset-grid", "#eeeeee");
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
  }
  drawXLabels(ctx, formattedXLabels, xIndices, getX, H, x0, x1, rotateX);

  // Draw curves
  const allHitPts = [];
  for (let line = 0; line < lineCount; line++) {
    if (hiddenSet.has(line)) continue;

    const pts = [];
    const ptsMeta = [];
    const color = palette[line % palette.length];

    // byRow: prepend dummy point at x=0, y=0
    if (!byCol) {
      const x = getX(0);
      const y = y1 - ((0 - yMin) / (yMax - yMin)) * (y1 - y0);
      pts.push([x, y]);
      ptsMeta.push({ px: x, py: y, label: `${origins[line]} @ 0m`, value: formatValue(0), color });
    }

    for (let pt = (byCol ? 0 : ptOffset); pt < pointCount; pt++) {
      const { r, c } = getRC(line, pt);
      if (mask[r] && mask[r][c]) {
        const v = vals[r][c];
        if (typeof v === "number" && isFinite(v)) {
          const x = getX(pt);
          const y = y1 - ((v - yMin) / (yMax - yMin)) * (y1 - y0);
          pts.push([x, y]);
          const lbl = byCol
            ? `${devs[c]} @ ${formatOriginLabel(String(origins[r]))}`
            : `${origins[r]} @ ${devs[c]}`;
          ptsMeta.push({ px: x, py: y, label: lbl, value: formatValue(v), color });
        }
      }
    }
    if (pts.length < 2) continue;

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    drawMarkers(ctx, pts, color, 3);

    for (const m of ptsMeta) allHitPts.push(m);
  }

  storeHitPoints(canvas, allHitPts);

  // Draw enlarged marker for hovered point
  const hoverPt = canvas.__chartHoverPt;
  if (hoverPt) {
    const match = allHitPts.find(p => p.px === hoverPt.px && p.py === hoverPt.py);
    if (match) {
      canvas.__chartHoverPt = match;
      ctx.fillStyle = match.color;
      ctx.beginPath(); ctx.arc(match.px, match.py, 4.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  // HTML legend with checkboxes
  if (legendEnabled && legendEl && !opts._skipLegend) {
    renderChartLegend({
      listElement: legendEl,
      countElement: document.getElementById("devChartLegendCount"),
      series: lines.map((label, index) => ({
        id: index,
        label: String(label ?? index),
        color: palette[index % palette.length],
      })),
      hiddenIds: hiddenSet,
      onVisibilityChange: () => triggerLegendRedraw(legendEl),
    });
  }

  // Active cell highlight
  const active = opts.activeCell;
  if (active && Number.isFinite(active.r) && Number.isFinite(active.c)) {
    const r = active.r, c = active.c;
    const lineIdx = byCol ? c : r;
    const ptIdx   = byCol ? r : c + ptOffset;
    if (!hiddenSet.has(lineIdx) && mask[r] && mask[r][c] && typeof vals[r][c] === "number") {
      const v = vals[r][c];
      const x = getX(ptIdx);
      const y = y1 - ((v - yMin) / (yMax - yMin)) * (y1 - y0);
      ctx.fillStyle = getChartColor("--ar-chart-dataset-strong-text", "#000000");
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.font = "12px Arial";
      const lbl = byCol
        ? `${devs[c]} @ ${formatOriginLabel(String(origins[r]))} = ${formatValue(v)}`
        : `${origins[r] ?? r} @ ${devs[c]} = ${formatValue(v)}`;
      ctx.fillText(lbl, x0 + 8, y0 + 16);
    }
  }
}

// Keep legacy exports as thin wrappers for backward compatibility
export function renderDevChart(canvas, model, opts = {}) {
  renderChart(canvas, model, { ...opts, mode: "byRow" });
}

export function renderColChart(canvas, model, opts = {}) {
  renderChart(canvas, model, { ...opts, mode: "byCol" });
}

// ============================================================
//  Legend state management
// ============================================================
function getLegendState(legendEl) {
  if (!legendEl) return null;
  if (!legendEl.__chartLegendState) {
    legendEl.__chartLegendState = {
      hiddenSet: new Set(),
    };
  }
  return legendEl.__chartLegendState;
}

function triggerLegendRedraw(legendEl) {
  if (legendEl.__chartLastRender) {
    legendEl.__chartLastRender();
  }
}

// ============================================================
//  Canvas hover tooltip (shared setup)
// ============================================================
export function setupChartHover(canvas) {
  if (!canvas || canvas.__chartHoverSetup) return;
  canvas.__chartHoverSetup = true;

  let tooltip = document.getElementById("chartTooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "chartTooltip";
    tooltip.className = "chartTooltip";
    document.body.appendChild(tooltip);
  }

  canvas.addEventListener("mousemove", (e) => {
    const hitPts = canvas.__chartHitPts;
    if (!hitPts || !hitPts.length) { tooltip.style.display = "none"; return; }

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const mx = (e.clientX - rect.left) * dpr;
    const my = (e.clientY - rect.top) * dpr;

    // Find closest point within threshold
    let best = null, bestDist = 15 * dpr; // 15px threshold
    for (const pt of hitPts) {
      const dx = pt.px - mx, dy = pt.py - my;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestDist) { bestDist = d; best = pt; }
    }

    const prevHover = canvas.__chartHoverPt;
    if (best) {
      tooltip.textContent = `${best.label} = ${best.value}`;
      tooltip.style.display = "block";
      // Position tooltip near cursor
      const tx = e.clientX + 12;
      const ty = e.clientY - 28;
      tooltip.style.left = `${tx}px`;
      tooltip.style.top = `${ty}px`;
      if (prevHover !== best) {
        canvas.__chartHoverPt = best;
        if (canvas.__chartRedraw) canvas.__chartRedraw();
      }
    } else {
      tooltip.style.display = "none";
      if (prevHover) {
        canvas.__chartHoverPt = null;
        if (canvas.__chartRedraw) canvas.__chartRedraw();
      }
    }
  });

  canvas.addEventListener("mouseleave", () => {
    tooltip.style.display = "none";
    if (canvas.__chartHoverPt) {
      canvas.__chartHoverPt = null;
      if (canvas.__chartRedraw) canvas.__chartRedraw();
    }
  });
}

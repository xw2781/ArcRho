/*
===============================================================================
DFM Ratios Chart - popup chart modal rendering and interactions
===============================================================================
*/
import {
  state,
  calcRatio, formatRatio, computeAverageForColumn,
  ratioStrikeSet, selectedSummaryByCol,
  ratioChartThresholdByCol, ratioChartLowerThresholdByCol,
  ratioChartLeftThresholdByCol,
  summaryRowMap,
  getRatioChartCol, setRatioChartCol,
  getRatioChartRaf, setRatioChartRaf,
  getRatioChartWired, setRatioChartWired,
  getRatioChartPoints, setRatioChartPoints,
  getRatioChartScale, setRatioChartScale,
  getRatioChartDragActive, setRatioChartDragActive,
  getRatioChartDragMoved, setRatioChartDragMoved,
  getRatioChartHoverLine, setRatioChartHoverLine,
  getRatioChartDragTarget, setRatioChartDragTarget,
  getRatioChartHoverTimer, setRatioChartHoverTimer,
  getRatioChartHoverKey, setRatioChartHoverKey,
  getRatioChartTooltipVisible, setRatioChartTooltipVisible,
  getEffectiveDevLabelsForModel, getRatioHeaderLabels,
  getOriginLabelTextForRatio, buildSummaryRows, getDfmDecimalPlaces,
  buildExcludedSetForColumn,
} from "/ui/dfm/dfm_state.js";
import {
  isUserEntryConfig,
  getUserEntryValueForCol,
  scheduleRatioSummaryUpdate,
} from "/ui/dfm/dfm_ratios_summary_table.js?v=20260713f";
import {
  beginRatioHistoryAction,
  cancelRatioHistoryAction,
  commitRatioHistoryAction,
} from "/ui/dfm/dfm_ratio_history.js";

let _onRatioStateMutated = () => {};
let ratioChartProtectedExclusionKeys = new Set();
let ratioChartThresholdExclusionKeys = new Set();
let ratioChartDragAxisRange = null;
let ratioChartYAxisRangeByCol = new Map();
let ratioChartAxisDragPreview = null;
let ratioChartAxisDragStart = null;

export function setRatioChartCallbacks({ onRatioStateMutated } = {}) {
  if (typeof onRatioStateMutated === "function") _onRatioStateMutated = onRatioStateMutated;
}

function isRatioKeyForColumn(key, col) {
  const parts = String(key || "").split(",");
  return Number(parts[1]) === col;
}

function clearRatioChartSessionExclusionMemory() {
  ratioChartProtectedExclusionKeys.clear();
  ratioChartThresholdExclusionKeys.clear();
  ratioChartDragAxisRange = null;
  ratioChartAxisDragPreview = null;
  ratioChartAxisDragStart = null;
}

function snapshotProtectedExclusionsForChartColumn(col) {
  clearRatioChartSessionExclusionMemory();
  for (const key of ratioStrikeSet) {
    if (isRatioKeyForColumn(key, col)) ratioChartProtectedExclusionKeys.add(key);
  }
}

function reconcileProtectedExclusionsForChartColumn(col) {
  if (col == null) return;
  for (const key of ratioStrikeSet) {
    if (!isRatioKeyForColumn(key, col)) continue;
    if (!ratioChartThresholdExclusionKeys.has(key)) {
      ratioChartProtectedExclusionKeys.add(key);
    }
  }
  for (const key of [...ratioChartProtectedExclusionKeys]) {
    if (!ratioStrikeSet.has(key)) ratioChartProtectedExclusionKeys.delete(key);
  }
  for (const key of [...ratioChartThresholdExclusionKeys]) {
    if (!ratioStrikeSet.has(key)) ratioChartThresholdExclusionKeys.delete(key);
  }
}

function rememberThresholdExcludedKey(key) {
  if (ratioChartProtectedExclusionKeys.has(key)) return;
  ratioChartThresholdExclusionKeys.add(key);
}

function rememberManualChartExclusionToggle(key, excluded) {
  ratioChartThresholdExclusionKeys.delete(key);
  if (excluded) {
    ratioChartProtectedExclusionKeys.add(key);
  } else {
    ratioChartProtectedExclusionKeys.delete(key);
  }
}

// =============================================================================
// Ratio Chart Modal
// =============================================================================
function getRatioChartModalEl() {
  return document.getElementById("dfmRatioChartModal");
}

function getRatioChartCanvas() {
  return document.getElementById("dfmRatioChartCanvas");
}

export function isRatioChartOpen() {
  const modal = getRatioChartModalEl();
  return !!modal && modal.classList.contains("open");
}

function getRatioColumnLabel(col) {
  const model = state.model;
  const devs = getEffectiveDevLabelsForModel(model || {});
  const ratioLabels = getRatioHeaderLabels(devs);
  const label = ratioLabels[col] || "";
  return label ? `(${col + 1}) ${label}` : `Column ${col + 1}`;
}

function getSelectedSummaryConfigForCol(col) {
  const rows = buildSummaryRows();
  const defaultRowId = rows[0]?.id || "";
  const rowId = selectedSummaryByCol.get(col) || defaultRowId;
  return rowId ? summaryRowMap.get(rowId) : null;
}

function resolveUserEntryToSourceConfig(cfg, col) {
  // If cfg is a user entry whose formula references a known summary row,
  // return that row's config so the chart can show which points it uses.
  if (!cfg || !isUserEntryConfig(cfg)) return null;
  const inputs = cfg.inputs ?? cfg.formulas;
  if (!Array.isArray(inputs)) return null;
  const raw = String(inputs[col] ?? "").trim();
  if (!raw) return null;
  // Find referenced summary row labels in the formula
  for (const [rowId, rowCfg] of summaryRowMap) {
    if (isUserEntryConfig(rowCfg)) continue;
    const label = String(rowCfg.label || "").trim();
    if (!label) continue;
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`["']${escaped}["']`, "i").test(raw) || new RegExp(escaped, "i").test(raw)) {
      return rowCfg;
    }
  }
  return null;
}

function buildUsedRowSetForColumn(model, col, cfg, excludedSet) {
  const used = new Set();
  if (!cfg) return used;
  if (isUserEntryConfig(cfg)) {
    // Resolve to the underlying summary method if formula references one
    const sourceCfg = resolveUserEntryToSourceConfig(cfg, col);
    if (sourceCfg) return buildUsedRowSetForColumn(model, col, sourceCfg, excludedSet);
    return used;
  }
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) return used;

  const vals = model.values;
  const mask = model.mask;
  const rowCount = Array.isArray(model.origin_labels) ? model.origin_labels.length : vals.length;
  const periodsRaw = cfg?.periods ?? "all";
  const periods = typeof periodsRaw === "string" && periodsRaw.toLowerCase() === "all"
    ? "all"
    : Number(periodsRaw);
  const lookback = Number.isFinite(periods) && periods > 0 ? Math.floor(periods) : null;

  const includeRow = (r) => {
    const hasA = !!(mask[r] && mask[r][col]);
    const hasB = !!(mask[r] && mask[r][col + 1]);
    if (!hasA || !hasB) return null;
    const ratio = calcRatio(vals?.[r]?.[col], vals?.[r]?.[col + 1]);
    if (!Number.isFinite(ratio)) return null;
    return ratio;
  };

  if (lookback) {
    let picked = 0;
    for (let r = rowCount - 1; r >= 0; r--) {
      if (picked >= lookback) break;
      const ratio = includeRow(r);
      if (!Number.isFinite(ratio)) continue;
      if (excludedSet && excludedSet.has(`${r},${col}`)) continue;
      picked += 1;
      used.add(r);
    }
  } else {
    for (let r = 0; r < rowCount; r++) {
      const ratio = includeRow(r);
      if (!Number.isFinite(ratio)) continue;
      if (excludedSet && excludedSet.has(`${r},${col}`)) continue;
      used.add(r);
    }
  }

  return used;
}

function getThresholdValueForCol(col, fallback) {
  const raw = ratioChartThresholdByCol.get(col);
  if (Number.isFinite(raw)) return raw;
  const next = Number.isFinite(fallback) ? fallback : null;
  if (next != null) ratioChartThresholdByCol.set(col, next);
  return next;
}

function setThresholdValueForCol(col, value) {
  if (!Number.isFinite(value)) return;
  ratioChartThresholdByCol.set(col, value);
}

function getLowerThresholdValueForCol(col, fallback) {
  const raw = ratioChartLowerThresholdByCol.get(col);
  if (Number.isFinite(raw)) return raw;
  const next = Number.isFinite(fallback) ? fallback : null;
  if (next != null) ratioChartLowerThresholdByCol.set(col, next);
  return next;
}

function setLowerThresholdValueForCol(col, value) {
  if (!Number.isFinite(value)) return;
  ratioChartLowerThresholdByCol.set(col, value);
}

function getLeftThresholdIndexForCol(col, fallback) {
  const raw = ratioChartLeftThresholdByCol.get(col);
  if (Number.isFinite(raw)) return raw;
  const next = Number.isFinite(fallback) ? fallback : 0;
  ratioChartLeftThresholdByCol.set(col, next);
  return next;
}

function setLeftThresholdIndexForCol(col, value) {
  if (!Number.isFinite(value)) return;
  ratioChartLeftThresholdByCol.set(col, Math.max(0, value));
}

function syncRatioColumnStrikeCells(col) {
  const cells = document.querySelectorAll(
    `#ratioWrap table.ratioMainTable td.ratioCell[data-col="${col}"][data-r]`
  );
  cells.forEach((cell) => {
    const r = cell.dataset.r;
    if (r == null) return;
    const key = `${r},${col}`;
    cell.classList.toggle("strike", ratioStrikeSet.has(key));
  });
}

export function resetRatioChartThresholds() {
  ratioChartThresholdByCol.clear();
  ratioChartLowerThresholdByCol.clear();
  ratioChartLeftThresholdByCol.clear();
  clearRatioChartSessionExclusionMemory();
  setRatioChartHoverLine(null);
  setRatioChartDragTarget(null);
  setRatioChartDragActive(false);
  setRatioChartDragMoved(false);
  clearRatioChartHover();
  if (isRatioChartOpen()) scheduleRatioChartRender();
}

function isLeftOfThreshold(rowIndex, rowCount, cutoffIndex) {
  const cutoff = Number.isFinite(cutoffIndex) ? Math.max(0, cutoffIndex) : 0;
  const span = Math.max(1, rowCount - 1);
  const cutoffT = cutoff / span;
  const pointT = rowCount <= 1 ? 0.5 : rowIndex / span;
  return pointT < cutoffT;
}

function applyCurrentThresholdExclusions(col) {
  const model = state.model;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) return;
  const devs = getEffectiveDevLabelsForModel(model);
  if (col < 0 || col >= devs.length - 1) return;
  reconcileProtectedExclusionsForChartColumn(col);
  const vals = model.values;
  const mask = model.mask;
  const rowCount = Array.isArray(model.origin_labels) ? model.origin_labels.length : vals.length;
  let upper = getThresholdValueForCol(col);
  let lower = getLowerThresholdValueForCol(col);
  const leftCutoffIndex = getLeftThresholdIndexForCol(col, 0);
  if (Number.isFinite(upper) && Number.isFinite(lower) && upper < lower) {
    const tmp = upper;
    upper = lower;
    lower = tmp;
  }

  let changed = false;
  for (let r = 0; r < rowCount; r++) {
    const key = `${r},${col}`;
    if (ratioChartProtectedExclusionKeys.has(key)) continue;
    const hasA = !!(mask[r] && mask[r][col]);
    const hasB = !!(mask[r] && mask[r][col + 1]);
    if (!hasA || !hasB) {
      if (ratioChartThresholdExclusionKeys.has(key)) {
        ratioChartThresholdExclusionKeys.delete(key);
        if (ratioStrikeSet.delete(key)) changed = true;
      }
      continue;
    }
    const ratio = calcRatio(vals?.[r]?.[col], vals?.[r]?.[col + 1]);
    if (!Number.isFinite(ratio)) {
      if (ratioChartThresholdExclusionKeys.has(key)) {
        ratioChartThresholdExclusionKeys.delete(key);
        if (ratioStrikeSet.delete(key)) changed = true;
      }
      continue;
    }
    const shouldExclude =
      (Number.isFinite(upper) && ratio > upper) ||
      (Number.isFinite(lower) && ratio < lower) ||
      isLeftOfThreshold(r, rowCount, leftCutoffIndex);
    if (shouldExclude) {
      if (!ratioStrikeSet.has(key)) {
        ratioStrikeSet.add(key);
        changed = true;
      }
      rememberThresholdExcludedKey(key);
    } else if (ratioChartThresholdExclusionKeys.has(key)) {
      ratioChartThresholdExclusionKeys.delete(key);
      if (ratioStrikeSet.delete(key)) changed = true;
    }
  }

  syncRatioColumnStrikeCells(col);
  if (changed) {
    scheduleRatioSummaryUpdate();
    _onRatioStateMutated();
  }
  scheduleRatioChartRender();
}

function includeAllRatiosForChartColumn(col) {
  const model = state.model;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) return;
  const devs = getEffectiveDevLabelsForModel(model);
  if (col < 0 || col >= devs.length - 1) return;
  const rowCount = Array.isArray(model.origin_labels) ? model.origin_labels.length : model.values.length;

  let changed = false;
  beginRatioHistoryAction("chart-include-all");
  for (let r = 0; r < rowCount; r++) {
    const key = `${r},${col}`;
    if (!ratioStrikeSet.has(key)) continue;
    ratioStrikeSet.delete(key);
    changed = true;
  }

  clearRatioChartSessionExclusionMemory();
  if (!changed) {
    cancelRatioHistoryAction();
    return;
  }
  syncRatioColumnStrikeCells(col);
  scheduleRatioSummaryUpdate();
  _onRatioStateMutated();
  commitRatioHistoryAction("chart-include-all");
  scheduleRatioChartRender();
}

function buildRatioColumnSeries(col) {
  const model = state.model;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) {
    return { labels: [], values: [], status: [] };
  }
  const devs = getEffectiveDevLabelsForModel(model);
  if (col < 0 || col >= devs.length - 1) {
    return { labels: [], values: [], status: [] };
  }
  const origins = model.origin_labels || [];
  const vals = model.values;
  const mask = model.mask;
  const labels = [];
  const values = [];
  const status = [];
  const cfg = getSelectedSummaryConfigForCol(col);
  const excludedSet = buildExcludedSetForColumn(model, col, cfg, ratioStrikeSet);
  const usedSet = buildUsedRowSetForColumn(model, col, cfg, excludedSet);

  for (let r = 0; r < origins.length; r++) {
    labels.push(String(origins[r] ?? ""));
    const hasA = !!(mask[r] && mask[r][col]);
    const hasB = !!(mask[r] && mask[r][col + 1]);
    if (!hasA || !hasB) {
      values.push(null);
      status.push("none");
      continue;
    }
    const ratio = calcRatio(vals?.[r]?.[col], vals?.[r]?.[col + 1]);
    if (!Number.isFinite(ratio)) {
      values.push(null);
      status.push("none");
      continue;
    }
    values.push(ratio);
    if (excludedSet.has(`${r},${col}`)) {
      status.push("excluded");
    } else if (usedSet.has(r)) {
      status.push("selected");
    } else {
      status.push("not-used");
    }
  }

  return { labels, values, status };
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

function getRatioChartTooltipEl() {
  return document.getElementById("dfmRatioChartTooltip");
}

function hideRatioChartTooltip() {
  const tooltip = getRatioChartTooltipEl();
  if (!tooltip) return;
  tooltip.style.display = "none";
  setRatioChartTooltipVisible(false);
}

function clearRatioChartHover() {
  const timer = getRatioChartHoverTimer();
  if (timer) {
    clearTimeout(timer);
    setRatioChartHoverTimer(null);
  }
  setRatioChartHoverKey(null);
  hideRatioChartTooltip();
}

function showRatioChartTooltip(point, canvas) {
  const tooltip = getRatioChartTooltipEl();
  if (!tooltip || !canvas || !point) return;
  const wrap = canvas.closest(".dfmRatioChartCanvasWrap");
  if (!wrap) return;
  const rect = canvas.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  const label = String(point.label ?? "");
  const value =
    Number.isFinite(point.value) ? formatRatio(point.value, getDfmDecimalPlaces()) : "";
  let statusLabel = "Not Used";
  if (point.status === "excluded") statusLabel = "Excluded";
  if (point.status === "selected") statusLabel = "Selected";

  let inner = `<div class="dfmTooltipLabel">${label}</div>`;
  if (value) {
    inner += `<div class="dfmTooltipMeta">${value} | ${statusLabel}</div>`;
  } else {
    inner += `<div class="dfmTooltipMeta">${statusLabel}</div>`;
  }
  tooltip.innerHTML = inner;
  tooltip.style.display = "block";
  tooltip.style.visibility = "hidden";

  const x = point.x + (rect.left - wrapRect.left);
  const y = point.y + (rect.top - wrapRect.top);
  const tipW = tooltip.offsetWidth || 0;
  const tipH = tooltip.offsetHeight || 0;
  const pad = 6;
  let left = x - tipW / 2;
  let top = y - tipH - 10;
  const maxLeft = Math.max(pad, wrapRect.width - tipW - pad);
  const maxTop = Math.max(pad, wrapRect.height - tipH - pad);
  left = Math.min(maxLeft, Math.max(pad, left));
  top = Math.min(maxTop, Math.max(pad, top));
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
  tooltip.style.visibility = "visible";
  setRatioChartTooltipVisible(true);
}

function getRatioChartThresholdHit(cx, cy, scale) {
  if (!scale) return null;
  const { x0, x1, y0, y1, upperY, lowerY, leftThresholdX } = scale;
  if (cx < x0 || cx > x1 || cy < y0 || cy > y1) return null;
  const candidates = [];
  if (Number.isFinite(upperY) && Math.abs(cy - upperY) <= 6) {
    candidates.push({ target: "upper", distance: Math.abs(cy - upperY) });
  }
  if (Number.isFinite(lowerY) && Math.abs(cy - lowerY) <= 6) {
    candidates.push({ target: "lower", distance: Math.abs(cy - lowerY) });
  }
  if (Number.isFinite(leftThresholdX) && Math.abs(cx - leftThresholdX) <= 6) {
    candidates.push({ target: "left", distance: Math.abs(cx - leftThresholdX) });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0].target;
}

function getRatioChartThresholdCursor(target) {
  if (target === "axis-max" || target === "axis-min") return "ns-resize";
  if (target === "left") return "ew-resize";
  return target ? "ns-resize" : "default";
}

function getRatioChartAxisLabelHit(cx, cy, scale) {
  if (!scale) return null;
  const labels = [
    { target: "axis-max", hit: scale.axisMaxLabelHit },
    { target: "axis-min", hit: scale.axisMinLabelHit },
  ];
  for (const item of labels) {
    const hit = item.hit;
    if (!hit) continue;
    if (cx >= hit.x0 && cx <= hit.x1 && cy >= hit.y0 && cy <= hit.y1) {
      return item.target;
    }
  }
  return null;
}

function getRatioChartDragHit(cx, cy, scale) {
  return getRatioChartThresholdHit(cx, cy, scale) || getRatioChartAxisLabelHit(cx, cy, scale);
}

function getAxisValueForClientY(clientY, canvas, scale, target) {
  if (!canvas || !scale) return null;
  const { y0, y1, yMin, yMax } = scale;
  if (!Number.isFinite(y0) || !Number.isFinite(y1) || !Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    return null;
  }
  const span = Math.max(1e-9, Math.abs(yMax - yMin));
  let value = null;
  if (ratioChartAxisDragStart?.target === target) {
    const deltaY = clientY - ratioChartAxisDragStart.clientY;
    const unitsPerPx = ratioChartAxisDragStart.span / Math.max(1, ratioChartAxisDragStart.plotHeight);
    value = ratioChartAxisDragStart.value - (deltaY * unitsPerPx * 1.25);
  } else {
    const rect = canvas.getBoundingClientRect();
    const cy = clientY - rect.top;
    const clampedY = Math.max(y0, Math.min(y1, cy));
    const t = (y1 - clampedY) / Math.max(1, y1 - y0);
    value = yMin + t * (yMax - yMin);
  }
  const minGap = span * 0.01;
  const custom = ratioChartYAxisRangeByCol.get(getRatioChartCol()) || {};
  const currentMin = Number.isFinite(custom.min) ? custom.min : yMin;
  const currentMax = Number.isFinite(custom.max) ? custom.max : yMax;
  if (target === "axis-max") {
    value = Math.max(currentMin + minGap, value);
  } else if (target === "axis-min") {
    value = Math.min(currentMax - minGap, value);
  }
  const rawY = y1 - ((value - yMin) / Math.max(1e-9, yMax - yMin)) * (y1 - y0);
  const y = Math.max(y0, Math.min(y1, rawY));
  return { y, value };
}

function beginYAxisDrag(target, clientY, scale) {
  if (!scale || (target !== "axis-max" && target !== "axis-min")) return;
  const custom = ratioChartYAxisRangeByCol.get(getRatioChartCol()) || {};
  const startValue = target === "axis-max"
    ? (Number.isFinite(custom.max) ? custom.max : scale.yMax)
    : (Number.isFinite(custom.min) ? custom.min : scale.yMin);
  ratioChartAxisDragStart = {
    target,
    clientY,
    value: startValue,
    span: Math.max(1e-9, Math.abs(scale.yMax - scale.yMin)),
    plotHeight: Math.max(1, scale.y1 - scale.y0),
  };
}

function setCustomYAxisBoundForCol(col, target, value) {
  if (col == null || !Number.isFinite(value)) return;
  const current = ratioChartYAxisRangeByCol.get(col) || {};
  const next = { ...current };
  if (target === "axis-max") next.max = value;
  if (target === "axis-min") next.min = value;
  if (Number.isFinite(next.min) && Number.isFinite(next.max) && next.min >= next.max) return;
  ratioChartYAxisRangeByCol.set(col, next);
}

function resetCustomYAxisBoundForCol(col, target) {
  if (col == null) return;
  const current = ratioChartYAxisRangeByCol.get(col);
  if (!current) return;
  const next = { ...current };
  if (target === "axis-max") delete next.max;
  if (target === "axis-min") delete next.min;
  if (Number.isFinite(next.min) || Number.isFinite(next.max)) {
    ratioChartYAxisRangeByCol.set(col, next);
  } else {
    ratioChartYAxisRangeByCol.delete(col);
  }
}

function renderRatioColumnChart(canvas, labels, values, status) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  resizeCanvasToCSS(canvas);
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W_css = canvas.width / dpr;
  const H_css = canvas.height / dpr;
  ctx.clearRect(0, 0, W_css, H_css);

  setRatioChartPoints([]);
  const valid = values
    .map((v, i) => (Number.isFinite(v) ? { v, i } : null))
    .filter(Boolean);
  if (!valid.length) {
    ctx.font = "12px Arial";
    ctx.fillStyle = "#555";
    ctx.fillText("No data to plot.", 10, 20);
    return;
  }

  let yMin = Infinity;
  let yMax = -Infinity;
  valid.forEach((pt) => {
    yMin = Math.min(yMin, pt.v);
    yMax = Math.max(yMax, pt.v);
  });
  // Save raw data range for clamping threshold drag
  const dataMin = yMin;
  const dataMax = yMax;
  // Expand y-axis to include the selected summary value so it's not clipped
  const chartColForRange = getRatioChartCol();
  if (chartColForRange != null) {
    const cfgForRange = getSelectedSummaryConfigForCol(chartColForRange);
    if (cfgForRange) {
      let selVal = null;
      if (isUserEntryConfig(cfgForRange)) {
        selVal = getUserEntryValueForCol(cfgForRange, chartColForRange);
      } else {
        const model2 = state.model;
        if (model2 && Array.isArray(model2.values) && Array.isArray(model2.mask)) {
          const exc = buildExcludedSetForColumn(model2, chartColForRange, cfgForRange, ratioStrikeSet);
          const sum = computeAverageForColumn(model2, chartColForRange, exc, cfgForRange);
          const isVol = String(cfgForRange.base || "volume").toLowerCase() === "volume";
          const hasVal = sum.value !== null && (isVol ? sum.sumA : sum.totalIncluded > 0);
          selVal = hasVal ? sum.value : null;
        }
      }
      if (selVal != null && Number.isFinite(selVal)) {
        yMin = Math.min(yMin, selVal);
        yMax = Math.max(yMax, selVal);
      }
    }
  }
  // Expand y-axis to include threshold lines so they're always visible
  if (chartColForRange != null) {
    const upperTh = getThresholdValueForCol(chartColForRange);
    const lowerTh = getLowerThresholdValueForCol(chartColForRange);
    if (Number.isFinite(upperTh)) {
      yMin = Math.min(yMin, upperTh);
      yMax = Math.max(yMax, upperTh);
    }
    if (Number.isFinite(lowerTh)) {
      yMin = Math.min(yMin, lowerTh);
      yMax = Math.max(yMax, lowerTh);
    }
  }
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }
  // Add a small padding so edge values aren't clipped against the axis boundary
  const yPad = (yMax - yMin) * 0.04;
  yMin -= yPad;
  yMax += yPad;
  const autoSpan = Math.max(1e-9, yMax - yMin);
  const customAxis = chartColForRange != null ? ratioChartYAxisRangeByCol.get(chartColForRange) : null;
  const hasCustomMin = Number.isFinite(customAxis?.min);
  const hasCustomMax = Number.isFinite(customAxis?.max);
  if (hasCustomMin && hasCustomMax && customAxis.min < customAxis.max) {
    yMin = customAxis.min;
    yMax = customAxis.max;
  } else if (hasCustomMin && !hasCustomMax) {
    yMin = customAxis.min;
    if (yMin >= yMax) yMax = yMin + autoSpan;
  } else if (hasCustomMax && !hasCustomMin) {
    yMax = customAxis.max;
    if (yMax <= yMin) yMin = yMax - autoSpan;
  }
  if (
    getRatioChartDragActive() &&
    ratioChartDragAxisRange &&
    Number.isFinite(ratioChartDragAxisRange.yMin) &&
    Number.isFinite(ratioChartDragAxisRange.yMax) &&
    ratioChartDragAxisRange.yMin < ratioChartDragAxisRange.yMax
  ) {
    yMin = ratioChartDragAxisRange.yMin;
    yMax = ratioChartDragAxisRange.yMax;
  }

  const W = W_css;
  const H = H_css;
  const padT = 12;
  const maxLabelLen = labels.reduce((m, v) => Math.max(m, String(v ?? "").length), 0);
  const denseLabels = labels.length > 8 || maxLabelLen > 4;
  const rotate90 = labels.length > 15;
  const labelPad = (denseLabels || rotate90) ? Math.min(48, Math.max(16, Math.ceil(maxLabelLen * 3))) : 0;
  const padL = 44 + labelPad;
  const padR = 12 + (denseLabels ? 8 : 0);
  const extraBottomPad = 16;
  const padB = 40 + labelPad + extraBottomPad;
  const x0 = padL;
  const y0 = padT;
  const x1 = W - padR;
  const y1 = H - padB;
  const span = Math.max(1, labels.length - 1);
  const getX = (i) => {
    if (labels.length <= 1) return x0 + (x1 - x0) / 2;
    return x0 + (i / span) * (x1 - x0);
  };
  setRatioChartScale({ x0, x1, y0, y1, yMin, yMax, dataMin, dataMax, xSpan: span, width: W, height: H });
  const scale = getRatioChartScale();

  ctx.strokeStyle = "#9ca3af";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x0, y1);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  const yTicks = 4;
  ctx.font = "11px Arial";
  ctx.textAlign = "left";
  for (let i = 0; i <= yTicks; i++) {
    const t = i / yTicks;
    const y = y1 - t * (y1 - y0);
    const v = yMin + t * (yMax - yMin);
    const tickLabel = formatRatio(v, getDfmDecimalPlaces());
    ctx.strokeStyle = "#eef2f7";
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
    ctx.fillStyle = "#374151";
    ctx.fillText(tickLabel, 6, y + 4);
    if (i === 0 || i === yTicks) {
      const w = ctx.measureText(tickLabel).width || 28;
      const hit = {
        x0: 0,
        x1: Math.min(x0 - 4, 10 + w),
        y0: y - 10,
        y1: y + 10,
      };
      if (i === 0) scale.axisMinLabelHit = hit;
      if (i === yTicks) scale.axisMaxLabelHit = hit;
    }
  }

  ctx.fillStyle = "#374151";
  ctx.font = denseLabels ? "10px Arial" : "11px Arial";
  ctx.textAlign = rotate90 ? "center" : (denseLabels ? "right" : "center");
  const labelY = H - extraBottomPad - (denseLabels ? 8 : 6);
  for (let i = 0; i < labels.length; i++) {
    let x = getX(i);
    ctx.strokeStyle = "#eef2f7";
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();
    const label = String(labels[i] ?? "");
    if (rotate90) {
      ctx.save();
      ctx.translate(x, labelY);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(label, 0, 0);
      ctx.restore();
    } else if (denseLabels) {
      if (i === 0) x += 8;
      ctx.save();
      ctx.translate(x, labelY);
      ctx.rotate(-Math.PI / 4);
      ctx.fillText(label, 0, 0);
      ctx.restore();
    } else {
      ctx.fillText(label, x, labelY);
    }
  }

  // Interactive threshold lines (upper/lower)
  const chartCol = getRatioChartCol();
  const upperVal = getThresholdValueForCol(chartCol, yMax);
  const lowerVal = getLowerThresholdValueForCol(chartCol, yMin);
  const leftCutoffIndex = getLeftThresholdIndexForCol(chartCol, 0);
  // Dim regions outside the threshold band
  const leftSpan = Math.max(1, labels.length - 1);
  const leftCutoff = Math.max(0, Math.min(leftSpan, leftCutoffIndex));
  const leftThresholdX = x0 + (leftCutoff / leftSpan) * (x1 - x0);
  scale.leftThresholdX = leftThresholdX;
  if (leftThresholdX > x0) {
    ctx.save();
    ctx.fillStyle = "rgba(107, 114, 128, 0.10)";
    ctx.fillRect(x0, y0, Math.max(0, leftThresholdX - x0), Math.max(0, y1 - y0));
    ctx.restore();
  }
  if (Number.isFinite(upperVal)) {
    const t = (upperVal - yMin) / (yMax - yMin);
    const upperY = y1 - t * (y1 - y0);
    ctx.save();
    ctx.fillStyle = "rgba(15, 23, 42, 0.08)";
    ctx.fillRect(x0, y0, Math.max(0, x1 - x0), Math.max(0, upperY - y0));
    ctx.restore();
  }
  if (Number.isFinite(lowerVal)) {
    const t = (lowerVal - yMin) / (yMax - yMin);
    const lowerY = y1 - t * (y1 - y0);
    ctx.save();
    ctx.fillStyle = "rgba(15, 23, 42, 0.08)";
    ctx.fillRect(x0, lowerY, Math.max(0, x1 - x0), Math.max(0, y1 - lowerY));
    ctx.restore();
  }

  if (Number.isFinite(leftThresholdX)) {
    const active = getRatioChartHoverLine() === "left" || (getRatioChartDragActive() && getRatioChartDragTarget() === "left");
    ctx.save();
    ctx.strokeStyle = active ? "#4b5563" : "#6b7280";
    ctx.lineWidth = active ? 2.2 : 1.5;
    ctx.setLineDash(active ? [] : [5, 4]);
    ctx.beginPath();
    ctx.moveTo(leftThresholdX, y0);
    ctx.lineTo(leftThresholdX, y1);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = active ? "#4b5563" : "#6b7280";
    ctx.beginPath();
    ctx.arc(leftThresholdX, y0 + 6, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (Number.isFinite(upperVal)) {
    const t = (upperVal - yMin) / (yMax - yMin);
    const thresholdY = y1 - t * (y1 - y0);
    scale.upperY = thresholdY;
    const active = getRatioChartHoverLine() === "upper" || (getRatioChartDragActive() && getRatioChartDragTarget() === "upper");
    ctx.save();
    ctx.strokeStyle = active ? "#f97316" : "#f59e0b";
    ctx.lineWidth = active ? 2.2 : 1.4;
    ctx.setLineDash(active ? [] : [6, 4]);
    ctx.beginPath();
    ctx.moveTo(x0, thresholdY);
    ctx.lineTo(x1, thresholdY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = active ? "#f97316" : "#f59e0b";
    ctx.beginPath();
    ctx.arc(x1 + 6, thresholdY, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  if (Number.isFinite(lowerVal)) {
    const t = (lowerVal - yMin) / (yMax - yMin);
    const thresholdY = y1 - t * (y1 - y0);
    scale.lowerY = thresholdY;
    const active = getRatioChartHoverLine() === "lower" || (getRatioChartDragActive() && getRatioChartDragTarget() === "lower");
    ctx.save();
    ctx.strokeStyle = active ? "#0284c7" : "#0ea5e9";
    ctx.lineWidth = active ? 2.2 : 1.4;
    ctx.setLineDash(active ? [] : [6, 4]);
    ctx.beginPath();
    ctx.moveTo(x0, thresholdY);
    ctx.lineTo(x1, thresholdY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = active ? "#0284c7" : "#0ea5e9";
    ctx.beginPath();
    ctx.arc(x1 + 14, thresholdY, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (
    getRatioChartDragActive() &&
    (getRatioChartDragTarget() === "axis-max" || getRatioChartDragTarget() === "axis-min") &&
    ratioChartAxisDragPreview &&
    Number.isFinite(ratioChartAxisDragPreview.y)
  ) {
    ctx.save();
    ctx.strokeStyle = "#dc2626";
    ctx.lineWidth = 1.8;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x0, ratioChartAxisDragPreview.y);
    ctx.lineTo(x1, ratioChartAxisDragPreview.y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (Number.isFinite(ratioChartAxisDragPreview.value)) {
      ctx.fillStyle = "#dc2626";
      ctx.font = "11px Arial";
      ctx.textAlign = "left";
      ctx.fillText(formatRatio(ratioChartAxisDragPreview.value, getDfmDecimalPlaces()), x0 + 6, ratioChartAxisDragPreview.y - 6);
    }
    ctx.restore();
  }

  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 2;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      started = false;
      continue;
    }
    const x = getX(i);
    const y = y1 - ((v - yMin) / (yMax - yMin)) * (y1 - y0);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();

  const points = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const x = getX(i);
    const y = y1 - ((v - yMin) / (yMax - yMin)) * (y1 - y0);
    const pointStatus = status && status[i];
    points.push({
      x,
      y,
      rowIndex: i,
      label: labels?.[i],
      value: v,
      status: pointStatus,
    });
    const xSize = 5;
    if (pointStatus === "excluded") {
      ctx.strokeStyle = "#dc2626";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - xSize, y - xSize);
      ctx.lineTo(x + xSize, y + xSize);
      ctx.moveTo(x + xSize, y - xSize);
      ctx.lineTo(x - xSize, y + xSize);
      ctx.stroke();
    } else {
      const isSelected = pointStatus === "selected";
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? "#2563eb" : "#ffffff";
      ctx.strokeStyle = isSelected ? "#2563eb" : "#94a3b8";
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.strokeStyle = "#16a34a";
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
    }
  }
  setRatioChartPoints(points);

  // Draw "Selected" summary value line + update HTML legend value
  const selValEl = document.getElementById("dfmRatioChartSelectedValue");
  if (selValEl) {
    const dashedIcon = selValEl.querySelector(".dfmLegendDashedLine");
    selValEl.textContent = "";
    if (dashedIcon) selValEl.appendChild(dashedIcon);
  }
  if (chartCol != null) {
    const cfg = getSelectedSummaryConfigForCol(chartCol);
    if (cfg) {
      const model = state.model;
      if (model && Array.isArray(model.values) && Array.isArray(model.mask)) {
        let selectedValue = null;
        if (isUserEntryConfig(cfg)) {
          selectedValue = getUserEntryValueForCol(cfg, chartCol);
        } else {
          const excluded = buildExcludedSetForColumn(model, chartCol, cfg, ratioStrikeSet);
          const summary = computeAverageForColumn(model, chartCol, excluded, cfg);
          const isVolume = String(cfg.base || "volume").toLowerCase() === "volume";
          const hasValue = summary.value !== null && (isVolume ? summary.sumA : summary.totalIncluded > 0);
          selectedValue = hasValue ? summary.value : null;
        }
        if (selectedValue != null && Number.isFinite(selectedValue)) {
          const t = (selectedValue - yMin) / (yMax - yMin);
          const rawY = y1 - t * (y1 - y0);
          const selectedY = Math.max(y0, Math.min(y1, rawY));
          scale.selectedY = selectedY;
          ctx.save();
          ctx.strokeStyle = "#16a34a";
          ctx.lineWidth = 1.4;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(x0, selectedY);
          ctx.lineTo(x1, selectedY);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
          // Update HTML legend selected value
          if (selValEl) {
            const dashedIcon = selValEl.querySelector(".dfmLegendDashedLine");
            selValEl.textContent = "";
            if (dashedIcon) selValEl.appendChild(dashedIcon);
            selValEl.appendChild(document.createTextNode(` Selected (${formatRatio(selectedValue, getDfmDecimalPlaces())})`));
          }
        }
      }
    }
  }
}

export function scheduleRatioChartRender() {
  if (getRatioChartRaf()) return;
  setRatioChartRaf(requestAnimationFrame(() => {
    setRatioChartRaf(null);
    renderRatioChartNow();
  }));
}

function renderRatioChartNow() {
  const col = getRatioChartCol();
  if (col == null) return;
  if (!isRatioChartOpen()) return;
  const canvas = getRatioChartCanvas();
  if (!canvas) return;
  reconcileProtectedExclusionsForChartColumn(col);
  const { labels, values, status } = buildRatioColumnSeries(col);
  renderRatioColumnChart(canvas, labels, values, status);
}

export function showRatioColumnChart(col) {
  const model = state.model;
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) return;
  const devs = getEffectiveDevLabelsForModel(model);
  if (col < 0 || col >= devs.length - 1) return;

  setRatioChartCol(col);
  snapshotProtectedExclusionsForChartColumn(col);
  clearRatioChartHover();
  const modal = getRatioChartModalEl();
  if (!modal) return;
  const titleEl = document.getElementById("dfmRatioChartTitle");
  const metaEl = document.getElementById("dfmRatioChartMeta");
  const cfg = getSelectedSummaryConfigForCol(col);
  if (titleEl) titleEl.textContent = `Ratios - ${getRatioColumnLabel(col)}`;
  if (metaEl) {
    const rowLabel = getOriginLabelTextForRatio();
    const formulaLabel = cfg?.label || cfg?.id || "Selected";
    metaEl.textContent = `Selected: ${formulaLabel} - ${rowLabel}`;
  }
  modal.querySelector(".dfmModalCard")?._resetDrag?.();
  modal.classList.add("open");
  scheduleRatioChartRender();
}

function hideRatioColumnChart() {
  const modal = getRatioChartModalEl();
  if (modal) modal.classList.remove("open");
  setRatioChartCol(null);
  clearRatioChartSessionExclusionMemory();
  ratioChartYAxisRangeByCol.clear();
  clearRatioChartHover();
}

export function wireRatioChartModal() {
  if (getRatioChartWired()) return;
  const modal = getRatioChartModalEl();
  if (!modal) return;
  setRatioChartWired(true);
  modal.querySelector(".dfmModalBackdrop")?.addEventListener("click", () => hideRatioColumnChart());
  document.getElementById("dfmRatioChartClose")?.addEventListener("click", () => hideRatioColumnChart());
  document.getElementById("dfmRatioChartIncludeAll")?.addEventListener("click", () => {
    const chartCol = getRatioChartCol();
    if (chartCol == null) return;
    includeAllRatiosForChartColumn(chartCol);
  });

  /* draggable window via header */
  const header = modal.querySelector(".dfmRatioChartHeader");
  const card = modal.querySelector(".dfmModalCard");
  if (header && card) {
    let dx = 0, dy = 0, sx = 0, sy = 0;
    header.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      e.preventDefault();
      sx = e.clientX; sy = e.clientY;
      const onMove = (ev) => {
        dx += ev.clientX - sx; dy += ev.clientY - sy;
        sx = ev.clientX; sy = ev.clientY;
        card.style.transform = `translate(${dx}px,${dy}px)`;
      };
      const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
    card._resetDrag = () => { dx = dy = 0; card.style.transform = ""; };
  }
  const canvas = getRatioChartCanvas();
  canvas?.addEventListener("pointerdown", (e) => {
    clearRatioChartHover();
    const chartCol = getRatioChartCol();
    const scale = getRatioChartScale();
    if (chartCol == null || !scale) return;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const hit = getRatioChartDragHit(cx, cy, scale);
    if (!hit) return;
    setRatioChartDragActive(true);
    setRatioChartDragMoved(false);
    setRatioChartDragTarget(hit);
    if (hit !== "axis-max" && hit !== "axis-min") {
      beginRatioHistoryAction("chart-threshold-drag");
    }
    ratioChartDragAxisRange = {
      yMin: scale.yMin,
      yMax: scale.yMax,
    };
    if (hit === "axis-max" || hit === "axis-min") {
      beginYAxisDrag(hit, e.clientY, scale);
      ratioChartAxisDragPreview = getAxisValueForClientY(e.clientY, canvas, scale, hit);
    }
    setRatioChartHoverLine(getRatioChartDragTarget());
    e.preventDefault();
  });

  canvas?.addEventListener("pointermove", (e) => {
    const chartCol = getRatioChartCol();
    const scale = getRatioChartScale();
    if (getRatioChartDragActive() || chartCol == null || !scale) {
      clearRatioChartHover();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const hit = getRatioChartDragHit(cx, cy, scale);
    if (hit !== getRatioChartHoverLine()) {
      setRatioChartHoverLine(hit);
      scheduleRatioChartRender();
    }
    if (canvas) canvas.style.cursor = getRatioChartThresholdCursor(hit);
    if (hit) {
      clearRatioChartHover();
      return;
    }
    const chartPoints = getRatioChartPoints();
    if (!chartPoints.length) {
      clearRatioChartHover();
      return;
    }
    let best = null;
    let bestDist = Infinity;
    for (const pt of chartPoints) {
      const ddx = pt.x - cx;
      const ddy = pt.y - cy;
      const dist = ddx * ddx + ddy * ddy;
      if (dist < bestDist) {
        bestDist = dist;
        best = pt;
      }
    }
    const hitRadius = 8;
    if (!best || bestDist > hitRadius * hitRadius) {
      clearRatioChartHover();
      return;
    }
    const key = `${best.rowIndex},${chartCol}`;
    if (key !== getRatioChartHoverKey()) {
      clearRatioChartHover();
      setRatioChartHoverKey(key);
    }
    if (getRatioChartTooltipVisible() || getRatioChartHoverTimer()) return;
    setRatioChartHoverTimer(setTimeout(() => {
      setRatioChartHoverTimer(null);
      if (getRatioChartHoverKey() !== key) return;
      if (!isRatioChartOpen()) return;
      showRatioChartTooltip(best, canvas);
    }, 500));
  });
  canvas?.addEventListener("pointerleave", () => {
    clearRatioChartHover();
  });
  canvas?.addEventListener("dblclick", (e) => {
    clearRatioChartHover();
    const chartCol = getRatioChartCol();
    const scale = getRatioChartScale();
    if (chartCol == null || !scale) return;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const hit = getRatioChartAxisLabelHit(cx, cy, scale);
    if (hit !== "axis-max" && hit !== "axis-min") return;
    resetCustomYAxisBoundForCol(chartCol, hit);
    e.preventDefault();
    scheduleRatioChartRender();
  });

  window.addEventListener("pointermove", (e) => {
    const chartCol = getRatioChartCol();
    const scale = getRatioChartScale();
    if (!getRatioChartDragActive() || chartCol == null || !scale) return;
    const rect = canvas.getBoundingClientRect();
    const target = getRatioChartDragTarget();
    if (target === "axis-max" || target === "axis-min") {
      ratioChartAxisDragPreview = getAxisValueForClientY(e.clientY, canvas, scale, target);
      setRatioChartDragMoved(true);
      scheduleRatioChartRender();
      return;
    }
    if (target === "left") {
      const cx = e.clientX - rect.left;
      const { x0, x1, xSpan } = scale;
      const clampedX = Math.max(x0, Math.min(x1, cx));
      const span = Math.max(1, Number.isFinite(xSpan) ? xSpan : 1);
      const t = (clampedX - x0) / Math.max(1, x1 - x0);
      setLeftThresholdIndexForCol(chartCol, t * span);
      setRatioChartDragMoved(true);
      scheduleRatioChartRender();
      return;
    }
    const cy = e.clientY - rect.top;
    const { y0, y1, yMin, yMax, dataMin, dataMax } = scale;
    const clampedY = Math.max(y0, Math.min(y1, cy));
    const t = (y1 - clampedY) / (y1 - y0);
    let value = yMin + t * (yMax - yMin);
    // Clamp threshold to within 20% of data range beyond actual points
    const dataSpan = (dataMax - dataMin) || 1;
    const margin = dataSpan * 0.2;
    value = Math.max(dataMin - margin, Math.min(dataMax + margin, value));
    if (target === "upper") {
      const lower = getLowerThresholdValueForCol(chartCol);
      const next = Number.isFinite(lower) ? Math.max(value, lower) : value;
      setThresholdValueForCol(chartCol, next);
    } else if (target === "lower") {
      const upper = getThresholdValueForCol(chartCol);
      const next = Number.isFinite(upper) ? Math.min(value, upper) : value;
      setLowerThresholdValueForCol(chartCol, next);
    }
    setRatioChartDragMoved(true);
    scheduleRatioChartRender();
  });

  window.addEventListener("pointerup", () => {
    if (!getRatioChartDragActive()) return;
    const target = getRatioChartDragTarget();
    setRatioChartDragActive(false);
    ratioChartDragAxisRange = null;
    const chartCol = getRatioChartCol();
    if (getRatioChartDragMoved() && chartCol != null) {
      if (target === "axis-max" || target === "axis-min") {
        setCustomYAxisBoundForCol(chartCol, target, ratioChartAxisDragPreview?.value);
        cancelRatioHistoryAction();
      } else {
        applyCurrentThresholdExclusions(chartCol);
        commitRatioHistoryAction("chart-threshold-drag");
      }
    } else if (target !== "axis-max" && target !== "axis-min") {
      cancelRatioHistoryAction();
    }
    ratioChartAxisDragPreview = null;
    ratioChartAxisDragStart = null;
    setRatioChartHoverLine(null);
    setRatioChartDragTarget(null);
    if (canvas) canvas.style.cursor = "default";
    scheduleRatioChartRender();
  });

  canvas?.addEventListener("click", (e) => {
    if (getRatioChartDragMoved()) {
      setRatioChartDragMoved(false);
      return;
    }
    clearRatioChartHover();
    const chartCol = getRatioChartCol();
    const chartPoints = getRatioChartPoints();
    if (chartCol == null || !chartPoints.length) return;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    let best = null;
    let bestDist = Infinity;
    for (const pt of chartPoints) {
      const ddx = pt.x - cx;
      const ddy = pt.y - cy;
      const dist = ddx * ddx + ddy * ddy;
      if (dist < bestDist) {
        bestDist = dist;
        best = pt;
      }
    }
    const hitRadius = 8;
    if (!best || bestDist > hitRadius * hitRadius) return;
    const key = `${best.rowIndex},${chartCol}`;
    beginRatioHistoryAction("chart-point-click");
    if (ratioStrikeSet.has(key)) {
      ratioStrikeSet.delete(key);
    } else {
      ratioStrikeSet.add(key);
    }
    rememberManualChartExclusionToggle(key, ratioStrikeSet.has(key));
    const cell = document.querySelector(
      `#ratioWrap td.ratioCell[data-r="${best.rowIndex}"][data-col="${chartCol}"]`
    );
    if (cell) cell.classList.toggle("strike", ratioStrikeSet.has(key));
    scheduleRatioSummaryUpdate();
    _onRatioStateMutated();
    commitRatioHistoryAction("chart-point-click");
    scheduleRatioChartRender();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (isRatioChartOpen()) hideRatioColumnChart();
  });
  window.addEventListener("resize", () => {
    if (isRatioChartOpen()) scheduleRatioChartRender();
  });
}

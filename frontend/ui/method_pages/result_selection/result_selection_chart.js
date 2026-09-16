import {
  canHideChartLegendSeries,
  hiddenChartSeriesIdsAfterContextToggle,
  renderChartLegend,
} from "../../shared/components/chart_legend/chart_legend.js?v=20260724a";

const CHART_COLORS = [
  "#2b6df6",
  "#0f766e",
  "#b45309",
  "#7c3aed",
  "#be123c",
  "#0369a1",
  "#15803d",
  "#c2410c",
  "#4f46e5",
  "#0e7490",
  "#a21caf",
  "#475569",
];

const MIN_ZOOM_DRAG = 6;
// Keep the first and last points clear of the axes, and let a point sitting on a
// zoom-window edge paint whole instead of being sliced by the clip.
const SERIES_INSET = 7;
const SERIES_BLEED = 5;

function getChartColor(propertyName, fallback) {
  return window.ArcRhoColorTheme?.getCssColor?.(propertyName, fallback) || fallback;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sourceLabel(source, sourceIndex) {
  return String(source?.name || source?.datasetType || source?.dataset_type || `Source ${sourceIndex + 1}`).trim();
}

export const hiddenSeriesIdsAfterContextToggle = hiddenChartSeriesIdsAfterContextToggle;
export const canHideChartSeries = canHideChartLegendSeries;

export function buildResultSelectionChartSeries({
  sources = [],
  sourceIndexes = [],
  selectedUltimateValues = [],
  selectedUltimateLabel = "Selected Ultimate",
  rowCount = 0,
} = {}) {
  const count = Math.max(0, Number.parseInt(String(rowCount), 10) || 0);
  const orderedIndexes = Array.isArray(sourceIndexes) && sourceIndexes.length
    ? sourceIndexes
    : sources.map((_, index) => index);
  const series = orderedIndexes
    .filter((sourceIndex) => Number.isInteger(sourceIndex) && sourceIndex >= 0 && sourceIndex < sources.length)
    .map((sourceIndex, orderIndex) => {
      const source = sources[sourceIndex] || {};
      const label = sourceLabel(source, sourceIndex);
      return {
        id: `source:${label.toLowerCase()}`,
        label,
        color: CHART_COLORS[orderIndex % CHART_COLORS.length],
        values: Array.from({ length: count }, (_, rowIndex) => finiteNumber(source?.values?.[rowIndex])),
      };
    });

  series.push({
    id: "selected-ultimate",
    label: String(selectedUltimateLabel || "Selected Ultimate").trim(),
    color: "#111827",
    values: Array.from({ length: count }, (_, rowIndex) => finiteNumber(selectedUltimateValues?.[rowIndex])),
    emphasized: true,
  });
  return series;
}

function niceStep(range, targetTickCount = 6) {
  const roughStep = Math.max(range, Number.EPSILON) / Math.max(1, targetTickCount);
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  if (normalized <= 1) return magnitude;
  if (normalized <= 2) return 2 * magnitude;
  if (normalized <= 2.5) return 2.5 * magnitude;
  if (normalized <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

function chartRange(series) {
  const values = series.flatMap((entry) => entry.values.map(finiteNumber).filter((value) => value !== null));
  if (!values.length) return null;
  let dataMin = Math.min(...values);
  let dataMax = Math.max(...values);
  if (dataMin === dataMax) {
    const spread = Math.max(Math.abs(dataMin) * 0.05, 1);
    dataMin -= spread;
    dataMax += spread;
  }
  const padding = (dataMax - dataMin) * 0.06;
  const step = niceStep(dataMax - dataMin + padding * 2);
  const min = Math.floor((dataMin - padding) / step) * step;
  const max = Math.ceil((dataMax + padding) / step) * step;
  const ticks = [];
  for (let value = min; value <= max + step * 0.001; value += step) ticks.push(value);
  return { min, max, ticks };
}

function zoomedRange(valueMin, valueMax) {
  const step = niceStep(valueMax - valueMin);
  const ticks = [];
  for (let value = Math.ceil(valueMin / step) * step; value <= valueMax + step * 0.001; value += step) ticks.push(value);
  if (!ticks.length) ticks.push(valueMin, valueMax);
  return { min: valueMin, max: valueMax, ticks };
}

function numberFormatter(decimalPlaces) {
  const decimals = Math.max(0, Math.min(8, Number.parseInt(String(decimalPlaces ?? 1), 10) || 0));
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function setCanvasSize(canvas) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
  const pixelWidth = Math.floor(width * pixelRatio);
  const pixelHeight = Math.floor(height * pixelRatio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext("2d");
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  return { context, width, height };
}

export function createResultSelectionChart({ canvas, legendList, legendCount, emptyState, tooltip, zoomBox } = {}) {
  if (!canvas) return null;

  let data = { originLabels: [], series: [], decimalPlaces: 1 };
  let points = [];
  let animationFrame = null;
  let legendSignature = "";
  let plotArea = null;
  let zoomWindow = null;
  let drag = null;
  const hiddenSeriesIds = new Set();
  const resizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => scheduleRender())
    : null;

  resizeObserver?.observe(canvas);

  function hideTooltip() {
    if (tooltip) tooltip.hidden = true;
  }

  function visibleSeries() {
    return data.series.filter((series) => !hiddenSeriesIds.has(series.id));
  }

  function updateLegendCount() {
    if (!legendCount) return;
    const visibleCount = visibleSeries().length;
    legendCount.textContent = `${visibleCount} of ${data.series.length}`;
  }

  function renderLegend() {
    if (!legendList) return;
    const signature = data.series.map((series) => `${series.id}\u0000${series.label}\u0000${series.color}`).join("\u0001");
    if (signature === legendSignature) {
      updateLegendCount();
      return;
    }
    legendSignature = signature;
    renderChartLegend({
      listElement: legendList,
      countElement: legendCount,
      series: data.series,
      hiddenIds: hiddenSeriesIds,
      onVisibilityChange: () => {
        hideTooltip();
        scheduleRender();
      },
    });
  }

  function draw() {
    animationFrame = null;
    const { context, width, height } = setCanvasSize(canvas);
    context.clearRect(0, 0, width, height);
    context.fillStyle = getChartColor("--ar-chart-background", "#ffffff");
    context.fillRect(0, 0, width, height);
    points = [];

    const series = visibleSeries();
    const labels = Array.isArray(data.originLabels) ? data.originLabels.map(String) : [];
    const rowCount = Math.max(labels.length, ...series.map((entry) => entry.values.length), 0);
    const lastRowIndex = Math.max(0, rowCount - 1);
    let indexMin = 0;
    let indexMax = lastRowIndex;
    let range = chartRange(series);
    if (zoomWindow && range) {
      const low = Math.min(Math.max(0, zoomWindow.indexMin), lastRowIndex);
      const high = Math.min(Math.max(0, zoomWindow.indexMax), lastRowIndex);
      if (high - low >= 1e-6) {
        indexMin = low;
        indexMax = high;
      }
      range = zoomedRange(zoomWindow.valueMin, zoomWindow.valueMax);
    }
    const hasChartSpace = width >= 240 && height >= 180;
    const isEmpty = !series.length || !range || rowCount === 0 || !hasChartSpace;
    plotArea = null;
    if (emptyState) {
      emptyState.hidden = !isEmpty;
      emptyState.textContent = !hasChartSpace
        ? "Expand the window to view the chart."
        : !series.length
          ? "Select at least one column in the legend."
          : "Add source or selected output values to plot dataset vectors.";
    }
    canvas.classList.toggle("isEmpty", isEmpty);
    canvas.setAttribute(
      "aria-label",
      isEmpty
        ? "Result Selection dataset vector chart. No visible values are available."
        : `Result Selection dataset vector chart with ${rowCount} origin periods and ${series.length} visible columns.${zoomWindow ? " Zoomed in; double-click to restore the full view." : ""}`,
    );
    if (isEmpty) return;

    const firstLabelIndex = Math.max(0, Math.ceil(indexMin - 1e-9));
    const lastLabelIndex = Math.min(lastRowIndex, Math.floor(indexMax + 1e-9));
    const labelCount = Math.max(1, lastLabelIndex - firstLabelIndex + 1);
    const format = numberFormatter(data.decimalPlaces);
    context.font = '11px Arial, "Segoe UI", sans-serif';
    const widestTick = Math.max(...range.ticks.map((tick) => context.measureText(format.format(tick)).width));
    const rotateLabels = labelCount > 10 || labels.some((label) => label.length > 8);
    const padding = {
      top: 14,
      right: 18 + SERIES_INSET,
      bottom: rotateLabels ? 72 : 38,
      left: Math.max(58, Math.ceil(widestTick) + 16),
    };
    const x0 = padding.left;
    const x1 = width - padding.right;
    const y0 = padding.top;
    const y1 = height - padding.bottom;
    const xStart = x0 + SERIES_INSET;
    const xEnd = x1 - SERIES_INSET;
    const xSpan = indexMax - indexMin;
    const xFor = (index) => xSpan <= 0 ? (xStart + xEnd) / 2 : xStart + ((index - indexMin) / xSpan) * (xEnd - xStart);
    const yFor = (value) => y1 - ((value - range.min) / (range.max - range.min)) * (y1 - y0);
    plotArea = { x0, x1, y0, y1, xStart, xEnd, indexMin, indexMax, valueMin: range.min, valueMax: range.max };

    context.lineWidth = 1;
    context.textBaseline = "middle";
    context.textAlign = "right";
    for (const tick of range.ticks) {
      const y = yFor(tick);
      context.strokeStyle = getChartColor("--ar-chart-grid", "#e5eaf0");
      context.beginPath();
      context.moveTo(x0, y);
      context.lineTo(x1, y);
      context.stroke();
      context.fillStyle = getChartColor("--ar-chart-text-muted", "#5f6b7a");
      context.fillText(format.format(tick), x0 - 8, y);
    }

    context.strokeStyle = getChartColor("--ar-chart-axis", "#aeb8c5");
    context.beginPath();
    context.moveTo(x0, y0);
    context.lineTo(x0, y1);
    context.lineTo(x1, y1);
    context.stroke();

    const maxLabels = Math.max(2, Math.floor((x1 - x0) / (rotateLabels ? 44 : 70)));
    const labelEvery = Math.max(1, Math.ceil(labelCount / maxLabels));
    context.fillStyle = getChartColor("--ar-chart-text", "#4b5563");
    context.textBaseline = "top";
    for (let index = firstLabelIndex; index <= lastLabelIndex; index += 1) {
      if ((index - firstLabelIndex) % labelEvery !== 0 && index !== lastLabelIndex) continue;
      const label = labels[index] || String(index + 1);
      const x = xFor(index);
      context.save();
      if (rotateLabels) {
        context.translate(x - 2, y1 + 10);
        context.rotate(-Math.PI / 4);
        context.textAlign = "right";
        context.fillText(label, 0, 0);
      } else {
        context.textAlign = "center";
        context.fillText(label, x, y1 + 10);
      }
      context.restore();
    }

    context.save();
    context.beginPath();
    context.rect(x0 - SERIES_BLEED, y0 - SERIES_BLEED, x1 - x0 + SERIES_BLEED * 2, y1 - y0 + SERIES_BLEED * 2);
    context.clip();
    for (const entry of series) {
      context.strokeStyle = entry.color;
      context.lineWidth = entry.emphasized ? 2.4 : 1.8;
      context.lineJoin = "round";
      context.lineCap = "round";
      context.beginPath();
      let segmentOpen = false;
      for (let index = 0; index < rowCount; index += 1) {
        const value = finiteNumber(entry.values[index]);
        if (value === null) {
          segmentOpen = false;
          continue;
        }
        const x = xFor(index);
        const y = yFor(value);
        if (segmentOpen) context.lineTo(x, y);
        else context.moveTo(x, y);
        segmentOpen = true;
      }
      context.stroke();

      for (let index = 0; index < rowCount; index += 1) {
        const value = finiteNumber(entry.values[index]);
        if (value === null) continue;
        const x = xFor(index);
        const y = yFor(value);
        context.fillStyle = getChartColor("--ar-chart-point-fill", "#ffffff");
        context.strokeStyle = entry.color;
        context.lineWidth = entry.emphasized ? 2 : 1.5;
        context.beginPath();
        context.arc(x, y, entry.emphasized ? 3.2 : 2.7, 0, Math.PI * 2);
        context.fill();
        context.stroke();
        if (x >= x0 - SERIES_BLEED && x <= x1 + SERIES_BLEED && y >= y0 - SERIES_BLEED && y <= y1 + SERIES_BLEED) {
          points.push({ x, y, value, origin: labels[index] || String(index + 1), series: entry });
        }
      }
    }
    context.restore();
  }

  function scheduleRender() {
    if (animationFrame !== null) return;
    animationFrame = window.requestAnimationFrame(draw);
  }

  function showTooltip(event) {
    if (!tooltip || !points.length) return;
    const bounds = canvas.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left;
    const pointerY = event.clientY - bounds.top;
    let nearest = null;
    let nearestDistance = Infinity;
    for (const point of points) {
      const distance = (point.x - pointerX) ** 2 + (point.y - pointerY) ** 2;
      if (distance < nearestDistance) {
        nearest = point;
        nearestDistance = distance;
      }
    }
    if (!nearest || nearestDistance > 100) {
      hideTooltip();
      return;
    }
    const format = numberFormatter(data.decimalPlaces);
    const title = document.createElement("strong");
    title.textContent = nearest.series.label;
    const detail = document.createElement("span");
    detail.textContent = `${nearest.origin}: ${format.format(nearest.value)}`;
    tooltip.replaceChildren(title, detail);
    tooltip.style.left = `${Math.min(Math.max(8, pointerX + 12), Math.max(8, bounds.width - 220))}px`;
    tooltip.style.top = `${Math.max(8, pointerY - 48)}px`;
    tooltip.hidden = false;
  }

  function canvasPoint(event) {
    const bounds = canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function drawZoomBox() {
    if (!zoomBox || !drag) return;
    zoomBox.style.left = `${canvas.offsetLeft + Math.min(drag.startX, drag.x)}px`;
    zoomBox.style.top = `${canvas.offsetTop + Math.min(drag.startY, drag.y)}px`;
    zoomBox.style.width = `${Math.abs(drag.x - drag.startX)}px`;
    zoomBox.style.height = `${Math.abs(drag.y - drag.startY)}px`;
    zoomBox.hidden = false;
  }

  function endZoomDrag() {
    if (!drag) return;
    if (canvas.hasPointerCapture?.(drag.pointerId)) canvas.releasePointerCapture(drag.pointerId);
    drag = null;
    if (zoomBox) zoomBox.hidden = true;
  }

  function startZoomDrag(event) {
    if (event.button !== 0 || !plotArea) return;
    const point = canvasPoint(event);
    const inside = point.x >= plotArea.x0 && point.x <= plotArea.x1
      && point.y >= plotArea.y0 && point.y <= plotArea.y1;
    if (!inside) return;
    drag = { pointerId: event.pointerId, startX: point.x, startY: point.y, x: point.x, y: point.y };
    canvas.setPointerCapture(event.pointerId);
    hideTooltip();
    drawZoomBox();
    event.preventDefault();
  }

  function moveZoomDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) {
      showTooltip(event);
      return;
    }
    if (!plotArea) {
      endZoomDrag();
      return;
    }
    const point = canvasPoint(event);
    drag.x = Math.min(Math.max(point.x, plotArea.x0), plotArea.x1);
    drag.y = Math.min(Math.max(point.y, plotArea.y0), plotArea.y1);
    drawZoomBox();
  }

  function applyZoomDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const left = Math.min(drag.startX, drag.x);
    const right = Math.max(drag.startX, drag.x);
    const top = Math.min(drag.startY, drag.y);
    const bottom = Math.max(drag.startY, drag.y);
    const area = plotArea;
    endZoomDrag();
    if (!area || right - left < MIN_ZOOM_DRAG || bottom - top < MIN_ZOOM_DRAG) return;
    const indexSpan = area.indexMax - area.indexMin;
    const indexAt = (x) => area.indexMin + ((x - area.xStart) / (area.xEnd - area.xStart)) * indexSpan;
    const valueAt = (y) => area.valueMax - ((y - area.y0) / (area.y1 - area.y0)) * (area.valueMax - area.valueMin);
    zoomWindow = {
      indexMin: indexAt(left),
      indexMax: indexAt(right),
      valueMin: valueAt(bottom),
      valueMax: valueAt(top),
    };
    scheduleRender();
  }

  function resetZoom() {
    if (!zoomWindow) return;
    zoomWindow = null;
    hideTooltip();
    scheduleRender();
  }

  canvas.addEventListener("pointerdown", startZoomDrag);
  canvas.addEventListener("pointermove", moveZoomDrag);
  canvas.addEventListener("pointerup", applyZoomDrag);
  canvas.addEventListener("pointercancel", endZoomDrag);
  canvas.addEventListener("dblclick", resetZoom);
  canvas.addEventListener("pointerleave", hideTooltip);
  window.addEventListener("arcrho:color-theme-changed", scheduleRender);

  return {
    render(nextData = {}) {
      data = {
        originLabels: Array.isArray(nextData.originLabels) ? nextData.originLabels : [],
        series: Array.isArray(nextData.series) ? nextData.series : [],
        decimalPlaces: nextData.decimalPlaces,
      };
      renderLegend();
      hideTooltip();
      scheduleRender();
    },
    refresh: scheduleRender,
    destroy() {
      resizeObserver?.disconnect();
      endZoomDrag();
      canvas.removeEventListener("pointerdown", startZoomDrag);
      canvas.removeEventListener("pointermove", moveZoomDrag);
      canvas.removeEventListener("pointerup", applyZoomDrag);
      canvas.removeEventListener("pointercancel", endZoomDrag);
      canvas.removeEventListener("dblclick", resetZoom);
      canvas.removeEventListener("pointerleave", hideTooltip);
      window.removeEventListener("arcrho:color-theme-changed", scheduleRender);
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    },
  };
}

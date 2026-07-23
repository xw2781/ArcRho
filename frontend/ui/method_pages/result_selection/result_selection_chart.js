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

export function hiddenSeriesIdsAfterContextToggle(series = [], targetSeriesId = "", currentHiddenIds = []) {
  const ids = series.map((entry) => entry?.id).filter(Boolean);
  const currentHidden = new Set(currentHiddenIds);
  const visibleIds = ids.filter((id) => !currentHidden.has(id));
  if (visibleIds.length === 1 && visibleIds[0] === targetSeriesId) return new Set();
  return new Set(ids.filter((id) => id !== targetSeriesId));
}

export function canHideChartSeries(series = [], targetSeriesId = "", currentHiddenIds = []) {
  const currentHidden = new Set(currentHiddenIds);
  if (currentHidden.has(targetSeriesId)) return true;
  const visibleCount = series.reduce((count, entry) => count + (entry?.id && !currentHidden.has(entry.id) ? 1 : 0), 0);
  return visibleCount > 1;
}

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

export function createResultSelectionChart({ canvas, legendList, legendCount, emptyState, tooltip } = {}) {
  if (!canvas) return null;

  let data = { originLabels: [], series: [], decimalPlaces: 1 };
  let points = [];
  let animationFrame = null;
  let legendSignature = "";
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
    const nextIds = new Set(data.series.map((series) => series.id));
    for (const id of hiddenSeriesIds) {
      if (!nextIds.has(id)) hiddenSeriesIds.delete(id);
    }
    const signature = data.series.map((series) => `${series.id}\u0000${series.label}\u0000${series.color}`).join("\u0001");
    if (signature === legendSignature) {
      updateLegendCount();
      return;
    }
    legendSignature = signature;
    const items = data.series.map((series) => {
      const item = document.createElement("label");
      item.className = "rsChartLegendItem";
      item.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const nextHiddenIds = hiddenSeriesIdsAfterContextToggle(data.series, series.id, hiddenSeriesIds);
        hiddenSeriesIds.clear();
        for (const id of nextHiddenIds) hiddenSeriesIds.add(id);
        legendSignature = "";
        renderLegend();
        hideTooltip();
        scheduleRender();
      });

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = !hiddenSeriesIds.has(series.id);
      checkbox.setAttribute("aria-label", `Show ${series.label}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          hiddenSeriesIds.delete(series.id);
        } else if (canHideChartSeries(data.series, series.id, hiddenSeriesIds)) {
          hiddenSeriesIds.add(series.id);
        } else {
          checkbox.checked = true;
          return;
        }
        hideTooltip();
        updateLegendCount();
        scheduleRender();
      });

      const swatch = document.createElement("span");
      swatch.className = "rsChartLegendSwatch";
      swatch.style.setProperty("--rs-chart-series", series.color);
      swatch.setAttribute("aria-hidden", "true");

      const label = document.createElement("span");
      label.className = "rsChartLegendLabel";
      label.textContent = series.label;
      item.append(checkbox, swatch, label);
      return item;
    });
    legendList.replaceChildren(...items);
    updateLegendCount();
  }

  function draw() {
    animationFrame = null;
    const { context, width, height } = setCanvasSize(canvas);
    context.clearRect(0, 0, width, height);
    context.fillStyle = getChartColor("--ar-chart-background", "#ffffff");
    context.fillRect(0, 0, width, height);
    points = [];

    const series = visibleSeries();
    const range = chartRange(series);
    const labels = Array.isArray(data.originLabels) ? data.originLabels.map(String) : [];
    const rowCount = Math.max(labels.length, ...series.map((entry) => entry.values.length), 0);
    const hasChartSpace = width >= 240 && height >= 180;
    const isEmpty = !series.length || !range || rowCount === 0 || !hasChartSpace;
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
        : `Result Selection dataset vector chart with ${rowCount} origin periods and ${series.length} visible columns.`,
    );
    if (isEmpty) return;

    const format = numberFormatter(data.decimalPlaces);
    context.font = '11px Arial, "Segoe UI", sans-serif';
    const widestTick = Math.max(...range.ticks.map((tick) => context.measureText(format.format(tick)).width));
    const rotateLabels = rowCount > 10 || labels.some((label) => label.length > 8);
    const padding = {
      top: 14,
      right: 18,
      bottom: rotateLabels ? 72 : 38,
      left: Math.max(58, Math.ceil(widestTick) + 16),
    };
    const x0 = padding.left;
    const x1 = width - padding.right;
    const y0 = padding.top;
    const y1 = height - padding.bottom;
    const xSpan = Math.max(1, rowCount - 1);
    const xFor = (index) => rowCount === 1 ? (x0 + x1) / 2 : x0 + (index / xSpan) * (x1 - x0);
    const yFor = (value) => y1 - ((value - range.min) / (range.max - range.min)) * (y1 - y0);

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
    const labelEvery = Math.max(1, Math.ceil(rowCount / maxLabels));
    context.fillStyle = getChartColor("--ar-chart-text", "#4b5563");
    context.textBaseline = "top";
    for (let index = 0; index < rowCount; index += 1) {
      if (index % labelEvery !== 0 && index !== rowCount - 1) continue;
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
        points.push({ x, y, value, origin: labels[index] || String(index + 1), series: entry });
      }
    }
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

  canvas.addEventListener("pointermove", showTooltip);
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
      canvas.removeEventListener("pointermove", showTooltip);
      canvas.removeEventListener("pointerleave", hideTooltip);
      window.removeEventListener("arcrho:color-theme-changed", scheduleRender);
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    },
  };
}

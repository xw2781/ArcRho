const SERIES = [
  { key: "latestRatio", label: "Latest / Exposure", color: "#2b6df6" },
  { key: "trendedLatestRatio", label: "Trended Latest / Exposure", color: "#15803d" },
  { key: "trendedDevelopedRatio", label: "Trended Developed Ratio", color: "#be123c" },
  { key: "expectedUltimateRatio", label: "Expected Ultimate Ratio", color: "#7c3aed" },
  { key: "detrendedExpectedRatio", label: "Detrended Expected Ratio", color: "#0ea5e9" },
  { key: "capeCodUltimateRatio", label: "Cape Cod Ultimate Ratio", color: "#111827" },
];

function getChartColor(propertyName, fallback) {
  return window.ArcRhoColorTheme?.getCssColor?.(propertyName, fallback) || fallback;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function ratio(numerator, denominator) {
  const top = finiteNumber(numerator);
  const bottom = finiteNumber(denominator);
  if (top === null || bottom === null || bottom === 0) return null;
  return top / bottom;
}

function buildChartRows(data) {
  const labels = Array.isArray(data?.originLabels) ? data.originLabels : [];
  const latestValues = Array.isArray(data?.latestValues) ? data.latestValues : [];
  const trendedLatestValues = Array.isArray(data?.trendedLatestValues) ? data.trendedLatestValues : [];
  const exposureValues = Array.isArray(data?.exposureValues) ? data.exposureValues : [];
  const trendedDevelopedRatios = Array.isArray(data?.trendedDevelopedRatios) ? data.trendedDevelopedRatios : [];
  const expectedUltimateRatios = Array.isArray(data?.expectedUltimateRatios) ? data.expectedUltimateRatios : [];
  const detrendedExpectedRatios = Array.isArray(data?.detrendedExpectedRatios) ? data.detrendedExpectedRatios : [];
  const capeCodUltimateRatios = Array.isArray(data?.capeCodUltimateRatios) ? data.capeCodUltimateRatios : [];
  const count = Math.max(
    labels.length,
    latestValues.length,
    exposureValues.length,
    trendedDevelopedRatios.length,
    expectedUltimateRatios.length,
    detrendedExpectedRatios.length,
    capeCodUltimateRatios.length,
  );

  return Array.from({ length: count }, (_, index) => ({
    label: String(labels[index] ?? index + 1),
    latestRatio: ratio(latestValues[index], exposureValues[index]),
    trendedLatestRatio: ratio(trendedLatestValues[index], exposureValues[index]),
    trendedDevelopedRatio: finiteNumber(trendedDevelopedRatios[index]),
    expectedUltimateRatio: finiteNumber(expectedUltimateRatios[index]),
    detrendedExpectedRatio: finiteNumber(detrendedExpectedRatios[index]),
    capeCodUltimateRatio: finiteNumber(capeCodUltimateRatios[index]),
  }));
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

function chartRange(rows) {
  const values = [];
  for (const row of rows) {
    for (const series of SERIES) {
      const value = finiteNumber(row[series.key]);
      if (value !== null) values.push(value);
    }
  }
  if (!values.length) return null;

  let dataMin = Math.min(...values);
  let dataMax = Math.max(...values);
  if (dataMin === dataMax) {
    const spread = Math.max(Math.abs(dataMin) * 0.05, 0.05);
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

function ratioFormatter(decimalPlaces, scalePercent) {
  const decimals = Math.max(0, Math.min(8, Number.parseInt(String(decimalPlaces ?? 2), 10) || 0));
  const numberFormat = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return {
    format(value) {
      const number = finiteNumber(value);
      if (number === null) return "";
      return scalePercent ? `${numberFormat.format(number * 100)}%` : numberFormat.format(number);
    },
  };
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

function drawLegend(legend) {
  if (!legend) return;
  legend.replaceChildren(...SERIES.map((series) => {
    const item = document.createElement("span");
    item.className = "ccChartLegendItem";
    const swatch = document.createElement("span");
    swatch.className = "ccChartLegendSwatch";
    swatch.style.setProperty("--cc-chart-series", series.color);
    swatch.setAttribute("aria-hidden", "true");
    item.append(swatch, document.createTextNode(series.label));
    return item;
  }));
}

export function createCapeCodRatiosChart({ canvas, legend, emptyState, tooltip } = {}) {
  if (!canvas) return null;

  let data = {};
  let points = [];
  let animationFrame = null;
  const resizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => scheduleRender())
    : null;

  drawLegend(legend);
  resizeObserver?.observe(canvas);

  function hideTooltip() {
    if (!tooltip) return;
    tooltip.hidden = true;
  }

  function scalePercent() {
    return data?.scalingType !== "unscaled";
  }

  function draw() {
    animationFrame = null;
    const { context, width, height } = setCanvasSize(canvas);
    context.clearRect(0, 0, width, height);
    context.fillStyle = getChartColor("--ar-chart-background", "#ffffff");
    context.fillRect(0, 0, width, height);
    points = [];

    const rows = buildChartRows(data);
    const range = chartRange(rows);
    const hasChartSpace = width >= 240 && height >= 180;
    const isEmpty = !range || !rows.length || !hasChartSpace;
    if (emptyState) {
      emptyState.hidden = !isEmpty;
      emptyState.textContent = hasChartSpace
        ? "Select source data to plot ratio series."
        : "Expand the window to view the chart.";
    }
    canvas.classList.toggle("isEmpty", isEmpty);
    canvas.setAttribute(
      "aria-label",
      isEmpty
        ? "Cape Cod ratio chart. No values are available."
        : `Cape Cod ratio chart with ${rows.length} origin periods and six series.`,
    );
    if (isEmpty) return;

    const format = ratioFormatter(data?.decimalPlaces, scalePercent());
    context.font = '11px Arial, "Segoe UI", sans-serif';
    const widestTick = Math.max(...range.ticks.map((tick) => context.measureText(format.format(tick)).width));
    const rotateLabels = rows.length > 10 || rows.some((row) => row.label.length > 8);
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
    const xSpan = Math.max(1, rows.length - 1);
    const xFor = (index) => (rows.length === 1
      ? (x0 + x1) / 2
      : x0 + (index / xSpan) * (x1 - x0));
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
    const labelEvery = Math.max(1, Math.ceil(rows.length / maxLabels));
    context.fillStyle = getChartColor("--ar-chart-text", "#4b5563");
    context.textBaseline = "top";
    for (let index = 0; index < rows.length; index += 1) {
      if (index % labelEvery !== 0 && index !== rows.length - 1) continue;
      const x = xFor(index);
      context.save();
      if (rotateLabels) {
        context.translate(x - 2, y1 + 10);
        context.rotate(-Math.PI / 4);
        context.textAlign = "right";
        context.fillText(rows[index].label, 0, 0);
      } else {
        context.textAlign = "center";
        context.fillText(rows[index].label, x, y1 + 10);
      }
      context.restore();
    }

    for (const series of SERIES) {
      context.strokeStyle = series.color;
      context.lineWidth = 2;
      context.lineJoin = "round";
      context.lineCap = "round";
      context.beginPath();
      let segmentOpen = false;
      for (let index = 0; index < rows.length; index += 1) {
        const value = finiteNumber(rows[index][series.key]);
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

      for (let index = 0; index < rows.length; index += 1) {
        const value = finiteNumber(rows[index][series.key]);
        if (value === null) continue;
        const x = xFor(index);
        const y = yFor(value);
        context.fillStyle = getChartColor("--ar-chart-point-fill", "#ffffff");
        context.strokeStyle = series.color;
        context.lineWidth = 1.8;
        context.beginPath();
        context.arc(x, y, 3, 0, Math.PI * 2);
        context.fill();
        context.stroke();
        points.push({ x, y, value, origin: rows[index].label, series });
      }
    }
  }

  function scheduleRender() {
    if (animationFrame !== null) return;
    animationFrame = requestAnimationFrame(draw);
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
    const format = ratioFormatter(data?.decimalPlaces, scalePercent());
    const title = document.createElement("strong");
    title.textContent = nearest.series.label;
    const detail = document.createElement("span");
    detail.textContent = `${nearest.origin}: ${format.format(nearest.value)}`;
    tooltip.replaceChildren(title, detail);
    tooltip.style.left = `${Math.min(Math.max(8, pointerX + 12), Math.max(8, bounds.width - 190))}px`;
    tooltip.style.top = `${Math.max(8, pointerY - 48)}px`;
    tooltip.hidden = false;
  }

  canvas.addEventListener("pointermove", showTooltip);
  canvas.addEventListener("pointerleave", hideTooltip);
  window.addEventListener("arcrho:color-theme-changed", scheduleRender);

  return {
    render(nextData = {}) {
      data = nextData;
      hideTooltip();
      scheduleRender();
    },
    refresh: scheduleRender,
    destroy() {
      resizeObserver?.disconnect();
      canvas.removeEventListener("pointermove", showTooltip);
      canvas.removeEventListener("pointerleave", hideTooltip);
      window.removeEventListener("arcrho:color-theme-changed", scheduleRender);
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    },
  };
}

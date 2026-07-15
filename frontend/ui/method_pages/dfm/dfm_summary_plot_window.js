const STYLE_ID = "dfm-summary-plot-window-style";

const SERIES_COLORS = [
  "#1f5ca8",
  "#2f8f5b",
  "#b44d4d",
  "#7a4fb2",
  "#b2771f",
  "#247c8f",
  "#8b3f73",
  "#587229",
  "#4d617a",
  "#a0462f",
];

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .dfmSummaryPlotWindow {
      position: fixed;
      z-index: 2600;
      left: 50%;
      top: 50%;
      width: min(980px, calc(100vw - 40px));
      height: min(620px, calc(100vh - 40px));
      min-width: 520px;
      min-height: 360px;
      display: flex;
      flex-direction: column;
      background: #fff;
      border: 1px solid #b8c5d8;
      border-radius: 6px;
      box-shadow: 0 16px 36px rgba(15, 23, 42, 0.24);
      resize: both;
      overflow: hidden;
      color: #1f2937;
      font-family: var(--dfm-font, "Segoe UI", Tahoma, Arial, sans-serif);
    }
    .dfmSummaryPlotHeader {
      min-height: 34px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 0 10px 0 12px;
      border-bottom: 1px solid #d9e1ec;
      background: #f6f8fb;
      cursor: move;
      user-select: none;
    }
    .dfmSummaryPlotTitle {
      margin: 0;
      font-size: 13px;
      font-weight: 700;
      color: #0f2450;
    }
    .dfmSummaryPlotClose {
      width: 26px;
      height: 26px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: #526071;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
    }
    .dfmSummaryPlotClose:hover {
      background: #e8eef7;
      color: #1f2937;
    }
    .dfmSummaryPlotBody {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px;
      overflow: hidden;
    }
    .dfmSummaryPlotToolbar {
      flex: 0 0 auto;
      min-height: 32px;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 6px;
      border: 1px solid #dce4ef;
      border-radius: 5px;
      background: #f8fafc;
    }
    .dfmSummaryPlotToolBtn {
      width: 28px;
      height: 26px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid #b8c5d8;
      border-radius: 4px;
      background: #fff;
      color: #12396e;
      cursor: pointer;
    }
    .dfmSummaryPlotToolBtn:hover,
    .dfmSummaryPlotToolBtn.active {
      border-color: #225baa;
      background: #eaf2ff;
      color: #0f3d82;
    }
    .dfmSummaryPlotToolBtn svg {
      width: 16px;
      height: 16px;
      pointer-events: none;
    }
    .dfmSummaryPlotModeToggle {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      margin-left: 4px;
      padding-left: 8px;
      border-left: 1px solid #d6dfeb;
    }
    .dfmSummaryPlotModeBtn {
      height: 26px;
      min-width: 58px;
      padding: 0 8px;
      border: 1px solid #b8c5d8;
      border-radius: 4px;
      background: #fff;
      color: #12396e;
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      line-height: 1;
    }
    .dfmSummaryPlotModeBtn:hover,
    .dfmSummaryPlotModeBtn.active {
      border-color: #225baa;
      background: #eaf2ff;
      color: #0f3d82;
    }
    .dfmSummaryPlotContent {
      flex: 1 1 auto;
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 180px;
      gap: 10px;
      overflow: hidden;
    }
    .dfmSummaryPlotChartWrap {
      min-width: 0;
      min-height: 0;
      border: 1px solid #dce4ef;
      border-radius: 5px;
      background: #fff;
      overflow: hidden;
    }
    .dfmSummaryPlotSvg {
      display: block;
      width: 100%;
      height: 100%;
      min-height: 280px;
      background: #fff;
    }
    .dfmSummaryPlotChartWrap.zoomMode .dfmSummaryPlotSvg {
      cursor: zoom-in;
    }
    .dfmSummaryPlotChartWrap.panMode .dfmSummaryPlotSvg {
      cursor: grab;
    }
    .dfmSummaryPlotChartWrap.panMode.panning .dfmSummaryPlotSvg {
      cursor: grabbing;
    }
    .dfmSummaryPlotChartWrap.pencilMode .dfmSummaryPlotSvg {
      cursor: crosshair;
    }
    .dfmSummaryPlotChartWrap.zoomMode,
    .dfmSummaryPlotChartWrap.panMode,
    .dfmSummaryPlotChartWrap.pencilMode {
      touch-action: none;
    }
    .dfmSummaryPlotHitArea {
      fill: transparent;
      pointer-events: all;
    }
    .dfmSummaryPlotSelection {
      fill: rgba(34, 91, 170, 0.14);
      stroke: #225baa;
      stroke-width: 1;
      stroke-dasharray: 4 3;
      pointer-events: none;
    }
    .dfmSummaryPlotLegend {
      min-width: 0;
      overflow: auto;
      border: 1px solid #dce4ef;
      border-radius: 5px;
      background: #fbfcff;
      padding: 8px;
    }
    .dfmSummaryPlotLegendTitle {
      margin: 0 0 8px;
      font-size: 12px;
      font-weight: 700;
      color: #1f2937;
    }
    .dfmSummaryPlotLegendItem {
      display: flex;
      align-items: center;
      gap: 7px;
      margin: 0 0 7px;
      font-size: 12px;
      color: #384253;
      line-height: 1.25;
      cursor: pointer;
      user-select: none;
    }
    .dfmSummaryPlotLegendItem.is-hidden .dfmSummaryPlotLegendLabel,
    .dfmSummaryPlotLegendItem.is-hidden .dfmSummaryPlotSwatch {
      opacity: 0.4;
    }
    .dfmSummaryPlotLegendItem.is-select-all {
      font-weight: 600;
    }
    .dfmSummaryPlotSwatch {
      width: 16px;
      height: 3px;
      flex: 0 0 auto;
      border-radius: 999px;
    }
    .dfmSummaryPlotLegendLabel {
      min-width: 0;
      flex: 1 1 auto;
      overflow-wrap: anywhere;
    }
    .dfmSummaryPlotLegendChk {
      flex: 0 0 auto;
      margin: 0 0 0 auto;
    }
    .dfmSummaryPlotEmpty {
      padding: 18px;
      color: #526071;
      font-size: 13px;
    }
    @media (max-width: 760px) {
      .dfmSummaryPlotWindow {
        min-width: min(420px, calc(100vw - 24px));
      }
      .dfmSummaryPlotContent {
        grid-template-columns: 1fr;
      }
      .dfmSummaryPlotLegend {
        max-height: 120px;
      }
    }
  `;
  document.head.appendChild(style);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseNumericCell(text) {
  const cleaned = String(text || "").replace(/,/g, "").trim();
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function getDevelopmentLabels(summaryTable) {
  const wrap = summaryTable?.closest?.("#ratioWrap");
  const headers = Array.from(wrap?.querySelectorAll?.("table.ratioMainTable thead th[data-col]") || [])
    .filter((cell) => String(cell.dataset.col || "") !== "all");
  if (headers.length) {
    return headers.map((cell, index) => String(cell.textContent || "").trim() || `Col ${index + 1}`);
  }
  const firstRow = summaryTable?.querySelector?.("tr[data-row-id]");
  const count = firstRow ? firstRow.querySelectorAll("td.summaryCell").length : 0;
  return Array.from({ length: count }, (_unused, index) => `Col ${index + 1}`);
}

function extractSummaryPlotData(summaryTable) {
  const xLabels = getDevelopmentLabels(summaryTable);
  const rows = Array.from(summaryTable?.querySelectorAll?.("tr[data-row-id]") || []);
  const series = rows.map((row, rowIndex) => {
    const label = String(row.querySelector("th")?.textContent || `Series ${rowIndex + 1}`).replace(/\s+/g, " ").trim();
    const values = Array.from(row.querySelectorAll("td.summaryCell")).map((cell) => parseNumericCell(cell.textContent));
    return {
      label: label || `Series ${rowIndex + 1}`,
      rowId: String(row.dataset.rowId || ""),
      color: SERIES_COLORS[rowIndex % SERIES_COLORS.length],
      values,
    };
  }).filter((item) => item.values.some((value) => Number.isFinite(value)));
  const selectedRow = summaryTable
    ?.closest?.("#ratioWrap")
    ?.querySelector?.('table.ratioSelectedTable tr[data-row-id="selected"]');
  if (selectedRow) {
    const selectedValues = Array.from(selectedRow.querySelectorAll("td[data-col]"))
      .map((cell) => parseNumericCell(cell.textContent));
    if (selectedValues.some((value) => Number.isFinite(value))) {
      series.push({
        label: "Selected",
        rowId: "selected",
        isSelected: true,
        color: "#111827",
        values: selectedValues,
        dash: "7 4",
      });
    }
  }
  return { xLabels, series };
}

function valuesToPercentDeveloped(values) {
  const output = new Array(values.length).fill(null);
  let running = null;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (!Number.isFinite(value)) {
      running = null;
      continue;
    }
    if (index === values.length - 1) {
      running = value;
    } else if (Number.isFinite(running)) {
      running = value * running;
    } else {
      running = null;
      continue;
    }
    if (Number.isFinite(running) && running !== 0) {
      output[index] = (1 / running) * 100;
    }
  }
  return output;
}

function buildPercentDevelopedPlotData(summaryTable) {
  const base = extractSummaryPlotData(summaryTable);
  return {
    xLabels: base.xLabels,
    mode: "percent-developed",
    series: base.series
      .map((item) => ({
        ...item,
        values: valuesToPercentDeveloped(item.values),
      }))
      .filter((item) => item.values.some((value) => Number.isFinite(value))),
  };
}

function getSummaryPlotData(summaryTable, mode) {
  if (mode === "percent-developed") return buildPercentDevelopedPlotData(summaryTable);
  return { ...extractSummaryPlotData(summaryTable), mode: "values" };
}

function niceNumber(value) {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs >= 1000 || abs < 0.001) return value.toExponential(2);
  return String(Math.round(value * 10000) / 10000);
}

function formatPlotValue(value, mode) {
  const text = niceNumber(value);
  return mode === "percent-developed" && text ? `${text}%` : text;
}

function getChartScale(series, xMin = 0, xMax = Number.POSITIVE_INFINITY) {
  const values = series.flatMap((item) => item.values.map((value, index) => (
    index >= xMin && index <= xMax ? value : null
  ))).filter((value) => Number.isFinite(value));
  if (!values.length) return { min: 0, max: 1 };
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    const pad = Math.abs(min || 1) * 0.1;
    min -= pad;
    max += pad;
  }
  const padding = (max - min) * 0.08;
  return { min: min - padding, max: max + padding };
}

function renderChart(data, zoom = null, hiddenSet = new Set()) {
  const width = 900;
  const height = 420;
  const pad = { left: 62, right: 26, top: 24, bottom: 72 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const { xLabels, series } = data;
  const colCount = Math.max(1, xLabels.length);
  const xMin = Math.max(0, Number.isFinite(zoom?.xMin) ? zoom.xMin : 0);
  const xMax = Math.min(colCount - 1, Number.isFinite(zoom?.xMax) ? zoom.xMax : colCount - 1);
  const baseScale = getChartScale(series, Math.floor(xMin), Math.ceil(xMax));
  const min = Number.isFinite(zoom?.yMin) ? zoom.yMin : baseScale.min;
  const max = Number.isFinite(zoom?.yMax) ? zoom.yMax : baseScale.max;
  const xSpan = Math.max(1e-9, xMax - xMin);
  const xFor = (index) => pad.left + (colCount === 1 ? plotW / 2 : ((index - xMin) / xSpan) * plotW);
  const yFor = (value) => pad.top + (1 - ((value - min) / (max - min))) * plotH;
  const yTicks = Array.from({ length: 5 }, (_unused, index) => min + ((max - min) * index) / 4);
  const mode = data?.mode || "values";
  const grid = yTicks.map((tick) => {
    const y = yFor(tick);
    return `
      <line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="#e6ebf2" />
      <text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="#667085">${escapeHtml(formatPlotValue(tick, mode))}</text>
    `;
  }).join("");
  const labelStep = Math.max(1, Math.ceil(colCount / 12));
  const xAxisLabels = xLabels.map((label, index) => {
    if (index < Math.ceil(xMin) || index > Math.floor(xMax)) return "";
    if (index % labelStep !== 0 && index !== colCount - 1) return "";
    const x = xFor(index);
    return `<text x="${x}" y="${height - 24}" text-anchor="end" font-size="11" fill="#667085" transform="rotate(-38 ${x} ${height - 24})">${escapeHtml(label)}</text>`;
  }).join("");
  const lines = series.map((item, seriesIndex) => {
    if (hiddenSet.has(seriesIndex)) return "";
    const points = item.values
      .map((value, index) => Number.isFinite(value) ? `${xFor(index)},${yFor(value)}` : "")
      .filter(Boolean)
      .join(" ");
    const markers = item.values.map((value, index) => {
      if (!Number.isFinite(value)) return "";
      return `<circle cx="${xFor(index)}" cy="${yFor(value)}" r="3" fill="${item.color}"><title>${escapeHtml(item.label)} ${escapeHtml(xLabels[index] || "")}: ${escapeHtml(formatPlotValue(value, mode))}</title></circle>`;
    }).join("");
    const dash = item.dash ? ` stroke-dasharray="${escapeHtml(item.dash)}"` : "";
    const widthAttr = item.label === "Selected" ? "3" : "2";
    return `<polyline points="${points}" fill="none" stroke="${item.color}" stroke-width="${widthAttr}"${dash} stroke-linejoin="round" stroke-linecap="round" />${markers}`;
  }).join("");

  return `
    <svg class="dfmSummaryPlotSvg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Average formula table plot"
      data-plot-left="${pad.left}" data-plot-top="${pad.top}" data-plot-width="${plotW}" data-plot-height="${plotH}"
      data-x-min="${xMin}" data-x-max="${xMax}" data-y-min="${min}" data-y-max="${max}">
      <defs>
        <clipPath id="dfmSummaryPlotClip"><rect x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}" /></clipPath>
      </defs>
      <rect x="0" y="0" width="${width}" height="${height}" fill="#fff" />
      ${grid}
      <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" stroke="#aeb8c8" />
      <line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" stroke="#aeb8c8" />
      ${xAxisLabels}
      <g clip-path="url(#dfmSummaryPlotClip)">${lines}</g>
      <rect class="dfmSummaryPlotHitArea" x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}" />
    </svg>
  `;
}

function getFullZoomDomain(data) {
  const colCount = Math.max(1, data?.xLabels?.length || 0);
  const scale = getChartScale(data?.series || [], 0, colCount - 1);
  return { xMin: 0, xMax: colCount - 1, yMin: scale.min, yMax: scale.max };
}

function clampZoomToFullDomain(nextZoom, fullZoom) {
  const clampAxis = (min, max, fullMin, fullMax) => {
    const fullSpan = Math.max(1e-9, fullMax - fullMin);
    const span = Math.min(Math.max(1e-9, max - min), fullSpan);
    if (span >= fullSpan - 1e-9) return { min: fullMin, max: fullMax };
    let nextMin = min;
    let nextMax = min + span;
    if (nextMin < fullMin) {
      nextMin = fullMin;
      nextMax = fullMin + span;
    }
    if (nextMax > fullMax) {
      nextMax = fullMax;
      nextMin = fullMax - span;
    }
    return { min: nextMin, max: nextMax };
  };
  const x = clampAxis(nextZoom.xMin, nextZoom.xMax, fullZoom.xMin, fullZoom.xMax);
  const y = clampAxis(nextZoom.yMin, nextZoom.yMax, fullZoom.yMin, fullZoom.yMax);
  return { xMin: x.min, xMax: x.max, yMin: y.min, yMax: y.max };
}

function getPlotCssMetrics(svg) {
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox?.baseVal;
  const viewWidth = Math.max(1, viewBox?.width || 900);
  const viewHeight = Math.max(1, viewBox?.height || 420);
  const plotWidth = Number(svg.dataset.plotWidth);
  const plotHeight = Number(svg.dataset.plotHeight);
  return {
    width: Math.max(1, rect.width * ((Number.isFinite(plotWidth) ? plotWidth : viewWidth) / viewWidth)),
    height: Math.max(1, rect.height * ((Number.isFinite(plotHeight) ? plotHeight : viewHeight) / viewHeight)),
  };
}

function renderLegend(series, hiddenSet = new Set()) {
  if (!series.length) return "";
  const selectAllChecked = hiddenSet.size === 0;
  const selectAllMixed = hiddenSet.size > 0 && hiddenSet.size < series.length;
  const selectAll = `
    <div class="dfmSummaryPlotLegendItem is-select-all" data-action="select-all">
      <span class="dfmSummaryPlotLegendLabel">Select All</span>
      <input class="dfmSummaryPlotLegendChk" type="checkbox" ${selectAllChecked ? "checked" : ""} data-mixed="${selectAllMixed ? "1" : "0"}" aria-label="Select all lines">
    </div>
  `;
  const items = series.map((item, index) => {
    const hidden = hiddenSet.has(index);
    return `
    <div class="dfmSummaryPlotLegendItem${hidden ? " is-hidden" : ""}" title="${escapeHtml(item.label)}" data-index="${index}">
      <span class="dfmSummaryPlotSwatch" style="background:${item.color}"></span>
      <span class="dfmSummaryPlotLegendLabel">${escapeHtml(item.label)}</span>
      <input class="dfmSummaryPlotLegendChk" type="checkbox" ${hidden ? "" : "checked"} aria-label="Show ${escapeHtml(item.label)}">
    </div>
  `;
  }).join("");
  return `<p class="dfmSummaryPlotLegendTitle">Rows</p>${selectAll}${items}`;
}

function placeWindow(win) {
  const rect = win.getBoundingClientRect();
  const left = Math.max(16, (window.innerWidth - rect.width) / 2);
  const top = Math.max(16, (window.innerHeight - rect.height) / 2);
  win.style.left = `${left}px`;
  win.style.top = `${top}px`;
  win.style.transform = "none";
}

function enableDrag(win, header) {
  if (!win || !header) return;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  function onMove(event) {
    if (!dragging) return;
    const nextLeft = Math.min(window.innerWidth - 80, Math.max(8, startLeft + event.clientX - startX));
    const nextTop = Math.min(window.innerHeight - 40, Math.max(8, startTop + event.clientY - startY));
    win.style.left = `${nextLeft}px`;
    win.style.top = `${nextTop}px`;
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mouseup", onUp, true);
  }
  header.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    if (event.target?.closest?.("button")) return;
    const rect = win.getBoundingClientRect();
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    event.preventDefault();
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
  });
}

function svgPoint(svg, event) {
  const pt = svg.createSVGPoint();
  pt.x = event.clientX;
  pt.y = event.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function domainFromSvgPoint(svg, point) {
  const left = Number(svg.dataset.plotLeft);
  const top = Number(svg.dataset.plotTop);
  const width = Number(svg.dataset.plotWidth);
  const height = Number(svg.dataset.plotHeight);
  const xMin = Number(svg.dataset.xMin);
  const xMax = Number(svg.dataset.xMax);
  const yMin = Number(svg.dataset.yMin);
  const yMax = Number(svg.dataset.yMax);
  const x = clamp(point.x, left, left + width);
  const y = clamp(point.y, top, top + height);
  return {
    x: xMin + ((x - left) / width) * (xMax - xMin),
    y: yMax - ((y - top) / height) * (yMax - yMin),
    svgX: x,
    svgY: y,
  };
}

function svgPointForData(svg, colCount, index, value) {
  const left = Number(svg.dataset.plotLeft);
  const top = Number(svg.dataset.plotTop);
  const width = Number(svg.dataset.plotWidth);
  const height = Number(svg.dataset.plotHeight);
  const xMin = Number(svg.dataset.xMin);
  const xMax = Number(svg.dataset.xMax);
  const yMin = Number(svg.dataset.yMin);
  const yMax = Number(svg.dataset.yMax);
  const xSpan = Math.max(1e-9, xMax - xMin);
  return {
    x: left + (colCount === 1 ? width / 2 : ((index - xMin) / xSpan) * width),
    y: top + (1 - ((value - yMin) / Math.max(1e-9, yMax - yMin))) * height,
  };
}

function findNearestEditablePoint(data, svg, event, hiddenSet) {
  const pointer = svgPoint(svg, event);
  const rect = svg.getBoundingClientRect();
  const viewWidth = Math.max(1, svg.viewBox?.baseVal?.width || 900);
  const threshold = Math.max(8, Math.min(18, 10 * (viewWidth / Math.max(1, rect.width))));
  const colCount = Math.max(1, data?.xLabels?.length || 0);
  let best = null;
  (data?.series || []).forEach((series, seriesIndex) => {
    if (hiddenSet?.has?.(seriesIndex) || series?.isSelected || !series?.rowId) return;
    (series.values || []).forEach((value, col) => {
      if (!Number.isFinite(value)) return;
      const point = svgPointForData(svg, colCount, col, value);
      const left = Number(svg.dataset.plotLeft);
      const top = Number(svg.dataset.plotTop);
      const width = Number(svg.dataset.plotWidth);
      const height = Number(svg.dataset.plotHeight);
      if (point.x < left || point.x > left + width || point.y < top || point.y > top + height) return;
      const dist = Math.hypot(point.x - pointer.x, point.y - pointer.y);
      if (dist > threshold) return;
      if (!best || dist < best.dist) {
        best = { seriesIndex, rowId: series.rowId, col, value, label: series.label, dist };
      }
    });
  });
  return best;
}

function setSelectionRect(rect, start, current) {
  const x = Math.min(start.svgX, current.svgX);
  const y = Math.min(start.svgY, current.svgY);
  const width = Math.abs(current.svgX - start.svgX);
  const height = Math.abs(current.svgY - start.svgY);
  rect.setAttribute("x", String(x));
  rect.setAttribute("y", String(y));
  rect.setAttribute("width", String(width));
  rect.setAttribute("height", String(height));
}

export function openDfmSummaryPlotWindow(summaryTable, options = {}) {
  ensureStyles();
  const existing = document.querySelector(".dfmSummaryPlotWindow");
  if (existing) existing.remove();
  let plotMode = "values";
  let data = getSummaryPlotData(summaryTable, plotMode);
  const win = document.createElement("div");
  win.className = "dfmSummaryPlotWindow";
  let zoom = null;
  let activeTool = "";
  const hiddenSeries = new Set();
  win.innerHTML = `
    <div class="dfmSummaryPlotHeader">
      <h2 class="dfmSummaryPlotTitle">Average Formula Table Plot</h2>
      <button class="dfmSummaryPlotClose" type="button" aria-label="Close">&times;</button>
    </div>
    <div class="dfmSummaryPlotBody">
      <div class="dfmSummaryPlotToolbar" role="toolbar" aria-label="Plot tools">
        <button class="dfmSummaryPlotToolBtn" type="button" data-tool="zoom" title="Zoom: drag a chart area to zoom; click the chart to reset" aria-label="Zoom">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"></circle>
            <path d="M10.5 7.5v6M7.5 10.5h6M15.5 15.5 21 21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
          </svg>
        </button>
        <button class="dfmSummaryPlotToolBtn" type="button" data-tool="pan" title="Drag: pan the current chart view" aria-label="Drag">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 12V6.8a1.8 1.8 0 0 1 3.6 0V11" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"></path>
            <path d="M11.6 11V5.8a1.8 1.8 0 0 1 3.6 0V12" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"></path>
            <path d="M15.2 12V8.3a1.8 1.8 0 0 1 3.6 0v5.2c0 4.5-2.8 7-7.2 7H10c-2.2 0-3.8-.8-5.1-2.6L2.6 14.8a1.8 1.8 0 0 1 2.8-2.2L8 15.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"></path>
          </svg>
        </button>
        <button class="dfmSummaryPlotToolBtn" type="button" data-tool="pencil" title="Pencil: click an average formula point to use it as the selected value" aria-label="Pencil">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 20h4.2L19.5 8.7a2.4 2.4 0 0 0 0-3.4l-.8-.8a2.4 2.4 0 0 0-3.4 0L4 15.8V20Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"></path>
            <path d="M13.7 6.1 17.9 10.3M4 15.8 8.2 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
          </svg>
        </button>
        <div class="dfmSummaryPlotModeToggle" role="group" aria-label="Graph mode">
          <button class="dfmSummaryPlotModeBtn active" type="button" data-mode="values">Ratios</button>
          <button class="dfmSummaryPlotModeBtn" type="button" data-mode="percent-developed">% Dev</button>
        </div>
      </div>
      <div class="dfmSummaryPlotContent">
        <div class="dfmSummaryPlotChartWrap"></div>
        <div class="dfmSummaryPlotLegend"></div>
      </div>
    </div>
  `;
  document.body.appendChild(win);
  placeWindow(win);
  enableDrag(win, win.querySelector(".dfmSummaryPlotHeader"));

  const chartWrap = win.querySelector(".dfmSummaryPlotChartWrap");
  const legendEl = win.querySelector(".dfmSummaryPlotLegend");
  const zoomBtn = win.querySelector('[data-tool="zoom"]');
  const panBtn = win.querySelector('[data-tool="pan"]');
  const pencilBtn = win.querySelector('[data-tool="pencil"]');
  const modeBtns = Array.from(win.querySelectorAll(".dfmSummaryPlotModeBtn"));
  let interaction = null;
  let pendingPanZoom = null;
  let panRaf = 0;

  const close = () => {
    document.removeEventListener("keydown", onKeyDown);
    cancelActiveInteraction();
    win.remove();
  };

  function onKeyDown(event) {
    if (event.key !== "Escape" || !activeTool) return;
    event.preventDefault();
    cancelActiveInteraction();
    activeTool = "";
    render();
  }

  const render = () => {
    if (!chartWrap) return;
    chartWrap.classList.toggle("zoomMode", activeTool === "zoom");
    chartWrap.classList.toggle("panMode", activeTool === "pan");
    chartWrap.classList.toggle("pencilMode", activeTool === "pencil");
    if (zoomBtn) zoomBtn.classList.toggle("active", activeTool === "zoom");
    if (panBtn) panBtn.classList.toggle("active", activeTool === "pan");
    if (pencilBtn) pencilBtn.classList.toggle("active", activeTool === "pencil");
    modeBtns.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === plotMode);
    });
    chartWrap.innerHTML = data.series.length
      ? renderChart(data, zoom, hiddenSeries)
      : '<div class="dfmSummaryPlotEmpty">No numeric summary table values to plot.</div>';
    if (legendEl) {
      legendEl.innerHTML = renderLegend(data.series, hiddenSeries);
      legendEl.querySelectorAll(".dfmSummaryPlotLegendChk[data-mixed='1']").forEach((checkbox) => {
        checkbox.indeterminate = true;
      });
    }
  };

  const toggleSeries = (index, checked) => {
    if (!Number.isFinite(index)) return;
    if (!checked && hiddenSeries.size >= data.series.length - 1) {
      render();
      return;
    }
    if (checked) hiddenSeries.delete(index);
    else hiddenSeries.add(index);
    render();
  };

  const toggleSelectAll = (checked) => {
    if (checked) {
      hiddenSeries.clear();
    } else {
      hiddenSeries.clear();
      for (let index = 0; index < data.series.length; index += 1) hiddenSeries.add(index);
    }
    render();
  };

  const showOnlySeries = (index) => {
    if (!Number.isFinite(index)) return;
    const isOnlyVisible = hiddenSeries.size === data.series.length - 1 && !hiddenSeries.has(index);
    hiddenSeries.clear();
    if (!isOnlyVisible) {
      for (let itemIndex = 0; itemIndex < data.series.length; itemIndex += 1) {
        if (itemIndex !== index) hiddenSeries.add(itemIndex);
      }
    }
    render();
  };

  const schedulePanRender = (nextZoom) => {
    pendingPanZoom = nextZoom;
    if (panRaf) return;
    panRaf = requestAnimationFrame(() => {
      panRaf = 0;
      if (!pendingPanZoom) return;
      zoom = pendingPanZoom;
      pendingPanZoom = null;
      render();
    });
  };

  const releasePointer = (pointerId) => {
    try {
      chartWrap?.releasePointerCapture?.(pointerId);
    } catch (_err) {
      // Pointer capture may already be released by the browser.
    }
  };

  function cancelActiveInteraction() {
    if (interaction?.pointerId != null) releasePointer(interaction.pointerId);
    interaction?.rect?.remove();
    interaction = null;
    pendingPanZoom = null;
    if (panRaf) {
      cancelAnimationFrame(panRaf);
      panRaf = 0;
    }
    chartWrap?.classList.remove("panning");
  }

  const applyPencilPick = (event) => {
    const svg = chartWrap?.querySelector?.(".dfmSummaryPlotSvg");
    if (!svg) return false;
    const point = findNearestEditablePoint(data, svg, event, hiddenSeries);
    if (!point) return false;
    if (typeof options?.onSelectAveragePoint === "function") {
      const changed = options.onSelectAveragePoint({
        rowId: point.rowId,
        col: point.col,
        value: point.value,
        label: point.label,
      });
      if (changed === false) return false;
    }
    data = getSummaryPlotData(summaryTable, plotMode);
    render();
    return true;
  };

  const onChartPointerDown = (event) => {
    if (!activeTool || event.button !== 0) return;
    if (!event.target?.classList?.contains("dfmSummaryPlotHitArea")) return;
    const svg = chartWrap?.querySelector?.(".dfmSummaryPlotSvg");
    if (!svg) return;
    event.preventDefault();
    if (activeTool === "pencil") {
      applyPencilPick(event);
      return;
    }
    chartWrap?.setPointerCapture?.(event.pointerId);
    if (activeTool === "pan") {
      interaction = {
        type: "pan",
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        baseZoom: zoom || getFullZoomDomain(data),
      };
      chartWrap?.classList.add("panning");
      return;
    }
    const start = domainFromSvgPoint(svg, svgPoint(svg, event));
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.classList.add("dfmSummaryPlotSelection");
    rect.setAttribute("x", String(start.svgX));
    rect.setAttribute("y", String(start.svgY));
    rect.setAttribute("width", "0");
    rect.setAttribute("height", "0");
    svg.appendChild(rect);
    interaction = {
      type: "zoom",
      pointerId: event.pointerId,
      start,
      rect,
      moved: false,
    };
  };

  const onChartPointerMove = (event) => {
    if (!interaction || event.pointerId !== interaction.pointerId) return;
    const svg = chartWrap?.querySelector?.(".dfmSummaryPlotSvg");
    if (!svg) return;
    if (interaction.type === "pan") {
      const full = getFullZoomDomain(data);
      const plotSize = getPlotCssMetrics(svg);
      const spanX = interaction.baseZoom.xMax - interaction.baseZoom.xMin;
      const spanY = interaction.baseZoom.yMax - interaction.baseZoom.yMin;
      const domainDeltaX = -((event.clientX - interaction.startClientX) / plotSize.width) * spanX;
      const domainDeltaY = ((event.clientY - interaction.startClientY) / plotSize.height) * spanY;
      const nextZoom = clampZoomToFullDomain({
        xMin: interaction.baseZoom.xMin + domainDeltaX,
        xMax: interaction.baseZoom.xMax + domainDeltaX,
        yMin: interaction.baseZoom.yMin + domainDeltaY,
        yMax: interaction.baseZoom.yMax + domainDeltaY,
      }, full);
      schedulePanRender(nextZoom);
      return;
    }
    const current = domainFromSvgPoint(svg, svgPoint(svg, event));
    interaction.moved = interaction.moved
      || Math.abs(current.svgX - interaction.start.svgX) > 3
      || Math.abs(current.svgY - interaction.start.svgY) > 3;
    setSelectionRect(interaction.rect, interaction.start, current);
  };

  const finishChartPointer = (event) => {
    if (!interaction || event.pointerId !== interaction.pointerId) return;
    releasePointer(event.pointerId);
    if (interaction.type === "pan") {
      if (pendingPanZoom) {
        zoom = pendingPanZoom;
        pendingPanZoom = null;
      }
      if (panRaf) {
        cancelAnimationFrame(panRaf);
        panRaf = 0;
      }
      interaction = null;
      chartWrap?.classList.remove("panning");
      render();
      return;
    }
    const svg = chartWrap?.querySelector?.(".dfmSummaryPlotSvg");
    const zoomInteraction = interaction;
    interaction = null;
    zoomInteraction.rect?.remove();
    if (!svg) return;
    const current = domainFromSvgPoint(svg, svgPoint(svg, event));
    if (!zoomInteraction.moved) {
      zoom = null;
      render();
      return;
    }
    const xA = Math.min(zoomInteraction.start.x, current.x);
    const xB = Math.max(zoomInteraction.start.x, current.x);
    const yA = Math.min(zoomInteraction.start.y, current.y);
    const yB = Math.max(zoomInteraction.start.y, current.y);
    if ((xB - xA) < 0.05 || (yB - yA) <= 1e-9) return;
    zoom = { xMin: xA, xMax: xB, yMin: yA, yMax: yB };
    render();
  };

  const cancelChartPointer = (event) => {
    if (!interaction || event.pointerId !== interaction.pointerId) return;
    cancelActiveInteraction();
  };

  if (chartWrap) {
    chartWrap.addEventListener("pointerdown", onChartPointerDown);
    chartWrap.addEventListener("pointermove", onChartPointerMove);
    chartWrap.addEventListener("pointerup", finishChartPointer);
    chartWrap.addEventListener("pointercancel", cancelChartPointer);
  };

  legendEl?.addEventListener("click", (event) => {
    if (event.target?.closest?.(".dfmSummaryPlotLegendChk")) return;
    const item = event.target?.closest?.(".dfmSummaryPlotLegendItem");
    if (!item || !legendEl.contains(item)) return;
    event.preventDefault();
    if (item.dataset.action === "select-all") {
      const shouldShowAll = hiddenSeries.size > 0;
      toggleSelectAll(shouldShowAll);
      return;
    }
    const index = Number(item.dataset.index);
    toggleSeries(index, hiddenSeries.has(index));
  });

  legendEl?.addEventListener("change", (event) => {
    const checkbox = event.target?.closest?.(".dfmSummaryPlotLegendChk");
    if (!checkbox) return;
    const item = checkbox.closest(".dfmSummaryPlotLegendItem");
    if (!item || !legendEl.contains(item)) return;
    event.stopPropagation();
    if (item.dataset.action === "select-all") {
      toggleSelectAll(checkbox.checked);
      return;
    }
    toggleSeries(Number(item.dataset.index), checkbox.checked);
  });

  legendEl?.addEventListener("contextmenu", (event) => {
    const item = event.target?.closest?.(".dfmSummaryPlotLegendItem");
    if (!item || !legendEl.contains(item)) return;
    if (item.dataset.action === "select-all") return;
    event.preventDefault();
    showOnlySeries(Number(item.dataset.index));
  });

  zoomBtn?.addEventListener("click", () => {
    activeTool = activeTool === "zoom" ? "" : "zoom";
    render();
  });
  panBtn?.addEventListener("click", () => {
    activeTool = activeTool === "pan" ? "" : "pan";
    render();
  });
  pencilBtn?.addEventListener("click", () => {
    activeTool = activeTool === "pencil" ? "" : "pencil";
    render();
  });
  modeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode === "percent-developed" ? "percent-developed" : "values";
      if (mode === plotMode) return;
      plotMode = mode;
      data = getSummaryPlotData(summaryTable, plotMode);
      zoom = null;
      hiddenSeries.clear();
      cancelActiveInteraction();
      render();
    });
  });
  document.addEventListener("keydown", onKeyDown);
  win.querySelector(".dfmSummaryPlotClose")?.addEventListener("click", close);
  render();
}

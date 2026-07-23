import {
  getEffectiveDevLabelsForModel,
  getResolvedProjectName,
  getResolvedReservingClass,
  markDfmDirty,
  state,
} from "/ui/method_pages/dfm/dfm_state.js";
import { openProjectNameTreePicker } from "/ui/shared/components/pickers/project_name_tree_picker.js";

const STYLE_ID = "dfm-developed-curve-window-style";
const MENU_ID = "dfmDevelopedCurveMenu";
const X_AXIS_LABEL = "Development Month";
const CURVE_TYPE_LABELS = new Map([
  ["linear", "Linear"],
  ["smooth", "Smooth"],
  ["step", "Step"],
  ["trend-exponential", "Exponential"],
  ["trend-logarithmic", "Logarithmic"],
  ["trend-power", "Power"],
]);
const SERIES_COLORS = ["#1f5ca8", "#b45309", "#047857", "#7c3aed", "#be123c", "#0f766e"];
const curveTypesBySegmentLabel = new Map();
const curveTypesBySegmentIndex = new Map();

function getChartColor(propertyName, fallback) {
  return window.ArcRhoColorTheme?.getCssColor?.(propertyName, fallback) || fallback;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseNumber(value) {
  const text = String(value ?? "").replace(/,/g, "");
  const match = text.match(/[-+]?\d*\.?\d+/);
  if (!match) return null;
  const parsed = Number(match[0]);
  if (!Number.isFinite(parsed)) return null;
  return text.includes("%") ? parsed / 100 : parsed;
}

function normalizeCurveType(value) {
  const raw = String(value || "").trim();
  if (CURVE_TYPE_LABELS.has(raw)) return raw;
  const lowered = raw.toLowerCase();
  for (const [type, label] of CURVE_TYPE_LABELS.entries()) {
    if (label.toLowerCase() === lowered) return type;
  }
  return "linear";
}

function getSegmentLabel(point, index) {
  const label = String(point?.label || "").trim();
  return label || `Segment ${index + 1}`;
}

function getSavedCurveTypeForPoint(point, index) {
  const label = getSegmentLabel(point, index);
  return normalizeCurveType(
    curveTypesBySegmentLabel.get(label) ||
    curveTypesBySegmentIndex.get(index) ||
    "linear",
  );
}

function rememberCurveTypes(points, segmentTypes) {
  curveTypesBySegmentLabel.clear();
  curveTypesBySegmentIndex.clear();
  points.forEach((point, index) => {
    const type = normalizeCurveType(segmentTypes?.[index]);
    curveTypesBySegmentLabel.set(getSegmentLabel(point, index), type);
    curveTypesBySegmentIndex.set(index, type);
  });
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .dfmDevelopedCurveWindow {
      position: fixed;
      z-index: 2650;
      left: 50%;
      top: 50%;
      width: min(980px, calc(100vw - 44px));
      height: min(620px, calc(100vh - 44px));
      min-width: 560px;
      min-height: 380px;
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
    .dfmDevelopedCurveHeader {
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
    .dfmDevelopedCurveTitle {
      margin: 0;
      font-size: 13px;
      font-weight: 700;
      color: #0f2450;
    }
    .dfmDevelopedCurveClose {
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
    .dfmDevelopedCurveClose:hover {
      background: #e8eef7;
      color: #1f2937;
    }
    .dfmDevelopedCurveBody {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px;
      overflow: hidden;
    }
    .dfmDevelopedCurveProjectBar {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px;
      border: 1px solid #dce4ef;
      border-radius: 5px;
      background: #f8fafc;
      font-size: 12px;
    }
    .dfmDevelopedCurveProjectBar label {
      color: #334155;
      font-weight: 600;
      white-space: nowrap;
    }
    .dfmDevelopedCurveProjectInputWrap {
      flex: 1 1 220px;
      min-width: 160px;
      display: flex;
      align-items: stretch;
    }
    .dfmDevelopedCurveProjectInputWrap input {
      flex: 1 1 auto;
      min-width: 0;
      height: 26px;
      border: 1px solid #b8c5d8;
      border-right: 0;
      border-radius: 4px 0 0 4px;
      padding: 3px 7px;
      background: #fff;
      color: #1f2937;
      font: inherit;
    }
    .dfmDevelopedCurveProjectBar button {
      height: 26px;
      border: 1px solid #9eb5d6;
      border-radius: 4px;
      background: #1f5ca8;
      color: #fff;
      font: inherit;
      padding: 0 10px;
      cursor: pointer;
    }
    .dfmDevelopedCurveProjectBar .dfmDevelopedCurveProjectPicker {
      width: 30px;
      min-width: 30px;
      padding: 0;
      border-color: #b8c5d8;
      border-radius: 0 4px 4px 0;
      background: #eef3fb;
      color: #334155;
      font-weight: 700;
    }
    .dfmDevelopedCurveProjectBar .dfmDevelopedCurveProjectPicker:hover {
      background: #e2ebf7;
      color: #0f3d82;
    }
    .dfmDevelopedCurveProjectBar button:disabled {
      opacity: 0.62;
      cursor: default;
    }
    .dfmDevelopedCurveProjectStatus {
      flex: 1 1 180px;
      min-width: 120px;
      color: #526071;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dfmDevelopedCurveProjectStatus.error {
      color: #b42318;
      font-weight: 600;
    }
    .dfmDevelopedCurveToolbar {
      flex: 0 0 auto;
      max-height: 128px;
      padding: 6px;
      border: 1px solid #dce4ef;
      border-radius: 5px;
      background: #f8fafc;
      font-size: 12px;
      overflow: auto hidden;
    }
    .dfmDevelopedCurveToolbarTitle {
      margin-bottom: 5px;
      font-weight: 600;
      color: #334155;
    }
    .dfmDevelopedCurveSegmentTable {
      border-collapse: collapse;
      width: max-content;
      min-width: 100%;
      table-layout: fixed;
    }
    .dfmDevelopedCurveSegmentTable th,
    .dfmDevelopedCurveSegmentTable td {
      height: 30px;
      border: 1px solid #d7e0ec;
      padding: 3px 6px;
      background: #fff;
      vertical-align: middle;
    }
    .dfmDevelopedCurveSegmentTable th {
      position: sticky;
      left: 0;
      z-index: 1;
      width: 88px;
      min-width: 88px;
      background: #edf3fb;
      color: #334155;
      font-weight: 700;
      text-align: left;
      white-space: nowrap;
    }
    .dfmDevelopedCurveSegmentPeriod {
      width: 128px;
      min-width: 128px;
      max-width: 128px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #334155;
    }
    .dfmDevelopedCurveSegmentType {
      width: 128px;
      min-width: 128px;
      max-width: 128px;
    }
    .dfmDevelopedCurveSegmentType select {
      height: 24px;
      width: 100%;
      border: 1px solid #b8c5d8;
      border-radius: 0;
      background: #fff;
      color: #1f2937;
      font: inherit;
    }
    .dfmDevelopedCurveChartWrap {
      flex: 1 1 auto;
      min-height: 0;
      border: 1px solid #dce4ef;
      border-radius: 5px;
      background: #fff;
      overflow: hidden;
    }
    .dfmDevelopedCurveSvg {
      display: block;
      width: 100%;
      height: 100%;
      min-height: 300px;
      background: #fff;
    }
    .dfmDevelopedCurveEmpty {
      padding: 18px;
      color: #526071;
      font-size: 13px;
    }
    .dfmDevelopedCurveMenu {
      position: fixed;
      z-index: 2700;
      min-width: 210px;
      padding: 4px;
      border: 1px solid #b8c5d8;
      border-radius: 5px;
      background: #fff;
      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.22);
      font-family: var(--dfm-font, "Segoe UI", Tahoma, Arial, sans-serif);
    }
    .dfmDevelopedCurveMenu button {
      width: 100%;
      min-height: 28px;
      display: block;
      border: 0;
      border-radius: 3px;
      background: transparent;
      color: #172033;
      font: inherit;
      font-size: 12px;
      text-align: left;
      padding: 5px 8px;
      cursor: pointer;
    }
    .dfmDevelopedCurveMenu button:hover {
      background: #eaf2ff;
      color: #0f3d82;
    }
  `;
  document.head.appendChild(style);
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
    if (event.button !== 0 || event.target?.closest?.("button")) return;
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

function parseFirstDevMonthFromLabel(label) {
  const text = String(label || "").trim();
  const nums = [...text.matchAll(/\d*\.?\d+/g)].map((match) => Number(match[0]))
    .filter((value) => Number.isFinite(value));
  if (!nums.length) return null;
  return nums[0];
}

function readDevelopedCurvePoints(selectedTable) {
  const wrap = selectedTable?.closest?.("#ratioWrap");
  const headers = Array.from(wrap?.querySelectorAll?.("table.ratioMainTable thead th[data-col]") || [])
    .filter((cell) => String(cell.dataset.col || "") !== "all");
  const dataDevLabels = getEffectiveDevLabelsForModel(state?.model || {});
  const developedRow = selectedTable?.querySelector?.('tr[data-row-id="percent-developed"]');
  const developedCells = Array.from(developedRow?.querySelectorAll?.("td[data-col]") || []);
  return developedCells.map((cell, index) => {
    const col = Number(cell.dataset.col);
    const header = headers.find((item) => Number(item.dataset.col) === col);
    const label = String(header?.textContent || `Dev ${index + 1}`).trim();
    const xLabel = dataDevLabels[col] ?? label;
    return {
      x: parseFirstDevMonthFromLabel(xLabel),
      y: parseNumber(cell.textContent),
      label,
      col,
    };
  }).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .sort((a, b) => a.x - b.x);
}

function monthlyRange(start, end) {
  const min = Math.ceil(start);
  const max = Math.floor(end);
  const out = [];
  for (let x = min; x <= max; x += 1) out.push(x);
  return out.length ? out : [end];
}

function interpolateSegmentSmooth(start, end, x) {
  const t = (x - start.x) / Math.max(1e-9, end.x - start.x);
  const eased = t * t * (3 - 2 * t);
  return start.y + (end.y - start.y) * eased;
}

function fitSegmentTransformed(start, end, transformX, transformY, inverseY) {
  const sx = transformX(start.x);
  const ex = transformX(end.x);
  const sy = transformY(start.y);
  const ey = transformY(end.y);
  if (![sx, ex, sy, ey].every(Number.isFinite) || Math.abs(ex - sx) < 1e-9) return null;
  const slope = (ey - sy) / (ex - sx);
  const intercept = sy - slope * sx;
  return (x) => inverseY(intercept + slope * transformX(x));
}

function interpolateSegment(start, end, x, curveType) {
  if (curveType === "step") return x < end.x ? start.y : end.y;
  if (curveType === "smooth") return interpolateSegmentSmooth(start, end, x);
  if (curveType === "trend-exponential") {
    const fn = fitSegmentTransformed(start, end, (v) => v, Math.log, Math.exp);
    if (fn) return fn(x);
  }
  if (curveType === "trend-logarithmic") {
    const fn = fitSegmentTransformed(start, end, Math.log, (v) => v, (v) => v);
    if (fn) return fn(x);
  }
  if (curveType === "trend-power") {
    const fn = fitSegmentTransformed(start, end, Math.log, Math.log, Math.exp);
    if (fn) return fn(x);
  }
  return start.y + (end.y - start.y) * ((x - start.x) / Math.max(1e-9, end.x - start.x));
}

function buildSegmentedCurve(points, segmentTypes) {
  const curve = [];
  const seen = new Set();
  points.forEach((end, index) => {
    const start = index === 0
      ? { x: 1, y: 0, label: "Month 1" }
      : points[index - 1];
    if (!Number.isFinite(start.x) || !Number.isFinite(end.x) || end.x < start.x) return;
    const type = segmentTypes[index] || "linear";
    monthlyRange(start.x, end.x).forEach((x) => {
      if (seen.has(x)) return;
      seen.add(x);
      const y = interpolateSegment(start, end, x, type);
      if (Number.isFinite(y)) curve.push({ x, y });
    });
  });
  return curve.sort((a, b) => a.x - b.x);
}

function niceNumber(value) {
  if (!Number.isFinite(value)) return "";
  const pct = value * 100;
  return `${(Math.round(pct * 10) / 10).toFixed(1)}%`;
}

function renderChart(seriesList, segmentTypes) {
  const usableSeries = (Array.isArray(seriesList) ? seriesList : [])
    .filter((series) => Array.isArray(series?.points) && series.points.length);
  if (!usableSeries.length) return '<div class="dfmDevelopedCurveEmpty">Not enough % Developed points to plot.</div>';
  const width = 900;
  const height = 420;
  const pad = { left: 70, right: 26, top: 46, bottom: 66 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const renderedSeries = usableSeries.map((series, index) => ({
    ...series,
    color: series.color || SERIES_COLORS[index % SERIES_COLORS.length],
    curve: buildSegmentedCurve(series.points, segmentTypes),
  }));
  const allPoints = renderedSeries.flatMap((series) => [...series.points, ...series.curve]);
  const allY = allPoints.map((point) => point.y).filter(Number.isFinite);
  const allX = allPoints.map((point) => point.x).filter(Number.isFinite);
  const xMin = Math.min(1, ...allX);
  const xMax = Math.max(...allX);
  let yMin = Math.min(...allY, 0);
  let yMax = Math.max(...allY, 1);
  if (yMin === yMax) {
    yMin -= 0.05;
    yMax += 0.05;
  }
  const yPad = (yMax - yMin) * 0.08;
  yMin = Math.max(0, yMin - yPad);
  yMax += yPad;
  const xFor = (x) => pad.left + ((x - xMin) / Math.max(1e-9, xMax - xMin)) * plotW;
  const yFor = (y) => pad.top + (1 - ((y - yMin) / Math.max(1e-9, yMax - yMin))) * plotH;
  const yTicks = Array.from({ length: 5 }, (_unused, index) => yMin + ((yMax - yMin) * index) / 4);
  const xTickStep = Math.max(1, Math.ceil((xMax - xMin) / 10));
  const xTicks = [];
  for (let x = Math.ceil(xMin); x <= Math.floor(xMax); x += xTickStep) xTicks.push(x);
  if (!xTicks.includes(xMax)) xTicks.push(xMax);
  const chartBackground = escapeHtml(getChartColor("--ar-chart-background", "#ffffff"));
  const chartGrid = escapeHtml(getChartColor("--ar-chart-svg-grid", "#e6ebf2"));
  const chartAxis = escapeHtml(getChartColor("--ar-chart-svg-axis", "#aeb8c8"));
  const chartText = escapeHtml(getChartColor("--ar-chart-svg-text", "#475569"));
  const chartTextMuted = escapeHtml(getChartColor("--ar-chart-svg-text-muted", "#667085"));
  const chartPointFill = escapeHtml(getChartColor("--ar-chart-point-fill", "#ffffff"));
  const grid = yTicks.map((tick) => {
    const y = yFor(tick);
    return `
      <line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="${chartGrid}" />
      <text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="${chartTextMuted}">${escapeHtml(niceNumber(tick))}</text>
    `;
  }).join("");
  const xLabels = xTicks.map((tick) => {
    const x = xFor(tick);
    return `<text x="${x}" y="${height - 26}" text-anchor="middle" font-size="11" fill="${chartTextMuted}">${escapeHtml(tick)}m</text>`;
  }).join("");
  const seriesLines = renderedSeries.map((series) => {
    const curvePoints = series.curve.map((point) => `${xFor(point.x)},${yFor(point.y)}`).join(" ");
    if (!curvePoints) return "";
    return `<polyline points="${curvePoints}" fill="none" stroke="${escapeHtml(series.color)}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />`;
  }).join("");
  const actualPoints = renderedSeries.map((series) => series.points.map((point) => `
    <circle cx="${xFor(point.x)}" cy="${yFor(point.y)}" r="4" fill="${chartPointFill}" stroke="${escapeHtml(series.color)}" stroke-width="2">
      <title>${escapeHtml(series.name)} - ${escapeHtml(point.label)}: ${escapeHtml(niceNumber(point.y))}</title>
    </circle>
  `).join("")).join("");
  const legend = renderedSeries.map((series, index) => {
    const x = width - pad.right - 190;
    const y = 16 + index * 16;
    return `
      <line x1="${x}" y1="${y}" x2="${x + 22}" y2="${y}" stroke="${escapeHtml(series.color)}" stroke-width="3" stroke-linecap="round" />
      <text x="${x + 28}" y="${y + 4}" font-size="11" fill="${chartText}">${escapeHtml(series.name)}</text>
    `;
  }).join("");
  return `
    <svg class="dfmDevelopedCurveSvg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Percentage developed curve">
      <rect x="0" y="0" width="${width}" height="${height}" fill="${chartBackground}" />
      ${legend}
      ${grid}
      <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" stroke="${chartAxis}" />
      <line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" stroke="${chartAxis}" />
      ${xLabels}
      <text x="${pad.left + plotW / 2}" y="${height - 8}" text-anchor="middle" font-size="12" fill="${chartText}">${escapeHtml(X_AXIS_LABEL)}</text>
      <text x="18" y="${pad.top + plotH / 2}" text-anchor="middle" font-size="12" fill="${chartText}" transform="rotate(-90 18 ${pad.top + plotH / 2})">% Developed</text>
      ${seriesLines}
      ${actualPoints}
    </svg>
  `;
}

function curveTypeOptions(selected) {
  const options = [
    ["linear", "Linear"],
    ["smooth", "Smooth"],
    ["step", "Step"],
    ["trend-exponential", "Exponential"],
    ["trend-logarithmic", "Logarithmic"],
    ["trend-power", "Power"],
  ];
  return options.map(([value, label]) => (
    `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`
  )).join("");
}

function renderSegmentControls(points, segmentTypes) {
  if (!points.length) return "";
  const periodCells = points.map((point, index) => {
    const startLabel = index === 0 ? "1" : String(points[index - 1].x);
    const endLabel = String(point.x);
    const title = `${point.label}: ${startLabel}-${endLabel} months`;
    return `<td class="dfmDevelopedCurveSegmentPeriod" title="${escapeHtml(title)}">${escapeHtml(point.label)}</td>`;
  }).join("");
  const typeCells = points.map((point, index) => {
    const startLabel = index === 0 ? "1" : String(points[index - 1].x);
    const endLabel = String(point.x);
    const title = `${point.label}: ${startLabel}-${endLabel} months`;
    return `
      <td class="dfmDevelopedCurveSegmentType" title="${escapeHtml(title)}">
        <select aria-label="${escapeHtml(`Curve type for ${point.label}`)}" data-segment-index="${index}">
          ${curveTypeOptions(segmentTypes[index] || "linear")}
        </select>
      </td>
    `;
  }).join("");
  return `
    <div class="dfmDevelopedCurveToolbarTitle">Curve Type By Segment</div>
    <table class="dfmDevelopedCurveSegmentTable" aria-label="Curve type by segment">
      <tbody>
        <tr>
          <th scope="row">Period</th>
          ${periodCells}
        </tr>
        <tr>
          <th scope="row">Curve Type</th>
          ${typeCells}
        </tr>
      </tbody>
    </table>
  `;
}

function getCurrentDfmContext() {
  return {
    projectName: getResolvedProjectName() || String(document.getElementById("projectSelect")?.value || "").trim(),
    reservingClass: getResolvedReservingClass() || String(document.getElementById("pathInput")?.value || "").trim(),
    methodName: String(document.getElementById("dfmMethodName")?.value || "").trim(),
  };
}

function normalizeCurvePoints(points) {
  return (Array.isArray(points) ? points : [])
    .map((point, index) => ({
      x: Number(point?.x),
      y: Number(point?.y),
      label: String(point?.label || `Dev ${index + 1}`),
      col: Number.isFinite(Number(point?.col)) ? Number(point.col) : index,
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .sort((a, b) => a.x - b.x);
}

async function readResponseError(response) {
  try {
    const data = await response.json();
    if (typeof data?.detail === "string") return data.detail;
    if (Array.isArray(data?.detail)) return data.detail.map((item) => item?.msg || String(item)).join("; ");
  } catch {}
  try {
    const text = await response.text();
    if (text) return text;
  } catch {}
  return `Request failed (${response.status})`;
}

async function fetchPriorProjectCurve(projectName, context) {
  const params = new URLSearchParams({
    project_name: projectName,
    reserving_class: context.reservingClass,
    method_name: context.methodName,
  });
  const response = await fetch(`/dfm/percent-developed-curve?${params.toString()}`);
  if (!response.ok) throw new Error(await readResponseError(response));
  const data = await response.json();
  const points = normalizeCurvePoints(data?.points);
  if (!points.length) throw new Error("Selected project has no % Developed curve points for this DFM.");
  return {
    id: `project:${projectName.toLowerCase()}`,
    name: projectName,
    points,
  };
}

function setProjectStatus(win, text, isError = false) {
  const status = win?.querySelector?.(".dfmDevelopedCurveProjectStatus");
  if (!status) return;
  status.textContent = text || "";
  status.classList.toggle("error", !!isError);
  status.title = text || "";
}

export function openPercentDevelopedCurveWindow(selectedTable) {
  ensureStyles();
  const existing = document.querySelector(".dfmDevelopedCurveWindow");
  if (existing) {
    if (typeof existing.__dfmDevelopedCurveClose === "function") existing.__dfmDevelopedCurveClose();
    else existing.remove();
  }
  const points = readDevelopedCurvePoints(selectedTable);
  const segmentTypes = points.map((point, index) => getSavedCurveTypeForPoint(point, index));
  const context = getCurrentDfmContext();
  const seriesList = [{
    id: "current",
    name: context.projectName || "Current project",
    points,
    color: SERIES_COLORS[0],
  }];
  rememberCurveTypes(points, segmentTypes);
  const win = document.createElement("div");
  win.className = "dfmDevelopedCurveWindow";
  win.innerHTML = `
    <div class="dfmDevelopedCurveHeader">
      <h2 class="dfmDevelopedCurveTitle">% Developed Curve</h2>
      <button class="dfmDevelopedCurveClose" type="button" aria-label="Close">&times;</button>
    </div>
    <div class="dfmDevelopedCurveBody">
      <div class="dfmDevelopedCurveProjectBar">
        <label for="dfmDevelopedCurvePriorProject">Prior Project</label>
        <div class="dfmDevelopedCurveProjectInputWrap">
          <input id="dfmDevelopedCurvePriorProject" type="text" placeholder="Optional project name" autocomplete="off" />
          <button class="dfmDevelopedCurveProjectPicker" type="button" title="Select prior project" aria-label="Select prior project">...</button>
        </div>
        <button class="dfmDevelopedCurveAddProject" type="button">Add Curve</button>
        <span class="dfmDevelopedCurveProjectStatus" aria-live="polite"></span>
      </div>
      <div class="dfmDevelopedCurveToolbar">${renderSegmentControls(points, segmentTypes)}</div>
      <div class="dfmDevelopedCurveChartWrap"></div>
    </div>
  `;
  document.body.appendChild(win);
  placeWindow(win);
  enableDrag(win, win.querySelector(".dfmDevelopedCurveHeader"));
  const chartWrap = win.querySelector(".dfmDevelopedCurveChartWrap");
  const render = () => {
    if (chartWrap) chartWrap.innerHTML = renderChart(seriesList, segmentTypes);
  };
  const close = () => {
    window.removeEventListener("arcrho:color-theme-changed", render);
    win.remove();
  };
  win.__dfmDevelopedCurveClose = close;
  window.addEventListener("arcrho:color-theme-changed", render);
  const addProjectCurve = async () => {
    const input = win.querySelector("#dfmDevelopedCurvePriorProject");
    const button = win.querySelector(".dfmDevelopedCurveAddProject");
    const projectName = String(input?.value || "").trim();
    if (!projectName) {
      setProjectStatus(win, "Enter a prior project name.", true);
      return;
    }
    if (!context.reservingClass || !context.methodName) {
      setProjectStatus(win, "Current path and method name are required.", true);
      return;
    }
    if (projectName.toLowerCase() === String(context.projectName || "").toLowerCase()) {
      setProjectStatus(win, "Enter a different project name.", true);
      return;
    }
    if (button) button.disabled = true;
    setProjectStatus(win, "Loading prior project curve...");
    try {
      const series = await fetchPriorProjectCurve(projectName, context);
      const existingIndex = seriesList.findIndex((item) => item.id === series.id);
      series.color = SERIES_COLORS[(existingIndex >= 0 ? existingIndex : seriesList.length) % SERIES_COLORS.length];
      if (existingIndex >= 0) {
        seriesList[existingIndex] = series;
      } else {
        seriesList.push(series);
      }
      setProjectStatus(win, `Added ${projectName}.`);
      render();
    } catch (err) {
      setProjectStatus(win, err?.message || "Could not add prior project curve.", true);
    } finally {
      if (button) button.disabled = false;
    }
  };
  const openPriorProjectPicker = async () => {
    const input = win.querySelector("#dfmDevelopedCurvePriorProject");
    const anchor = win.querySelector(".dfmDevelopedCurveProjectInputWrap") || input;
    await openProjectNameTreePicker({
      initialProject: input?.value || "",
      anchorElement: anchor || null,
      title: "Select Prior Project",
      setStatus: (text) => setProjectStatus(win, text, false),
      onError: (err) => {
        console.error("Failed to load project tree:", err);
        setProjectStatus(win, "Error loading project tree.", true);
      },
      onSelect: (projectName) => {
        const selected = String(projectName || "").trim();
        if (!selected || !input) return;
        input.value = selected;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        setProjectStatus(win, "");
      },
    });
  };
  win.querySelector(".dfmDevelopedCurveToolbar")?.addEventListener("change", (event) => {
    const select = event.target?.closest?.("select[data-segment-index]");
    if (!select) return;
    const index = Number(select.dataset.segmentIndex);
    if (!Number.isFinite(index)) return;
    segmentTypes[index] = normalizeCurveType(select.value);
    rememberCurveTypes(points, segmentTypes);
    markDfmDirty();
    render();
  });
  win.querySelector(".dfmDevelopedCurveAddProject")?.addEventListener("click", addProjectCurve);
  win.querySelector(".dfmDevelopedCurveProjectPicker")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openPriorProjectPicker();
  });
  win.querySelector("#dfmDevelopedCurvePriorProject")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addProjectCurve();
  });
  win.querySelector(".dfmDevelopedCurveClose")?.addEventListener("click", close);
  render();
}

function getMenu() {
  ensureStyles();
  let menu = document.getElementById(MENU_ID);
  if (menu) return menu;
  menu = document.createElement("div");
  menu.id = MENU_ID;
  menu.className = "dfmDevelopedCurveMenu";
  menu.style.display = "none";
  menu.innerHTML = `
    <button type="button" data-action="copy-value">Copy value</button>
    <button type="button" data-action="show-curve">Show Percentage Developed Curve</button>
  `;
  document.body.appendChild(menu);
  document.addEventListener("mousedown", (event) => {
    if (!menu.contains(event.target)) menu.style.display = "none";
  });
  return menu;
}

export function wirePercentDevelopedCurveMenu(selectedTable) {
  if (!selectedTable || selectedTable.dataset.developedCurveMenuWired === "1") return;
  selectedTable.dataset.developedCurveMenuWired = "1";
  selectedTable.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const menu = getMenu();
    menu.__selectedTable = selectedTable;
    menu.style.display = "block";
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
  });
  const menu = getMenu();
  if (menu.dataset.clickWired !== "1") {
    menu.dataset.clickWired = "1";
    menu.addEventListener("click", (event) => {
      const btn = event.target?.closest?.("[data-action]");
      if (!btn) return;
      if (btn.dataset.action === "copy-value" && typeof window.__arcRhoCopyActiveGridSelection === "function") {
        void window.__arcRhoCopyActiveGridSelection();
      } else if (btn.dataset.action === "show-curve" && menu.__selectedTable) {
        openPercentDevelopedCurveWindow(menu.__selectedTable);
      }
      menu.style.display = "none";
    });
  }
}

/* Fan chart for the Results tab: the simulated mean by origin as a line, the
   DFM's figure as a dashed line, and one shaded band per symmetric pair of the
   chosen percentiles, the narrower bands painted darker over the wider ones.
   The page model computes the bands (fanChartData); this module only draws
   them, redraws when its box or the colour theme changes, and names the
   origin's figures on hover. */

import { formatAxisTick } from "/ui/method_pages/bootstrap/bootstrap_page_model.js?v=20260923b";

const COLORS = Object.freeze({
  band: [43, 109, 246],
  mean: "#2b6df6",
  dfm: "#475569",
});

function chartColor(propertyName, fallback) {
  return window.ArcRhoColorTheme?.getCssColor?.(propertyName, fallback) || fallback;
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function niceStep(span, targetTicks = 5) {
  const raw = Math.max(span, Number.EPSILON) / Math.max(1, targetTicks);
  const power = 10 ** Math.floor(Math.log10(raw));
  const scaled = raw / power;
  const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return nice * power;
}

const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function setCanvasSize(canvas) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
  }
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width, height };
}

/* Opacity of a band: the widest is faintest and each narrower one adds to it. */
export function fanBandAlpha(index, count) {
  if (count <= 1) return 0.22;
  return 0.1 + (0.2 * index) / (count - 1);
}

export function createFanChart({ canvas, legend, tooltip, emptyState } = {}) {
  if (!canvas) return null;
  let data = null;
  let columns = [];
  let frame = null;

  function renderLegend() {
    if (!legend) return;
    const items = [];
    const add = (label, swatchStyle) => {
      const item = document.createElement("span");
      item.className = "bstChartLegendItem";
      const swatch = document.createElement("span");
      swatch.className = "bstChartLegendSwatch";
      swatch.setAttribute("aria-hidden", "true");
      Object.assign(swatch.style, swatchStyle);
      item.append(swatch, document.createTextNode(label));
      items.push(item);
    };
    if (data) {
      add("Mean", { background: COLORS.mean, height: "2px" });
      add("DFM", { borderTop: `2px dashed ${COLORS.dfm}`, height: "0" });
      const count = data.bands.length;
      data.bands.forEach((band, index) => {
        const [r, g, b] = COLORS.band;
        add(`${band.lower}% to ${band.upper}%`, { background: `rgba(${r}, ${g}, ${b}, ${fanBandAlpha(index, count) + 0.08})`, height: "10px" });
      });
    }
    legend.replaceChildren(...items);
  }

  function draw() {
    frame = null;
    const { context, width, height } = setCanvasSize(canvas);
    context.clearRect(0, 0, width, height);
    context.fillStyle = chartColor("--ar-chart-background", "#ffffff");
    context.fillRect(0, 0, width, height);
    columns = [];
    const labels = data?.labels || [];
    const values = [];
    for (const series of [data?.mean || [], data?.dfm || []]) values.push(...series.map(finite));
    for (const band of data?.bands || []) values.push(...band.lowerValues.map(finite), ...band.upperValues.map(finite));
    const present = values.filter((value) => value !== null);
    const hasSpace = width >= 220 && height >= 150;
    const isEmpty = !labels.length || !present.length || !hasSpace;
    if (emptyState) {
      emptyState.hidden = !isEmpty;
      emptyState.textContent = !hasSpace && labels.length ? "Expand the window to view the chart." : "No simulated results are stored.";
    }
    canvas.setAttribute("aria-label", isEmpty
      ? "Fan chart. No values are available."
      : `Fan chart of ${labels.length} origins with ${data.bands.length} percentile bands.`);
    if (isEmpty) return;

    let min = Math.min(...present);
    let max = Math.max(...present);
    if (min === max) {
      min -= Math.max(Math.abs(min) * 0.05, 1);
      max += Math.max(Math.abs(max) * 0.05, 1);
    }
    const step = niceStep(max - min, 5);
    const yMin = Math.floor(min / step) * step;
    const yMax = Math.ceil(max / step) * step;
    context.font = '11px Arial, "Segoe UI", sans-serif';
    const ticks = [];
    for (let tick = yMin; tick <= yMax + step * 0.001; tick += step) ticks.push(tick);
    const widest = Math.max(...ticks.map((tick) => context.measureText(formatAxisTick(tick, step)).width));
    const plot = { left: Math.max(46, Math.ceil(widest) + 14), right: width - 16, top: 12, bottom: height - 30 };
    const x = (index) => (labels.length === 1
      ? (plot.left + plot.right) / 2
      : plot.left + (index / (labels.length - 1)) * (plot.right - plot.left));
    const y = (value) => plot.bottom - ((value - yMin) / (yMax - yMin)) * (plot.bottom - plot.top);

    context.lineWidth = 1;
    context.textAlign = "right";
    context.textBaseline = "middle";
    for (const tick of ticks) {
      const py = Math.round(y(tick)) + 0.5;
      context.strokeStyle = chartColor("--ar-chart-grid", "#e5eaf0");
      context.beginPath();
      context.moveTo(plot.left, py);
      context.lineTo(plot.right, py);
      context.stroke();
      context.fillStyle = chartColor("--ar-chart-text-muted", "#5f6b7a");
      context.fillText(formatAxisTick(tick, step), plot.left - 6, py);
    }
    context.strokeStyle = chartColor("--ar-chart-axis", "#aeb8c5");
    context.beginPath();
    context.moveTo(plot.left + 0.5, plot.top);
    context.lineTo(plot.left + 0.5, plot.bottom + 0.5);
    context.lineTo(plot.right, plot.bottom + 0.5);
    context.stroke();

    const labelEvery = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor((plot.right - plot.left) / 44))));
    context.textAlign = "center";
    context.textBaseline = "top";
    context.fillStyle = chartColor("--ar-chart-text", "#4b5563");
    labels.forEach((label, index) => {
      if (index % labelEvery && index !== labels.length - 1) return;
      context.fillText(label, x(index), plot.bottom + 8);
    });

    // Bands: a polygon along the upper values and back along the lower ones,
    // broken wherever an origin has no value.
    const [r, g, b] = COLORS.band;
    data.bands.forEach((band, bandIndex) => {
      context.fillStyle = `rgba(${r}, ${g}, ${b}, ${fanBandAlpha(bandIndex, data.bands.length)})`;
      let run = [];
      const flush = () => {
        if (run.length) {
          context.beginPath();
          run.forEach((point, i) => (i ? context.lineTo(x(point.index), y(point.upper)) : context.moveTo(x(point.index), y(point.upper))));
          for (let i = run.length - 1; i >= 0; i -= 1) context.lineTo(x(run[i].index), y(run[i].lower));
          context.closePath();
          context.fill();
        }
        run = [];
      };
      labels.forEach((_, index) => {
        const lower = finite(band.lowerValues[index]);
        const upper = finite(band.upperValues[index]);
        if (lower === null || upper === null) flush();
        else run.push({ index, lower, upper });
      });
      flush();
    });

    const line = (series, color, dashed) => {
      context.strokeStyle = color;
      context.lineWidth = dashed ? 1.5 : 2;
      context.setLineDash(dashed ? [5, 4] : []);
      context.lineJoin = "round";
      context.beginPath();
      let open = false;
      series.forEach((value, index) => {
        const n = finite(value);
        if (n === null) {
          open = false;
          return;
        }
        if (open) context.lineTo(x(index), y(n));
        else context.moveTo(x(index), y(n));
        open = true;
      });
      context.stroke();
      context.setLineDash([]);
    };
    line(data.dfm, COLORS.dfm, true);
    line(data.mean, COLORS.mean, false);
    data.mean.forEach((value, index) => {
      const n = finite(value);
      if (n === null) return;
      context.fillStyle = chartColor("--ar-chart-point-fill", "#ffffff");
      context.strokeStyle = COLORS.mean;
      context.lineWidth = 1.8;
      context.beginPath();
      context.arc(x(index), y(n), 3, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    });
    columns = labels.map((label, index) => ({ label, index, x: x(index) }));
  }

  function schedule() {
    if (frame !== null) return;
    frame = requestAnimationFrame(draw);
  }

  function hideTooltip() {
    if (tooltip) tooltip.hidden = true;
  }

  function onMove(event) {
    if (!tooltip || !columns.length) return;
    const bounds = canvas.getBoundingClientRect();
    const px = event.clientX - bounds.left;
    let nearest = null;
    for (const column of columns) {
      if (!nearest || Math.abs(column.x - px) < Math.abs(nearest.x - px)) nearest = column;
    }
    if (!nearest || Math.abs(nearest.x - px) > 30) {
      hideTooltip();
      return;
    }
    const title = document.createElement("strong");
    title.textContent = nearest.label;
    const lines = [
      `Mean ${whole.format(finite(data.mean[nearest.index]) ?? 0)}`,
      ...(finite(data.dfm[nearest.index]) !== null ? [`DFM ${whole.format(data.dfm[nearest.index])}`] : []),
      ...data.bands.map((band) => {
        const lower = finite(band.lowerValues[nearest.index]);
        const upper = finite(band.upperValues[nearest.index]);
        return lower === null || upper === null ? "" : `${band.lower}% to ${band.upper}%: ${whole.format(lower)} to ${whole.format(upper)}`;
      }).filter(Boolean),
    ];
    tooltip.replaceChildren(title, ...lines.map((textLine) => {
      const span = document.createElement("span");
      span.textContent = textLine;
      return span;
    }));
    tooltip.style.left = `${Math.min(Math.max(8, px + 12), Math.max(8, bounds.width - 230))}px`;
    tooltip.style.top = `${Math.max(8, event.clientY - bounds.top - 60)}px`;
    tooltip.hidden = false;
  }

  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => schedule()) : null;
  observer?.observe(canvas);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", hideTooltip);
  window.addEventListener("arcrho:color-theme-changed", schedule);

  return {
    render(next) {
      data = next && Array.isArray(next.labels) ? next : null;
      hideTooltip();
      renderLegend();
      schedule();
    },
    refresh: schedule,
  };
}

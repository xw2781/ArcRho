/* Distribution of the total reserve (or ultimate) on the Results tab: the
   stored histogram as bars, the mean as a solid line, and each chosen
   percentile as a dashed marker labelled across the top. It reads only what
   the page model hands it, redraws itself when its box changes size or the
   colour theme changes, and shows a bar's range and share on hover. */

import { formatAxisTick } from "/ui/method_pages/bootstrap/bootstrap_page_model.js?v=20260923b";

const COLORS = Object.freeze({
  bar: "rgba(43, 109, 246, 0.22)",
  barEdge: "rgba(43, 109, 246, 0.55)",
  barHover: "rgba(43, 109, 246, 0.42)",
  mean: "#111827",
  marker: "#b45309",
});

function chartColor(propertyName, fallback) {
  return window.ArcRhoColorTheme?.getCssColor?.(propertyName, fallback) || fallback;
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

export function createDistributionChart({ canvas, tooltip, emptyState } = {}) {
  if (!canvas) return null;
  let data = null;
  let bars = [];
  let hoverIndex = -1;
  let frame = null;

  function draw() {
    frame = null;
    const { context, width, height } = setCanvasSize(canvas);
    context.clearRect(0, 0, width, height);
    context.fillStyle = chartColor("--ar-chart-background", "#ffffff");
    context.fillRect(0, 0, width, height);
    bars = [];
    const hasSpace = width >= 220 && height >= 150;
    const isEmpty = !data || !data.counts.length || !hasSpace;
    if (emptyState) {
      emptyState.hidden = !isEmpty;
      emptyState.textContent = !hasSpace && data ? "Expand the window to view the chart." : "No simulated distribution is stored.";
    }
    canvas.setAttribute("aria-label", isEmpty
      ? "Distribution chart. No values are available."
      : `Distribution of the total over ${whole.format(data.total)} simulations with ${data.markers.length} percentiles marked.`);
    if (isEmpty) return;

    const { counts, lower, upper } = data;
    const span = upper > lower ? upper - lower : Math.max(Math.abs(lower) * 0.1, 1);
    const xMin = upper > lower ? lower : lower - span / 2;
    const xMax = upper > lower ? upper : lower + span / 2;
    const maxShare = Math.max(...counts) / Math.max(1, data.total);
    const yStep = niceStep(maxShare, 4);
    const yMax = Math.max(yStep, Math.ceil(maxShare / yStep) * yStep);
    const plot = { left: 46, right: width - 14, top: 24, bottom: height - 30 };
    const x = (value) => plot.left + ((value - xMin) / (xMax - xMin)) * (plot.right - plot.left);
    const y = (share) => plot.bottom - (share / yMax) * (plot.bottom - plot.top);

    context.font = '11px Arial, "Segoe UI", sans-serif';
    context.lineWidth = 1;
    context.textAlign = "right";
    context.textBaseline = "middle";
    const yDecimals = yStep >= 0.01 ? 0 : 1;
    for (let tick = 0; tick <= yMax + yStep / 2; tick += yStep) {
      const py = Math.round(y(tick)) + 0.5;
      context.strokeStyle = chartColor("--ar-chart-grid", "#e5eaf0");
      context.beginPath();
      context.moveTo(plot.left, py);
      context.lineTo(plot.right, py);
      context.stroke();
      context.fillStyle = chartColor("--ar-chart-text-muted", "#5f6b7a");
      context.fillText(`${(tick * 100).toFixed(yDecimals)}%`, plot.left - 6, py);
    }

    const xStep = niceStep(xMax - xMin, Math.max(2, Math.floor((plot.right - plot.left) / 90)));
    context.textAlign = "center";
    context.textBaseline = "top";
    context.fillStyle = chartColor("--ar-chart-text", "#4b5563");
    for (let tick = Math.ceil(xMin / xStep) * xStep; tick <= xMax + xStep * 0.001; tick += xStep) {
      context.fillText(formatAxisTick(tick, xStep), x(tick), plot.bottom + 8);
    }

    const binWidth = (upper - lower) / counts.length;
    counts.forEach((count, index) => {
      const from = upper > lower ? lower + index * binWidth : xMin;
      const to = upper > lower ? from + binWidth : xMax;
      const left = x(from);
      const right = x(to);
      const top = y(count / Math.max(1, data.total));
      context.fillStyle = index === hoverIndex ? COLORS.barHover : COLORS.bar;
      context.fillRect(left, top, Math.max(1, right - left), plot.bottom - top);
      context.strokeStyle = COLORS.barEdge;
      context.strokeRect(Math.round(left) + 0.5, Math.round(top) + 0.5, Math.max(1, Math.round(right - left)), Math.round(plot.bottom - top));
      bars.push({ left, right, from, to, count });
    });

    context.strokeStyle = chartColor("--ar-chart-axis", "#aeb8c5");
    context.beginPath();
    context.moveTo(plot.left + 0.5, plot.top - 8);
    context.lineTo(plot.left + 0.5, plot.bottom + 0.5);
    context.lineTo(plot.right, plot.bottom + 0.5);
    context.stroke();

    // Percentile markers, labelled along the top; a label that would collide
    // with the one before it drops to a second line.
    context.setLineDash([4, 3]);
    context.strokeStyle = COLORS.marker;
    context.fillStyle = COLORS.marker;
    context.textAlign = "center";
    context.textBaseline = "bottom";
    const lastLabelRight = [-Infinity, -Infinity];
    for (const marker of data.markers) {
      const px = Math.round(x(marker.value)) + 0.5;
      if (px < plot.left || px > plot.right) continue;
      context.beginPath();
      context.moveTo(px, plot.top);
      context.lineTo(px, plot.bottom);
      context.stroke();
      const label = `${marker.percent}%`;
      const half = context.measureText(label).width / 2;
      const row = px - half < lastLabelRight[0] + 4 ? 1 : 0;
      context.fillText(label, px, row ? plot.top - 13 : plot.top - 2);
      lastLabelRight[row] = px + half;
    }
    context.setLineDash([]);

    if (data.mean !== null && data.mean !== undefined) {
      const px = Math.round(x(data.mean)) + 0.5;
      if (px >= plot.left && px <= plot.right) {
        context.strokeStyle = COLORS.mean;
        context.lineWidth = 1.5;
        context.beginPath();
        context.moveTo(px, plot.top);
        context.lineTo(px, plot.bottom);
        context.stroke();
      }
    }
  }

  function schedule() {
    if (frame !== null) return;
    frame = requestAnimationFrame(draw);
  }

  function hideTooltip() {
    if (tooltip) tooltip.hidden = true;
    if (hoverIndex !== -1) {
      hoverIndex = -1;
      schedule();
    }
  }

  function onMove(event) {
    if (!bars.length) return;
    const bounds = canvas.getBoundingClientRect();
    const px = event.clientX - bounds.left;
    const index = bars.findIndex((bar) => px >= bar.left && px < bar.right);
    if (index < 0) {
      hideTooltip();
      return;
    }
    if (index !== hoverIndex) {
      hoverIndex = index;
      schedule();
    }
    if (!tooltip) return;
    const bar = bars[index];
    const title = document.createElement("strong");
    title.textContent = `${whole.format(bar.from)} to ${whole.format(bar.to)}`;
    const detail = document.createElement("span");
    detail.textContent = `${whole.format(bar.count)} simulations (${((bar.count / Math.max(1, data.total)) * 100).toFixed(1)}%)`;
    tooltip.replaceChildren(title, detail);
    tooltip.style.left = `${Math.min(Math.max(8, px + 12), Math.max(8, bounds.width - 200))}px`;
    tooltip.style.top = `${Math.max(8, event.clientY - bounds.top - 48)}px`;
    tooltip.hidden = false;
  }

  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => schedule()) : null;
  observer?.observe(canvas);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", hideTooltip);
  window.addEventListener("arcrho:color-theme-changed", schedule);

  return {
    render(next) {
      data = next || null;
      hoverIndex = -1;
      if (tooltip) tooltip.hidden = true;
      schedule();
    },
    refresh: schedule,
  };
}

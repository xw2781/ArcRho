/* Residual scatter for the Residuals tab: one point per residual, placed at its
   development period, with the flagged residuals in the warning colour and a
   dashed zero line. It redraws itself when its box changes size, so the grid
   and the chart can sit side by side or stack without either one asking. */

const COLORS = Object.freeze({
  axis: "#94a3b8",
  grid: "#e2e8f0",
  zero: "#64748b",
  label: "#475569",
  point: "#2b6df6",
  flagged: "#b45309",
});

function niceStep(span) {
  const raw = span / 6;
  const power = 10 ** Math.floor(Math.log10(raw));
  const scaled = raw / power;
  const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return nice * power;
}

function formatTick(value, step) {
  const decimals = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
  return value.toFixed(decimals);
}

export function createResidualChart({ canvas }) {
  let data = { grid: [], flags: [], labels: [] };

  function draw() {
    if (!canvas?.isConnected) return;
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(box.width * ratio);
    canvas.height = Math.round(box.height * ratio);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, box.width, box.height);

    const points = [];
    data.grid.forEach((row, r) => row.forEach((value, c) => {
      if (value === null || value === undefined) return;
      points.push({ c, value, flagged: !!data.flags[r]?.[c] });
    }));
    const columns = data.labels.length;
    if (!points.length || !columns) return;

    const extent = Math.max(...points.map((point) => Math.abs(point.value)), 1e-9);
    const step = niceStep(extent * 2);
    const top = Math.ceil(extent / step) * step;
    const plot = { left: 46, right: box.width - 12, top: 10, bottom: box.height - 28 };
    const x = (c) => plot.left + ((c + 0.5) / columns) * (plot.right - plot.left);
    const y = (value) => plot.top + ((top - value) / (2 * top)) * (plot.bottom - plot.top);

    ctx.font = "11px Arial, \"Segoe UI\", sans-serif";
    ctx.fillStyle = COLORS.label;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let tick = -top; tick <= top + step / 2; tick += step) {
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plot.left, Math.round(y(tick)) + 0.5);
      ctx.lineTo(plot.right, Math.round(y(tick)) + 0.5);
      ctx.stroke();
      ctx.fillText(formatTick(tick, step), plot.left - 6, y(tick));
    }
    ctx.strokeStyle = COLORS.zero;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(plot.left, Math.round(y(0)) + 0.5);
    ctx.lineTo(plot.right, Math.round(y(0)) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labelEvery = Math.max(1, Math.ceil(columns / Math.max(1, (plot.right - plot.left) / 44)));
    data.labels.forEach((label, c) => {
      if (c % labelEvery) return;
      ctx.fillText(label, x(c), plot.bottom + 8);
    });
    ctx.strokeStyle = COLORS.axis;
    ctx.beginPath();
    ctx.moveTo(plot.left + 0.5, plot.top);
    ctx.lineTo(plot.left + 0.5, plot.bottom + 0.5);
    ctx.lineTo(plot.right, plot.bottom + 0.5);
    ctx.stroke();

    for (const point of points) {
      const px = x(point.c);
      const py = y(point.value);
      ctx.strokeStyle = point.flagged ? COLORS.flagged : COLORS.point;
      ctx.lineWidth = point.flagged ? 2 : 1.5;
      ctx.beginPath();
      ctx.moveTo(px - 3.5, py - 3.5);
      ctx.lineTo(px + 3.5, py + 3.5);
      ctx.moveTo(px + 3.5, py - 3.5);
      ctx.lineTo(px - 3.5, py + 3.5);
      ctx.stroke();
    }
  }

  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => draw()) : null;
  observer?.observe(canvas);

  return {
    render(next) {
      data = {
        grid: Array.isArray(next?.grid) ? next.grid : [],
        flags: Array.isArray(next?.flags) ? next.flags : [],
        labels: Array.isArray(next?.labels) ? next.labels : [],
      };
      draw();
    },
    refresh: draw,
  };
}

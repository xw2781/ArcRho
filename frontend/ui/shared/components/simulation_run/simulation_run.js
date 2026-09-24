/* The running card a stochastic method shows while it simulates: a Galton
   board whose balls bounce down a triangle of pegs and pile up into the bell
   curve a simulation converges to. The card stays up for at least
   SIMULATION_RUN_MIN_MS, so a quick run still reads as a run rather than a
   flicker. */

export const SIMULATION_RUN_MIN_MS = 2000;

const STYLE_ID = "arSimulationRunStyles";
const WIDTH = 264;
const HEIGHT = 172;
const ROWS = 10;
const BIN_W = 22;
const PEG_TOP = 12;
const ROW_H = 9;
const BIN_TOP = PEG_TOP + ROWS * ROW_H + 4;
const BIN_BOTTOM = HEIGHT - 4;
const STEP_MS = 70;
const SPAWN_MS = 55;
const FADE_MS = 160;
const COLORS = {
  peg: "#cbd5e1",
  ball: "#2b6df6",
  bar: "#dbe8ff",
  barTop: "#2b6df6",
  curve: "#b45309",
  base: "#cbd5e1",
};

function ensureStyles(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const link = doc.createElement("link");
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  link.href = "/ui/shared/components/simulation_run/simulation_run.css?v=20260923a";
  (doc.head || doc.documentElement)?.appendChild(link);
}

// Column k of row r (or bin k once r reaches ROWS) sits at this x.
const pegX = (row, k) => WIDTH / 2 + (k - row / 2) * BIN_W;
const pegY = (row) => PEG_TOP + row * ROW_H;

// The binomial shape the bins converge to, as fractions of its peak.
const EXPECTED = (() => {
  const counts = [1];
  for (let r = 0; r < ROWS; r += 1) {
    counts.push(0);
    for (let k = counts.length - 1; k > 0; k -= 1) counts[k] += counts[k - 1];
  }
  const peak = Math.max(...counts);
  return counts.map((c) => c / peak);
})();

function drawBoard(ctx, balls, bins) {
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = COLORS.peg;
  for (let r = 0; r < ROWS; r += 1) {
    for (let k = 0; k <= r; k += 1) {
      ctx.beginPath();
      ctx.arc(pegX(r, k), pegY(r), 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Bars grow against a floor, so the first few balls do not fill the bins.
  const scale = Math.max(14, ...bins);
  const binH = BIN_BOTTOM - BIN_TOP;
  bins.forEach((count, k) => {
    const x = pegX(ROWS, k) - BIN_W / 2 + 2;
    const h = (count / scale) * binH;
    ctx.fillStyle = COLORS.bar;
    ctx.fillRect(x, BIN_BOTTOM - h, BIN_W - 4, h);
    ctx.fillStyle = COLORS.barTop;
    ctx.fillRect(x, BIN_BOTTOM - h, BIN_W - 4, Math.min(2, h));
  });
  ctx.strokeStyle = COLORS.base;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pegX(ROWS, 0) - BIN_W / 2, BIN_BOTTOM + 0.5);
  ctx.lineTo(pegX(ROWS, ROWS) + BIN_W / 2, BIN_BOTTOM + 0.5);
  ctx.stroke();
  // The curve the bars are heading for, drawn at the height of the tallest bar.
  const peak = (Math.max(...bins) / scale) * binH;
  if (peak > 0) {
    ctx.strokeStyle = COLORS.curve;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    EXPECTED.forEach((share, k) => {
      const x = pegX(ROWS, k);
      const y = BIN_BOTTOM - share * peak;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.fillStyle = COLORS.ball;
  for (const ball of balls) {
    const t = Math.min(1, ball.t);
    const x = pegX(ball.row, ball.k) + (pegX(ball.row + 1, ball.k + ball.dir) - pegX(ball.row, ball.k)) * t;
    const toY = ball.row + 1 >= ROWS ? BIN_TOP : pegY(ball.row + 1);
    const y = pegY(ball.row) + (toY - pegY(ball.row)) * t - Math.sin(Math.PI * t) * 3;
    ctx.beginPath();
    ctx.arc(x, y - 3, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Shows the running card over the whole page until `finish()` is called.
 * `finish()` resolves once the card has been up for SIMULATION_RUN_MIN_MS, so
 * the caller can hold its results until the animation ends.
 */
export function showSimulationRun({ title = "Simulating", detail = "", documentRef = document } = {}) {
  const doc = documentRef;
  ensureStyles(doc);
  const root = doc.createElement("div");
  root.className = "arSimRun";
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");
  root.innerHTML = `
    <div class="arSimRunCard">
      <canvas class="arSimRunBoard" aria-hidden="true"></canvas>
      <div class="arSimRunTitle"></div>
      <div class="arSimRunDetail"></div>
    </div>`;
  root.querySelector(".arSimRunTitle").textContent = title;
  const detailEl = root.querySelector(".arSimRunDetail");
  const canvas = root.querySelector("canvas");
  const dpr = doc.defaultView?.devicePixelRatio || 1;
  canvas.width = Math.round(WIDTH * dpr);
  canvas.height = Math.round(HEIGHT * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  doc.body.appendChild(root);
  requestAnimationFrame(() => root.classList.add("isOpen"));

  const started = performance.now();
  const balls = [];
  const bins = new Array(ROWS + 1).fill(0);
  let last = started;
  let spawnDue = 0;
  let frame = 0;
  const tick = (now) => {
    const dt = Math.min(64, now - last);
    last = now;
    spawnDue -= dt;
    while (spawnDue <= 0) {
      balls.push({ row: 0, k: 0, t: 0, dir: Math.random() < 0.5 ? 0 : 1 });
      spawnDue += SPAWN_MS;
    }
    for (let i = balls.length - 1; i >= 0; i -= 1) {
      const ball = balls[i];
      ball.t += dt / STEP_MS;
      while (ball.t >= 1) {
        ball.t -= 1;
        ball.k += ball.dir;
        ball.row += 1;
        if (ball.row >= ROWS) {
          bins[ball.k] += 1;
          balls.splice(i, 1);
          break;
        }
        ball.dir = Math.random() < 0.5 ? 0 : 1;
      }
    }
    drawBoard(ctx, balls, bins);
    const seconds = ((now - started) / 1000).toFixed(1);
    detailEl.textContent = detail ? `${detail} · ${seconds} s` : `${seconds} s`;
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  let finishing = null;
  return {
    finish() {
      if (finishing) return finishing;
      const wait = Math.max(0, SIMULATION_RUN_MIN_MS - (performance.now() - started));
      finishing = new Promise((resolve) => setTimeout(resolve, wait)).then(() => {
        root.classList.remove("isOpen");
        setTimeout(() => {
          cancelAnimationFrame(frame);
          root.remove();
        }, FADE_MS);
      });
      return finishing;
    },
  };
}

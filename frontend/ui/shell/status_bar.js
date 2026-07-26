import { $ } from "./shell_context.js?v=20260510a";

export function updateStatusBar(text, options = {}) {
  const tone = String(options?.tone || "").trim().toLowerCase();
  const textEl = $("statusText");
  const barEl = $("statusBar");
  const applyTone = (el) => {
    if (!el || !el.classList) return;
    el.classList.remove("status-tone-error", "status-tone-warn");
    if (tone === "error") el.classList.add("status-tone-error");
    if (tone === "warn" || tone === "warning") el.classList.add("status-tone-warn");
  };
  applyTone(textEl);
  applyTone(barEl);
  if (textEl) {
    textEl.textContent = text || "";
    return;
  }
  if (!barEl) return;
  barEl.textContent = text || "";
}

export function clearSavedStatusOnDirty() {
  const textEl = $("statusText") || $("statusBar");
  if (!textEl) return;
  const current = String(textEl.textContent || "").trim();
  if (/^saved\s*:/i.test(current)) {
    updateStatusBar("Status: Ready");
  }
}

export function getStatusBarHeight() {
  const bar = $("statusBar");
  if (bar) {
    const rect = bar.getBoundingClientRect();
    if (rect && rect.height) return Math.round(rect.height);
  }
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--statusbar-h");
    const v = parseFloat(raw);
    if (Number.isFinite(v) && v > 0) return v;
  } catch {}
  return 24;
}

export function formatStatusTimestamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

export function initClock() {
  const el = $("clockText");
  if (!el) return;
  const pad = (n) => String(n).padStart(2, "0");
  const tick = () => {
    const d = new Date();
    el.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  tick();
  setInterval(tick, 1000);
}

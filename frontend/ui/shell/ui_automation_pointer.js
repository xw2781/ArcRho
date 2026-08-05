// Simulated pointer overlay for the ArcRho UI regression harness.
//
// Draws a cursor glyph over the shell document so a human can watch what the harness is doing.
// Feature pages are same-origin iframes beneath the shell, so a single overlay covers all of
// them. It cannot paint over native Electron dialogs or OS context menus.
//
// Two rules this module exists to enforce:
//   1. Travel animation only runs when visualization is enabled, so unattended runs stay fast.
//   2. The glyph is hidden for the duration of a screenshot. Without that it lands in every
//      baseline PNG and every later run diffs against a cursor that is not part of the UI.

const OVERLAY_ID = "arcrho-automation-pointer";
const STYLE_ID = "arcrho-automation-pointer-style";

let enabled = false;
let suppressDepth = 0;
let pointerEl = null;
let position = { x: 0, y: 0 };

function installStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 0;
      left: 0;
      z-index: 2147483647;
      width: 24px;
      height: 24px;
      margin: -2px 0 0 -2px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 120ms ease;
      will-change: transform;
    }
    #${OVERLAY_ID}.visible { opacity: 1; }
    #${OVERLAY_ID} .arcrhoPointerGlyph {
      width: 24px;
      height: 24px;
      display: block;
      filter: drop-shadow(0 1px 2px rgba(15, 23, 42, 0.45));
    }
    #${OVERLAY_ID} .arcrhoPointerPulse {
      position: absolute;
      top: 0;
      left: 0;
      width: 24px;
      height: 24px;
      border-radius: 999px;
      border: 2px solid #2563eb;
      opacity: 0;
      transform: scale(0.35);
    }
    #${OVERLAY_ID}.clicking .arcrhoPointerPulse {
      animation: arcrhoPointerPulse 320ms ease-out;
    }
    @keyframes arcrhoPointerPulse {
      0% { opacity: 0.85; transform: scale(0.35); }
      100% { opacity: 0; transform: scale(1.6); }
    }
    @media (prefers-reduced-motion: reduce) {
      #${OVERLAY_ID} { transition: none; }
      #${OVERLAY_ID}.clicking .arcrhoPointerPulse { animation: none; }
    }
  `;
  document.head.appendChild(style);
}

function ensurePointer() {
  if (pointerEl?.isConnected) return pointerEl;
  installStyles();
  const el = document.createElement("div");
  el.id = OVERLAY_ID;
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = `
    <span class="arcrhoPointerPulse"></span>
    <svg class="arcrhoPointerGlyph" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <path d="M5 3l14 7.5-6.1 1.6L10.6 19z"
            fill="#2563eb" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"></path>
    </svg>
  `;
  document.body.appendChild(el);
  pointerEl = el;
  applyTransform();
  return el;
}

function applyTransform() {
  if (!pointerEl) return;
  pointerEl.style.transform = `translate(${Math.round(position.x)}px, ${Math.round(position.y)}px)`;
}

function updateVisibility() {
  if (!pointerEl) return;
  const shouldShow = enabled && suppressDepth === 0;
  pointerEl.classList.toggle("visible", shouldShow);
}

export function isPointerEnabled() {
  return enabled;
}

export function setPointerEnabled(value) {
  enabled = !!value;
  if (enabled) ensurePointer();
  updateVisibility();
  return { enabled };
}

export function getPointerPosition() {
  return { ...position };
}

/**
 * Move the pointer glyph. When `durationMs` is positive the glyph travels to the target so a
 * human can follow it; otherwise it jumps, which is what unattended runs want.
 */
export function movePointer(x, y, durationMs = 0) {
  position = { x: Number(x) || 0, y: Number(y) || 0 };
  if (!enabled) return Promise.resolve(getPointerPosition());
  ensurePointer();
  updateVisibility();

  const duration = Math.max(0, Number(durationMs) || 0);
  if (duration <= 0) {
    pointerEl.style.transition = "opacity 120ms ease";
    applyTransform();
    return Promise.resolve(getPointerPosition());
  }

  return new Promise((resolve) => {
    pointerEl.style.transition = `opacity 120ms ease, transform ${duration}ms cubic-bezier(0.22, 0.61, 0.36, 1)`;
    applyTransform();
    window.setTimeout(() => {
      if (pointerEl) pointerEl.style.transition = "opacity 120ms ease";
      resolve(getPointerPosition());
    }, duration + 20);
  });
}

/** Flash the click pulse. Resolves once the animation has had time to play. */
export function pulsePointer() {
  if (!enabled || !pointerEl) return Promise.resolve({ pulsed: false });
  pointerEl.classList.remove("clicking");
  // Force reflow so the animation restarts on a repeated click at the same spot.
  void pointerEl.offsetWidth;
  pointerEl.classList.add("clicking");
  return new Promise((resolve) => {
    window.setTimeout(() => {
      pointerEl?.classList.remove("clicking");
      resolve({ pulsed: true });
    }, 340);
  });
}

/**
 * Hide the glyph while `fn` runs, then restore it. Nestable, and restores even if `fn` throws,
 * so a failed capture cannot leave the pointer permanently hidden.
 */
export async function withPointerHidden(fn) {
  suppressDepth += 1;
  updateVisibility();
  // Let the opacity transition commit before the caller reads pixels back.
  if (enabled && suppressDepth === 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 140));
  }
  try {
    return await fn();
  } finally {
    suppressDepth = Math.max(0, suppressDepth - 1);
    updateVisibility();
  }
}

export function destroyPointer() {
  pointerEl?.remove();
  pointerEl = null;
  suppressDepth = 0;
  enabled = false;
}

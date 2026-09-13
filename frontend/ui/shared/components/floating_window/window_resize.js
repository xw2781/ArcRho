/*
===============================================================================
Floating window resize - eight pointer-captured handles on a window's edges
and corners. The dragged edge moves while the opposite edge stays put, the
stylesheet's min-width/min-height bound the shrink, and the viewport bounds
the growth. The caller owns positioning: it receives the frame to apply.
===============================================================================
*/
const DIRECTIONS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function cssPixels(value) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

export function makeWindowResizable(win, { onFrame } = {}) {
  const handles = DIRECTIONS.map((dir) => {
    const handle = document.createElement("div");
    handle.className = `arWindowResizeHandle arWindowResize-${dir}`;
    let drag = null;

    const onMove = (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      let { left, top, width, height } = drag;
      if (dir.includes("e")) {
        width = clamp(drag.width + dx, drag.minWidth, window.innerWidth - left);
      }
      if (dir.includes("w")) {
        const right = left + drag.width;
        width = clamp(drag.width - dx, drag.minWidth, right);
        left = right - width;
      }
      if (dir.includes("s")) {
        height = clamp(drag.height + dy, drag.minHeight, window.innerHeight - top);
      }
      if (dir.includes("n")) {
        const bottom = top + drag.height;
        height = clamp(drag.height - dy, drag.minHeight, bottom);
        top = bottom - height;
      }
      onFrame?.({ left, top, width, height });
    };

    const stop = (e) => {
      if (!drag || (e && e.pointerId != null && e.pointerId !== drag.pointerId)) return;
      try { handle.releasePointerCapture(drag.pointerId); } catch { /* already released */ }
      drag = null;
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      handle.removeEventListener("lostpointercapture", stop);
    };

    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || drag) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = win.getBoundingClientRect();
      const style = getComputedStyle(win);
      drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        minWidth: cssPixels(style.minWidth),
        minHeight: cssPixels(style.minHeight),
      };
      try { handle.setPointerCapture(e.pointerId); } catch { /* capture unsupported */ }
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", stop);
      handle.addEventListener("lostpointercapture", stop);
    });

    win.appendChild(handle);
    return handle;
  });
  return () => handles.forEach((handle) => handle.remove());
}

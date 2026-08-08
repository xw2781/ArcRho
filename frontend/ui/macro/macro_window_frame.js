import { shell } from "../shell/shell_context.js?v=20260510a";

const WINDOW_MARGIN = 8;

export function createMacroWindowFrame({
  getWindow,
  getHeader,
  storageKey,
  onRectApplied = null,
  defaultWidth = 430,
  defaultHeight = 420,
}) {
  let initialized = false;

  function windowElement() {
    return typeof getWindow === "function" ? getWindow() : null;
  }

  function getWindowBounds() {
    const element = windowElement();
    const styles = element ? getComputedStyle(element) : null;
    const minWidth = Number.parseFloat(styles?.minWidth || "") || 360;
    const minHeight = Number.parseFloat(styles?.minHeight || "") || 320;
    const statusbarHeight = Number(shell.getStatusBarHeight?.() || 0);
    return {
      margin: WINDOW_MARGIN,
      minWidth,
      minHeight,
      maxRight: Math.max(WINDOW_MARGIN + minWidth, window.innerWidth - WINDOW_MARGIN),
      maxBottom: Math.max(WINDOW_MARGIN + minHeight, window.innerHeight - statusbarHeight - WINDOW_MARGIN),
    };
  }

  function clampWindowRect(left, top, width, height) {
    const bounds = getWindowBounds();
    const maxWidth = Math.max(bounds.minWidth, bounds.maxRight - bounds.margin);
    const maxHeight = Math.max(bounds.minHeight, bounds.maxBottom - bounds.margin);
    const nextWidth = Math.min(Math.max(bounds.minWidth, Number(width) || bounds.minWidth), maxWidth);
    const nextHeight = Math.min(Math.max(bounds.minHeight, Number(height) || bounds.minHeight), maxHeight);
    const maxLeft = Math.max(bounds.margin, bounds.maxRight - nextWidth);
    const maxTop = Math.max(bounds.margin, bounds.maxBottom - nextHeight);
    return {
      left: Math.min(Math.max(bounds.margin, Number(left) || bounds.margin), maxLeft),
      top: Math.min(Math.max(bounds.margin, Number(top) || bounds.margin), maxTop),
      width: nextWidth,
      height: nextHeight,
    };
  }

  function currentDimensions() {
    const element = windowElement();
    const rect = element?.getBoundingClientRect?.();
    return {
      left: Number(rect?.left) || WINDOW_MARGIN,
      top: Number(rect?.top) || WINDOW_MARGIN,
      width: Number(element?.offsetWidth || rect?.width) || defaultWidth,
      height: Number(element?.offsetHeight || rect?.height) || defaultHeight,
    };
  }

  function applyRect(left, top, width, height) {
    const element = windowElement();
    if (!element) return;
    const next = clampWindowRect(left, top, width, height);
    element.style.left = `${Math.round(next.left)}px`;
    element.style.top = `${Math.round(next.top)}px`;
    element.style.width = `${Math.round(next.width)}px`;
    element.style.height = `${Math.round(next.height)}px`;
    element.style.right = "auto";
    element.style.bottom = "auto";
    onRectApplied?.();
  }

  function applyPosition(left, top, width, height) {
    const element = windowElement();
    if (!element) return;
    const dimensions = currentDimensions();
    const next = clampWindowRect(
      left,
      top,
      width ?? dimensions.width,
      height ?? dimensions.height,
    );
    element.style.left = `${Math.round(next.left)}px`;
    element.style.top = `${Math.round(next.top)}px`;
    element.style.right = "auto";
    element.style.bottom = "auto";
  }

  function readPosition() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      return saved && Number.isFinite(saved.left) && Number.isFinite(saved.top) ? saved : null;
    } catch {
      return null;
    }
  }

  function savePosition() {
    const element = windowElement();
    if (!element) return;
    const rect = element.getBoundingClientRect();
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: element.offsetWidth || Math.round(rect.width),
        height: element.offsetHeight || Math.round(rect.height),
      }));
    } catch {}
  }

  function restorePosition() {
    const saved = readPosition();
    if (!saved) return;
    if (Number.isFinite(saved.width) && Number.isFinite(saved.height)) {
      applyRect(saved.left, saved.top, saved.width, saved.height);
    } else {
      applyPosition(saved.left, saved.top);
    }
  }

  function lockSize() {
    const element = windowElement();
    if (!element) return;
    if (element.offsetWidth > 0) element.style.width = `${element.offsetWidth}px`;
    if (element.offsetHeight > 0) element.style.height = `${element.offsetHeight}px`;
  }

  function initDrag() {
    const element = windowElement();
    const header = typeof getHeader === "function" ? getHeader() : null;
    if (!element || !header) return;
    let dragState = null;

    header.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target?.closest?.("button")) return;
      const rect = element.getBoundingClientRect();
      dragState = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        width: element.offsetWidth || rect.width,
        height: element.offsetHeight || rect.height,
      };
      try { header.setPointerCapture(event.pointerId); } catch {}
      event.preventDefault();
    });

    header.addEventListener("pointermove", (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      applyPosition(
        event.clientX - dragState.offsetX,
        event.clientY - dragState.offsetY,
        dragState.width,
        dragState.height,
      );
    });

    const stopDrag = (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      try { header.releasePointerCapture(event.pointerId); } catch {}
      savePosition();
      dragState = null;
    };

    header.addEventListener("pointerup", stopDrag);
    header.addEventListener("pointercancel", stopDrag);
  }

  function initResize() {
    const element = windowElement();
    if (!element) return;
    const handles = Array.from(element.querySelectorAll(".macroResizeHandle"));
    if (!handles.length) return;
    let resizeState = null;

    const startResize = (event) => {
      if (event.button !== 0) return;
      const handle = event.currentTarget;
      const rect = element.getBoundingClientRect();
      resizeState = {
        pointerId: event.pointerId,
        edge: String(handle?.dataset?.resizeEdge || "se"),
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        top: rect.top,
        width: element.offsetWidth || rect.width,
        height: element.offsetHeight || rect.height,
      };
      try { handle.setPointerCapture(event.pointerId); } catch {}
      event.preventDefault();
      event.stopPropagation();
    };

    const moveResize = (event) => {
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      const dx = event.clientX - resizeState.startX;
      const dy = event.clientY - resizeState.startY;
      const edge = resizeState.edge;
      const bounds = getWindowBounds();
      const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));
      let { left, top, width, height } = resizeState;

      if (edge.includes("e")) {
        width = clamp(resizeState.width + dx, bounds.minWidth, bounds.maxRight - resizeState.left);
      }
      if (edge.includes("s")) {
        height = clamp(resizeState.height + dy, bounds.minHeight, bounds.maxBottom - resizeState.top);
      }
      if (edge.includes("w")) {
        const right = resizeState.left + resizeState.width;
        left = clamp(resizeState.left + dx, bounds.margin, right - bounds.minWidth);
        width = right - left;
      }
      if (edge.includes("n")) {
        const bottom = resizeState.top + resizeState.height;
        top = clamp(resizeState.top + dy, bounds.margin, bottom - bounds.minHeight);
        height = bottom - top;
      }
      applyRect(left, top, width, height);
    };

    const stopResize = (event) => {
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      try { event.currentTarget?.releasePointerCapture?.(event.pointerId); } catch {}
      savePosition();
      resizeState = null;
    };

    handles.forEach((handle) => {
      handle.addEventListener("pointerdown", startResize);
      handle.addEventListener("pointermove", moveResize);
      handle.addEventListener("pointerup", stopResize);
      handle.addEventListener("pointercancel", stopResize);
    });
  }

  return {
    init() {
      if (initialized) return;
      initialized = true;
      initDrag();
      initResize();
    },
    applyRect,
    applyPosition,
    lockSize,
    restorePosition,
    savePosition,
  };
}

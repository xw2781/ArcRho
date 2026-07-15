(function () {
  "use strict";

  const ZOOM_STORAGE_KEY = "arcrho_ui_zoom_pct";
  const ZOOM_MODE_KEY = "arcrho_zoom_mode";
  const STATUSBAR_H_KEY = "arcrho_statusbar_h";
  const WIRE_KEY = "__arcRhoPageZoomBridgeState";
  const FORWARD_TYPES = new Set(["arcrho:zoom", "arcrho:zoom-step", "arcrho:zoom-reset"]);

  function readNumberFromStorage(key, fallbackValue) {
    try {
      const value = Number(localStorage.getItem(key));
      return Number.isFinite(value) ? value : fallbackValue;
    } catch {
      return fallbackValue;
    }
  }

  function getZoomMode() {
    try {
      return localStorage.getItem(ZOOM_MODE_KEY) === "host" ? "host" : "css";
    } catch {
      return "css";
    }
  }

  function notifyApplied(state, detail) {
    window.dispatchEvent(new CustomEvent("arcrho:page-zoom-applied", { detail }));
    for (const callback of state.callbacks) {
      try {
        callback(detail);
      } catch {
        // Keep one page callback from breaking zoom for the rest of the page.
      }
    }
  }

  function applyPageZoomValue(rawZoom, rawStatusBarHeight, state) {
    const zoom = Number(rawZoom);
    if (!Number.isFinite(zoom)) return null;
    const statusBarHeight = Number(rawStatusBarHeight);
    const safeStatusBarHeight = Number.isFinite(statusBarHeight) && statusBarHeight > 0
      ? statusBarHeight
      : readNumberFromStorage(STATUSBAR_H_KEY, 24);
    const percent = Math.max(50, Math.min(200, zoom));
    const scale = percent / 100;
    const mode = getZoomMode();
    const root = document.documentElement;
    const body = document.body;

    if (mode === "host") {
      if (root) {
        root.style.zoom = "";
        root.style.setProperty("--ui-zoom", "1");
        root.style.setProperty("--app-safe-bottom", `${safeStatusBarHeight}px`);
      }
      if (body) body.style.zoom = "";
    } else {
      if (root) {
        root.style.zoom = String(scale);
        root.style.setProperty("--ui-zoom", String(scale));
        root.style.setProperty("--app-safe-bottom", `${safeStatusBarHeight / scale}px`);
      }
      if (body) body.style.zoom = String(scale);
    }

    const detail = { zoom: percent, statusBarHeight: safeStatusBarHeight, scale, mode };
    state.lastApplied = detail;
    notifyApplied(state, detail);
    return detail;
  }

  function shouldRelayToParent(event) {
    return window.parent && window.parent !== window && event?.source !== window.parent;
  }

  function relayToParent(message) {
    try {
      window.parent.postMessage(message, "*");
    } catch {
      // ignore parent messaging failures
    }
  }

  function wirePageZoomBridge(options = {}) {
    const state = window[WIRE_KEY] || {
      wired: false,
      callbacks: new Set(),
      lastApplied: null,
    };
    window[WIRE_KEY] = state;

    if (typeof options.onApplied === "function") {
      state.callbacks.add(options.onApplied);
    }

    if (!state.wired) {
      state.wired = true;
      window.addEventListener("message", (event) => {
        const type = String(event?.data?.type || "");
        if (type === "arcrho:set-zoom") {
          applyPageZoomValue(event.data.zoom, event.data.statusBarHeight, state);
          return;
        }
        if (FORWARD_TYPES.has(type) && shouldRelayToParent(event)) {
          relayToParent(event.data);
        }
      });

      document.addEventListener("wheel", (event) => {
        if (!(event.ctrlKey || event.metaKey)) return;
        if (!window.parent || window.parent === window) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        relayToParent({ type: "arcrho:zoom", deltaY: event.deltaY });
      }, { capture: true, passive: false });
    }

    if (options.applyInitial !== false) {
      applyPageZoomValue(
        readNumberFromStorage(ZOOM_STORAGE_KEY, 100),
        readNumberFromStorage(STATUSBAR_H_KEY, 24),
        state
      );
    } else if (state.lastApplied && typeof options.onApplied === "function") {
      options.onApplied(state.lastApplied);
    }

    return state.lastApplied;
  }

  window.ArcRhoZoomBridge = {
    wirePageZoomBridge,
    applyPageZoomValue: (zoom, statusBarHeight) => {
      const state = window[WIRE_KEY] || { wired: false, callbacks: new Set(), lastApplied: null };
      window[WIRE_KEY] = state;
      return applyPageZoomValue(zoom, statusBarHeight, state);
    },
  };
})();

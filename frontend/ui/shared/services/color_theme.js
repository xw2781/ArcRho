(function initializeArcRhoColorTheme(global) {
  "use strict";

  const STORAGE_KEY = "arcrho_color_theme";
  const ATTRIBUTE_NAME = "data-arcrho-theme";
  const MESSAGE_TYPE = "arcrho:set-color-theme";
  const CHANGE_EVENT = "arcrho:color-theme-changed";
  const DEFAULT_THEME = "light";
  const THEMES = Object.freeze(["light", "dark"]);
  const THEME_MENU_OPEN_CLASS = "arcrhoThemeMenuOpen";
  let hostPreferenceRevision = 0;

  function normalizeTheme(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return THEMES.includes(normalized) ? normalized : DEFAULT_THEME;
  }

  function readStoredTheme() {
    try {
      return normalizeTheme(global.localStorage?.getItem(STORAGE_KEY));
    } catch {
      return DEFAULT_THEME;
    }
  }

  function persistLocalTheme(theme) {
    try {
      global.localStorage?.setItem(STORAGE_KEY, theme);
    } catch {
      // The theme still applies for this document when storage is unavailable.
    }
  }

  function isTopLevelWindow() {
    try {
      return !global.top || global.top === global;
    } catch {
      return false;
    }
  }

  function persistHostTheme(theme) {
    if (!isTopLevelWindow()) return;
    const savePreference = global.ADAHost?.saveColorThemePreference;
    if (typeof savePreference !== "function") return;
    Promise.resolve(savePreference(theme)).catch(() => {
      // Browser-only sessions and temporarily unavailable hosts keep the local cache.
    });
  }

  function persistTheme(theme) {
    persistLocalTheme(theme);
    persistHostTheme(theme);
  }

  async function hydrateHostThemePreference() {
    if (!isTopLevelWindow()) return readStoredTheme();
    const loadPreference = global.ADAHost?.loadColorThemePreference;
    if (typeof loadPreference !== "function") return readStoredTheme();
    const revision = hostPreferenceRevision;
    try {
      const result = await loadPreference();
      if (revision !== hostPreferenceRevision) return getTheme();
      if (!result?.exists) {
        const cachedTheme = readStoredTheme();
        persistHostTheme(cachedTheme);
        return cachedTheme;
      }
      const theme = normalizeTheme(result.theme);
      persistLocalTheme(theme);
      return applyTheme(theme, {
        notifyChildren: true,
        persist: false,
        source: "host-preference",
      });
    } catch {
      return readStoredTheme();
    }
  }

  function getTheme() {
    return normalizeTheme(global.document?.documentElement?.getAttribute(ATTRIBUTE_NAME));
  }

  function getMonacoTheme(theme = getTheme()) {
    return normalizeTheme(theme) === "dark" ? "vs-dark" : "vs";
  }

  function getCssColor(propertyName, fallback = "", element = global.document?.documentElement) {
    const name = String(propertyName || "").trim();
    if (!name || !element || typeof global.getComputedStyle !== "function") return fallback;
    try {
      return global.getComputedStyle(element).getPropertyValue(name).trim() || fallback;
    } catch {
      return fallback;
    }
  }

  function syncMonacoTheme(theme) {
    try {
      global.monaco?.editor?.setTheme?.(getMonacoTheme(theme));
    } catch {
      // Monaco may not be ready yet; editor creation also reads getMonacoTheme().
    }
  }

  function syncNativeWindowBackground() {
    const root = global.document?.documentElement;
    if (!root || typeof global.getComputedStyle !== "function") return;
    try {
      if (global.top && global.top !== global) return;
    } catch {
      return;
    }
    const color = global.getComputedStyle(root)
      .getPropertyValue("--ar-native-window-background")
      .trim();
    if (!color) return;
    try {
      global.ADAHost?.setWindowBackgroundColor?.(color);
    } catch {
      // Browser sessions and older hosts do not expose this optional bridge.
    }
  }

  function wireThemeMenu(menu) {
    if (!menu || typeof menu.querySelector !== "function" || menu.dataset?.arcrhoThemeMenuWired === "1") {
      return null;
    }
    const submenu = menu.querySelector("[data-color-theme-options]");
    const dropdown = menu.closest?.(".menuDropdown") || null;
    const trigger = global.document?.querySelector?.("[data-color-theme-trigger]") || null;
    const getItems = () => Array.from(menu.querySelectorAll?.("[data-color-theme-value]") || []);
    if (!submenu || getItems().length === 0) return null;

    const setExpanded = (expanded) => {
      menu.classList?.toggle(THEME_MENU_OPEN_CLASS, expanded);
      menu.setAttribute?.("aria-expanded", expanded ? "true" : "false");
    };
    const closeOptions = ({ focusParent = false } = {}) => {
      setExpanded(false);
      for (const item of getItems()) item.tabIndex = -1;
      if (focusParent) menu.focus?.();
    };
    const openOptions = ({ focusSelected = true } = {}) => {
      setExpanded(true);
      const items = getItems();
      const selected = items.find((item) => item.getAttribute?.("aria-checked") === "true") || items[0];
      for (const item of items) item.tabIndex = item === selected ? 0 : -1;
      if (focusSelected) selected?.focus?.();
    };
    const focusItemAt = (index) => {
      const items = getItems();
      if (items.length === 0) return;
      const target = items[(index + items.length) % items.length];
      for (const item of items) item.tabIndex = item === target ? 0 : -1;
      target.focus?.();
    };

    trigger?.addEventListener?.("keydown", (event) => {
      if (!["Enter", " ", "ArrowDown"].includes(event.key)) return;
      event.preventDefault?.();
      if (!dropdown?.classList?.contains("open")) trigger.click?.();
      openOptions();
    });

    menu.addEventListener("keydown", (event) => {
      const items = getItems();
      const item = event.target?.closest?.("[data-color-theme-value]");
      if (!item || !menu.contains?.(item)) {
        if (!["Enter", " ", "ArrowRight", "ArrowDown"].includes(event.key)) return;
        event.preventDefault?.();
        openOptions();
        return;
      }
      const index = items.indexOf(item);
      if (event.key === "ArrowDown") {
        event.preventDefault?.();
        focusItemAt(index + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault?.();
        focusItemAt(index - 1);
      } else if (event.key === "Home") {
        event.preventDefault?.();
        focusItemAt(0);
      } else if (event.key === "End") {
        event.preventDefault?.();
        focusItemAt(items.length - 1);
      } else if (event.key === "ArrowLeft" || event.key === "Escape") {
        event.preventDefault?.();
        closeOptions({ focusParent: true });
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault?.();
        item.click?.();
      }
    });

    menu.addEventListener("pointerenter", () => menu.setAttribute?.("aria-expanded", "true"));
    menu.addEventListener("pointerleave", () => {
      if (!menu.classList?.contains(THEME_MENU_OPEN_CLASS) && !menu.contains?.(global.document?.activeElement)) {
        menu.setAttribute?.("aria-expanded", "false");
      }
    });
    menu.addEventListener("focusout", () => {
      global.setTimeout?.(() => {
        if (!menu.contains?.(global.document?.activeElement)) closeOptions();
      }, 0);
    });
    menu.addEventListener("click", (event) => {
      const item = event.target?.closest?.("[data-color-theme-value]");
      if (!item || !menu.contains?.(item)) return;
      closeOptions();
      global.setTimeout?.(() => trigger?.focus?.(), 0);
    });

    if (menu.dataset) menu.dataset.arcrhoThemeMenuWired = "1";
    return Object.freeze({ close: closeOptions, open: openOptions });
  }

  function wireThemeMenus(root = global.document) {
    const menus = root?.querySelectorAll?.("[data-color-theme-menu]") || [];
    return Array.from(menus, (menu) => wireThemeMenu(menu)).filter(Boolean);
  }

  function notifyChildFrames(theme) {
    const frames = global.document?.querySelectorAll?.("iframe") || [];
    for (const frame of frames) {
      try {
        frame.contentWindow?.postMessage({ type: MESSAGE_TYPE, theme }, "*");
      } catch {
        // Ignore frames that are unavailable while loading or closing.
      }
    }
  }

  function applyTheme(value, options = {}) {
    const theme = normalizeTheme(value);
    const root = global.document?.documentElement;
    const previousTheme = getTheme();
    root?.setAttribute(ATTRIBUTE_NAME, theme);
    if (options.persist === true) persistTheme(theme);
    syncMonacoTheme(theme);
    syncNativeWindowBackground();
    if (options.notifyChildren !== false) notifyChildFrames(theme);
    if (previousTheme !== theme || options.forceEvent === true) {
      global.dispatchEvent?.(new CustomEvent(CHANGE_EVENT, {
        detail: { theme, previousTheme, source: options.source || "runtime" },
      }));
    }
    return theme;
  }

  function setTheme(value, options = {}) {
    hostPreferenceRevision += 1;
    return applyTheme(value, {
      ...options,
      persist: options.persist !== false,
      source: options.source || "user",
    });
  }

  const api = Object.freeze({
    ATTRIBUTE_NAME,
    CHANGE_EVENT,
    DEFAULT_THEME,
    MESSAGE_TYPE,
    STORAGE_KEY,
    THEMES,
    applyTheme,
    getCssColor,
    getMonacoTheme,
    getTheme,
    hydrateHostThemePreference,
    normalizeTheme,
    readStoredTheme,
    setTheme,
    syncNativeWindowBackground,
    wireThemeMenu,
    wireThemeMenus,
  });

  global.ArcRhoColorTheme = api;
  let bootstrapTheme = readStoredTheme();
  try {
    const requestedTheme = new URLSearchParams(global.location?.search || "").get("theme");
    if (THEMES.includes(String(requestedTheme || "").trim().toLowerCase())) {
      bootstrapTheme = normalizeTheme(requestedTheme);
      persistLocalTheme(bootstrapTheme);
    }
  } catch {
    // Keep the local renderer cache when the current URL is unavailable.
  }
  applyTheme(bootstrapTheme, { notifyChildren: false, source: "bootstrap" });
  void hydrateHostThemePreference();

  global.addEventListener?.("message", (event) => {
    if (event?.data?.type !== MESSAGE_TYPE) return;
    applyTheme(event.data.theme, { persist: false, source: "message" });
  });

  global.addEventListener?.("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    applyTheme(event.newValue, { persist: false, source: "storage" });
  });

  if (global.document?.readyState === "loading") {
    global.document.addEventListener("DOMContentLoaded", () => {
      wireThemeMenus();
      syncNativeWindowBackground();
    }, { once: true });
  } else {
    wireThemeMenus();
    syncNativeWindowBackground();
  }
})(window);

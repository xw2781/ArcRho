(function initializeArcRhoColorTheme(global) {
  "use strict";

  const STORAGE_KEY = "arcrho_color_theme";
  const ATTRIBUTE_NAME = "data-arcrho-theme";
  const MESSAGE_TYPE = "arcrho:set-color-theme";
  const CHANGE_EVENT = "arcrho:color-theme-changed";
  const DEFAULT_THEME = "light";
  const THEMES = Object.freeze(["light", "dark", "high-contrast"]);
  // Shared with the cascade controller so pointer and keyboard hold one open state.
  const THEME_MENU_OPEN_CLASS = "menuSubmenuOpen";
  const MONACO_ATOM_ONE_DARK_THEME = "arcrho-atom-one-dark";
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
    if (normalizeTheme(theme) !== "dark") return "vs";
    ensureAtomOneDarkMonacoTheme();
    return MONACO_ATOM_ONE_DARK_THEME;
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

  function toMonacoColor(value) {
    return String(value || "").trim().replace(/^#/, "");
  }

  function buildAtomOneDarkMonacoTheme() {
    const color = (propertyName) => getCssColor(propertyName);
    const colors = Object.fromEntries([
      ["editor.background", color("--ar-monaco-editor-background")],
      ["editor.foreground", color("--ar-monaco-editor-foreground")],
      ["editorCursor.foreground", color("--ar-monaco-editor-cursor")],
      ["editor.lineHighlightBackground", color("--ar-monaco-editor-line-highlight")],
      ["editor.selectionBackground", color("--ar-monaco-editor-selection")],
      ["editor.inactiveSelectionBackground", color("--ar-monaco-editor-selection")],
      ["editor.selectionHighlightBackground", color("--ar-monaco-editor-selection-highlight")],
      ["editor.findMatchHighlightBackground", color("--ar-monaco-editor-find-match-highlight")],
      ["editorIndentGuide.background1", color("--ar-monaco-editor-indent-guide")],
      ["editorIndentGuide.activeBackground1", color("--ar-monaco-editor-indent-guide-active")],
      ["editorLineNumber.foreground", color("--ar-monaco-editor-line-number")],
      ["editorLineNumber.activeForeground", color("--ar-monaco-editor-foreground")],
      ["editorWhitespace.foreground", color("--ar-monaco-editor-indent-guide")],
      ["editorRuler.foreground", color("--ar-monaco-editor-indent-guide")],
      ["editorGutter.background", color("--ar-monaco-editor-background")],
      ["editorHoverWidget.background", color("--ar-monaco-editor-widget-background")],
      ["editorHoverWidget.border", color("--ar-monaco-editor-widget-border")],
      ["editorSuggestWidget.background", color("--ar-monaco-editor-widget-background")],
      ["editorSuggestWidget.border", color("--ar-monaco-editor-widget-border")],
      ["editorSuggestWidget.selectedBackground", color("--ar-monaco-editor-list-selection")],
      ["editorWidget.background", color("--ar-monaco-editor-widget-background")],
      ["editorWidget.border", color("--ar-monaco-editor-widget-border")],
      ["list.activeSelectionBackground", color("--ar-monaco-editor-list-selection")],
      ["list.activeSelectionForeground", color("--ar-monaco-editor-active-foreground")],
      ["list.focusBackground", color("--ar-monaco-editor-list-selection")],
      ["list.hoverBackground", color("--ar-monaco-editor-list-hover")],
      ["scrollbarSlider.background", color("--ar-monaco-editor-scrollbar")],
      ["scrollbarSlider.hoverBackground", color("--ar-monaco-editor-scrollbar-hover")],
      ["scrollbarSlider.activeBackground", color("--ar-monaco-editor-scrollbar-active")],
      ["editorError.foreground", color("--ar-monaco-syntax-invalid")],
      ["editorWarning.foreground", color("--ar-monaco-syntax-type")],
      ["editorInfo.foreground", color("--ar-monaco-syntax-function")],
    ].filter(([, value]) => Boolean(value)));
    const rule = (token, propertyName, fontStyle = "") => {
      const foreground = toMonacoColor(color(propertyName));
      if (!foreground) return null;
      return fontStyle ? { token, foreground, fontStyle } : { token, foreground };
    };

    return {
      base: "vs-dark",
      inherit: true,
      colors,
      rules: [
        rule("comment", "--ar-monaco-syntax-comment", "italic"),
        rule("keyword", "--ar-monaco-syntax-keyword"),
        rule("number", "--ar-monaco-syntax-number"),
        rule("string", "--ar-monaco-syntax-string"),
        rule("string.escape", "--ar-monaco-syntax-cyan"),
        rule("regexp", "--ar-monaco-syntax-cyan"),
        rule("type", "--ar-monaco-syntax-type"),
        rule("class", "--ar-monaco-syntax-type"),
        rule("function", "--ar-monaco-syntax-function"),
        rule("variable", "--ar-monaco-syntax-variable"),
        rule("variable.parameter", "--ar-monaco-editor-foreground"),
        rule("tag", "--ar-monaco-syntax-variable"),
        rule("attribute.name", "--ar-monaco-syntax-number"),
        rule("delimiter", "--ar-monaco-editor-foreground"),
        rule("identifier", "--ar-monaco-editor-foreground"),
        rule("invalid", "--ar-monaco-syntax-invalid"),
        rule("string.interpolated", "--ar-monaco-syntax-interpolation"),
      ].filter(Boolean),
    };
  }

  function ensureAtomOneDarkMonacoTheme() {
    const defineTheme = global.monaco?.editor?.defineTheme;
    if (typeof defineTheme !== "function") return;
    try {
      defineTheme(MONACO_ATOM_ONE_DARK_THEME, buildAtomOneDarkMonacoTheme());
    } catch {
      // Monaco may still be initializing; its next theme lookup will retry.
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
      const cascade = global.ArcRhoCascadeMenu;
      if (expanded) cascade?.open?.(menu);
      else cascade?.closeAll?.();
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

    // Pointer open/close and aria-expanded during hover belong to the shared
    // cascade controller; this menu only owns its keyboard and selection paths.
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

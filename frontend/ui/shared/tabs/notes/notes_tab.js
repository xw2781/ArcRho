import {
  findNotesPathMatches,
  isExcelWorkbookPath,
} from "./notes_paths.js";
import {
  indentNotesText,
  outdentNotesText,
} from "./notes_text.js";

const NOTES_TAB_STYLESHEET_ID = "arNotesTabStylesheet";
const NOTES_TAB_STYLESHEET_HREF = "/ui/shared/tabs/notes/notes_tab.css?v=20260714a";
const MOUNTED_NOTES_TABS = new WeakMap();

function ensureNotesTabStylesheet(documentRef) {
  const existingById = documentRef.getElementById?.(NOTES_TAB_STYLESHEET_ID);
  if (existingById) return existingById;

  const existingByHref = Array.from(
    documentRef.querySelectorAll?.('link[rel="stylesheet"]') || [],
  ).find((link) => link.getAttribute("href") === NOTES_TAB_STYLESHEET_HREF);
  if (existingByHref) return existingByHref;

  const link = documentRef.createElement("link");
  link.id = NOTES_TAB_STYLESHEET_ID;
  link.rel = "stylesheet";
  link.href = NOTES_TAB_STYLESHEET_HREF;
  (documentRef.head || documentRef.documentElement)?.appendChild(link);
  return link;
}

function appendElement(documentRef, parent, tagName, className, text = null) {
  const element = documentRef.createElement(tagName);
  if (className) element.className = className;
  if (text !== null) element.textContent = String(text);
  parent.appendChild(element);
  return element;
}

function appendFontOption(documentRef, select, value, label) {
  const option = documentRef.createElement("option");
  option.value = value;
  option.textContent = label;
  select.appendChild(option);
}

function appendFormatToggle(documentRef, toolbar, key, label, title) {
  const button = appendElement(
    documentRef,
    toolbar,
    "button",
    "arNotesTabFormatToggle",
    label,
  );
  button.type = "button";
  button.dataset.notesToggle = key;
  button.setAttribute("aria-label", title);
  button.setAttribute("aria-pressed", "false");
  button.title = title;
  return button;
}

function buildNotesTabElements(documentRef, {
  ariaLabel,
  placeholder,
}) {
  const root = documentRef.createElement("div");
  root.className = "arNotesTab";

  const toolbar = appendElement(
    documentRef,
    root,
    "div",
    "arNotesTabToolbar",
  );
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Notes formatting");

  const fontGroup = appendElement(
    documentRef,
    toolbar,
    "label",
    "arNotesTabFormatGroup",
  );
  fontGroup.title = "Font family";
  appendElement(
    documentRef,
    fontGroup,
    "span",
    "arNotesTabFormatLabel",
    "Font",
  );
  const fontFamily = appendElement(
    documentRef,
    fontGroup,
    "select",
    "arNotesTabFormatSelect",
  );
  fontFamily.dataset.notesStyle = "font-family";
  fontFamily.setAttribute("aria-label", "Notes font family");
  appendFontOption(documentRef, fontFamily, "", "Default");
  appendFontOption(documentRef, fontFamily, "'Segoe UI', Tahoma, sans-serif", "Segoe UI");
  appendFontOption(documentRef, fontFamily, "Calibri, 'Segoe UI', sans-serif", "Calibri");
  appendFontOption(documentRef, fontFamily, "'Consolas', 'Courier New', monospace", "Consolas");
  appendFontOption(documentRef, fontFamily, "'Georgia', serif", "Georgia");

  const sizeGroup = appendElement(
    documentRef,
    toolbar,
    "label",
    "arNotesTabFormatGroup",
  );
  sizeGroup.title = "Font size";
  appendElement(
    documentRef,
    sizeGroup,
    "span",
    "arNotesTabFormatLabel",
    "Size",
  );
  const fontSize = appendElement(
    documentRef,
    sizeGroup,
    "input",
    "arNotesTabFormatInput",
  );
  fontSize.type = "number";
  fontSize.min = "8";
  fontSize.max = "48";
  fontSize.step = "1";
  fontSize.value = "13";
  fontSize.dataset.notesStyle = "font-size";
  fontSize.setAttribute("aria-label", "Notes font size");

  const colorGroup = appendElement(
    documentRef,
    toolbar,
    "label",
    "arNotesTabFormatGroup arNotesTabFormatColorGroup",
  );
  colorGroup.title = "Text color";
  appendElement(
    documentRef,
    colorGroup,
    "span",
    "arNotesTabFormatLabel",
    "Color",
  );
  const color = appendElement(
    documentRef,
    colorGroup,
    "input",
    "arNotesTabFormatColor",
  );
  color.type = "color";
  color.value = "#1c2433";
  color.dataset.notesStyle = "color";
  color.setAttribute("aria-label", "Notes text color");

  const divider = appendElement(
    documentRef,
    toolbar,
    "span",
    "arNotesTabFormatDivider",
  );
  divider.setAttribute("aria-hidden", "true");

  const toggles = {
    bold: appendFormatToggle(documentRef, toolbar, "bold", "B", "Bold"),
    italic: appendFormatToggle(documentRef, toolbar, "italic", "I", "Italic"),
    underline: appendFormatToggle(documentRef, toolbar, "underline", "U", "Underline"),
    strike: appendFormatToggle(documentRef, toolbar, "strike", "S", "Strikethrough"),
  };

  const inputWrap = appendElement(
    documentRef,
    root,
    "div",
    "arNotesTabInputWrap",
  );
  const decor = appendElement(
    documentRef,
    inputWrap,
    "pre",
    "arNotesTabDecor",
  );
  decor.setAttribute("aria-hidden", "true");

  const input = appendElement(
    documentRef,
    inputWrap,
    "textarea",
    "arNotesTabInput",
  );
  input.placeholder = String(placeholder || "Enter notes...");
  input.setAttribute("aria-label", String(ariaLabel || "Notes"));
  input.spellcheck = false;
  input.setAttribute("spellcheck", "false");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("data-gramm", "false");
  input.setAttribute("data-gramm_editor", "false");
  input.setAttribute("data-enable-grammarly", "false");

  return {
    root,
    toolbar,
    inputWrap,
    decor,
    input,
    styleControls: {
      fontFamily,
      fontSize,
      color,
      ...toggles,
    },
  };
}

function buildPathOverlayElements(documentRef) {
  const tooltip = documentRef.createElement("div");
  tooltip.className = "arNotesTabPathTooltip";
  tooltip.setAttribute("role", "tooltip");

  const menu = documentRef.createElement("div");
  menu.className = "arNotesTabPathMenu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-hidden", "true");

  const appendMenuItem = (action, label) => {
    const button = appendElement(
      documentRef,
      menu,
      "button",
      "arNotesTabPathMenuItem",
      label,
    );
    button.type = "button";
    button.dataset.notesPathAction = action;
    button.setAttribute("role", "menuitem");
    return button;
  };

  const open = appendMenuItem("open", "Open File");
  const openReadOnly = appendMenuItem("open-read-only", "Open as Read-Only");
  openReadOnly.hidden = true;
  const copy = appendMenuItem("copy", "Copy File Path");
  return {
    tooltip,
    menu,
    menuItems: { open, openReadOnly, copy },
  };
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function rgbStringToHex(value) {
  const source = String(value || "").trim();
  if (!source) return "";
  if (/^#[0-9a-f]{6}$/iu.test(source)) return source.toLowerCase();

  const match = source.match(/^rgba?\(([^)]+)\)$/iu);
  if (!match) return "";
  const parts = match[1]
    .split(",")
    .map((part) => Number.parseFloat(part.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) {
    return "";
  }
  const toHex = (part) => Math.max(0, Math.min(255, Math.round(part)))
    .toString(16)
    .padStart(2, "0");
  return "#" + toHex(parts[0]) + toHex(parts[1]) + toHex(parts[2]);
}

function normalizeOpenPathResult(result, customHandlerUsed) {
  if (result === true) return { ok: true, error: "" };
  if (result === false) return { ok: false, error: "Open path failed." };
  if (result == null && customHandlerUsed) return { ok: true, error: "" };
  if (!result || typeof result !== "object") {
    return { ok: false, error: "Open path failed." };
  }
  return {
    ok: !!result.ok,
    error: String(result.error || ""),
  };
}

/**
 * Mounts the shared Notes tab UI into an existing page-owned container.
 * Formatting is intentionally ephemeral and applies to the whole note; only
 * the textarea value participates in dirty tracking and persistence.
 *
 * @param {Object} options
 * @param {HTMLElement} options.container
 * @param {string} [options.value]
 * @param {string} [options.placeholder]
 * @param {string} [options.ariaLabel]
 * @param {(value: string, detail: Object) => void} [options.onChange]
 * @param {(dirty: boolean, detail: Object) => void} [options.onDirtyChange]
 * @param {(text: string) => void} [options.onStatus]
 * @param {(path: string, options: {readOnly: boolean}) => Promise<Object>|Object} [options.onOpenPath]
 * @param {Document} [options.documentRef]
 * @returns {Object}
 */
export function mountNotesTab({
  container,
  value = "",
  placeholder = "Enter notes...",
  ariaLabel = "Notes",
  onChange,
  onDirtyChange,
  onStatus,
  onOpenPath,
  documentRef,
} = {}) {
  const documentObject = documentRef
    || container?.ownerDocument
    || globalThis.document;
  if (!documentObject || typeof documentObject.createElement !== "function") {
    throw new TypeError("mountNotesTab requires a document.");
  }
  if (!container || typeof container.appendChild !== "function") {
    throw new TypeError("mountNotesTab requires a container element.");
  }
  if (MOUNTED_NOTES_TABS.has(container)) {
    throw new Error("mountNotesTab requires an unused container; destroy the existing Notes tab first.");
  }

  const windowObject = documentObject.defaultView || globalThis.window;
  if (!windowObject || typeof windowObject.addEventListener !== "function") {
    throw new TypeError("mountNotesTab requires a window.");
  }

  const notifyChange = typeof onChange === "function" ? onChange : () => {};
  const notifyDirtyChange = typeof onDirtyChange === "function"
    ? onDirtyChange
    : () => {};
  const setStatus = typeof onStatus === "function" ? onStatus : () => {};
  const openPathHandler = typeof onOpenPath === "function" ? onOpenPath : null;

  ensureNotesTabStylesheet(documentObject);
  const elements = buildNotesTabElements(documentObject, {
    ariaLabel,
    placeholder,
  });
  const overlays = buildPathOverlayElements(documentObject);
  const overlayHost = documentObject.body || documentObject.documentElement;
  overlayHost.appendChild(overlays.tooltip);
  overlayHost.appendChild(overlays.menu);
  container.classList?.add("arNotesTabMount");
  container.appendChild(elements.root);

  const {
    root,
    toolbar,
    inputWrap,
    decor,
    input,
    styleControls,
  } = elements;
  const {
    tooltip,
    menu,
    menuItems,
  } = overlays;

  const cleanupCallbacks = [];
  const pendingBridgeCancels = new Set();
  let destroyed = false;
  let cleanValue = String(value ?? "");
  let dirty = false;
  let plainTextEditMode = false;
  let decorRenderPending = false;
  let hoverPathToken = null;
  let contextMenuPath = "";
  let textStyleState = null;
  let selectionSnapshot = { start: 0, end: 0 };
  let flushTimer = null;
  let resizeObserver = null;

  input.value = cleanValue;

  const listen = (target, eventName, handler, options) => {
    target?.addEventListener?.(eventName, handler, options);
    cleanupCallbacks.push(() => {
      target?.removeEventListener?.(eventName, handler, options);
    });
  };

  const clearFlushTimer = () => {
    if (flushTimer === null) return;
    windowObject.clearTimeout(flushTimer);
    flushTimer = null;
  };

  const setPlainTextMode = (enabled) => {
    plainTextEditMode = !!enabled;
    root.classList.toggle("is-editing", plainTextEditMode);
  };

  const setHoverPathToken = (nextToken) => {
    if (hoverPathToken === nextToken) return;
    hoverPathToken?.classList.remove("is-hovered");
    hoverPathToken = nextToken || null;
    hoverPathToken?.classList.add("is-hovered");
  };

  const syncDecorScroll = () => {
    decor.scrollTop = input.scrollTop;
    decor.scrollLeft = input.scrollLeft;
  };

  const syncToolbarWidth = () => {
    if (destroyed) return;
    const width = Math.max(0, Math.round(inputWrap.getBoundingClientRect().width));
    if (width) toolbar.style.width = String(width) + "px";
  };

  const renderDecor = () => {
    if (destroyed) return;
    const source = String(input.value || "");
    const matches = findNotesPathMatches(source);
    const fragment = documentObject.createDocumentFragment();
    let cursor = 0;
    matches.forEach((match, index) => {
      if (match.start > cursor) {
        fragment.appendChild(documentObject.createTextNode(source.slice(cursor, match.start)));
      }
      const token = documentObject.createElement("span");
      token.className = "arNotesTabPathToken";
      token.dataset.path = match.path;
      token.dataset.notesPathIndex = String(index);
      token.textContent = source.slice(match.start, match.end);
      fragment.appendChild(token);
      cursor = match.end;
    });
    if (cursor < source.length) {
      fragment.appendChild(documentObject.createTextNode(source.slice(cursor)));
    }
    if (!source) fragment.appendChild(documentObject.createTextNode(" "));
    decor.replaceChildren(fragment);
    setHoverPathToken(null);
    syncDecorScroll();
  };

  const hidePathTooltip = () => {
    tooltip.classList.remove("is-open");
    tooltip.style.left = "";
    tooltip.style.top = "";
  };

  const hidePathMenu = () => {
    contextMenuPath = "";
    menu.classList.remove("is-open");
    menu.setAttribute("aria-hidden", "true");
    menu.style.left = "";
    menu.style.top = "";
  };

  const positionOverlay = (element, clientX, clientY, {
    offsetX = 0,
    offsetY = 0,
    preferAbove = false,
  } = {}) => {
    const padding = 8;
    let left = Math.round((Number(clientX) || 0) + offsetX);
    let top = Math.round((Number(clientY) || 0) + offsetY);
    element.style.left = "0px";
    element.style.top = "0px";
    const rect = element.getBoundingClientRect();
    if (left + rect.width > windowObject.innerWidth - padding) {
      left = Math.max(padding, windowObject.innerWidth - rect.width - padding);
    }
    if (top + rect.height > windowObject.innerHeight - padding) {
      const aboveTop = Math.round((Number(clientY) || 0) - rect.height - 10);
      top = preferAbove
        ? Math.max(padding, aboveTop)
        : Math.max(padding, windowObject.innerHeight - rect.height - padding);
    }
    element.style.left = String(left) + "px";
    element.style.top = String(top) + "px";
  };

  const showPathTooltip = (clientX, clientY, text) => {
    tooltip.textContent = String(text || "Right-click for file options");
    tooltip.classList.add("is-open");
    positionOverlay(tooltip, clientX, clientY, {
      offsetX: 14,
      offsetY: 14,
      preferAbove: true,
    });
  };

  const showPathMenu = (clientX, clientY, targetPath) => {
    contextMenuPath = String(targetPath || "");
    if (!contextMenuPath) return;
    hidePathTooltip();
    menuItems.openReadOnly.hidden = !isExcelWorkbookPath(contextMenuPath);
    menu.classList.add("is-open");
    menu.setAttribute("aria-hidden", "false");
    positionOverlay(menu, clientX, clientY);
  };

  const rememberSelection = () => {
    const start = Number.isFinite(input.selectionStart) ? input.selectionStart : 0;
    const end = Number.isFinite(input.selectionEnd) ? input.selectionEnd : start;
    selectionSnapshot = { start, end };
  };

  const focusInput = ({ preventScroll = true } = {}) => {
    if (destroyed) return;
    try {
      input.focus({ preventScroll: !!preventScroll });
    } catch {
      input.focus();
    }
  };

  const restoreSelectionAndFocus = () => {
    if (destroyed) return;
    focusInput();
    try {
      const length = String(input.value || "").length;
      const start = Math.max(0, Math.min(length, Number(selectionSnapshot.start) || 0));
      const end = Math.max(start, Math.min(length, Number(selectionSnapshot.end) || start));
      input.selectionStart = start;
      input.selectionEnd = end;
    } catch {}
  };

  const isToolbarElement = (element) => !!(element && toolbar.contains(element));

  const flushEditingViewIfInactive = () => {
    flushTimer = null;
    if (destroyed) return;
    if (documentObject.activeElement === input) return;
    if (isToolbarElement(documentObject.activeElement)) return;
    input.style.cursor = "";
    setHoverPathToken(null);
    hidePathTooltip();
    if (decorRenderPending) {
      renderDecor();
      decorRenderPending = false;
    }
    setPlainTextMode(false);
  };

  const scheduleEditingViewFlush = () => {
    clearFlushTimer();
    flushTimer = windowObject.setTimeout(flushEditingViewIfInactive, 0);
  };

  const getDefaultTextStyle = () => {
    return {
      fontFamily: "",
      fontSize: 13,
      color: "#1c2433",
      bold: false,
      italic: false,
      underline: false,
      strike: false,
    };
  };

  const applyTextStyle = (nextState) => {
    if (destroyed || !nextState) return;
    textStyleState = {
      fontFamily: String(nextState.fontFamily || ""),
      fontSize: clampInteger(nextState.fontSize, 8, 48, 13),
      color: rgbStringToHex(nextState.color) || "#1c2433",
      bold: !!nextState.bold,
      italic: !!nextState.italic,
      underline: !!nextState.underline,
      strike: !!nextState.strike,
    };

    const decorationLines = [];
    if (textStyleState.underline) decorationLines.push("underline");
    if (textStyleState.strike) decorationLines.push("line-through");
    const textDecorationLine = decorationLines.length
      ? decorationLines.join(" ")
      : "none";

    root.style.setProperty("--ar-notes-text-color", textStyleState.color);
    for (const textSurface of [decor, input]) {
      textSurface.style.fontFamily = textStyleState.fontFamily;
      textSurface.style.fontSize = String(textStyleState.fontSize) + "px";
      textSurface.style.fontWeight = textStyleState.bold ? "700" : "400";
      textSurface.style.fontStyle = textStyleState.italic ? "italic" : "normal";
      textSurface.style.textDecorationLine = textDecorationLine;
      textSurface.style.textDecorationColor = textStyleState.color;
    }

    styleControls.fontFamily.value = textStyleState.fontFamily;
    styleControls.fontSize.value = String(textStyleState.fontSize);
    styleControls.color.value = textStyleState.color;
    for (const key of ["bold", "italic", "underline", "strike"]) {
      const active = !!textStyleState[key];
      styleControls[key].classList.toggle("is-active", active);
      styleControls[key].setAttribute("aria-pressed", active ? "true" : "false");
    }
  };

  const updateTextStyleFromControls = ({ refocus = false } = {}) => {
    applyTextStyle({
      ...(textStyleState || getDefaultTextStyle()),
      fontFamily: styleControls.fontFamily.value,
      fontSize: styleControls.fontSize.value,
      color: styleControls.color.value,
    });
    if (refocus) restoreSelectionAndFocus();
  };

  const updateDirtyState = (source) => {
    const nextDirty = String(input.value || "") !== cleanValue;
    if (nextDirty === dirty) return;
    const previousDirty = dirty;
    dirty = nextDirty;
    notifyDirtyChange(dirty, {
      value: String(input.value || ""),
      cleanValue,
      previousDirty,
      source,
    });
  };

  const handleInput = () => {
    if (plainTextEditMode) {
      decorRenderPending = true;
    } else {
      renderDecor();
      decorRenderPending = false;
    }
    updateDirtyState("user");
    notifyChange(String(input.value || ""), {
      dirty,
      source: "user",
    });
  };

  const getPathTokenAtPoint = (clientX, clientY) => {
    const previousPointerEvents = input.style.pointerEvents;
    input.style.pointerEvents = "none";
    let node = null;
    try {
      node = documentObject.elementFromPoint(clientX, clientY);
    } finally {
      input.style.pointerEvents = previousPointerEvents;
    }
    const token = node?.closest?.(".arNotesTabPathToken");
    if (!token || !decor.contains(token)) return null;
    return token;
  };

  const getPathFromToken = (token) => String(token?.dataset?.path || "");

  const openPathViaShellBridge = (targetPath, { readOnly = false } = {}) => (
    new Promise((resolve) => {
      let parentWindow = null;
      try {
        parentWindow = windowObject.parent;
      } catch {}
      if (!targetPath || !parentWindow || parentWindow === windowObject) {
        resolve({ ok: false, error: "Open path requires desktop app." });
        return;
      }

      const requestId = "notes-open-path-"
        + Date.now()
        + "-"
        + Math.random().toString(36).slice(2, 8);
      let finished = false;
      let timeoutId = null;

      const finish = (result) => {
        if (finished) return;
        finished = true;
        if (timeoutId !== null) windowObject.clearTimeout(timeoutId);
        windowObject.removeEventListener("message", handleMessage);
        pendingBridgeCancels.delete(cancel);
        resolve(result || { ok: false, error: "Open path failed." });
      };
      const cancel = () => {
        finish({ ok: false, error: "Notes editor was destroyed." });
      };
      const handleMessage = (event) => {
        const message = event?.data;
        if (!message || message.type !== "arcrho:open-path-result") return;
        if (String(message.requestId || "") !== requestId) return;
        finish({
          ok: !!message.ok,
          error: String(message.error || ""),
        });
      };

      pendingBridgeCancels.add(cancel);
      windowObject.addEventListener("message", handleMessage);
      timeoutId = windowObject.setTimeout(() => {
        finish({ ok: false, error: "Open path timed out." });
      }, 5000);

      try {
        parentWindow.postMessage({
          type: "arcrho:open-path",
          requestId,
          path: targetPath,
          readOnly: !!readOnly,
        }, "*");
      } catch {
        finish({ ok: false, error: "Open path requires desktop app." });
      }
    })
  );

  const openDetectedPath = async (targetPath, { readOnly = false } = {}) => {
    if (!targetPath || destroyed) return;
    try {
      const hostApi = windowObject.ADAHost || null;
      const customHandlerUsed = !!openPathHandler;
      let result;
      if (openPathHandler) {
        result = await openPathHandler(targetPath, { readOnly: !!readOnly });
      } else if (hostApi && typeof hostApi.openPath === "function") {
        result = await hostApi.openPath({
          path: targetPath,
          readOnly: !!readOnly,
        });
      } else {
        result = await openPathViaShellBridge(targetPath, {
          readOnly: !!readOnly,
        });
      }
      if (destroyed) return;

      const normalized = normalizeOpenPathResult(result, customHandlerUsed);
      if (normalized.ok) {
        setStatus(
          readOnly
            ? "Opened Excel read-only: " + targetPath
            : "Opened path: " + targetPath,
        );
      } else if (normalized.error === "Open path requires desktop app.") {
        setStatus("Open path requires desktop app.");
      } else {
        setStatus(
          (readOnly ? "Open Excel read-only" : "Open path")
            + " failed: "
            + (normalized.error || targetPath),
        );
      }
    } catch (error) {
      if (destroyed) return;
      setStatus(
        (readOnly ? "Open Excel read-only" : "Open path")
          + " failed: "
          + String(error?.message || error),
      );
    }
  };

  const copyDetectedPath = async (targetPath) => {
    const text = String(targetPath || "");
    if (!text || destroyed) return;
    try {
      const clipboard = windowObject.navigator?.clipboard;
      if (clipboard && typeof clipboard.writeText === "function") {
        await clipboard.writeText(text);
      } else {
        const temporaryInput = documentObject.createElement("textarea");
        temporaryInput.value = text;
        temporaryInput.setAttribute("readonly", "");
        temporaryInput.style.position = "fixed";
        temporaryInput.style.left = "-9999px";
        temporaryInput.style.top = "0";
        overlayHost.appendChild(temporaryInput);
        temporaryInput.select();
        const copied = documentObject.execCommand?.("copy");
        temporaryInput.remove();
        if (copied === false) throw new Error("Clipboard copy was rejected.");
      }
      if (!destroyed) setStatus("Copied file path.");
    } catch (error) {
      if (!destroyed) {
        setStatus("Copy file path failed: " + String(error?.message || error));
      }
    }
  };

  listen(input, "input", handleInput);
  listen(input, "scroll", () => {
    syncDecorScroll();
    setHoverPathToken(null);
    hidePathTooltip();
    hidePathMenu();
  }, { passive: true });
  listen(input, "mousemove", (event) => {
    if ((event.buttons & 1) === 1) {
      input.style.cursor = "";
      setHoverPathToken(null);
      hidePathTooltip();
      return;
    }
    const token = getPathTokenAtPoint(event.clientX, event.clientY);
    if (!token) {
      input.style.cursor = "";
      setHoverPathToken(null);
      hidePathTooltip();
      return;
    }
    input.style.cursor = "pointer";
    setHoverPathToken(token);
    const editing = documentObject.activeElement === input
      || isToolbarElement(documentObject.activeElement);
    showPathTooltip(
      event.clientX,
      event.clientY,
      editing
        ? "Exit editing, then right-click for file options"
        : "Right-click for file options",
    );
  });
  listen(input, "mouseleave", () => {
    input.style.cursor = "";
    setHoverPathToken(null);
    hidePathTooltip();
  });
  listen(input, "focus", () => {
    clearFlushTimer();
    rememberSelection();
    setPlainTextMode(true);
    input.style.cursor = "";
    setHoverPathToken(null);
    hidePathTooltip();
  });
  listen(input, "blur", () => {
    rememberSelection();
    scheduleEditingViewFlush();
  });
  listen(input, "select", rememberSelection);
  listen(input, "keyup", rememberSelection);
  listen(input, "mouseup", rememberSelection);
  listen(input, "keydown", (event) => {
    rememberSelection();
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      input.blur();
      return;
    }
    if (event.key !== "Tab") return;

    event.preventDefault();
    event.stopPropagation();
    const result = event.shiftKey
      ? outdentNotesText(input.value, input.selectionStart, input.selectionEnd)
      : indentNotesText(input.value, input.selectionStart, input.selectionEnd);
    input.value = result.value;
    input.selectionStart = result.selectionStart;
    input.selectionEnd = result.selectionEnd;
    selectionSnapshot = {
      start: result.selectionStart,
      end: result.selectionEnd,
    };
    input.dispatchEvent(new windowObject.Event("input", { bubbles: true }));
  });
  listen(input, "mousedown", (event) => {
    if (event.button === 2) {
      if (plainTextEditMode) return;
      const token = getPathTokenAtPoint(event.clientX, event.clientY);
      const targetPath = getPathFromToken(token);
      if (!targetPath) return;
      event.preventDefault();
      event.stopPropagation();
      setHoverPathToken(token);
      showPathMenu(event.clientX, event.clientY, targetPath);
      return;
    }
    if (event.button !== 0) return;
    hidePathTooltip();
    hidePathMenu();
  });
  listen(input, "contextmenu", (event) => {
    if (plainTextEditMode) return;
    const token = getPathTokenAtPoint(event.clientX, event.clientY);
    const targetPath = getPathFromToken(token);
    if (!targetPath) return;
    event.preventDefault();
    event.stopPropagation();
    setHoverPathToken(token);
    showPathMenu(event.clientX, event.clientY, targetPath);
  });
  listen(input, "click", (event) => {
    rememberSelection();
    if (event.button === 0) hidePathTooltip();
  });

  listen(toolbar, "mousedown", (event) => {
    const toggle = event.target?.closest?.("[data-notes-toggle]");
    if (!toggle || !toolbar.contains(toggle)) return;
    event.preventDefault();
    event.stopPropagation();
  });
  listen(toolbar, "click", (event) => {
    const toggle = event.target?.closest?.("[data-notes-toggle]");
    if (!toggle || !toolbar.contains(toggle)) return;
    const key = String(toggle.dataset.notesToggle || "");
    if (!["bold", "italic", "underline", "strike"].includes(key)) return;
    event.preventDefault();
    event.stopPropagation();
    const current = textStyleState || getDefaultTextStyle();
    applyTextStyle({
      ...current,
      [key]: !current[key],
    });
    restoreSelectionAndFocus();
  });
  listen(toolbar, "focusout", scheduleEditingViewFlush);
  listen(styleControls.fontFamily, "change", () => {
    updateTextStyleFromControls({ refocus: true });
  });
  listen(styleControls.fontSize, "input", updateTextStyleFromControls);
  listen(styleControls.fontSize, "change", () => {
    updateTextStyleFromControls({ refocus: true });
  });
  listen(styleControls.fontSize, "blur", updateTextStyleFromControls);
  listen(styleControls.color, "input", updateTextStyleFromControls);
  listen(styleControls.color, "change", () => {
    updateTextStyleFromControls({ refocus: true });
  });

  listen(menu, "click", (event) => {
    const actionButton = event.target?.closest?.("[data-notes-path-action]");
    if (!actionButton || !menu.contains(actionButton)) return;
    const action = String(actionButton.dataset.notesPathAction || "");
    const targetPath = contextMenuPath;
    event.preventDefault();
    event.stopPropagation();
    hidePathMenu();
    if (action === "open") {
      void openDetectedPath(targetPath);
    } else if (action === "open-read-only") {
      void openDetectedPath(targetPath, { readOnly: true });
    } else if (action === "copy") {
      void copyDetectedPath(targetPath);
    }
  });
  listen(menu, "keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      hidePathMenu();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const visibleItems = [menuItems.open, menuItems.openReadOnly, menuItems.copy]
      .filter((item) => !item.hidden);
    const currentIndex = visibleItems.indexOf(documentObject.activeElement);
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = currentIndex < 0
      ? (direction > 0 ? 0 : visibleItems.length - 1)
      : (currentIndex + direction + visibleItems.length) % visibleItems.length;
    event.preventDefault();
    visibleItems[nextIndex]?.focus();
  });

  listen(documentObject, "mousedown", (event) => {
    if (!menu.contains(event.target)) hidePathMenu();
  });
  listen(windowObject, "keydown", (event) => {
    if (event.key === "Escape") hidePathMenu();
  });
  listen(windowObject, "resize", syncToolbarWidth);
  listen(windowObject, "resize", hidePathMenu);

  applyTextStyle(getDefaultTextStyle());
  renderDecor();
  setPlainTextMode(false);
  syncToolbarWidth();

  if (typeof windowObject.ResizeObserver === "function") {
    resizeObserver = new windowObject.ResizeObserver(syncToolbarWidth);
    resizeObserver.observe(inputWrap);
  }

  const controller = {
    getValue() {
      return String(input.value || "");
    },

    /**
     * Programmatically replaces the note. By default this can make the
     * controller dirty; pass markClean true when loading persisted content.
     */
    setValue(nextValue, {
      markClean = false,
      notify = false,
    } = {}) {
      if (destroyed) return;
      input.value = String(nextValue ?? "");
      if (markClean) cleanValue = input.value;
      const length = input.value.length;
      selectionSnapshot = {
        start: Math.min(length, selectionSnapshot.start),
        end: Math.min(length, selectionSnapshot.end),
      };
      renderDecor();
      decorRenderPending = false;
      updateDirtyState("programmatic");
      if (notify) {
        notifyChange(String(input.value || ""), {
          dirty,
          source: "programmatic",
        });
      }
    },

    markClean(nextCleanValue = input.value) {
      if (destroyed) return;
      cleanValue = String(nextCleanValue ?? "");
      updateDirtyState("mark-clean");
    },

    isDirty() {
      return dirty;
    },

    focus(options = {}) {
      focusInput(options);
    },

    resize() {
      syncToolbarWidth();
      syncDecorScroll();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearFlushTimer();
      for (const cancel of Array.from(pendingBridgeCancels)) cancel();
      pendingBridgeCancels.clear();
      try {
        resizeObserver?.disconnect();
      } catch {}
      resizeObserver = null;
      for (let index = cleanupCallbacks.length - 1; index >= 0; index -= 1) {
        try {
          cleanupCallbacks[index]();
        } catch {}
      }
      cleanupCallbacks.length = 0;
      setHoverPathToken(null);
      tooltip.remove();
      menu.remove();
      root.remove();
      container.classList?.remove("arNotesTabMount");
      if (MOUNTED_NOTES_TABS.get(container) === controller) {
        MOUNTED_NOTES_TABS.delete(container);
      }
    },

    get destroyed() {
      return destroyed;
    },

    elements: {
      root,
      toolbar,
      inputWrap,
      decor,
      input,
      tooltip,
      pathMenu: menu,
      styleControls,
    },
  };

  MOUNTED_NOTES_TABS.set(container, controller);
  return controller;
}

export const createNotesTab = mountNotesTab;

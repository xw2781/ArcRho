import {
  findNotesPathMatches,
  isExcelWorkbookPath,
} from "./notes_paths.js";
import {
  indentNotesText,
  outdentNotesText,
} from "./notes_text.js";
import {
  findNotesCompletionQuery,
  findNotesExpressionMatches,
  listNotesCompletions,
  renderNotesExpressionText,
  renderNotesExpressions,
} from "./notes_expressions.js";

const NOTES_TAB_STYLESHEET_ID = "arNotesTabStylesheet";
const NOTES_TAB_STYLESHEET_HREF = "/ui/shared/tabs/notes/notes_tab.css?v=20260911a";
const CLICK_DRAG_THRESHOLD_PX = 3;
// The note font size the user picked last, remembered for every Notes tab in
// the app so a panel opens at the size they were reading at.
const NOTES_FONT_SIZE_STORAGE_KEY = "arcrho.notes.font-size";
const DEFAULT_NOTES_FONT_SIZE = 13;
const MIN_NOTES_FONT_SIZE = 8;
const MAX_NOTES_FONT_SIZE = 48;
// The panel size the user dragged the note to, remembered the same way.
const NOTES_PANEL_SIZE_STORAGE_KEY = "arcrho.notes.panel-size";
const MIN_NOTES_PANEL_SIZE_PX = 160;
const MAX_NOTES_PANEL_SIZE_PX = 4000;
const NOTES_PANEL_SIZE_SAVE_DELAY_MS = 200;
const AUTO_CLOSE_PAIRS = { "{": "}", "(": ")" };
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

  // Shown only when the page supplies an expression context.
  const insertDivider = appendElement(
    documentRef,
    toolbar,
    "span",
    "arNotesTabFormatDivider",
  );
  insertDivider.setAttribute("aria-hidden", "true");
  insertDivider.hidden = true;
  const insert = appendElement(
    documentRef,
    toolbar,
    "button",
    "arNotesTabInsertButton",
    "Insert Value",
  );
  insert.type = "button";
  insert.dataset.notesInsert = "1";
  insert.title = "Insert a value from this method into the note";
  insert.setAttribute("aria-haspopup", "menu");
  insert.setAttribute("aria-expanded", "false");
  insert.hidden = true;

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

  // Mirrors the raw text under the transparent-text textarea while editing
  // so `{...}` can be coloured and the caret can be located on screen.
  const editLayer = appendElement(
    documentRef,
    inputWrap,
    "pre",
    "arNotesTabEditLayer",
  );
  editLayer.setAttribute("aria-hidden", "true");

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
    editLayer,
    input,
    insert,
    insertDivider,
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

  const insertMenu = documentRef.createElement("div");
  insertMenu.className = "arNotesTabPathMenu arNotesTabInsertMenu";
  insertMenu.setAttribute("role", "menu");
  insertMenu.setAttribute("aria-hidden", "true");

  const completionMenu = documentRef.createElement("div");
  completionMenu.className = "arNotesTabPathMenu arNotesTabCompletionMenu";
  completionMenu.setAttribute("role", "listbox");
  completionMenu.setAttribute("aria-label", "Available names");
  completionMenu.setAttribute("aria-hidden", "true");
  return {
    tooltip,
    menu,
    insertMenu,
    completionMenu,
    menuItems: { open, openReadOnly, copy },
  };
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** The remembered note font size, or the default when none is stored. */
function readStoredNotesFontSize(windowObject) {
  try {
    const stored = windowObject?.localStorage?.getItem(NOTES_FONT_SIZE_STORAGE_KEY);
    if (stored === null || stored === undefined || stored === "") return DEFAULT_NOTES_FONT_SIZE;
    return clampInteger(
      stored,
      MIN_NOTES_FONT_SIZE,
      MAX_NOTES_FONT_SIZE,
      DEFAULT_NOTES_FONT_SIZE,
    );
  } catch {
    return DEFAULT_NOTES_FONT_SIZE;
  }
}

function writeStoredNotesFontSize(windowObject, fontSize) {
  try {
    windowObject?.localStorage?.setItem(NOTES_FONT_SIZE_STORAGE_KEY, String(fontSize));
  } catch {
    // A blocked or full storage only costs the panel its remembered size.
  }
}

/**
 * The remembered panel size, or null when none is stored. Only a drag of the
 * resize grip is remembered: the browser writes the dragged width and height
 * to the inline style, while a window resize leaves the style alone.
 */
function readStoredNotesPanelSize(windowObject) {
  try {
    const raw = windowObject?.localStorage?.getItem(NOTES_PANEL_SIZE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const width = clampInteger(parsed?.width, MIN_NOTES_PANEL_SIZE_PX, MAX_NOTES_PANEL_SIZE_PX, 0);
    const height = clampInteger(parsed?.height, MIN_NOTES_PANEL_SIZE_PX, MAX_NOTES_PANEL_SIZE_PX, 0);
    if (!width && !height) return null;
    return { width, height };
  } catch {
    return null;
  }
}

function writeStoredNotesPanelSize(windowObject, size) {
  try {
    windowObject?.localStorage?.setItem(NOTES_PANEL_SIZE_STORAGE_KEY, JSON.stringify(size));
  } catch {
    // A blocked or full storage only costs the panel its remembered size.
  }
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
 * @param {() => Object} [options.expressionContext] Returns the names a `{...}`
 *   placeholder may use (see notes_expressions.js). When given, the rendered
 *   view shows each placeholder's value and the toolbar offers Insert Value.
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
  expressionContext,
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
  const resolveExpressionContext = typeof expressionContext === "function"
    ? expressionContext
    : null;

  ensureNotesTabStylesheet(documentObject);
  const elements = buildNotesTabElements(documentObject, {
    ariaLabel,
    placeholder,
  });
  const overlays = buildPathOverlayElements(documentObject);
  const overlayHost = documentObject.body || documentObject.documentElement;
  overlayHost.appendChild(overlays.tooltip);
  overlayHost.appendChild(overlays.menu);
  overlayHost.appendChild(overlays.insertMenu);
  overlayHost.appendChild(overlays.completionMenu);
  container.classList?.add("arNotesTabMount");
  container.appendChild(elements.root);

  const {
    root,
    toolbar,
    inputWrap,
    decor,
    editLayer,
    input,
    insert,
    insertDivider,
    styleControls,
  } = elements;
  const {
    tooltip,
    menu,
    insertMenu,
    completionMenu,
    menuItems,
  } = overlays;
  // The completion popup: the query being typed, its entries, and the
  // highlighted row.
  let completionState = null;
  insert.hidden = !resolveExpressionContext;
  insertDivider.hidden = !resolveExpressionContext;

  const cleanupCallbacks = [];
  const pendingBridgeCancels = new Set();
  let destroyed = false;
  let cleanValue = String(value ?? "");
  let dirty = false;
  let plainTextEditMode = false;
  let hoverPathToken = null;
  let contextMenuPath = "";
  let textStyleState = null;
  let selectionSnapshot = { start: 0, end: 0 };
  let flushTimer = null;
  let panelSizeSaveTimer = null;
  let resizeObserver = null;
  // Where the mouse went down on the rendered view; a release without a drag
  // enters editing, a drag leaves the rendered text selected for copying.
  let decorPress = null;

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

  const clearPanelSizeSaveTimer = () => {
    if (panelSizeSaveTimer === null) return;
    windowObject.clearTimeout(panelSizeSaveTimer);
    panelSizeSaveTimer = null;
  };

  /**
   * Remembers the size the grip was dragged to. The inline width and height
   * are the browser's own record of that drag, so an empty pair means the
   * panel is still at its stylesheet size and nothing is stored.
   */
  const scheduleNotesPanelSizeSave = () => {
    if (destroyed) return;
    const { width, height } = inputWrap.style;
    if (!width && !height) return;
    clearPanelSizeSaveTimer();
    panelSizeSaveTimer = windowObject.setTimeout(() => {
      panelSizeSaveTimer = null;
      if (destroyed) return;
      writeStoredNotesPanelSize(windowObject, {
        width: Math.round(inputWrap.offsetWidth || 0),
        height: Math.round(inputWrap.offsetHeight || 0),
      });
    }, NOTES_PANEL_SIZE_SAVE_DELAY_MS);
  };

  const restoreNotesPanelSize = () => {
    const stored = readStoredNotesPanelSize(windowObject);
    if (!stored) return;
    // `max-width: 100%` keeps a panel wider than its host from overflowing.
    if (stored.width) inputWrap.style.width = String(stored.width) + "px";
    if (stored.height) inputWrap.style.height = String(stored.height) + "px";
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

  const buildTextSegment = (segmentText, rawStart) => {
    const span = documentObject.createElement("span");
    span.className = "arNotesTabTextSegment";
    span.dataset.rawStart = String(rawStart);
    let cursor = 0;
    findNotesPathMatches(segmentText).forEach((match) => {
      if (match.start > cursor) {
        span.appendChild(documentObject.createTextNode(segmentText.slice(cursor, match.start)));
      }
      const token = documentObject.createElement("span");
      token.className = "arNotesTabPathToken";
      token.dataset.path = match.path;
      token.textContent = segmentText.slice(match.start, match.end);
      span.appendChild(token);
      cursor = match.end;
    });
    if (cursor < segmentText.length) {
      span.appendChild(documentObject.createTextNode(segmentText.slice(cursor)));
    }
    return span;
  };

  const buildExpressionSegment = (segment) => {
    const span = documentObject.createElement("span");
    span.className = "arNotesTabExpression" + (segment.error ? " is-error" : "");
    span.textContent = segment.text;
    span.dataset.source = segment.source;
    if (segment.error) span.dataset.error = segment.error;
    span.dataset.rawStart = String(segment.start);
    return span;
  };

  // The rendered view: every segment remembers the raw note span it came
  // from so a click on it can put the caret at the matching raw position.
  const renderDecor = () => {
    if (destroyed) return;
    const source = String(input.value || "");
    const fragment = documentObject.createDocumentFragment();
    if (!source) {
      const empty = documentObject.createElement("span");
      empty.className = "arNotesTabPlaceholder";
      empty.textContent = input.placeholder;
      fragment.appendChild(empty);
    } else {
      const segments = resolveExpressionContext
        ? renderNotesExpressions(source, resolveExpressionContext())
        : [{ kind: "text", start: 0, end: source.length, text: source }];
      for (const segment of segments) {
        const element = segment.kind === "expression"
          ? buildExpressionSegment(segment)
          : buildTextSegment(segment.text, segment.start);
        element.dataset.rawEnd = String(segment.end);
        fragment.appendChild(element);
      }
    }
    decor.replaceChildren(fragment);
    setHoverPathToken(null);
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

  const hideInsertMenu = () => {
    insertMenu.classList.remove("is-open");
    insertMenu.setAttribute("aria-hidden", "true");
    insertMenu.style.left = "";
    insertMenu.style.top = "";
    insert.setAttribute("aria-expanded", "false");
  };

  const showInsertMenu = () => {
    const catalog = resolveExpressionContext?.()?.catalog;
    insertMenu.replaceChildren();
    for (const entry of Array.isArray(catalog) ? catalog : []) {
      const item = appendElement(
        documentObject,
        insertMenu,
        "button",
        "arNotesTabPathMenuItem arNotesTabInsertItem",
      );
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.dataset.notesSnippet = String(entry.snippet || "");
      appendElement(documentObject, item, "code", "arNotesTabInsertSnippet", entry.snippet);
      appendElement(documentObject, item, "span", "arNotesTabInsertDescription", entry.description);
    }
    hidePathTooltip();
    hidePathMenu();
    insertMenu.classList.add("is-open");
    insertMenu.setAttribute("aria-hidden", "false");
    insert.setAttribute("aria-expanded", "true");
    const anchor = insert.getBoundingClientRect();
    positionOverlay(insertMenu, anchor.left, anchor.bottom + 4);
  };

  const insertSnippet = (snippet) => {
    if (destroyed || !snippet) return;
    const length = String(input.value || "").length;
    const start = Math.max(0, Math.min(length, Number(selectionSnapshot.start) || 0));
    const end = Math.max(start, Math.min(length, Number(selectionSnapshot.end) || start));
    focusInput();
    input.selectionStart = start;
    input.selectionEnd = end;
    // execCommand keeps the textarea's undo history; setRangeText is the
    // fallback where it is unavailable.
    if (!documentObject.execCommand?.("insertText", false, snippet)) {
      input.setRangeText(snippet, start, end, "end");
      input.dispatchEvent(new windowObject.Event("input", { bubbles: true }));
    }
    rememberSelection();
  };

  // The edit-mode mirror: the raw text with each `{...}` in deep blue. A
  // trailing zero-width space keeps a final empty line the same height the
  // textarea gives it.
  const renderEditLayer = () => {
    if (destroyed) return;
    const source = String(input.value || "");
    const fragment = documentObject.createDocumentFragment();
    let cursor = 0;
    const matches = resolveExpressionContext ? findNotesExpressionMatches(source) : [];
    for (const match of matches) {
      if (match.literal !== undefined) continue;
      if (match.start > cursor) fragment.appendChild(documentObject.createTextNode(source.slice(cursor, match.start)));
      const span = documentObject.createElement("span");
      span.className = "arNotesTabEditExpression";
      span.textContent = source.slice(match.start, match.end);
      fragment.appendChild(span);
      cursor = match.end;
    }
    fragment.appendChild(documentObject.createTextNode(source.slice(cursor) + "\u200b"));
    editLayer.replaceChildren(fragment);
    editLayer.scrollTop = input.scrollTop;
    editLayer.scrollLeft = input.scrollLeft;
  };

  // Where a raw text offset sits on screen, read off the mirror layer.
  const caretRectAt = (offset) => {
    let remaining = Math.max(0, offset);
    const walker = documentObject.createTreeWalker(editLayer, 4);
    let node = walker.nextNode();
    while (node) {
      const length = node.textContent.length;
      if (remaining <= length) {
        const range = documentObject.createRange();
        const at = Math.min(remaining, Math.max(0, length - 1));
        range.setStart(node, at);
        range.setEnd(node, Math.min(length, at + 1));
        const rects = range.getClientRects();
        const rect = rects.length ? rects[remaining >= length && rects.length > 1 ? rects.length - 1 : 0] : range.getBoundingClientRect();
        if (rect && (rect.width || rect.height)) {
          return remaining >= length && length > 0 ? { left: rect.right, top: rect.top, bottom: rect.bottom } : rect;
        }
        break;
      }
      remaining -= length;
      node = walker.nextNode();
    }
    const fallback = editLayer.getBoundingClientRect();
    return { left: fallback.left + 10, top: fallback.top + 10, bottom: fallback.top + 28 };
  };

  const hideCompletions = () => {
    completionState = null;
    completionMenu.classList.remove("is-open");
    completionMenu.setAttribute("aria-hidden", "true");
    completionMenu.style.left = "";
    completionMenu.style.top = "";
  };

  const renderCompletions = () => {
    const { entries, active } = completionState;
    completionMenu.replaceChildren();
    entries.forEach((entry, index) => {
      const item = appendElement(
        documentObject,
        completionMenu,
        "div",
        "arNotesTabCompletionItem" + (index === active ? " is-active" : ""),
      );
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", index === active ? "true" : "false");
      item.dataset.notesCompletion = String(index);
      appendElement(documentObject, item, "code", "arNotesTabCompletionName", entry.name);
      appendElement(documentObject, item, "span", "arNotesTabCompletionKind", entry.kind);
      appendElement(documentObject, item, "span", "arNotesTabCompletionPreview", entry.description || entry.preview);
    });
    completionMenu.querySelector(".is-active")?.scrollIntoView?.({ block: "nearest" });
  };

  // Offers the names that can follow what the caret is typing inside `{...}`.
  const updateCompletions = () => {
    if (destroyed || !resolveExpressionContext || documentObject.activeElement !== input) {
      hideCompletions();
      return;
    }
    const caret = Number.isFinite(input.selectionStart) ? input.selectionStart : 0;
    if (caret !== input.selectionEnd) {
      hideCompletions();
      return;
    }
    const value = String(input.value || "");
    const query = findNotesCompletionQuery(value.slice(0, caret));
    if (!query) {
      hideCompletions();
      return;
    }
    const partial = query.partial.toLowerCase();
    const entries = listNotesCompletions(resolveExpressionContext(), query.path)
      .filter((entry) => entry.name.toLowerCase().startsWith(partial));
    if (!entries.length || (entries.length === 1 && entries[0].name === query.partial && entries[0].kind === "value")) {
      hideCompletions();
      return;
    }
    const previousName = completionState?.entries[completionState.active]?.name;
    const active = Math.max(0, entries.findIndex((entry) => entry.name === previousName));
    completionState = { query, entries, active };
    renderCompletions();
    completionMenu.classList.add("is-open");
    completionMenu.setAttribute("aria-hidden", "false");
    const rect = caretRectAt(caret);
    positionOverlay(completionMenu, rect.left, rect.bottom + 4);
  };

  const moveCompletion = (step) => {
    if (!completionState) return;
    const count = completionState.entries.length;
    completionState.active = (completionState.active + step + count) % count;
    renderCompletions();
  };

  // Replaces [start, end) with text, keeping the textarea's undo history
  // where execCommand is available.
  const replaceRange = (start, end, text) => {
    input.selectionStart = start;
    input.selectionEnd = end;
    if (!documentObject.execCommand?.(text ? "insertText" : "delete", false, text)) {
      input.setRangeText(text, start, end, "end");
      input.dispatchEvent(new windowObject.Event("input", { bubbles: true }));
    }
  };

  const setCaret = (start, end = start) => {
    input.selectionStart = start;
    input.selectionEnd = end;
    rememberSelection();
    updateCompletions();
  };

  const acceptCompletion = (index = completionState?.active) => {
    if (!completionState) return;
    const entry = completionState.entries[index];
    const { query } = completionState;
    if (!entry) return;
    const caret = Number.isFinite(input.selectionStart) ? input.selectionStart : 0;
    focusInput();
    // A list or function completion lands inside its parentheses.
    const closing = AUTO_CLOSE_PAIRS[entry.insert.slice(-1)] || "";
    replaceRange(query.start, caret, entry.insert + closing);
    setCaret(query.start + entry.insert.length);
  };

  // Brackets close themselves while a note has placeholders: the opener
  // inserts its pair around the selection, the closer steps over one already
  // there, and Backspace inside an empty pair removes both.
  const handleBracketKey = (event) => {
    if (!resolveExpressionContext || event.ctrlKey || event.metaKey || event.altKey) return false;
    const value = String(input.value || "");
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const closing = AUTO_CLOSE_PAIRS[event.key];
    if (closing) {
      if (start === end && /\w/u.test(value[end] || "")) return false;
      event.preventDefault();
      replaceRange(start, end, event.key + value.slice(start, end) + closing);
      setCaret(start + 1, end + 1);
      return true;
    }
    if (Object.values(AUTO_CLOSE_PAIRS).includes(event.key) && start === end && value[start] === event.key) {
      event.preventDefault();
      setCaret(start + 1);
      return true;
    }
    if (event.key === "Backspace" && start === end && start > 0 && AUTO_CLOSE_PAIRS[value[start - 1]] === value[start]) {
      event.preventDefault();
      replaceRange(start - 1, start + 1, "");
      setCaret(start - 1);
      return true;
    }
    return false;
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
    setHoverPathToken(null);
    hidePathTooltip();
    hideInsertMenu();
    hideCompletions();
    renderDecor();
    setPlainTextMode(false);
    syncDecorScroll();
  };

  const scheduleEditingViewFlush = () => {
    clearFlushTimer();
    flushTimer = windowObject.setTimeout(flushEditingViewIfInactive, 0);
  };

  const getDefaultTextStyle = () => {
    return {
      fontFamily: "",
      fontSize: readStoredNotesFontSize(windowObject),
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
      fontSize: clampInteger(
        nextState.fontSize,
        MIN_NOTES_FONT_SIZE,
        MAX_NOTES_FONT_SIZE,
        DEFAULT_NOTES_FONT_SIZE,
      ),
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
    for (const textSurface of [decor, editLayer, input]) {
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
    if (textStyleState) writeStoredNotesFontSize(windowObject, textStyleState.fontSize);
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
      renderEditLayer();
      updateCompletions();
    } else {
      renderDecor();
    }
    updateDirtyState("user");
    notifyChange(String(input.value || ""), {
      dirty,
      source: "user",
    });
  };

  const caretPointAt = (clientX, clientY) => {
    if (typeof documentObject.caretPositionFromPoint === "function") {
      const position = documentObject.caretPositionFromPoint(clientX, clientY);
      return position ? { node: position.offsetNode, offset: position.offset } : null;
    }
    if (typeof documentObject.caretRangeFromPoint === "function") {
      const range = documentObject.caretRangeFromPoint(clientX, clientY);
      return range ? { node: range.startContainer, offset: range.startOffset } : null;
    }
    return null;
  };

  // Maps a point on the rendered view to a caret position in the raw note.
  // Inside a text segment the rendered and raw characters line up; a click on
  // a rendered value lands at the opening brace of its placeholder.
  const rawOffsetFromPoint = (clientX, clientY) => {
    const length = String(input.value || "").length;
    const point = caretPointAt(clientX, clientY);
    if (!point?.node) return length;
    const element = point.node.nodeType === 3 ? point.node.parentElement : point.node;
    const segment = element?.closest?.("[data-raw-start]");
    if (!segment || !decor.contains(segment)) return length;
    const rawStart = Number(segment.dataset.rawStart);
    if (segment.classList.contains("arNotesTabExpression")) return rawStart;
    const range = documentObject.createRange();
    range.setStart(segment, 0);
    range.setEnd(point.node, point.offset);
    return Math.min(Number(segment.dataset.rawEnd), rawStart + range.toString().length);
  };

  const beginEditingAt = (offset) => {
    focusInput();
    try {
      input.selectionStart = offset;
      input.selectionEnd = offset;
    } catch {}
    rememberSelection();
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
  listen(input, "focus", () => {
    clearFlushTimer();
    rememberSelection();
    setHoverPathToken(null);
    hidePathTooltip();
    // Carry the rendered view's scroll position into the editor before the
    // view is hidden.
    input.scrollTop = decor.scrollTop;
    input.scrollLeft = decor.scrollLeft;
    setPlainTextMode(true);
    renderEditLayer();
  });
  listen(input, "scroll", () => {
    editLayer.scrollTop = input.scrollTop;
    editLayer.scrollLeft = input.scrollLeft;
    hideCompletions();
  }, { passive: true });

  // The rendered view is a selectable surface: dragging selects rendered text
  // for copying, a plain click enters editing at the clicked position.
  listen(decor, "mousedown", (event) => {
    hidePathTooltip();
    hidePathMenu();
    hideInsertMenu();
    decorPress = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
  });
  listen(decor, "mouseup", (event) => {
    const press = decorPress;
    decorPress = null;
    if (event.button !== 0 || !press) return;
    const dragged = Math.abs(event.clientX - press.x) > CLICK_DRAG_THRESHOLD_PX
      || Math.abs(event.clientY - press.y) > CLICK_DRAG_THRESHOLD_PX;
    const selection = windowObject.getSelection?.();
    if (dragged || (selection && !selection.isCollapsed && decor.contains(selection.anchorNode))) return;
    beginEditingAt(rawOffsetFromPoint(event.clientX, event.clientY));
  });
  listen(decor, "mousemove", (event) => {
    if ((event.buttons & 1) === 1) {
      setHoverPathToken(null);
      hidePathTooltip();
      return;
    }
    const token = event.target?.closest?.(".arNotesTabPathToken");
    if (token) {
      setHoverPathToken(token);
      showPathTooltip(
        event.clientX,
        event.clientY,
        isToolbarElement(documentObject.activeElement)
          ? "Exit editing, then right-click for file options"
          : "Right-click for file options",
      );
      return;
    }
    setHoverPathToken(null);
    const expression = event.target?.closest?.(".arNotesTabExpression");
    if (!expression) {
      hidePathTooltip();
      return;
    }
    const source = String(expression.dataset.source || "");
    const error = String(expression.dataset.error || "");
    showPathTooltip(event.clientX, event.clientY, error ? source + ": " + error : source);
  });
  listen(decor, "mouseleave", () => {
    setHoverPathToken(null);
    hidePathTooltip();
  });
  listen(decor, "scroll", () => {
    hidePathTooltip();
    hidePathMenu();
  }, { passive: true });
  listen(decor, "contextmenu", (event) => {
    const token = event.target?.closest?.(".arNotesTabPathToken");
    const targetPath = getPathFromToken(token);
    if (!targetPath) return;
    event.preventDefault();
    event.stopPropagation();
    setHoverPathToken(token);
    showPathMenu(event.clientX, event.clientY, targetPath);
  });
  listen(input, "blur", () => {
    rememberSelection();
    scheduleEditingViewFlush();
  });
  listen(input, "select", rememberSelection);
  listen(input, "keyup", (event) => {
    rememberSelection();
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) updateCompletions();
  });
  listen(input, "mouseup", rememberSelection);
  listen(input, "keydown", (event) => {
    rememberSelection();
    if (completionState) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        moveCompletion(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        acceptCompletion();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        hideCompletions();
        return;
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      input.blur();
      return;
    }
    if (handleBracketKey(event)) return;
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
    if (event.button !== 0) return;
    hidePathTooltip();
    hidePathMenu();
    hideInsertMenu();
  });
  listen(input, "click", () => {
    rememberSelection();
    updateCompletions();
  });

  listen(toolbar, "mousedown", (event) => {
    const control = event.target?.closest?.("[data-notes-toggle], [data-notes-insert]");
    if (!control || !toolbar.contains(control)) return;
    event.preventDefault();
    event.stopPropagation();
  });
  listen(toolbar, "click", (event) => {
    if (event.target?.closest?.("[data-notes-insert]")) {
      event.preventDefault();
      event.stopPropagation();
      if (insertMenu.classList.contains("is-open")) hideInsertMenu();
      else showInsertMenu();
      return;
    }
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

  // Keep focus in the textarea while the Insert Value menu is used so leaving
  // and re-entering edit mode does not flicker around the click.
  listen(insertMenu, "mousedown", (event) => {
    event.preventDefault();
  });
  listen(insertMenu, "click", (event) => {
    const item = event.target?.closest?.("[data-notes-snippet]");
    if (!item || !insertMenu.contains(item)) return;
    event.preventDefault();
    event.stopPropagation();
    hideInsertMenu();
    insertSnippet(String(item.dataset.notesSnippet || ""));
  });

  // Clicking a completion must not blur the textarea, or the accept would
  // land after the editor has already left edit mode.
  listen(completionMenu, "mousedown", (event) => {
    event.preventDefault();
  });
  listen(completionMenu, "click", (event) => {
    const item = event.target?.closest?.("[data-notes-completion]");
    if (!item || !completionMenu.contains(item)) return;
    event.preventDefault();
    event.stopPropagation();
    acceptCompletion(Number(item.dataset.notesCompletion));
  });

  listen(documentObject, "mousedown", (event) => {
    if (!menu.contains(event.target)) hidePathMenu();
    if (!insertMenu.contains(event.target) && !insert.contains(event.target)) hideInsertMenu();
    if (!completionMenu.contains(event.target)) hideCompletions();
  });
  listen(documentObject, "mouseup", () => {
    decorPress = null;
  });
  listen(windowObject, "keydown", (event) => {
    if (event.key !== "Escape") return;
    hidePathMenu();
    hideInsertMenu();
  });
  listen(windowObject, "resize", syncToolbarWidth);
  listen(windowObject, "resize", hidePathMenu);
  listen(windowObject, "resize", hideInsertMenu);

  applyTextStyle(getDefaultTextStyle());
  renderDecor();
  setPlainTextMode(false);
  restoreNotesPanelSize();
  syncToolbarWidth();

  if (typeof windowObject.ResizeObserver === "function") {
    resizeObserver = new windowObject.ResizeObserver(() => {
      syncToolbarWidth();
      scheduleNotesPanelSizeSave();
    });
    resizeObserver.observe(inputWrap);
  }

  const controller = {
    getValue() {
      return String(input.value || "");
    },

    /**
     * The range last selected while editing, as offsets into the raw text.
     * Editing ends as soon as focus leaves, so the range outlives it and is
     * still what a tool run from another window means by "the selected text".
     * `start === end` when nothing is selected.
     */
    getSelection() {
      const length = String(input.value || "").length;
      const start = Math.max(0, Math.min(length, Number(selectionSnapshot.start) || 0));
      const end = Math.max(start, Math.min(length, Number(selectionSnapshot.end) || start));
      return { start, end };
    },

    /**
     * The note with every placeholder rendered against the current
     * expression context, or the raw text when the page supplies none.
     */
    getRenderedValue() {
      const source = String(input.value || "");
      return resolveExpressionContext
        ? renderNotesExpressionText(source, resolveExpressionContext())
        : source;
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
      const previousValue = String(input.value || "");
      input.value = String(nextValue ?? "");
      if (markClean) cleanValue = input.value;
      const length = input.value.length;
      // Different text makes the remembered range meaningless, so it starts
      // over; the same text keeps it, clamped.
      selectionSnapshot = input.value === previousValue
        ? {
          start: Math.min(length, selectionSnapshot.start),
          end: Math.min(length, selectionSnapshot.end),
        }
        : { start: 0, end: 0 };
      renderDecor();
      renderEditLayer();
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

    /**
     * Re-renders the view so `{...}` placeholders show current values. A note
     * being edited shows raw text and is rendered when editing ends anyway.
     */
    render() {
      if (destroyed || plainTextEditMode) return;
      renderDecor();
      syncDecorScroll();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearFlushTimer();
      clearPanelSizeSaveTimer();
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
      insertMenu.remove();
      completionMenu.remove();
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
      insertMenu,
      completionMenu,
      editLayer,
      styleControls,
    },
  };

  MOUNTED_NOTES_TABS.set(container, controller);
  return controller;
}

export const createNotesTab = mountNotesTab;

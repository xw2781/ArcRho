/*
===============================================================================
Linked-Cell Formula Editor
The floating formula bar for an Excel-linked Dataset cell. It wears the shared
`.arFormulaBar` look and follows the same rules as the DFM Ratios bar: it sits
above the linked cell — or the whole spilled range — sized to the formula it
shows and never wider than the visible grid frame, it renders a colorized
read-only view until the input is focused, and a click on the cell pins it open
or closed.
===============================================================================
*/
import {
  computeFormulaBarLayout,
  FORMULA_BAR_FRAME_INSET_PX,
  getFormulaBarContentWidth,
  invalidateFormulaBarWidthCache,
} from "/ui/shared/components/formula_bar/formula_bar_layout.js?v=20260812a";
import { tokenizeFormula } from "/ui/shared/components/formula_bar/formula_text.js?v=20260812a";

const FORMULA_HOVER_STYLE_ID = "arcrho-formula-hover-style";
const FORMULA_HOVER_STYLESHEETS = [
  "/ui/shared/components/formula_bar/formula_bar.css?v=20260812a",
  "/ui/shared/components/formula_hover/formula_hover.css?v=20260812a",
];
const DEFAULT_HIDE_DELAY_MS = 140;
const VIEWPORT_MARGIN_PX = 8;

let formulaHoverIdSequence = 0;

export function ensureFormulaHoverStyles(documentRef = document) {
  if (!documentRef?.head) return;
  const links = Array.from(documentRef.querySelectorAll?.('link[rel="stylesheet"]') || []);
  FORMULA_HOVER_STYLESHEETS.forEach((href, index) => {
    const path = href.split("?")[0];
    if (links.some((link) => String(link.getAttribute?.("href") || link.href || "").includes(path))) return;
    const id = index === 0 ? `${FORMULA_HOVER_STYLE_ID}-base` : FORMULA_HOVER_STYLE_ID;
    if (documentRef.getElementById?.(id)) return;
    const link = documentRef.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = href;
    documentRef.head.appendChild(link);
  });
}

/**
 * Where the editor sits, in viewport coordinates. `frameEl` is the scrolling
 * grid the bar must stay inside; without one it falls back to the window, which
 * is what a detached or test document gets.
 */
export function calculateFormulaHoverPosition(anchorRect, hoverRect, viewport = {}, frameRect = null) {
  const viewportWidth = Math.max(0, Number(viewport.width) || 0);
  const viewportHeight = Math.max(0, Number(viewport.height) || 0);
  const margin = VIEWPORT_MARGIN_PX;
  const frame = frameRect || {
    left: margin,
    right: Math.max(margin, viewportWidth - margin),
    top: margin,
    bottom: Math.max(margin, viewportHeight - margin),
  };
  const layout = computeFormulaBarLayout({
    anchorRect,
    frame,
    contentWidth: Math.max(0, Number(hoverRect?.width) || 0),
    barHeight: Math.max(0, Number(hoverRect?.height) || 0),
  });
  if (!layout) {
    return { left: Math.round(Number(anchorRect?.left) || 0), top: 0, width: 0, placement: "above" };
  }
  return layout;
}

function normalizedFormulaContext(rawContext) {
  if (!rawContext || typeof rawContext !== "object") return null;
  const formula = String(rawContext.formula ?? rawContext.reference ?? "").trim();
  if (!formula) return null;
  return { ...rawContext, formula };
}

/** Colorized read-only rendering: Excel references carry the workbook color. */
function renderFormulaDisplay(displayEl, rawText) {
  if (!displayEl) return;
  displayEl.textContent = "";
  const tokens = tokenizeFormula(rawText);
  if (!tokens.length) return;
  for (const token of tokens) {
    if (token.type === "excel") {
      const span = displayEl.ownerDocument.createElement("span");
      span.className = "fmtExcelRef";
      span.textContent = token.text;
      displayEl.appendChild(span);
      continue;
    }
    if (token.type === "op") {
      displayEl.appendChild(displayEl.ownerDocument.createTextNode(` ${token.text} `));
      continue;
    }
    const text = token.text.trim();
    if (text) {
      displayEl.appendChild(displayEl.ownerDocument.createTextNode(text === "=" ? "= " : text));
    }
  }
}

export function createFormulaHoverEditor(options = {}) {
  const documentRef = options.documentRef || document;
  const windowRef = options.windowRef || documentRef?.defaultView || window;
  const onCommit = typeof options.onCommit === "function"
    ? options.onCommit
    : async () => ({ ok: false, error: "Formula editing is unavailable." });
  const onEditStart = typeof options.onEditStart === "function" ? options.onEditStart : () => {};
  const onDismiss = typeof options.onDismiss === "function" ? options.onDismiss : () => {};
  const onStatus = typeof options.onStatus === "function" ? options.onStatus : () => {};
  const getFrameElement = typeof options.getFrameElement === "function"
    ? options.getFrameElement
    : () => documentRef.getElementById?.("tableWrap") || null;
  const hideDelayMs = Number.isFinite(Number(options.hideDelayMs))
    ? Math.max(0, Number(options.hideDelayMs))
    : DEFAULT_HIDE_DELAY_MS;

  let root = null;
  let input = null;
  let display = null;
  let errorMessage = null;
  let activeAnchor = null;
  let activePositionRect = null;
  let activeContext = null;
  let activeKey = "";
  let pinnedKey = "";
  let hideTimer = 0;
  let barHovered = false;
  let commitPending = false;
  let commitSequence = 0;

  function handleDocumentMouseDown(event) {
    if (!root?.classList?.contains("isOpen") || commitPending) return;
    if (root.contains?.(event.target) || activeAnchor?.contains?.(event.target)) return;
    pinnedKey = "";
    hide();
  }

  function handleViewportResize() {
    invalidateFormulaBarWidthCache();
    reposition();
  }

  function ensureEditor() {
    if (root?.isConnected) return root;
    if (!documentRef?.body) return null;
    ensureFormulaHoverStyles(documentRef);

    formulaHoverIdSequence += 1;
    const errorId = `arFormulaHoverError-${formulaHoverIdSequence}`;

    root = documentRef.createElement("div");
    root.className = "arFormulaBar arFormulaHover";
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", "External Excel formula");
    root.setAttribute("aria-hidden", "true");
    root.setAttribute("aria-busy", "false");

    const formulaMark = documentRef.createElement("span");
    formulaMark.className = "arFormulaBarFxIcon";
    formulaMark.textContent = "fx";
    formulaMark.setAttribute("aria-hidden", "true");

    input = documentRef.createElement("input");
    input.className = "arFormulaBarInput";
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.style.display = "none";
    input.setAttribute("aria-label", "External Excel formula");
    input.setAttribute("aria-describedby", errorId);

    display = documentRef.createElement("div");
    display.className = "arFormulaBarDisplay";

    errorMessage = documentRef.createElement("div");
    errorMessage.id = errorId;
    errorMessage.className = "arFormulaHoverError";
    errorMessage.setAttribute("role", "alert");
    errorMessage.setAttribute("aria-live", "assertive");
    errorMessage.hidden = true;

    root.appendChild(formulaMark);
    root.appendChild(input);
    root.appendChild(display);
    root.appendChild(errorMessage);
    documentRef.body.appendChild(root);

    root.addEventListener("mouseenter", () => {
      barHovered = true;
      clearHideTimer();
    });
    root.addEventListener("mouseleave", () => {
      barHovered = false;
      scheduleHide();
    });
    // The rendered display is what shows until the formula is being typed into.
    display.addEventListener("mousedown", (event) => {
      if (activeContext?.readOnly) return;
      event.preventDefault();
      setEditing(true);
      input.focus?.({ preventScroll: true });
      input.select?.();
    });
    input.addEventListener("focus", () => {
      clearHideTimer();
      setEditing(true);
      onEditStart(activeContext);
    });
    input.addEventListener("blur", () => {
      setEditing(false);
      scheduleHide();
    });
    input.addEventListener("input", () => {
      clearError();
      reposition();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (activeContext) input.value = activeContext.formula;
        setEditing(false);
        pinnedKey = "";
        hide();
        return;
      }
      if (event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      void commit();
    });

    windowRef?.addEventListener?.("scroll", reposition, true);
    windowRef?.addEventListener?.("resize", handleViewportResize);
    documentRef.addEventListener?.("mousedown", handleDocumentMouseDown);
    return root;
  }

  /** Swap between the rendered formula and the editable input, then re-measure. */
  function setEditing(editing) {
    if (!input || !display) return;
    if (editing) {
      input.style.display = "";
      display.style.display = "none";
    } else {
      input.style.display = "none";
      display.style.display = "";
      renderFormulaDisplay(display, input.value);
    }
    reposition();
  }

  function clearHideTimer() {
    if (!hideTimer) return;
    windowRef.clearTimeout(hideTimer);
    hideTimer = 0;
  }

  function clearError() {
    if (!root || !input || !errorMessage) return;
    root.classList.remove("has-error");
    input.removeAttribute("aria-invalid");
    errorMessage.hidden = true;
    errorMessage.textContent = "";
  }

  function showError(message) {
    if (!root || !input || !errorMessage) return;
    const text = String(message || "The Excel formula could not be loaded.");
    root.classList.add("has-error");
    input.setAttribute("aria-invalid", "true");
    errorMessage.textContent = text;
    errorMessage.hidden = false;
    reposition();
  }

  function setBusy(busy) {
    commitPending = !!busy;
    if (!root || !input) return;
    root.setAttribute("aria-busy", busy ? "true" : "false");
    input.setAttribute("aria-busy", busy ? "true" : "false");
    input.readOnly = !!busy || !!activeContext?.readOnly;
    root.classList.toggle("is-busy", !!busy);
  }

  function contentKey() {
    const editing = !!input && input.style.display !== "none";
    return [
      editing ? "edit" : "display",
      String(errorMessage?.hidden === false ? errorMessage.textContent || "" : ""),
      editing ? String(input?.value || "") : String(display?.textContent || ""),
      // Length-prefixed so no formula text can forge a part boundary.
    ].map((part) => `${part.length}:${part}`).join("|");
  }

  function reposition() {
    if (!root?.classList?.contains("isOpen") || !activeAnchor?.isConnected) return;
    const resolvedPositionRect = typeof activePositionRect === "function"
      ? activePositionRect()
      : activePositionRect;
    const anchorRect = resolvedPositionRect || activeAnchor.getBoundingClientRect?.();
    if (!anchorRect) return;

    const viewportHeight = Number(windowRef?.innerHeight || documentRef.documentElement?.clientHeight || 0);
    const frameEl = getFrameElement();
    const frameBox = frameEl?.getBoundingClientRect?.();
    // The grid bounds the bar horizontally, but not vertically: this editor is a
    // fixed overlay, so a link in the grid's first row still gets its bar above
    // the range rather than flipped underneath it.
    const frame = frameBox
      ? {
        left: frameBox.left,
        right: frameBox.left + Number(frameEl.clientWidth || 0) - FORMULA_BAR_FRAME_INSET_PX,
        top: VIEWPORT_MARGIN_PX,
        bottom: Math.max(VIEWPORT_MARGIN_PX, viewportHeight - VIEWPORT_MARGIN_PX),
      }
      : null;
    // Height is read before measuring: measuring lifts the width clamps, and an
    // error message wraps to a second line, so it has to come from the bar as it
    // currently stands.
    const barHeight = Number(root.getBoundingClientRect?.().height || 0);
    const contentWidth = getFormulaBarContentWidth(root, contentKey(), input);
    const layout = calculateFormulaHoverPosition(
      anchorRect,
      { width: contentWidth, height: barHeight },
      {
        width: Number(windowRef?.innerWidth || documentRef.documentElement?.clientWidth || 0),
        height: Number(windowRef?.innerHeight || documentRef.documentElement?.clientHeight || 0),
      },
      frame,
    );
    if (layout.width > 0) {
      const px = `${layout.width}px`;
      root.style.width = px;
      root.style.minWidth = px;
      root.style.maxWidth = px;
    }
    root.style.left = `${layout.left}px`;
    root.style.top = `${layout.top}px`;
    root.dataset.placement = layout.placement;
  }

  function open(anchor, rawContext, openOptions = {}) {
    const context = normalizedFormulaContext(rawContext);
    if (!anchor?.isConnected || !context || commitPending) return false;
    if (!ensureEditor()) return false;
    clearHideTimer();
    clearError();
    activeAnchor = anchor;
    activePositionRect = openOptions.positionRect || null;
    activeContext = context;
    activeKey = String(openOptions.key || context.reference || context.formula || "");
    input.value = context.formula;
    input.readOnly = !!context.readOnly;
    input.setAttribute("aria-readonly", context.readOnly ? "true" : "false");
    root.classList.add("isOpen");
    root.setAttribute("aria-hidden", "false");
    setEditing(!!openOptions.focus && !context.readOnly);
    reposition();
    if (openOptions.focus) {
      windowRef.requestAnimationFrame?.(() => {
        if (!root?.classList?.contains("isOpen")) return;
        input.focus?.({ preventScroll: true });
        input.select?.();
      });
    }
    return true;
  }

  function hide() {
    if (!root || commitPending) return false;
    const dismissedContext = activeContext;
    const shouldRestoreFocus = documentRef.activeElement === input;
    clearHideTimer();
    root.classList.remove("isOpen", "has-error");
    root.setAttribute("aria-hidden", "true");
    input?.removeAttribute("aria-invalid");
    if (errorMessage) {
      errorMessage.hidden = true;
      errorMessage.textContent = "";
    }
    activeAnchor = null;
    activePositionRect = null;
    activeContext = null;
    activeKey = "";
    barHovered = false;
    if (shouldRestoreFocus) onDismiss(dismissedContext);
    return true;
  }

  function scheduleHide() {
    clearHideTimer();
    if (commitPending) return;
    // A pinned editor stays put until it is clicked away or dismissed.
    if (pinnedKey && pinnedKey === activeKey) return;
    hideTimer = windowRef.setTimeout(() => {
      hideTimer = 0;
      if (barHovered || documentRef.activeElement === input) return;
      if (pinnedKey && pinnedKey === activeKey) return;
      hide();
    }, hideDelayMs);
  }

  /**
   * Clicking the linked cell pins the editor open; clicking it again releases
   * it. Hovering elsewhere still opens the editor transiently.
   */
  function togglePinned(anchor, rawContext, toggleOptions = {}) {
    const context = normalizedFormulaContext(rawContext);
    if (!context) return false;
    const key = String(toggleOptions.key || context.reference || context.formula || "");
    if (pinnedKey && pinnedKey === key) {
      pinnedKey = "";
      hide();
      return true;
    }
    pinnedKey = key;
    return open(anchor, context, { ...toggleOptions, key });
  }

  async function commit() {
    if (!activeContext || !input || commitPending || activeContext.readOnly) return false;
    const formula = String(input.value || "").trim();
    if (!formula) {
      showError("Enter an Excel formula or cell reference.");
      input.focus?.({ preventScroll: true });
      return false;
    }

    const context = activeContext;
    const sequence = ++commitSequence;
    clearError();
    setBusy(true);
    onStatus("Loading linked values from Excel...");
    let result;
    try {
      result = await onCommit({ formula, context });
    } catch (error) {
      result = { ok: false, error: String(error?.message || error) };
    }
    if (sequence !== commitSequence) return false;
    setBusy(false);

    if (result?.ok) {
      pinnedKey = "";
      hide();
      return true;
    }
    if (result?.canceled || result?.aborted || result?.stale) {
      pinnedKey = "";
      hide();
      return false;
    }
    const message = result?.error || "The Excel formula could not be loaded.";
    showError(message);
    onStatus(message);
    windowRef.requestAnimationFrame?.(() => input?.isConnected && input.focus?.({ preventScroll: true }));
    return false;
  }

  function attach(anchor, rawContext, attachOptions = {}) {
    const context = normalizedFormulaContext(rawContext);
    if (!anchor || !context) return false;
    anchor.setAttribute?.(
      "aria-description",
      "Linked to Excel. Hover, click, or press F2 to view the formula.",
    );
    const key = String(context.reference || context.formula || "");
    const openOptions = () => ({
      positionRect: attachOptions.positionRect || null,
      key,
    });
    const resolvedAnchor = () => {
      const resolved = typeof attachOptions.resolveAnchor === "function"
        ? attachOptions.resolveAnchor()
        : null;
      return resolved || anchor;
    };
    anchor.addEventListener?.("mouseenter", () => open(resolvedAnchor(), context, openOptions()));
    anchor.addEventListener?.("mouseleave", scheduleHide);
    anchor.addEventListener?.("click", (event) => {
      if (event?.button) return;
      togglePinned(resolvedAnchor(), context, openOptions());
    });
    return true;
  }

  function destroy() {
    commitSequence += 1;
    commitPending = false;
    pinnedKey = "";
    clearHideTimer();
    invalidateFormulaBarWidthCache();
    windowRef?.removeEventListener?.("scroll", reposition, true);
    windowRef?.removeEventListener?.("resize", handleViewportResize);
    documentRef.removeEventListener?.("mousedown", handleDocumentMouseDown);
    root?.remove?.();
    root = null;
    input = null;
    display = null;
    errorMessage = null;
    activeAnchor = null;
    activePositionRect = null;
    activeContext = null;
    activeKey = "";
  }

  return {
    attach,
    commit,
    destroy,
    hide,
    open,
    reposition,
    togglePinned,
  };
}

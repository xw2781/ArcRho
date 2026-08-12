const FORMULA_HOVER_STYLE_ID = "arcrho-formula-hover-style";
const FORMULA_HOVER_STYLESHEET = "/ui/shared/components/formula_hover/formula_hover.css?v=20260811c";
const DEFAULT_HIDE_DELAY_MS = 140;

let formulaHoverIdSequence = 0;

export function ensureFormulaHoverStyles(documentRef = document) {
  if (!documentRef?.head || documentRef.getElementById?.(FORMULA_HOVER_STYLE_ID)) return;
  const existing = Array.from(documentRef.querySelectorAll?.('link[rel="stylesheet"]') || []).some((link) =>
    String(link.getAttribute?.("href") || link.href || "").includes("/ui/shared/components/formula_hover/formula_hover.css"),
  );
  if (existing) return;
  const link = documentRef.createElement("link");
  link.id = FORMULA_HOVER_STYLE_ID;
  link.rel = "stylesheet";
  link.href = FORMULA_HOVER_STYLESHEET;
  documentRef.head.appendChild(link);
}

export function calculateFormulaHoverPosition(anchorRect, hoverRect, viewport = {}) {
  const margin = 8;
  const gap = 5;
  const viewportWidth = Math.max(0, Number(viewport.width) || 0);
  const viewportHeight = Math.max(0, Number(viewport.height) || 0);
  const hoverWidth = Math.max(0, Number(hoverRect?.width) || 0);
  const hoverHeight = Math.max(0, Number(hoverRect?.height) || 0);
  const anchorLeft = Number(anchorRect?.left) || 0;
  const anchorTop = Number(anchorRect?.top) || 0;
  const anchorBottom = Number(anchorRect?.bottom) || anchorTop;

  let left = anchorLeft;
  if (viewportWidth > 0) {
    left = Math.max(margin, Math.min(left, viewportWidth - hoverWidth - margin));
  }

  const aboveTop = anchorTop - hoverHeight - gap;
  const belowTop = anchorBottom + gap;
  const aboveFits = aboveTop >= margin;
  const belowFits = viewportHeight <= 0 || belowTop + hoverHeight <= viewportHeight - margin;
  let top = aboveTop;
  let placement = "above";
  if (!aboveFits && belowFits) {
    top = belowTop;
    placement = "below";
  } else if (!aboveFits && !belowFits) {
    const roomAbove = Math.max(0, anchorTop - margin);
    const roomBelow = Math.max(0, viewportHeight - margin - anchorBottom);
    if (roomBelow > roomAbove) {
      top = belowTop;
      placement = "below";
    }
  }

  return {
    left: Math.round(left),
    top: Math.round(top),
    placement,
  };
}

function normalizedFormulaContext(rawContext) {
  if (!rawContext || typeof rawContext !== "object") return null;
  const formula = String(rawContext.formula ?? rawContext.reference ?? "").trim();
  if (!formula) return null;
  return { ...rawContext, formula };
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
  const hideDelayMs = Number.isFinite(Number(options.hideDelayMs))
    ? Math.max(0, Number(options.hideDelayMs))
    : DEFAULT_HIDE_DELAY_MS;

  let root = null;
  let input = null;
  let errorMessage = null;
  let activeAnchor = null;
  let activePositionRect = null;
  let activeContext = null;
  let hideTimer = 0;
  let barHovered = false;
  let commitPending = false;
  let commitSequence = 0;

  function handleDocumentMouseDown(event) {
    if (!root?.classList?.contains("is-open") || commitPending) return;
    if (root.contains?.(event.target) || activeAnchor?.contains?.(event.target)) return;
    hide();
  }

  function ensureEditor() {
    if (root?.isConnected) return root;
    if (!documentRef?.body) return null;
    ensureFormulaHoverStyles(documentRef);

    formulaHoverIdSequence += 1;
    const errorId = `arFormulaHoverError-${formulaHoverIdSequence}`;

    root = documentRef.createElement("div");
    root.className = "arFormulaHover";
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", "External Excel formula");
    root.setAttribute("aria-hidden", "true");
    root.setAttribute("aria-busy", "false");

    const editorRow = documentRef.createElement("div");
    editorRow.className = "arFormulaHoverRow";
    const formulaMark = documentRef.createElement("span");
    formulaMark.className = "arFormulaHoverMark";
    formulaMark.textContent = "fx";
    formulaMark.setAttribute("aria-hidden", "true");

    input = documentRef.createElement("input");
    input.className = "arFormulaHoverInput";
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", "External Excel formula");
    input.setAttribute("aria-describedby", errorId);

    errorMessage = documentRef.createElement("div");
    errorMessage.id = errorId;
    errorMessage.className = "arFormulaHoverError";
    errorMessage.setAttribute("role", "alert");
    errorMessage.setAttribute("aria-live", "assertive");
    errorMessage.hidden = true;

    editorRow.appendChild(formulaMark);
    editorRow.appendChild(input);
    root.appendChild(editorRow);
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
    input.addEventListener("focus", () => {
      clearHideTimer();
      onEditStart(activeContext);
    });
    input.addEventListener("blur", scheduleHide);
    input.addEventListener("input", clearError);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (activeContext) input.value = activeContext.formula;
        hide();
        return;
      }
      if (event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      void commit();
    });

    windowRef?.addEventListener?.("scroll", reposition, true);
    windowRef?.addEventListener?.("resize", reposition);
    documentRef.addEventListener?.("mousedown", handleDocumentMouseDown);
    return root;
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

  function reposition() {
    if (!root?.classList?.contains("is-open") || !activeAnchor?.isConnected) return;
    const resolvedPositionRect = typeof activePositionRect === "function"
      ? activePositionRect()
      : activePositionRect;
    const anchorRect = resolvedPositionRect || activeAnchor.getBoundingClientRect?.();
    if (!anchorRect) return;
    const hoverRect = root.getBoundingClientRect?.() || { width: 0, height: 0 };
    const position = calculateFormulaHoverPosition(anchorRect, hoverRect, {
      width: Number(windowRef?.innerWidth || documentRef.documentElement?.clientWidth || 0),
      height: Number(windowRef?.innerHeight || documentRef.documentElement?.clientHeight || 0),
    });
    root.style.left = `${position.left}px`;
    root.style.top = `${position.top}px`;
    root.dataset.placement = position.placement;
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
    input.value = context.formula;
    input.readOnly = !!context.readOnly;
    input.setAttribute("aria-readonly", context.readOnly ? "true" : "false");
    root.classList.add("is-open");
    root.setAttribute("aria-hidden", "false");
    reposition();
    if (openOptions.focus) {
      windowRef.requestAnimationFrame?.(() => {
        if (!root?.classList?.contains("is-open")) return;
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
    root.classList.remove("is-open", "has-error");
    root.setAttribute("aria-hidden", "true");
    input?.removeAttribute("aria-invalid");
    if (errorMessage) {
      errorMessage.hidden = true;
      errorMessage.textContent = "";
    }
    activeAnchor = null;
    activePositionRect = null;
    activeContext = null;
    barHovered = false;
    if (shouldRestoreFocus) onDismiss(dismissedContext);
    return true;
  }

  function scheduleHide() {
    clearHideTimer();
    if (commitPending) return;
    hideTimer = windowRef.setTimeout(() => {
      hideTimer = 0;
      if (barHovered || documentRef.activeElement === input) return;
      hide();
    }, hideDelayMs);
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
      hide();
      return true;
    }
    if (result?.canceled || result?.aborted || result?.stale) {
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
    anchor.setAttribute?.("aria-description", "Linked to Excel. Hover or press F2 to view the formula.");
    anchor.addEventListener?.("mouseenter", () => {
      const resolvedAnchor = typeof attachOptions.resolveAnchor === "function"
        ? attachOptions.resolveAnchor()
        : null;
      open(resolvedAnchor || anchor, context, {
        positionRect: attachOptions.positionRect || null,
      });
    });
    anchor.addEventListener?.("mouseleave", scheduleHide);
    return true;
  }

  function destroy() {
    commitSequence += 1;
    commitPending = false;
    clearHideTimer();
    windowRef?.removeEventListener?.("scroll", reposition, true);
    windowRef?.removeEventListener?.("resize", reposition);
    documentRef.removeEventListener?.("mousedown", handleDocumentMouseDown);
    root?.remove?.();
    root = null;
    input = null;
    errorMessage = null;
    activeAnchor = null;
    activePositionRect = null;
    activeContext = null;
  }

  return {
    attach,
    commit,
    destroy,
    hide,
    open,
    reposition,
  };
}

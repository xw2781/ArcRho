const activeValidationLeases = new WeakMap();
let nextValidationLeaseId = 1;

export const DFM_FORMULA_VALIDATION_TIMEOUT_MS = 30000;

function addDescriptionId(inputEl, descriptionId) {
  if (!inputEl?.setAttribute || !descriptionId) return;
  const ids = String(inputEl.getAttribute?.("aria-describedby") || "")
    .split(/\s+/)
    .filter(Boolean);
  if (!ids.includes(descriptionId)) ids.push(descriptionId);
  inputEl.setAttribute("aria-describedby", ids.join(" "));
}

function removeDescriptionId(inputEl, descriptionId) {
  if (!inputEl?.removeAttribute || !descriptionId) return;
  const ids = String(inputEl.getAttribute?.("aria-describedby") || "")
    .split(/\s+/)
    .filter((id) => id && id !== descriptionId);
  if (ids.length) inputEl.setAttribute?.("aria-describedby", ids.join(" "));
  else inputEl.removeAttribute("aria-describedby");
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function rectNumber(rect, key, fallback = 0) {
  const value = Number(rect?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

export function computeFormulaValidationTooltipLayout({
  barRect,
  anchorRect,
  hostRect,
  tooltipRect,
  viewportWidth,
  viewportHeight,
  gap = 6,
  margin = 8,
  preferredMaxWidth = 520,
} = {}) {
  const width = Math.max(0, Number(viewportWidth) || 0);
  const height = Math.max(0, Number(viewportHeight) || 0);
  const safeMargin = Math.max(0, Number(margin) || 0);
  const safeGap = Math.max(0, Number(gap) || 0);
  const barLeft = rectNumber(barRect, "left");
  const barTop = rectNumber(barRect, "top");
  const barRight = rectNumber(barRect, "right", barLeft + rectNumber(barRect, "width"));
  const barBottom = rectNumber(barRect, "bottom", barTop + rectNumber(barRect, "height"));
  const hostLeft = rectNumber(hostRect, "left");
  const hostTop = rectNumber(hostRect, "top");
  const hostRight = rectNumber(hostRect, "right", width);
  const hostBottom = rectNumber(hostRect, "bottom", height);
  const boundsLeft = Math.max(safeMargin, hostLeft + safeMargin);
  const boundsRight = Math.max(
    boundsLeft,
    Math.min(Math.max(safeMargin, width - safeMargin), hostRight - safeMargin),
  );
  const maxWidth = Math.max(
    1,
    Math.min(Math.max(1, Number(preferredMaxWidth) || 1), boundsRight - boundsLeft),
  );
  const tooltipWidth = Math.min(maxWidth, Math.max(0, rectNumber(tooltipRect, "width")));
  const tooltipHeight = Math.max(0, rectNumber(tooltipRect, "height"));
  const anchorLeft = rectNumber(anchorRect, "left", barLeft);
  const anchorWidth = Math.max(0, rectNumber(anchorRect, "width", barRight - barLeft));
  const anchorX = clamp(anchorLeft + Math.min(28, anchorWidth / 2), boundsLeft, boundsRight);
  const maxLeft = Math.max(boundsLeft, boundsRight - tooltipWidth);
  const left = clamp(anchorX - 24, boundsLeft, maxLeft);
  const aboveTop = barTop - tooltipHeight - safeGap;
  const belowTop = barBottom + safeGap;
  const maxTop = Math.max(safeMargin, height - safeMargin - tooltipHeight);
  let placement = "above";
  let top = aboveTop;
  if (aboveTop < safeMargin && belowTop + tooltipHeight <= height - safeMargin) {
    placement = "below";
    top = belowTop;
  } else {
    top = clamp(aboveTop, safeMargin, maxTop);
  }
  const arrowInset = Math.min(10, tooltipWidth / 2);
  const arrowX = clamp(
    anchorX - left,
    arrowInset,
    Math.max(arrowInset, tooltipWidth - arrowInset),
  );
  const visible = width > 0
    && height > 0
    && hostRight > hostLeft
    && hostBottom > hostTop
    && hostRight > 0
    && hostLeft < width
    && hostBottom > 0
    && hostTop < height
    && barRight > barLeft
    && barBottom > barTop
    && tooltipWidth > 0
    && tooltipHeight > 0
    && boundsRight > boundsLeft
    && barRight > 0
    && barLeft < width
    && barBottom > 0
    && barTop < height
    && barRight > hostLeft
    && barLeft < hostRight
    && barBottom > hostTop
    && barTop < hostBottom;

  return { left, top, maxWidth, arrowX, placement, visible };
}

export function showFormulaValidationError({ barEl, inputEl, errorEl, message }) {
  const text = String(message || "Formula validation failed.").trim();
  if (barEl?.classList) barEl.classList.add("hasValidationError");
  if (inputEl?.setAttribute) {
    inputEl.setAttribute("aria-invalid", "true");
    addDescriptionId(inputEl, errorEl?.id);
  }
  if (errorEl) {
    errorEl.textContent = text;
    errorEl.hidden = false;
  }
  return text;
}

export function clearFormulaValidationError({ barEl, inputEl, errorEl }) {
  if (barEl?.classList) barEl.classList.remove("hasValidationError");
  if (inputEl?.removeAttribute) {
    inputEl.removeAttribute("aria-invalid");
    if (errorEl?.id) removeDescriptionId(inputEl, errorEl.id);
  }
  if (errorEl) {
    errorEl.textContent = "";
    errorEl.hidden = true;
  }
}

export function revealAndFocusFormulaInput({
  inputEl,
  displayEl,
  selectionStart,
  selectionEnd,
  preventScroll = true,
} = {}) {
  if (!inputEl || inputEl.isConnected === false) return false;
  inputEl.style.display = "";
  if (displayEl) displayEl.style.display = "none";
  inputEl.focus?.({ preventScroll });

  const valueLength = String(inputEl.value || "").length;
  const start = Math.max(0, Math.min(valueLength, Number.isInteger(selectionStart) ? selectionStart : valueLength));
  const end = Math.max(start, Math.min(valueLength, Number.isInteger(selectionEnd) ? selectionEnd : start));
  inputEl.setSelectionRange?.(start, end);
  return true;
}

export function beginFormulaValidationLease(inputEl, {
  timeoutMs = DFM_FORMULA_VALIDATION_TIMEOUT_MS,
} = {}) {
  if (!inputEl) throw new TypeError("Formula validation requires an input element.");

  const previous = activeValidationLeases.get(inputEl);
  previous?.cancel?.();

  const controller = new AbortController();
  const leaseId = nextValidationLeaseId++;
  const previousReadOnly = !!inputEl.readOnly;
  let timedOut = false;
  let finished = false;

  inputEl.dataset.formulaCommitPending = "1";
  inputEl.readOnly = true;
  inputEl.setAttribute?.("aria-busy", "true");

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, Number(timeoutMs) || DFM_FORMULA_VALIDATION_TIMEOUT_MS));

  const finish = ({ abort = false } = {}) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutId);
    if (abort && !controller.signal.aborted) controller.abort();
    if (activeValidationLeases.get(inputEl)?.id !== leaseId) return;
    activeValidationLeases.delete(inputEl);
    inputEl.readOnly = previousReadOnly;
    delete inputEl.dataset.formulaCommitPending;
    inputEl.removeAttribute?.("aria-busy");
  };

  const lease = {
    id: leaseId,
    inputEl,
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    finish,
    cancel() {
      finish({ abort: true });
    },
  };
  activeValidationLeases.set(inputEl, lease);
  return lease;
}

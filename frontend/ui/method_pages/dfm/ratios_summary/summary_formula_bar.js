/*
===============================================================================
DFM Ratios Summary Formula Bar
===============================================================================
*/
import {
  registerSummaryFunctions,
  summaryRuntime,
} from "/ui/method_pages/dfm/ratios_summary/summary_runtime.js?v=20260726b";

const {
  state, calcRatio, roundRatio, formatRatio, computeAverageForColumn,
  ratioStrikeSet, selectedSummaryByCol, summaryRowConfigs, summaryRowMap, BASE_SUMMARY_ROWS,
  getShowNaBorders, getRatioSummaryRaf, setRatioSummaryRaf,
  getLastSummaryCtxRowId, setLastSummaryCtxRowId,
  getEffectiveDevLabelsForModel, getRatioHeaderLabels, buildSummaryRows,
  buildExcludedSetForColumn, parsePeriodsValue, parseExcludeValue, getDfmDecimalPlaces,
  getSummaryConfigKey, loadCustomSummaryRows, saveCustomSummaryRows,
  getExcelActiveSelection, readExcelCell, readExcelCellsBatch, openExcelWorkbook, excelWaitForEnter,
  buildExcelRangeSourceCells, containsExcelRef, excelColumnFromIndex, findExcelRefsInline,
  formatExcelRef, normalizeExcelReferenceAddressCase, parseStandaloneExcelRange,
  collectDfmExternalLinkGroupsModel, getDfmExternalLinkHardCodeTargets, getDfmExternalLinkRangeTargets,
  DFM_FORMULA_VALIDATION_TIMEOUT_MS, beginFormulaValidationLease, clearFormulaValidationError,
  computeFormulaValidationTooltipLayout, revealAndFocusFormulaInput, showFormulaValidationError,
  wireSelectableTable, openDfmSummaryPlotWindow, hasDfmCellNote, showDfmCellNoteEditor,
  beginRatioHistoryAction, commitRatioHistoryAction,
} = summaryRuntime;

const updateActiveSummaryFormulaReferenceUi = (...args) => summaryRuntime.updateActiveSummaryFormulaReferenceUi(...args);
const refreshAllExcelLinks = (...args) => summaryRuntime.refreshAllExcelLinks(...args);
const isSummaryFormulaCommitPending = (...args) => summaryRuntime.isSummaryFormulaCommitPending(...args);
const commitSummaryFormulaInput = (...args) => summaryRuntime.commitSummaryFormulaInput(...args);
const updateSummaryFormulaBarForCell = (...args) => summaryRuntime.updateSummaryFormulaBarForCell(...args);
const refreshSummaryFormulaBar = (...args) => summaryRuntime.refreshSummaryFormulaBar(...args);
const beginSummaryFormulaEditSession = (...args) => summaryRuntime.beginSummaryFormulaEditSession(...args);
const cancelSummaryFormulaEditSession = (...args) => summaryRuntime.cancelSummaryFormulaEditSession(...args);

function scrollSummaryFormulaInputToEnd(inputEl) {
  if (!inputEl) return;
  window.requestAnimationFrame(() => {
    try {
      inputEl.scrollLeft = inputEl.scrollWidth;
    } catch (_err) {
      // no-op: some browsers may not expose scroll metrics on detached inputs
    }
  });
}

/**
 * Tokenise a formula string into typed segments.
 * Recognises Excel refs, quoted row references, operators, and plain text.
 */
function tokenizeFormula(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return [];

  // Ensure leading '='
  let remaining = text.startsWith("=") ? text : "=" + text;
  const tokens = [];

  while (remaining.length > 0) {
    // Excel ref: 'dir\[file.xlsx]Sheet'!A1 or a range such as ...!A1:C3
    const xlMatch = /^'([^[]*)\[([^\]]+)\]([^'!]+)'!\$?[A-Z]+\$?[0-9]+(?::\$?[A-Z]+\$?[0-9]+)?/i.exec(remaining);
    if (xlMatch) {
      tokens.push({ type: "excel", text: xlMatch[0] });
      remaining = remaining.slice(xlMatch[0].length);
      continue;
    }
    // Quoted row reference: "Some Label" or 'Some Label'
    const quotedMatch = /^(["'])(.+?)\1/.exec(remaining);
    if (quotedMatch) {
      tokens.push({ type: "ref", text: quotedMatch[0] });
      remaining = remaining.slice(quotedMatch[0].length);
      continue;
    }
    // Operator
    const opMatch = /^[+\-*/]/.exec(remaining);
    if (opMatch) {
      tokens.push({ type: "op", text: opMatch[0] });
      remaining = remaining.slice(1);
      continue;
    }
    // Plain text (one char at a time)
    tokens.push({ type: "plain", text: remaining[0] });
    remaining = remaining.slice(1);
  }

  // Merge consecutive plain tokens
  const merged = [];
  for (const tok of tokens) {
    if (tok.type === "plain" && merged.length > 0 && merged[merged.length - 1].type === "plain") {
      merged[merged.length - 1].text += tok.text;
    } else {
      merged.push({ ...tok });
    }
  }
  return merged;
}

/**
 * Format a raw formula string with proper spacing around operators
 * and ensure leading '='. Does not alter content inside Excel refs
 * or quoted references.
 */
function formatFormulaText(rawText) {
  const tokens = tokenizeFormula(rawText);
  if (!tokens.length) return String(rawText || "").trim();
  let out = "";
  for (const tok of tokens) {
    if (tok.type === "op") {
      out = out.replace(/\s+$/, "");
      out += " " + tok.text + " ";
    } else if (tok.type === "plain") {
      out += tok.text.trim();
    } else {
      out += tok.text;
    }
  }
  const formatted = out.replace(/\s+$/, "");
  if (formatted.startsWith("=")) return `= ${formatted.slice(1).trimStart()}`;
  return formatted;
}

/**
 * Render colorized formula display in the overlay div.
 * - Excel refs → dark green
 * - Quoted row references → blue
 * - Operators get spaces around them
 * - Always shows leading '='
 */
function renderFormulaBarDisplay(displayEl, rawText) {
  if (!displayEl) return;
  const tokens = tokenizeFormula(rawText);
  if (!tokens.length) {
    displayEl.textContent = "";
    return;
  }

  displayEl.innerHTML = "";
  for (const tok of tokens) {
    if (tok.type === "excel") {
      const span = document.createElement("span");
      span.className = "fmtExcelRef";
      span.textContent = tok.text;
      displayEl.appendChild(span);
    } else if (tok.type === "ref") {
      const span = document.createElement("span");
      span.className = "fmtRowRef";
      span.textContent = tok.text;
      displayEl.appendChild(span);
    } else if (tok.type === "op") {
      displayEl.appendChild(document.createTextNode(" " + tok.text + " "));
    } else {
      const t = tok.text.trim();
      if (t) displayEl.appendChild(document.createTextNode(t));
    }
  }
}

/** Show/hide display overlay vs input based on focus state. */
function updateFormulaBarDisplayMode(barEl, isEditing) {
  if (!barEl) return;
  const input = barEl.querySelector("#dfmSummaryFormulaBarInput");
  const display = barEl.querySelector("#dfmSummaryFormulaBarDisplay");
  if (!input || !display) return;
  if (isEditing) {
    input.style.display = "";
    display.style.display = "none";
  } else {
    // Format the raw input with proper spacing and leading '='
    const raw = String(input.value || "").trim();
    if (raw) {
      input.value = formatFormulaText(raw);
    }
    input.style.display = "none";
    display.style.display = "";
    renderFormulaBarDisplay(display, input.value);
  }
}

function syncSummaryFormulaBarWidth(barEl, summaryTable) {
  if (!barEl || !summaryTable) return;
  const host = summaryTable.closest("#ratioWrapHost") || document.getElementById("ratioWrapHost");
  const hostWidth = Number(host?.clientWidth || 0);
  const tableWidth = Number(summaryTable.getBoundingClientRect?.().width || 0);
  const frameWidth = Math.max(0, Math.ceil(tableWidth || hostWidth));
  if (!frameWidth) return;
  const viewportWidth = Math.max(0, Math.ceil(Math.min(frameWidth, hostWidth || frameWidth)));
  const contentWidth = Math.max(0, viewportWidth - summaryRuntime.SUMMARY_FORMULA_BAR_FRAME_INSET_PX);
  const contentOffset = Math.min(
    Math.max(0, Number(host?.scrollLeft || 0)),
    Math.max(0, frameWidth - contentWidth)
  );
  const px = `${frameWidth}px`;
  barEl.style.width = px;
  barEl.style.minWidth = px;
  barEl.style.maxWidth = px;
  barEl.style.setProperty(
    "--dfm-summary-formula-bar-content-width",
    `${contentWidth}px`
  );
  barEl.style.setProperty(
    "--dfm-summary-formula-bar-content-x",
    `${contentOffset}px`
  );
  scheduleSummaryFormulaBarValidationTooltipPosition();
}

function positionSummaryFormulaBarValidationTooltip() {
  const { bar, input, display, error } = getSummaryFormulaBarParts();
  if (!bar || !error || error.hidden) return;

  error.style.visibility = "hidden";
  const host = bar.closest?.("#ratioWrapHost") || document.getElementById("ratioWrapHost");
  const ratiosPage = document.getElementById("dfmRatiosPage");
  if (
    !host
    || !bar.isConnected
    || !bar.classList.contains("fxVisible")
    || ratiosPage?.getClientRects?.().length === 0
  ) return;

  const popout = bar.closest?.(".tabPopoutWindow");
  const computedPopoutZ = popout ? window.getComputedStyle?.(popout)?.zIndex : "";
  const popoutZ = Number.parseInt(
    popout?.style?.zIndex || computedPopoutZ || "",
    10,
  );
  const tooltipZ = Number.isFinite(popoutZ)
    ? Math.min(summaryRuntime.SUMMARY_FORMULA_BAR_TOOLTIP_MAX_Z_INDEX, popoutZ + 1)
    : summaryRuntime.SUMMARY_FORMULA_BAR_TOOLTIP_Z_INDEX;
  error.style.zIndex = String(tooltipZ);

  const barRect = bar.getBoundingClientRect();
  const anchorEl = input?.getClientRects?.().length ? input : display;
  const anchorRect = anchorEl?.getBoundingClientRect?.() || barRect;
  const hostRect = host.getBoundingClientRect();
  const viewportWidth = Math.max(0, Number(window.innerWidth || document.documentElement?.clientWidth || 0));
  const viewportHeight = Math.max(0, Number(window.innerHeight || document.documentElement?.clientHeight || 0));
  const layoutInput = { barRect, anchorRect, hostRect, viewportWidth, viewportHeight };
  const widthLayout = computeFormulaValidationTooltipLayout({
    ...layoutInput,
    tooltipRect: { width: 0, height: 0 },
  });
  error.style.maxWidth = `${widthLayout.maxWidth}px`;

  const layout = computeFormulaValidationTooltipLayout({
    ...layoutInput,
    tooltipRect: error.getBoundingClientRect(),
  });
  error.style.left = `${Math.round(layout.left)}px`;
  error.style.top = `${Math.round(layout.top)}px`;
  error.style.setProperty("--dfm-summary-formula-tooltip-arrow-x", `${Math.round(layout.arrowX)}px`);
  error.dataset.placement = layout.placement;
  error.style.visibility = layout.visible ? "visible" : "hidden";
}

function scheduleSummaryFormulaBarValidationTooltipPosition() {
  const error = document.getElementById("dfmSummaryFormulaBarError");
  if (!error || error.hidden || summaryRuntime.formulaBarTooltipRaf) return;
  summaryRuntime.formulaBarTooltipRaf = window.requestAnimationFrame(() => {
    summaryRuntime.formulaBarTooltipRaf = 0;
    positionSummaryFormulaBarValidationTooltip();
  });
}

function scheduleSummaryFormulaBarResizeRefresh() {
  if (summaryRuntime.formulaBarResizeRaf) return;
  summaryRuntime.formulaBarResizeRaf = window.requestAnimationFrame(() => {
    summaryRuntime.formulaBarResizeRaf = 0;
    refreshSummaryFormulaBar();
    scheduleSummaryFormulaBarValidationTooltipPosition();
  });
}

function wireSummaryFormulaBarResizeWatcher(summaryTable) {
  const host = summaryTable?.closest?.("#ratioWrapHost") || document.getElementById("ratioWrapHost");
  if (summaryRuntime.formulaBarScrollHost && summaryRuntime.formulaBarScrollHost !== host) {
    summaryRuntime.formulaBarScrollHost.removeEventListener("scroll", scheduleSummaryFormulaBarResizeRefresh);
    summaryRuntime.formulaBarScrollHost = null;
  }
  if (host && summaryRuntime.formulaBarScrollHost !== host) {
    host.addEventListener("scroll", scheduleSummaryFormulaBarResizeRefresh, { passive: true });
    summaryRuntime.formulaBarScrollHost = host;
  }
  if (host && window.ResizeObserver) {
    if (summaryRuntime.formulaBarResizeObserver?.target !== host) {
      summaryRuntime.formulaBarResizeObserver?.observer?.disconnect?.();
      const observer = new ResizeObserver(scheduleSummaryFormulaBarResizeRefresh);
      observer.observe(host);
      summaryRuntime.formulaBarResizeObserver = { observer, target: host };
    }
  }
  if (!summaryRuntime.formulaBarResizeWired) {
    summaryRuntime.formulaBarResizeWired = true;
    window.addEventListener("resize", scheduleSummaryFormulaBarResizeRefresh);
    window.addEventListener(
      "pointerdown",
      scheduleSummaryFormulaBarValidationTooltipPosition,
      { capture: true, passive: true },
    );
  }
}

function getSummaryFormulaBarParts(barEl = null) {
  const bar = barEl || document.getElementById("dfmSummaryFormulaBar");
  return {
    bar,
    input: bar?.querySelector?.("#dfmSummaryFormulaBarInput") || null,
    display: bar?.querySelector?.("#dfmSummaryFormulaBarDisplay") || null,
    error: bar?.querySelector?.("#dfmSummaryFormulaBarError")
      || document.getElementById("dfmSummaryFormulaBarError")
      || null,
    state: bar?.querySelector?.("#dfmSummaryFormulaBarState") || null,
  };
}

function clearSummaryFormulaBarValidationError() {
  const { bar, input, error } = getSummaryFormulaBarParts();
  if (summaryRuntime.formulaValidationErrorInput && summaryRuntime.formulaValidationErrorInput !== input) {
    clearFormulaValidationError({ inputEl: summaryRuntime.formulaValidationErrorInput, errorEl: error });
  }
  clearFormulaValidationError({
    barEl: bar,
    inputEl: summaryRuntime.formulaValidationErrorInput || input,
    errorEl: error,
  });
  summaryRuntime.formulaValidationErrorInput = null;
}

function showSummaryFormulaBarValidationError(message, inputEl = null) {
  const { bar, input, error } = getSummaryFormulaBarParts();
  const targetInput = inputEl || input;
  if (summaryRuntime.formulaValidationErrorInput && summaryRuntime.formulaValidationErrorInput !== targetInput) {
    clearFormulaValidationError({ inputEl: summaryRuntime.formulaValidationErrorInput, errorEl: error });
  }
  const text = showFormulaValidationError({
    barEl: bar,
    inputEl: targetInput,
    errorEl: error,
    message,
  });
  summaryRuntime.formulaValidationErrorInput = targetInput;
  positionSummaryFormulaBarValidationTooltip();
  scheduleSummaryFormulaBarValidationTooltipPosition();
  return text;
}

function cancelFormulaBarDisplayRefresh() {
  if (!summaryRuntime.summaryFormulaBarDisplayRaf) return;
  window.cancelAnimationFrame(summaryRuntime.summaryFormulaBarDisplayRaf);
  summaryRuntime.summaryFormulaBarDisplayRaf = 0;
}

function clearFormulaBarFocusRestoreHandler() {
  if (!summaryRuntime.summaryFormulaBarFocusRestoreHandler) return;
  window.removeEventListener("focus", summaryRuntime.summaryFormulaBarFocusRestoreHandler);
  summaryRuntime.summaryFormulaBarFocusRestoreHandler = null;
}

function isSummaryFormulaBarInputEditing(inputEl) {
  return !!(
    inputEl &&
    inputEl.isConnected &&
    summaryRuntime.summaryFormulaBarState.input === inputEl &&
    summaryRuntime.summaryFormulaBarState.mode !== "display"
  );
}

function setSummaryFormulaBarMode(mode, inputEl = null) {
  const nextMode = mode === "validating" ? "validating" : (mode === "editing" ? "editing" : "display");
  const currentInput = inputEl || getSummaryFormulaBarParts().input;
  summaryRuntime.summaryFormulaBarState = {
    mode: nextMode,
    input: nextMode === "display" ? null : currentInput,
    generation: summaryRuntime.summaryFormulaBarState.generation + 1,
  };
  const { bar, state } = getSummaryFormulaBarParts(currentInput?.closest?.(".dfmSummaryFormulaBar"));
  bar?.classList?.toggle("isValidating", nextMode === "validating");
  if (state) {
    state.hidden = nextMode !== "validating";
    state.textContent = nextMode === "validating" ? "Validating…" : "";
  }
}

function setFormulaBarCommitControlsDisabled(inputEl, disabled, leaseId = null) {
  const bar = inputEl?.closest?.(".dfmSummaryFormulaBar");
  if (!bar) return;
  [
    "#dfmSummaryFormulaBarXlLink",
    "#dfmSummaryFormulaBarRefresh",
    "#dfmSummaryFormulaBarOpenXl",
  ].forEach((selector) => {
    const button = bar.querySelector(selector);
    if (!button) return;
    if (disabled) {
      if (!button.disabled) button.dataset.disabledByFormulaValidation = "1";
      button.dataset.formulaValidationLease = String(leaseId ?? "");
      button.disabled = true;
    } else if (
      leaseId === null ||
      button.dataset.formulaValidationLease === String(leaseId)
    ) {
      delete button.dataset.formulaValidationLease;
      if (button.dataset.disabledByFormulaValidation !== "1") return;
      delete button.dataset.disabledByFormulaValidation;
      button.disabled = false;
    }
  });
}

function scheduleFormulaBarDisplayMode(barEl, inputEl) {
  cancelFormulaBarDisplayRefresh();
  const generation = summaryRuntime.summaryFormulaBarState.generation;
  summaryRuntime.summaryFormulaBarDisplayRaf = window.requestAnimationFrame(() => {
    summaryRuntime.summaryFormulaBarDisplayRaf = 0;
    if (generation !== summaryRuntime.summaryFormulaBarState.generation) return;
    const { bar, input } = getSummaryFormulaBarParts(barEl);
    if (!bar || !input || input !== inputEl || !input.isConnected) return;
    updateFormulaBarDisplayMode(bar, isSummaryFormulaBarInputEditing(input));
  });
}

function captureFormulaInputSelection(inputEl) {
  const valueLength = String(inputEl?.value || "").length;
  const start = Number.isInteger(inputEl?.selectionStart) ? inputEl.selectionStart : valueLength;
  const end = Number.isInteger(inputEl?.selectionEnd) ? inputEl.selectionEnd : start;
  return {
    selectionStart: Math.max(2, start),
    selectionEnd: Math.max(2, end),
  };
}

function restoreFormulaBarEditingAfterValidation(barEl, inputEl, selection = {}) {
  cancelFormulaBarDisplayRefresh();
  clearFormulaBarFocusRestoreHandler();
  const { bar, input, display } = getSummaryFormulaBarParts(barEl);
  if (!bar || !input || input !== inputEl || !input.isConnected) return;
  setSummaryFormulaBarMode("editing", input);
  updateFormulaBarDisplayMode(bar, true);

  const restore = () => {
    summaryRuntime.summaryFormulaBarFocusRestoreHandler = null;
    if (!isSummaryFormulaBarInputEditing(input) || !input.isConnected) return;
    revealAndFocusFormulaInput({
      inputEl: input,
      displayEl: display,
      selectionStart: selection.selectionStart,
      selectionEnd: selection.selectionEnd,
    });
  };

  if (document.hasFocus()) {
    window.requestAnimationFrame(restore);
  } else {
    summaryRuntime.summaryFormulaBarFocusRestoreHandler = restore;
    window.addEventListener("focus", restore, { once: true });
  }
}

function cancelActiveSummaryFormulaCommit() {
  summaryRuntime.summaryFormulaCommitGeneration += 1;
  const lease = summaryRuntime.summaryFormulaCommitLease;
  lease?.cancel?.();
  if (lease?.inputEl) setFormulaBarCommitControlsDisabled(lease.inputEl, false, lease.id);
  summaryRuntime.summaryFormulaCommitLease = null;
}

function ensureSummaryFormulaBarValidationTooltip() {
  let error = document.getElementById("dfmSummaryFormulaBarError");
  if (!error) {
    error = document.createElement("div");
    error.id = "dfmSummaryFormulaBarError";
    error.className = "dfmSummaryFormulaBarError";
    error.setAttribute("role", "alert");
    error.setAttribute("aria-live", "assertive");
    error.setAttribute("aria-atomic", "true");
    error.hidden = true;
  }
  if (document.body && error.parentElement !== document.body) {
    document.body.appendChild(error);
  }
  return error;
}

function ensureSummaryFormulaBarEl(summaryTable) {
  ensureSummaryFormulaBarValidationTooltip();
  let el = document.getElementById("dfmSummaryFormulaBar");
  if (!el) {
    el = document.createElement("div");
    el.id = "dfmSummaryFormulaBar";
    el.className = "dfmSummaryFormulaBar";
    const fxIcon = document.createElement("span");
    fxIcon.className = "dfmSummaryFormulaBarFxIcon";
    fxIcon.textContent = "fx";
    fxIcon.title = "Formula Bar";
    const label = document.createElement("span");
    label.id = "dfmSummaryFormulaBarLabelText";
    label.className = "dfmSummaryFormulaBarLabel";
    label.textContent = "f(x)";
    const input = document.createElement("input");
    input.id = "dfmSummaryFormulaBarInput";
    input.className = "dfmSummaryFormulaBarInput";
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    const xlBtn = document.createElement("button");
    xlBtn.id = "dfmSummaryFormulaBarXlLink";
    xlBtn.className = "dfmSummaryFormulaBarXlBtn";
    xlBtn.title = "Link to Excel cell";
    xlBtn.textContent = "XL";
    xlBtn.type = "button";
    const refreshBtn = document.createElement("button");
    refreshBtn.id = "dfmSummaryFormulaBarRefresh";
    refreshBtn.className = "dfmSummaryFormulaBarRefreshBtn";
    refreshBtn.title = "Refresh all Excel-linked values";
    refreshBtn.textContent = "\u21BB";
    refreshBtn.type = "button";
    const openBtn = document.createElement("button");
    openBtn.id = "dfmSummaryFormulaBarOpenXl";
    openBtn.className = "dfmSummaryFormulaBarOpenBtn";
    openBtn.title = "Open source workbook in Excel";
    openBtn.textContent = "\uD83D\uDCC2";
    openBtn.type = "button";
    const display = document.createElement("div");
    display.id = "dfmSummaryFormulaBarDisplay";
    display.className = "dfmSummaryFormulaBarDisplay";
    const validationState = document.createElement("span");
    validationState.id = "dfmSummaryFormulaBarState";
    validationState.className = "dfmSummaryFormulaBarState";
    validationState.setAttribute("aria-live", "polite");
    validationState.hidden = true;
    const content = document.createElement("div");
    content.className = "dfmSummaryFormulaBarContent";
    content.appendChild(fxIcon);
    content.appendChild(label);
    content.appendChild(input);
    content.appendChild(display);
    content.appendChild(validationState);
    content.appendChild(xlBtn);
    content.appendChild(refreshBtn);
    content.appendChild(openBtn);
    el.appendChild(content);
  }
  if (el.dataset.wired !== "1") {
    const input = el.querySelector("#dfmSummaryFormulaBarInput");
    const FORMULA_PREFIX = "= ";
    const PREFIX_LEN = FORMULA_PREFIX.length; // 2
    input?.addEventListener("focus", () => {
      setSummaryFormulaBarMode("editing", input);
      updateFormulaBarDisplayMode(el, true);
      // Ensure leading "= " prefix is present
      if (!input.value.startsWith(FORMULA_PREFIX)) {
        const body = input.value.replace(/^=\s*/, "");
        input.value = FORMULA_PREFIX + body;
      }
      const summaryTableEl = document.querySelector("#ratioWrap table.ratioSummaryTable");
      const rowId = String(input.dataset.rowId || "");
      const col = Number(input.dataset.col);
      if (!summaryTableEl || !rowId || !Number.isFinite(col) || col < 0) return;
      const cell = summaryTableEl.querySelector(`td.summaryCell[data-r="${rowId}"][data-col="${col}"]`);
      if (!cell) return;
      beginSummaryFormulaEditSession(summaryTableEl, cell, input, col);
      updateActiveSummaryFormulaReferenceUi(summaryTableEl);
      scrollSummaryFormulaInputToEnd(input);
    });
    // Prevent cursor from moving before the prefix
    input?.addEventListener("click", () => {
      if (input.selectionStart < PREFIX_LEN) input.setSelectionRange(PREFIX_LEN, PREFIX_LEN);
    });
    input?.addEventListener("input", () => {
      delete input.dataset.skipFormulaBlurCommit;
      setSummaryFormulaBarMode("editing", input);
      clearSummaryFormulaBarValidationError();
      // Keep the leading "= " undeletable
      if (!input.value.startsWith(FORMULA_PREFIX)) {
        const cleaned = input.value.replace(/^=\s*/, "");
        input.value = FORMULA_PREFIX + cleaned;
        input.setSelectionRange(PREFIX_LEN, PREFIX_LEN);
      }
      const normalizedReference = normalizeExcelReferenceAddressCase(input.value);
      if (normalizedReference !== input.value) {
        const selectionStart = input.selectionStart;
        const selectionEnd = input.selectionEnd;
        input.value = normalizedReference;
        if (Number.isInteger(selectionStart) && Number.isInteger(selectionEnd)) {
          input.setSelectionRange(selectionStart, selectionEnd);
        }
      }
      const summaryTableEl = document.querySelector("#ratioWrap table.ratioSummaryTable");
      const rowId = String(input.dataset.rowId || "");
      const col = Number(input.dataset.col);
      if (summaryTableEl && rowId && Number.isFinite(col) && col >= 0) {
        const cell = summaryTableEl.querySelector(`td.summaryCell[data-r="${rowId}"][data-col="${col}"]`);
        if (cell) {
          beginSummaryFormulaEditSession(summaryTableEl, cell, input, col);
          updateSummaryFormulaBarForCell(cell);
          updateActiveSummaryFormulaReferenceUi(summaryTableEl);
        }
      }
    });
    input?.addEventListener("keydown", async (e) => {
      // Prevent deleting the leading "= " prefix
      if (e.key === "Backspace" && input.selectionStart <= PREFIX_LEN && input.selectionEnd <= PREFIX_LEN) {
        e.preventDefault();
        return;
      }
      if (e.key === "Delete" && input.selectionStart < PREFIX_LEN && input.selectionEnd <= PREFIX_LEN) {
        e.preventDefault();
        return;
      }
      // Prevent selecting/replacing the prefix via Home or Ctrl+A
      if (e.key === "Home") {
        e.preventDefault();
        input.setSelectionRange(PREFIX_LEN, e.shiftKey ? input.selectionEnd : PREFIX_LEN);
        return;
      }
      if (e.key === "ArrowLeft" && input.selectionStart <= PREFIX_LEN && !e.shiftKey) {
        e.preventDefault();
        return;
      }
      if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        input.setSelectionRange(PREFIX_LEN, input.value.length);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (isSummaryFormulaCommitPending(input)) return;
        const selection = captureFormulaInputSelection(input);
        setSummaryFormulaBarMode("validating", input);
        const validationStateGeneration = summaryRuntime.summaryFormulaBarState.generation;
        const ok = await commitSummaryFormulaInput(input);
        if (
          summaryRuntime.summaryFormulaBarState.generation !== validationStateGeneration ||
          summaryRuntime.summaryFormulaBarState.input !== input ||
          summaryRuntime.summaryFormulaBarState.mode !== "validating"
        ) return;
        if (ok) {
          setSummaryFormulaBarMode("display", input);
          if (document.activeElement === input) {
            input.dataset.skipFormulaBlurCommit = "1";
            input.blur();
          } else {
            scheduleFormulaBarDisplayMode(el, input);
          }
        } else {
          restoreFormulaBarEditingAfterValidation(el, input, selection);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelActiveSummaryFormulaCommit();
        cancelSummaryFormulaEditSession();
        clearSummaryFormulaBarValidationError();
        setSummaryFormulaBarMode("display", input);
        input.dataset.skipFormulaBlurCommit = "1";
        input.blur();
      }
    });
    input?.addEventListener("blur", async () => {
      if (input.dataset.skipFormulaBlurCommit === "1") {
        delete input.dataset.skipFormulaBlurCommit;
        scheduleFormulaBarDisplayMode(el, input);
        return;
      }
      if (isSummaryFormulaCommitPending(input)) {
        scheduleFormulaBarDisplayMode(el, input);
        return;
      }
      const selection = captureFormulaInputSelection(input);
      setSummaryFormulaBarMode("validating", input);
      const validationStateGeneration = summaryRuntime.summaryFormulaBarState.generation;
      const ok = await commitSummaryFormulaInput(input);
      if (
        summaryRuntime.summaryFormulaBarState.generation !== validationStateGeneration ||
        summaryRuntime.summaryFormulaBarState.input !== input ||
        summaryRuntime.summaryFormulaBarState.mode !== "validating"
      ) return;
      if (!ok) {
        restoreFormulaBarEditingAfterValidation(el, input, selection);
        return;
      }
      setSummaryFormulaBarMode("display", input);
      scheduleFormulaBarDisplayMode(el, input);
    });
    const displayDiv = el.querySelector("#dfmSummaryFormulaBarDisplay");
    displayDiv?.addEventListener("click", () => {
      if (input && !input.disabled && !input.readOnly && !isSummaryFormulaCommitPending(input)) {
        setSummaryFormulaBarMode("editing", input);
        updateFormulaBarDisplayMode(el, true);
        input.focus({ preventScroll: true });
      }
    });
    const xlBtn = el.querySelector("#dfmSummaryFormulaBarXlLink");
    xlBtn?.addEventListener("mousedown", () => {
      if (input.readOnly || isSummaryFormulaCommitPending(input)) return;
      // Prevent blur from committing the formula when clicking XL button
      input.dataset.skipFormulaBlurCommit = "1";
    });
    xlBtn?.addEventListener("click", () => {
      if (input.readOnly || isSummaryFormulaCommitPending(input)) return;
      const rowId = String(input?.dataset.rowId || "");
      const col = Number(input?.dataset.col);
      if (!rowId || !Number.isFinite(col) || col < 0) return;
      enterXlLinkMode(el, input, rowId, col);
    });
    const refreshBtn = el.querySelector("#dfmSummaryFormulaBarRefresh");
    refreshBtn?.addEventListener("click", () => {
      if (input.readOnly || isSummaryFormulaCommitPending(input)) return;
      clearSummaryFormulaBarValidationError();
      refreshAllExcelLinks().catch((error) => {
        setStatusBarText("Excel refresh failed.");
        showSummaryFormulaBarValidationError(error?.message || "Excel refresh failed.", input);
      });
    });
    const openBtn = el.querySelector("#dfmSummaryFormulaBarOpenXl");
    openBtn?.addEventListener("click", async () => {
      if (input.readOnly || isSummaryFormulaCommitPending(input)) return;
      // Find Excel ref in the current formula
      const raw = String(input?.value || "").trim();
      const refs = findExcelRefsInline(raw.startsWith("=") ? raw : "=" + raw);
      if (!refs.length) {
        showSummaryFormulaBarValidationError("No Excel reference found in current formula.", input);
        return;
      }
      clearSummaryFormulaBarValidationError();
      openBtn.disabled = true;
      try {
        const address = refs[0].endCell && refs[0].endCell !== refs[0].cell
          ? `${refs[0].cell}:${refs[0].endCell}`
          : refs[0].cell;
        const result = await openExcelWorkbook(refs[0].bookPath, refs[0].sheet, address);
        if (!result.ok) {
          showSummaryFormulaBarValidationError(result.error || "Failed to open workbook.", input);
        }
      } catch (err) {
        showSummaryFormulaBarValidationError(`Failed to open workbook: ${err.message || err}`, input);
      }
      openBtn.disabled = false;
    });
    el.dataset.wired = "1";
  }
  const parent = summaryTable?.parentElement;
  if (parent && el.parentElement !== parent) {
    parent.insertBefore(el, summaryTable);
  } else if (parent && summaryTable && el.nextElementSibling !== summaryTable) {
    parent.insertBefore(el, summaryTable);
  }
  wireSummaryFormulaBarResizeWatcher(summaryTable);
  return el;
}

function setStatusBarText(text) {
  // Status bar lives in the parent document (DFM runs in an iframe)
  const doc = window.parent?.document || document;
  const el = doc.getElementById("statusText") || doc.getElementById("statusBar");
  if (el) el.textContent = text || "";
}

// =============================================================================
// Excel Link Mode + Refresh
// =============================================================================

function exitXlLinkMode(barEl, options = {}) {
  const session = summaryRuntime._xlLinkSession;
  const restoreValue = options.restoreValue !== false;
  summaryRuntime._xlLinkMode = false;
  if (summaryRuntime._xlLinkFocusHandler) {
    window.removeEventListener("focus", summaryRuntime._xlLinkFocusHandler);
    summaryRuntime._xlLinkFocusHandler = null;
  }
  if (summaryRuntime._xlLinkEscHandler) {
    document.removeEventListener("keydown", summaryRuntime._xlLinkEscHandler);
    summaryRuntime._xlLinkEscHandler = null;
  }
  if (summaryRuntime._xlLinkAbortController) {
    summaryRuntime._xlLinkAbortController.abort();
    summaryRuntime._xlLinkAbortController = null;
  }
  if (barEl) barEl.classList.remove("xlLinkMode");
  const input = session?.inputEl || barEl?.querySelector?.("#dfmSummaryFormulaBarInput");
  if (input) {
    input.disabled = false;
    input.placeholder = "Enter value or formula";
    if (restoreValue && session) input.value = session.savedValue;
    if (input.isConnected) {
      setSummaryFormulaBarMode("editing", input);
      updateFormulaBarDisplayMode(barEl || input.closest?.(".dfmSummaryFormulaBar"), true);
    }
  }
  summaryRuntime._xlLinkSession = null;
}

function enterXlLinkMode(barEl, inputEl, rowId, col) {
  if (!inputEl || inputEl.readOnly || isSummaryFormulaCommitPending(inputEl)) return;
  if (summaryRuntime._xlLinkMode) {
    const savedValue = String(summaryRuntime._xlLinkSession?.savedValue ?? inputEl.value ?? "");
    exitXlLinkMode(barEl);
    restoreFormulaBarEditingAfterValidation(barEl, inputEl, {
      selectionStart: savedValue.length,
      selectionEnd: savedValue.length,
    });
    return;
  }
  summaryRuntime._xlLinkMode = true;
  clearSummaryFormulaBarValidationError();
  setSummaryFormulaBarMode("validating", inputEl);
  const validationState = barEl.querySelector("#dfmSummaryFormulaBarState");
  if (validationState) validationState.textContent = "Waiting for Excel…";
  barEl.classList.add("xlLinkMode");
  const savedValue = inputEl.value;
  const session = { barEl, inputEl, savedValue, rowId, col };
  summaryRuntime._xlLinkSession = session;
  inputEl.value = "";
  inputEl.placeholder = "Select a cell in Excel, press Enter to confirm...";
  inputEl.disabled = true;

  summaryRuntime._xlLinkEscHandler = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      exitXlLinkMode(barEl);
      restoreFormulaBarEditingAfterValidation(barEl, inputEl, {
        selectionStart: savedValue.length,
        selectionEnd: savedValue.length,
      });
    }
  };
  document.addEventListener("keydown", summaryRuntime._xlLinkEscHandler);

  // Also support the old focus-return flow as fallback
  summaryRuntime._xlLinkFocusHandler = () => {
    // If the polling already resolved, ignore
    if (!summaryRuntime._xlLinkMode) return;
  };
  window.addEventListener("focus", summaryRuntime._xlLinkFocusHandler);

  // Start polling: wait for Enter key in Excel (cell moves)
  summaryRuntime._xlLinkAbortController = new AbortController();
  const abortSignal = summaryRuntime._xlLinkAbortController.signal;
  (async () => {
    try {
      const result = await excelWaitForEnter({ signal: abortSignal });
      if (abortSignal.aborted || summaryRuntime._xlLinkSession !== session) return;
      exitXlLinkMode(barEl, { restoreValue: false });
      if (!result.ok) {
        inputEl.value = savedValue;
        showSummaryFormulaBarValidationError(result.error || "Could not read from Excel.", inputEl);
        restoreFormulaBarEditingAfterValidation(barEl, inputEl, {
          selectionStart: savedValue.length,
          selectionEnd: savedValue.length,
        });
        return;
      }
      if (!result.confirmed) {
        // Timeout — no Enter pressed within 30s, restore previous value
        inputEl.value = savedValue;
        restoreFormulaBarEditingAfterValidation(barEl, inputEl, {
          selectionStart: savedValue.length,
          selectionEnd: savedValue.length,
        });
        return;
      }
      // Populate formula bar with Excel ref and enter edit mode
      const ref = formatExcelRef(result.book_path, result.sheet, result.cell);
      inputEl.value = ref;
      inputEl.dataset.rowId = rowId;
      inputEl.dataset.col = String(col);
      // Bring our Electron window to front and focus formula bar in edit mode
      const linkReturnGeneration = summaryRuntime.summaryFormulaBarState.generation;
      if (window.ADAHost?.focusWindow) await window.ADAHost.focusWindow();
      if (
        !barEl.isConnected ||
        !inputEl.isConnected ||
        document.getElementById("dfmSummaryFormulaBar") !== barEl ||
        summaryRuntime.summaryFormulaBarState.generation !== linkReturnGeneration ||
        summaryRuntime.summaryFormulaBarState.input !== inputEl ||
        summaryRuntime.summaryFormulaBarState.mode !== "editing"
      ) return;
      setSummaryFormulaBarMode("editing", inputEl);
      updateFormulaBarDisplayMode(barEl, true);
      inputEl.focus();
      scrollSummaryFormulaInputToEnd(inputEl);
      // Start an edit session so Enter commits / Escape cancels
      const summaryTableEl = document.querySelector("#ratioWrap table.ratioSummaryTable");
      if (summaryTableEl) {
        const cell = summaryTableEl.querySelector(`td.summaryCell[data-r="${rowId}"][data-col="${col}"]`);
        if (cell) beginSummaryFormulaEditSession(summaryTableEl, cell, inputEl, col);
      }
    } catch (err) {
      if (abortSignal.aborted) return;
      exitXlLinkMode(barEl);
      showSummaryFormulaBarValidationError(`Could not read from Excel: ${err?.message || err}`, inputEl);
      restoreFormulaBarEditingAfterValidation(barEl, inputEl, {
        selectionStart: savedValue.length,
        selectionEnd: savedValue.length,
      });
    }
  })();
}

registerSummaryFunctions({
  scrollSummaryFormulaInputToEnd,
  tokenizeFormula,
  formatFormulaText,
  renderFormulaBarDisplay,
  updateFormulaBarDisplayMode,
  syncSummaryFormulaBarWidth,
  positionSummaryFormulaBarValidationTooltip,
  scheduleSummaryFormulaBarValidationTooltipPosition,
  scheduleSummaryFormulaBarResizeRefresh,
  wireSummaryFormulaBarResizeWatcher,
  getSummaryFormulaBarParts,
  clearSummaryFormulaBarValidationError,
  showSummaryFormulaBarValidationError,
  cancelFormulaBarDisplayRefresh,
  clearFormulaBarFocusRestoreHandler,
  isSummaryFormulaBarInputEditing,
  setSummaryFormulaBarMode,
  setFormulaBarCommitControlsDisabled,
  scheduleFormulaBarDisplayMode,
  captureFormulaInputSelection,
  restoreFormulaBarEditingAfterValidation,
  cancelActiveSummaryFormulaCommit,
  ensureSummaryFormulaBarValidationTooltip,
  ensureSummaryFormulaBarEl,
  setStatusBarText,
  exitXlLinkMode,
  enterXlLinkMode,
});

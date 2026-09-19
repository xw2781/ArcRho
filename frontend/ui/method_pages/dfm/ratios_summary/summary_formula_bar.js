/*
===============================================================================
DFM Ratios Summary Formula Bar
===============================================================================
*/
import { attachArcrhoTooltip } from "/ui/shared/components/tooltip/tooltip.js?v=20260812a";
import { installDfmDatasetAutocomplete } from "/ui/method_pages/dfm/dfm_dataset_autocomplete.js?v=20260814b";
import { wireFormulaHelper } from "/ui/shared/components/formula_bar/formula_helper.js?v=20260917a";
import { evaluateFormulaValues } from "/ui/shared/dataset/dataset_formula_values.js?v=20260919a";
import {
  getCachedDfmDatasetReferenceValues,
  resolveDfmDatasetReferencesInFormulaDetailed,
} from "/ui/method_pages/dfm/dfm_dataset_formula.js?v=20260820a";
import { createFormulaBarExcelLinkButton } from "/ui/shared/components/formula_bar/formula_bar_excel_link.js?v=20260908a";
import {
  formatFormulaText,
  stripRoundWrappers,
  tokenizeFormula,
} from "/ui/shared/components/formula_bar/formula_text.js?v=20260908a";
import {
  registerSummaryFunctions,
  summaryRuntime,
} from "/ui/method_pages/dfm/ratios_summary/summary_runtime.js?v=20260914b";

const {
  state, calcRatio, roundRatio, formatRatio, computeAverageForColumn,
  ratioStrikeSet, selectedSummaryByCol, summaryRowConfigs, summaryRowMap, BASE_SUMMARY_ROWS,
  getShowNaBorders, getRatioSummaryRaf, setRatioSummaryRaf,
  getLastSummaryCtxRowId, setLastSummaryCtxRowId,
  getEffectiveDevLabelsForModel, getRatioHeaderLabels, buildSummaryRows,
  buildExcludedSetForColumn, parsePeriodsValue, parseExcludeValue, getDfmDecimalPlaces,
  getSummaryConfigKey, loadCustomSummaryRows, saveCustomSummaryRows,
  readExcelCell, readExcelCellsBatch, openExcelWorkbook,
  buildExcelRangeSourceCells, containsExcelRef, excelColumnFromIndex, findExcelRefsInline,
  formatExcelRef, normalizeExcelReferenceAddressCase, parseStandaloneExcelRange,
  collectDfmExternalLinkGroupsModel, getDfmExternalLinkHardCodeTargets, getDfmExternalLinkRangeTargets,
  DFM_FORMULA_VALIDATION_TIMEOUT_MS, beginFormulaValidationLease, clearFormulaValidationError,
  computeFormulaValidationTooltipLayout, revealAndFocusFormulaInput, showFormulaValidationError,
  wireSelectableTable, openDfmSummaryPlotWindow, hasDfmCellNote, showDfmCellNoteEditor,
  beginRatioHistoryAction, commitRatioHistoryAction,
} = summaryRuntime;

const updateActiveSummaryFormulaReferenceUi = (...args) => summaryRuntime.updateActiveSummaryFormulaReferenceUi(...args);
const formatUserEntryFormulaEvaluationValue = (...args) => (
  summaryRuntime.formatUserEntryFormulaEvaluationValue(...args)
);
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

/** Ask the containing Project Instance to open a dataset explicitly in DSV. */
function openDfmFormulaDataset(datasetName, windowRef = window) {
  const name = String(datasetName || "").trim();
  const parentWindow = windowRef?.parent;
  if (!name || !parentWindow || parentWindow === windowRef) return false;
  parentWindow.postMessage({
    type: "arcrho:project-instance-open-dependent-dataset",
    datasetName: name,
    openMethod: false,
  }, "*");
  return true;
}

// A dataset factor of exactly 1 leaves the User Entry value where it was, so
// its pill is drawn quiet grey: the reference is still live and clickable, it
// just is not moving the number. The tolerance only absorbs binary rounding.
const NEUTRAL_DATASET_FACTOR_TOLERANCE = 1e-9;

function isNeutralDatasetFactor(value) {
  return Number.isFinite(value) && Math.abs(value - 1) <= NEUTRAL_DATASET_FACTOR_TOLERANCE;
}

/**
 * Render colorized formula display in the overlay div.
 * - Excel refs → dark green
 * - Quoted row references → one palette colour each, matching the cells they name
 * - Dataset references → clickable DSV pills, grey when the value is 1
 * - Operators get spaces around them
 * - Always shows leading '='
 */
function renderFormulaBarDisplay(displayEl, rawText, sourceText = rawText) {
  if (!displayEl) return;
  const tokens = tokenizeFormula(stripRoundWrappers(rawText));
  if (!tokens.length) {
    displayEl.textContent = "";
    return;
  }

  // Optional: this module is also loaded standalone, without the model module.
  const referenceColors = summaryRuntime.buildSummaryFormulaReferenceColorsByLabel?.(sourceText)
    || new Map();
  displayEl.innerHTML = "";
  const sourceDatasetTokens = tokenizeFormula(sourceText).filter((token) => token.datasetName);
  // Values come from the session cache the page warms when it opens, keyed by
  // the reference finder rather than by this tokenizer, so they are only
  // trusted when both readings of the formula found the same references.
  const cachedValues = getCachedDfmDatasetReferenceValues(sourceText);
  const datasetValues = cachedValues.length === sourceDatasetTokens.length ? cachedValues : [];
  const unresolvedPills = [];
  let datasetIndex = 0;
  for (const tok of tokens) {
    if (tok.datasetCoordinate) continue;
    if (tok.type === "excel") {
      const span = document.createElement("span");
      span.className = "fmtExcelRef";
      span.textContent = tok.text;
      displayEl.appendChild(span);
    } else if (tok.type === "ref") {
      const span = document.createElement("span");
      const label = tok.text.slice(1, -1);
      span.className = "fmtRowRef";
      const colorClass = referenceColors.get(label.trim().toLowerCase());
      if (colorClass) span.classList.add(colorClass);
      span.textContent = label;
      displayEl.appendChild(span);
    } else if (tok.type === "bracket" && tok.datasetName) {
      const referenceIndex = datasetIndex;
      const sourceToken = sourceDatasetTokens[referenceIndex] || tok;
      datasetIndex += 1;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "fmtDatasetRef";
      const cachedValue = datasetValues[referenceIndex];
      if (isNeutralDatasetFactor(cachedValue)) button.classList.add("isNeutral");
      else if (!Number.isFinite(cachedValue)) unresolvedPills.push({ button, referenceIndex });
      button.textContent = `${tok.datasetName} @ ${tok.datasetCoordinateLabel}`;
      button.dataset.datasetName = tok.datasetName;
      button.dataset.coordinateLabel = tok.datasetCoordinateLabel;
      button.setAttribute(
        "aria-label",
        `Open dataset ${tok.datasetName} at ${tok.datasetCoordinateLabel} in Dataset Viewer`,
      );
      let tooltipValuePromise = null;
      attachArcrhoTooltip(button, async () => {
        if (!tooltipValuePromise) {
          const referenceFormula = `=[${sourceToken.datasetName}][${sourceToken.datasetCoordinateLabel}]`;
          tooltipValuePromise = resolveDfmDatasetReferencesInFormulaDetailed(referenceFormula)
            .then((resolved) => {
              const value = Number(String(resolved?.resolvedFormula || "").replace(/^=\s*/, ""));
              return Number.isFinite(value)
                ? formatUserEntryFormulaEvaluationValue(value)
                : "Value unavailable";
            })
            .catch(() => "Value unavailable");
        }
        return tooltipValuePromise;
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!openDfmFormulaDataset(tok.datasetName)) {
          setStatusBarText(`Could not open dataset ${tok.datasetName}.`);
        }
      });
      displayEl.appendChild(button);
    } else if (tok.type === "op") {
      displayEl.appendChild(document.createTextNode(" " + tok.text + " "));
    } else {
      const t = tok.text.trim();
      if (t) displayEl.appendChild(document.createTextNode(t === "=" ? "= " : t));
    }
  }

  // Nothing is known about a reference until it resolves once, and until then
  // its pill reads as blue. One batched read for the whole formula fills the
  // cache the next render also uses, so this costs a single request in the
  // narrow window before the page-open warm-up lands.
  if (unresolvedPills.length) {
    resolveDfmDatasetReferencesInFormulaDetailed(sourceText).then(() => {
      const resolvedValues = getCachedDfmDatasetReferenceValues(sourceText);
      if (resolvedValues.length !== sourceDatasetTokens.length) return;
      for (const pill of unresolvedPills) {
        pill.button.classList.toggle("isNeutral", isNeutralDatasetFactor(resolvedValues[pill.referenceIndex]));
      }
    }).catch(() => {
      // Best-effort: an unreadable reference simply keeps its blue pill.
    });
  }
}

// The bar is a singleton on the page, so its workbook button is one too.
let summaryExcelLink = null;

/** Show/hide display overlay vs input based on focus state. */
/**
 * Fold a doubled leading "=" into one. A copied Excel link carries its own
 * sign and the bar already shows one, so "= ='C:\...'!A1" is one formula with
 * the sign written twice, not an error worth reporting.
 */
function collapseFormulaEquals(raw) {
  const text = String(raw ?? "");
  const match = /^(\s*=)(?:\s*=)+/u.exec(text);
  return match ? `${match[1]}${text.slice(match[0].length)}` : text;
}

function updateFormulaBarDisplayMode(barEl, isEditing) {
  if (!barEl) return;
  const input = barEl.querySelector("#dfmSummaryFormulaBarInput");
  const display = barEl.querySelector("#dfmSummaryFormulaBarDisplay");
  if (!input || !display) return;
  // The raw formula is what names the workbook, in both modes: the rendered
  // display drops a ROUND wrapper the reference may sit inside.
  summaryExcelLink?.update(input.value);
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
    renderFormulaBarDisplay(display, input.dataset.displayFormula || input.value, input.value);
  }
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
    || !bar.classList.contains("isOpen")
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

/**
 * The panel lives between two tables that are as wide as their data, inside a
 * box that scrolls sideways, so its natural width is the width of the widest
 * table rather than the width of the window. The stylesheet pins it to the
 * left edge of the scrollport; this gives it the visible width to match, so
 * the label at one end and the Excel link at the other always sit where the
 * window puts them instead of drifting off screen with the grid.
 */
function syncSummaryFormulaPanelWidth() {
  const panel = document.getElementById("dfmSummaryFormulaPanel");
  const host = document.getElementById("ratioWrapHost");
  if (!panel || !host) return;
  const style = window.getComputedStyle(host);
  const padding = (Number.parseFloat(style.paddingLeft) || 0)
    + (Number.parseFloat(style.paddingRight) || 0);
  const visibleWidth = host.clientWidth - padding;
  // The bar belongs to the summary table, so when that table is narrower than
  // the scrollport it stops at the table's right edge rather than running on
  // across empty space.
  const summaryTable = document.querySelector("#ratioWrap table.ratioSummaryTable");
  const tableWidth = summaryTable ? Math.ceil(summaryTable.getBoundingClientRect().width) : 0;
  const width = tableWidth > 0 ? Math.min(visibleWidth, tableWidth) : visibleWidth;
  if (width > 0) panel.style.setProperty("--dfm-summary-formula-panel-width", `${width}px`);
  else panel.style.removeProperty("--dfm-summary-formula-panel-width");
}

/**
 * Dragging across the formula text must not take the grid with it. The bar
 * sits inside the box that scrolls the tables, so a selection running past the
 * end of the input makes the browser scroll that box to follow it, and the
 * tables slide under a reader who only meant to select part of a formula. The
 * box is therefore held at the offsets it had when the drag started, until the
 * drag ends.
 */
function holdRatioScrollDuringBarSelection(barEl) {
  barEl.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const host = document.getElementById("ratioWrapHost");
    if (!host) return;
    const { scrollLeft, scrollTop } = host;
    const hold = () => {
      if (host.scrollLeft !== scrollLeft) host.scrollLeft = scrollLeft;
      if (host.scrollTop !== scrollTop) host.scrollTop = scrollTop;
    };
    const release = () => {
      host.removeEventListener("scroll", hold);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
    };
    host.addEventListener("scroll", hold);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
  });
}

function scheduleSummaryFormulaBarResizeRefresh() {
  if (summaryRuntime.formulaBarResizeRaf) return;
  summaryRuntime.formulaBarResizeRaf = window.requestAnimationFrame(() => {
    summaryRuntime.formulaBarResizeRaf = 0;
    syncSummaryFormulaPanelWidth();
    scheduleSummaryFormulaBarValidationTooltipPosition();
  });
}

// The bar itself no longer moves with the grid, so only a window resize (or a
// zoom change) can move it relative to the viewport; its own width and the
// validation tooltip are the only things left that need to notice.
function handleSummaryFormulaBarViewportResize() {
  scheduleSummaryFormulaBarResizeRefresh();
}

function wireSummaryFormulaBarResizeWatcher() {
  syncSummaryFormulaPanelWidth();
  if (summaryRuntime.formulaBarResizeWired) return;
  summaryRuntime.formulaBarResizeWired = true;
  window.addEventListener("resize", handleSummaryFormulaBarViewportResize);
  window.addEventListener(
    "pointerdown",
    scheduleSummaryFormulaBarValidationTooltipPosition,
    { capture: true, passive: true },
  );
  // A window resize is not the only thing that changes the visible width: the
  // side panel, the tab strip and the scrollbar gutter all move that edge
  // without the window moving at all.
  const host = document.getElementById("ratioWrapHost");
  if (host && typeof window.ResizeObserver === "function") {
    new window.ResizeObserver(scheduleSummaryFormulaBarResizeRefresh).observe(host);
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

/**
 * Commit what the bar holds, as Enter does: the bar shows "Validating…" while
 * the formula is checked, leaves edit mode when it is accepted, and keeps the
 * draft, caret, and edit session in place when it is refused. Returns whether
 * the formula was accepted.
 */
async function submitSummaryFormulaBarInput(barEl, input) {
  if (!barEl || !input || isSummaryFormulaCommitPending(input)) return false;
  const selection = captureFormulaInputSelection(input);
  setSummaryFormulaBarMode("validating", input);
  const validationStateGeneration = summaryRuntime.summaryFormulaBarState.generation;
  const ok = await commitSummaryFormulaInput(input);
  if (
    summaryRuntime.summaryFormulaBarState.generation !== validationStateGeneration ||
    summaryRuntime.summaryFormulaBarState.input !== input ||
    summaryRuntime.summaryFormulaBarState.mode !== "validating"
  ) return !!ok;
  if (ok) {
    setSummaryFormulaBarMode("display", input);
    if (document.activeElement === input) {
      input.dataset.skipFormulaBlurCommit = "1";
      input.blur();
    } else {
      scheduleFormulaBarDisplayMode(barEl, input);
    }
  } else {
    restoreFormulaBarEditingAfterValidation(barEl, input, selection);
  }
  return !!ok;
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
    el.className = "arFormulaBar dfmSummaryFormulaBar";
    const fxIcon = document.createElement("span");
    fxIcon.className = "arFormulaBarFxIcon";
    fxIcon.textContent = "fx";
    const label = document.createElement("span");
    label.id = "dfmSummaryFormulaBarLabelText";
    label.className = "dfmSummaryFormulaBarLabel";
    label.textContent = "f(x)";
    // The row name alone does not say which cell is in the bar: the ratio
    // column it sits in is named beside it, the way the grid header names it.
    const colLabel = document.createElement("span");
    colLabel.id = "dfmSummaryFormulaBarColLabel";
    colLabel.className = "dfmSummaryFormulaBarColLabel";
    colLabel.hidden = true;
    const input = document.createElement("input");
    input.id = "dfmSummaryFormulaBarInput";
    input.className = "arFormulaBarInput dfmSummaryFormulaBarInput";
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    const display = document.createElement("div");
    display.id = "dfmSummaryFormulaBarDisplay";
    display.className = "arFormulaBarDisplay dfmSummaryFormulaBarDisplay";
    summaryExcelLink = createFormulaBarExcelLinkButton({ onStatus: setStatusBarText });
    const validationState = document.createElement("span");
    validationState.id = "dfmSummaryFormulaBarState";
    validationState.className = "dfmSummaryFormulaBarState";
    validationState.setAttribute("aria-live", "polite");
    validationState.hidden = true;
    el.appendChild(fxIcon);
    el.appendChild(label);
    el.appendChild(colLabel);
    el.appendChild(input);
    el.appendChild(display);
    el.appendChild(summaryExcelLink.el);
    el.appendChild(validationState);
  }
  if (el.dataset.wired !== "1") {
    const input = el.querySelector("#dfmSummaryFormulaBarInput");
    holdRatioScrollDuringBarSelection(el);
    installDfmDatasetAutocomplete(input);
    wireFormulaHelper(el.querySelector(".arFormulaBarFxIcon"), input, {
      onOpen: () => { updateFormulaBarDisplayMode(el, true); input.focus(); },
      evaluate: async (formula, options) => {
        const table = document.querySelector("#ratioWrap table.ratioSummaryTable");
        const resolved = await resolveDfmDatasetReferencesInFormulaDetailed(formula, options);
        const result = await evaluateFormulaValues(resolved.resolvedFormula, {
          ...options,
          referenceValues: summaryRuntime.buildSummaryReferenceValues(table, Number(input.dataset.col)),
          round: summaryRuntime.roundHalfUp,
        });
        if (result.ok && (result.rows !== 1 || result.values[0].some(value => !Number.isFinite(value) || value <= 0))) {
          return { ok: false, error: "DFM needs one row of values greater than zero. Use TRANSPOSE, TAKE or INDEX to select the required values." };
        }
        return result;
      },
    });
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
      // A pasted formula brings its own "=", which folds into the one the bar
      // shows; the caret keeps its place in the text that remains.
      const collapsed = collapseFormulaEquals(input.value);
      if (collapsed !== input.value) {
        const removed = input.value.length - collapsed.length;
        const selectionStart = Math.max(PREFIX_LEN, (input.selectionStart ?? collapsed.length) - removed);
        const selectionEnd = Math.max(selectionStart, (input.selectionEnd ?? collapsed.length) - removed);
        input.value = collapsed;
        input.setSelectionRange(selectionStart, selectionEnd);
      }
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
        await submitSummaryFormulaBarInput(el, input);
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
      if (input.dataset.formulaHelperOpen === "1") return;
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
    el.dataset.wired = "1";
  }
  // Docked above the grid rather than floating over it, so it lives in that
  // fixed panel and stays in the page's own flow.
  const host = document.getElementById("dfmSummaryFormulaPanel");
  if (host && el.parentElement !== host) {
    host.appendChild(el);
  }
  wireSummaryFormulaBarResizeWatcher();
  return el;
}

/**
 * The development label the grid prints over a ratio column, such as `12-24`,
 * for the column the bar is showing. An empty string when there is no model
 * yet or the column is outside it, which hides the label rather than printing
 * a stray number.
 */
function getSummaryDevLabelForCol(col) {
  const index = Number(col);
  if (!Number.isFinite(index) || index < 0) return "";
  const model = state?.model;
  if (!model) return "";
  const labels = getRatioHeaderLabels(getEffectiveDevLabelsForModel(model));
  return String(labels?.[index] ?? "");
}

function setSummaryFormulaBarColLabel(col, barEl = null) {
  const el = barEl || document.getElementById("dfmSummaryFormulaBar");
  const colLabel = el?.querySelector?.("#dfmSummaryFormulaBarColLabel");
  if (!colLabel) return;
  const text = getSummaryDevLabelForCol(col);
  colLabel.textContent = text;
  colLabel.hidden = !text;
}

function setStatusBarText(text) {
  // Status bar lives in the parent document (DFM runs in an iframe)
  const doc = window.parent?.document || document;
  const el = doc.getElementById("statusText") || doc.getElementById("statusBar");
  if (el) el.textContent = text || "";
}

/**
 * Idle state: the panel stays in place at all times, docked above the ratio
 * summary table, so an eligible-but-unselected moment shows a quiet note
 * rather than the bar disappearing.
 */
function showSummaryFormulaBarIdle() {
  const panel = document.getElementById("dfmSummaryFormulaPanel");
  if (panel) panel.hidden = false;
  const el = ensureSummaryFormulaBarEl();
  clearSummaryFormulaBarValidationError();
  const input = el.querySelector("#dfmSummaryFormulaBarInput");
  const label = el.querySelector("#dfmSummaryFormulaBarLabelText");
  if (label) label.textContent = "f(x)";
  setSummaryFormulaBarColLabel(-1, el);
  if (input) {
    setSummaryFormulaBarMode("display", input);
    input.value = "";
    input.disabled = true;
    delete input.dataset.rowId;
    delete input.dataset.col;
    delete input.dataset.displayFormula;
  }
  el.classList.remove("isOpen");
  el.classList.add("isNote");
  const display = el.querySelector("#dfmSummaryFormulaBarDisplay");
  if (display) {
    display.textContent = "Select a cell to see its value or formula.";
    display.style.display = "";
  }
  if (input) input.style.display = "none";
  summaryExcelLink?.update("");
}

/**
 * A summary row that isn't User Entry (an average, a benchmark row, ...) has
 * no formula of its own to edit, but the bar still names what it shows: the
 * cell's own unrounded factor, read-only text a reader can select and copy
 * -- never an input, so there is nothing to type into.
 */
function showSummaryFormulaBarReadOnlyValue(cell, cfg) {
  const panel = document.getElementById("dfmSummaryFormulaPanel");
  if (panel) panel.hidden = false;
  const el = ensureSummaryFormulaBarEl();
  clearSummaryFormulaBarValidationError();
  const label = el.querySelector("#dfmSummaryFormulaBarLabelText");
  if (label) label.textContent = String(cfg?.label || cfg?.id || "f(x)");
  setSummaryFormulaBarColLabel(cell?.dataset?.col, el);
  const input = el.querySelector("#dfmSummaryFormulaBarInput");
  if (input) {
    setSummaryFormulaBarMode("display", input);
    input.value = "";
    input.disabled = true;
    delete input.dataset.rowId;
    delete input.dataset.col;
    delete input.dataset.displayFormula;
  }
  el.classList.remove("isNote");
  el.classList.add("isOpen");
  const rawValue = cell?.dataset?.copyValue;
  const numericValue = rawValue === "" || rawValue == null ? NaN : Number(rawValue);
  const display = el.querySelector("#dfmSummaryFormulaBarDisplay");
  if (display) {
    // Written as an equation, the way a User Entry formula is: the row name on
    // the left of the bar, then `=`, then what that row is worth here.
    display.textContent = Number.isFinite(numericValue) ? `= ${numericValue}` : "";
    display.style.display = "";
  }
  if (input) input.style.display = "none";
  summaryExcelLink?.update("");
}

/**
 * True hide: nothing is rendered for the bar to describe (no summary table on
 * the page at all), so the whole docked panel steps out of the layout rather
 * than sitting there with permanently idle controls.
 */
function hideSummaryFormulaBar() {
  const panel = document.getElementById("dfmSummaryFormulaPanel");
  if (panel) panel.hidden = true;
  clearSummaryFormulaBarValidationError();
  const el = document.getElementById("dfmSummaryFormulaBar");
  if (el) {
    setSummaryFormulaBarMode("display", el.querySelector("#dfmSummaryFormulaBarInput"));
    el.classList.remove("isOpen");
  }
}

registerSummaryFunctions({
  scrollSummaryFormulaInputToEnd,
  tokenizeFormula,
  formatFormulaText,
  stripRoundWrappers,
  openDfmFormulaDataset,
  renderFormulaBarDisplay,
  updateFormulaBarDisplayMode,
  positionSummaryFormulaBarValidationTooltip,
  scheduleSummaryFormulaBarValidationTooltipPosition,
  scheduleSummaryFormulaBarResizeRefresh,
  syncSummaryFormulaPanelWidth,
  handleSummaryFormulaBarViewportResize,
  wireSummaryFormulaBarResizeWatcher,
  getSummaryFormulaBarParts,
  setSummaryFormulaBarColLabel,
  clearSummaryFormulaBarValidationError,
  showSummaryFormulaBarValidationError,
  cancelFormulaBarDisplayRefresh,
  clearFormulaBarFocusRestoreHandler,
  isSummaryFormulaBarInputEditing,
  setSummaryFormulaBarMode,
  scheduleFormulaBarDisplayMode,
  captureFormulaInputSelection,
  restoreFormulaBarEditingAfterValidation,
  cancelActiveSummaryFormulaCommit,
  ensureSummaryFormulaBarValidationTooltip,
  ensureSummaryFormulaBarEl,
  setStatusBarText,
  collapseFormulaEquals,
  submitSummaryFormulaBarInput,
  showSummaryFormulaBarIdle,
  showSummaryFormulaBarReadOnlyValue,
  hideSummaryFormulaBar,
});

/*
===============================================================================
DFM Ratios Summary Excel Integration
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

const isUserEntryConfig = (...args) => summaryRuntime.isUserEntryConfig(...args);
const getCurrentRatioColumnCount = (...args) => summaryRuntime.getCurrentRatioColumnCount(...args);
const applyUserEntryReferenceHighlights = (...args) => summaryRuntime.applyUserEntryReferenceHighlights(...args);
const evaluateSimpleMathExpression = (...args) => summaryRuntime.evaluateSimpleMathExpression(...args);
const parseSummaryArrayFormula = (...args) => summaryRuntime.parseSummaryArrayFormula(...args);
const normalizeUserEntryInputs = (...args) => summaryRuntime.normalizeUserEntryInputs(...args);
const getUserEntryValueForCol = (...args) => summaryRuntime.getUserEntryValueForCol(...args);
const getUserEntryInputForCol = (...args) => summaryRuntime.getUserEntryInputForCol(...args);
const clearSummaryFormulaBarValidationError = (...args) => summaryRuntime.clearSummaryFormulaBarValidationError(...args);
const showSummaryFormulaBarValidationError = (...args) => summaryRuntime.showSummaryFormulaBarValidationError(...args);
const setSummaryFormulaBarMode = (...args) => summaryRuntime.setSummaryFormulaBarMode(...args);
const setStatusBarText = (...args) => summaryRuntime.setStatusBarText(...args);
const updateSummaryFormulaBarForCell = (...args) => summaryRuntime.updateSummaryFormulaBarForCell(...args);
const clearSummaryReferenceUi = (...args) => summaryRuntime.clearSummaryReferenceUi(...args);
const buildSummaryReferenceValues = (...args) => summaryRuntime.buildSummaryReferenceValues(...args);
const setUserEntryCellEntry = (...args) => summaryRuntime.setUserEntryCellEntry(...args);
const persistUserEntryRowsFromState = (...args) => summaryRuntime.persistUserEntryRowsFromState(...args);
const ensureSelectedRowValues = (...args) => summaryRuntime.ensureSelectedRowValues(...args);

/**
 * Resolve all Excel refs in an expression to numeric values, then evaluate
 * the resulting math expression with row references.
 * Returns { ok, value, error? }.
 */
async function resolveExcelRefsInExpression(raw, referenceValues, options = {}) {
  let expr = String(raw || "").trim();
  if (expr.startsWith("=")) expr = expr.slice(1).trim();

  // Find all inline Excel refs
  const refs = findExcelRefsInline("=" + expr); // prepend = to normalise
  if (!refs.length) return { ok: false, error: "No Excel refs found." };

  // Resolve each unique ref
  const resolvedMap = new Map();
  for (const ref of refs) {
    if (resolvedMap.has(ref.match)) continue;
    const result = await readExcelCell(ref.bookPath, ref.sheet, ref.cell, { signal: options.signal });
    if (!result.ok) return { ok: false, error: `Excel read error for ${ref.match}: ${result.error}` };
    if (!Number.isFinite(result.value)) return { ok: false, error: `Non-numeric value from ${ref.match}: ${result.value}` };
    resolvedMap.set(ref.match, String(result.value));
    summaryRuntime._xlCellValueCache.set(ref.match, result.value);
  }

  // Substitute Excel refs with their numeric values in the expression
  let substituted = "=" + expr;
  for (const [matchStr, numStr] of resolvedMap) {
    substituted = substituted.split(matchStr).join(numStr);
  }

  // Now evaluate using the existing math evaluator (handles row references + arithmetic)
  const parsed = evaluateSimpleMathExpression(substituted, referenceValues);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { ok: false, error: null }; // let caller show standard error
  }
  return { ok: true, value: parsed };
}

// Cache of last-resolved Excel cell values, keyed by ref match string (e.g. "'dir\[file]Sheet'!A1")

export function cancelDfmExcelFreshnessCheck() {
  summaryRuntime._dfmExcelFreshnessGeneration += 1;
  summaryRuntime._dfmExcelFreshnessAbortController?.abort?.();
  summaryRuntime._dfmExcelFreshnessAbortController = null;
}

function invalidateDfmExcelRefresh() {
  summaryRuntime._dfmExcelRefreshGeneration += 1;
  summaryRuntime._dfmExcelRefreshAbortController?.abort?.();
  summaryRuntime._dfmExcelRefreshAbortController = null;
  cancelDfmExcelFreshnessCheck();
}

function dfmExternalInputStillMatches(rowId, col, expectedInput) {
  const cfg = summaryRowMap.get(String(rowId || ""));
  if (!cfg || !isUserEntryConfig(cfg)) return false;
  return String(getUserEntryInputForCol(cfg, Number(col)) || "").trim()
    === String(expectedInput || "").trim();
}

async function commitExcelFormulaAsync(rowId, col, raw, options = {}) {
  try {
    const summaryTable = document.querySelector("#ratioWrap table.ratioSummaryTable");
    const selectedTable = document.querySelector("#ratioWrap table.ratioSelectedTable");
    const refValues = summaryTable ? buildSummaryReferenceValues(summaryTable, col) : new Map();

    const result = await resolveExcelRefsInExpression(raw, refValues, { signal: options.signal });
    if (options.isCurrent && !options.isCurrent()) return false;
    if (!result.ok) {
      if (result.error) {
        showSummaryFormulaBarValidationError(result.error);
      } else {
        showSummaryFormulaBarValidationError("Enter a number > 0, or a formula like =\"Simple - 5\"*2.");
      }
      return false;
    }
    const nextValue = roundRatio(result.value, 6);
    restoreSupersededExcelRange(summaryTable, rowId, col, raw);
    setUserEntryCellEntry(rowId, col, raw, nextValue);
    persistUserEntryRowsFromState();
    const cell = summaryTable?.querySelector(`td.summaryCell[data-r="${rowId}"][data-col="${col}"]`);
    if (cell) {
      setUserEntryCellDisplayValue(cell, nextValue);
      cell.classList.add("excelLinked");
      cell.title = raw;
    }
    if (selectedTable && summaryTable) ensureSelectedRowValues(summaryTable, selectedTable);
    applyUserEntryReferenceHighlights(summaryTable);
    applyExcelRangeHighlights(summaryTable);
    clearSummaryReferenceUi(summaryTable);
    summaryRuntime.summaryFormulaEditState = null;
    updateSummaryFormulaBarForCell(cell);
    summaryRuntime._onRatioStateMutated();
    return true;
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    showSummaryFormulaBarValidationError(`Failed to evaluate Excel formula: ${err.message || err}`);
    return false;
  }
}

export async function refreshAllExcelLinks(options = {}) {
  const summaryTable = document.querySelector("#ratioWrap table.ratioSummaryTable");
  const selectedTable = document.querySelector("#ratioWrap table.ratioSelectedTable");
  const rangeLinks = [];
  const batchItems = [];
  const batchMeta = [];
  const cellsToRefresh = [];
  const requestedSourceIds = Array.isArray(options?.sourceIds)
    ? new Set(options.sourceIds.map((id) => String(id || "")).filter(Boolean))
    : null;
  const selectedConsumerKeys = new Set();
  if (requestedSourceIds) {
    const groups = collectDfmExternalLinkGroups();
    requestedSourceIds.forEach((id) => {
      groups.get(id)?.consumers?.forEach?.((_consumer, key) => selectedConsumerKeys.add(key));
    });
  }

  for (const cfg of summaryRowConfigs) {
    if (!isUserEntryConfig(cfg)) continue;
    const inputs = cfg.inputs || [];
    for (let col = 0; col < inputs.length; col++) {
      if (
        requestedSourceIds
        && !selectedConsumerKeys.has(`${String(cfg.id)}\u001f${col}`)
      ) continue;
      const inputRaw = String(inputs[col] || "").trim();
      if (!containsExcelRef(inputRaw)) continue;
      const range = parseStandaloneExcelRange(inputRaw);
      if (range) {
        rangeLinks.push({ rowId: String(cfg.id), col, inputRaw, range });
        continue;
      }
      const inlineRefs = findExcelRefsInline(inputRaw.startsWith("=") ? inputRaw : "=" + inputRaw);
      for (const ref of inlineRefs) {
        batchItems.push({ book_path: ref.bookPath, sheet: ref.sheet, cell: ref.cell });
        batchMeta.push({ rowId: cfg.id, col, inputRaw, refMatch: ref.match });
      }
      cellsToRefresh.push({ rowId: cfg.id, col, inputRaw });
    }
  }
  if (!rangeLinks.length && !batchItems.length) {
    return { linkedCellCount: 0, changedCount: 0, failedCount: 0 };
  }

  invalidateDfmExcelRefresh();
  const refreshGeneration = summaryRuntime._dfmExcelRefreshGeneration;
  const refreshController = new AbortController();
  summaryRuntime._dfmExcelRefreshAbortController = refreshController;
  const refreshIsCurrent = () => (
    refreshGeneration === summaryRuntime._dfmExcelRefreshGeneration
    && !refreshController.signal.aborted
  );

  setStatusBarText("Refreshing linked Excel values...");
  let linkedCellCount = 0;
  let changedCount = 0;
  let failedCount = 0;

  try {
  for (const link of rangeLinks) {
    const rangeCellCount = link.range.rowCount * link.range.colCount;
    linkedCellCount += rangeCellCount;
    const destination = getExcelRangeDestination(summaryTable, link.rowId, link.col, link.range);
    if (!destination.ok) {
      failedCount += rangeCellCount;
      continue;
    }
    const readResult = await readExcelRangeValues(link.range, {
      signal: refreshController.signal,
    });
    if (!refreshIsCurrent()) {
      return { linkedCellCount, changedCount, failedCount, aborted: true };
    }
    if (!dfmExternalInputStillMatches(link.rowId, link.col, link.inputRaw)) {
      continue;
    }
    if (!readResult.ok) {
      failedCount += destination.entries.length;
      continue;
    }
    summaryRuntime._applyingDfmExcelRefresh = true;
    try {
      changedCount += applyResolvedExcelRange(
        summaryTable,
        selectedTable,
        link.rowId,
        link.col,
        link.inputRaw,
        link.range,
        destination,
        readResult.values,
      );
    } finally {
      summaryRuntime._applyingDfmExcelRefresh = false;
    }
    const anchor = destination.entries[0]?.cell;
    if (anchor) {
      anchor.classList.add("excelLinked");
      anchor.title = "";
    }
  }

  const resolvedMap = new Map();
  if (batchItems.length) {
    linkedCellCount += cellsToRefresh.length;
    const result = await readExcelCellsBatch(batchItems, {
      signal: refreshController.signal,
    });
    if (!refreshIsCurrent()) {
      return { linkedCellCount, changedCount, failedCount, aborted: true };
    }
    if (result.ok) {
      for (let i = 0; i < result.results.length; i++) {
        const itemResult = result.results[i];
        if (itemResult.ok && Number.isFinite(itemResult.value)) {
          resolvedMap.set(batchMeta[i].refMatch, itemResult.value);
          summaryRuntime._xlCellValueCache.set(batchMeta[i].refMatch, itemResult.value);
        }
      }
    }
  }

  for (const { rowId, col, inputRaw } of cellsToRefresh) {
    if (!refreshIsCurrent()) {
      return { linkedCellCount, changedCount, failedCount, aborted: true };
    }
    if (!dfmExternalInputStillMatches(rowId, col, inputRaw)) continue;
    let expr = inputRaw.startsWith("=") ? inputRaw : "=" + inputRaw;
    let allResolved = true;
    const refs = findExcelRefsInline(expr);
    for (const ref of refs) {
      if (resolvedMap.has(ref.match)) {
        expr = expr.split(ref.match).join(String(resolvedMap.get(ref.match)));
      } else {
        allResolved = false;
      }
    }
    if (!allResolved) {
      failedCount += 1;
      continue;
    }

    const refValues = summaryTable ? buildSummaryReferenceValues(summaryTable, col) : new Map();
    const parsed = evaluateSimpleMathExpression(expr, refValues);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      failedCount += 1;
      continue;
    }

    const nextValue = roundRatio(parsed, 6);
    const cfg = summaryRowMap.get(rowId);
    if (!cfg) continue;
    const currentValue = getUserEntryValueForCol(cfg, col);
    if (Math.abs(currentValue - nextValue) < 1e-10) continue;
    summaryRuntime._applyingDfmExcelRefresh = true;
    try {
      setUserEntryCellEntry(rowId, col, inputRaw, nextValue, { persist: false });
    } finally {
      summaryRuntime._applyingDfmExcelRefresh = false;
    }
    changedCount += 1;
    const cell = summaryTable?.querySelector(`td.summaryCell[data-r="${rowId}"][data-col="${col}"]`);
    if (cell) {
      setUserEntryCellDisplayValue(cell, nextValue);
      cell.classList.add("excelLinked");
      cell.title = inputRaw;
    }
  }

  if (changedCount > 0) persistUserEntryRowsFromState();
  if (summaryTable && selectedTable) {
    ensureSelectedRowValues(summaryTable, selectedTable);
    applyUserEntryReferenceHighlights(summaryTable);
    applyExcelRangeHighlights(summaryTable);
  }
  if (changedCount > 0) {
    summaryRuntime._onRatioStateMutated();
  }
  if (failedCount > 0) {
    setStatusBarText(`Excel refresh: ${failedCount} linked cell${failedCount === 1 ? "" : "s"} failed.`);
    if (!options.silentErrors) {
      showSummaryFormulaBarValidationError("One or more Excel-linked values could not be refreshed.");
    }
  } else if (changedCount > 0) {
    const suffix = options.source === "dfm-open" ? " changed from the saved DFM values." : " updated.";
    setStatusBarText(`Excel refresh: ${changedCount} linked cell${changedCount === 1 ? "" : "s"}${suffix}`);
  } else {
    setStatusBarText(`Excel refresh: ${linkedCellCount} linked cell${linkedCellCount === 1 ? "" : "s"} unchanged.`);
  }
  return { linkedCellCount, changedCount, failedCount };
  } catch (error) {
    if (error?.name === "AbortError" || !refreshIsCurrent()) {
      return { linkedCellCount, changedCount, failedCount, aborted: true };
    }
    throw error;
  } finally {
    summaryRuntime._applyingDfmExcelRefresh = false;
    if (
      refreshGeneration === summaryRuntime._dfmExcelRefreshGeneration
      && summaryRuntime._dfmExcelRefreshAbortController === refreshController
    ) {
      summaryRuntime._dfmExcelRefreshAbortController = null;
    }
  }
}

function canonicalExcelComparisonValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const scaled = Math.abs(number) * 1_000_000;
  const rounded = Math.floor(scaled + 0.5 + Number.EPSILON);
  return Math.sign(number || 1) * rounded / 1_000_000;
}

function excelFreshnessSourceKey(bookPath, sheet, cell) {
  return [
    String(bookPath || "").trim().toLowerCase(),
    String(sheet || "").trim().toLowerCase(),
    String(cell || "").trim().toUpperCase(),
  ].join("\u001f");
}

/**
 * Checks saved workbook values without mutating DFM rows, Excel caches, dirty
 * state, JSON, or rendering. All source cells are deduplicated into one batch.
 */
export async function checkDfmExcelLinkFreshness(options = {}) {
  cancelDfmExcelFreshnessCheck();
  const generation = summaryRuntime._dfmExcelFreshnessGeneration;
  const controller = new AbortController();
  summaryRuntime._dfmExcelFreshnessAbortController = controller;
  const signal = options.signal || controller.signal;
  const isCurrent = () => generation === summaryRuntime._dfmExcelFreshnessGeneration && !signal.aborted;
  const itemsByKey = new Map();
  const consumers = [];
  const columnCount = getCurrentRatioColumnCount();

  for (const cfg of summaryRowConfigs) {
    if (!isUserEntryConfig(cfg)) continue;
    const inputs = Array.isArray(cfg.inputs) ? cfg.inputs : [];
    inputs.forEach((rawInput, col) => {
      const inputRaw = String(rawInput || "").trim();
      if (!containsExcelRef(inputRaw)) return;
      const range = parseStandaloneExcelRange(inputRaw);
      if (range) {
        const sourceCells = buildExcelRangeSourceCells(range).flat();
        const targets = getDfmExternalLinkRangeTargets({
          rows: summaryRowConfigs,
          rowId: String(cfg.id),
          startColumn: col,
          range,
          columnCount,
          isUserEntry: isUserEntryConfig,
        });
        targets.forEach((target, index) => {
          const cell = sourceCells[index];
          const key = excelFreshnessSourceKey(range.bookPath, range.sheet, cell);
          if (!itemsByKey.has(key)) {
            itemsByKey.set(key, { book_path: range.bookPath, sheet: range.sheet, cell });
          }
          consumers.push({
            kind: "value",
            sourceKeys: [key],
            expected: getUserEntryValueForCol(target.cfg, target.col),
          });
        });
        return;
      }

      const refs = findExcelRefsInline(inputRaw.startsWith("=") ? inputRaw : `=${inputRaw}`);
      const sourceKeys = [];
      refs.forEach((ref) => {
        const key = excelFreshnessSourceKey(ref.bookPath, ref.sheet, ref.cell);
        sourceKeys.push(key);
        if (!itemsByKey.has(key)) {
          itemsByKey.set(key, { book_path: ref.bookPath, sheet: ref.sheet, cell: ref.cell });
        }
      });
      consumers.push({
        kind: "formula",
        sourceKeys,
        refs,
        inputRaw,
        col,
        expected: getUserEntryValueForCol(cfg, col),
      });
    });
  }

  if (!itemsByKey.size) {
    if (summaryRuntime._dfmExcelFreshnessAbortController === controller) summaryRuntime._dfmExcelFreshnessAbortController = null;
    return { ok: true, linkedCellCount: 0, staleCount: 0, unverifiedCount: 0 };
  }

  const entries = Array.from(itemsByKey.entries());
  try {
    const result = await readExcelCellsBatch(entries.map(([, item]) => item), { signal });
    if (!isCurrent()) return { ok: false, aborted: true, staleCount: 0, unverifiedCount: 0 };
    const values = new Map();
    entries.forEach(([key], index) => {
      const itemResult = result?.results?.[index];
      const value = Number(itemResult?.value);
      values.set(key, itemResult?.ok && Number.isFinite(value) ? value : null);
    });

    let staleCount = 0;
    let unverifiedCount = 0;
    const summaryTable = document.querySelector("#ratioWrap table.ratioSummaryTable");
    consumers.forEach((consumer) => {
      if (consumer.sourceKeys.some((key) => !Number.isFinite(values.get(key)))) {
        unverifiedCount += 1;
        return;
      }
      let freshValue = null;
      if (consumer.kind === "value") {
        freshValue = values.get(consumer.sourceKeys[0]);
      } else {
        let expression = consumer.inputRaw.startsWith("=")
          ? consumer.inputRaw
          : `=${consumer.inputRaw}`;
        consumer.refs.forEach((ref, index) => {
          expression = expression.split(ref.match).join(String(values.get(consumer.sourceKeys[index])));
        });
        freshValue = evaluateSimpleMathExpression(
          expression,
          summaryTable ? buildSummaryReferenceValues(summaryTable, consumer.col) : new Map(),
        );
      }
      const expected = canonicalExcelComparisonValue(consumer.expected);
      const actual = canonicalExcelComparisonValue(freshValue);
      if (!Number.isFinite(actual) || actual <= 0 || !Number.isFinite(expected)) {
        unverifiedCount += 1;
      } else if (actual !== expected) {
        staleCount += 1;
      }
    });
    return {
      ok: true,
      linkedCellCount: consumers.length,
      staleCount,
      unverifiedCount,
    };
  } catch (error) {
    if (error?.name === "AbortError" || !isCurrent()) {
      return { ok: false, aborted: true, staleCount: 0, unverifiedCount: 0 };
    }
    return {
      ok: false,
      linkedCellCount: consumers.length,
      staleCount: 0,
      unverifiedCount: consumers.length,
      error: String(error?.message || error || "Excel freshness check failed."),
    };
  } finally {
    if (summaryRuntime._dfmExcelFreshnessAbortController === controller) summaryRuntime._dfmExcelFreshnessAbortController = null;
  }
}


function collectDfmExternalLinkGroups() {
  return collectDfmExternalLinkGroupsModel({
    rows: summaryRowConfigs,
    columnCount: getCurrentRatioColumnCount(),
    isUserEntry: isUserEntryConfig,
  });
}

function dfmExternalTargetLabel(target, ratioLabels) {
  const rowLabel = String(target?.cfg?.label || target?.cfg?.id || "User Entry");
  const columnLabel = String(ratioLabels?.[target?.col] || `Column ${Number(target?.col) + 1}`);
  return `${rowLabel} / ${columnLabel}`;
}

export function getDfmExternalLinkRecords() {
  const ratioLabels = getRatioHeaderLabels(getEffectiveDevLabelsForModel(state?.model || {}));
  return Array.from(collectDfmExternalLinkGroups().values()).map((group) => {
    const targets = Array.from(group.targets.values());
    const labels = targets.map((target) => dfmExternalTargetLabel(target, ratioLabels));
    const destination = labels.length <= 1
      ? (labels[0] || "Ratios")
      : `${labels[0]} + ${labels.length - 1} more`;
    const start = String(group.reference.cell || "");
    const end = String(group.reference.endCell || start);
    const firstTarget = targets[0];
    const firstValue = firstTarget
      ? formatRatio(
        roundRatio(getUserEntryValueForCol(firstTarget.cfg, firstTarget.col), 6),
        getDfmDecimalPlaces(),
      )
      : "";
    return {
      id: group.id,
      workbookPath: group.reference.bookPath,
      worksheet: group.reference.sheet,
      address: start === end ? start : `${start}:${end}`,
      value: start !== end ? `${firstValue}...` : firstValue,
      destination,
      affectedCellCount: targets.length,
    };
  });
}

function hardCodeDfmUserEntryTarget(target) {
  const cfg = target?.cfg;
  const col = Number(target?.col);
  if (!cfg || !Number.isInteger(col) || col < 0 || !isUserEntryConfig(cfg)) return false;
  const value = roundRatio(getUserEntryValueForCol(cfg, col), 6);
  const inputs = normalizeUserEntryInputs(
    cfg.inputs ?? cfg.formulas,
    cfg.values,
    Math.max(getCurrentRatioColumnCount(), col + 1),
  );
  inputs[col] = String(value);
  cfg.inputs = inputs;
  if (Object.prototype.hasOwnProperty.call(cfg, "formulas")) delete cfg.formulas;
  return true;
}

export function breakDfmExternalLinks(ids) {
  const requestedIds = new Set(
    (Array.isArray(ids) ? ids : [ids]).map((id) => String(id || "")).filter(Boolean),
  );
  const groups = collectDfmExternalLinkGroups();
  const selectedGroups = Array.from(requestedIds)
    .map((id) => groups.get(id))
    .filter(Boolean);
  if (!selectedGroups.length) {
    return { ok: false, error: "The external link is no longer available." };
  }
  invalidateDfmExcelRefresh();
  const hardCodeTargets = new Map();
  selectedGroups.forEach((group) => {
    getDfmExternalLinkHardCodeTargets({
      group,
      rows: summaryRowConfigs,
      columnCount: getCurrentRatioColumnCount(),
      isUserEntry: isUserEntryConfig,
    }).forEach((target, key) => hardCodeTargets.set(key, target));
  });
  let affectedCellCount = 0;
  hardCodeTargets.forEach((target) => {
    if (hardCodeDfmUserEntryTarget(target)) affectedCellCount += 1;
  });
  if (!affectedCellCount) {
    return { ok: false, error: "No editable DFM cells are available for this link." };
  }
  persistUserEntryRowsFromState();
  summaryRuntime._renderRatioTable();
  summaryRuntime._onRatioStateMutated();
  return {
    ok: true,
    affectedCellCount,
    message: `${selectedGroups.length === 1 ? "Link" : `${selectedGroups.length} links`} broken. ${affectedCellCount} Ratios cell${affectedCellCount === 1 ? " is" : "s are"} now hard-coded.`,
  };
}

export function breakDfmExternalLink(id) {
  return breakDfmExternalLinks([id]);
}

function hideSummaryFormulaBar() {
  const el = document.getElementById("dfmSummaryFormulaBar");
  if (el) {
    clearSummaryFormulaBarValidationError();
    setSummaryFormulaBarMode("display", el.querySelector("#dfmSummaryFormulaBarInput"));
    el.classList.remove("fxVisible");
  }
}

function setUserEntryCellDisplayValue(cell, value) {
  if (!cell) return;
  cell.textContent = formatRatio(roundRatio(value, 6), getDfmDecimalPlaces());
  cell.classList.remove("na");
  cell.classList.remove("ratioPlaceholder");
  cell.classList.remove("strike");
  cell.classList.remove("excelLinked");
  cell.classList.add("userEntryEditable");
  cell.title = "";
}

function getExcelRangeDestination(summaryTable, rowId, startCol, range) {
  if (!summaryTable || !rowId || !Number.isFinite(startCol) || !range) {
    return { ok: false, error: "Excel range destination is unavailable." };
  }
  const rows = Array.from(summaryTable.querySelectorAll("tr[data-row-id]"));
  const anchorRow = summaryTable.querySelector(`tr[data-row-id="${CSS.escape(String(rowId))}"]`);
  const anchorRowIndex = rows.indexOf(anchorRow);
  if (anchorRowIndex < 0) return { ok: false, error: "Excel range anchor row is unavailable." };

  const entries = [];
  for (let rowOffset = 0; rowOffset < range.rowCount; rowOffset++) {
    const targetRow = rows[anchorRowIndex + rowOffset];
    if (!targetRow) {
      return { ok: false, error: "The Excel range extends beyond the available Average Formula rows." };
    }
    const targetRowId = String(targetRow.dataset.rowId || "");
    if (!isUserEntryConfig(summaryRowMap.get(targetRowId))) {
      return { ok: false, error: "Every row affected by an Excel range must be a User Entry row." };
    }
    for (let colOffset = 0; colOffset < range.colCount; colOffset++) {
      const col = Number(startCol) + colOffset;
      const cell = targetRow.querySelector(`td.summaryCell[data-col="${col}"]`);
      if (!cell) {
        return { ok: false, error: "The Excel range extends beyond the available development columns." };
      }
      entries.push({
        cell,
        rowId: targetRowId,
        col,
        rowOffset,
        colOffset,
        sourceCell: `${excelColumnFromIndex(range.col0 + colOffset)}${range.row0 + rowOffset + 1}`,
      });
    }
  }
  return { ok: true, entries };
}

function resetExcelRangeDestination(summaryTable, rowId, col, inputRaw, options = {}) {
  const range = parseStandaloneExcelRange(inputRaw);
  if (!range) return false;
  const destination = getExcelRangeDestination(summaryTable, rowId, col, range);
  if (!destination.ok) return false;
  const keepKeys = options.keepKeys instanceof Set ? options.keepKeys : new Set();
  let changed = false;
  destination.entries.forEach((entry) => {
    const key = `${entry.rowId},${entry.col}`;
    if (keepKeys.has(key)) return;
    setUserEntryCellEntry(entry.rowId, entry.col, "1", 1, { persist: false });
    setUserEntryCellDisplayValue(entry.cell, 1);
    changed = true;
  });
  return changed;
}

function restoreSupersededExcelRange(summaryTable, rowId, col, nextRaw, options = {}) {
  const cfg = summaryRowMap.get(String(rowId));
  if (!cfg || !isUserEntryConfig(cfg)) return false;
  const previousRaw = String(getUserEntryInputForCol(cfg, col) || "").trim();
  const previousRange = parseStandaloneExcelRange(previousRaw);
  if (!previousRange || previousRaw === String(nextRaw || "").trim()) return false;
  return resetExcelRangeDestination(summaryTable, rowId, col, previousRaw, options);
}

function addArrayFormulaOutlineClasses(cell, options = {}) {
  if (!cell) return;
  cell.classList.add("arArrayFormulaCell");
  if (options.active) cell.classList.add("arArrayFormulaActive");
  if (options.top) cell.classList.add("arArrayFormulaEdgeTop");
  if (options.right) cell.classList.add("arArrayFormulaEdgeRight");
  if (options.bottom) cell.classList.add("arArrayFormulaEdgeBottom");
  if (options.left) cell.classList.add("arArrayFormulaEdgeLeft");
}

function getSummaryArrayFormulaDestination(summaryTable, rowId, startCol, itemCount) {
  const row = summaryTable?.querySelector(`tr[data-row-id="${CSS.escape(String(rowId))}"]`);
  const availableCells = Array.from(row?.querySelectorAll("td.summaryCell[data-col]") || [])
    .map((cell) => ({ cell, col: Number(cell.dataset.col) }))
    .filter((item) => Number.isFinite(item.col) && item.col >= startCol)
    .sort((a, b) => a.col - b.col);
  const count = Math.min(Math.max(0, Number(itemCount) || 0), availableCells.length);
  return { entries: availableCells.slice(0, count) };
}

function applyExcelRangeHighlights(summaryTable) {
  if (!summaryTable) return;
  const activeCell = summaryTable.querySelector("td.summaryCell.summaryActiveCell");
  summaryTable.querySelectorAll("td.excelRangeAffected, td.arArrayFormulaCell").forEach((cell) => {
    cell.classList.remove(
      "excelRangeAffected",
      "excelRangeActive",
      "excelRangeSpillCell",
      "excelRangeBridgeCell",
      "excelRangeEdgeTop",
      "excelRangeEdgeRight",
      "excelRangeEdgeBottom",
      "excelRangeEdgeLeft",
      "arArrayFormulaCell",
      "arArrayFormulaActive",
      "arArrayFormulaEdgeTop",
      "arArrayFormulaEdgeRight",
      "arArrayFormulaEdgeBottom",
      "arArrayFormulaEdgeLeft",
    );
    delete cell.dataset.excelRangeFormula;
    delete cell.dataset.excelRangeAnchorRowId;
    delete cell.dataset.excelRangeAnchorCol;
    if (!cell.classList.contains("excelLinked")) cell.title = "";
  });

  summaryRowConfigs.forEach((cfg) => {
    if (!isUserEntryConfig(cfg)) return;
    const rowId = String(cfg?.id || "");
    const inputs = Array.isArray(cfg?.inputs) ? cfg.inputs : [];
    inputs.forEach((inputRaw, col) => {
      const raw = String(inputRaw || "").trim();
      const parsedArray = parseSummaryArrayFormula(raw);
      if (parsedArray) {
        if (!parsedArray.ok) return;
        const arrayDestination = getSummaryArrayFormulaDestination(
          summaryTable,
          rowId,
          col,
          parsedArray.expressions.length,
        );
        const lastIndex = arrayDestination.entries.length - 1;
        if (lastIndex < 0) return;
        const arrayIsActive = arrayDestination.entries.some((entry) => entry.cell === activeCell);
        arrayDestination.entries.forEach((entry, index) => {
          addArrayFormulaOutlineClasses(entry.cell, {
            active: arrayIsActive,
            top: true,
            right: index === lastIndex,
            bottom: true,
            left: index === 0,
          });
          if (index <= 0) return;
          const bridgeCell = entry.cell.previousElementSibling;
          if (bridgeCell?.classList?.contains("ratioDataSpacer")) {
            addArrayFormulaOutlineClasses(bridgeCell, {
              active: arrayIsActive,
              top: true,
              bottom: true,
            });
          }
        });
        return;
      }
      const range = parseStandaloneExcelRange(raw);
      if (!range) return;
      const destination = getExcelRangeDestination(summaryTable, rowId, col, range);
      if (!destination.ok) return;
      const rangeIsActive = destination.entries.some((entry) => entry.cell === activeCell);
      destination.entries.forEach((entry) => {
        const isAnchor = entry.rowOffset === 0 && entry.colOffset === 0;
        entry.cell.classList.add("excelRangeAffected");
        addArrayFormulaOutlineClasses(entry.cell, {
          active: rangeIsActive,
          top: entry.rowOffset === 0,
          right: entry.colOffset === range.colCount - 1,
          bottom: entry.rowOffset === range.rowCount - 1,
          left: entry.colOffset === 0,
        });
        if (!isAnchor) entry.cell.classList.add("excelRangeSpillCell");
        if (rangeIsActive) entry.cell.classList.add("excelRangeActive");
        if (entry.rowOffset === 0) entry.cell.classList.add("excelRangeEdgeTop");
        if (entry.colOffset === range.colCount - 1) entry.cell.classList.add("excelRangeEdgeRight");
        if (entry.rowOffset === range.rowCount - 1) entry.cell.classList.add("excelRangeEdgeBottom");
        if (entry.colOffset === 0) entry.cell.classList.add("excelRangeEdgeLeft");
        entry.cell.dataset.excelRangeFormula = raw;
        entry.cell.dataset.excelRangeAnchorRowId = rowId;
        entry.cell.dataset.excelRangeAnchorCol = String(col);
        entry.cell.title = "";

        if (entry.colOffset > 0) {
          const bridgeCell = entry.cell.previousElementSibling;
          if (bridgeCell?.classList?.contains("ratioDataSpacer")) {
            bridgeCell.classList.add("excelRangeAffected", "excelRangeBridgeCell");
            addArrayFormulaOutlineClasses(bridgeCell, {
              active: rangeIsActive,
              top: entry.rowOffset === 0,
              bottom: entry.rowOffset === range.rowCount - 1,
            });
            if (rangeIsActive) bridgeCell.classList.add("excelRangeActive");
            if (entry.rowOffset === 0) bridgeCell.classList.add("excelRangeEdgeTop");
            if (entry.rowOffset === range.rowCount - 1) bridgeCell.classList.add("excelRangeEdgeBottom");
          }
        }
      });
    });
  });
}

async function readExcelRangeValues(range, options = {}) {
  const items = buildExcelRangeSourceCells(range).flat().map((cell) => ({
    book_path: range.bookPath,
    sheet: range.sheet,
    cell,
  }));
  const result = await readExcelCellsBatch(items, { signal: options.signal });
  if (!result?.ok || !Array.isArray(result.results)) {
    return { ok: false, error: result?.error || "Excel range refresh failed." };
  }
  const values = [];
  for (let index = 0; index < items.length; index++) {
    const itemResult = result.results[index];
    const value = Number(itemResult?.value);
    if (!itemResult?.ok || !Number.isFinite(value) || value <= 0) {
      return {
        ok: false,
        error: itemResult?.error || `Excel cell ${items[index].cell} must contain a number greater than 0.`,
      };
    }
    values.push(roundRatio(value, 6));
  }
  return { ok: true, values };
}

function applyResolvedExcelRange(summaryTable, selectedTable, rowId, col, raw, range, destination, values) {
  const nextKeys = new Set(destination.entries.map((entry) => `${entry.rowId},${entry.col}`));
  destination.entries.forEach((entry) => {
    if (entry.rowId === String(rowId) && entry.col === Number(col)) return;
    restoreSupersededExcelRange(summaryTable, entry.rowId, entry.col, "1");
  });
  restoreSupersededExcelRange(summaryTable, rowId, col, raw, { keepKeys: nextKeys });
  let changedCount = 0;
  destination.entries.forEach((entry, index) => {
    const cfg = summaryRowMap.get(entry.rowId);
    const currentValue = getUserEntryValueForCol(cfg, entry.col);
    const value = values[index];
    if (Math.abs(currentValue - value) > 1e-10) changedCount += 1;
    const input = entry.rowId === String(rowId) && entry.col === Number(col) ? raw : String(value);
    setUserEntryCellEntry(entry.rowId, entry.col, input, value, { persist: false });
    setUserEntryCellDisplayValue(entry.cell, value);
  });
  persistUserEntryRowsFromState();
  if (selectedTable) ensureSelectedRowValues(summaryTable, selectedTable);
  applyUserEntryReferenceHighlights(summaryTable);
  applyExcelRangeHighlights(summaryTable);
  return changedCount;
}

async function commitExcelRangeFormulaAsync(rowId, col, raw, range, options = {}) {
  try {
    const summaryTable = document.querySelector("#ratioWrap table.ratioSummaryTable");
    const selectedTable = document.querySelector("#ratioWrap table.ratioSelectedTable");
    const destination = getExcelRangeDestination(summaryTable, rowId, col, range);
    if (!destination.ok) throw new Error(destination.error);
    const readResult = await readExcelRangeValues(range, { signal: options.signal });
    if (options.isCurrent && !options.isCurrent()) return false;
    if (!readResult.ok) throw new Error(readResult.error);
    applyResolvedExcelRange(summaryTable, selectedTable, rowId, col, raw, range, destination, readResult.values);
    const anchor = destination.entries[0]?.cell || null;
    if (anchor) {
      anchor.classList.add("excelLinked");
      anchor.title = "";
    }
    clearSummaryReferenceUi(summaryTable);
    summaryRuntime.summaryFormulaEditState = null;
    updateSummaryFormulaBarForCell(anchor);
    summaryRuntime._onRatioStateMutated();
    setStatusBarText(`Excel range linked: ${destination.entries.length} cells refreshed.`);
    return true;
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    showSummaryFormulaBarValidationError(error?.message || "Could not read the Excel range.");
    return false;
  }
}

registerSummaryFunctions({
  resolveExcelRefsInExpression,
  cancelDfmExcelFreshnessCheck,
  invalidateDfmExcelRefresh,
  dfmExternalInputStillMatches,
  commitExcelFormulaAsync,
  refreshAllExcelLinks,
  canonicalExcelComparisonValue,
  excelFreshnessSourceKey,
  checkDfmExcelLinkFreshness,
  collectDfmExternalLinkGroups,
  dfmExternalTargetLabel,
  getDfmExternalLinkRecords,
  hardCodeDfmUserEntryTarget,
  breakDfmExternalLinks,
  breakDfmExternalLink,
  hideSummaryFormulaBar,
  setUserEntryCellDisplayValue,
  getExcelRangeDestination,
  resetExcelRangeDestination,
  restoreSupersededExcelRange,
  addArrayFormulaOutlineClasses,
  getSummaryArrayFormulaDestination,
  applyExcelRangeHighlights,
  readExcelRangeValues,
  applyResolvedExcelRange,
  commitExcelRangeFormulaAsync,
});

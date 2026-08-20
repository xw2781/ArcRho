/*
===============================================================================
DFM Ratios Summary Excel Link Validation
===============================================================================
Answers the two questions a DFM method asks its saved Excel links when it
opens: is every stored reference still readable, and does every stored value
still match the workbook. A reference the workbook refuses - a renamed sheet,
a deleted row that left a #REF!, a workbook that moved - is reported by name
and recorded against the User Entry cell it feeds, so that cell reads red and
keeps its saved ratio until the reference is fixed; a value that merely drifted
stays a count. Nothing here mutates DFM rows, caches, dirty state, or JSON.
*/
import {
  registerSummaryFunctions,
  summaryRuntime,
} from "/ui/method_pages/dfm/ratios_summary/summary_runtime.js?v=20260819a";

const {
  state, summaryRowConfigs, summaryRowMap,
  getEffectiveDevLabelsForModel, getRatioHeaderLabels,
  readExcelCellsBatch,
  buildExcelRangeSourceCells, containsExcelRef, findExcelRefsInline, parseStandaloneExcelRange,
  getDfmExternalLinkRangeTargets,
} = summaryRuntime;

// Registered by their owning modules after this one loads, so they are reached
// through the runtime rather than captured at import time.
const isUserEntryConfig = (...args) => summaryRuntime.isUserEntryConfig(...args);
const getCurrentRatioColumnCount = (...args) => summaryRuntime.getCurrentRatioColumnCount(...args);
const getUserEntryValueForCol = (...args) => summaryRuntime.getUserEntryValueForCol(...args);
const evaluateSimpleMathExpression = (...args) => summaryRuntime.evaluateSimpleMathExpression(...args);
const buildSummaryReferenceValues = (...args) => summaryRuntime.buildSummaryReferenceValues(...args);

export function dfmExcelInvalidTargetKey(rowId, col) {
  return `${String(rowId)}\u001f${Number(col)}`;
}

export function currentRatioHeaderLabels() {
  return getRatioHeaderLabels(getEffectiveDevLabelsForModel(state?.model || {}));
}

export function dfmTargetDestinationLabel(rowId, col, ratioLabels) {
  const cfg = summaryRowMap.get(String(rowId));
  const rowLabel = String(cfg?.label || cfg?.id || rowId || "User Entry");
  const columnLabel = String(ratioLabels?.[Number(col)] || `Column ${Number(col) + 1}`);
  return `${rowLabel} / ${columnLabel}`;
}

/**
 * Paints every User Entry cell whose Excel reference failed validation red.
 *
 * The map is the record, not the class: a re-render rebuilds the cells and
 * `updateRatioSummary` reads the same map, so a broken reference keeps saying
 * so until it is fixed, refreshed, or the formula is replaced.
 */
export function applyDfmExcelInvalidHighlights(summaryTable = null) {
  const table = summaryTable
    || document.querySelector("#ratioWrap table.ratioSummaryTable");
  if (!table) return;
  table.querySelectorAll("td.summaryCell.excelLinkError")
    .forEach((cell) => cell.classList.remove("excelLinkError"));
  summaryRuntime._dfmExcelInvalidTargets.forEach((_failure, key) => {
    const [rowId, col] = key.split("\u001f");
    table
      .querySelector(`td.summaryCell[data-r="${CSS.escape(rowId)}"][data-col="${col}"]`)
      ?.classList.add("excelLinkError");
  });
}

export function getDfmExcelLinkFailures() {
  return Array.from(summaryRuntime._dfmExcelInvalidTargets.values())
    .map((failure) => ({ ...failure }));
}

export function setDfmExcelInvalidTargets(invalidTargets) {
  summaryRuntime._dfmExcelInvalidTargets = invalidTargets;
  applyDfmExcelInvalidHighlights();
}

export function clearDfmExcelLinkFailures() {
  if (!summaryRuntime._dfmExcelInvalidTargets.size) return;
  setDfmExcelInvalidTargets(new Map());
}

export function cancelDfmExcelFreshnessCheck() {
  summaryRuntime._dfmExcelFreshnessGeneration += 1;
  summaryRuntime._dfmExcelFreshnessAbortController?.abort?.();
  summaryRuntime._dfmExcelFreshnessAbortController = null;
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
 * state, or JSON. All source cells are deduplicated into one batch.
 *
 * The only thing it writes is the broken-reference marking: a cell whose source
 * the workbook refused keeps its saved ratio and turns red, and one that reads
 * again loses the marking.
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
            rowId: String(target.cfg?.id || ""),
            col: target.col,
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
        rowId: String(cfg.id),
        col,
        expected: getUserEntryValueForCol(cfg, col),
      });
    });
  }

  if (!itemsByKey.size) {
    if (summaryRuntime._dfmExcelFreshnessAbortController === controller) summaryRuntime._dfmExcelFreshnessAbortController = null;
    clearDfmExcelLinkFailures();
    return { ok: true, linkedCellCount: 0, staleCount: 0, unverifiedCount: 0, invalidCount: 0, invalidLinks: [] };
  }

  const entries = Array.from(itemsByKey.entries());
  try {
    const result = await readExcelCellsBatch(entries.map(([, item]) => item), { signal });
    if (!isCurrent()) return { ok: false, aborted: true, staleCount: 0, unverifiedCount: 0, invalidLinks: [] };
    const values = new Map();
    // A cell the workbook refused - a renamed sheet, a deleted row that left a
    // #REF!, a workbook that moved - is a broken reference, not a value that
    // merely could not be compared, so its reason is kept and reported.
    const errors = new Map();
    entries.forEach(([key], index) => {
      const itemResult = result?.results?.[index];
      const value = Number(itemResult?.value);
      values.set(key, itemResult?.ok && Number.isFinite(value) ? value : null);
      if (itemResult && itemResult.ok === false) {
        errors.set(key, String(itemResult.error || "The linked cell could not be read."));
      }
    });

    let staleCount = 0;
    let unverifiedCount = 0;
    const invalidLinks = [];
    const invalidTargets = new Map();
    const ratioLabels = currentRatioHeaderLabels();
    const summaryTable = document.querySelector("#ratioWrap table.ratioSummaryTable");
    consumers.forEach((consumer) => {
      const brokenKey = consumer.sourceKeys.find((key) => errors.has(key));
      if (brokenKey) {
        const item = itemsByKey.get(brokenKey);
        const failure = {
          workbookPath: String(item?.book_path || ""),
          worksheet: String(item?.sheet || ""),
          sourceCell: String(item?.cell || ""),
          destination: dfmTargetDestinationLabel(consumer.rowId, consumer.col, ratioLabels),
          error: errors.get(brokenKey),
        };
        invalidLinks.push(failure);
        invalidTargets.set(dfmExcelInvalidTargetKey(consumer.rowId, consumer.col), failure);
        return;
      }
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
    setDfmExcelInvalidTargets(invalidTargets);
    return {
      ok: true,
      linkedCellCount: consumers.length,
      staleCount,
      unverifiedCount,
      invalidCount: invalidLinks.length,
      invalidLinks,
    };
  } catch (error) {
    if (error?.name === "AbortError" || !isCurrent()) {
      return { ok: false, aborted: true, staleCount: 0, unverifiedCount: 0, invalidLinks: [] };
    }
    return {
      ok: false,
      linkedCellCount: consumers.length,
      staleCount: 0,
      unverifiedCount: consumers.length,
      invalidCount: 0,
      invalidLinks: [],
      error: String(error?.message || error || "Excel freshness check failed."),
    };
  } finally {
    if (summaryRuntime._dfmExcelFreshnessAbortController === controller) summaryRuntime._dfmExcelFreshnessAbortController = null;
  }
}

registerSummaryFunctions({
  applyDfmExcelInvalidHighlights,
  cancelDfmExcelFreshnessCheck,
  canonicalExcelComparisonValue,
  checkDfmExcelLinkFreshness,
  clearDfmExcelLinkFailures,
  excelFreshnessSourceKey,
  getDfmExcelLinkFailures,
});

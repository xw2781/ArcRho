import { summaryRuntime } from "/ui/method_pages/dfm/ratios_summary/summary_runtime.js?v=20260914b";
import { filterPatternColumns, isPatternColumnActive } from "/ui/method_pages/dfm/dfm_pattern_columns.js";

const CLIPBOARD_KEY = "dfmSelectedFormulaPatterns";

function warn(text) {
  window.parent.postMessage({ type: "arcrho:status", text, tone: "warn" }, "*");
}

export function copySelectedFormulaPatterns() {
  const { matrix } = summaryRuntime.buildAverageSelectionPayload();
  if (!matrix.length || !matrix[0].length) {
    warn("No selected formula patterns to copy.");
    return;
  }
  localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(filterPatternColumns(matrix)));
}

export function applySelectedFormulaPatterns() {
  if (!summaryRuntime.isRatioEditMode()) return;
  const stored = localStorage.getItem(CLIPBOARD_KEY);
  if (!stored) {
    warn("Copy selected formula patterns first.");
    return;
  }
  let pattern;
  try {
    pattern = JSON.parse(stored);
  } catch {
    warn("Invalid selected formula patterns.");
    return;
  }
  if (!Array.isArray(pattern)) {
    warn("Invalid selected formula patterns.");
    return;
  }
  const { matrix } = summaryRuntime.buildAverageSelectionPayload();
  let unmatched = pattern.length !== matrix.length;
  const selections = new Map();
  for (let r = 0; r < matrix.length; r++) {
    const row = Array.isArray(pattern[r]) ? pattern[r] : [];
    if (row.length !== matrix[r].length) unmatched = true;
    for (let c = 0; c < Math.min(row.length, matrix[r].length); c++) {
      if (!isPatternColumnActive(c)) continue;
      if (row[c] === 1) selections.set(c, String(summaryRuntime.summaryRowConfigs[r].id));
    }
  }
  if (selections.size) {
    summaryRuntime.beginRatioHistoryAction("apply-selected-formula-patterns");
    selections.forEach((rowId, col) => summaryRuntime.selectedSummaryByCol.set(col, rowId));
    summaryRuntime._renderRatioTable();
    summaryRuntime._onRatioStateMutated();
    summaryRuntime.commitRatioHistoryAction("apply-selected-formula-patterns");
  }
  if (unmatched) warn("Selected formula patterns applied; unmatched cells ignored.");
}

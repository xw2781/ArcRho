import { activeRatioCols, getRatioColAllActive } from "/ui/method_pages/dfm/dfm_state.js";

export function isPatternColumnActive(col) {
  return getRatioColAllActive() || activeRatioCols.size === 0 || activeRatioCols.has(col);
}

export function filterPatternColumns(pattern) {
  // Keep original coordinates; null means this column was not copied.
  return pattern.map((row) => row.map((value, col) => isPatternColumnActive(col) ? value : null));
}

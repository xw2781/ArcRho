import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../ui/method_pages/dfm/", import.meta.url);
const source = await readFile(new URL("ratios_summary/summary_patterns.js", root), "utf8");
const columnSource = await readFile(new URL("dfm_pattern_columns.js", root), "utf8");
const modelSource = await readFile(new URL("ratios_summary/summary_model.js", root), "utf8");
const builder = modelSource.slice(
  modelSource.indexOf("export function buildAverageSelectionPayload"),
  modelSource.indexOf("export function applyRatioSelectionPattern"),
).replace("export ", "");

function createDfm(storage, ids, selected, edit = true, highlighted = [], allActive = false) {
  const messages = [];
  const actions = [];
  const runtime = {
    summaryRowConfigs: ids.map((id) => ({ id, label: id })),
    selectedSummaryByCol: new Map(selected.map((row, col) => [col, ids[row]])),
    isRatioEditMode: () => edit,
    beginRatioHistoryAction: () => actions.push("begin"),
    commitRatioHistoryAction: () => actions.push("commit"),
    _renderRatioTable: () => actions.push("render"),
    _onRatioStateMutated: () => actions.push("dirty"),
  };
  runtime.buildAverageSelectionPayload = new Function(
    "state", "getEffectiveDevLabelsForModel", "getRatioHeaderLabels", "summaryRowConfigs", "selectedSummaryByCol",
    `${builder}\nreturn buildAverageSelectionPayload;`,
  )({ model: { values: [], mask: [] } }, () => [], () => selected,
    runtime.summaryRowConfigs, runtime.selectedSummaryByCol);
  const columns = new Function("activeRatioCols", "getRatioColAllActive",
    columnSource.replace(/^import .*;\r?\n/u, "").replaceAll("export function", "function")
      + "\nreturn { filterPatternColumns, isPatternColumnActive };",
  )(new Set(highlighted), () => allActive);
  const api = new Function("summaryRuntime", "localStorage", "window", "filterPatternColumns", "isPatternColumnActive",
    source.replace(/^import .*;\r?\n/gmu, "").replaceAll("export function", "function")
      + "\nreturn { copySelectedFormulaPatterns, applySelectedFormulaPatterns };",
  )(runtime, { setItem: (key, value) => storage.set(key, value), getItem: (key) => storage.get(key) },
    { parent: { postMessage: (message) => messages.push(message) } }, columns.filterPatternColumns, columns.isPatternColumnActive);
  return { ...api, runtime, messages, actions, selected: () => [...runtime.selectedSummaryByCol.values()] };
}

test("copy transfers green selections by position to another DFM and preserves extra columns", () => {
  const storage = new Map();
  const source = createDfm(storage, ["source-a", "source-b"], [1, 0]);
  source.copySelectedFormulaPatterns();
  const target = createDfm(storage, ["target-a", "target-b", "target-c"], [0, 1, 2]);
  target.applySelectedFormulaPatterns();
  assert.deepEqual(target.selected(), ["target-b", "target-a", "target-c"]);
  assert.deepEqual(target.actions, ["begin", "render", "dirty", "commit"]);
  assert.deepEqual(target.messages, [{
    type: "arcrho:status", text: "Selected formula patterns applied; unmatched cells ignored.", tone: "warn",
  }]);
});

test("selected rows and columns outside the target are ignored without clearing its selection", () => {
  const storage = new Map();
  createDfm(storage, ["a", "b", "c"], [2, 0, 1]).copySelectedFormulaPatterns();
  const target = createDfm(storage, ["x", "y"], [1, 1]);
  target.applySelectedFormulaPatterns();
  assert.deepEqual(target.selected(), ["y", "x"]);
  assert.equal(target.messages.length, 1);
});

test("matching table sizes apply silently without modifying row definitions", () => {
  const storage = new Map();
  createDfm(storage, ["a", "b"], [1, 0]).copySelectedFormulaPatterns();
  const target = createDfm(storage, ["x", "y"], [0, 1]);
  const rows = structuredClone(target.runtime.summaryRowConfigs);
  target.applySelectedFormulaPatterns();
  assert.deepEqual(target.selected(), ["y", "x"]);
  assert.deepEqual(target.runtime.summaryRowConfigs, rows);
  assert.deepEqual(target.messages, []);
});

test("Select mode cannot mutate selected formula patterns", () => {
  const storage = new Map();
  createDfm(storage, ["a", "b"], [1]).copySelectedFormulaPatterns();
  const target = createDfm(storage, ["x", "y"], [0], false);
  target.applySelectedFormulaPatterns();
  assert.deepEqual(target.selected(), ["x"]);
  assert.deepEqual(target.actions, []);
});

test("no overlapping selected row leaves the target unchanged and warns", () => {
  const storage = new Map();
  createDfm(storage, ["a", "b"], [1]).copySelectedFormulaPatterns();
  const target = createDfm(storage, ["x"], [0]);
  target.applySelectedFormulaPatterns();
  assert.deepEqual(target.selected(), ["x"]);
  assert.deepEqual(target.actions, []);
  assert.equal(target.messages[0].tone, "warn");
});

test("summary copy and apply use the intersection of highlighted columns", () => {
  const storage = new Map();
  createDfm(storage, ["a", "b"], [1, 1, 1], true, [0, 2]).copySelectedFormulaPatterns();
  const target = createDfm(storage, ["x", "y"], [0, 0, 0], true, [1, 2]);
  target.applySelectedFormulaPatterns();
  assert.deepEqual(target.selected(), ["x", "x", "y"]);
  assert.deepEqual(target.messages, []);
});

test("summary paste with no highlights applies every copied column", () => {
  const storage = new Map();
  createDfm(storage, ["a", "b"], [1, 1, 1], true, [0, 2]).copySelectedFormulaPatterns();
  const target = createDfm(storage, ["x", "y"], [0, 0, 0]);
  target.applySelectedFormulaPatterns();
  assert.deepEqual(target.selected(), ["y", "x", "y"]);
});

test("all-column highlighting includes the summary's final column", () => {
  const storage = new Map();
  createDfm(storage, ["a", "b"], [1, 1, 1], true, [], true).copySelectedFormulaPatterns();
  const target = createDfm(storage, ["x", "y"], [0, 0, 0], true, [], true);
  target.applySelectedFormulaPatterns();
  assert.deepEqual(target.selected(), ["y", "y", "y"]);
});

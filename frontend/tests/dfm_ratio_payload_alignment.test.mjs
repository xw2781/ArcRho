import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The DFM method payload carries the ratio triangle and the exclusion pattern as
// two matrices that a strict contract requires to have identical row lengths
// (`DFM exclusion rows must match the corresponding ratio-value rows`). They are
// produced by two builders that live in different modules, so this suite runs
// both against one model and compares the shapes they emit.

const root = new URL("../", import.meta.url);
const source = async (path) => readFile(new URL(path, root), "utf8");

const [persistenceSource, summarySource, stateSource, ratiosTabSource] = await Promise.all([
  source("ui/method_pages/dfm/dfm_persistence.js"),
  source("ui/method_pages/dfm/ratios_summary/summary_model.js"),
  source("ui/method_pages/dfm/dfm_state.js"),
  source("ui/method_pages/dfm/dfm_ratios_tab.js"),
]);
const { calcRatio, ratioNumberOrNull } = await import(
  new URL("ui/method_pages/dfm/dfm_ratio_calc.js", root)
);
const columnSource = await source("ui/method_pages/dfm/dfm_pattern_columns.js");
function patternColumns(activeCols = [], allActive = false) {
  return new Function("activeRatioCols", "getRatioColAllActive",
    columnSource.replace(/^import .*;\r?\n/u, "").replaceAll("export function", "function")
      + "\nreturn { filterPatternColumns, isPatternColumnActive };",
  )(new Set(activeCols), () => allActive);
}

function functionSlice(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return text.slice(start, end).replace(/^export /gmu, "");
}

const devLabelHelpers = [
  functionSlice(stateSource, "export function getEffectiveDevLabelsForModel", "export function toLabelNum"),
  functionSlice(stateSource, "export function toLabelNum", "export function getRatioHeaderLabels"),
  functionSlice(stateSource, "export function getRatioHeaderLabels", "export function getOriginLabelTextForRatio"),
].join("\n");

function loadAnalysisValue() {
  const slice = functionSlice(persistenceSource, "function analysisValue", "function trimTrailingNulls");
  return new Function(
    "ratioNumberOrNull",
    `${slice}\nreturn analysisValue;`,
  )(ratioNumberOrNull);
}

function loadPersistedSnapshotReader() {
  const slice = [
    functionSlice(ratiosTabSource, "let persistedRatioTriangleValues = null;", "export function applyPersistedRatioDerivedSnapshot"),
    functionSlice(ratiosTabSource, "export function applyPersistedRatioDerivedSnapshot", "export {"),
  ].join("\n");
  return new Function(
    "ratioNumberOrNull",
    `${slice}\nreturn { applyPersistedRatioDerivedSnapshot, read: () => persistedRatioTriangleValues };`,
  )(ratioNumberOrNull);
}

function loadRatioValuesBuilder(state) {
  const slice = [
    functionSlice(persistenceSource, "function analysisValue", "function trimTrailingNulls"),
    functionSlice(persistenceSource, "function trimTrailingNulls", "function normalizeSummaryUserEntryValue"),
    functionSlice(
      persistenceSource,
      "function buildCalculatedRatioTriangleValues",
      "function trimMatrixToReferenceRowShape",
    ),
    devLabelHelpers,
  ].join("\n");
  return new Function(
    "state",
    "calcRatio",
    "ratioNumberOrNull",
    `${slice}\nreturn buildCalculatedRatioTriangleValues;`,
  )(state, calcRatio, ratioNumberOrNull);
}

function loadPatternBuilder(state, ratioStrikeSet) {
  const slice = [
    functionSlice(summarySource, "function trimTrailingMaskCells", "export function buildRatioSelectionPattern"),
    functionSlice(summarySource, "export function buildRatioSelectionPattern", "export function buildAverageSelectionPayload"),
    devLabelHelpers,
  ].join("\n");
  return new Function(
    "state",
    "calcRatio",
    "ratioStrikeSet",
    `${slice}\nreturn buildRatioSelectionPattern;`,
  )(state, calcRatio, ratioStrikeSet);
}

// Row 0 is an all-zero origin, row 1 goes to zero part way across, row 2 is
// ordinary data. A zero left value has no ratio, which is exactly the case the
// two builders used to disagree about.
const MODEL = {
  origin_labels: ["2026 Q1", "2026 Q2", "2026 Q3"],
  dev_labels: ["3", "6", "9", "12"],
  values: [
    [0, 0, 0, 0],
    [2.461532, 11.924039, 0, 0],
    [10, 20, 40, 80],
  ],
  mask: [
    [true, true, true, true],
    [true, true, true, true],
    [true, true, true, true],
  ],
};

test("a null ratio stays null instead of rounding to zero", () => {
  const analysisValue = loadAnalysisValue();
  // calcRatio returns null when there is no ratio to compute; Number(null) is 0
  // and finite, so an unguarded finite check turns that null into a real 0.
  assert.equal(calcRatio(0, 5), null);
  assert.equal(analysisValue(calcRatio(0, 5)), null);
  assert.equal(analysisValue(null), null);
  assert.equal(analysisValue(undefined), null);
  assert.equal(analysisValue(""), null);
  assert.equal(analysisValue(0), 0);
  // A zero later value is no ratio either: the origin has nothing to develop
  // from, so the cell reads as the muted placeholder and no average uses it.
  assert.equal(calcRatio(5, 0), null);
  assert.equal(analysisValue(calcRatio(5, 0)), null);
  // The ratio is kept whole rather than trimmed to six decimals.
  assert.equal(analysisValue(calcRatio(2.461532, 11.924039)), 11.924039 / 2.461532);
});

test("ratio-value rows and exclusion rows keep matching lengths", () => {
  const state = { model: MODEL };
  const buildCalculatedRatioTriangleValues = loadRatioValuesBuilder(state);
  const buildRatioSelectionPattern = loadPatternBuilder(state, new Set(["2,0"]));

  const ratioValues = buildCalculatedRatioTriangleValues();
  const pattern = buildRatioSelectionPattern();

  assert.equal(ratioValues.length, MODEL.origin_labels.length);
  assert.equal(pattern.length, MODEL.origin_labels.length);
  for (let row = 0; row < MODEL.origin_labels.length; row++) {
    assert.equal(
      ratioValues[row].length,
      pattern[row].length,
      `row ${row} (${MODEL.origin_labels[row]}) shapes disagree: `
        + `${JSON.stringify(ratioValues[row])} vs ${JSON.stringify(pattern[row])}`,
    );
  }
  // An all-zero origin has no ratios at all, so it must not fabricate any.
  assert.deepEqual(ratioValues[0], []);
  // The second origin develops once and then holds zero, so its one ratio is
  // followed by nothing rather than by a ratio of zero.
  assert.deepEqual(ratioValues[1], [11.924039 / 2.461532]);
  assert.deepEqual(ratioValues[2], [2, 2, 2]);
  assert.deepEqual(pattern[2], [1, 0, 0]);
});

test("a stored null ratio renders as the grey placeholder, not a ratio of 0", () => {
  const snapshot = loadPersistedSnapshotReader();
  // A persisted row keeps interior nulls: this is the shape a saved method holds
  // for an origin whose first development period is zero.
  snapshot.applyPersistedRatioDerivedSnapshot({ "ratio_values": [[null, 1, 1.25]] });
  assert.deepEqual(snapshot.read(), [[null, 1, 1.25]]);

  // renderRatioTable keeps a persisted ratio only while it is finite, so the null
  // cell falls through to calcRatio and lands on the grey 1.0000 placeholder that
  // every other cell without a ratio uses.
  assert.equal(Number.isFinite(snapshot.read()[0][0]), false);
  assert.match(ratiosTabSource, /const ratio = Number\.isFinite\(persistedRatio\)/u);
  assert.match(ratiosTabSource, /td\.classList\.add\("ratioPlaceholder"\);/u);
});

test("the canonical ratio reader never turns an empty cell into a zero", () => {
  assert.equal(ratioNumberOrNull(null), null);
  assert.equal(ratioNumberOrNull(undefined), null);
  assert.equal(ratioNumberOrNull(""), null);
  assert.equal(ratioNumberOrNull("nope"), null);
  assert.equal(ratioNumberOrNull(0), 0);
  assert.equal(ratioNumberOrNull("1.25"), 1.25);
});

function pastePattern(pattern, currentPattern, strikes = [], activeCols = []) {
  const ratioStrikeSet = new Set(strikes);
  const messages = [];
  const actions = [];
  const bindings = {
    state: { model: { values: [], mask: [] } },
    ratioStrikeSet,
    window: { parent: { postMessage: (message) => messages.push(message) } },
    localStorage: { getItem: () => JSON.stringify(pattern) },
    isRatioEditMode: () => true,
    clearRatioActionError: () => {},
    buildRatioSelectionPattern: () => currentPattern,
    ...patternColumns(activeCols),
    beginRatioHistoryAction: () => actions.push("begin"),
    commitRatioHistoryAction: () => actions.push("commit"),
    renderRatioTable: () => actions.push("render"),
    scheduleRatioSummaryUpdate: () => actions.push("summary"),
    onRatioStateMutated: () => actions.push("dirty"),
  };
  const slice = functionSlice(ratiosTabSource, "function showRatioPatternWarning", "// Ratio Column Activation");
  new Function(...Object.keys(bindings), `${slice}\napplyRatioPatternsFromClipboard();`)(...Object.values(bindings));
  assert.deepEqual(actions, ["begin", "render", "summary", "dirty", "commit"]);
  return { strikes: [...ratioStrikeSet].sort(), messages };
}

test("pasting into a quarterly triangle with one more diagonal preserves uncovered cells", () => {
  const result = pastePattern([[1, 0], [0], []], [[0, 1, 1], [1, 1], [1], []],
    ["0,1", "0,2", "1,0", "1,1", "2,0"]);
  assert.deepEqual(result.strikes, ["0,0", "0,2", "1,1", "2,0"]);
  assert.deepEqual(result.messages, [{
    type: "arcrho:status", tone: "warn", text: "Ratio patterns applied; unmatched cells ignored.",
  }]);
});

test("pasting a larger triangle clips copied cells outside the target", () => {
  const result = pastePattern([[1, 1, 1], [0, 1], [1], []], [[0, 0], [1], []], ["1,0"]);
  assert.deepEqual(result.strikes, ["0,0", "0,1"]);
  assert.equal(result.messages.length, 1);
});

test("partial paste respects active columns and skips masked cells on either triangle", () => {
  const result = pastePattern([[1, 0, 2, 1]], [[0, 1, 1, 2, 1]],
    ["0,1", "0,2", "0,4"], [1, 2, 3, 4]);
  assert.deepEqual(result.strikes, ["0,2", "0,4"]);
  assert.equal(result.messages.length, 1);
});

test("matching shapes paste without a warning", () => {
  const result = pastePattern([[1, 0], [0]], [[0, 1], [1]], ["0,1", "1,0"]);
  assert.deepEqual(result.strikes, ["0,0"]);
  assert.deepEqual(result.messages, []);
});

test("ratio copy keeps only highlighted source columns at their original positions", () => {
  let copied;
  const slice = functionSlice(ratiosTabSource, "function copyRatioPatterns", "function showRatioPatternWarning");
  new Function("clearRatioActionError", "buildRatioSelectionPattern", "localStorage", "filterPatternColumns",
    `${slice}\ncopyRatioPatterns();`,
  )(() => {}, () => [[1, 0, 1], [0, 1]], { setItem: (_key, value) => { copied = JSON.parse(value); } },
    patternColumns([0, 2]).filterPatternColumns);
  assert.deepEqual(copied, [[1, null, 1], [0, null]]);
  const result = pastePattern(copied, [[0, 1, 0], [1, 1]], ["0,1", "1,0", "1,1"], [1, 2]);
  assert.deepEqual(result.strikes, ["0,1", "0,2", "1,0", "1,1"]);
  assert.deepEqual(result.messages, []);
});

test("no highlights and all-column highlight both copy all columns", () => {
  const pattern = [[1, 0, 2], [0]];
  assert.deepEqual(patternColumns().filterPatternColumns(pattern), pattern);
  assert.deepEqual(patternColumns([1], true).filterPatternColumns(pattern), pattern);
});

test("a highlighted column outside the triangle does not fall back to applying all columns", () => {
  const result = pastePattern([[1, 0]], [[0, 1]], ["0,1"], [2]);
  assert.deepEqual(result.strikes, ["0,1"]);
});

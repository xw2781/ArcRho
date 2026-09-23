import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The "- Ult" cell of every DFM average row is that row's own tail factor, an
// input as in ResQ (CustomAverages(i).TailFactor): a computed average keeps a
// typed tail just as a User Entry row does, and the page reads, edits and
// saves it the way dfm_contract._calculate_formula_values recalculates it.

const root = new URL("../", import.meta.url);
const source = async (path) => readFile(new URL(path, root), "utf8");

const [stateSource, persistenceSource, summaryTableSource, entriesSource, interactionsSource] = await Promise.all([
  source("ui/method_pages/dfm/dfm_state.js"),
  source("ui/method_pages/dfm/dfm_persistence.js"),
  source("ui/method_pages/dfm/dfm_ratios_summary_table.js"),
  source("ui/method_pages/dfm/ratios_summary/summary_entries.js"),
  source("ui/method_pages/dfm/ratios_summary/summary_interactions.js"),
]);

function functionSlice(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return text.slice(start, end).replace(/^export /gmu, "");
}

const tail = new Function(
  `${functionSlice(stateSource, "export function summaryRowOwnsTail", "// Curves tab state")}
return { summaryRowOwnsTail, getSummaryRowTailFactor, isSummaryTailEntryCell, setSummaryRowTailFactor };`,
)();

const hydrate = new Function(
  `${functionSlice(persistenceSource, "function normalizeSummaryUserEntryValue", "function buildCalculatedRatioTriangleValues")}
${functionSlice(persistenceSource, "function hydrateSummaryRowValuesFromAverageFormulaValues", "export async function buildDfmMethodPayloadWithPaths")}
return hydrateSummaryRowValuesFromAverageFormulaValues;`,
)();

const volumeAll = () => ({ id: "volume_all", label: "Volume - all", averageType: "custom", base: "volume", periods: "all", exclude: 0 });
const userEntry = () => ({ id: "user_a", label: "User A", averageType: "user_entry", base: "simple", values: [1.2, 1.1, 1.005] });
const benchmark = () => ({ id: "aug", label: "Aug 2024", averageType: "custom", base: "benchmark", values: [1.3, 1.1, 1.0003] });

test("every average row owns its tail, a computed average included", () => {
  assert.equal(tail.summaryRowOwnsTail(volumeAll()), true);
  assert.equal(tail.summaryRowOwnsTail(userEntry()), true);
  assert.equal(tail.summaryRowOwnsTail(benchmark()), true);
  assert.equal(tail.summaryRowOwnsTail(null), false);
});

test("a computed row reads its stored tail, and 1 when none is stored", () => {
  assert.equal(tail.getSummaryRowTailFactor(volumeAll(), 2), 1);
  assert.equal(tail.getSummaryRowTailFactor({ ...volumeAll(), values: [1.3, 1.1, 1.0018] }, 2), 1.0018);
  assert.equal(tail.getSummaryRowTailFactor({ ...volumeAll(), values: [1.3, 1.1, 0] }, 2), 1);
  assert.equal(tail.getSummaryRowTailFactor(userEntry(), 2), 1.005);
});

test("only a non User Entry row's tail cell is a typed tail entry", () => {
  assert.equal(tail.isSummaryTailEntryCell(volumeAll(), 2, 2), true);
  assert.equal(tail.isSummaryTailEntryCell(benchmark(), 2, 2), true);
  assert.equal(tail.isSummaryTailEntryCell(volumeAll(), 1, 2), false);
  assert.equal(tail.isSummaryTailEntryCell(userEntry(), 2, 2), false);
  assert.equal(tail.isSummaryTailEntryCell(null, 2, 2), false);
});

test("typing a tail stores it on the row and refuses anything not above zero", () => {
  const row = volumeAll();
  assert.equal(tail.setSummaryRowTailFactor(row, 2, 1.0018), true);
  assert.deepEqual(row.values, [1, 1, 1.0018]);
  assert.equal(tail.getSummaryRowTailFactor(row, 2), 1.0018);
  assert.equal(tail.setSummaryRowTailFactor(row, 2, 0), false);
  assert.equal(tail.setSummaryRowTailFactor(row, 2, Number.NaN), false);
  assert.equal(tail.getSummaryRowTailFactor(row, 2), 1.0018);
});

test("opening a method gives a computed row its stored tail", () => {
  const rows = hydrate(
    [volumeAll(), { id: "simple_all", label: "Simple - all", averageType: "custom", base: "simple" }],
    ["Volume - all", "Simple - all"],
    [[1.25, 1.1, 1.0018], [1.3, 1.2]],
  );
  assert.equal(tail.getSummaryRowTailFactor(rows[0], 2), 1.0018);
  assert.equal(tail.getSummaryRowTailFactor(rows[1], 2), 1);
});

test("the Ratios tab shows every row's tail as an editable input and commits a typed one", () => {
  const tailBranch = functionSlice(summaryTableSource, "if (col >= devs.length - 1) {", "if (!config) return;");
  assert.doesNotMatch(tailBranch, /ratioPlaceholder"\);\s*\n\s*cell\.classList\.remove\("strike"\)/u);
  assert.match(tailBranch, /classList\.add\("userEntryEditable"\)/u);
  assert.match(entriesSource, /if \(cfg && isTailEntryCell\(cfg, col\)\) \{[\s\S]*?commitSummaryTailEntry\(/u);
  assert.match(entriesSource, /if \(!isUserEntryConfig\(cfg\) && !tailEntry\) \{\s*showSummaryFormulaBarReadOnlyValue/u);
  assert.match(interactionsSource, /isSummaryTailEntryCell\(cfg, Number\(cell\.dataset\.col\), devs\.length - 1\)/u);
});

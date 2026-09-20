import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The Ratios tab opens on the selected average of the first column, so the
// formula bar shows the factor the method uses as soon as it is on screen.

const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

const ROWS = [
  { id: "volume_all", label: "Volume - all", averageType: "custom" },
  { id: "simple5", label: "Simple - 5", averageType: "custom" },
  {
    id: "formula",
    label: "User Entry",
    averageType: "user_entry",
    values: [3.01],
    inputs: ['="Volume - all" * 1.05'],
  },
];

const runtimeStubUrl = dataUrl(`
  export const summaryRuntime = {
    summaryRowMap: new Map(${JSON.stringify(ROWS.map((row) => [row.id, row]))}),
    selectedSummaryByCol: new Map(),
    summaryActiveCellState: { rowId: "", col: -1 },
    isUserEntryConfig: (cfg) => cfg?.averageType === "user_entry",
  };
  export const registerSummaryFunctions = (functions) => Object.assign(summaryRuntime, functions);
`);
const emptyStubUrl = dataUrl(`
  export const createRatioDragVisitTracker = () => ({ reset() {}, visit() { return true; } });
  export const copySelectedFormulaPatterns = () => {};
  export const applySelectedFormulaPatterns = () => {};
`);

const interactionsSource = (await readFile(
  new URL("../ui/method_pages/dfm/ratios_summary/summary_interactions.js", import.meta.url),
  "utf8",
))
  .replace(/"\/ui\/method_pages\/dfm\/ratios_summary\/summary_runtime\.js\?v=[^"]*"/u, JSON.stringify(runtimeStubUrl))
  .replace('"/ui/method_pages/dfm/dfm_ratio_drag_tracker.js"', JSON.stringify(emptyStubUrl))
  .replace('"/ui/method_pages/dfm/ratios_summary/summary_patterns.js"', JSON.stringify(emptyStubUrl));

const interactions = await import(dataUrl(interactionsSource));
const { selectedSummaryByCol } = (await import(runtimeStubUrl)).summaryRuntime;

/** A stand-in summary table: one cell per row over two ratio columns. */
function buildSummaryTable(rows = ROWS) {
  const cells = [];
  for (const row of rows) {
    for (const col of [0, 1]) {
      cells.push({ dataset: { r: row.id, col: String(col) } });
    }
  }
  return {
    querySelectorAll: (selector) => (selector === "td.summaryCell[data-col]" ? cells : []),
  };
}

test("the Ratios tab opens on the green selected cell of the first column", () => {
  selectedSummaryByCol.clear();
  selectedSummaryByCol.set(0, "simple5");
  // A different row is selected further along, and has no say in where the
  // tab opens.
  selectedSummaryByCol.set(1, "formula");

  assert.deepEqual(
    interactions.pickSummaryOpeningCell(buildSummaryTable()),
    { rowId: "simple5", col: 0 },
  );
});

test("a column with no selection yet opens on its first row", () => {
  selectedSummaryByCol.clear();
  assert.deepEqual(
    interactions.pickSummaryOpeningCell(buildSummaryTable()),
    { rowId: "volume_all", col: 0 },
  );

  // A selection naming a row the table does not carry is no selection at all.
  selectedSummaryByCol.set(0, "removed_row");
  assert.deepEqual(
    interactions.pickSummaryOpeningCell(buildSummaryTable()),
    { rowId: "volume_all", col: 0 },
  );
});

test("a table with no cells opens on nothing", () => {
  selectedSummaryByCol.clear();
  assert.equal(interactions.pickSummaryOpeningCell(buildSummaryTable([])), null);
  assert.equal(interactions.pickSummaryOpeningCell(null), null);
});

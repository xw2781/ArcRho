import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const interactionsSource = await readFile(
  new URL("../ui/method_pages/dfm/ratios_summary/summary_interactions.js", import.meta.url),
  "utf8",
);
const entriesSource = await readFile(
  new URL("../ui/method_pages/dfm/ratios_summary/summary_entries.js", import.meta.url),
  "utf8",
);
const dfmCss = await readFile(new URL("../ui/method_pages/dfm/dfm.css", import.meta.url), "utf8");

const modelSource = await readFile(
  new URL("../ui/method_pages/dfm/ratios_summary/summary_model.js", import.meta.url),
  "utf8",
);

// Three average-formula rows plus the User Entry row whose formula names one of
// them, over a single development column.
const ROWS = [
  { id: "r_simple5", label: "Simple - 5 Ex hi/lo", averageType: "custom" },
  { id: "r_bench", label: "Benchmark", averageType: "custom" },
  {
    id: "r_ue",
    label: "User Entry",
    averageType: "user_entry",
    values: [3.0102],
    inputs: ['="Simple - 5 Ex hi/lo" * 1'],
  },
];

const runtimeStub = `const summaryRuntime = {
  state: { model: {} },
  summaryRowConfigs: ${JSON.stringify(ROWS)},
  summaryRowMap: new Map(${JSON.stringify(ROWS.map((row) => [row.id, row]))}),
  summaryFormulaEditState: null,
  getEffectiveDevLabelsForModel: () => ["12"],
  getRatioHeaderLabels: (devs) => devs,
  tokenizeFormula: (formula) => (String(formula || "").match(/"[^"]*"/gu) || [])
    .map((text) => ({ type: "ref", text })),
};
const registerSummaryFunctions = (functions) => Object.assign(summaryRuntime, functions);
export { summaryRuntime };`;

const patchedModel = modelSource.replace(
  /import \{[\s\S]*?\} from "\/ui\/method_pages\/dfm\/ratios_summary\/summary_runtime\.js\?v=[^"]*";/u,
  runtimeStub,
);

globalThis.CSS = { escape: (value) => String(value) };
const liveInput = { value: '="Simple - 5 Ex hi/lo" * 1' };
globalThis.document = { body: { contains: (node) => node === liveInput } };
globalThis.window = { requestAnimationFrame: () => 0 };

const model = await import(`data:text/javascript;base64,${Buffer.from(patchedModel).toString("base64")}`);
const modelRuntime = model.summaryRuntime;

/** A one-column stand-in for the average-formula table. */
function buildSummaryTable() {
  const cells = new Map(ROWS.map((row) => {
    const classes = new Set(["summaryCell"]);
    return [row.id, {
      rowId: row.id,
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
      },
    }];
  }));
  return {
    cells,
    querySelector: (selector) => {
      const rowId = /data-r="([^"]+)"/u.exec(selector)?.[1];
      return (rowId && cells.get(rowId)) || null;
    },
    querySelectorAll: (selector) => (
      selector.includes("summaryFormulaReferencedCell")
        ? Array.from(cells.values()).filter((cell) => cell.classList.contains("summaryFormulaReferencedCell"))
        : []
    ),
  };
}

const isFilled = (table, rowId) => table.cells.get(rowId).classList.contains("summaryFormulaReferencedCell");

test("the referenced fill follows the formula being dragged, not the saved one", () => {
  const summaryTable = buildSummaryTable();
  modelRuntime.summaryFormulaEditState = null;
  modelRuntime.applyUserEntryReferenceHighlights(summaryTable);
  assert.equal(isFilled(summaryTable, "r_simple5"), true, "the saved formula fills the row it names");
  assert.equal(isFilled(summaryTable, "r_bench"), false);

  // Dragging the reference onto Benchmark rewrites the formula bar's draft; the
  // saved formula still names the row the drag started from.
  modelRuntime.summaryFormulaEditState = {
    summaryTable,
    input: liveInput,
    rowId: "r_ue",
    col: 0,
  };
  liveInput.value = '= "Benchmark" * 1';
  modelRuntime.applyUserEntryReferenceHighlights(summaryTable);
  assert.equal(isFilled(summaryTable, "r_simple5"), false, "the row the reference left loses its fill");
  assert.equal(isFilled(summaryTable, "r_bench"), true);

  // Abandoning the edit hands the fill back to the saved formula.
  modelRuntime.summaryFormulaEditState = null;
  modelRuntime.applyUserEntryReferenceHighlights(summaryTable);
  assert.equal(isFilled(summaryTable, "r_simple5"), true);
  assert.equal(isFilled(summaryTable, "r_bench"), false);
});

test("the fill is refreshed wherever the draft formula can change", () => {
  assert.match(
    entriesSource,
    /function beginSummaryFormulaEditSession[\s\S]*?applyUserEntryReferenceHighlights\(summaryTable\);/u,
  );
  assert.match(
    entriesSource,
    /function cancelSummaryFormulaEditSession[\s\S]*?applyUserEntryReferenceHighlights\(summaryTable\);/u,
  );
});

test("the drag hot zone is marked from the same border test that starts the drag", () => {
  // One geometry rule for both, or the cursor would promise a drag the press
  // does not deliver.
  assert.match(
    interactionsSource,
    /const updateReferenceDragReadyUi = \(e\) => \{[\s\S]*?isNearCellBorder\(e, cell\)[\s\S]*?classList\.add\("summaryFormulaRefDragReady"\)/u,
  );
  assert.match(
    interactionsSource,
    /const tryStartReferenceDrag = \(e\) => \{[\s\S]*?isNearCellBorder\(e, cell\)/u,
  );
  assert.match(interactionsSource, /updateReferenceHoverUi\(hoverCell \|\| null\);\s*updateReferenceDragReadyUi\(e\);/u);
});

test("the hot zone and the gesture both clear themselves", () => {
  assert.match(entriesSource, /function clearSummaryReferenceUi[\s\S]*?summaryFormulaRefDragReady/u);
  assert.match(
    interactionsSource,
    /const tryStartReferenceDrag = \(e\) => \{[\s\S]*?classList\.add\("summaryFormulaRefDragging"\)/u,
  );
  assert.match(
    interactionsSource,
    /const finishReferenceDrag = \(\) => \{[\s\S]*?classList\.remove\("summaryFormulaRefDragging"\)/u,
  );
});

test("the reference cell reads as a move where it drags and a click everywhere else", () => {
  assert.match(
    dfmCss,
    /#ratioWrap td\.summaryCell\.summaryFormulaActiveRefCell\.summaryFormulaRefDragReady,\s*#ratioWrap table\.ratioSummaryTable\.summaryFormulaRefDragging td\.summaryCell \{\s*cursor: move;/u,
  );
  // The middle of a candidate cell still picks the reference on a click.
  assert.match(dfmCss, /#ratioWrap td\.summaryCell\.summaryRefCandidate \{\s*cursor: pointer;/u);
  // The move cursor has to outrank the Edit-mode pen at equal specificity, which
  // it only does by coming later in the sheet.
  const penIndex = dfmCss.indexOf('#ratioWrap[data-interaction-mode="edit"] td.summaryCell.userEntryEditable');
  const moveIndex = dfmCss.indexOf("#ratioWrap td.summaryCell.summaryFormulaActiveRefCell.summaryFormulaRefDragReady");
  assert.ok(penIndex > 0 && moveIndex > penIndex, "the move cursor rule must follow the pen cursor rule");
  // The whole cell no longer claims a drag its middle cannot start.
  assert.doesNotMatch(dfmCss, /summaryFormulaActiveRefCell[\s\S]{0,200}?cursor: grab;/u);
  assert.doesNotMatch(dfmCss, /summaryFormulaRefDragTarget[\s\S]{0,200}?cursor: grab(bing)?;/u);
});

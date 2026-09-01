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
const formulaBarSource = await readFile(
  new URL("../ui/method_pages/dfm/ratios_summary/summary_formula_bar.js", import.meta.url),
  "utf8",
);

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
  isRatioEditMode: () => true,
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
      dataset: { r: row.id, col: "0" },
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
      },
    }];
  }));
  const matching = (selector) => {
    const wanted = (selector.match(/\.[A-Za-z0-9_-]+/gu) || []).map((token) => token.slice(1));
    return Array.from(cells.values())
      .filter((cell) => wanted.every((name) => cell.classList.contains(name)));
  };
  return {
    cells,
    querySelector: (selector) => {
      const rowId = /data-r="([^"]+)"/u.exec(selector)?.[1];
      if (rowId) return cells.get(rowId) || null;
      return matching(selector)[0] || null;
    },
    querySelectorAll: matching,
  };
}

const isFilled = (table, rowId) => table.cells.get(rowId).classList.contains("summaryFormulaReferencedCell");
const colorOf = (table, rowId) => {
  const cell = table.cells.get(rowId);
  for (let index = 0; index < 6; index++) {
    if (cell.classList.contains(`summaryFormulaRefColor${index}`)) return index;
  }
  return null;
};

test("the referenced fill follows the formula being dragged, not the saved one", () => {
  const summaryTable = buildSummaryTable();
  summaryTable.cells.get("r_ue").classList.add("summaryActiveCell");
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
  liveInput.value = '="Simple - 5 Ex hi/lo" * 1';
  modelRuntime.applyUserEntryReferenceHighlights(summaryTable);
  assert.equal(isFilled(summaryTable, "r_simple5"), true);
  assert.equal(isFilled(summaryTable, "r_bench"), false);
});

test("nothing is filled while the User Entry cell that names it is not the one in view", () => {
  const summaryTable = buildSummaryTable();
  modelRuntime.summaryFormulaEditState = null;
  modelRuntime.applyUserEntryReferenceHighlights(summaryTable);
  assert.equal(isFilled(summaryTable, "r_simple5"), false, "a saved formula alone no longer fills anything");

  // Putting the cursor on the User Entry cell brings its references back.
  summaryTable.cells.get("r_ue").classList.add("summaryActiveCell");
  modelRuntime.applyUserEntryReferenceHighlights(summaryTable);
  assert.equal(isFilled(summaryTable, "r_simple5"), true);

  // Moving it onto a row with no formula of its own clears them again.
  summaryTable.cells.get("r_ue").classList.remove("summaryActiveCell");
  summaryTable.cells.get("r_bench").classList.add("summaryActiveCell");
  modelRuntime.applyUserEntryReferenceHighlights(summaryTable);
  assert.equal(isFilled(summaryTable, "r_simple5"), false);
});

test("each reference in one formula gets its own colour, in the order the formula names them", () => {
  const summaryTable = buildSummaryTable();
  summaryTable.cells.get("r_ue").classList.add("summaryActiveCell");
  modelRuntime.summaryFormulaEditState = {
    summaryTable,
    input: liveInput,
    rowId: "r_ue",
    col: 0,
  };
  liveInput.value = '= ("Benchmark" + "Simple - 5 Ex hi/lo" + "Benchmark") / 3';
  modelRuntime.applyUserEntryReferenceHighlights(summaryTable);
  assert.equal(colorOf(summaryTable, "r_bench"), 0, "the first reference named takes the first colour");
  assert.equal(colorOf(summaryTable, "r_simple5"), 1, "the second takes the next colour");

  // A reference dropped from the formula gives its colour back.
  liveInput.value = '= "Simple - 5 Ex hi/lo" * 1';
  modelRuntime.applyUserEntryReferenceHighlights(summaryTable);
  assert.equal(colorOf(summaryTable, "r_bench"), null);
  assert.equal(colorOf(summaryTable, "r_simple5"), 0);
  modelRuntime.summaryFormulaEditState = null;
});

test("the formula bar pill and the cell it names read from one palette entry", () => {
  const colors = modelRuntime.buildSummaryFormulaReferenceColorsByLabel(
    '= ("Benchmark" + "Simple - 5 Ex hi/lo") / 2',
  );
  assert.equal(colors.get("benchmark"), "summaryFormulaRefColor0");
  assert.equal(colors.get("simple - 5 ex hi/lo"), "summaryFormulaRefColor1");
  // The bar draws its pills from the same map the cells are painted from.
  assert.match(
    formulaBarSource,
    /buildSummaryFormulaReferenceColorsByLabel\?\.\(sourceText\)[\s\S]*?tok\.type === "ref"[\s\S]*?span\.classList\.add\(colorClass\)/u,
  );
  // One palette block serves both, so a colour can never drift between them.
  assert.doesNotMatch(dfmCss, /#ratioWrap td\.summaryCell\.summaryFormulaRefColor\d/u);
  assert.match(
    dfmCss,
    /\.fmtRowRef\[class\*="summaryFormulaRefColor"\] \{\s*border-color: var\(--dfm-formula-ref-line\);/u,
  );
});

test("the palette gives every reference colour a fill and a matching outline", () => {
  for (let index = 0; index < 6; index++) {
    assert.match(
      dfmCss,
      new RegExp(`summaryFormulaRefColor${index} \\{\\s*--dfm-formula-ref-fill: #[0-9a-f]{6};\\s*--dfm-formula-ref-line: #[0-9a-f]{6};`, "u"),
    );
  }
  assert.match(dfmCss, /summaryFormulaReferencedCell\.dfmTableActive \{\s*background: var\(--dfm-formula-ref-fill/u);
  assert.match(dfmCss, /outline: 2px solid var\(--dfm-formula-ref-line/u);
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
    /#ratioWrap td\.summaryCell\.summaryFormulaActiveRefCell\.summaryFormulaRefDragReady,\s*#ratioWrap table\.ratioSummaryTable\.summaryFormulaRefDragging td\.summaryCell \{\s*cursor: move !important;/u,
  );
  // Select mode paints every cell's cursor with `!important` and the formula bar
  // is editable there too, so the move cursor has to outrank it in both modes.
  assert.match(dfmCss, /\[data-interaction-mode="select"\] td \{\s*cursor: pointer !important;/u);
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

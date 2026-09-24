/*
 * The Ratios tab marks one cell with a dashed border in Edit mode, across the
 * ratio triangle and the average-formula table together. These tests pin the
 * wiring that keeps it a single marker and the two keyboard actions that read
 * it, in the source of the modules that own them: the Ratios tab's import graph
 * reaches the whole DFM page, so it cannot be loaded into a test process.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const ratiosTabSource = await read("../ui/method_pages/dfm/dfm_ratios_tab.js");
const summaryInteractionsSource = await read(
  "../ui/method_pages/dfm/ratios_summary/summary_interactions.js",
);
const summaryFacadeSource = await read("../ui/method_pages/dfm/dfm_ratios_summary_table.js");
const dfmCss = await read("../ui/method_pages/dfm/dfm.css");

test("the ratio triangle's active cell is drawn like the average-formula table's", () => {
  const summaryRule = /#ratioWrap td\.summaryCell\.summaryActiveCell \{[^}]*outline: 1px dashed #1f2937;[^}]*\}/u;
  const ratioRule = /#ratioWrap table\.ratioMainTable td\.ratioCell\.ratioActiveCell \{[^}]*outline: 1px dashed #1f2937;[^}]*\}/u;
  assert.match(dfmCss, summaryRule);
  assert.match(dfmCss, ratioRule);
  // The shared highlight clears a ratio cell's outline at the same specificity,
  // so the marker's rule only wins where it comes later in the file.
  assert.ok(
    dfmCss.search(ratioRule) > dfmCss.indexOf("#ratioWrap td.ratioCell.dfmTableActive {"),
    "the marker rule must follow the rule that clears a ratio cell's outline",
  );
});

test("a User Entry average reads as typeable until it is the selected one", async () => {
  const fillRule = /#ratioWrap td\.summaryCell\.userEntryEditable \{\s*background: var\(--ar-spreadsheet-percent-fill\);\s*\}/u;
  // The same pale blue a Result Selection weight cell carries.
  assert.match(dfmCss, fillRule);
  const resultSelectionCss = await read("../ui/method_pages/result_selection/result_selection.css");
  assert.match(resultSelectionCss, /\.rsWeightCell \{\s*background: var\(--ar-spreadsheet-percent-fill\);/u);
  // The selected-average green has to cover it, which it only does at equal
  // specificity by coming later in the file.
  assert.ok(
    dfmCss.indexOf("#ratioWrap td.summaryCell.ratioSelectedCell,") > dfmCss.search(fillRule),
    "the selected-average fill must follow the User Entry fill",
  );
});
test("pressing a ratio cell moves the marker and the marker survives a re-render", () => {
  assert.match(
    ratiosTabSource,
    /if \(cell\.closest\("table\.ratioMainTable"\)\) setRatioActiveCell\(cell\);/u,
  );
  // The state, not the discarded cell, is what the re-render paints from.
  assert.match(ratiosTabSource, /wireSummarySelection\(summaryTable, selectedTable\);[\s\S]{0,200}?paintRatioActiveCell\(\);/u);
  assert.match(ratiosTabSource, /function paintRatioActiveCell\(\)[\s\S]*?getRatioActiveCell\(\)\?\.classList\.add\("ratioActiveCell"\)/u);
});

test("only one of the two tables holds the marker", () => {
  // Taking it on the triangle drops the average-formula table's...
  assert.match(ratiosTabSource, /function setRatioActiveCell\(cell\)[\s\S]*?clearSummaryActiveCell\(\);/u);
  // ...and taking it on the average-formula table drops the triangle's.
  assert.match(
    summaryInteractionsSource,
    /summaryRuntime\.summaryActiveCellState = \{ rowId, col \};[\s\S]{0,160}?summaryRuntime\._clearRatioActiveCell\(\);/u,
  );
  assert.match(
    summaryInteractionsSource,
    /summaryRuntime\.summaryActiveCellState = \{ rowId: rowKey, col: colIndex \};\s+summaryRuntime\._clearRatioActiveCell\(\);/u,
  );
  assert.match(summaryInteractionsSource, /export function clearSummaryActiveCell\(\)/u);
  assert.match(summaryFacadeSource, /export const clearSummaryActiveCell = delegate\("clearSummaryActiveCell"\)/u);
  assert.match(summaryFacadeSource, /summaryRuntime\._clearRatioActiveCell = clearRatioActiveCell/u);
});

test("giving up the marker takes the formula bar and the reference fills with it", () => {
  const body = summaryInteractionsSource.match(
    /export function clearSummaryActiveCell\(\) \{[\s\S]*?\n\}/u,
  )?.[0];
  assert.ok(body, "clearSummaryActiveCell is defined");
  assert.match(body, /summaryActiveCellState = \{ rowId: "", col: -1 \}/u);
  assert.match(body, /classList\.remove\("summaryActiveCell"\)/u);
  assert.match(body, /updateSummaryFormulaBarForCell\(null\)/u);
  // A ratio drag crosses many cells, so a table without the marker returns first.
  assert.match(body, /if \(!String\(summaryRuntime\.summaryActiveCellState\.rowId \|\| ""\)\) return;/u);
});

test("Enter acts on the marked cell in Edit mode and on the range in Select mode", () => {
  assert.match(
    ratiosTabSource,
    /function applyHighlightedRatioRangeAction\(\) \{[\s\S]{0,200}?if \(isRatioEditMode\(\)\) return applyActiveRatioCellAction\(wrap\);/u,
  );
  const editAction = ratiosTabSource.match(
    /function applyActiveRatioCellAction\(wrap\) \{[\s\S]*?\n\}/u,
  )?.[0];
  assert.ok(editAction, "applyActiveRatioCellAction is defined");
  // A marked ratio cell is included or excluded, as one undo step...
  assert.match(
    editAction,
    /beginRatioHistoryAction\("ratio-active-enter"\);\s+const excluded = toggleRatioCellExclusion\(ratioCell\);/u,
  );
  assert.match(editAction, /commitRatioHistoryAction\("ratio-active-enter"\)/u);
  // ...and a marked average-formula cell becomes its column's selection.
  assert.match(editAction, /return selectSummaryCell\(summaryTable, rowId, col\)/u);
  // Re-selecting what is already selected must not dirty the method.
  assert.match(editAction, /if \(selectedSummaryByCol\.get\(col\) === rowId\) return true;/u);
});

test("Edit-mode arrows move the triangle's marker only while it holds it", () => {
  const handler = ratiosTabSource.match(
    /document\.addEventListener\("keydown", \(event\) => \{[\s\S]*?ArrowUp: \[-1, 0\][\s\S]*?\n  \}\);/u,
  )?.[0];
  assert.ok(handler, "the Edit-mode arrow handler is wired");
  assert.match(handler, /if \(!isRatioEditMode\(\) \|\| !getRatioActiveCell\(\)\) return;/u);
  assert.match(handler, /input, textarea, select, \[contenteditable='true'\]/u);
  assert.match(handler, /moveRatioActiveCell\(movement\[0\], movement\[1\]\)/u);
  // Movement stays inside the triangle it started in.
  const move = ratiosTabSource.match(/function moveRatioActiveCell\([\s\S]*?\n\}/u)?.[0];
  assert.ok(move, "moveRatioActiveCell is defined");
  assert.match(move, /Math\.max\(0, Math\.min\(rows\.length - 1, rowIndex \+ rowDelta\)\)/u);
  assert.match(move, /Math\.max\(0, Math\.min\(colCount - 1, ratioActiveCellState\.c \+ colDelta\)\)/u);
});

test("one rule decides which ratio cells can be struck", () => {
  const toggle = ratiosTabSource.match(
    /function toggleRatioCellExclusion\(cell, \{ defer = false \} = \{\}\) \{[\s\S]*?\n\}/u,
  )?.[0];
  assert.ok(toggle, "toggleRatioCellExclusion is defined");
  assert.match(toggle, /classList\.contains\("na"\) \|\| cell\.classList\.contains\("ratioPlaceholder"\)/u);
  assert.match(toggle, /isRatioDataRow\(r\)/u);
  // The click, the drag, Enter, and a highlighted range all come through it.
  assert.equal(
    (ratiosTabSource.match(/toggleRatioCellExclusion\(/gu) || []).length,
    5,
    "the definition plus its four callers",
  );
  assert.doesNotMatch(ratiosTabSource, /const toggleStrike = /u);
});

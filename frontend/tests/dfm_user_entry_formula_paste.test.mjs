import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// A copied Excel link pasted onto a User Entry cell must reach the formula bar
// and be committed there, and nothing else on the page may answer that paste.
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const interactionsSource = await read("../ui/method_pages/dfm/ratios_summary/summary_interactions.js");
const entriesSource = await read("../ui/method_pages/dfm/ratios_summary/summary_entries.js");
const barSource = await read("../ui/method_pages/dfm/ratios_summary/summary_formula_bar.js");
const gridSource = await read("../ui/shared/tabs/data/dataset_grid_interactions.js");

test("a pasted formula on a User Entry cell goes to the formula bar, numbers to the grid", () => {
  assert.match(
    interactionsSource,
    /if \(isUserEntryFormulaClipboardText\(text\)\) \{\s+pasteFormulaIntoSummaryFormulaBar\(summaryTable, cell, text\);\s+return;\s+\}\s+pasteUserEntryClipboardGrid\(summaryTable, selectedTable, cell, text\);/u,
  );
  // One cell that opens with "=" or names a workbook or dataset is a formula.
  assert.match(
    entriesSource,
    /if \(!parsed\.ok \|\| parsed\.rows\.length !== 1 \|\| parsed\.width !== 1\) return false;\s+const text = String\(parsed\.rows\[0\]\[0\] \|\| ""\)\.trim\(\);\s+return text\.startsWith\("="\) \|\| containsExcelRef\(text\) \|\| containsDfmDatasetReference\(text\);/u,
  );
});

test("the formula paste opens an edit session and commits the way Enter does", () => {
  assert.match(
    entriesSource,
    /beginSummaryFormulaEditSession\(summaryTable, startCell, input, col\);\s+void submitSummaryFormulaBarInput\(bar, input\);\s+return true;/u,
  );
  assert.match(
    barSource,
    /if \(e\.key === "Enter"\) \{\s+e\.preventDefault\(\);\s+await submitSummaryFormulaBarInput\(el, input\);/u,
  );
  // A spilled cell of a linked range still points the reader at the anchor.
  assert.match(
    entriesSource,
    /function pasteFormulaIntoSummaryFormulaBar[\s\S]*?excelRangeSpillCell[\s\S]*?Edit the first cell of the Excel-linked range instead\./u,
  );
});

test("a doubled = is folded while typing and again on commit", () => {
  assert.match(barSource, /const collapsed = collapseFormulaEquals\(input\.value\);/u);
  assert.match(
    entriesSource,
    /normalizeExcelReferenceAddressCase\(collapseFormulaEquals\(String\(inputEl\.value \|\| ""\)\.trim\(\)\)\)/u,
  );
  // The paste builds the bar text from the bare formula, so the bar's own
  // prefix is the only "=" left.
  assert.match(
    entriesSource,
    /const formula = stripFormulaEquals\(collapseFormulaEquals\(String\(rawText \?\? ""\)\.trim\(\)\)\);\s+input\.value = `= \$\{normalizeExcelReferenceAddressCase\(formula\)\}`;/u,
  );
});

test("the shared dataset grid answers document pastes and keys only while it is shown", () => {
  const gated = gridSource.match(/if \(isTypingTarget\(e\.target\) \|\| !gridIsShown\(\)\) return;/gu) || [];
  assert.equal(gated.length, 3, "the copy, edit-key, and paste listeners all check the grid is shown");
  assert.match(
    gridSource,
    /function gridIsShown\(\) \{\s+const wrap = document\.getElementById\("tableWrap"\);\s+if \(!wrap\) return false;\s+if \(typeof wrap\.checkVisibility === "function"\) return wrap\.checkVisibility\(\);\s+return wrap\.offsetParent !== null;/u,
  );
});

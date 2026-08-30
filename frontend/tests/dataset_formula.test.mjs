import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const referenceUrl = dataUrl(await readFile(
  new URL("../ui/shared/integrations/excel_reference.js", import.meta.url),
  "utf8",
));
const internalReferenceUrl = dataUrl(await readFile(
  new URL("../ui/shared/dataset/dataset_internal_reference.js", import.meta.url),
  "utf8",
));
const formulaSource = (await readFile(
  new URL("../ui/shared/dataset/dataset_formula.js", import.meta.url),
  "utf8",
))
  .replace('"/ui/shared/integrations/excel_reference.js?v=20260715a"', JSON.stringify(referenceUrl))
  .replace('"/ui/shared/dataset/dataset_internal_reference.js?v=20260830a"', JSON.stringify(internalReferenceUrl));
const formula = await import(dataUrl(formulaSource));

const EXCEL = "'C:\\Data\\[Book.xlsx]Sheet 1'!a1:a3";

function matrix(values) {
  return { rows: values.length, cols: values[0].length, values };
}

test("a standalone Excel or dataset reference keeps its own kind", () => {
  assert.equal(formula.classifyDatasetFormula(`=${EXCEL}`).kind, "excel");
  assert.equal(formula.classifyDatasetFormula("=[C 82 - Prior Qtr Selected][1:7]").kind, "internal");
  assert.equal(formula.classifyDatasetFormula(" [C 82][2024, 12] ").kind, "internal");
});

test("arithmetic over references is a formula with canonical text", () => {
  const doubled = formula.classifyDatasetFormula("=[ C 82 - Prior Qtr Selected ][ 1 : 7 ]*2");
  assert.equal(doubled.kind, "formula");
  assert.equal(doubled.canonical, "=[C 82 - Prior Qtr Selected][1:7] * 2");
  assert.deepEqual(doubled.references.map((token) => token.kind), ["internal"]);

  const mixed = formula.classifyDatasetFormula(`=(${EXCEL} + [C 82][1:3])/1000`);
  assert.equal(mixed.kind, "formula");
  assert.equal(mixed.canonical, "=('C:\\Data\\[Book.xlsx]Sheet 1'!A1:A3 + [C 82][1:3]) / 1000");
  assert.deepEqual(mixed.references.map((token) => token.kind), ["excel", "internal"]);

  const unary = formula.classifyDatasetFormula("=-[A][1]^2+3*(2-1)");
  assert.equal(unary.canonical, "=-[A][1] ^ 2 + 3 * (2 - 1)");

  // The same reference twice is one source to resolve.
  assert.equal(formula.classifyDatasetFormula("=[A][1] + [A][1]").references.length, 1);
});

test("drafts that fit none of the three kinds are refused with a reason", () => {
  const cases = [
    ["", /Enter an Excel link/u],
    ["=2*3", /at least one dataset or Excel reference/u],
    ["=[C 82][1:7] *", /ends before its last operand/u],
    ["=[C 82]", /missing its coordinates/u],
    ["=[C 82][1:7] $ 2", /Unexpected "\$"/u],
    ["=([C 82][1:7] * 2", /missing a closing parenthesis/u],
    ["='C:\\Data\\Book.xlsx'!A1 * 2", /Excel reference must be written/u],
  ];
  for (const [text, pattern] of cases) {
    const result = formula.classifyDatasetFormula(text);
    assert.equal(result.kind, "invalid", text);
    assert.match(result.error, pattern, text);
  }
});

test("evaluation follows Excel array rules", () => {
  const lookups = {
    "[A][1:3]": matrix([[1], [2], [3]]),
    "[B][1:3]": matrix([[10], [20], [30]]),
    "[C][1, 1:2]": matrix([[100, 200]]),
    "[D][1:2]": matrix([[1], [2]]),
    "[E][1:2]": matrix([[null], [2]]),
    "[A][1]": matrix([[4]]),
  };
  const evaluate = (text) => {
    const parsed = formula.parseDatasetFormula(text);
    assert.equal(parsed.ok, true, parsed.error);
    return formula.evaluateDatasetFormula(parsed.tree, (token) => lookups[token.canonical]);
  };

  assert.deepEqual(evaluate("=[A][1:3] * 2").values, [[2], [4], [6]]);
  assert.deepEqual(evaluate("=[A][1:3] + [B][1:3]").values, [[11], [22], [33]]);
  // A one-row matrix stretches down a column and a column stretches across a row.
  assert.deepEqual(evaluate("=[A][1:3] + [C][1, 1:2]").values, [[101, 201], [102, 202], [103, 203]]);
  // A blank source cell is zero, as it is in Excel.
  assert.deepEqual(evaluate("=[E][1:2] * 2").values, [[0], [4]]);
  // Unary minus binds tighter than ^, as it does in Excel: -4^2 is 16.
  assert.deepEqual(evaluate("=-[A][1]^2+3*(2-1)").values, [[19]]);

  const mismatch = evaluate("=[A][1:3] + [D][1:2]");
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /Array sizes do not match \(3x1 and 2x1\)/u);
  const division = evaluate("=[A][1] / [E][1:2]");
  assert.equal(division.ok, false);
  assert.match(division.error, /divides by zero/u);
});

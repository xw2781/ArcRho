import "./ui_module_loader.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { formulaCallContext, formulaCompletionQuery, formulaCompletionIdentity, completionEdit } from "../ui/shared/components/formula_bar/formula_completion.js";
import { findArcRhoFormulaReferences, parseDatasetFormula, evaluateDatasetFormula } from "../ui/shared/dataset/dataset_formula.js";
import { evaluateFormulaValues } from "../ui/shared/dataset/dataset_formula_values.js";

test("completion tracks nested arguments without counting quoted commas or array separators", () => {
  const query = formulaCallContext('=TAKE(TRANSPOSE({1,2;3,4}), -');
  assert.equal(query.spec.name, "TAKE"); assert.equal(query.argument, 1);
  assert.equal(formulaCallContext('=ArcRhoTri("A,B", "Paid", TRUE, ').argument, 3);
  assert.equal(formulaCompletionQuery('=SUM([Pa').kind, "dataset");
  assert.equal(formulaCompletionQuery('=ArcRhoVec("", "Pa').kind, "datasetArgument");
  assert.equal(formulaCompletionQuery('=ArcRhoVec("[foo').kind, "contextArgument");
  assert.equal(formulaCompletionQuery("=tra").kind, "function");
  assert.equal(formulaCompletionQuery("[").kind, "dataset");
  assert.equal(formulaCompletionQuery("=IF(SU").kind, "function");
});

test("completion replaces the token at the caret and preserves the remaining expression", () => {
  let text = '=TAKE([Pa][1:4],2)';
  let query = formulaCompletionQuery(text, text.indexOf('][1'));
  assert.equal(completionEdit(text, query, '[Paid][').value, '=TAKE([Paid][1:4],2)');
  text = '=ArcRhoVec("", "Pa") * 2';
  query = formulaCompletionQuery(text, text.indexOf('Pa') + 2);
  assert.equal(completionEdit(text, query, '"Paid"').value, '=ArcRhoVec("", "Paid") * 2');
  text = '=ArcRhoVec("Other RC", "Pa old",,"Other Project")';
  query = formulaCompletionQuery(text, text.indexOf('Pa') + 2);
  assert.equal(completionEdit(text, query, '"Paid"').value, '=ArcRhoVec("Other RC", "Paid",,"Other Project")');
  assert.deepEqual(formulaCompletionIdentity(text, query, {project_name: "Current", reserving_class: "RC"}), {project_name: "Other Project", reserving_class: "Other RC"});
});

test("add-in calls accept omitted context and optional slots and escaped text", () => {
  const raw = '=INDEX(ArcRhoTri(,"Paid ""Net""",,,,"Other Project"),2,1)';
  const parsed = parseDatasetFormula(raw);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.references.length, 1);
  assert.equal(parsed.references[0].parsed.arguments.Path, null);
  assert.equal(parsed.references[0].parsed.arguments.ProjectName, "Other Project");
  const matrix = { rows: 2, cols: 2, values: [[1, 2], [3, 4]] };
  assert.deepEqual(evaluateDatasetFormula(parsed.tree, () => matrix).values, [[3]]);
  assert.equal(findArcRhoFormulaReferences('="ArcRhoVec(ignored)"').length, 0);
  assert.equal(findArcRhoFormulaReferences('=[ArcRhoVec(fake)][1]').length, 0);
});

test("preview and DSV evaluation use one batched resolver and produce the same array", async () => {
  let calls = 0;
  const result = await evaluateFormulaValues('=TRANSPOSE(TAKE(ArcRhoVec(,"Paid"),-2))', {
    resolveReferences: async refs => {
      calls++; assert.deepEqual(refs, ['=ArcRhoVec(, "Paid")']);
      return { ok: true, data: { results: [{ row_count: 3, column_count: 1, cells: [{ value: 1 }, { value: 2 }, { value: 3 }] }] } };
    },
  });
  assert.equal(calls, 1); assert.equal(result.ok, true, result.error); assert.deepEqual(result.values, [[2, 3]]);
});

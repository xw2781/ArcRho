import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  completeDfmDatasetName,
  DfmDatasetReferenceSyntaxError,
  filterDfmDatasetNames,
  containsDfmDatasetReference,
  findActiveDfmDatasetNameQuery,
  findDfmDatasetReferences,
  substituteDfmDatasetReferenceLabels,
  substituteDfmDatasetReferences,
} from "../ui/method_pages/dfm/dfm_dataset_reference.js";
import {
  buildDfmAverageFormulaObject,
  buildDfmSummaryRowsFromAverageFormulaObject,
} from "../ui/method_pages/dfm/dfm_average_formula_rows.js";

const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

test("DFM dataset references parse vector and triangle coordinates", () => {
  const refs = findDfmDatasetReferences(
    "=[Paid Claims][2024, 12] / [Earned Premium][1] + [Quoted][\"2024 Q1\", '12, months']"
  );

  assert.deepEqual(
    refs.map(({ datasetName, rowIndex, colIndex }) => ({ datasetName, rowIndex, colIndex })),
    [
      { datasetName: "Paid Claims", rowIndex: "2024", colIndex: "12" },
      { datasetName: "Earned Premium", rowIndex: "1", colIndex: null },
      { datasetName: "Quoted", rowIndex: "\"2024 Q1\"", colIndex: "'12, months'" },
    ],
  );
  assert.equal(containsDfmDatasetReference("='C:\\Data\\[Book.xlsx]Sheet'!A1"), false);
});

test("DFM dataset reference substitution preserves surrounding arithmetic", () => {
  const formula = "=[Paid][1, 2] / [Premium][1]";
  const references = findDfmDatasetReferences(formula);
  assert.equal(
    substituteDfmDatasetReferences(formula, references, [{ value: 150 }, { value: 100 }]),
    "=150 / 100",
  );
});

test("DFM dataset display substitution uses resolved axis labels without changing the source formula", () => {
  const formula = "=[Paid][-1, 2] / [Premium][-1]";
  const references = findDfmDatasetReferences(formula);
  const results = [
    { value: 150, row_label: "2025 Q4", col_label: "24 months" },
    { value: 100, row_label: "2025 Q4", col_label: null },
  ];

  assert.equal(
    substituteDfmDatasetReferenceLabels(formula, references, results),
    "=[Paid][2025 Q4, 24 months] / [Premium][2025 Q4]",
  );
  assert.equal(formula, "=[Paid][-1, 2] / [Premium][-1]");
});

test("DFM average formula persistence round-trips display-only inputs", () => {
  const averageFormulas = buildDfmAverageFormulaObject([
    {
      id: "user_entry",
      label: "User Entry",
      averageType: "user_entry",
      base: "simple",
      periods: "all",
      exclude: 0,
      inputs: ["=[Premium][-1]"],
      displayInputs: ["=[Premium][2025 Q4]"],
    },
  ], [[1]], [[1.2]]);

  assert.deepEqual(averageFormulas["display_inputs"], [["=[Premium][2025 Q4]"]]);
  assert.deepEqual(
    buildDfmSummaryRowsFromAverageFormulaObject(averageFormulas)[0].displayInputs,
    ["=[Premium][2025 Q4]"],
  );
});

test("DFM dataset references reject missing coordinates and brackets", () => {
  assert.throws(
    () => findDfmDatasetReferences("=[Paid][1, ]"),
    DfmDatasetReferenceSyntaxError,
  );
  assert.throws(
    () => findDfmDatasetReferences("=[Paid][1, 2"),
    DfmDatasetReferenceSyntaxError,
  );
});

test("DFM dataset autocomplete finds and completes an active dataset-name bracket", () => {
  const formula = "= [Paid] + [C 0";
  const active = findActiveDfmDatasetNameQuery(formula, formula.length);
  assert.deepEqual(active, { start: 11, end: 15, query: "C 0" });
  assert.deepEqual(
    filterDfmDatasetNames(["Case 01", "C 02 Paid", "Premium", "c 02 paid"], active.query),
    ["C 02 Paid"],
  );
  assert.deepEqual(completeDfmDatasetName(formula, active, "C 02 Paid"), {
    value: "= [Paid] + [C 02 Paid][",
    caret: 23,
  });
});

test("DFM dataset autocomplete ignores coordinate and Excel workbook brackets", () => {
  const coordinate = "= [Paid][2";
  assert.equal(findActiveDfmDatasetNameQuery(coordinate, coordinate.length), null);
  const excel = "= 'C:\\Data\\[Book";
  assert.equal(findActiveDfmDatasetNameQuery(excel, excel.length), null);
});

test("DFM formula resolution batches every reference into one API request", async () => {
  const parserSource = await readFile(
    new URL("../ui/method_pages/dfm/dfm_dataset_reference.js", import.meta.url),
    "utf8",
  );
  const parserUrl = moduleUrl(parserSource);
  const apiUrl = moduleUrl(`
    export const readDfmMethodIdentityFromPage = () => ({
      project_name: "Project",
      reserving_class: "RC",
    });
    export const resolveDfmDatasetReferences = async (payload) => {
      globalThis.__dfmDatasetReferencePayload = payload;
      return {
        results: payload.references.map((reference, index) => ({
          value: index + 10,
          row_label: "Row " + reference.row_idx,
          col_label: reference.col_idx ? "Column " + reference.col_idx : null,
        })),
      };
    };
  `);
  let formulaSource = await readFile(
    new URL("../ui/method_pages/dfm/dfm_dataset_formula.js", import.meta.url),
    "utf8",
  );
  formulaSource = formulaSource
    .replace(
      '"/ui/method_pages/dfm/dfm_method_api.js?v=20260814b"',
      JSON.stringify(apiUrl),
    )
    .replace(
      '"/ui/method_pages/dfm/dfm_dataset_reference.js?v=20260811b"',
      JSON.stringify(parserUrl),
    );

  const formulaModule = await import(moduleUrl(formulaSource));
  const resolved = await formulaModule.resolveDfmDatasetReferencesInFormulas([
    "=[Paid][1, 2] + [Premium][1]",
    "=[Paid][2, 2]",
  ]);

  assert.deepEqual(resolved, ["=10 + 11", "=12"]);
  assert.deepEqual(globalThis.__dfmDatasetReferencePayload, {
    project_name: "Project",
    reserving_class: "RC",
    references: [
      { dataset_name: "Paid", row_idx: "1", col_idx: "2" },
      { dataset_name: "Premium", row_idx: "1" },
      { dataset_name: "Paid", row_idx: "2", col_idx: "2" },
    ],
  });
  const detailed = await formulaModule.resolveDfmDatasetReferencesInFormulaDetailed(
    "=[Paid][-1, 2]",
  );
  assert.deepEqual(detailed, {
    formula: "=[Paid][-1, 2]",
    resolvedFormula: "=10",
    displayFormula: "=[Paid][Row -1, Column 2]",
  });

  // Resolution caches each reference's value for the session, so synchronous
  // summary recalculation can substitute them without a network round trip.
  assert.deepEqual(
    formulaModule.substituteCachedDfmDatasetReferencesInFormula('="Simple - 3" * [Paid][1, 2]'),
    { ok: true, formula: '="Simple - 3" * 10' },
  );
  assert.deepEqual(
    formulaModule.substituteCachedDfmDatasetReferencesInFormula("=[Premium][1] + [Paid][-1, 2]"),
    { ok: true, formula: "=11 + 10" },
  );
  assert.deepEqual(
    formulaModule.substituteCachedDfmDatasetReferencesInFormula("=2 * 3"),
    { ok: true, formula: "=2 * 3" },
  );
  assert.deepEqual(
    formulaModule.substituteCachedDfmDatasetReferencesInFormula("=[Never Resolved][1]"),
    { ok: false, formula: "=[Never Resolved][1]" },
  );
  assert.deepEqual(
    formulaModule.substituteCachedDfmDatasetReferencesInFormula("=[Paid][1, "),
    { ok: false, formula: "=[Paid][1, " },
  );

  // The same cache answers per reference, in formula order, so the formula bar
  // can tell which pills are worth exactly 1 without a read of its own.
  assert.deepEqual(
    formulaModule.getCachedDfmDatasetReferenceValues('="Simple - 3" * [Premium][1] * [Paid][1, 2]'),
    [11, 10],
  );
  assert.deepEqual(
    formulaModule.getCachedDfmDatasetReferenceValues("=[Never Resolved][1] * [Paid][1, 2]"),
    [null, 10],
  );
  assert.deepEqual(formulaModule.getCachedDfmDatasetReferenceValues("=2 * 3"), []);
  assert.deepEqual(formulaModule.getCachedDfmDatasetReferenceValues("=[Paid][1, "), []);
  delete globalThis.__dfmDatasetReferencePayload;
});

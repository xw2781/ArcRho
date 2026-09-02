import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The Berquist Sherman User Value row accepts a typed number, an arithmetic
// formula, or an Excel reference, and lists its Excel links on the shared
// Links tab. The helpers behind that are pure, so they load here with their
// absolute imports rewritten to data: URLs.

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

const referenceUrl = dataUrl(await read("../ui/shared/integrations/excel_reference.js"));
const ratioCalcUrl = dataUrl(await read("../ui/method_pages/dfm/dfm_ratio_calc.js"));
const helpersSource = (await read("../ui/method_pages/berquist_sherman/berquist_sherman_user_values.js"))
  .replace('"/ui/shared/integrations/excel_reference.js?v=20260715a"', JSON.stringify(referenceUrl))
  .replace('"/ui/method_pages/dfm/dfm_ratio_calc.js"', JSON.stringify(ratioCalcUrl));
const helpers = await import(dataUrl(helpersSource));

const BOOK = "C:\\Reviews\\[Inflation.xlsx]Rates";
const ref = (cell) => `='${BOOK}'!${cell}`;

test("a typed number drops thousands separators and a blank clears the cell", () => {
  assert.deepEqual(helpers.parseUserValueNumber("1,250.5"), { ok: true, value: 1250.5 });
  assert.deepEqual(helpers.parseUserValueNumber("  "), { ok: true, value: null });
  assert.deepEqual(helpers.parseUserValueNumber("abc"), { ok: false, value: null });
  assert.equal(helpers.isUserValueFormula("0.05"), false);
  assert.equal(helpers.isUserValueFormula("=0.05*2"), true);
  assert.equal(helpers.isUserValueFormula(ref("B2")), true);
});

test("the arithmetic whitelist matches the DFM User Entry evaluator", async () => {
  assert.equal(helpers.evaluateUserValueArithmetic("=(1+2)*3/4"), 2.25);
  assert.equal(helpers.evaluateUserValueArithmetic("ROUND(2.38625, 4)"), 2.3863);
  assert.equal(helpers.evaluateUserValueArithmetic("=2**3"), null);
  assert.equal(helpers.evaluateUserValueArithmetic("=alert(1)"), null);
  // Both evaluators admit exactly the same characters, so a formula that one
  // page accepts cannot be refused by the other.
  const whitelist = /if \(!\/\^\(\?:\[0-9\+\\-\*\/\(\)\.,\\s\]\|ROUND\\\(\)\+\$\/u\.test\(expr\)\) return null;/u;
  assert.match(helpersSource, whitelist);
  assert.match(await read("../ui/method_pages/dfm/ratios_summary/summary_model.js"), whitelist);
});

test("an Excel formula evaluates from the workbook values it names", () => {
  const values = new Map();
  const [reference] = helpers.userValueExcelReferences(ref("B2"));
  values.set(helpers.excelSourceKey(reference), 0.045);
  assert.equal(helpers.evaluateUserValueFormula(ref("B2"), values), 0.045);
  assert.equal(helpers.evaluateUserValueFormula(`=${ref("B2").slice(1)} * 2`, values), 0.09);
  assert.equal(helpers.evaluateUserValueFormula(ref("b2"), values), 0.045, "addresses are case-insensitive");
  assert.throws(() => helpers.evaluateUserValueFormula(ref("C2"), values), /Rates!C2 has no numeric value/u);
  assert.throws(() => helpers.evaluateUserValueFormula("=1/x", values), /Enter a number, a formula, or an Excel cell reference/u);
  assert.throws(() => helpers.evaluateUserValueFormula(ref("B2:D2"), values), /is a range/u);
});

test("a pasted range fills the row to the right with one cell reference per column", () => {
  const entries = helpers.expandUserValueRangeEntry(ref("B2:E3"), 3, 5);
  assert.deepEqual(entries, [
    { column: 3, input: ref("B2") },
    { column: 4, input: ref("C2") },
  ]);
  assert.equal(helpers.expandUserValueRangeEntry(ref("B2"), 0, 5), null);
  assert.equal(helpers.expandUserValueRangeEntry("=1+1", 0, 5), null);
});

test("read items and link records name each workbook cell once", () => {
  const grids = [
    {
      scope: "inflation",
      label: "Average Inflation",
      inputs: ["", ref("B2"), `=${ref("B2").slice(1)}+0.01`, ""],
      columnLabels: ["12", "24", "36", "48"],
    },
    {
      scope: "average",
      label: "Current Average Case Reserves",
      inputs: ["", "", "", ref("B3")],
      columnLabels: ["12", "24", "36", "48"],
    },
  ];
  const items = helpers.excelReadItemsForInputs(grids.flatMap((grid) => grid.inputs));
  assert.deepEqual(items.map((item) => item.cell), ["B2", "B3"]);
  assert.equal(items[0].book_path, "C:\\Reviews\\Inflation.xlsx");
  assert.equal(items[0].sheet, "Rates");

  const records = helpers.buildUserValueLinkRecords(grids);
  assert.deepEqual(records.map((record) => [record.address, record.destination, record.affectedCellCount]), [
    ["B2", "Average Inflation / 24~36", 2],
    ["B3", "Current Average Case Reserves / 48", 1],
  ]);
  assert.equal(records[0].workbookPath, "C:\\Reviews\\Inflation.xlsx");
  assert.equal(records[0].worksheet, "Rates");
  assert.deepEqual(helpers.normalizeUserValueInputs(["=1", null], 3), ["=1", "", ""]);
});

test("the page keeps formula text beside the numbers only when a cell holds one", async () => {
  const main = await read("../ui/method_pages/berquist_sherman/berquist_sherman_main.js");
  assert.match(main, /if \(state\.userInflationInputs\.some\(Boolean\)\) \{\s*\n\s*methodTab\.user_inflation_inputs = state\.userInflationInputs\.slice\(\);/u);
  assert.match(main, /if \(state\.userAverageCaseReserveInputs\.some\(Boolean\)\) \{\s*\n\s*methodTab\.user_average_case_reserve_inputs = state\.userAverageCaseReserveInputs\.slice\(\);/u);
  assert.match(main, /state\.userInflationInputs = normalizeUserValueInputs\(\s*\n\s*method\.user_inflation_inputs,/u);
  // A blank User Value starts as null so the cell reads blank, and the
  // calculation's own normalizer reads that as zero.
  assert.match(main, /state\.userInflation = Array\(developmentCount\)\.fill\(null\)/u);
  assert.match(main, /state\.userAverageCaseReserves = Array\(developmentCount\)\.fill\(null\)/u);
});

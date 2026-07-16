import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExcelRangeSourceCells,
  containsExcelReference,
  excelColumnFromIndex,
  excelColumnToIndex,
  findExcelReferences,
  formatExcelReference,
  normalizeExcelCellAddress,
  normalizeExcelReferenceAddressCase,
  parseExcelCellAddress,
  parseExcelReference,
  parseStandaloneExcelRange,
} from "../ui/shared/integrations/excel_reference.js";

test("parses standalone Excel cell references and normalizes addresses", () => {
  const reference = parseExcelReference("='C:\\Claims\\[Book.xlsx]Paid Data'!$b$12");

  assert.deepEqual(reference, {
    bookPath: "C:\\Claims\\Book.xlsx",
    dir: "C:\\Claims\\",
    filename: "Book.xlsx",
    sheet: "Paid Data",
    cell: "B12",
    endCell: "B12",
  });
  assert.equal(normalizeExcelCellAddress("$az$101"), "AZ101");
  assert.equal(
    normalizeExcelReferenceAddressCase("='C:\\Claims\\[Book.xlsx]Paid Data'!$b$12:$ad$20"),
    "='C:\\Claims\\[Book.xlsx]Paid Data'!$B$12:$AD$20",
  );
});

test("formats standalone cell and range references", () => {
  assert.equal(
    formatExcelReference("C:\\Claims\\Book.xlsx", "Paid Data", "$b$12"),
    "='C:\\Claims\\[Book.xlsx]Paid Data'!$B$12",
  );
  assert.equal(
    formatExcelReference("C:/Claims/Book.xlsx", "Paid Data", "$b$12", "$d$14"),
    "='C:/Claims/[Book.xlsx]Paid Data'!$B$12:$D$14",
  );
});

test("round-trips Excel sources containing escaped apostrophes", () => {
  const formatted = formatExcelReference(
    "C:\\O'Brien\\Book.xlsx",
    "Bob's Data",
    "$a$1",
  );

  assert.equal(
    formatted,
    "='C:\\O''Brien\\[Book.xlsx]Bob''s Data'!$A$1",
  );
  assert.deepEqual(parseExcelReference(formatted), {
    bookPath: "C:\\O'Brien\\Book.xlsx",
    dir: "C:\\O'Brien\\",
    filename: "Book.xlsx",
    sheet: "Bob's Data",
    cell: "A1",
    endCell: "A1",
  });
  assert.deepEqual(
    findExcelReferences(`=2 * ${formatted}`).map(({ bookPath, sheet, cell }) => ({
      bookPath,
      sheet,
      cell,
    })),
    [{ bookPath: "C:\\O'Brien\\Book.xlsx", sheet: "Bob's Data", cell: "A1" }],
  );
});

test("finds multiple inline Excel references in an expression", () => {
  const references = findExcelReferences(
    "='C:\\Claims\\[Book.xlsx]Paid'!$a$1 + 'D:\\Inputs\\[Other.xlsm]Ratios'!c3:d4",
  );

  assert.equal(references.length, 2);
  assert.deepEqual(
    references.map(({ bookPath, sheet, cell, endCell }) => ({ bookPath, sheet, cell, endCell })),
    [
      { bookPath: "C:\\Claims\\Book.xlsx", sheet: "Paid", cell: "A1", endCell: "A1" },
      { bookPath: "D:\\Inputs\\Other.xlsm", sheet: "Ratios", cell: "C3", endCell: "D4" },
    ],
  );
});

test("finds the optional-quote standalone form", () => {
  const references = findExcelReferences("=C:\\Claims\\[Book.xlsx]Paid!a1:b2");

  assert.equal(references.length, 1);
  assert.equal(references[0].match, "C:\\Claims\\[Book.xlsx]Paid!a1:b2");
  assert.equal(references[0].cell, "A1");
  assert.equal(references[0].endCell, "B2");
});

test("parses reversed ranges and expands source cells from the top-left", () => {
  const range = parseStandaloneExcelRange("='C:\\Claims\\[Book.xlsx]Paid'!C3:A1");

  assert.ok(range);
  assert.equal(range.cell, "C3");
  assert.equal(range.endCell, "A1");
  assert.equal(range.row0, 0);
  assert.equal(range.col0, 0);
  assert.equal(range.rowCount, 3);
  assert.equal(range.colCount, 3);
  assert.deepEqual(buildExcelRangeSourceCells(range), [
    ["A1", "B1", "C1"],
    ["A2", "B2", "C2"],
    ["A3", "B3", "C3"],
  ]);
});

test("converts Excel columns and cell addresses", () => {
  assert.equal(excelColumnToIndex("A"), 0);
  assert.equal(excelColumnToIndex("AA"), 26);
  assert.equal(excelColumnToIndex("A1"), -1);
  assert.equal(excelColumnFromIndex(0), "A");
  assert.equal(excelColumnFromIndex(26), "AA");
  assert.equal(excelColumnFromIndex(-1), "");
  assert.deepEqual(parseExcelCellAddress("$AA$27"), { row: 26, col: 26 });
});

test("detects valid references and rejects invalid input", () => {
  assert.equal(containsExcelReference("='C:\\Claims\\[Book.xlsx]Paid'!A1"), true);
  assert.equal(containsExcelReference("=2 * 'C:\\Claims\\[Book.xlsx]Paid'!A1"), true);
  assert.equal(containsExcelReference("=A1 + B2"), false);
  assert.equal(parseExcelReference("not an Excel reference"), null);
  assert.equal(parseExcelReference("='C:\\Claims\\Book.xlsx]Paid'!A1"), null);
  assert.equal(parseStandaloneExcelRange("='C:\\Claims\\[Book.xlsx]Paid'!A1"), null);
  assert.deepEqual(findExcelReferences("not an Excel reference"), []);
});

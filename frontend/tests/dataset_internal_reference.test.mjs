import assert from "node:assert/strict";
import test from "node:test";

const reference = await import(
  new URL("../ui/shared/dataset/dataset_internal_reference.js", import.meta.url)
);

test("parses single, range, and triangle references", () => {
  const single = reference.parseInternalDatasetReference("=[C 82][4]");
  assert.equal(single.ok, true);
  assert.equal(single.datasetName, "C 82");
  assert.deepEqual(single.row, { start: "4", end: null });
  assert.equal(single.col, null);

  const ranged = reference.parseInternalDatasetReference("[C 82 - Prior Qtr Selected][1:6]");
  assert.equal(ranged.ok, true);
  assert.deepEqual(ranged.row, { start: "1", end: "6" });

  const triangle = reference.parseInternalDatasetReference('=[Paid Claims]["2024", 1:2]');
  assert.equal(triangle.ok, true);
  assert.deepEqual(triangle.row, { start: '"2024"', end: null });
  assert.deepEqual(triangle.col, { start: "1", end: "2" });
});

test("rejects non-standalone or malformed references", () => {
  for (const text of [
    "=[C 82][1] + 1",
    "=[C 82]",
    "=[C 82][]",
    "=[][1]",
    "=[C 82][1, 2, 3]",
    "=[C 82][1:2:3]",
    '=[C 82]["2017]',
    "=1.5",
    "='C:\\Data\\[Book.xlsx]Sheet 1'!A1",
  ]) {
    const parsed = reference.parseInternalDatasetReference(text);
    assert.equal(parsed.ok, false, text);
    assert.ok(parsed.error, text);
  }
});

test("formats canonical text and matches the parse round trip", () => {
  const parsed = reference.parseInternalDatasetReference("  [ C 82 ][ 1 : 6 ]  ");
  assert.equal(reference.formatInternalDatasetReference(parsed), "=[C 82][1:6]");
  const triangle = reference.parseInternalDatasetReference("=[Paid Claims][2 , 1:2]");
  assert.equal(reference.formatInternalDatasetReference(triangle), "=[Paid Claims][2, 1:2]");
});

test("pick drafts cover '=' and bracket drafts but never Excel drafts", () => {
  assert.equal(reference.isInternalReferencePickDraft("="), true);
  assert.equal(reference.isInternalReferencePickDraft("=[C 8"), true);
  assert.equal(reference.isInternalReferencePickDraft("=[C 82][1:6]"), true);
  assert.equal(reference.isInternalReferencePickDraft("='C:\\Data\\[Book.xlsx]Sheet 1'!A1"), false);
  assert.equal(reference.isInternalReferencePickDraft("=1.5"), false);
  assert.equal(reference.isInternalReferencePickDraft("12"), false);
});

test("builds reference text from a picked rectangle", () => {
  assert.equal(
    reference.buildInternalDatasetReferenceText({
      datasetName: "C 82 - Prior Qtr Selected",
      rowStart: 0,
      rowEnd: 5,
      colStart: 0,
      colEnd: 0,
      isVector: true,
    }),
    "=[C 82 - Prior Qtr Selected][1:6]",
  );
  assert.equal(
    reference.buildInternalDatasetReferenceText({
      datasetName: "Paid Claims",
      rowStart: 1,
      rowEnd: 1,
      colStart: 0,
      colEnd: 1,
      isVector: false,
    }),
    "=[Paid Claims][2, 1:2]",
  );
  assert.equal(
    reference.buildInternalDatasetReferenceText({
      datasetName: "",
      rowStart: 0,
      rowEnd: 0,
    }),
    "",
  );
});

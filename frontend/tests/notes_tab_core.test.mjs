import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function importSource(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  return import(
    "data:text/javascript;base64," + Buffer.from(source).toString("base64")
  );
}

const notesPaths = await importSource(
  "../ui/shared/tabs/notes/notes_paths.js",
);
const notesText = await importSource(
  "../ui/shared/tabs/notes/notes_text.js",
);

test("finds drive and UNC file paths without surrounding prose punctuation", () => {
  const source = 'Open "C:\\Claims\\July Book.xlsx", then \\\\server\\share\\memo.pdf.';
  const matches = notesPaths.findNotesPathMatches(source);

  assert.deepEqual(
    matches.map((match) => match.path),
    [
      "C:\\Claims\\July Book.xlsx",
      "\\\\server\\share\\memo.pdf",
    ],
  );
  assert.deepEqual(
    matches.map((match) => source.slice(match.start, match.end)),
    [
      "C:\\Claims\\July Book.xlsx",
      "\\\\server\\share\\memo.pdf",
    ],
  );
});

test("trims a detected path at a known file extension before prose", () => {
  assert.deepEqual(
    notesPaths.findNotesPathMatches(
      "Review C:\\Claims\\July Book.xlsx before approval",
    ),
    [{
      start: 7,
      end: 31,
      path: "C:\\Claims\\July Book.xlsx",
    }],
  );
});

test("shows read-only open only for Excel workbook extensions", () => {
  assert.equal(
    notesPaths.isExcelWorkbookPath(' "C:\\Claims\\Book.XLSM", '),
    true,
  );
  assert.equal(
    notesPaths.isExcelWorkbookPath("C:\\Claims\\Book.csv"),
    false,
  );
});

test("Tab inserts the shared four-space unit and replaces a selection", () => {
  assert.deepEqual(
    notesText.indentNotesText("abc", 1, 2),
    {
      value: "a    c",
      selectionStart: 5,
      selectionEnd: 5,
    },
  );
});

test("Shift+Tab outdents all selected lines and preserves selection bounds", () => {
  assert.deepEqual(
    notesText.outdentNotesText("    one\n    two\nthree", 0, 16),
    {
      value: "one\ntwo\nthree",
      selectionStart: 0,
      selectionEnd: 8,
    },
  );
});

test("Shift+Tab removes one literal tab from the current line", () => {
  assert.deepEqual(
    notesText.outdentNotesText("\titem", 5, 5),
    {
      value: "item",
      selectionStart: 4,
      selectionEnd: 4,
    },
  );
});

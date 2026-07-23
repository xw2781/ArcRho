import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function importSource(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  return import(
    "data:text/javascript;base64," + Buffer.from(source).toString("base64")
  );
}

const foldersModel = await importSource(
  "../ui/file_explorer/file_explorer_model.js",
);

test("derives folder nicknames for drive, UNC, POSIX, and relative paths", () => {
  assert.equal(foldersModel.defaultHomeFolderNickname("C:\\"), "C:");
  assert.equal(foldersModel.defaultHomeFolderNickname("C:\\Work\\Reports\\"), "Reports");
  assert.equal(foldersModel.defaultHomeFolderNickname("\\\\server\\share\\"), "share");
  assert.equal(foldersModel.defaultHomeFolderNickname("\\\\server\\share\\Models"), "Models");
  assert.equal(foldersModel.defaultHomeFolderNickname("/"), "/");
  assert.equal(foldersModel.defaultHomeFolderNickname("/var/log/"), "log");
  assert.equal(foldersModel.defaultHomeFolderNickname("relative/folder"), "folder");
  assert.equal(foldersModel.defaultHomeFolderNickname(""), "Folder");
});

test("migrates string shortcuts, preserves nicknames and order, and deduplicates paths", () => {
  assert.equal(
    foldersModel.homeFolderPathKey("C:\\Data\\Reports\\"),
    foldersModel.homeFolderPathKey("c:/data/reports"),
  );
  assert.deepEqual(
    foldersModel.normalizeHomeFolderShortcuts([
      "C:\\Data\\Reports\\",
      { path: "c:/data/reports", nickname: "Duplicate loses" },
      { folderPath: "\\\\Server\\Share\\Models", nickname: "  Pricing Models  " },
      { path: "/var/log", nickname: "   " },
      { path: "/VAR/LOG/", nickname: "Duplicate log" },
      null,
      { path: "" },
    ]),
    [
      { path: "C:\\Data\\Reports\\", nickname: "Reports" },
      { path: "\\\\Server\\Share\\Models", nickname: "Pricing Models" },
      { path: "/var/log", nickname: "log" },
    ],
  );

  assert.deepEqual(
    foldersModel.normalizeHomeFolderShortcuts({ path: "D:\\Models", label: "Models Drive" }),
    [{ path: "D:\\Models", nickname: "Models Drive" }],
  );
});

test("normalizes legacy arrays and persisted folder documents to the current schema", () => {
  assert.equal(foldersModel.FILE_EXPLORER_FAVORITES_SCHEMA_VERSION, 1);
  assert.deepEqual(
    foldersModel.normalizeHomeFoldersDocument(["C:\\Data"]),
    {
      version: 1,
      folders: [{ path: "C:\\Data", nickname: "Data" }],
    },
  );
  assert.deepEqual(
    foldersModel.normalizeHomeFoldersDocument({
      version: 99,
      folders: [
        { path: "D:\\Models", nickname: "Pricing" },
        { path: "d:/models", nickname: "Duplicate" },
      ],
    }),
    {
      version: 1,
      folders: [{ path: "D:\\Models", nickname: "Pricing" }],
    },
  );
  assert.deepEqual(
    foldersModel.normalizeHomeFoldersDocument(null),
    { version: 1, folders: [] },
  );
});

test("finds parents without navigating above drive, UNC-share, or POSIX roots", () => {
  assert.equal(foldersModel.parentFolderPath("C:\\Users\\analyst\\Documents\\"), "C:\\Users\\analyst");
  assert.equal(foldersModel.parentFolderPath("C:\\Users"), "C:\\");
  assert.equal(foldersModel.parentFolderPath("C:\\"), "");
  assert.equal(foldersModel.parentFolderPath("\\\\server\\share\\folder\\child"), "\\\\server\\share\\folder");
  assert.equal(foldersModel.parentFolderPath("\\\\server\\share\\folder"), "\\\\server\\share");
  assert.equal(foldersModel.parentFolderPath("\\\\server\\share\\"), "");
  assert.equal(foldersModel.parentFolderPath("/home/analyst/data/"), "/home/analyst");
  assert.equal(foldersModel.parentFolderPath("/home"), "/");
  assert.equal(foldersModel.parentFolderPath("/"), "");
  assert.equal(foldersModel.parentFolderPath("relative/folder/file"), "relative/folder");
  assert.equal(foldersModel.parentFolderPath("relative"), "");
});

test("normalizes file entries with optional size and modified metadata", () => {
  const modifiedAt = "2026-07-22T14:30:00.000Z";
  assert.deepEqual(
    foldersModel.normalizeHomeFileEntry({
      name: "Report.xlsx",
      path: "C:\\Data\\Report.xlsx",
      isFile: true,
      size: "1536",
      modifiedAt,
    }),
    {
      name: "Report.xlsx",
      path: "C:\\Data\\Report.xlsx",
      isDirectory: false,
      isFile: true,
      size: 1536,
      mtimeMs: Date.parse(modifiedAt),
    },
  );

  assert.deepEqual(
    foldersModel.normalizeHomeFileEntry({
      path: "C:\\Data\\Archive",
      kind: "folder",
      size: 4096,
    }),
    {
      name: "Archive",
      path: "C:\\Data\\Archive",
      isDirectory: true,
      isFile: false,
      size: null,
      mtimeMs: null,
    },
  );

  assert.deepEqual(
    foldersModel.normalizeHomeFileEntries([null, "C:\\Data\\notes.txt", {}]),
    [{
      name: "notes.txt",
      path: "C:\\Data\\notes.txt",
      isDirectory: false,
      isFile: true,
      size: null,
      mtimeMs: null,
    }],
  );
});

test("labels common file types and formats byte sizes", () => {
  assert.equal(foldersModel.getHomeFileTypeLabel({ name: "Data", isDirectory: true }), "File folder");
  assert.equal(foldersModel.getHomeFileTypeLabel("Quarterly.XLSX"), "Microsoft Excel Worksheet");
  assert.equal(foldersModel.getHomeFileTypeLabel("memo.pdf"), "PDF Document");
  assert.equal(foldersModel.getHomeFileTypeLabel("archive.custom"), "CUSTOM File");
  assert.equal(foldersModel.getHomeFileTypeLabel("LICENSE"), "File");

  assert.equal(foldersModel.formatHomeFileSize(null), "");
  assert.equal(foldersModel.formatHomeFileSize(0), "0 B");
  assert.equal(foldersModel.formatHomeFileSize(512), "512 B");
  assert.equal(foldersModel.formatHomeFileSize(1024), "1 KB");
  assert.equal(foldersModel.formatHomeFileSize(1536), "1.5 KB");
  assert.equal(foldersModel.formatHomeFileSize(10 * 1024 * 1024), "10 MB");

  const timestamp = Date.parse("2026-07-22T14:30:00.000Z");
  const expectedDate = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
  assert.equal(foldersModel.formatHomeFileDate(timestamp, "en-US"), expectedDate);
  assert.equal(foldersModel.formatHomeFileDate("not a date", "en-US"), "");
});

const SORT_ENTRIES = [
  { name: "Zeta", path: "C:\\Root\\Zeta", isDirectory: true, mtimeMs: 500 },
  { name: "Alpha", path: "C:\\Root\\Alpha", isDirectory: true, mtimeMs: 100 },
  { name: "report10.txt", path: "C:\\Root\\report10.txt", size: 10, mtimeMs: 300 },
  { name: "report2.pdf", path: "C:\\Root\\report2.pdf", size: 200, mtimeMs: 100 },
  { name: "book.xlsx", path: "C:\\Root\\book.xlsx", size: 50, mtimeMs: 200 },
  { name: "unknown.bin", path: "C:\\Root\\unknown.bin" },
];

function sortedNames(options) {
  return foldersModel.filterAndSortHomeFileEntries(SORT_ENTRIES, options).map((entry) => entry.name);
}

test("filters entries by name, path, or derived type", () => {
  assert.deepEqual(sortedNames({ query: "report" }), ["report2.pdf", "report10.txt"]);
  assert.deepEqual(sortedNames({ query: "excel" }), ["book.xlsx"]);
  assert.deepEqual(sortedNames({ query: "root\\alpha" }), ["Alpha"]);
});

test("sorts folders first by name in ascending and descending directions", () => {
  assert.deepEqual(
    sortedNames({ sortKey: "name", sortDirection: "asc" }),
    ["Alpha", "Zeta", "book.xlsx", "report2.pdf", "report10.txt", "unknown.bin"],
  );
  assert.deepEqual(
    sortedNames({ sortKey: "name", sortDirection: "desc" }),
    ["Zeta", "Alpha", "unknown.bin", "report10.txt", "report2.pdf", "book.xlsx"],
  );
});

test("sorts file metadata by date, type, and size while keeping missing values last", () => {
  assert.deepEqual(
    sortedNames({ sortKey: "date", sortDirection: "asc" }),
    ["Alpha", "Zeta", "report2.pdf", "book.xlsx", "report10.txt", "unknown.bin"],
  );
  assert.deepEqual(
    sortedNames({ sortKey: "date", sortDirection: "desc" }),
    ["Zeta", "Alpha", "report10.txt", "book.xlsx", "report2.pdf", "unknown.bin"],
  );
  assert.deepEqual(
    sortedNames({ sortKey: "type", sortDirection: "asc" }),
    ["Alpha", "Zeta", "unknown.bin", "book.xlsx", "report2.pdf", "report10.txt"],
  );
  assert.deepEqual(
    sortedNames({ sortKey: "size", sortDirection: "desc" }),
    ["Zeta", "Alpha", "report2.pdf", "book.xlsx", "report10.txt", "unknown.bin"],
  );
});

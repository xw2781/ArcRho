// The Excel link inventory, in the shape every surface that shows it reads.
//
// `POST /excel_links/list` answers with one entry per linked workbook and, in
// it, one usage per object that reads it; `POST /excel_links/check` answers
// with the same listing after reading every linked cell on ArcRho Server and
// comparing it with the value the object has stored. Two surfaces consume
// that: the Excel Link Manager window, which shows a row per usage, and the
// Project Instance dataset table, which folds the verdict into its own Status
// column so a stale link is visible without opening the manager.
//
// This module owns the normalization, the poll's change signature, and the
// reduction of a checked listing to one verdict per object, so the two
// surfaces cannot disagree about what the server said.

function text(value) {
  return String(value ?? "").trim();
}

function count(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

// How often the listing is polled for a workbook saved outside ArcRho. The
// listing is one hosted read that stats each workbook; the values are only
// re-compared when the listing itself moved.
export const LISTING_POLL_MS = 15000;

export const STATUS_NEEDS_REVIEW = "needs_review";
export const STATUS_UPDATED = "updated";

/**
 * The listing's workbooks in the shape the consumers read. `valueCheck` marks
 * every usage's status as the value comparison (`checkedValues`) rather than
 * the listing's file-time verdict.
 */
export function normalizeExcelLinkWorkbooks(value, { valueCheck = false } = {}) {
  const source = Array.isArray(value) ? value : [];
  return source
    .map((item) => ({
      workbookPath: text(item?.workbook_path),
      workbookName: text(item?.workbook_name) || text(item?.workbook_path),
      folder: text(item?.folder),
      exists: item?.exists === true,
      // The server's stat of the file; part of the poll's change signature.
      mtime: Number.isFinite(Number(item?.mtime)) && item?.mtime !== null ? Number(item.mtime) : null,
      // The workbook's own Created/Modified/Last saved by, the workbook-side
      // answer to the dataset table's Created, Last Modified, and User. A
      // workbook that carries none - a legacy .xls, an encrypted package -
      // leaves them blank.
      created: text(item?.created),
      modified: text(item?.modified),
      lastModifiedBy: text(item?.last_modified_by),
      datasetCount: count(item?.dataset_count),
      methodCount: count(item?.method_count),
      linkCount: count(item?.link_count),
      cellCount: count(item?.cell_count),
      usages: (Array.isArray(item?.usages) ? item.usages : [])
        .map((usage) => ({
          kind: usage?.kind === "dfm" ? "dfm" : "dataset",
          name: text(usage?.name),
          datasetType: text(usage?.dataset_type),
          methodType: text(usage?.method_type),
          // needs_review / updated, or blank when the server could not settle it.
          status: text(usage?.status),
          statusPending: false,
          checkedValues: valueCheck === true,
          changedCellCount: count(usage?.changed_cell_count),
          checkError: text(usage?.check_error),
          linkCount: count(usage?.link_count),
          cellCount: count(usage?.cell_count),
        }))
        .filter((usage) => usage.name),
    }))
    .filter((item) => item.workbookPath);
}

/** The same workbooks with every status blanked and marked as being checked. */
export function pendingExcelLinkWorkbooks(workbooks) {
  return (Array.isArray(workbooks) ? workbooks : []).map((workbook) => ({
    ...workbook,
    usages: workbook.usages.map((usage) => ({
      ...usage, status: "", statusPending: true, checkedValues: false, changedCellCount: 0, checkError: "",
    })),
  }));
}

/**
 * What a poll compares one listing with the last: each workbook's path, file
 * time, and reachability, and each usage with its file-time verdict. A
 * workbook saved in Excel moves its file time; a dataset saved in ArcRho
 * moves its verdict; a link added or removed changes the usages.
 */
export function excelLinkListingSignature(workbooks) {
  return JSON.stringify((Array.isArray(workbooks) ? workbooks : []).map((workbook) => [
    text(workbook?.workbookPath).toLowerCase(),
    workbook?.mtime ?? null,
    workbook?.exists === true,
    text(workbook?.modified),
    (Array.isArray(workbook?.usages) ? workbook.usages : []).map((usage) => [usage.kind, usage.name, usage.status]),
  ]));
}

/**
 * One verdict per object named in a checked listing, folded across every
 * workbook it reads. A DFM method and the dataset it writes carry the same
 * name, so both arrive under that one name and the dataset table finds its
 * row either way.
 *
 * Only a value comparison counts: a usage still carrying the listing's
 * file-time verdict, or one the server could not settle, is not a changed
 * value and must not flag a row.
 */
export function excelLinkObjectStatuses(workbooks) {
  const byName = new Map();
  for (const workbook of Array.isArray(workbooks) ? workbooks : []) {
    for (const usage of Array.isArray(workbook?.usages) ? workbook.usages : []) {
      const name = text(usage?.name);
      if (!name || usage?.checkedValues !== true) continue;
      const entry = byName.get(name) || {
        name,
        needsReview: false,
        changedCellCount: 0,
        workbookNames: [],
      };
      if (usage.status === STATUS_NEEDS_REVIEW) {
        entry.needsReview = true;
        entry.changedCellCount += count(usage.changedCellCount);
        const book = text(workbook?.workbookName) || text(workbook?.workbookPath);
        if (book && !entry.workbookNames.includes(book)) entry.workbookNames.push(book);
      }
      byName.set(name, entry);
    }
  }
  return [...byName.values()].filter((entry) => entry.needsReview);
}

/** The Status tooltip sentence for an object whose linked values moved. */
export function excelLinkChangeSentence(entry) {
  if (!entry?.needsReview) return "";
  const cells = count(entry.changedCellCount);
  const books = Array.isArray(entry.workbookNames) ? entry.workbookNames : [];
  const source = books.length === 1
    ? books[0]
    : `${books.length} workbooks`;
  const values = cells === 1 ? "1 linked value differs" : `${cells} linked values differ`;
  return cells
    ? `${values} from ${source}; refresh the Excel links to load them.`
    : `The linked values differ from ${source}; refresh the Excel links to load them.`;
}

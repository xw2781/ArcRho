import { config } from "/ui/shared/dataset/dataset_config.js";

async function parseExcelResponse(resp, signal) {
  try {
    return await resp.json();
  } catch (error) {
    if (signal?.aborted) {
      const aborted = new Error("Excel request was cancelled.");
      aborted.name = "AbortError";
      throw aborted;
    }
    if (error?.name === "AbortError") throw error;
    return { ok: false, error: "Network error" };
  }
}

export async function readExcelCell(bookPath, sheet, cell, options = {}) {
  const resp = await fetch(`${config.API_BASE}/excel/read_cell`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ book_path: bookPath, sheet, cell }),
    signal: options.signal,
  });
  return parseExcelResponse(resp, options.signal);
}

export async function readExcelCellsBatch(items, options = {}) {
  const resp = await fetch(`${config.API_BASE}/excel/read_cells_batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
    signal: options.signal,
  });
  return parseExcelResponse(resp, options.signal);
}

/**
 * Validates saved link sources and reports each workbook's timestamp in one pass.
 *
 * The response carries `results` in item order, exactly as
 * `readExcelCellsBatch` does, plus `workbooks` with one `{path, ok, mtime}`
 * entry per distinct workbook, so an opening dataset or method can tell a
 * broken reference from a merely newer workbook without a second round trip.
 */
export async function validateExcelLinksBatch(items, options = {}) {
  const resp = await fetch(`${config.API_BASE}/excel/validate_links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: Array.isArray(items) ? items : [] }),
    signal: options.signal,
  });
  return parseExcelResponse(resp, options.signal);
}

export async function readExcelFileMtimesBatch(bookPaths, options = {}) {
  const resp = await fetch(`${config.API_BASE}/excel/file_mtimes_batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ book_paths: Array.isArray(bookPaths) ? bookPaths : [] }),
    signal: options.signal,
  });
  return parseExcelResponse(resp, options.signal);
}

export async function openExcelWorkbook(bookPath, sheet = "", cell = "") {
  const resp = await fetch(`${config.API_BASE}/excel/open_workbook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ book_path: bookPath, sheet, cell }),
  });
  return resp.json().catch(() => ({ ok: false, error: "Network error" }));
}

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

/**
 * Reads workbook cells in item order, one answer per item.
 *
 * Every linked-workbook read a window performs goes through here, and the app
 * server hands it to the ArcRho Server host whenever one is reachable, so the
 * workbook is opened on the machine a refresh and a retarget have to be able
 * to open it on rather than over this machine's mapped drive.
 */
export async function readExcelCellsBatch(items, options = {}) {
  const resp = await fetch(`${config.API_BASE}/excel/read_cells_batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
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

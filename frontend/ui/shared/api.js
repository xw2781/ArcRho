// All HTTP calls live here.

import { config } from "/ui/shared/config.js";

export async function getDataset(dsId = config.DS_ID, options = {}) {
  const params = new URLSearchParams({
    project_name: String(options?.projectName ?? options?.project_name ?? "").trim(),
    origin_length: String(options?.originLength ?? options?.origin_length ?? "").trim(),
  });
  const resp = await fetch(`${config.API_BASE}/dataset/${encodeURIComponent(dsId)}?${params.toString()}`);
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

export async function patchDataset(items, fileMtime, dsId = config.DS_ID) {
  const resp = await fetch(`${config.API_BASE}/dataset/${dsId}/patch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items, file_mtime: fileMtime }),
  });

  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

export async function loadDatasetNotes(payload) {
  const resp = await fetch(`${config.API_BASE}/dataset/notes/load`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

export async function saveDatasetNotes(payload) {
  const resp = await fetch(`${config.API_BASE}/dataset/notes/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

export async function loadDatasetSidecar(payload) {
  const resp = await fetch(`${config.API_BASE}/dataset/sidecar/load`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

export async function saveDatasetSidecar(payload) {
  const resp = await fetch(`${config.API_BASE}/dataset/sidecar/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

export async function previewCalculatedDatasetDependents(payload) {
  const resp = await fetch(`${config.API_BASE}/dataset/calculated/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

// =============================================================================
// Excel Cell Linking
// =============================================================================

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

export async function getExcelActiveSelection() {
  const resp = await fetch(`${config.API_BASE}/excel/active_selection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return resp.json().catch(() => ({ ok: false, error: "Network error" }));
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

export async function excelWaitForEnter(options = {}) {
  const resp = await fetch(`${config.API_BASE}/excel/wait_for_enter`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
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

// All HTTP calls live here.

import { config } from "./config.js";

export async function getDataset(dsId = config.DS_ID, startYear = config.START_YEAR) {
  const resp = await fetch(`${config.API_BASE}/dataset/${dsId}?start_year=${encodeURIComponent(startYear)}`);
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

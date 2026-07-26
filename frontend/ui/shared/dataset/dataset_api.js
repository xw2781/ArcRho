// Dataset HTTP client functions.

import { config } from "/ui/shared/dataset/dataset_config.js";

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

export async function getDatasetNumberFormatDefaults(options = {}) {
  const params = new URLSearchParams();
  const datasetTypeName = String(options?.datasetTypeName ?? options?.dataset_type_name ?? "").trim();
  if (datasetTypeName) params.set("dataset_type_name", datasetTypeName);
  const query = params.toString();
  const resp = await fetch(`${config.API_BASE}/dataset/number-format-defaults${query ? `?${query}` : ""}`, {
    cache: "no-store",
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

export async function loadCachedDataset(payload) {
  const resp = await fetch(`${config.API_BASE}/dataset/cache/load`, {
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

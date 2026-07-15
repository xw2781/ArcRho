const DEFAULT_DATASET_TYPES_COLUMNS = ["Name", "Data Format", "Category", "Calculated", "Formula", "Generated"];

function toText(value) {
  return String(value || "").trim();
}

function normalizeKey(value) {
  return toText(value).replace(/\s+/g, " ").toLowerCase();
}

export function parseDatasetTypesCalculatedFlag(value) {
  if (typeof value === "boolean") return value;
  const text = normalizeKey(value);
  return text === "true" || text === "1" || text === "yes" || text === "y";
}

export function parseDatasetTypesGeneratedFlag(value) {
  return parseDatasetTypesCalculatedFlag(value);
}

function buildColumnIndexByName(columns) {
  const out = new Map();
  for (let i = 0; i < (Array.isArray(columns) ? columns.length : 0); i += 1) {
    const key = normalizeKey(columns[i]);
    if (key && !out.has(key)) out.set(key, i);
  }
  return out;
}

function getRowValueByIndex(row, index, fallback = "") {
  if (!Array.isArray(row)) return fallback;
  if (!Number.isInteger(index) || index < 0 || index >= row.length) return fallback;
  return row[index];
}

function getRowValueByKeys(row, keys = [], fallback = "") {
  if (!row || typeof row !== "object" || Array.isArray(row)) return fallback;
  for (const key of Array.isArray(keys) ? keys : []) {
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  }
  return fallback;
}

export function normalizeDatasetTypesPayload(rawPayload) {
  const payload = rawPayload && typeof rawPayload === "object" && rawPayload.data && typeof rawPayload.data === "object"
    ? rawPayload.data
    : rawPayload;

  if (Array.isArray(payload)) {
    return normalizeDatasetTypesPayload({ rows: payload });
  }

  const columns = Array.isArray(payload?.columns)
    ? payload.columns.map((c) => toText(c))
    : [...DEFAULT_DATASET_TYPES_COLUMNS];
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const indexByName = buildColumnIndexByName(columns);
  const outRows = [];

  const idxName = indexByName.has("name") ? Number(indexByName.get("name")) : -1;
  const idxDataFormat = indexByName.has("data format") ? Number(indexByName.get("data format")) : -1;
  const idxCategory = indexByName.has("category") ? Number(indexByName.get("category")) : -1;
  const idxCalculated = indexByName.has("calculated") ? Number(indexByName.get("calculated")) : -1;
  const idxFormula = indexByName.has("formula") ? Number(indexByName.get("formula")) : -1;
  const idxGenerated = indexByName.has("generated") ? Number(indexByName.get("generated")) : -1;

  for (const row of rows) {
    if (Array.isArray(row)) {
      outRows.push([
        toText(getRowValueByIndex(row, idxName, row[0])),
        toText(getRowValueByIndex(row, idxDataFormat, row[1])),
        toText(getRowValueByIndex(row, idxCategory, row[2])),
        parseDatasetTypesCalculatedFlag(getRowValueByIndex(row, idxCalculated, row[3])),
        toText(getRowValueByIndex(row, idxFormula, row[4])),
        parseDatasetTypesGeneratedFlag(getRowValueByIndex(row, idxGenerated, row[6])),
      ]);
      continue;
    }
    if (row && typeof row === "object") {
      outRows.push([
        toText(getRowValueByKeys(row, ["Name", "name"])),
        toText(getRowValueByKeys(row, ["Data Format", "dataFormat", "data_format"])),
        toText(getRowValueByKeys(row, ["Category", "category"])),
        parseDatasetTypesCalculatedFlag(getRowValueByKeys(row, ["Calculated", "calculated"])),
        toText(getRowValueByKeys(row, ["Formula", "formula"])),
        parseDatasetTypesGeneratedFlag(getRowValueByKeys(row, ["Generated", "generated"])),
      ]);
    }
  }

  return {
    columns: [...DEFAULT_DATASET_TYPES_COLUMNS],
    rows: outRows,
  };
}

export function extractDatasetTypeItems(columns, rows, options = {}) {
  const normalized = normalizeDatasetTypesPayload({ columns, rows });
  const itemDefaultCategory = toText(options?.defaultCategory) || "Uncategorized";
  const dedupeByName = options?.dedupeByName !== false;
  const out = [];
  const seen = new Set();

  for (const row of normalized.rows) {
    const name = toText(row?.[0]);
    if (!name) continue;
    const uniqueKey = normalizeKey(name);
    if (!uniqueKey) continue;
    if (dedupeByName && seen.has(uniqueKey)) continue;
    seen.add(uniqueKey);
    out.push({
      name,
      dataFormat: toText(row?.[1]),
      category: toText(row?.[2]) || itemDefaultCategory,
      calculated: !!parseDatasetTypesCalculatedFlag(row?.[3]),
      formula: toText(row?.[4]),
      generated: !!parseDatasetTypesGeneratedFlag(row?.[5]),
    });
  }

  return out;
}

export async function fetchProjectDatasetTypes(projectName, options = {}) {
  const name = toText(projectName);
  if (!name) {
    return {
      projectName: "",
      exists: false,
      sourcePath: "",
      data: normalizeDatasetTypesPayload({ columns: DEFAULT_DATASET_TYPES_COLUMNS, rows: [] }),
    };
  }

  const fetchImpl = typeof options?.fetchImpl === "function" ? options.fetchImpl : fetch;
  const endpoint = toText(options?.endpoint) || "/dataset_types";
  const resp = await fetchImpl(`${endpoint}?project_name=${encodeURIComponent(name)}`);
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(detail || `Failed to load dataset types (${resp.status}).`);
  }

  const payload = await resp.json().catch(() => ({}));
  const normalized = normalizeDatasetTypesPayload(payload?.data || {});
  return {
    projectName: name,
    exists: payload?.exists !== false,
    sourcePath: toText(payload?.path),
    data: normalized,
  };
}

export async function fetchProjectDatasetTypeItems(projectName, options = {}) {
  const fetched = await fetchProjectDatasetTypes(projectName, options);
  return {
    projectName: fetched.projectName,
    exists: fetched.exists,
    sourcePath: fetched.sourcePath,
    data: fetched.data,
    items: extractDatasetTypeItems(fetched.data?.columns, fetched.data?.rows, options),
  };
}

export const DATASET_TYPES_COLUMNS = [...DEFAULT_DATASET_TYPES_COLUMNS];

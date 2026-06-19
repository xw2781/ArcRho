const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const DATASET_ORIGIN_HEADER_PREFIX_V1 = "arcrho_header_labels::";
export const DATASET_ORIGIN_HEADER_CACHE_VERSION = "v3";
export const DATASET_ORIGIN_HEADER_PREFIX_V2 = `${DATASET_ORIGIN_HEADER_PREFIX_V1}${DATASET_ORIGIN_HEADER_CACHE_VERSION}::`;

export function normalizeDatasetOriginLength(value, fallback = 12) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getDatasetOriginHeaderCacheKey(project, originLen) {
  return `${DATASET_ORIGIN_HEADER_PREFIX_V2}${String(project || "").trim()}::${String(originLen || "")}`;
}

export function loadDatasetOriginLabelsFromCache(project, originLen) {
  try {
    const raw = localStorage.getItem(getDatasetOriginHeaderCacheKey(project, originLen)) || "";
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.labels)) return parsed.labels.map(String);
  } catch {
    // ignore
  }
  return null;
}

export function saveDatasetOriginLabelsToCache(project, originLen, labels) {
  if (!Array.isArray(labels)) return;
  try {
    localStorage.setItem(
      getDatasetOriginHeaderCacheKey(project, originLen),
      JSON.stringify({ labels: labels.map(String) }),
    );
  } catch {
    // ignore
  }
}

export async function fetchDatasetOriginLabels(projectName, originLen, options = {}) {
  const project = String(projectName || "").trim();
  if (!project) return null;
  const periodLength = normalizeDatasetOriginLength(originLen);
  const resp = await fetch("/arcrho/headers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ProjectName: project,
      PeriodLength: periodLength,
      timeout_sec: Number(options.timeoutSec) || 6.0,
      periodType: 0,
      Transposed: false,
      Calendar: false,
    }),
  });
  if (!resp.ok) throw new Error(`headers failed: ${resp.status}`);
  const data = await resp.json().catch(() => ({}));
  const labels = Array.isArray(data?.labels)
    ? data.labels
    : (Array.isArray(data?.headers)
      ? data.headers
      : (Array.isArray(data?.origin_labels) ? data.origin_labels : null));
  return Array.isArray(labels) ? labels.map(String) : null;
}

export async function ensureDatasetOriginLabels(projectName, originLen, options = {}) {
  const project = String(projectName || "").trim();
  const length = normalizeDatasetOriginLength(originLen);
  if (!project) return [];
  if (!options.forceRefresh) {
    const cached = loadDatasetOriginLabelsFromCache(project, length);
    if (Array.isArray(cached) && cached.length) return cached;
  }
  const labels = await fetchDatasetOriginLabels(project, length, options);
  if (Array.isArray(labels) && labels.length) {
    saveDatasetOriginLabelsToCache(project, length, labels);
    return labels;
  }
  return [];
}

export function formatDatasetOriginLabel(label, originLen) {
  if (Number(originLen) !== 1) return String(label ?? "");
  const s = String(label ?? "");
  if (!/^\d{6}$/.test(s)) return s;
  const mm = Number.parseInt(s.slice(4), 10);
  return `${MONTH_ABBR[mm - 1] || ""} ${s.slice(0, 4)}`.trim();
}

export function getDatasetOriginLabelText(originLen) {
  switch (Number(originLen)) {
    case 12: return "Accident Year";
    case 6: return "Accident Half-Year";
    case 3: return "Accident Quarter";
    case 1: return "Accident Month";
    default: return "Accident Period";
  }
}


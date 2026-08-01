const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NUMBER_BY_NAME = new Map([
  ["jan", 1], ["january", 1],
  ["feb", 2], ["february", 2],
  ["mar", 3], ["march", 3],
  ["apr", 4], ["april", 4],
  ["may", 5],
  ["jun", 6], ["june", 6],
  ["jul", 7], ["july", 7],
  ["aug", 8], ["august", 8],
  ["sep", 9], ["september", 9],
  ["oct", 10], ["october", 10],
  ["nov", 11], ["november", 11],
  ["dec", 12], ["december", 12],
]);
const ORIGIN_KIND_BY_LENGTH = new Map([[12, "year"], [6, "half"], [3, "quarter"], [1, "month"]]);

export function normalizeDatasetOriginLength(value, fallback = 12) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseDatasetOriginLabel(value) {
  const label = String(value ?? "").trim();
  let match = label.match(/^(\d{4})$/);
  if (match) {
    const year = Number(match[1]);
    return year > 0 ? { kind: "year", index: year } : null;
  }
  match = label.match(/^(\d{4})\s*H([12])$/i);
  if (match) {
    const year = Number(match[1]);
    return year > 0 ? { kind: "half", index: year * 2 + Number(match[2]) - 1 } : null;
  }
  match = label.match(/^(\d{4})\s*Q([1-4])$/i);
  if (match) {
    const year = Number(match[1]);
    return year > 0 ? { kind: "quarter", index: year * 4 + Number(match[2]) - 1 } : null;
  }
  match = label.match(/^(\d{4})(0[1-9]|1[0-2])$/);
  if (match) {
    const year = Number(match[1]);
    return year > 0 ? { kind: "month", index: year * 12 + Number(match[2]) - 1 } : null;
  }
  match = label.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (match) {
    const month = MONTH_NUMBER_BY_NAME.get(match[1].toLowerCase());
    const year = Number(match[2]);
    return month && year > 0 ? { kind: "month", index: year * 12 + month - 1 } : null;
  }
  return null;
}

export function validateDatasetOriginLabels(labels, options = {}) {
  if (!Array.isArray(labels) || !labels.length) {
    return { ok: false, labels: [], error: "no origin labels were returned" };
  }
  const normalized = labels.map((label) => String(label ?? "").trim());
  const expectedCount = Number.parseInt(String(options?.expectedCount ?? ""), 10);
  if (Number.isFinite(expectedCount) && expectedCount > 0 && normalized.length !== expectedCount) {
    return {
      ok: false,
      labels: [],
      error: `origin label count ${normalized.length} does not match data row count ${expectedCount}`,
    };
  }
  const parsed = normalized.map(parseDatasetOriginLabel);
  if (parsed.some((item) => !item)) {
    return { ok: false, labels: [], error: "one or more origin labels are blank or use an unsupported date format" };
  }
  const kinds = new Set(parsed.map((item) => item.kind));
  if (kinds.size !== 1) {
    return { ok: false, labels: [], error: "origin labels mix incompatible date formats" };
  }
  const originLength = Number.parseInt(String(options?.originLen ?? options?.originLength ?? ""), 10);
  const expectedKind = ORIGIN_KIND_BY_LENGTH.get(originLength);
  if (options?.requireMatchingPeriod === true && expectedKind && !kinds.has(expectedKind)) {
    return {
      ok: false,
      labels: [],
      error: `origin labels do not match the requested ${originLength}-month period length`,
    };
  }
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index].index !== parsed[index - 1].index + 1) {
      return { ok: false, labels: [], error: "origin labels are not consecutive" };
    }
  }
  return { ok: true, labels: normalized, error: "" };
}

function originLabelResolutionError(project, reason) {
  const detail = String(reason || "ArcRho project headers are unavailable").trim();
  if (/^cannot load\b/i.test(detail) || /Origin Start Date|Project Settings/i.test(detail)) {
    return new Error(detail);
  }
  if (/timed?\s*out|timeout/i.test(detail)) {
    return new Error(`Cannot load origin labels for project '${project}': ${detail}`);
  }
  return new Error(
    `Cannot load origin labels for project '${project}': ${detail}. Set a valid Origin Start Date in Project Settings, then try again.`,
  );
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
      periodType: 0,
      Transposed: false,
      Calendar: false,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.ok === false) {
    throw originLabelResolutionError(
      project,
      data?.detail || data?.error || data?.message || data?.status || `headers request failed (${resp.status})`,
    );
  }
  const labels = Array.isArray(data?.labels)
    ? data.labels
    : (Array.isArray(data?.headers)
      ? data.headers
      : (Array.isArray(data?.origin_labels) ? data.origin_labels : null));
  const result = validateDatasetOriginLabels(labels, {
    originLen: periodLength,
    expectedCount: options?.expectedCount,
    requireMatchingPeriod: options?.requireMatchingPeriod,
  });
  if (!result.ok) throw originLabelResolutionError(project, result.error);
  return result.labels;
}

export async function ensureDatasetOriginLabels(projectName, originLen, options = {}) {
  const project = String(projectName || "").trim();
  const length = normalizeDatasetOriginLength(originLen);
  if (!project) throw new Error("Cannot load origin labels: project name is missing.");
  return fetchDatasetOriginLabels(project, length, options);
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

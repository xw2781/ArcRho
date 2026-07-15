import {
  normalizeReservingClassPath,
  normalizeReservingClassPathKey,
} from "/ui/shared/services/valid_value_lists.js";

const LAST_VIEWED_KEY = "arcrho_dataset_last_viewed_v1";
const HISTORY_KEY = "arcrho_browsing_history_v1";
const DEFAULT_MAX_ENTRIES = 15;

function toText(value) {
  return String(value || "").trim();
}

function normalizeNameKey(value) {
  return toText(value).replace(/\s+/g, " ").toLowerCase();
}

function safeParseJson(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readStorageObject(key) {
  try {
    return safeParseJson(localStorage.getItem(key) || "");
  } catch {
    return null;
  }
}

function writeStorageObject(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value || null));
    return true;
  } catch {
    return false;
  }
}

function getEntryKey(entry) {
  if (!entry) return "";
  const projectKey = normalizeNameKey(entry.project);
  const pathKey = normalizeReservingClassPathKey(entry.path);
  const triKey = normalizeNameKey(entry.tri);
  if (!projectKey || !pathKey || !triKey) return "";
  return `${projectKey}||${pathKey}||${triKey}`;
}

export function normalizeBrowsingHistoryEntry(rawEntry) {
  if (!rawEntry || typeof rawEntry !== "object") return null;
  const project = toText(rawEntry.project || rawEntry.ProjectName || rawEntry.project_name);
  const path = normalizeReservingClassPath(
    rawEntry.path || rawEntry.Path || rawEntry.reservingClass || rawEntry.reserving_class,
  );
  const tri = toText(rawEntry.tri || rawEntry.TriangleName || rawEntry.datasetName || rawEntry.dataset_name);
  if (!project || !path || !tri) return null;
  const tsRaw = Number(rawEntry.ts);
  const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? Math.floor(tsRaw) : Date.now();
  return { project, path, tri, ts };
}

export function getLastViewedDatasetInputs() {
  const raw = readStorageObject(LAST_VIEWED_KEY);
  return normalizeBrowsingHistoryEntry(raw);
}

export function setLastViewedDatasetInputs(entry) {
  const normalized = normalizeBrowsingHistoryEntry(entry);
  if (!normalized) return null;
  writeStorageObject(LAST_VIEWED_KEY, normalized);
  return normalized;
}

export function getBrowsingHistoryEntries(options = {}) {
  const maxEntriesRaw = Number(options?.maxEntries);
  const maxEntries = Number.isFinite(maxEntriesRaw) && maxEntriesRaw >= 1
    ? Math.floor(maxEntriesRaw)
    : DEFAULT_MAX_ENTRIES;

  const raw = readStorageObject(HISTORY_KEY);
  const list = Array.isArray(raw?.entries) ? raw.entries : [];

  const out = [];
  const seen = new Set();
  for (const item of list) {
    const normalized = normalizeBrowsingHistoryEntry(item);
    if (!normalized) continue;
    const key = getEntryKey(normalized);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= maxEntries) break;
  }
  return out;
}

export function pushBrowsingHistoryEntry(entry, options = {}) {
  const maxEntriesRaw = Number(options?.maxEntries);
  const maxEntries = Number.isFinite(maxEntriesRaw) && maxEntriesRaw >= 1
    ? Math.floor(maxEntriesRaw)
    : DEFAULT_MAX_ENTRIES;

  const normalized = normalizeBrowsingHistoryEntry(entry);
  if (!normalized) {
    return {
      entry: null,
      entries: getBrowsingHistoryEntries({ maxEntries }),
    };
  }

  const next = [normalized];
  const targetKey = getEntryKey(normalized);
  for (const existing of getBrowsingHistoryEntries({ maxEntries: Math.max(maxEntries * 2, 100) })) {
    const existingKey = getEntryKey(existing);
    if (!existingKey || existingKey === targetKey) continue;
    next.push(existing);
    if (next.length >= maxEntries) break;
  }

  writeStorageObject(HISTORY_KEY, { entries: next });
  setLastViewedDatasetInputs(normalized);

  return { entry: normalized, entries: next };
}

export function clearBrowsingHistoryEntries() {
  writeStorageObject(HISTORY_KEY, { entries: [] });
}

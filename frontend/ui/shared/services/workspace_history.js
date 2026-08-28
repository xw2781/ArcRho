import { localDayKey } from "/ui/shared/services/local_day.js?v=20260828a";

const HISTORY_KEY = "arcrho_workspace_history_v1";
const DEFAULT_MAX_ENTRIES = 100;

function toText(value) { return String(value || "").trim(); }
function pathKey(path) { return toText(path).replace(/[\\/]+/g, "\\").toLowerCase(); }
// One record per folder per day: the same folder opened on two days keeps both records.
function entryKey(entry) { return `${pathKey(entry?.path)}|${localDayKey(entry?.ts)}`; }

function readHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "") || {}; } catch { return {}; }
}

function writeHistory(value) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(value)); } catch {}
}

export function normalizeWorkspaceHistoryEntry(raw) {
  const path = toText(raw?.path);
  if (!path) return null;
  const time = Number(raw?.ts);
  return { path, ts: Number.isFinite(time) && time > 0 ? Math.floor(time) : Date.now() };
}

export function getWorkspaceHistoryEntries(options = {}) {
  const maxEntries = Math.max(1, Math.floor(Number(options.maxEntries) || DEFAULT_MAX_ENTRIES));
  const source = readHistory();
  const seen = new Set();
  const entries = [];
  for (const raw of Array.isArray(source.entries) ? source.entries : []) {
    const entry = normalizeWorkspaceHistoryEntry(raw);
    const key = entry ? entryKey(entry) : "";
    if (!entry || !key || seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
    if (entries.length >= maxEntries) break;
  }
  return entries;
}

export function pushWorkspaceHistoryEntry(raw, options = {}) {
  const maxEntries = Math.max(1, Math.floor(Number(options.maxEntries) || DEFAULT_MAX_ENTRIES));
  const entry = normalizeWorkspaceHistoryEntry(raw);
  if (!entry) return getWorkspaceHistoryEntries({ maxEntries });
  const key = entryKey(entry);
  const entries = [entry];
  for (const existing of getWorkspaceHistoryEntries({ maxEntries: Math.max(maxEntries * 2, 200) })) {
    if (entryKey(existing) === key) continue;
    entries.push(existing);
    if (entries.length >= maxEntries) break;
  }
  writeHistory({ entries });
  return entries;
}

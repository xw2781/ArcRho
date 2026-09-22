import { createDependencyFilters, DEPENDENCY_FILTER_FIELDS } from "./dependency_graph_filters.js?v=20260921a";
import { STATUS_CURRENT, STATUS_REVIEW_NEEDED } from "../shared/dataset/review_status.js";

// Local-user state, shared by graph windows across projects on this PC.
export const DEPENDENCY_GRAPH_PREFERENCES_KEY = "arcrho_dependency_graph_filters";

export function normalizeDependencyGraphPreferences(source) {
  const filters = createDependencyFilters();
  for (const { key } of DEPENDENCY_FILTER_FIELDS) {
    const values = source?.filters?.[key];
    if (Array.isArray(values)) {
      for (const value of values) {
        if (typeof value !== "string") continue;
        const normalized = value.trim().toLowerCase();
        if (key !== "status" || [STATUS_CURRENT, STATUS_REVIEW_NEEDED].some(status => String(status) === normalized)) filters[key].add(normalized);
      }
    }
  }
  return { filters, matchedOnly: source?.matchedOnly !== false };
}

export function readDependencyGraphPreferences(storage) {
  try {
    return normalizeDependencyGraphPreferences(JSON.parse(
      (storage ?? globalThis.localStorage)?.getItem(DEPENDENCY_GRAPH_PREFERENCES_KEY) || "null",
    ));
  } catch {
    return normalizeDependencyGraphPreferences(null);
  }
}

export function writeDependencyGraphPreferences({ filters, matchedOnly }, storage) {
  const value = {
    filters: Object.fromEntries(DEPENDENCY_FILTER_FIELDS.map(({ key }) => [key, [...filters[key]].sort()])),
    matchedOnly,
  };
  (storage ?? globalThis.localStorage).setItem(DEPENDENCY_GRAPH_PREFERENCES_KEY, JSON.stringify(value));
}

/* Canonical catalog of the tabbed pages a Project Instance window can host.

   Every page below used to declare its own tab array, and the Project Instance
   window openers repeated the tab each kind opens on. The Preferences window
   has to offer the same lists and the same defaults, so a third copy would have
   guaranteed drift: this module owns the tab id/label list per window kind and
   the tab a window of that kind opens on when nothing asks for another one.

   `key` matches the `windowKind` the Project Instance window layer stores on a
   frame, so an opener, the preference payload, and a restored window all name a
   kind the same way. */

export const DATASET_VIEWER_TAB_DEFS = Object.freeze([
  { id: "details", label: "Details" },
  { id: "data", label: "Data" },
  { id: "chart", label: "Chart" },
  { id: "notes", label: "Notes" },
  { id: "links", label: "Links" },
  { id: "auditLog", label: "Audit Log" },
]);

export const DFM_TAB_DEFS = Object.freeze([
  { id: "details", label: "Details" },
  { id: "data", label: "Data" },
  { id: "ratios", label: "Ratios" },
  { id: "results", label: "Results" },
  { id: "notes", label: "Notes" },
  { id: "links", label: "Links" },
  { id: "audit", label: "Audit Log" },
]);

export const RESULT_SELECTION_TAB_DEFS = Object.freeze([
  { id: "details", label: "Details" },
  { id: "method", label: "Method" },
  { id: "chart", label: "Chart" },
  { id: "results", label: "Results" },
  { id: "validation", label: "Validation" },
  { id: "notes", label: "Notes" },
  { id: "audit", label: "Audit Log" },
]);

export const BORNHUETTER_FERGUSON_TAB_DEFS = Object.freeze([
  { id: "details", label: "Details" },
  { id: "method", label: "Method" },
  { id: "chart", label: "Chart" },
  { id: "notes", label: "Notes" },
  { id: "audit", label: "Audit Log" },
]);

export const CAPE_COD_TAB_DEFS = Object.freeze([
  { id: "details", label: "Details" },
  { id: "method", label: "Method" },
  { id: "ultimates", label: "Ultimates" },
  { id: "ratios", label: "Ratios" },
  { id: "notes", label: "Notes" },
  { id: "audit", label: "Audit Log" },
]);

export const BERQUIST_SHERMAN_TAB_DEFS = Object.freeze([
  { id: "details", label: "Details" },
  { id: "method", label: "Method" },
  { id: "notes", label: "Notes" },
  { id: "links", label: "Links" },
  { id: "audit", label: "Audit Log" },
]);

/* The order here is the order the Preferences window lists the kinds in. */
export const WINDOW_TAB_KINDS = Object.freeze([
  Object.freeze({
    key: "dataset",
    label: "Dataset Viewer",
    hint: "DSV",
    tabs: DATASET_VIEWER_TAB_DEFS,
    appDefaultTab: "data",
  }),
  Object.freeze({
    key: "dfm",
    label: "Development Factor Method",
    hint: "DFM",
    tabs: DFM_TAB_DEFS,
    appDefaultTab: "ratios",
  }),
  Object.freeze({
    key: "result_selection",
    label: "Result Selection",
    hint: "RS",
    tabs: RESULT_SELECTION_TAB_DEFS,
    appDefaultTab: "method",
  }),
  Object.freeze({
    key: "bornhuetter_ferguson",
    label: "Bornhuetter Ferguson",
    hint: "BF",
    tabs: BORNHUETTER_FERGUSON_TAB_DEFS,
    appDefaultTab: "method",
  }),
  Object.freeze({
    key: "cape_cod",
    label: "Cape Cod",
    hint: "CC",
    tabs: CAPE_COD_TAB_DEFS,
    appDefaultTab: "method",
  }),
  Object.freeze({
    key: "berquist_sherman",
    label: "Berquist Sherman",
    hint: "BS",
    tabs: BERQUIST_SHERMAN_TAB_DEFS,
    appDefaultTab: "method",
  }),
]);

/* Where a user's chosen defaults live. They are local-user state: one choice
   per Windows account on this PC, used in every project. */
export const DEFAULT_WINDOW_TABS_STORAGE_KEY = "arcrho_default_window_tabs";

const KIND_BY_KEY = new Map(WINDOW_TAB_KINDS.map((kind) => [kind.key, kind]));

export function windowTabKind(kindKey) {
  return KIND_BY_KEY.get(String(kindKey || "").trim()) || null;
}

export function windowTabIds(kindKey) {
  return new Set((windowTabKind(kindKey)?.tabs || []).map(({ id }) => id));
}

export function isWindowTab(kindKey, tabId) {
  return windowTabIds(kindKey).has(String(tabId || "").trim());
}

export function appDefaultWindowTab(kindKey) {
  return windowTabKind(kindKey)?.appDefaultTab || "";
}

/* The app defaults as a complete map, which is what an unsaved preference and
   the Preferences window's "Reset to app defaults" both start from. */
export function appDefaultWindowTabs() {
  const defaults = {};
  for (const kind of WINDOW_TAB_KINDS) defaults[kind.key] = kind.appDefaultTab;
  return defaults;
}

/* A stored map is user-editable JSON, so keep only ids the page can actually
   open and fill the rest from the app defaults. */
export function normalizeDefaultWindowTabs(stored) {
  const source = stored && typeof stored === "object" ? stored : {};
  const defaults = {};
  for (const kind of WINDOW_TAB_KINDS) {
    const value = String(source[kind.key] ?? "").trim();
    defaults[kind.key] = isWindowTab(kind.key, value) ? value : kind.appDefaultTab;
  }
  return defaults;
}

export function readDefaultWindowTabs() {
  let stored = null;
  try {
    // The stored text is a preference a user can edit by hand.
    stored = JSON.parse(globalThis.localStorage?.getItem(DEFAULT_WINDOW_TABS_STORAGE_KEY) || "null");
  } catch {
    stored = null;
  }
  return normalizeDefaultWindowTabs(stored);
}

/* Always a complete map, so a kind left at the app default is written rather
   than left to an older stored value. Returns what was stored. */
export function writeDefaultWindowTabs(chosen) {
  const defaults = normalizeDefaultWindowTabs(chosen);
  globalThis.localStorage?.setItem(DEFAULT_WINDOW_TABS_STORAGE_KEY, JSON.stringify(defaults));
  return defaults;
}

/* One rule for every opener: an explicitly requested tab wins, then the user's
   default for that kind, then the app default. */
export function resolveWindowTab(kindKey, requestedTab, defaults) {
  const requested = String(requestedTab || "").trim();
  if (isWindowTab(kindKey, requested)) return requested;
  const preferred = String(defaults?.[String(kindKey || "").trim()] ?? "").trim();
  if (isWindowTab(kindKey, preferred)) return preferred;
  return appDefaultWindowTab(kindKey);
}

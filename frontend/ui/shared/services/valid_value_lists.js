const PROJECT_SOURCE_DEFAULT = "project_map";

const projectListCache = {
  loaded: false,
  items: [],
};
const datasetListCache = new Map();
const reservingClassListCache = new Map();
const reservingClassListInFlight = new Map();
const reservingClassTypeNameLookupCache = new Map();

function toText(value) {
  return String(value || "").trim();
}

export function normalizeValidValueKey(value) {
  return toText(value).replace(/\s+/g, " ").toLowerCase();
}

// Reserving-class names can contain "/" literally, so only "\" is treated as a path delimiter.
function splitBackslashDelimitedPath(value) {
  return String(value || "")
    .split("\\")
    .map((part) => toText(part))
    .filter(Boolean);
}

export function normalizeReservingClassPath(value) {
  return splitBackslashDelimitedPath(value).join("\\");
}

export function normalizeReservingClassPathKey(value) {
  return normalizeReservingClassPath(value).toLowerCase();
}

export function splitReservingClassPath(value) {
  return splitBackslashDelimitedPath(value);
}

export function buildReservingClassPathPartLookup(values) {
  const lookup = new Map();
  for (const raw of Array.isArray(values) ? values : []) {
    for (const part of splitReservingClassPath(raw)) {
      const key = normalizeValidValueKey(part);
      if (!key || lookup.has(key)) continue;
      lookup.set(key, part);
    }
  }
  return lookup;
}

export function normalizeReservingClassPathByPartLookup(value, partLookup) {
  const parts = splitReservingClassPath(value);
  if (!parts.length) return "";
  if (!(partLookup instanceof Map) || !partLookup.size) return "";

  const normalizedParts = [];
  for (const part of parts) {
    const key = normalizeValidValueKey(part);
    const canonicalPart = partLookup.get(key);
    if (!canonicalPart) return "";
    normalizedParts.push(canonicalPart);
  }
  return normalizedParts.join("\\");
}

function dedupeAndSortValues(values, keyFn) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const value = toText(raw);
    if (!value) continue;
    const key = keyFn(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  out.sort((a, b) =>
    String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base", numeric: true }),
  );
  return out;
}

async function readJson(url, errorPrefix) {
  const resp = await fetch(url);
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    const msg = detail || `${errorPrefix} (${resp.status}).`;
    const err = new Error(msg);
    err.status = resp.status;
    throw err;
  }
  return await resp.json().catch(() => ({}));
}

function extractDatasetNames(payload) {
  const rows = Array.isArray(payload?.data?.rows) ? payload.data.rows : [];
  const out = [];
  for (const row of rows) {
    if (Array.isArray(row)) {
      out.push(row[0]);
      continue;
    }
    if (row && typeof row === "object") {
      out.push(row.Name ?? row.name ?? "");
    }
  }
  return dedupeAndSortValues(out, normalizeValidValueKey);
}

function extractReservingPathsFromPathTree(payload) {
  const paths = Array.isArray(payload?.data?.paths) ? payload.data.paths : [];
  return dedupeAndSortValues(paths, normalizeReservingClassPathKey).map(normalizeReservingClassPath);
}

function extractReservingPathsFromCombinations(payload) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
  const rawPaths = [];
  if (Array.isArray(data.paths)) rawPaths.push(...data.paths);
  if (Array.isArray(data.combinations)) rawPaths.push(...data.combinations);
  return dedupeAndSortValues(rawPaths, normalizeReservingClassPathKey).map(normalizeReservingClassPath);
}

function extractReservingClassTypeNames(payload) {
  const rows = Array.isArray(payload?.data?.rows) ? payload.data.rows : [];
  const out = [];
  for (const row of rows) {
    if (Array.isArray(row)) {
      out.push(row[0]);
      continue;
    }
    if (row && typeof row === "object") {
      out.push(row.Name ?? row.name ?? "");
    }
  }
  return dedupeAndSortValues(out, normalizeValidValueKey);
}

async function loadReservingClassTypeNameLookup(projectName, options = {}) {
  const project = toText(projectName);
  if (!project) return new Map();

  const cacheKey = normalizeValidValueKey(project);
  const forceReload = !!options?.forceReload;
  if (!forceReload && reservingClassTypeNameLookupCache.has(cacheKey)) {
    const cached = reservingClassTypeNameLookupCache.get(cacheKey);
    if (cached instanceof Map) return cached;
  }

  let names = [];
  try {
    const payload = await readJson(
      `/reserving_class_types?project_name=${encodeURIComponent(project)}`,
      "Failed to load reserving class types",
    );
    names = extractReservingClassTypeNames(payload);
  } catch {
    names = [];
  }

  const lookup = new Map();
  for (const name of names) {
    const key = normalizeValidValueKey(name);
    if (!key || lookup.has(key)) continue;
    lookup.set(key, String(name || "").trim());
  }
  reservingClassTypeNameLookupCache.set(cacheKey, lookup);
  return lookup;
}

async function collectReservingPathsFromChildren(projectName) {
  const queue = [""];
  const seenPrefixKeys = new Set([""]);
  const seenPathKeys = new Set();
  const out = [];

  while (queue.length) {
    const prefix = queue.shift() || "";
    const params = new URLSearchParams({ project_name: projectName });
    if (prefix) params.set("prefix", prefix);

    const payload = await readJson(
      `/reserving_class_path_tree/children?${params.toString()}`,
      "Failed to load reserving class path tree",
    );
    const children = Array.isArray(payload?.children) ? payload.children : [];

    for (const child of children) {
      const path = normalizeReservingClassPath(child?.path || "");
      if (!path) continue;
      const key = normalizeReservingClassPathKey(path);
      if (!seenPathKeys.has(key)) {
        seenPathKeys.add(key);
        out.push(path);
      }
      if (!child?.has_children) continue;
      if (seenPrefixKeys.has(key)) continue;
      seenPrefixKeys.add(key);
      queue.push(path);
    }
  }

  out.sort((a, b) =>
    String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base", numeric: true }),
  );
  return out;
}

export async function loadProjectValidValueList(options = {}) {
  const forceReload = !!options?.forceReload;
  if (!forceReload && projectListCache.loaded) return projectListCache.items.slice();

  const source = toText(options?.source) || PROJECT_SOURCE_DEFAULT;
  void source; // Reserved for future source-specific expansion.

  const payload = await readJson("/arcrho/projects", "Failed to load projects");
  const items = dedupeAndSortValues(payload?.projects || [], normalizeValidValueKey);

  projectListCache.loaded = true;
  projectListCache.items = items;
  return items.slice();
}

export async function loadDatasetValidValueList(projectName, options = {}) {
  const project = toText(projectName);
  if (!project) return [];

  const cacheKey = normalizeValidValueKey(project);
  const forceReload = !!options?.forceReload;
  if (!forceReload && datasetListCache.has(cacheKey)) {
    return (datasetListCache.get(cacheKey) || []).slice();
  }

  const payload = await readJson(
    `/dataset_types?project_name=${encodeURIComponent(project)}`,
    "Failed to load dataset types",
  );
  const items = extractDatasetNames(payload);
  datasetListCache.set(cacheKey, items);
  return items.slice();
}

export async function loadReservingClassValidValueList(projectName, options = {}) {
  const project = toText(projectName);
  if (!project) return [];

  const cacheKey = normalizeValidValueKey(project);
  const forceReload = !!options?.forceReload;
  const hydrateFromChildren = !!options?.hydrateFromChildren;
  if (!forceReload && reservingClassListCache.has(cacheKey)) {
    const cachedItems = reservingClassListCache.get(cacheKey) || [];
    if (Array.isArray(cachedItems) && cachedItems.length) {
      return cachedItems.slice();
    }
  }

  if (reservingClassListInFlight.has(cacheKey)) {
    const inFlightItems = await reservingClassListInFlight.get(cacheKey);
    return Array.isArray(inFlightItems) ? inFlightItems.slice() : [];
  }

  const loadPromise = (async () => {
    let items = [];
    let shouldHydrateFromChildren = false;
    try {
      const payload = await readJson(
        `/reserving_class_path_tree?project_name=${encodeURIComponent(project)}`,
        "Failed to load reserving class paths",
      );
      items = extractReservingPathsFromPathTree(payload);
      shouldHydrateFromChildren = payload?.exists === false || !items.length;
    } catch {
      items = [];
      shouldHydrateFromChildren = true;
    }

    if (!items.length) {
      try {
        const payload = await readJson(
          `/reserving_class_combinations?project_name=${encodeURIComponent(project)}`,
          "Failed to load reserving class combinations",
        );
        items = extractReservingPathsFromCombinations(payload);
      } catch {
        items = [];
      }
    }

    if (hydrateFromChildren && (shouldHydrateFromChildren || !items.length)) {
      try {
        const hydratedPaths = await collectReservingPathsFromChildren(project);
        if (hydratedPaths.length) {
          items = dedupeAndSortValues(
            [...items, ...hydratedPaths],
            normalizeReservingClassPathKey,
          ).map(normalizeReservingClassPath);
        }
      } catch {
        // Keep previously resolved paths (path-tree/combinations) as fallback.
      }
    }

    items = dedupeAndSortValues(items, normalizeReservingClassPathKey).map(normalizeReservingClassPath);
    reservingClassListCache.set(cacheKey, items);
    return items;
  })();

  reservingClassListInFlight.set(cacheKey, loadPromise);
  try {
    const items = await loadPromise;
    return Array.isArray(items) ? items.slice() : [];
  } finally {
    if (reservingClassListInFlight.get(cacheKey) === loadPromise) {
      reservingClassListInFlight.delete(cacheKey);
    }
  }
}

export async function validateReservingClassPathByTypeNames(projectName, path, options = {}) {
  const project = toText(projectName);
  const normalizedPath = normalizeReservingClassPath(path);
  if (!project || !normalizedPath) {
    return { ok: false, path: "" };
  }

  const inputParts = splitReservingClassPath(normalizedPath);
  if (!inputParts.length) {
    return { ok: false, path: "" };
  }

  const typeNameLookup = await loadReservingClassTypeNameLookup(project, options);
  if (!(typeNameLookup instanceof Map) || !typeNameLookup.size) {
    return { ok: false, path: "" };
  }

  const canonicalParts = [];
  for (const rawPart of inputParts) {
    const key = normalizeValidValueKey(rawPart);
    const canonical = typeNameLookup.get(key);
    if (!canonical) {
      return { ok: false, path: "" };
    }
    canonicalParts.push(canonical);
  }

  const canonicalPath = normalizeReservingClassPath(canonicalParts.join("\\"));
  return canonicalPath
    ? { ok: true, path: canonicalPath }
    : { ok: false, path: "" };
}

export function clearValidValueListCache(options = {}) {
  const project = toText(options?.projectName);
  if (!project) {
    projectListCache.loaded = false;
    projectListCache.items = [];
    datasetListCache.clear();
    reservingClassListCache.clear();
    reservingClassListInFlight.clear();
    reservingClassTypeNameLookupCache.clear();
    return;
  }

  const key = normalizeValidValueKey(project);
  datasetListCache.delete(key);
  reservingClassListCache.delete(key);
  reservingClassListInFlight.delete(key);
  reservingClassTypeNameLookupCache.delete(key);
}

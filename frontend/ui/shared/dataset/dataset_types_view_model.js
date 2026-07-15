import { parseDatasetTypesCalculatedFlag } from "/ui/shared/dataset/dataset_types_source.js";

function toText(value) {
  return String(value || "").trim();
}

function normalizeKey(value) {
  return toText(value).replace(/\s+/g, " ").toLowerCase();
}

function normalizeCategoryLabel(category) {
  return toText(category) || "Uncategorized";
}

function compareText(leftValue, rightValue) {
  return String(leftValue || "").localeCompare(String(rightValue || ""), undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

export function tokenizeDatasetTypeNameSearch(text) {
  return toText(text)
    .split(/\s+/g)
    .map((v) => normalizeKey(v))
    .filter(Boolean);
}

export function matchesDatasetTypeNameSearch(item, tokensOrText) {
  const tokens = Array.isArray(tokensOrText)
    ? tokensOrText.map((v) => normalizeKey(v)).filter(Boolean)
    : tokenizeDatasetTypeNameSearch(tokensOrText);
  if (!tokens.length) return true;
  const hay = normalizeKey(item?.name);
  if (!hay) return false;
  return tokens.every((token) => hay.includes(token));
}

export function filterDatasetTypeItems(items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const allowedFormats = Array.isArray(options?.allowedDataFormats)
    ? options.allowedDataFormats.map((v) => normalizeKey(v)).filter(Boolean)
    : [];
  const allowedFormatSet = allowedFormats.length ? new Set(allowedFormats) : null;
  const includeCalculated = options?.includeCalculated !== false;
  const nameTokens = Array.isArray(options?.nameSearchTokens)
    ? options.nameSearchTokens
    : tokenizeDatasetTypeNameSearch(options?.nameSearchText);
  const customFilter = typeof options?.itemFilter === "function" ? options.itemFilter : null;

  return list.filter((item) => {
    if (allowedFormatSet) {
      const fmt = normalizeKey(item?.dataFormat);
      if (!allowedFormatSet.has(fmt)) return false;
    }
    if (!includeCalculated && !!item?.calculated) return false;
    if (nameTokens.length && !matchesDatasetTypeNameSearch(item, nameTokens)) return false;
    if (customFilter) {
      try {
        return !!customFilter(item);
      } catch {
        return false;
      }
    }
    return true;
  });
}

export function compareDatasetTypeItems(a, b, key = "name") {
  const left = a || {};
  const right = b || {};
  const cmp = compareText(toText(left[key]), toText(right[key]));
  if (cmp !== 0) return cmp;
  return compareText(toText(left.name), toText(right.name));
}

export function sortDatasetTypeItems(items, options = {}) {
  const list = [...(Array.isArray(items) ? items : [])];
  const sortKey = toText(options?.sortKey) || "name";
  const sortDir = String(options?.sortDir || "asc").toLowerCase() === "desc" ? -1 : 1;
  list.sort((a, b) => compareDatasetTypeItems(a, b, sortKey) * sortDir);
  return list;
}

export function groupDatasetTypeItemsByCategory(items) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const category = normalizeCategoryLabel(item?.category);
    if (!map.has(category)) map.set(category, []);
    map.get(category).push(item);
  }
  return map;
}

export function buildDatasetTypeCategoryOptions(items) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const label = normalizeCategoryLabel(item?.category);
    const key = normalizeKey(label);
    if (!key || map.has(key)) continue;
    map.set(key, label);
  }
  const out = Array.from(map.entries()).map(([key, label]) => ({ key, label }));
  out.sort((a, b) => compareText(a?.label, b?.label));
  return out;
}

export function buildDatasetTypeDataFormatOptions(items, options = {}) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = getDatasetTypeDataFormatKey(item?.dataFormat, options);
    const label = getDatasetTypeDataFormatLabel(item?.dataFormat);
    if (!key || map.has(key)) continue;
    map.set(key, { key, label });
  }
  const out = Array.from(map.values());
  out.sort((a, b) => compareText(a?.label, b?.label));
  return out;
}

export function buildDatasetTypeCalculatedOptions(items) {
  let hasFalse = false;
  let hasTrue = false;
  for (const item of Array.isArray(items) ? items : []) {
    if (parseDatasetTypesCalculatedFlag(item?.calculated)) hasTrue = true;
    else hasFalse = true;
  }
  const out = [];
  if (hasFalse) out.push({
    key: getDatasetTypeCalculatedKey(false),
    label: getDatasetTypeCalculatedLabel(false),
  });
  if (hasTrue) out.push({
    key: getDatasetTypeCalculatedKey(true),
    label: getDatasetTypeCalculatedLabel(true),
  });
  return out;
}

export function isDatasetTypeCategoryVisible(category, selectedCategoryKeys) {
  if (!(selectedCategoryKeys instanceof Set)) return true;
  if (selectedCategoryKeys.size === 0) return true;
  const key = normalizeKey(normalizeCategoryLabel(category));
  return selectedCategoryKeys.has(key);
}

export function isDatasetTypeDataFormatVisible(dataFormat, selectedDataFormatKeys, options = {}) {
  if (!(selectedDataFormatKeys instanceof Set)) return true;
  if (selectedDataFormatKeys.size === 0) return true;
  const key = getDatasetTypeDataFormatKey(dataFormat, options);
  return selectedDataFormatKeys.has(key);
}

export function isDatasetTypeCalculatedVisible(calculated, selectedCalculatedKeys) {
  if (!(selectedCalculatedKeys instanceof Set)) return true;
  if (selectedCalculatedKeys.size === 0) return true;
  const key = getDatasetTypeCalculatedKey(calculated);
  return selectedCalculatedKeys.has(key);
}

export function isDatasetTypeCategoryFilterActive(categoryOptions, selectedCategoryKeys) {
  return isDatasetTypeSelectionFilterActive(categoryOptions, selectedCategoryKeys);
}

function normalizeProjectSettingsFilterLabel(value) {
  const raw = toText(value);
  return raw || "(blank)";
}

function normalizeProjectSettingsFilterKey(value, options = {}) {
  const blankKey = toText(options?.blankKey) || "__blank__";
  const raw = toText(value);
  if (!raw) return blankKey;
  return normalizeKey(raw);
}

function normalizeCalculatedFilterKey(value) {
  return parseDatasetTypesCalculatedFlag(value) ? "true" : "false";
}

function normalizeCalculatedFilterLabel(value) {
  return parseDatasetTypesCalculatedFlag(value) ? "Yes" : "No";
}

export function getDatasetTypeDataFormatKey(value, options = {}) {
  return normalizeProjectSettingsFilterKey(value, options);
}

export function getDatasetTypeDataFormatLabel(value) {
  return normalizeProjectSettingsFilterLabel(value);
}

export function getDatasetTypeCategoryKey(value, options = {}) {
  return getDatasetTypeDataFormatKey(value, options);
}

export function getDatasetTypeCategoryLabel(value) {
  return getDatasetTypeDataFormatLabel(value);
}

export function getDatasetTypeCalculatedKey(value) {
  return normalizeCalculatedFilterKey(value);
}

export function getDatasetTypeCalculatedLabel(value) {
  return normalizeCalculatedFilterLabel(value);
}

export function getDatasetTypeColumnFilterValueKeyFromRow(colLabel, row, options = {}) {
  const col = toText(colLabel);
  if (!col) return "";
  if (col === "Category") return getDatasetTypeCategoryKey(row?.[2], options);
  if (col === "Data Format") return getDatasetTypeDataFormatKey(row?.[1], options);
  if (col === "Calculated") return getDatasetTypeCalculatedKey(row?.[3]);
  return "";
}

export function buildDatasetTypeColumnFilterOptionsFromRows(rows, colLabel, options = {}) {
  const col = toText(colLabel);
  const list = Array.isArray(rows) ? rows : [];
  if (!col) return [];

  if (col === "Calculated") {
    let hasFalse = false;
    let hasTrue = false;
    for (const row of list) {
      if (parseDatasetTypesCalculatedFlag(row?.[3])) hasTrue = true;
      else hasFalse = true;
    }
    const out = [];
    if (hasFalse) out.push({ key: getDatasetTypeCalculatedKey(false), label: getDatasetTypeCalculatedLabel(false) });
    if (hasTrue) out.push({ key: getDatasetTypeCalculatedKey(true), label: getDatasetTypeCalculatedLabel(true) });
    return out;
  }

  const byKey = new Map();
  for (const row of list) {
    const sourceValue = col === "Category" ? row?.[2] : row?.[1];
    const key = col === "Category"
      ? getDatasetTypeCategoryKey(sourceValue, options)
      : getDatasetTypeDataFormatKey(sourceValue, options);
    const label = col === "Category"
      ? getDatasetTypeCategoryLabel(sourceValue)
      : getDatasetTypeDataFormatLabel(sourceValue);
    if (!byKey.has(key)) byKey.set(key, { key, label });
  }
  const out = Array.from(byKey.values());
  out.sort((a, b) => compareText(a?.label, b?.label));
  return out;
}

export function isDatasetTypeSelectionFilterActive(options, selectedKeys) {
  const optionList = Array.isArray(options) ? options : [];
  if (!(selectedKeys instanceof Set) || !optionList.length) return false;
  if (selectedKeys.size === 0) return false;
  if (selectedKeys.size !== optionList.length) return true;
  for (const opt of optionList) {
    if (!selectedKeys.has(opt.key)) return true;
  }
  return false;
}

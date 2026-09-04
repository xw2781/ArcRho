import { closeFloatingPathTreePicker, openFloatingPathTreePicker } from "/ui/shared/components/pickers/path_tree_picker.js?v=20260904a";
import { buildWorkflowPathRootNode } from "/ui/shared/integrations/workflow_picker_options.js";

const LOOKUP_MODEL_CACHE = new Map();
const HIDDEN_PATHS_CACHE = new Map();
const FILTER_SPEC_CACHE = new Map();
const FILTER_PREFS_CACHE = new Map();
const TREE_FILTER_PREFERENCE_DEFAULTS = Object.freeze({
  autoExpandSingleChild: true,
  hideSegmentLabels: true,
});
const WINDOW_FRAME_MARGIN_PX = 8;
const COLLAPSE_DEEPEST_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="6" y1="12" x2="18" y2="12"/></svg>';
const FILTER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v5l-4 2v-7L3 5z"/></svg>';
const SETTINGS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/ui/shared/icons/gear.svg?v=20260823b#gear"></use></svg>';

function toText(value) {
  return String(value || "").trim();
}

function makeError(message, status = 0) {
  const err = new Error(String(message || "Request failed."));
  err.status = Number(status || 0);
  return err;
}

function canonName(value) {
  const raw = toText(value).replace(/^['"]+|['"]+$/g, "");
  return raw.replace(/\s+/g, " ").toLowerCase();
}

function splitPath(rawPath, delimiter = "\\") {
  return String(rawPath || "")
    .split(delimiter)
    .map((part) => toText(part))
    .filter(Boolean);
}

async function copyTextToClipboard(rawText, doc = window.document) {
  const text = toText(rawText);
  if (!text) return false;

  try {
    const nav = doc?.defaultView?.navigator || window.navigator;
    if (nav?.clipboard && typeof nav.clipboard.writeText === "function") {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fallback below
  }

  try {
    const ta = doc.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "readonly");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    doc.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = typeof doc.execCommand === "function" ? doc.execCommand("copy") : false;
    if (ta.parentNode) ta.parentNode.removeChild(ta);
    return !!ok;
  } catch {
    return false;
  }
}

function normalizeTreePathKey(rawPath, delimiter = "\\") {
  return splitPath(rawPath, delimiter)
    .map((part) => part.toLowerCase())
    .join(delimiter);
}

function getFilterPrefsCacheKey(projectName) {
  return toText(projectName).toLowerCase();
}

function parsePositiveInt(value) {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

function getViewportSize(doc) {
  const view = doc?.defaultView || window;
  const width = Number(view?.innerWidth || doc?.documentElement?.clientWidth || 0);
  const height = Number(view?.innerHeight || doc?.documentElement?.clientHeight || 0);
  return {
    width: Number.isFinite(width) && width > 0 ? width : 0,
    height: Number.isFinite(height) && height > 0 ? height : 0,
  };
}

function clampWindowPosition(doc, win, leftIn, topIn, margin = WINDOW_FRAME_MARGIN_PX) {
  const safeMargin = Number.isFinite(Number(margin)) ? Math.max(0, Number(margin)) : WINDOW_FRAME_MARGIN_PX;
  const leftRaw = Number(leftIn);
  const topRaw = Number(topIn);
  const left = Number.isFinite(leftRaw) ? leftRaw : safeMargin;
  const top = Number.isFinite(topRaw) ? topRaw : safeMargin;
  const rect = typeof win?.getBoundingClientRect === "function"
    ? win.getBoundingClientRect()
    : null;
  const width = Number(rect?.width);
  const height = Number(rect?.height);
  const safeWidth = Number.isFinite(width) && width > 0 ? width : Number(win?.offsetWidth || 0);
  const safeHeight = Number.isFinite(height) && height > 0 ? height : Number(win?.offsetHeight || 0);
  const viewport = getViewportSize(doc);
  const minLeft = safeMargin;
  const minTop = safeMargin;
  const maxLeft = viewport.width > 0
    ? Math.max(minLeft, viewport.width - safeWidth - safeMargin)
    : minLeft;
  const maxTop = viewport.height > 0
    ? Math.max(minTop, viewport.height - safeHeight - safeMargin)
    : minTop;
  return {
    left: Math.min(Math.max(minLeft, left), maxLeft),
    top: Math.min(Math.max(minTop, top), maxTop),
  };
}

function applyWindowPositionWithinFrame(doc, win, left, top, margin = WINDOW_FRAME_MARGIN_PX) {
  if (!win) return null;
  const pos = clampWindowPosition(doc, win, left, top, margin);
  win.style.left = `${pos.left}px`;
  win.style.top = `${pos.top}px`;
  win.style.transform = "none";
  return pos;
}

function positionWindowBelowAnchor(doc, win, anchorEl, gap = 8, margin = WINDOW_FRAME_MARGIN_PX) {
  if (!doc || !win || !anchorEl || typeof anchorEl.getBoundingClientRect !== "function") return false;
  const anchorRect = anchorEl.getBoundingClientRect();
  const rect = win.getBoundingClientRect();
  const viewport = getViewportSize(doc);
  const leftRaw = Number(anchorRect?.left || 0);
  const topRaw = Number(anchorRect?.bottom || 0) + Number(gap || 0);
  const minLeft = margin;
  const maxLeft = viewport.width > 0
    ? Math.max(minLeft, viewport.width - rect.width - margin)
    : minLeft;
  const left = Math.min(Math.max(minLeft, leftRaw), maxLeft);
  const top = Math.max(margin, topRaw);

  if (viewport.height > 0) {
    const availableBelow = viewport.height - top - margin;
    const constrained = Math.max(120, Math.floor(availableBelow));
    if (Number.isFinite(constrained) && constrained > 0) {
      win.style.maxHeight = `${constrained}px`;
    }
  }

  win.style.left = `${left}px`;
  win.style.top = `${top}px`;
  win.style.transform = "none";
  return true;
}

function normalizeFormulaOperatorSpacing(value) {
  const text = toText(value);
  if (!text) return "";
  return text.replace(/\s*([+\-*/])\s*/g, " $1 ").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractFormulaComponents(formula, knownNames) {
  const text = toText(formula);
  if (!text) return [];

  const seen = new Set();
  const out = [];
  const pushUnique = (raw) => {
    const val = toText(raw);
    if (!val) return;
    const key = canonName(val);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(val);
  };

  const quoted = Array.from(text.matchAll(/"([^"]+)"/g))
    .map((m) => toText(m[1]))
    .filter(Boolean);
  for (const q of quoted) pushUnique(q);

  const names = Array.from(
    new Set((Array.isArray(knownNames) ? knownNames : []).map((n) => toText(n)).filter(Boolean)),
  ).sort((a, b) => b.length - a.length);

  if (names.length) {
    const matches = [];
    for (const name of names) {
      const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`, "gi");
      let m;
      while ((m = re.exec(text)) !== null) {
        matches.push({ start: m.index, end: m.index + m[0].length, name });
      }
    }

    matches.sort((a, b) => (a.start - b.start) || ((b.end - b.start) - (a.end - a.start)));
    const used = [];
    for (const it of matches) {
      const overlap = used.some((u) => it.start < u.end && it.end > u.start);
      if (overlap) continue;
      used.push({ start: it.start, end: it.end });
      pushUnique(it.name);
    }
  }

  // Fallback only if quoted/known-name matching could not resolve anything.
  // This keeps names that include '+' intact (e.g. "BI+BIR51") when knownNames can resolve them.
  if (!out.length) {
    const tokenParts = text
      .replace(/[()]/g, " ")
      .split(/[+\-*/]/)
      .map((p) => toText(p))
      .filter(Boolean);
    for (const token of tokenParts) {
      if (/^\d+(\.\d+)?$/.test(token)) continue;
      pushUnique(token);
    }
  }

  return out;
}

function getOrCreateMap(parentMap, key) {
  if (!parentMap.has(key)) parentMap.set(key, new Map());
  return parentMap.get(key);
}

function getOrCreateSet(parentMap, key) {
  if (!parentMap.has(key)) parentMap.set(key, new Set());
  return parentMap.get(key);
}

function buildReservingClassLookupModel(combosData, reservingTypesData) {
  const fields = Array.isArray(combosData?.fields) ? combosData.fields : [];
  const baseCombos = Array.isArray(combosData?.combinations) ? combosData.combinations : [];

  const levelNumbers = [];
  const levelLabels = [];
  for (let idx = 0; idx < fields.length; idx++) {
    const field = fields[idx] || {};
    const lvl = parsePositiveInt(field.level) ?? (idx + 1);
    levelNumbers.push(lvl);
    levelLabels.push(toText(field.field_name) || `Level ${idx + 1}`);
  }
  if (!levelNumbers.length && baseCombos.length) {
    const sample = splitPath(baseCombos[0], "\\");
    for (let i = 0; i < sample.length; i++) {
      levelNumbers.push(i + 1);
      levelLabels.push(`Level ${i + 1}`);
    }
  }

  const levelCount = levelNumbers.length;
  const levelIndexByNumber = new Map();
  for (let i = 0; i < levelNumbers.length; i++) {
    levelIndexByNumber.set(levelNumbers[i], i);
  }

  const displayByLevel = new Map(); // levelNum -> Map(key -> display)
  const rawDisplayByLevel = new Map(); // levelNum -> Map(key -> raw display)
  const rawValuesByLevel = new Map(); // levelNum -> Set(raw keys)
  const prefixChildren = new Map(); // exact raw prefix -> Set(raw child keys)
  const prefixExists = new Set([""]); // exact raw prefix existence
  const uniqueComboKeys = [];
  const seenComboRows = new Set();

  for (const rawCombo of baseCombos) {
    const partsRaw = splitPath(rawCombo, "\\");
    if (!partsRaw.length || !levelCount || partsRaw.length < levelCount) continue;
    const parts = partsRaw.slice(0, levelCount);

    const keys = [];
    let skip = false;
    for (let i = 0; i < parts.length; i++) {
      const key = canonName(parts[i]);
      if (!key) {
        skip = true;
        break;
      }
      keys.push(key);
      const levelNum = levelNumbers[i] ?? (i + 1);
      const levelMap = getOrCreateMap(displayByLevel, levelNum);
      if (!levelMap.has(key)) levelMap.set(key, parts[i]);
      const rawLevelMap = getOrCreateMap(rawDisplayByLevel, levelNum);
      if (!rawLevelMap.has(key)) rawLevelMap.set(key, parts[i]);
      getOrCreateSet(rawValuesByLevel, levelNum).add(key);
    }
    if (skip) continue;

    const comboKey = keys.join("\\");
    if (!comboKey || seenComboRows.has(comboKey)) continue;
    seenComboRows.add(comboKey);
    uniqueComboKeys.push(keys);

    for (let i = 0; i < keys.length; i++) {
      const prefix = keys.slice(0, i).join("\\");
      getOrCreateSet(prefixChildren, prefix).add(keys[i]);
      prefixExists.add(keys.slice(0, i + 1).join("\\"));
    }
  }

  const rctRows = Array.isArray(reservingTypesData?.rows) ? reservingTypesData.rows : [];
  const namesByLevel = new Map(); // levelNum -> Map(key -> display)
  const rowsByLevel = new Map(); // levelNum -> [{ name, formula }]
  const aggregateKeysByLevel = new Map(); // levelNum -> Set(defined aggregate class keys)

  for (const raw of rctRows) {
    if (!Array.isArray(raw)) continue;
    const name = toText(raw[0]);
    const levelNum = parsePositiveInt(raw[1]);
    const formula = normalizeFormulaOperatorSpacing(raw[2]);
    if (!name || !levelNum) continue;

    const namesMap = getOrCreateMap(namesByLevel, levelNum);
    const nameKey = canonName(name);
    if (nameKey && !namesMap.has(nameKey)) namesMap.set(nameKey, name);
    if (nameKey && formula) getOrCreateSet(aggregateKeysByLevel, levelNum).add(nameKey);

    if (!rowsByLevel.has(levelNum)) rowsByLevel.set(levelNum, []);
    rowsByLevel.get(levelNum).push({ name, formula });
  }

  const compToParentsByLevel = new Map(); // levelNum -> Map(compKey -> Set(parentKey))
  const parentToCompsByLevel = new Map(); // levelNum -> Map(parentKey -> Set(compKey))
  const parentDisplayByLevel = new Map(); // levelNum -> Map(parentKey -> parent display)
  const compDisplayByLevel = new Map(); // levelNum -> Map(compKey -> comp display)

  for (const [levelNum, rows] of rowsByLevel.entries()) {
    const knownNamesSet = new Set();
    for (const val of (namesByLevel.get(levelNum) || new Map()).values()) {
      const txt = toText(val);
      if (txt) knownNamesSet.add(txt);
    }
    for (const val of (rawDisplayByLevel.get(levelNum) || new Map()).values()) {
      const txt = toText(val);
      if (txt) knownNamesSet.add(txt);
    }
    const knownNames = Array.from(knownNamesSet);
    const compParentMap = getOrCreateMap(compToParentsByLevel, levelNum);
    const parentCompMap = getOrCreateMap(parentToCompsByLevel, levelNum);
    const parentDisplayMap = getOrCreateMap(parentDisplayByLevel, levelNum);
    const compDisplayMap = getOrCreateMap(compDisplayByLevel, levelNum);

    for (const row of rows) {
      const parentName = toText(row?.name);
      const formula = normalizeFormulaOperatorSpacing(row?.formula);
      if (!parentName || !formula) continue;

      const parentKey = canonName(parentName);
      if (!parentKey) continue;
      parentDisplayMap.set(parentKey, parentName);

      const comps = extractFormulaComponents(formula, knownNames);
      for (const comp of comps) {
        const compName = toText(comp);
        const compKey = canonName(compName);
        if (!compKey || compKey === parentKey) continue;

        getOrCreateSet(compParentMap, compKey).add(parentKey);
        getOrCreateSet(parentCompMap, parentKey).add(compKey);
        if (!compDisplayMap.has(compKey)) compDisplayMap.set(compKey, compName);
      }
    }
  }

  for (const [levelNum, namesMap] of parentDisplayByLevel.entries()) {
    const levelDisplay = getOrCreateMap(displayByLevel, levelNum);
    for (const [key, val] of namesMap.entries()) {
      levelDisplay.set(key, val); // rule display casing wins for parent names
    }
  }
  for (const [levelNum, namesMap] of compDisplayByLevel.entries()) {
    const levelDisplay = getOrCreateMap(displayByLevel, levelNum);
    for (const [key, val] of namesMap.entries()) {
      if (!levelDisplay.has(key)) levelDisplay.set(key, val);
    }
  }

  const filterSelectableKeysByLevel = new Map(); // levelNum -> Set(keys shown in filter window)
  for (const levelNum of levelNumbers) {
    const selectable = new Set();
    const rawVals = rawValuesByLevel.get(levelNum) || new Set();
    for (const key of rawVals) selectable.add(key);
    const aggNames = namesByLevel.get(levelNum) || new Map();
    for (const key of aggNames.keys()) selectable.add(key);
    filterSelectableKeysByLevel.set(levelNum, selectable);
  }

  const descendantsByLevel = new Map(); // levelNum -> Map(parentKey -> Set(desc keys + self))
  for (const [levelNum, parentCompMap] of parentToCompsByLevel.entries()) {
    const memo = new Map();
    const lookup = new Map();
    const walk = (parentKey, stack = new Set()) => {
      if (memo.has(parentKey)) return new Set(memo.get(parentKey));
      if (stack.has(parentKey)) return new Set([parentKey]);

      const stack2 = new Set(stack);
      stack2.add(parentKey);

      const acc = new Set([parentKey]);
      const comps = parentCompMap.get(parentKey) || new Set();
      for (const compKey of comps) {
        if (!compKey) continue;
        acc.add(compKey);
        if (parentCompMap.has(compKey)) {
          const desc = walk(compKey, stack2);
          for (const d of desc) acc.add(d);
        }
      }

      memo.set(parentKey, new Set(acc));
      return new Set(acc);
    };

    for (const parentKey of parentCompMap.keys()) {
      lookup.set(parentKey, walk(parentKey));
    }
    descendantsByLevel.set(levelNum, lookup);
  }

  const normalizeFilterSpec = (rawSpec) => {
    const out = new Map();
    const addEntry = (rawLevel, rawValues) => {
      const levelNum = parsePositiveInt(rawLevel);
      if (!levelNum || !levelIndexByNumber.has(levelNum)) return;
      const allowed = filterSelectableKeysByLevel.get(levelNum) || new Set();
      if (!allowed.size) return;

      const values = Array.isArray(rawValues) ? rawValues : [rawValues];
      const keys = new Set();
      for (const raw of values) {
        const key = canonName(raw);
        if (!key || !allowed.has(key)) continue;
        keys.add(key);
      }
      if (keys.size) out.set(levelNum, keys);
    };

    if (rawSpec instanceof Map) {
      for (const [level, values] of rawSpec.entries()) addEntry(level, values);
      return out;
    }
    if (Array.isArray(rawSpec)) {
      for (const item of rawSpec) {
        if (!item) continue;
        if (Array.isArray(item) && item.length >= 2) {
          addEntry(item[0], item[1]);
          continue;
        }
        if (typeof item === "object") {
          addEntry(
            item.levelNum ?? item.level_number ?? item.level ?? item.index,
            item.values ?? item.selected ?? item.selected_keys ?? item.keys,
          );
        }
      }
      return out;
    }
    if (rawSpec && typeof rawSpec === "object") {
      for (const [level, values] of Object.entries(rawSpec)) addEntry(level, values);
    }
    return out;
  };

  const filterRawExpansionMemoByLevel = new Map(); // levelNum -> Map(key -> Set(raw keys))
  const expandFilterKeyToRaw = (levelNum, key, stack = new Set()) => {
    const memoByLevel = getOrCreateMap(filterRawExpansionMemoByLevel, levelNum);
    if (memoByLevel.has(key)) return new Set(memoByLevel.get(key));
    if (stack.has(key)) return new Set();

    const rawValues = rawValuesByLevel.get(levelNum) || new Set();
    const out = new Set();
    if (rawValues.has(key)) out.add(key);
    const parentToComps = parentToCompsByLevel.get(levelNum) || new Map();
    const comps = parentToComps.get(key) || new Set();
    if (!comps.size) {
      memoByLevel.set(key, new Set(out));
      return out;
    }

    const stack2 = new Set(stack);
    stack2.add(key);

    for (const compKey of comps) {
      if (!compKey) continue;
      if (rawValues.has(compKey)) {
        out.add(compKey);
        continue;
      }
      const deeper = expandFilterKeyToRaw(levelNum, compKey, stack2);
      for (const v of deeper) out.add(v);
    }

    memoByLevel.set(key, new Set(out));
    return out;
  };

  const toEffectiveRawFilters = (selectedByLevel) => {
    const out = new Map();
    for (const [levelNum, selectedKeys] of selectedByLevel.entries()) {
      const rawAllowed = new Set();
      for (const key of selectedKeys || []) {
        if (!key) continue;
        const expanded = expandFilterKeyToRaw(levelNum, key);
        for (const raw of expanded) rawAllowed.add(raw);
      }
      out.set(levelNum, rawAllowed);
    }
    return out;
  };

  const buildFilteredPrefixLookups = (filtersByLevel) => {
    const children = new Map();
    const exists = new Set([""]);
    let matchedRows = 0;
    const effectiveRawFilters = toEffectiveRawFilters(filtersByLevel);

    for (const keys of uniqueComboKeys) {
      let pass = true;
      for (const [levelNum, allowedRaw] of effectiveRawFilters.entries()) {
        const idx = levelIndexByNumber.get(levelNum);
        if (!Number.isInteger(idx)) continue;
        const key = keys[idx];
        if (!allowedRaw.has(key)) {
          pass = false;
          break;
        }
      }
      if (!pass) continue;

      matchedRows += 1;
      for (let i = 0; i < keys.length; i++) {
        const prefix = keys.slice(0, i).join("\\");
        getOrCreateSet(children, prefix).add(keys[i]);
        exists.add(keys.slice(0, i + 1).join("\\"));
      }
    }

    return { children, exists, matchedRows };
  };

  let activePrefixChildren = prefixChildren;
  let activePrefixExists = prefixExists;
  let activeFiltersByLevel = new Map();
  let activeMatchedRows = uniqueComboKeys.length;
  let favoritePaths = [];
  let favoriteNicknames = {};
  let favoriteFolders = [];
  let favoritePathKeys = new Set();
  let favoriteAncestorPathKeys = new Set();

  const toPathKeyParts = (rawPath) => {
    const parts = splitPath(rawPath, "\\");
    if (!parts.length) return [];
    const out = [];
    for (const part of parts) {
      const key = canonName(part);
      if (!key) return [];
      out.push(key);
    }
    return out;
  };
  const toPathKey = (rawPath) => toPathKeyParts(rawPath).join("\\");
  const normalizeFavoritePathList = (rawPaths) => {
    const values = Array.isArray(rawPaths) ? rawPaths : [];
    const out = [];
    const seen = new Set();
    for (const raw of values) {
      const parts = splitPath(raw, "\\");
      if (!parts.length) continue;
      const keyParts = toPathKeyParts(parts.join("\\"));
      if (!keyParts.length) continue;
      const key = keyParts.join("\\");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(parts.join("\\"));
    }
    out.sort((a, b) => {
      const depthDiff = splitPath(a, "\\").length - splitPath(b, "\\").length;
      if (depthDiff !== 0) return depthDiff;
      return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
    });
    return out;
  };
  const rebuildFavoritePathSets = () => {
    favoritePathKeys = new Set();
    favoriteAncestorPathKeys = new Set();
    for (const path of favoritePaths) {
      const keyParts = toPathKeyParts(path);
      if (!keyParts.length) continue;
      const fullKey = keyParts.join("\\");
      favoritePathKeys.add(fullKey);
      for (let i = 1; i < keyParts.length; i++) {
        favoriteAncestorPathKeys.add(keyParts.slice(0, i).join("\\"));
      }
    }
  };
  const setFavoritePaths = (rawPaths) => {
    favoritePaths = normalizeFavoritePathList(rawPaths);
    const pathSet = new Set(favoritePaths.map((path) => toPathKey(path)).filter(Boolean));
    const nextNicknames = {};
    for (const path of favoritePaths) {
      const key = toPathKey(path);
      const nickname = toText(favoriteNicknames[key] ?? favoriteNicknames[path]).trim();
      if (key && pathSet.has(key) && nickname) nextNicknames[key] = nickname;
    }
    favoriteNicknames = nextNicknames;
    favoriteFolders = favoriteFolders.map((folder) => ({
      ...folder,
      paths: (Array.isArray(folder.paths) ? folder.paths : []).filter((path) => pathSet.has(toPathKey(path))),
    }));
    rebuildFavoritePathSets();
    return Array.from(favoritePaths);
  };
  const getFavoritePaths = () => Array.from(favoritePaths);
  const getFavoriteNickname = (rawPath) => {
    const key = toPathKey(rawPath);
    return key ? toText(favoriteNicknames[key]).trim() : "";
  };
  const setFavoriteNicknames = (rawNicknames) => {
    const source = (rawNicknames && typeof rawNicknames === "object") ? rawNicknames : {};
    const out = {};
    for (const path of favoritePaths) {
      const key = toPathKey(path);
      if (!key) continue;
      const nickname = toText(source[key] ?? source[path]).trim();
      if (nickname) out[key] = nickname.slice(0, 120);
    }
    favoriteNicknames = out;
    return { ...favoriteNicknames };
  };
  const getFavoriteNicknames = () => ({ ...favoriteNicknames });
  const setFavoriteNickname = (rawPath, rawNickname) => {
    const key = toPathKey(rawPath);
    if (!key || !favoritePathKeys.has(key)) return getFavoriteNicknames();
    const nickname = toText(rawNickname).trim();
    if (nickname) favoriteNicknames[key] = nickname.slice(0, 120);
    else delete favoriteNicknames[key];
    return getFavoriteNicknames();
  };
  const normalizeFavoriteFolderList = (rawFolders) => {
    const values = Array.isArray(rawFolders) ? rawFolders : [];
    const pathByKey = new Map();
    for (const path of favoritePaths) {
      const key = toPathKey(path);
      if (key) pathByKey.set(key, path);
    }
    const out = [];
    const seenIds = new Set();
    const assigned = new Set();
    for (const raw of values) {
      if (!raw || typeof raw !== "object") continue;
      const name = toText(raw.name ?? raw.label).slice(0, 120);
      if (!name) continue;
      let id = toText(raw.id ?? raw.key).slice(0, 80);
      if (!id || seenIds.has(id)) id = `folder-${out.length + 1}`;
      seenIds.add(id);
      const paths = [];
      for (const rawPath of Array.isArray(raw.paths) ? raw.paths : []) {
        const key = toPathKey(rawPath);
        const path = pathByKey.get(key);
        if (!path || assigned.has(key)) continue;
        assigned.add(key);
        paths.push(path);
      }
      out.push({ id, name, paths });
    }
    return out;
  };
  const setFavoriteFolders = (rawFolders) => {
    favoriteFolders = normalizeFavoriteFolderList(rawFolders);
    return favoriteFolders.map((folder) => ({ ...folder, paths: Array.from(folder.paths) }));
  };
  const getFavoriteFolders = () => favoriteFolders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    paths: Array.from(folder.paths || []),
  }));
  const createFavoriteFolder = (rawName) => {
    const name = toText(rawName).slice(0, 120);
    if (!name) return getFavoriteFolders();
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "folder";
    const ids = new Set(favoriteFolders.map((folder) => folder.id));
    let id = `${base}-${Date.now().toString(36)}`;
    let n = 2;
    while (ids.has(id)) id = `${base}-${n++}`;
    favoriteFolders.push({ id, name, paths: [] });
    return getFavoriteFolders();
  };
  const renameFavoriteFolder = (folderId, rawName) => {
    const id = toText(folderId);
    const name = toText(rawName).slice(0, 120);
    if (!id || !name) return getFavoriteFolders();
    favoriteFolders = favoriteFolders.map((folder) => (
      folder.id === id ? { ...folder, name } : folder
    ));
    return getFavoriteFolders();
  };
  const deleteFavoriteFolder = (folderId) => {
    const id = toText(folderId);
    favoriteFolders = favoriteFolders.filter((folder) => folder.id !== id);
    return getFavoriteFolders();
  };
  const reorderFavoriteFolder = (folderId, targetFolderId, position = "before") => {
    const id = toText(folderId);
    const targetId = toText(targetFolderId);
    if (!id || id === targetId) return getFavoriteFolders();
    const fromIndex = favoriteFolders.findIndex((folder) => folder.id === id);
    if (fromIndex < 0) return getFavoriteFolders();
    const next = favoriteFolders.slice();
    const [moved] = next.splice(fromIndex, 1);
    const targetIndex = targetId ? next.findIndex((folder) => folder.id === targetId) : -1;
    const insertAt = targetIndex < 0
      ? next.length
      : (position === "after" ? targetIndex + 1 : targetIndex);
    next.splice(insertAt, 0, moved);
    favoriteFolders = next;
    return getFavoriteFolders();
  };
  const moveFavoriteToFolder = (rawPath, folderId = null) => {
    const key = toPathKey(rawPath);
    if (!key || !favoritePathKeys.has(key)) return getFavoriteFolders();
    const targetId = toText(folderId);
    const canonicalPath = favoritePaths.find((path) => toPathKey(path) === key) || splitPath(rawPath, "\\").join("\\");
    favoriteFolders = favoriteFolders.map((folder) => {
      const paths = (Array.isArray(folder.paths) ? folder.paths : []).filter((path) => toPathKey(path) !== key);
      if (targetId && folder.id === targetId) paths.push(canonicalPath);
      return { ...folder, paths };
    });
    return getFavoriteFolders();
  };
  const isFavoritePath = (rawPath) => {
    const key = toPathKey(rawPath);
    return !!key && favoritePathKeys.has(key);
  };
  const isFavoriteAncestor = (rawPath) => {
    const key = toPathKey(rawPath);
    if (!key || favoritePathKeys.has(key)) return false;
    return favoriteAncestorPathKeys.has(key);
  };
  const toggleFavoritePath = (rawPath) => {
    const normPath = splitPath(rawPath, "\\").join("\\");
    const pathKey = toPathKey(normPath);
    if (!normPath || !pathKey) return { favorite: false, paths: getFavoritePaths() };
    if (favoritePathKeys.has(pathKey)) {
      setFavoritePaths(getFavoritePaths().filter((path) => toPathKey(path) !== pathKey));
      delete favoriteNicknames[pathKey];
      moveFavoriteToFolder(normPath, null);
      return { favorite: false, paths: getFavoritePaths() };
    }
    const next = getFavoritePaths();
    next.push(normPath);
    setFavoritePaths(next);
    return { favorite: true, paths: getFavoritePaths() };
  };

  const applyFilters = (rawSpec) => {
    const nextFilters = normalizeFilterSpec(rawSpec);
    activeFiltersByLevel = nextFilters;

    if (!nextFilters.size) {
      activePrefixChildren = prefixChildren;
      activePrefixExists = prefixExists;
      activeMatchedRows = uniqueComboKeys.length;
      return { filter_count: 0, matched_rows: activeMatchedRows };
    }

    const filtered = buildFilteredPrefixLookups(nextFilters);
    activePrefixChildren = filtered.children;
    activePrefixExists = filtered.exists;
    activeMatchedRows = filtered.matchedRows;
    return { filter_count: nextFilters.size, matched_rows: activeMatchedRows };
  };

  const getFilterFields = () => {
    const out = [];
    for (let idx = 0; idx < levelCount; idx++) {
      const levelNum = levelNumbers[idx] ?? (idx + 1);
      const label = levelLabels[idx] || `Level ${idx + 1}`;
      const keys = Array.from(filterSelectableKeysByLevel.get(levelNum) || new Set());
      const displayMap = displayByLevel.get(levelNum) || rawDisplayByLevel.get(levelNum) || new Map();
      keys.sort((a, b) => {
        const da = toText(displayMap.get(a) || a);
        const db = toText(displayMap.get(b) || b);
        return da.localeCompare(db, undefined, { sensitivity: "base", numeric: true });
      });

      const selectedKeys = Array.from(activeFiltersByLevel.get(levelNum) || new Set());
      const aggregateKeys = aggregateKeysByLevel.get(levelNum) || new Set();
      const values = keys.map((key) => ({
        key,
        name: toText(displayMap.get(key) || key),
        is_aggregate: aggregateKeys.has(key),
      }));
      out.push({
        level_index: idx + 1,
        level_number: levelNum,
        field_name: label,
        values,
        selected_keys: selectedKeys,
      });
    }
    return out;
  };

  const getChildrenForPrefix = (prefixPath = "") => {
    const prefixParts = splitPath(prefixPath, "\\");
    const prefixKeys = [];
    for (const part of prefixParts) {
      const key = canonName(part);
      if (!key) return [];
      prefixKeys.push(key);
    }

    const childLevelIndex = prefixKeys.length + 1;
    if (!levelCount || childLevelIndex > levelCount) return [];

    const childLevelNum = levelNumbers[childLevelIndex - 1] ?? childLevelIndex;
    const childLevelLabel = levelLabels[childLevelIndex - 1] || `Level ${childLevelIndex}`;
    const hasChildren = childLevelIndex < levelCount;
    const hasFormulaAtLevelKey = (levelNum, key) => {
      if (!levelNum || !key) return false;
      return (aggregateKeysByLevel.get(levelNum)?.has(key)) || false;
    };
    let ancestorCalculated = false;
    for (let i = 0; i < prefixKeys.length; i++) {
      const lvl = levelNumbers[i] ?? (i + 1);
      if (hasFormulaAtLevelKey(lvl, prefixKeys[i])) {
        ancestorCalculated = true;
        break;
      }
    }
    let exactPrefixes = new Set([""]);
    for (let idx = 0; idx < prefixKeys.length; idx++) {
      const levelNum = levelNumbers[idx] ?? (idx + 1);
      const key = prefixKeys[idx];
      const descendantsLookup = descendantsByLevel.get(levelNum);
      const allowed = descendantsLookup?.get(key) || new Set([key]);

      const nextPrefixes = new Set();
      for (const exactPrefix of exactPrefixes) {
        for (const allowedKey of allowed) {
          if (!allowedKey) continue;
          const nextKey = exactPrefix ? `${exactPrefix}\\${allowedKey}` : allowedKey;
          if (activePrefixExists.has(nextKey)) nextPrefixes.add(nextKey);
        }
      }
      exactPrefixes = nextPrefixes;
      if (!exactPrefixes.size) break;
    }

    const childRawKeys = new Set();
    for (const exactPrefix of exactPrefixes) {
      const set = activePrefixChildren.get(exactPrefix);
      if (!set) continue;
      for (const k of set) childRawKeys.add(k);
    }

    const compToParents = compToParentsByLevel.get(childLevelNum) || new Map();
    const expandedChildKeys = new Set(childRawKeys);
    const queue = Array.from(childRawKeys);
    let qIdx = 0;
    while (qIdx < queue.length) {
      const current = queue[qIdx++];
      const parents = compToParents.get(current) || new Set();
      for (const parentKey of parents) {
        if (!parentKey || expandedChildKeys.has(parentKey)) continue;
        expandedChildKeys.add(parentKey);
        queue.push(parentKey);
      }
    }

    // If this level has filter selections, show only explicitly selected keys.
    // Matching rows still expand aggregate selections to raw components for path
    // existence, but unselected imported values should not appear at this level.
    const selectedAtLevel = activeFiltersByLevel.get(childLevelNum) || new Set();
    if (selectedAtLevel.size) {
      const visibleAtLevel = new Set();

      for (const selectedKey of selectedAtLevel) {
        if (!selectedKey) continue;
        visibleAtLevel.add(selectedKey);
      }

      for (const key of Array.from(expandedChildKeys)) {
        if (!visibleAtLevel.has(key)) {
          expandedChildKeys.delete(key);
        }
      }
    }

    const prefixDisplay = prefixKeys.map((key, idx) => {
      const levelNum = levelNumbers[idx] ?? (idx + 1);
      const levelMap = displayByLevel.get(levelNum) || new Map();
      return toText(levelMap.get(key) || prefixParts[idx] || key);
    });

    const childDisplayMap = displayByLevel.get(childLevelNum) || new Map();
    const childAggCompMap = parentToCompsByLevel.get(childLevelNum) || new Map();
    const childKeys = Array.from(expandedChildKeys);
    const childMeta = childKeys.map((childKey) => {
      const name = toText(childDisplayMap.get(childKey) || childKey);
      const hasFormula = (aggregateKeysByLevel.get(childLevelNum)?.has(childKey))
        || ((childAggCompMap.get(childKey)?.size || 0) > 0);
      const pathKey = prefixKeys.concat([childKey]).join("\\");
      return {
        key: childKey,
        name,
        hasFormula,
        pathKey,
        favoriteRank: favoritePathKeys.has(pathKey) ? 0 : 1,
        // imported first, calculated second
        typeRank: hasFormula ? 1 : 0,
      };
    });
    childMeta.sort((a, b) => {
      if (a.favoriteRank !== b.favoriteRank) return a.favoriteRank - b.favoriteRank;
      if (a.typeRank !== b.typeRank) return a.typeRank - b.typeRank;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
    });

    return childMeta.map((item) => {
      const pathParts = prefixDisplay.concat([item.name]);
      const valueType = item.hasFormula
        ? "calculated"
        : (ancestorCalculated ? "calculated-muted" : "imported");
      return {
        name: item.name,
        path: pathParts.join("\\"),
        level_index: childLevelIndex,
        level_label: childLevelLabel,
        has_children: hasChildren,
        value_type: valueType,
      };
    });
  };
  const getPathNode = (rawPath = "") => {
    const parts = splitPath(rawPath, "\\");
    if (!parts.length) return null;
    let parentPath = "";
    let current = null;
    for (let idx = 0; idx < parts.length; idx++) {
      const expectedPath = parts.slice(0, idx + 1).join("\\");
      const expectedKey = toPathKey(expectedPath);
      const expectedNameKey = canonName(parts[idx]);
      const children = getChildrenForPrefix(parentPath);
      current = children.find((child) => {
        const childPathKey = toPathKey(child?.path || "");
        if (expectedKey && childPathKey === expectedKey) return true;
        return canonName(child?.name || "") === expectedNameKey;
      }) || null;
      if (!current) return null;
      parentPath = current.path || expectedPath;
    }
    return current;
  };

  return {
    levelLabels,
    getRootNodes: () => getChildrenForPrefix(""),
    getChildrenForPrefix,
    getPathNode,
    setFavoritePaths,
    getFavoritePaths,
    setFavoriteNicknames,
    getFavoriteNicknames,
    getFavoriteNickname,
    setFavoriteNickname,
    setFavoriteFolders,
    getFavoriteFolders,
    createFavoriteFolder,
    renameFavoriteFolder,
    deleteFavoriteFolder,
    reorderFavoriteFolder,
    moveFavoriteToFolder,
    isFavoritePath,
    isFavoriteAncestor,
    toggleFavoritePath,
    getFilterFields,
    hasActiveFilters: () => activeFiltersByLevel.size > 0,
    applyFilters,
    clearFilters: () => applyFilters({}),
    getActiveFilterSpec: () => {
      const out = {};
      for (const [levelNum, keys] of activeFiltersByLevel.entries()) {
        out[String(levelNum)] = Array.from(keys);
      }
      return out;
    },
    getActiveMatchCount: () => activeMatchedRows,
  };
}

async function fetchReservingClassCombinations(projectName) {
  const res = await fetch(`/reserving_class_combinations?project_name=${encodeURIComponent(projectName)}`);
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = toText(body?.detail);
    } catch {
      detail = "";
    }
    throw makeError(detail || `HTTP ${res.status}`, res.status);
  }
  const out = await res.json();
  if (!out?.ok) {
    throw makeError("Invalid reserving class combinations response.", res.status || 0);
  }
  return out?.data || {};
}

async function fetchReservingClassTypes(projectName) {
  const res = await fetch(`/reserving_class_types?project_name=${encodeURIComponent(projectName)}`);
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = toText(body?.detail);
    } catch {
      detail = "";
    }
    throw makeError(detail || `HTTP ${res.status}`, res.status);
  }

  const out = await res.json();
  if (!out?.ok) {
    throw makeError("Invalid reserving class types response.", res.status || 0);
  }
  return out?.data || { rows: [] };
}

async function fetchReservingClassHiddenPaths(projectName) {
  const res = await fetch(`/reserving_class_hidden_paths?project_name=${encodeURIComponent(projectName)}`);
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = toText(body?.detail);
    } catch {
      detail = "";
    }
    throw makeError(detail || `HTTP ${res.status}`, res.status);
  }
  const out = await res.json();
  if (!out?.ok) {
    throw makeError("Invalid reserving class hidden paths response.", res.status || 0);
  }
  const paths = Array.isArray(out?.hidden_paths) ? out.hidden_paths : [];
  const delimiter = "\\";
  const normalized = [];
  const seen = new Set();
  for (const raw of paths) {
    const key = normalizeTreePathKey(raw, delimiter);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(splitPath(raw, delimiter).join(delimiter));
  }
  return normalized;
}

async function saveReservingClassHiddenPaths(projectName, hiddenPaths) {
  const payload = {
    project_name: toText(projectName),
    hidden_paths: Array.isArray(hiddenPaths) ? hiddenPaths : [],
  };
  const res = await fetch("/reserving_class_hidden_paths", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = toText(body?.detail);
    } catch {
      detail = "";
    }
    throw makeError(detail || `HTTP ${res.status}`, res.status);
  }
  const out = await res.json();
  if (!out?.ok) {
    throw makeError("Invalid hidden paths save response.", res.status || 0);
  }
  return Array.isArray(out?.hidden_paths) ? out.hidden_paths : [];
}

function normalizeReservingClassFilterSpec(rawSpec) {
  const out = {};
  if (!rawSpec || typeof rawSpec !== "object") return out;

  for (const [rawLevel, rawValues] of Object.entries(rawSpec)) {
    const levelNum = parsePositiveInt(rawLevel);
    if (!levelNum) continue;

    const values = Array.isArray(rawValues) ? rawValues : [rawValues];
    const seen = new Set();
    const keys = [];
    for (const raw of values) {
      const key = canonName(raw);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
    if (!keys.length) continue;

    keys.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
    out[String(levelNum)] = keys;
  }

  const sorted = {};
  const levels = Object.keys(out).sort((a, b) => Number(a) - Number(b));
  for (const level of levels) {
    sorted[level] = out[level];
  }
  return sorted;
}

function normalizeReservingClassFilterPreferences(rawPrefs) {
  const prefs = (rawPrefs && typeof rawPrefs === "object") ? rawPrefs : {};
  const parseSize = (raw, minValue, maxValue) => {
    const n = Number.parseInt(String(raw ?? "").trim(), 10);
    if (!Number.isFinite(n) || n < minValue) return null;
    return Math.min(maxValue, n);
  };
  const treeWindowWidth = parseSize(
    prefs.tree_window_width ?? prefs.treeWindowWidth ?? prefs.window_width ?? prefs.windowWidth,
    320,
    2400,
  );
  const treeWindowHeight = parseSize(
    prefs.tree_window_height ?? prefs.treeWindowHeight ?? prefs.window_height ?? prefs.windowHeight,
    240,
    1800,
  );
  const filterWindowWidth = parseSize(
    prefs.filter_window_width
      ?? prefs.filterWindowWidth
      ?? prefs.filters_window_width
      ?? prefs.filtersWindowWidth,
    360,
    2400,
  );
  const filterWindowHeight = parseSize(
    prefs.filter_window_height
      ?? prefs.filterWindowHeight
      ?? prefs.filters_window_height
      ?? prefs.filtersWindowHeight,
    260,
    1800,
  );
  const normalizeFavoritePaths = (rawPaths) => {
    const values = Array.isArray(rawPaths) ? rawPaths : [];
    const out = [];
    const seen = new Set();
    for (const raw of values) {
      const path = splitPath(raw, "\\").join("\\");
      const key = normalizeTreePathKey(path, "\\");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(path);
    }
    out.sort((a, b) => {
      const depthDiff = splitPath(a, "\\").length - splitPath(b, "\\").length;
      if (depthDiff !== 0) return depthDiff;
      return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
    });
    return out;
  };
  const normalizeFavoriteNicknames = (rawNicknames, favoritePathList) => {
    const source = (rawNicknames && typeof rawNicknames === "object") ? rawNicknames : {};
    const out = {};
    const knownPaths = Array.isArray(favoritePathList) ? favoritePathList : [];
    for (const path of knownPaths) {
      const normalizedPath = splitPath(path, "\\").join("\\");
      const pathKey = normalizeTreePathKey(normalizedPath, "\\");
      if (!pathKey) continue;
      const rawValue = source[normalizedPath] ?? source[path] ?? source[pathKey];
      const nickname = toText(rawValue).trim();
      if (nickname) out[normalizedPath] = nickname.slice(0, 120);
    }
    return out;
  };
  const normalizeFavoriteFolders = (rawFolders, favoritePathList) => {
    const source = Array.isArray(rawFolders) ? rawFolders : [];
    const pathByKey = new Map();
    for (const path of Array.isArray(favoritePathList) ? favoritePathList : []) {
      const key = normalizeTreePathKey(path, "\\");
      if (key) pathByKey.set(key, path);
    }
    const out = [];
    const seenIds = new Set();
    const assigned = new Set();
    for (const raw of source) {
      if (!raw || typeof raw !== "object") continue;
      const name = toText(raw.name ?? raw.label).slice(0, 120);
      if (!name) continue;
      let id = toText(raw.id ?? raw.key).slice(0, 80);
      if (!id || seenIds.has(id)) id = `folder-${out.length + 1}`;
      seenIds.add(id);
      const paths = [];
      for (const rawPath of Array.isArray(raw.paths) ? raw.paths : []) {
        const key = normalizeTreePathKey(rawPath, "\\");
        const path = pathByKey.get(key);
        if (!path || assigned.has(key)) continue;
        assigned.add(key);
        paths.push(path);
      }
      out.push({ id, name, paths });
    }
    return out;
  };
  const favoritePaths = normalizeFavoritePaths(
    prefs.favorite_paths
      ?? prefs.favoritePaths
      ?? prefs.favorites
      ?? prefs.favorite_nodes
      ?? prefs.favoriteNodes,
  );
  const favoriteNicknames = normalizeFavoriteNicknames(
    prefs.favorite_nicknames
      ?? prefs.favoriteNicknames
      ?? prefs.favorite_labels
      ?? prefs.favoriteLabels,
    favoritePaths,
  );
  const favoriteFolders = normalizeFavoriteFolders(
    prefs.favorite_folders
      ?? prefs.favoriteFolders
      ?? prefs.favorite_groups
      ?? prefs.favoriteGroups,
    favoritePaths,
  );
  return {
    autoExpandSingleChild:
      typeof prefs.auto_expand_single_child === "boolean"
        ? prefs.auto_expand_single_child
        : (typeof prefs.autoExpandSingleChild === "boolean"
          ? prefs.autoExpandSingleChild
          : TREE_FILTER_PREFERENCE_DEFAULTS.autoExpandSingleChild),
    hideSegmentLabels:
      typeof prefs.hide_segment_labels === "boolean"
        ? prefs.hide_segment_labels
        : (typeof prefs.hideSegmentLabels === "boolean"
          ? prefs.hideSegmentLabels
          : TREE_FILTER_PREFERENCE_DEFAULTS.hideSegmentLabels),
    treeWindowWidth,
    treeWindowHeight,
    filterWindowWidth,
    filterWindowHeight,
    favoritePaths,
    favoriteNicknames,
    favoriteFolders,
  };
}

function isDefaultReservingClassFilterPreferences(rawPrefs) {
  const prefs = normalizeReservingClassFilterPreferences(rawPrefs);
  return (
    prefs.autoExpandSingleChild === TREE_FILTER_PREFERENCE_DEFAULTS.autoExpandSingleChild
    && prefs.hideSegmentLabels === TREE_FILTER_PREFERENCE_DEFAULTS.hideSegmentLabels
    && !Number.isFinite(prefs.treeWindowWidth)
    && !Number.isFinite(prefs.treeWindowHeight)
    && !Number.isFinite(prefs.filterWindowWidth)
    && !Number.isFinite(prefs.filterWindowHeight)
    && (!Array.isArray(prefs.favoritePaths) || prefs.favoritePaths.length === 0)
    && (!prefs.favoriteNicknames || !Object.keys(prefs.favoriteNicknames).length)
    && (!Array.isArray(prefs.favoriteFolders) || prefs.favoriteFolders.length === 0)
  );
}

async function fetchReservingClassFilterSpec(projectName) {
  const res = await fetch(`/reserving_class_filter_spec?project_name=${encodeURIComponent(projectName)}`);
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = toText(body?.detail);
    } catch {
      detail = "";
    }
    throw makeError(detail || `HTTP ${res.status}`, res.status);
  }
  const out = await res.json();
  if (!out?.ok) {
    throw makeError("Invalid reserving class filter spec response.", res.status || 0);
  }
  return {
    filterSpec: normalizeReservingClassFilterSpec(out?.filter_spec || {}),
    preferences: normalizeReservingClassFilterPreferences(out?.preferences || {}),
  };
}

async function saveReservingClassFilterSpec(projectName, filterSpec, preferences = null) {
  const normalizedPreferences = normalizeReservingClassFilterPreferences(preferences || {});
  const outPrefs = {
    auto_expand_single_child: !!normalizedPreferences.autoExpandSingleChild,
    hide_segment_labels: !!normalizedPreferences.hideSegmentLabels,
  };
  if (Number.isFinite(normalizedPreferences.treeWindowWidth)) {
    outPrefs.tree_window_width = normalizedPreferences.treeWindowWidth;
  }
  if (Number.isFinite(normalizedPreferences.treeWindowHeight)) {
    outPrefs.tree_window_height = normalizedPreferences.treeWindowHeight;
  }
  if (Number.isFinite(normalizedPreferences.filterWindowWidth)) {
    outPrefs.filter_window_width = normalizedPreferences.filterWindowWidth;
  }
  if (Number.isFinite(normalizedPreferences.filterWindowHeight)) {
    outPrefs.filter_window_height = normalizedPreferences.filterWindowHeight;
  }
  if (Array.isArray(normalizedPreferences.favoritePaths) && normalizedPreferences.favoritePaths.length) {
    outPrefs.favorite_paths = normalizedPreferences.favoritePaths;
  }
  if (normalizedPreferences.favoriteNicknames && Object.keys(normalizedPreferences.favoriteNicknames).length) {
    outPrefs.favorite_nicknames = normalizedPreferences.favoriteNicknames;
  }
  if (Array.isArray(normalizedPreferences.favoriteFolders) && normalizedPreferences.favoriteFolders.length) {
    outPrefs.favorite_folders = normalizedPreferences.favoriteFolders;
  }
  const payload = {
    project_name: toText(projectName),
    filter_spec: normalizeReservingClassFilterSpec(filterSpec),
    preferences: outPrefs,
  };
  const res = await fetch("/reserving_class_filter_spec", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = toText(body?.detail);
    } catch {
      detail = "";
    }
    throw makeError(detail || `HTTP ${res.status}`, res.status);
  }
  const out = await res.json();
  if (!out?.ok) {
    throw makeError("Invalid filter spec save response.", res.status || 0);
  }
  return {
    filterSpec: normalizeReservingClassFilterSpec(out?.filter_spec || {}),
    preferences: normalizeReservingClassFilterPreferences(out?.preferences || {}),
  };
}

const FILTER_STYLE_ID = "arcrho-reserving-class-filter-style";
const TREE_NODE_MENU_STYLE_ID = "arcrho-reserving-class-node-menu-style";
let activeFilterWindow = null;
let activePreferencesWindow = null;
let activeTreeNodeMenu = null;
let activeFilterValuesMenu = null;

function setPreferencesButtonsActive(doc, active) {
  const root = doc || window.document;
  if (!root || typeof root.querySelectorAll !== "function") return;
  root.querySelectorAll(".ptree-pref").forEach((btn) => {
    if (!btn?.classList) return;
    btn.classList.toggle("active", !!active);
  });
}

function ensureFilterWindowStyles(doc) {
  if (!doc || doc.getElementById(FILTER_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = FILTER_STYLE_ID;
  style.textContent = `
    .rcf-window {
      position: fixed;
      top: 132px;
      left: calc(50% + 286px);
      width: 520px;
      min-width: 360px;
      min-height: 260px;
      max-width: 96vw;
      max-height: 88vh;
      background: #fff;
      border: 1px solid #cfcfcf;
      border-radius: 8px;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.2);
      z-index: 5300;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      overscroll-behavior: contain;
    }
    .rcf-resize-handle {
      position: absolute;
      z-index: 5301;
    }
    .rcf-resize-n,
    .rcf-resize-s {
      left: 10px;
      right: 10px;
      height: 6px;
      cursor: ns-resize;
    }
    .rcf-resize-n { top: 0; }
    .rcf-resize-s { bottom: 0; }
    .rcf-resize-e,
    .rcf-resize-w {
      top: 10px;
      bottom: 10px;
      width: 6px;
      cursor: ew-resize;
    }
    .rcf-resize-w { left: 0; }
    .rcf-resize-e { right: 0; }
    .rcf-resize-nw,
    .rcf-resize-ne,
    .rcf-resize-sw,
    .rcf-resize-se {
      width: 12px;
      height: 12px;
    }
    .rcf-resize-nw { top: 0; left: 0; cursor: nwse-resize; }
    .rcf-resize-se { bottom: 0; right: 0; cursor: nwse-resize; }
    .rcf-resize-ne { top: 0; right: 0; cursor: nesw-resize; }
    .rcf-resize-sw { bottom: 0; left: 0; cursor: nesw-resize; }
    .rcf-titlebar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 12px;
      background: #f6f6f6;
      border-bottom: 1px solid #e1e1e1;
      user-select: none;
      cursor: grab;
      flex-shrink: 0;
    }
    .rcf-titlebar:active { cursor: grabbing; }
    .rcf-title-wrap {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      flex: 1 1 auto;
    }
    .rcf-title-icon {
      width: 16px;
      height: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: #666;
      flex-shrink: 0;
    }
    .rcf-title-icon svg {
      width: 100%;
      height: 100%;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .rcf-title {
      font-size: 14px;
      font-weight: 600;
      color: #2e2e2e;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      flex: 1 1 auto;
    }
    .rcf-tools {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .rcf-close {
      width: 30px;
      height: 30px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: #666;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .rcf-close:hover { background: #e8e8e8; }
    .rcf-close svg {
      width: 20px;
      height: 20px;
      stroke: currentColor;
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .rcprefs-window {
      position: fixed;
      top: 148px;
      left: calc(50% + 300px);
      width: 360px;
      min-width: 300px;
      max-width: 92vw;
      background: #fff;
      border: 1px solid #cfcfcf;
      border-radius: 8px;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.2);
      z-index: 5350;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .rcprefs-titlebar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 12px;
      background: #f6f6f6;
      border-bottom: 1px solid #e1e1e1;
      user-select: none;
      cursor: grab;
      flex-shrink: 0;
    }
    .rcprefs-titlebar:active { cursor: grabbing; }
    .rcprefs-title {
      font-size: 14px;
      font-weight: 600;
      color: #2e2e2e;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      flex: 1 1 auto;
    }
    .rcprefs-close {
      width: 30px;
      height: 30px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: #666;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .rcprefs-close:hover { background: #e8e8e8; }
    .rcprefs-close svg {
      width: 20px;
      height: 20px;
      stroke: currentColor;
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .rcprefs-body {
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      background: #fff;
    }
    .rcprefs-toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #333;
      font-size: 13px;
      user-select: none;
    }
    .rcprefs-toggle input[type="checkbox"] {
      width: 14px;
      height: 14px;
      margin: 0;
    }
    .rcprefs-help {
      color: #666;
      font-size: 12px;
      line-height: 1.35;
    }
    .rcf-body {
      flex: 1 1 auto;
      overflow: auto;
      padding: 10px 12px 8px;
      background: #fff;
      display: flex;
      flex-direction: column;
      gap: 10px;
      overscroll-behavior: contain;
    }
    .rcf-empty {
      color: #777;
      font-size: 13px;
      font-style: italic;
      padding: 8px 2px;
    }
    .rcf-row {
      display: grid;
      grid-template-columns: 128px 1fr;
      column-gap: 10px;
      align-items: start;
    }
    .rcf-label {
      font-size: 12px;
      color: #4f4f4f;
      padding-top: 8px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .rcf-input {
      min-height: 38px;
      border: 1px solid #d7d7d7;
      border-radius: 6px;
      padding: 5px 6px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: flex-start;
      background: #fff;
      transition: border-color 0.12s ease;
    }
    .rcf-input.drag {
      border-color: #2a66f5;
      box-shadow: 0 0 0 2px rgba(42, 102, 245, 0.12);
    }
    .rcf-search {
      flex: 1 1 80px;
      min-width: 80px;
      border: none;
      outline: none;
      background: transparent;
      font-size: 12px;
      color: #323232;
      line-height: 24px;
      padding: 0;
    }
    .rcf-search::placeholder {
      color: #9b9b9b;
      font-style: italic;
    }
    .rcf-values {
      margin-top: 6px;
      max-height: 104px;
      overflow: auto;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      border: 1px solid #efefef;
      border-radius: 6px;
      padding: 6px;
      background: #fafafa;
      overscroll-behavior: contain;
    }
    .rcf-values.drag {
      border-color: #2a66f5;
      box-shadow: 0 0 0 2px rgba(42, 102, 245, 0.12);
      background: #f4f8ff;
    }
    .rcf-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: 1px solid #d4d4d4;
      border-radius: 14px;
      padding: 1px 9px;
      font-size: 12px;
      color: #323232;
      background: #fff;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }
    .rcf-chip:hover { border-color: #9d9d9d; }
    .rcf-chip.selected {
      border-color: #2a66f5;
      background: #edf3ff;
      color: #1445ba;
    }
    .rcf-chip-icon {
      width: 11px;
      height: 11px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: #2563eb;
      flex-shrink: 0;
    }
    .rcf-chip-icon svg {
      width: 100%;
      height: 100%;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.9;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .rcf-chip-remove {
      border: none;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font-size: 12px;
      line-height: 1;
      padding: 0;
      margin-left: 2px;
    }
    .rcf-footer {
      flex-shrink: 0;
      border-top: 1px solid #ececec;
      background: #fbfbfb;
      padding: 8px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .rcf-summary {
      color: #666;
      font-size: 12px;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rcf-actions {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .rcf-btn {
      border: 1px solid #cfcfcf;
      border-radius: 6px;
      background: #fff;
      color: #333;
      font-size: 12px;
      padding: 3px 10px;
      cursor: pointer;
    }
    .rcf-btn:hover { background: #f2f2f2; }
    .rcf-btn:disabled {
      color: #9a9a9a;
      border-color: #e1e1e1;
      background: #fbfbfb;
      cursor: not-allowed;
    }
    .rcf-hidden-section {
      border-top: 1px solid #ececec;
      padding-top: 10px;
      margin-top: 2px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .rcf-hidden-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .rcf-hidden-title {
      font-size: 12px;
      font-weight: 600;
      color: #4f4f4f;
    }
    .rcf-hidden-actions {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .rcf-hidden-list {
      max-height: 140px;
      overflow: auto;
      border: 1px solid #efefef;
      border-radius: 6px;
      padding: 4px;
      background: #fafafa;
      overscroll-behavior: contain;
    }
    .rcf-hidden-empty {
      color: #777;
      font-size: 12px;
      padding: 6px 4px;
    }
    .rcf-hidden-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 5px 6px;
      border-radius: 6px;
      font-size: 12px;
      color: #222;
    }
    .rcf-hidden-row:hover { background: #eef3ff; }
    .rcf-hidden-row input {
      margin-top: 2px;
      flex-shrink: 0;
    }
    .rcf-hidden-path {
      min-width: 0;
      overflow-wrap: anywhere;
      line-height: 1.35;
    }
  `;
  doc.head.appendChild(style);
}

function ensureTreeNodeMenuStyles(doc) {
  if (!doc || doc.getElementById(TREE_NODE_MENU_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = TREE_NODE_MENU_STYLE_ID;
  style.textContent = `
    .rctm-menu {
      position: fixed;
      min-width: 176px;
      max-width: min(320px, 86vw);
      background: #fff;
      border: 1px solid #cfcfcf;
      border-radius: 8px;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.2);
      z-index: 5400;
      padding: 4px;
    }
    .rctm-item {
      width: 100%;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: #222;
      font-size: 12px;
      text-align: left;
      padding: 6px 9px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .rctm-item-label {
      flex: 1 1 auto;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .rctm-item-shortcut {
      flex-shrink: 0;
      color: #6f6f6f;
      font-size: 11px;
      line-height: 1;
    }
    .rctm-item:hover {
      background: #eef3ff;
    }
    .rctm-item:disabled {
      color: #9a9a9a;
      cursor: not-allowed;
    }
    .rctm-item:disabled .rctm-item-shortcut {
      color: #a5a5a5;
    }
    .rctm-item:disabled:hover {
      background: transparent;
    }
  `;
  doc.head.appendChild(style);
}

function makeFloatingWindowDraggable(doc, win, handle, ignoreSelector = "") {
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  const onMove = (e) => {
    if (!dragging) return;
    applyWindowPositionWithinFrame(doc, win, e.clientX - offsetX, e.clientY - offsetY);
  };
  const onUp = () => {
    if (dragging) {
      const rect = win.getBoundingClientRect();
      applyWindowPositionWithinFrame(doc, win, rect.left, rect.top);
    }
    dragging = false;
    doc.removeEventListener("mousemove", onMove);
    doc.removeEventListener("mouseup", onUp);
  };

  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (ignoreSelector && e.target.closest(ignoreSelector)) return;
    const rect = win.getBoundingClientRect();
    const resizeEdge = 16;
    if (e.clientX >= (rect.right - resizeEdge) && e.clientY >= (rect.bottom - resizeEdge)) return;
    dragging = true;
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    applyWindowPositionWithinFrame(doc, win, rect.left, rect.top);
    doc.addEventListener("mousemove", onMove);
    doc.addEventListener("mouseup", onUp);
    e.preventDefault();
  });
}

function makeFloatingWindowResizable(doc, win, options = {}) {
  const minWidth = Number(options?.minWidth) || 200;
  const minHeight = Number(options?.minHeight) || 150;
  const maxWidth = Number(options?.maxWidth) || Infinity;
  const maxHeight = Number(options?.maxHeight) || Infinity;
  const clampNum = (value, min, max) => Math.max(min, Math.min(max, value));

  const DIRECTIONS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

  for (const dir of DIRECTIONS) {
    const handle = doc.createElement("div");
    handle.className = `rcf-resize-handle rcf-resize-${dir}`;
    let dragging = null;

    const onMove = (e) => {
      if (!dragging || e.pointerId !== dragging.pointerId) return;
      const { startX, startY, startWidth, startHeight, startLeft, startTop } = dragging;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let width = startWidth;
      let height = startHeight;
      let left = startLeft;
      let top = startTop;

      if (dir.includes("e")) {
        width = clampNum(startWidth + dx, minWidth, maxWidth);
      }
      if (dir.includes("w")) {
        const right = startLeft + startWidth;
        width = clampNum(startWidth - dx, minWidth, maxWidth);
        left = right - width;
      }
      if (dir.includes("s")) {
        height = clampNum(startHeight + dy, minHeight, maxHeight);
      }
      if (dir.includes("n")) {
        const bottom = startTop + startHeight;
        height = clampNum(startHeight - dy, minHeight, maxHeight);
        top = bottom - height;
      }

      win.style.width = `${width}px`;
      win.style.height = `${height}px`;
      if (dir.includes("w") || dir.includes("n")) {
        applyWindowPositionWithinFrame(doc, win, left, top);
      }
    };

    const endDrag = (e) => {
      if (!dragging || (e && e.pointerId !== dragging.pointerId)) return;
      try { handle.releasePointerCapture(dragging.pointerId); } catch {}
      dragging = null;
    };

    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = win.getBoundingClientRect();
      dragging = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startWidth: rect.width,
        startHeight: rect.height,
        startLeft: rect.left,
        startTop: rect.top,
      };
      try { handle.setPointerCapture(e.pointerId); } catch {}
    });
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);

    win.appendChild(handle);
  }
}

function isVerticallyScrollable(el) {
  if (!el || typeof el.scrollHeight !== "number" || typeof el.clientHeight !== "number") return false;
  const view = el.ownerDocument?.defaultView || window;
  const style = view?.getComputedStyle ? view.getComputedStyle(el) : null;
  const overflowY = String(style?.overflowY || "").toLowerCase();
  const canScroll = overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
  return canScroll && (el.scrollHeight > (el.clientHeight + 1));
}

function findScrollableAncestorInside(target, root) {
  let el = target && target.nodeType === 1 ? target : null;
  while (el && el !== root) {
    if (isVerticallyScrollable(el)) return el;
    el = el.parentElement;
  }
  if (root && isVerticallyScrollable(root)) return root;
  return null;
}

function isolateWheelScroll(doc, win) {
  if (!doc || !win) return () => {};

  const onWheel = (evt) => {
    if (!win.contains(evt.target)) return;

    const targetEl = evt.target && evt.target.nodeType === 1 ? evt.target : null;
    const scroller = findScrollableAncestorInside(targetEl, win);
    if (!scroller) {
      evt.preventDefault();
      evt.stopPropagation();
      return;
    }

    const deltaY = Number(evt.deltaY || 0);
    if (!Number.isFinite(deltaY) || Math.abs(deltaY) < 0.01) return;

    const atTop = scroller.scrollTop <= 0;
    const atBottom = (scroller.scrollTop + scroller.clientHeight) >= (scroller.scrollHeight - 1);
    if ((deltaY < 0 && atTop) || (deltaY > 0 && atBottom)) {
      evt.preventDefault();
      evt.stopPropagation();
    }
  };

  doc.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => {
    doc.removeEventListener("wheel", onWheel, true);
  };
}

function closeReservingClassFilterWindow(reason = "programmatic") {
  if (!activeFilterWindow) return;
  closeReservingClassFilterValuesMenu("filter_closed");
  const { doc, win, onEsc, onWheelGuard, onBeforeClose, onClose } = activeFilterWindow;
  if (typeof onBeforeClose === "function") {
    let rect = null;
    try {
      rect = win && typeof win.getBoundingClientRect === "function"
        ? win.getBoundingClientRect()
        : null;
    } catch {
      rect = null;
    }
    try {
      onBeforeClose({
        reason,
        element: win,
        rect,
        left: Number(rect?.left),
        top: Number(rect?.top),
        width: Number(rect?.width),
        height: Number(rect?.height),
      });
    } catch {}
  }
  if (doc && onEsc) doc.removeEventListener("keydown", onEsc, true);
  if (typeof onWheelGuard === "function") {
    try { onWheelGuard(); } catch {}
  }
  if (win && win.parentNode) win.parentNode.removeChild(win);
  activeFilterWindow = null;
  if (typeof onClose === "function") {
    try { onClose(reason); } catch {}
  }
}

function refreshReservingClassFilterWindow() {
  if (typeof activeFilterWindow?.refresh === "function") {
    try { activeFilterWindow.refresh(); } catch {}
  }
}

function closeReservingClassPreferencesWindow(reason = "programmatic") {
  if (!activePreferencesWindow) return;
  const { doc, win, onEsc, onWheelGuard, onClose } = activePreferencesWindow;
  if (doc && onEsc) doc.removeEventListener("keydown", onEsc, true);
  if (typeof onWheelGuard === "function") {
    try { onWheelGuard(); } catch {}
  }
  if (win && win.parentNode) win.parentNode.removeChild(win);
  activePreferencesWindow = null;
  setPreferencesButtonsActive(doc, false);
  if (typeof onClose === "function") {
    try { onClose(reason); } catch {}
  }
}

function openReservingClassPreferencesWindow(options = {}) {
  const doc = options?.document || window.document;
  ensureFilterWindowStyles(doc);
  closeReservingClassPreferencesWindow("replaced");

  const win = doc.createElement("div");
  win.className = "rcprefs-window";

  const bar = doc.createElement("div");
  bar.className = "rcprefs-titlebar";

  const title = doc.createElement("div");
  title.className = "rcprefs-title";
  title.textContent = toText(options?.title) || "Tree View Preferences";

  const closeBtn = doc.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "rcprefs-close";
  closeBtn.title = "Close";
  closeBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
  closeBtn.addEventListener("click", () => closeReservingClassPreferencesWindow("close_button"));
  bar.append(title, closeBtn);
  win.appendChild(bar);

  const body = doc.createElement("div");
  body.className = "rcprefs-body";

  const toggleLabel = doc.createElement("label");
  toggleLabel.className = "rcprefs-toggle";
  const toggleInput = doc.createElement("input");
  toggleInput.type = "checkbox";
  toggleInput.checked =
    typeof options?.preferences?.autoExpandSingleChild === "boolean"
      ? options.preferences.autoExpandSingleChild
      : TREE_FILTER_PREFERENCE_DEFAULTS.autoExpandSingleChild;
  const toggleText = doc.createElement("span");
  toggleText.textContent = "Auto expand single-child nodes";
  toggleLabel.append(toggleInput, toggleText);
  body.appendChild(toggleLabel);

  const help = doc.createElement("div");
  help.className = "rcprefs-help";
  help.textContent = "When enabled, expanding a node with exactly one child will automatically expand the child.";
  body.appendChild(help);

  const hideSegmentLabelsLabel = doc.createElement("label");
  hideSegmentLabelsLabel.className = "rcprefs-toggle";
  const hideSegmentLabelsInput = doc.createElement("input");
  hideSegmentLabelsInput.type = "checkbox";
  hideSegmentLabelsInput.checked =
    typeof options?.preferences?.hideSegmentLabels === "boolean"
      ? options.preferences.hideSegmentLabels
      : TREE_FILTER_PREFERENCE_DEFAULTS.hideSegmentLabels;
  const hideSegmentLabelsText = doc.createElement("span");
  hideSegmentLabelsText.textContent = "Hide Segment Labels";
  hideSegmentLabelsLabel.append(hideSegmentLabelsInput, hideSegmentLabelsText);
  body.appendChild(hideSegmentLabelsLabel);

  const hideSegmentLabelsHelp = doc.createElement("div");
  hideSegmentLabelsHelp.className = "rcprefs-help";
  hideSegmentLabelsHelp.textContent = "Hide the segment labels shown at the right side of tree rows and shortcuts.";
  body.appendChild(hideSegmentLabelsHelp);

  const emitChange = () => {
    if (typeof options?.onChange === "function") {
      try {
        options.onChange({
          autoExpandSingleChild: !!toggleInput.checked,
          hideSegmentLabels: !!hideSegmentLabelsInput.checked,
        });
      } catch {}
    }
  };
  toggleInput.addEventListener("change", emitChange);
  hideSegmentLabelsInput.addEventListener("change", emitChange);

  win.appendChild(body);

  makeFloatingWindowDraggable(doc, win, bar, ".rcprefs-close, input, label");

  const onEsc = (evt) => {
    if (evt.key !== "Escape") return;
    evt.preventDefault();
    evt.stopPropagation();
    closeReservingClassPreferencesWindow("escape");
  };
  doc.addEventListener("keydown", onEsc, true);
  doc.body.appendChild(win);
  const onWheelGuard = isolateWheelScroll(doc, win);

  const anchor = options?.anchorElement;
  const view = doc.defaultView || window;
  if (anchor && typeof anchor.getBoundingClientRect === "function") {
    const anchorRect = anchor.getBoundingClientRect();
    const winRect = win.getBoundingClientRect();
    const viewportW = Number(view?.innerWidth || doc.documentElement.clientWidth || 0);
    const viewportH = Number(view?.innerHeight || doc.documentElement.clientHeight || 0);
    let left = anchorRect.right + 10;
    if (left + winRect.width > viewportW - 8) {
      left = Math.max(8, anchorRect.left - winRect.width - 10);
    }
    if (left + winRect.width > viewportW - 8) {
      left = Math.max(8, viewportW - winRect.width - 8);
    }
    let top = Math.max(8, anchorRect.top + 8);
    if (top + winRect.height > viewportH - 8) {
      top = Math.max(8, viewportH - winRect.height - 8);
    }
    applyWindowPositionWithinFrame(doc, win, left, top);
  }

  activePreferencesWindow = {
    doc,
    win,
    onEsc,
    onWheelGuard,
    onClose: options?.onClose,
  };

  return {
    close: () => closeReservingClassPreferencesWindow("api"),
    element: win,
  };
}

function closeReservingClassTreeNodeMenu(reason = "programmatic") {
  if (!activeTreeNodeMenu) return;
  const { doc, menu, onMouseDown, onEsc, onContextMenu } = activeTreeNodeMenu;
  if (doc && onMouseDown) doc.removeEventListener("mousedown", onMouseDown, true);
  if (doc && onEsc) doc.removeEventListener("keydown", onEsc, true);
  if (doc && onContextMenu) doc.removeEventListener("contextmenu", onContextMenu, true);
  if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
  activeTreeNodeMenu = null;
}

function closeReservingClassFilterValuesMenu(reason = "programmatic") {
  if (!activeFilterValuesMenu) return;
  const { doc, menu, onMouseDown, onEsc, onContextMenu } = activeFilterValuesMenu;
  if (doc && onMouseDown) doc.removeEventListener("mousedown", onMouseDown, true);
  if (doc && onEsc) doc.removeEventListener("keydown", onEsc, true);
  if (doc && onContextMenu) doc.removeEventListener("contextmenu", onContextMenu, true);
  if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
  activeFilterValuesMenu = null;
}

function openReservingClassFilterValuesMenu(options = {}) {
  const doc = options?.document || window.document;
  ensureTreeNodeMenuStyles(doc);
  closeReservingClassTreeNodeMenu("open_filter_values_menu");
  closeReservingClassFilterValuesMenu("replaced");

  const xIn = Number(options?.x);
  const yIn = Number(options?.y);
  const x = Number.isFinite(xIn) ? xIn : 0;
  const y = Number.isFinite(yIn) ? yIn : 0;
  const menu = doc.createElement("div");
  menu.className = "rctm-menu";

  const addMenuItem = (label, onClick, disabled = false) => {
    const item = doc.createElement("button");
    item.type = "button";
    item.className = "rctm-item";
    const itemLabel = doc.createElement("span");
    itemLabel.className = "rctm-item-label";
    itemLabel.textContent = String(label || "");
    item.appendChild(itemLabel);
    item.title = itemLabel.textContent;
    item.disabled = !!disabled;
    item.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      if (item.disabled) return;
      closeReservingClassFilterValuesMenu("item_click");
      if (typeof onClick === "function") {
        try { onClick(); } catch {}
      }
    });
    menu.appendChild(item);
  };

  addMenuItem(
    toText(options?.labelSelectAll) || "Select all",
    options?.onSelectAll,
    !options?.canSelectAll || typeof options?.onSelectAll !== "function",
  );
  addMenuItem(
    toText(options?.labelSelectCalculated) || "Select all Calculated Items",
    options?.onSelectCalculated,
    !options?.canSelectCalculated || typeof options?.onSelectCalculated !== "function",
  );
  addMenuItem(
    toText(options?.labelSelectImported) || "Select all Imported Items",
    options?.onSelectImported,
    !options?.canSelectImported || typeof options?.onSelectImported !== "function",
  );

  doc.body.appendChild(menu);

  const view = doc.defaultView || window;
  const viewportW = Number(view?.innerWidth || doc.documentElement.clientWidth || 0);
  const viewportH = Number(view?.innerHeight || doc.documentElement.clientHeight || 0);
  const rect = menu.getBoundingClientRect();

  let left = x;
  let top = y;
  if (left + rect.width > viewportW - 8) left = Math.max(8, viewportW - rect.width - 8);
  if (top + rect.height > viewportH - 8) top = Math.max(8, viewportH - rect.height - 8);
  left = Math.max(8, left);
  top = Math.max(8, top);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const onMouseDown = (evt) => {
    if (menu.contains(evt.target)) return;
    closeReservingClassFilterValuesMenu("outside_click");
  };
  const onEsc = (evt) => {
    if (String(evt?.key || "") !== "Escape") return;
    evt.preventDefault();
    evt.stopPropagation();
    if (typeof evt.stopImmediatePropagation === "function") evt.stopImmediatePropagation();
    closeReservingClassFilterValuesMenu("escape");
  };
  const onContextMenu = (evt) => {
    if (menu.contains(evt.target)) return;
    closeReservingClassFilterValuesMenu("outside_contextmenu");
  };

  doc.addEventListener("mousedown", onMouseDown, true);
  doc.addEventListener("keydown", onEsc, true);
  doc.addEventListener("contextmenu", onContextMenu, true);

  activeFilterValuesMenu = {
    doc,
    menu,
    onMouseDown,
    onEsc,
    onContextMenu,
  };
}

function openReservingClassTreeNodeMenu(options = {}) {
  const doc = options?.document || window.document;
  ensureTreeNodeMenuStyles(doc);
  closeReservingClassFilterValuesMenu("open_tree_node_menu");
  closeReservingClassTreeNodeMenu("replaced");

  const xIn = Number(options?.x);
  const yIn = Number(options?.y);
  const x = Number.isFinite(xIn) ? xIn : 0;
  const y = Number.isFinite(yIn) ? yIn : 0;
  const nodePath = toText(options?.nodePath);
  const nodeName = toText(options?.nodeName) || "selected";
  const menu = doc.createElement("div");
  menu.className = "rctm-menu";
  const addMenuItem = (label, onClick, disabled = false, shortcutHint = "") => {
    const item = doc.createElement("button");
    item.type = "button";
    item.className = "rctm-item";
    const itemLabel = doc.createElement("span");
    itemLabel.className = "rctm-item-label";
    itemLabel.textContent = String(label || "");
    item.appendChild(itemLabel);
    const hintText = String(shortcutHint || "").trim();
    if (hintText) {
      const hintEl = doc.createElement("span");
      hintEl.className = "rctm-item-shortcut";
      hintEl.textContent = hintText;
      item.appendChild(hintEl);
    }
    item.title = hintText ? `${itemLabel.textContent} (${hintText})` : itemLabel.textContent;
    item.disabled = !!disabled;
    item.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      if (item.disabled) return;
      closeReservingClassTreeNodeMenu("item_click");
      if (typeof onClick === "function") {
        try { onClick(); } catch {}
      }
    });
    menu.appendChild(item);
  };

  addMenuItem(
    "Copy Path",
    options?.onCopy,
    !nodePath || typeof options?.onCopy !== "function",
  );

  const canHide = typeof options?.onHide === "function";
  if (canHide) {
    addMenuItem(`Hide "${nodeName}"`, options.onHide, false, "H");
  }
  addMenuItem(
    "Unhide All",
    options?.onUnhideAll,
    !options?.canUnhideAll || typeof options?.onUnhideAll !== "function",
  );
  addMenuItem(
    "Hidden Paths...",
    options?.onHiddenPaths,
    typeof options?.onHiddenPaths !== "function",
  );

  doc.body.appendChild(menu);

  const view = doc.defaultView || window;
  const viewportW = Number(view?.innerWidth || doc.documentElement.clientWidth || 0);
  const viewportH = Number(view?.innerHeight || doc.documentElement.clientHeight || 0);
  const rect = menu.getBoundingClientRect();

  let left = x;
  let top = y;
  if (left + rect.width > viewportW - 8) left = Math.max(8, viewportW - rect.width - 8);
  if (top + rect.height > viewportH - 8) top = Math.max(8, viewportH - rect.height - 8);
  left = Math.max(8, left);
  top = Math.max(8, top);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const onMouseDown = (evt) => {
    if (menu.contains(evt.target)) return;
    closeReservingClassTreeNodeMenu("outside_click");
  };
  const onEsc = (evt) => {
    const key = String(evt?.key || "");
    if (key === "Escape") {
      evt.preventDefault();
      evt.stopPropagation();
      closeReservingClassTreeNodeMenu("escape");
      return;
    }
    if (
      (key === "h" || key === "H")
      && canHide
      && !evt.ctrlKey
      && !evt.altKey
      && !evt.metaKey
    ) {
      evt.preventDefault();
      evt.stopPropagation();
      closeReservingClassTreeNodeMenu("hide_shortcut");
      try { options.onHide(); } catch {}
    }
  };
  const onContextMenu = (evt) => {
    if (menu.contains(evt.target)) return;
    closeReservingClassTreeNodeMenu("outside_contextmenu");
  };

  doc.addEventListener("mousedown", onMouseDown, true);
  doc.addEventListener("keydown", onEsc, true);
  doc.addEventListener("contextmenu", onContextMenu, true);

  activeTreeNodeMenu = {
    doc,
    menu,
    onMouseDown,
    onEsc,
    onContextMenu,
  };
}

function openReservingClassFilterWindow(options = {}) {
  const doc = options?.document || window.document;
  ensureFilterWindowStyles(doc);
  closeReservingClassFilterWindow("replaced");

  const fields = Array.isArray(options?.fields) ? options.fields : [];
  const selectedByLevel = new Map();
  const rowStates = [];

  const win = doc.createElement("div");
  win.className = "rcf-window";
  const initialSize = options?.initialSize && typeof options.initialSize === "object"
    ? options.initialSize
    : null;
  const initialWidthRaw = parsePositiveInt(initialSize?.width);
  const initialHeightRaw = parsePositiveInt(initialSize?.height);
  if (initialWidthRaw) {
    const width = Math.max(360, Math.min(2400, initialWidthRaw));
    win.style.width = `${width}px`;
  }
  if (initialHeightRaw) {
    const height = Math.max(260, Math.min(1800, initialHeightRaw));
    win.style.height = `${height}px`;
  }

  const bar = doc.createElement("div");
  bar.className = "rcf-titlebar";

  const titleWrap = doc.createElement("div");
  titleWrap.className = "rcf-title-wrap";

  const titleIcon = doc.createElement("span");
  titleIcon.className = "rcf-title-icon";
  titleIcon.title = "Filter mapping";
  titleIcon.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="2" y="7" width="10" height="18" rx="1.5"/><line x1="2" y1="13" x2="12" y2="13"/><line x1="2" y1="19" x2="12" y2="19"/><rect x="20" y="7" width="10" height="18" rx="1.5"/><line x1="20" y1="13" x2="30" y2="13"/><line x1="20" y1="19" x2="30" y2="19"/><line x1="13" y1="16" x2="19" y2="16"/><polyline points="17,13.5 19.5,16 17,18.5"/></svg>';
  titleWrap.appendChild(titleIcon);

  const title = doc.createElement("span");
  title.className = "rcf-title";
  title.textContent = toText(options?.title) || "Filter Reserving Classes";
  titleWrap.appendChild(title);

  const tools = doc.createElement("div");
  tools.className = "rcf-tools";

  const closeBtn = doc.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "rcf-close";
  closeBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
  closeBtn.title = "Close";
  closeBtn.addEventListener("click", () => closeReservingClassFilterWindow("close_button"));
  tools.appendChild(closeBtn);

  bar.append(titleWrap, tools);
  win.appendChild(bar);

  const body = doc.createElement("div");
  body.className = "rcf-body";

  const buildFilterSpec = () => {
    const out = {};
    for (const [levelNum, keys] of selectedByLevel.entries()) {
      if (!keys || !keys.size) continue;
      out[String(levelNum)] = Array.from(keys);
    }
    return out;
  };

  const summary = doc.createElement("div");
  summary.className = "rcf-summary";
  const updateSummary = () => {
    let selectedCount = 0;
    for (const set of selectedByLevel.values()) selectedCount += set.size;
    if (!selectedCount) {
      summary.textContent = "No filters selected.";
      return;
    }
    const getMatchCount = typeof options?.getMatchCount === "function" ? options.getMatchCount : null;
    const matched = getMatchCount ? Number(getMatchCount()) : NaN;
    if (Number.isFinite(matched)) {
      summary.textContent = `${selectedCount} selected value${selectedCount === 1 ? "" : "s"} (${matched} matching rows).`;
    } else {
      summary.textContent = `${selectedCount} selected value${selectedCount === 1 ? "" : "s"}.`;
    }
  };

  const emitApply = () => {
    if (typeof options?.onApply === "function") {
      try { options.onApply(buildFilterSpec()); } catch {}
    }
    updateSummary();
  };

  const parseDragPayload = (evt, fallbackLevelNum) => {
    let raw = "";
    try {
      raw = String(evt?.dataTransfer?.getData("application/json") || "").trim();
    } catch {
      raw = "";
    }
    if (!raw) {
      try {
        raw = String(evt?.dataTransfer?.getData("text/plain") || "").trim();
      } catch {
        raw = "";
      }
    }
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // ignore and fallback
    }

    return {
      level_number: fallbackLevelNum,
      key: raw,
    };
  };

  const createCalculatedChipIcon = () => {
    const icon = doc.createElement("span");
    icon.className = "rcf-chip-icon";
    icon.title = "Calculated class type";
    icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h8v6H4zM12 11h8v6h-8zM12 3h8v6h-8z"/></svg>';
    return icon;
  };

  const registerFieldRow = (field, idx) => {
    const levelNum =
      parsePositiveInt(field?.level_number) ?? parsePositiveInt(field?.level_index) ?? (idx + 1);
    const label = toText(field?.field_name) || `Level ${idx + 1}`;
    const valuesIn = Array.isArray(field?.values) ? field.values : [];
    const valueMetaMap = new Map();
    for (const raw of valuesIn) {
      const rawName = typeof raw === "object" && raw !== null
        ? toText(raw.name ?? raw.value ?? raw.key)
        : toText(raw);
      const key = canonName(typeof raw === "object" && raw !== null ? (raw.key ?? rawName) : rawName);
      if (!key) continue;

      const isAggregate = !!(
        (raw && typeof raw === "object" && raw !== null && (
          raw.is_aggregate === true
          || raw.isAggregate === true
          || String(raw.value_type || raw.valueType || "").toLowerCase() === "calculated"
        ))
      );

      if (!valueMetaMap.has(key)) {
        valueMetaMap.set(key, { name: rawName || key, isAggregate });
        continue;
      }

      const prev = valueMetaMap.get(key);
      valueMetaMap.set(key, {
        name: toText(prev?.name) || rawName || key,
        isAggregate: !!(prev?.isAggregate || isAggregate),
      });
    }
    const values = Array.from(valueMetaMap.entries()).map(([key, meta]) => ({
      key,
      name: toText(meta?.name || key),
      isAggregate: !!meta?.isAggregate,
    }));
    values.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));

    const selected = new Set();
    const selectedIn = Array.isArray(field?.selected_keys) ? field.selected_keys : [];
    for (const raw of selectedIn) {
      const key = canonName(raw);
      if (!key || !valueMetaMap.has(key)) continue;
      selected.add(key);
    }
    selectedByLevel.set(levelNum, selected);

    const row = doc.createElement("div");
    row.className = "rcf-row";

    const labelEl = doc.createElement("div");
    labelEl.className = "rcf-label";
    labelEl.textContent = label;

    const editor = doc.createElement("div");

    const inputBox = doc.createElement("div");
    inputBox.className = "rcf-input";
    inputBox.dataset.levelNum = String(levelNum);

    const valuesBox = doc.createElement("div");
    valuesBox.className = "rcf-values";

    editor.append(inputBox, valuesBox);
    row.append(labelEl, editor);
    body.appendChild(row);

    const state = {
      levelNum,
      valueMetaMap,
      values,
      selected,
      inputBox,
      valuesBox,
      rerender: null,
    };
    rowStates.push(state);

    const addMatchingValuesToSelection = (predicate = null) => {
      let changed = false;
      for (const item of values) {
        if (!item?.key || selected.has(item.key)) continue;
        if (typeof predicate === "function" && !predicate(item)) continue;
        selected.add(item.key);
        changed = true;
      }
      if (changed) {
        rerender();
        emitApply();
      }
      return changed;
    };

    const removeMatchingValuesFromSelection = (predicate = null) => {
      let changed = false;
      for (const item of values) {
        if (!item?.key || !selected.has(item.key)) continue;
        if (typeof predicate === "function" && !predicate(item)) continue;
        selected.delete(item.key);
        changed = true;
      }
      if (changed) {
        rerender();
        emitApply();
      }
      return changed;
    };

    const countAddableValues = (predicate = null) => {
      let count = 0;
      for (const item of values) {
        if (!item?.key || selected.has(item.key)) continue;
        if (typeof predicate === "function" && !predicate(item)) continue;
        count += 1;
      }
      return count;
    };

    const countRemovableValues = (predicate = null) => {
      let count = 0;
      for (const item of values) {
        if (!item?.key || !selected.has(item.key)) continue;
        if (typeof predicate === "function" && !predicate(item)) continue;
        count += 1;
      }
      return count;
    };

    let searchText = "";
    const matchesSearchText = (item) => {
      if (!searchText) return true;
      return toText(item?.name || item?.key || "").toLowerCase().includes(searchText.toLowerCase());
    };

    const renderValues = () => {
      valuesBox.innerHTML = "";
      const matches = values.filter((item) => !selected.has(item.key) && matchesSearchText(item));
      if (!matches.length && searchText) {
        const empty = doc.createElement("div");
        empty.className = "rcf-empty";
        empty.textContent = "No matching values.";
        valuesBox.appendChild(empty);
        return;
      }
      for (const item of matches) {
        const chip = doc.createElement("span");
        chip.className = "rcf-chip";
        if (item.isAggregate) chip.appendChild(createCalculatedChipIcon());
        const txt = doc.createElement("span");
        txt.textContent = item.name;
        chip.appendChild(txt);
        chip.draggable = true;
        chip.title = "Drag to filter box, or click to add";
        chip.addEventListener("dragstart", (evt) => {
          if (!evt.dataTransfer) return;
          const payload = JSON.stringify({ level_number: levelNum, key: item.key });
          evt.dataTransfer.effectAllowed = "copy";
          try { evt.dataTransfer.setData("application/json", payload); } catch {}
          try { evt.dataTransfer.setData("text/plain", payload); } catch {}
        });
        chip.addEventListener("click", () => {
          if (selected.has(item.key)) return;
          selected.add(item.key);
          rerender();
          emitApply();
        });
        valuesBox.appendChild(chip);
      }
    };

    const searchInput = doc.createElement("input");
    searchInput.type = "text";
    searchInput.className = "rcf-search";
    searchInput.autocomplete = "off";
    searchInput.spellcheck = false;
    searchInput.addEventListener("mousedown", (evt) => evt.stopPropagation());
    searchInput.addEventListener("input", () => {
      searchText = searchInput.value;
      renderValues();
    });

    const rerender = () => {
      inputBox.innerHTML = "";
      const selectedKeys = Array.from(selected);
      selectedKeys.sort((a, b) => {
        const da = toText(valueMetaMap.get(a)?.name || a);
        const db = toText(valueMetaMap.get(b)?.name || b);
        return da.localeCompare(db, undefined, { sensitivity: "base", numeric: true });
      });
      for (const key of selectedKeys) {
        const chip = doc.createElement("span");
        chip.className = "rcf-chip selected";
        chip.draggable = true;
        chip.title = "Drag back to values to remove";
        const meta = valueMetaMap.get(key) || { name: key, isAggregate: false };
        if (meta.isAggregate) chip.appendChild(createCalculatedChipIcon());
        const txt = doc.createElement("span");
        txt.textContent = toText(meta.name || key);
        chip.appendChild(txt);

        chip.addEventListener("dragstart", (evt) => {
          if (!evt.dataTransfer) return;
          const payload = JSON.stringify({ level_number: levelNum, key });
          evt.dataTransfer.effectAllowed = "move";
          try { evt.dataTransfer.setData("application/json", payload); } catch {}
          try { evt.dataTransfer.setData("text/plain", payload); } catch {}
        });

        const removeBtn = doc.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "rcf-chip-remove";
        removeBtn.textContent = "\u00D7";
        removeBtn.title = "Remove";
        removeBtn.addEventListener("click", (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          selected.delete(key);
          rerender();
          emitApply();
        });
        chip.appendChild(removeBtn);
        inputBox.appendChild(chip);
      }

      searchInput.placeholder = selectedKeys.length ? "Type to search..." : "Drag values here, or type to search...";
      searchInput.value = searchText;
      inputBox.appendChild(searchInput);

      renderValues();
    };

    inputBox.addEventListener("dragover", (evt) => {
      evt.preventDefault();
      inputBox.classList.add("drag");
    });
    inputBox.addEventListener("dragleave", () => {
      inputBox.classList.remove("drag");
    });
    inputBox.addEventListener("drop", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      inputBox.classList.remove("drag");
      const payload = parseDragPayload(evt, levelNum);
      const payloadLevel = parsePositiveInt(payload?.level_number ?? payload?.levelNum ?? payload?.level);
      if (payloadLevel && payloadLevel !== levelNum) return;
      const key = canonName(payload?.key ?? payload?.name ?? payload?.value);
      if (!key || !valueMetaMap.has(key) || selected.has(key)) return;
      selected.add(key);
      rerender();
      emitApply();
    });
    inputBox.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();

      const canRemoveAll = countRemovableValues() > 0;
      const canRemoveCalculated = countRemovableValues((item) => !!item.isAggregate) > 0;
      const canRemoveImported = countRemovableValues((item) => !item.isAggregate) > 0;

      openReservingClassFilterValuesMenu({
        document: doc,
        x: evt.clientX,
        y: evt.clientY,
        canSelectAll: canRemoveAll,
        canSelectCalculated: canRemoveCalculated,
        canSelectImported: canRemoveImported,
        labelSelectAll: "Remove all",
        labelSelectCalculated: "Remove all Calculated Items",
        labelSelectImported: "Remove all Imported Items",
        onSelectAll: () => {
          removeMatchingValuesFromSelection();
        },
        onSelectCalculated: () => {
          removeMatchingValuesFromSelection((item) => !!item.isAggregate);
        },
        onSelectImported: () => {
          removeMatchingValuesFromSelection((item) => !item.isAggregate);
        },
      });
    });

    valuesBox.addEventListener("dragover", (evt) => {
      evt.preventDefault();
      valuesBox.classList.add("drag");
    });
    valuesBox.addEventListener("dragleave", () => {
      valuesBox.classList.remove("drag");
    });
    valuesBox.addEventListener("drop", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      valuesBox.classList.remove("drag");
      const payload = parseDragPayload(evt, levelNum);
      const payloadLevel = parsePositiveInt(payload?.level_number ?? payload?.levelNum ?? payload?.level);
      if (payloadLevel && payloadLevel !== levelNum) return;
      const key = canonName(payload?.key ?? payload?.name ?? payload?.value);
      if (!key || !selected.has(key)) return;
      selected.delete(key);
      rerender();
      emitApply();
    });

    valuesBox.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();

      const canSelectAll = countAddableValues() > 0;
      const canSelectCalculated = countAddableValues((item) => !!item.isAggregate) > 0;
      const canSelectImported = countAddableValues((item) => !item.isAggregate) > 0;

      openReservingClassFilterValuesMenu({
        document: doc,
        x: evt.clientX,
        y: evt.clientY,
        canSelectAll,
        canSelectCalculated,
        canSelectImported,
        onSelectAll: () => {
          addMatchingValuesToSelection();
        },
        onSelectCalculated: () => {
          addMatchingValuesToSelection((item) => !!item.isAggregate);
        },
        onSelectImported: () => {
          addMatchingValuesToSelection((item) => !item.isAggregate);
        },
      });
    });

    state.rerender = rerender;
    rerender();
  };

  if (!fields.length) {
    const empty = doc.createElement("div");
    empty.className = "rcf-empty";
    empty.textContent = "No reserving class fields found.";
    body.appendChild(empty);
  } else {
    fields.forEach(registerFieldRow);
  }

  let renderHiddenPathsSection = null;
  if (typeof options?.getHiddenPaths === "function") {
    const hiddenSection = doc.createElement("div");
    hiddenSection.className = "rcf-hidden-section";

    const hiddenHeader = doc.createElement("div");
    hiddenHeader.className = "rcf-hidden-header";
    const hiddenTitle = doc.createElement("span");
    hiddenTitle.className = "rcf-hidden-title";
    hiddenHeader.appendChild(hiddenTitle);

    const hiddenActions = doc.createElement("div");
    hiddenActions.className = "rcf-hidden-actions";
    const unhideSelectedBtn = doc.createElement("button");
    unhideSelectedBtn.type = "button";
    unhideSelectedBtn.className = "rcf-btn";
    unhideSelectedBtn.textContent = "Unhide Selected";
    unhideSelectedBtn.disabled = true;
    const unhideAllBtn = doc.createElement("button");
    unhideAllBtn.type = "button";
    unhideAllBtn.className = "rcf-btn";
    unhideAllBtn.textContent = "Unhide All";
    hiddenActions.append(unhideSelectedBtn, unhideAllBtn);
    hiddenHeader.appendChild(hiddenActions);

    const hiddenList = doc.createElement("div");
    hiddenList.className = "rcf-hidden-list";

    const hiddenSelected = new Set();

    const renderHiddenPaths = () => {
      const rawPaths = options.getHiddenPaths();
      const paths = Array.isArray(rawPaths) ? rawPaths : [];
      for (const path of Array.from(hiddenSelected)) {
        if (!paths.includes(path)) hiddenSelected.delete(path);
      }
      hiddenTitle.textContent = `Hidden Paths${paths.length ? ` (${paths.length})` : ""}`;
      hiddenList.innerHTML = "";
      if (!paths.length) {
        const empty = doc.createElement("div");
        empty.className = "rcf-hidden-empty";
        empty.textContent = "No hidden paths.";
        hiddenList.appendChild(empty);
      } else {
        paths.forEach((path) => {
          const row = doc.createElement("label");
          row.className = "rcf-hidden-row";
          const chk = doc.createElement("input");
          chk.type = "checkbox";
          chk.value = path;
          chk.checked = hiddenSelected.has(path);
          chk.addEventListener("change", () => {
            if (chk.checked) hiddenSelected.add(path);
            else hiddenSelected.delete(path);
            unhideSelectedBtn.disabled = hiddenSelected.size < 1;
          });
          const text = doc.createElement("span");
          text.className = "rcf-hidden-path";
          text.textContent = path;
          row.append(chk, text);
          hiddenList.appendChild(row);
        });
      }
      unhideSelectedBtn.disabled = hiddenSelected.size < 1;
      unhideAllBtn.disabled = paths.length < 1;
    };

    unhideSelectedBtn.addEventListener("click", async () => {
      if (!hiddenSelected.size || typeof options?.onUnhideSelected !== "function") return;
      const selectedPaths = Array.from(hiddenSelected);
      try { await options.onUnhideSelected(selectedPaths); } catch {}
      renderHiddenPaths();
    });
    unhideAllBtn.addEventListener("click", async () => {
      if (typeof options?.onUnhideAll !== "function") return;
      try { await options.onUnhideAll(); } catch {}
      renderHiddenPaths();
    });

    hiddenSection.append(hiddenHeader, hiddenList);
    body.appendChild(hiddenSection);
    renderHiddenPathsSection = renderHiddenPaths;
    renderHiddenPaths();
  }

  win.appendChild(body);

  const footer = doc.createElement("div");
  footer.className = "rcf-footer";
  footer.appendChild(summary);

  const actions = doc.createElement("div");
  actions.className = "rcf-actions";

  const clearBtn = doc.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "rcf-btn";
  clearBtn.textContent = "Clear";
  clearBtn.addEventListener("click", () => {
    for (const row of rowStates) {
      if (!row?.selected) continue;
      row.selected.clear();
      if (typeof row.rerender === "function") {
        row.rerender();
      }
    }
    emitApply();
  });
  actions.appendChild(clearBtn);

  const doneBtn = doc.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "rcf-btn";
  doneBtn.textContent = "Done";
  doneBtn.addEventListener("click", () => closeReservingClassFilterWindow("done"));
  actions.appendChild(doneBtn);

  footer.appendChild(actions);
  win.appendChild(footer);

  updateSummary();

  makeFloatingWindowDraggable(doc, win, bar, ".rcf-tools, .rcf-btn, .rcf-chip, .rcf-chip-remove");
  makeFloatingWindowResizable(doc, win, { minWidth: 360, minHeight: 260, maxWidth: 2400, maxHeight: 1800 });

  const onEsc = (evt) => {
    if (evt.key !== "Escape") return;
    evt.preventDefault();
    evt.stopPropagation();
    closeReservingClassFilterWindow("escape");
  };
  doc.addEventListener("keydown", onEsc, true);
  doc.body.appendChild(win);
  const onWheelGuard = isolateWheelScroll(doc, win);

  const anchor = options?.anchorElement;
  const view = doc.defaultView || window;
  if (anchor && typeof anchor.getBoundingClientRect === "function") {
    const anchorRect = anchor.getBoundingClientRect();
    const winRect = win.getBoundingClientRect();
    const viewportW = Number(view?.innerWidth || doc.documentElement.clientWidth || 0);
    const viewportH = Number(view?.innerHeight || doc.documentElement.clientHeight || 0);
    let left = anchorRect.right + 10;
    if (left + winRect.width > viewportW - 8) {
      left = Math.max(8, anchorRect.left - winRect.width - 10);
    }
    if (left + winRect.width > viewportW - 8) {
      left = Math.max(8, viewportW - winRect.width - 8);
    }
    let top = Math.max(8, anchorRect.top + 8);
    if (top + winRect.height > viewportH - 8) {
      top = Math.max(8, viewportH - winRect.height - 8);
    }
    applyWindowPositionWithinFrame(doc, win, left, top);
  }

  activeFilterWindow = {
    doc,
    win,
    onEsc,
    onWheelGuard,
    onBeforeClose: options?.onBeforeClose,
    onClose: options?.onClose,
    refresh: renderHiddenPathsSection,
  };

  return {
    close: () => closeReservingClassFilterWindow("api"),
    element: win,
  };
}

export async function openReservingClassPicker(options = {}) {
  const projectName = toText(options?.projectName);
  const cacheKey = canonName(projectName);
  const forceModelReload = !!options?.forceModelReload;
  const preserveFilters = !!options?.preserveFilters;
  const ignoreSavedFilterSpec = !!options?.ignoreSavedFilterSpec;
  const setStatus = typeof options?.setStatus === "function" ? options.setStatus : () => {};
  const onSelect = typeof options?.onSelect === "function" ? options.onSelect : null;
  const onClose = typeof options?.onClose === "function" ? options.onClose : null;
  const onProjectMissing =
    typeof options?.onProjectMissing === "function" ? options.onProjectMissing : null;
  const onError = typeof options?.onError === "function" ? options.onError : null;
  const missingSelectionMessage = toText(options?.missingSelectionMessage) || "Please select a project first.";
  const noValuesMessage =
    toText(options?.noValuesMessage) || "No reserving class values found for this project.";
  const hiddenAllMessage =
    toText(options?.hiddenAllMessage) || "All reserving class paths are hidden. Use right-click menu: Unhide All.";
  const anchorElement = options?.anchorElement || null;
  const inlineContainer = options?.inlineContainer && typeof options.inlineContainer.appendChild === "function"
    ? options.inlineContainer
    : null;
  const inlineTree = !!inlineContainer;
  const pickerTitle = toText(options?.title) || "Reserving Class";

  const openWorkflowOnlyPathPicker = () => {
    const workflowRootNode = buildWorkflowPathRootNode(options);
    if (!workflowRootNode) return null;

    closeReservingClassTreeNodeMenu("reopen");
    closeReservingClassFilterWindow("reopen");
    closeReservingClassPreferencesWindow("reopen");
    closeFloatingPathTreePicker("reopen");

    const picker = openFloatingPathTreePicker({
      title: pickerTitle,
      titleIcon: "hierarchy",
      container: inlineContainer || undefined,
      embedded: inlineTree,
      draggable: !inlineTree,
      closeOnEscape: !inlineTree,
      showCloseButton: !inlineTree,
      rootNodes: [],
      shortcutRootNodes: [workflowRootNode],
      delimiter: "\\",
      initialPath: toText(options?.initialPath),
      defaultExpandedDepth: Number.isInteger(options?.defaultExpandedDepth)
        ? Number(options.defaultExpandedDepth)
        : 1,
      autoCloseOnSelect: false,
      allowBranchSelect: false,
      onSelect: (path, node) => {
        closeReservingClassTreeNodeMenu("selected");
        closeReservingClassFilterWindow("selected");
        closeReservingClassPreferencesWindow("selected");
        if (onSelect) onSelect(toText(path), node);
      },
      onClose: (reason) => {
        closeReservingClassTreeNodeMenu(reason || "tree_closed");
        closeReservingClassFilterWindow(reason || "tree_closed");
        closeReservingClassPreferencesWindow(reason || "tree_closed");
        if (onClose) onClose(reason);
      },
    });
    if (picker?.element && anchorElement && !inlineTree) {
      positionWindowBelowAnchor(window.document, picker.element, anchorElement, 8);
    }
    return picker || null;
  };

  if (!projectName) {
    const picker = openWorkflowOnlyPathPicker();
    if (picker) return { ok: true, picker };
    setStatus(missingSelectionMessage);
    return { ok: false, reason: "missing_project" };
  }

  closeReservingClassTreeNodeMenu("reopen");
  closeReservingClassFilterWindow("reopen");
  closeReservingClassPreferencesWindow("reopen");
  closeFloatingPathTreePicker("reopen");

  try {
    // The filter spec lives in a different file from the combinations and types
    // pair below, so start its request alongside them instead of after them. On
    // a network drive each serialized request costs a full round trip, and this
    // one is on the Project Instance page-load critical path. The promise is
    // settled into a result object so an early start can never surface as an
    // unhandled rejection while the pair is still in flight.
    const filterPrefsCacheKey = getFilterPrefsCacheKey(projectName);
    const hasCachedSpec = !ignoreSavedFilterSpec && !!(cacheKey && FILTER_SPEC_CACHE.has(cacheKey));
    const hasCachedPrefs = FILTER_PREFS_CACHE.has(filterPrefsCacheKey);
    const needsFilterSpec = preserveFilters ? !hasCachedPrefs : (!hasCachedSpec || !hasCachedPrefs);
    const filterSpecRequest = needsFilterSpec
      ? fetchReservingClassFilterSpec(projectName).then(
          (loaded) => ({ ok: true, loaded }),
          (err) => ({ ok: false, err }),
        )
      : null;

    let model = (!forceModelReload && cacheKey) ? LOOKUP_MODEL_CACHE.get(cacheKey) : null;
    if (!model) {
      const [combosData, reservingTypesData] = await Promise.all([
        fetchReservingClassCombinations(projectName),
        fetchReservingClassTypes(projectName),
      ]);
      model = buildReservingClassLookupModel(combosData, reservingTypesData);
      if (cacheKey) LOOKUP_MODEL_CACHE.set(cacheKey, model);
    }

    let treeFilterPreferences = normalizeReservingClassFilterPreferences(
      FILTER_PREFS_CACHE.get(filterPrefsCacheKey) || {},
    );

    if (!preserveFilters) {
      let initialFilterSpec = {};

      if (hasCachedSpec) {
        initialFilterSpec = normalizeReservingClassFilterSpec(FILTER_SPEC_CACHE.get(cacheKey));
      }
      if (hasCachedPrefs) {
        treeFilterPreferences = normalizeReservingClassFilterPreferences(
          FILTER_PREFS_CACHE.get(filterPrefsCacheKey),
        );
      }

      if (filterSpecRequest) {
        const result = await filterSpecRequest;
        if (result.ok) {
          const loaded = result.loaded;
          initialFilterSpec = ignoreSavedFilterSpec
            ? {}
            : normalizeReservingClassFilterSpec(loaded?.filterSpec || {});
          treeFilterPreferences = normalizeReservingClassFilterPreferences(loaded?.preferences || {});
          if (cacheKey && !ignoreSavedFilterSpec) {
            FILTER_SPEC_CACHE.set(cacheKey, initialFilterSpec);
          }
          FILTER_PREFS_CACHE.set(filterPrefsCacheKey, treeFilterPreferences);
        } else {
          // Filter preferences are optional; continue with no filters when unavailable.
          console.warn("Failed to load reserving-class filter preference:", result.err);
          if (!hasCachedSpec) initialFilterSpec = {};
          if (!hasCachedPrefs) {
            treeFilterPreferences = normalizeReservingClassFilterPreferences({});
          }
        }
      }

      if (typeof model.applyFilters === "function") {
        model.applyFilters(initialFilterSpec);
      } else if (typeof model.clearFilters === "function") {
        model.clearFilters();
      }
    } else {
      if (cacheKey && !FILTER_SPEC_CACHE.has(cacheKey) && typeof model.getActiveFilterSpec === "function") {
        FILTER_SPEC_CACHE.set(cacheKey, normalizeReservingClassFilterSpec(model.getActiveFilterSpec()));
      }
      if (filterSpecRequest) {
        const result = await filterSpecRequest;
        if (result.ok) {
          const loaded = result.loaded;
          treeFilterPreferences = normalizeReservingClassFilterPreferences(loaded?.preferences || {});
          FILTER_PREFS_CACHE.set(filterPrefsCacheKey, treeFilterPreferences);
          if (!FILTER_SPEC_CACHE.has(cacheKey)) {
            FILTER_SPEC_CACHE.set(
              cacheKey,
              normalizeReservingClassFilterSpec(loaded?.filterSpec || {}),
            );
          }
        } else {
          console.warn("Failed to load reserving-class filter preference:", result.err);
          FILTER_PREFS_CACHE.set(filterPrefsCacheKey, treeFilterPreferences);
        }
      }
    }
    if (typeof model.setFavoritePaths === "function") {
      model.setFavoritePaths(treeFilterPreferences?.favoritePaths || []);
    }
    if (typeof model.setFavoriteNicknames === "function") {
      model.setFavoriteNicknames(treeFilterPreferences?.favoriteNicknames || {});
    }
    if (typeof model.setFavoriteFolders === "function") {
      model.setFavoriteFolders(treeFilterPreferences?.favoriteFolders || []);
    }
    const levelLabels = Array.isArray(model.levelLabels) ? model.levelLabels : [];
    const filterEmptyMessage =
      toText(options?.filterEmptyMessage) || "No reserving class paths match the selected filters.";
    let activePath = toText(options?.initialPath);
    const internalCloseReason = "filter_refresh";
    const delimiter = "\\";
    const hiddenPathMap = new Map();
    const addHiddenPath = (rawPath) => {
      const display = splitPath(rawPath, delimiter).join(delimiter);
      const key = normalizeTreePathKey(display, delimiter);
      if (!key) return;
      hiddenPathMap.set(key, display);
    };
    const hiddenCacheList = Array.isArray(HIDDEN_PATHS_CACHE.get(cacheKey))
      ? HIDDEN_PATHS_CACHE.get(cacheKey)
      : [];
    for (const raw of hiddenCacheList) addHiddenPath(raw);
    try {
      const loadedHiddenPaths = await fetchReservingClassHiddenPaths(projectName);
      hiddenPathMap.clear();
      for (const raw of loadedHiddenPaths) addHiddenPath(raw);
      if (cacheKey) HIDDEN_PATHS_CACHE.set(cacheKey, Array.from(hiddenPathMap.values()));
    } catch (err) {
      // Hidden-path preferences are optional; continue with any cached in-memory value.
      console.warn("Failed to load reserving-class hidden paths:", err);
    }
    const hasHiddenPath = (rawPath) => {
      const key = normalizeTreePathKey(rawPath, delimiter);
      if (!key) return false;
      for (const hiddenKey of hiddenPathMap.keys()) {
        if (!hiddenKey) continue;
        if (key === hiddenKey || key.startsWith(`${hiddenKey}${delimiter}`)) return true;
      }
      return false;
    };
    const filterHiddenNodes = (nodes) => {
      const arr = Array.isArray(nodes) ? nodes : [];
      if (!hiddenPathMap.size) return arr;
      return arr.filter((node) => !hasHiddenPath(node?.path || ""));
    };
    const persistHiddenPaths = async () => {
      const payload = Array.from(hiddenPathMap.values())
        .sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true }));
      const saved = await saveReservingClassHiddenPaths(projectName, payload);
      hiddenPathMap.clear();
      for (const raw of saved) addHiddenPath(raw);
      if (cacheKey) HIDDEN_PATHS_CACHE.set(cacheKey, Array.from(hiddenPathMap.values()));
      refreshReservingClassFilterWindow();
      return Array.from(hiddenPathMap.values());
    };
    const getHiddenPathsList = () => Array.from(hiddenPathMap.values())
      .sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true }));
    const unhideSelectedPaths = async (paths) => {
      const values = Array.isArray(paths) ? paths : [];
      if (!values.length) return false;
      let changed = false;
      for (const raw of values) {
        const key = normalizeTreePathKey(raw, delimiter);
        if (!key || !hiddenPathMap.has(key)) continue;
        hiddenPathMap.delete(key);
        changed = true;
      }
      if (!changed) return false;
      try {
        await persistHiddenPaths();
      } catch (err) {
        console.error("Failed to save hidden reserving-class paths:", err);
        setStatus("Failed to save hidden path preference.");
        return false;
      }
      openTreeWindow({ smoothReplaceExisting: true });
      return true;
    };
    const unhideAllHiddenPaths = async () => {
      if (!hiddenPathMap.size) return false;
      hiddenPathMap.clear();
      try {
        await persistHiddenPaths();
      } catch (err) {
        console.error("Failed to clear hidden reserving-class paths:", err);
        setStatus("Failed to reset hidden path preference.");
        return false;
      }
      openTreeWindow({ smoothReplaceExisting: true });
      return true;
    };
    const persistFilterSpec = (rawSpec) => {
      const normalized = normalizeReservingClassFilterSpec(rawSpec);
      if (cacheKey) FILTER_SPEC_CACHE.set(cacheKey, normalized);
      FILTER_PREFS_CACHE.set(filterPrefsCacheKey, treeFilterPreferences);
      void (async () => {
        try {
          const saved = await saveReservingClassFilterSpec(projectName, normalized, treeFilterPreferences);
          const savedSpec = normalizeReservingClassFilterSpec(saved?.filterSpec || {});
          const savedPrefs = normalizeReservingClassFilterPreferences(saved?.preferences || {});
          treeFilterPreferences = savedPrefs;
          if (cacheKey) {
            FILTER_SPEC_CACHE.set(cacheKey, savedSpec);
          }
          FILTER_PREFS_CACHE.set(filterPrefsCacheKey, savedPrefs);
        } catch (err) {
          console.error("Failed to save reserving-class filter preference:", err);
          setStatus("Failed to save filter preference.");
        }
      })();
      return normalized;
    };
    const persistFilterPreferences = (rawPrefs) => {
      const nextPrefs = (rawPrefs && typeof rawPrefs === "object") ? rawPrefs : {};
      const normalizedPrefs = normalizeReservingClassFilterPreferences({
        ...treeFilterPreferences,
        ...nextPrefs,
      });
      treeFilterPreferences = normalizedPrefs;
      FILTER_PREFS_CACHE.set(filterPrefsCacheKey, normalizedPrefs);

      const currentSpec = normalizeReservingClassFilterSpec(
        (typeof model.getActiveFilterSpec === "function")
          ? model.getActiveFilterSpec()
          : {},
      );
      if (cacheKey) FILTER_SPEC_CACHE.set(cacheKey, currentSpec);

      void (async () => {
        try {
          const saved = await saveReservingClassFilterSpec(projectName, currentSpec, normalizedPrefs);
          const savedSpec = normalizeReservingClassFilterSpec(saved?.filterSpec || {});
          const savedPrefs = normalizeReservingClassFilterPreferences(saved?.preferences || {});
          treeFilterPreferences = savedPrefs;
          if (cacheKey) {
            FILTER_SPEC_CACHE.set(cacheKey, savedSpec);
          }
          FILTER_PREFS_CACHE.set(filterPrefsCacheKey, savedPrefs);
        } catch (err) {
          console.error("Failed to save reserving-class tree preferences:", err);
          setStatus("Failed to save tree preferences.");
        }
      })();
      return normalizedPrefs;
    };
    const TREE_WINDOW_SIZE_LIMITS = Object.freeze({
      minWidth: 320,
      minHeight: 240,
      maxWidth: 2400,
      maxHeight: 1800,
    });
    const FILTER_WINDOW_SIZE_LIMITS = Object.freeze({
      minWidth: 360,
      minHeight: 260,
      maxWidth: 2400,
      maxHeight: 1800,
    });
    const normalizeWindowSize = (rawSize, limits = TREE_WINDOW_SIZE_LIMITS) => {
      const widthRaw = parsePositiveInt(rawSize?.width);
      const heightRaw = parsePositiveInt(rawSize?.height);
      return {
        width: widthRaw ? Math.max(limits.minWidth, Math.min(limits.maxWidth, widthRaw)) : null,
        height: heightRaw ? Math.max(limits.minHeight, Math.min(limits.maxHeight, heightRaw)) : null,
      };
    };
    const readWindowSize = (el, limits = TREE_WINDOW_SIZE_LIMITS) => {
      if (!el || typeof el.getBoundingClientRect !== "function") return { width: null, height: null };
      const rect = el.getBoundingClientRect();
      return normalizeWindowSize({ width: rect?.width, height: rect?.height }, limits);
    };
    const applyWindowSize = (el, size, limits = TREE_WINDOW_SIZE_LIMITS) => {
      if (!el || !size) return;
      const normalized = normalizeWindowSize(size, limits);
      if (normalized.width) el.style.width = `${normalized.width}px`;
      if (normalized.height) el.style.height = `${normalized.height}px`;
    };
    let treeWindowSize = normalizeWindowSize({
      width: treeFilterPreferences?.treeWindowWidth,
      height: treeFilterPreferences?.treeWindowHeight,
    }, TREE_WINDOW_SIZE_LIMITS);
    const persistTreeWindowSize = (rawSize) => {
      const nextSize = normalizeWindowSize(rawSize || {}, TREE_WINDOW_SIZE_LIMITS);
      const currentSize = normalizeWindowSize({
        width: treeFilterPreferences?.treeWindowWidth,
        height: treeFilterPreferences?.treeWindowHeight,
      }, TREE_WINDOW_SIZE_LIMITS);
      if (nextSize.width === currentSize.width && nextSize.height === currentSize.height) {
        return false;
      }
      treeFilterPreferences = persistFilterPreferences({
        ...treeFilterPreferences,
        treeWindowWidth: nextSize.width,
        treeWindowHeight: nextSize.height,
      });
      return true;
    };
    let filterWindowSize = normalizeWindowSize({
      width: treeFilterPreferences?.filterWindowWidth,
      height: treeFilterPreferences?.filterWindowHeight,
    }, FILTER_WINDOW_SIZE_LIMITS);
    const persistFilterWindowSize = (rawSize) => {
      const nextSize = normalizeWindowSize(rawSize || {}, FILTER_WINDOW_SIZE_LIMITS);
      const currentSize = normalizeWindowSize({
        width: treeFilterPreferences?.filterWindowWidth,
        height: treeFilterPreferences?.filterWindowHeight,
      }, FILTER_WINDOW_SIZE_LIMITS);
      if (nextSize.width === currentSize.width && nextSize.height === currentSize.height) {
        return false;
      }
      treeFilterPreferences = persistFilterPreferences({
        ...treeFilterPreferences,
        filterWindowWidth: nextSize.width,
        filterWindowHeight: nextSize.height,
      });
      return true;
    };
    const readWindowPosition = (el) => {
      if (!el || typeof el.getBoundingClientRect !== "function") return null;
      if ("isConnected" in el && !el.isConnected) return null;
      const rect = el.getBoundingClientRect();
      const left = Number(rect?.left);
      const top = Number(rect?.top);
      if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
      return { left, top };
    };
    const applyWindowPosition = (el, pos) => {
      if (!el || !pos) return;
      const left = Number(pos?.left);
      const top = Number(pos?.top);
      if (!Number.isFinite(left) || !Number.isFinite(top)) return;
      applyWindowPositionWithinFrame(window.document, el, left, top);
    };
    const normalizeExpandedTreePaths = (rawPaths) => {
      const values = Array.isArray(rawPaths) ? rawPaths : [];
      const out = [];
      const seen = new Set();
      for (const raw of values) {
        const parts = splitPath(raw, delimiter);
        if (!parts.length) continue;
        const path = parts.join(delimiter);
        const key = normalizeTreePathKey(path, delimiter);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(path);
      }
      out.sort((a, b) => {
        const depthDiff = splitPath(a, delimiter).length - splitPath(b, delimiter).length;
        if (depthDiff !== 0) return depthDiff;
        return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
      });
      return out;
    };
    let treeWindowPosition = null;
    let treeWindowScroll = null;
    let treeWindowElement = null;
    let treeWindowPicker = null;
    let treeExpandedPaths = null;
    const getFavoriteDisplayItems = () => {
      if (typeof model.getFavoritePaths !== "function") return [];
      return model.getFavoritePaths().map((path) => {
        const nickname = typeof model.getFavoriteNickname === "function"
          ? model.getFavoriteNickname(path)
          : "";
        const sourceNode = typeof model.getPathNode === "function"
          ? model.getPathNode(path)
          : null;
        return {
          path,
          nickname: nickname || path,
          levelLabel: sourceNode?.level_label || sourceNode?.levelLabel || levelLabels[Math.max(0, splitPath(path, "\\").length - 1)] || "",
          valueType: sourceNode?.value_type || sourceNode?.valueType || "imported",
        };
      });
    };
    const getFavoriteRenderState = () => ({
      favoriteItems: getFavoriteDisplayItems(),
      favoriteFolders: typeof model.getFavoriteFolders === "function" ? model.getFavoriteFolders() : [],
      showFavoriteSection: true,
    });
    const persistModelFavorites = () => {
      const favoritePaths = typeof model.getFavoritePaths === "function" ? model.getFavoritePaths() : [];
      const favoriteNicknames = typeof model.getFavoriteNicknames === "function"
        ? model.getFavoriteNicknames()
        : {};
      const favoriteFolders = typeof model.getFavoriteFolders === "function"
        ? model.getFavoriteFolders()
        : [];
      treeFilterPreferences = persistFilterPreferences({
        ...treeFilterPreferences,
        favoritePaths,
        favoriteNicknames,
        favoriteFolders,
      });
    };
    const refreshFavoritesInTreeWindow = () => {
      treeWindowPosition = readWindowPosition(treeWindowElement) || treeWindowPosition;
      if (typeof treeWindowPicker?.refreshFavoriteSection === "function") {
        treeWindowPicker.refreshFavoriteSection(getFavoriteRenderState());
        return;
      }
      closeFloatingPathTreePicker(internalCloseReason);
      openTreeWindow({ smoothReplaceExisting: true });
    };

    const openTreeWindow = (refreshOptions = {}) => {
      const rootChildrenRaw = model.getRootNodes();
      const workflowRootNode = buildWorkflowPathRootNode(options);
      const rootChildren = filterHiddenNodes(rootChildrenRaw);
      if (!rootChildren.length && !workflowRootNode) {
        treeWindowElement = null;
        if (rootChildrenRaw.length && hiddenPathMap.size) {
          setStatus(hiddenAllMessage);
        } else if (model.hasActiveFilters()) {
          setStatus(filterEmptyMessage);
        } else {
          setStatus(noValuesMessage);
        }
        return false;
      }

      const handleFilterClick = (ctx) => {
        closeReservingClassTreeNodeMenu("open_filter");
        closeReservingClassPreferencesWindow("open_filter");
        treeWindowPosition = readWindowPosition(ctx?.pickerElement || treeWindowElement) || treeWindowPosition;
        openReservingClassFilterWindow({
          document: window.document,
          title: `${pickerTitle} Filters`,
          fields: model.getFilterFields(),
          anchorElement: ctx?.buttonElement || ctx?.pickerElement || null,
          initialSize: filterWindowSize,
          getMatchCount: () => model.getActiveMatchCount(),
          getHiddenPaths: getHiddenPathsList,
          onUnhideSelected: (paths) => unhideSelectedPaths(paths),
          onUnhideAll: () => unhideAllHiddenPaths(),
          onApply: (spec) => {
            const normalizedSpec = persistFilterSpec(spec);
            model.applyFilters(normalizedSpec);
            treeWindowPosition = readWindowPosition(treeWindowElement) || treeWindowPosition;
            closeFloatingPathTreePicker(internalCloseReason);
            openTreeWindow();
          },
          onBeforeClose: (closeCtx) => {
            const nextSize = normalizeWindowSize(
              { width: closeCtx?.width, height: closeCtx?.height },
              FILTER_WINDOW_SIZE_LIMITS,
            );
            if (nextSize.width || nextSize.height) {
              filterWindowSize = nextSize;
            }
          },
          onClose: () => {
            persistFilterWindowSize(filterWindowSize);
          },
        });
      };
      const handlePreferencesClick = (ctx) => {
        closeReservingClassTreeNodeMenu("open_preferences");
        closeReservingClassFilterWindow("open_preferences");
        treeWindowPosition = readWindowPosition(ctx?.pickerElement || treeWindowElement) || treeWindowPosition;
        openReservingClassPreferencesWindow({
          document: window.document,
          title: "Tree View Preferences",
          anchorElement: ctx?.buttonElement || ctx?.pickerElement || null,
          preferences: treeFilterPreferences,
          onChange: (nextPrefs) => {
            treeFilterPreferences = persistFilterPreferences(nextPrefs);
            treeWindowPosition = readWindowPosition(treeWindowElement) || treeWindowPosition;
            closeFloatingPathTreePicker(internalCloseReason);
            openTreeWindow();
          },
        });
        setPreferencesButtonsActive(window.document, true);
      };

      const picker = openFloatingPathTreePicker({
        title: pickerTitle,
        titleFromActivePath: true,
        activePath,
        titleIcon: "hierarchy",
        container: inlineContainer || undefined,
        embedded: inlineTree,
        draggable: !inlineTree,
        closeOnEscape: !inlineTree,
        showCloseButton: !inlineTree,
        rootNodes: rootChildren,
        levelLabels,
        delimiter: "\\",
        expandedPaths: Array.isArray(treeExpandedPaths) ? treeExpandedPaths : undefined,
        initialScrollTop: Number.isFinite(Number(treeWindowScroll?.top)) ? Number(treeWindowScroll.top) : undefined,
        initialScrollLeft: Number.isFinite(Number(treeWindowScroll?.left)) ? Number(treeWindowScroll.left) : undefined,
        smoothReplaceExisting: !!refreshOptions?.smoothReplaceExisting,
        initialPath: activePath,
        defaultExpandedDepth: Number.isInteger(options?.defaultExpandedDepth)
          ? Number(options.defaultExpandedDepth)
          : 0,
        autoExpandSingleChild: !!treeFilterPreferences.autoExpandSingleChild,
        autoCloseOnSelect: false,
        hideSegmentLabels: !!treeFilterPreferences.hideSegmentLabels,
        showFavoriteSection: true,
        favoriteSectionTitle: "Shortcut",
        sourceSectionTitle: "All Paths",
        showSourceSectionTitle: true,
        sourceSectionActions: inlineTree ? [
          {
            title: "Collapse Bottom Level",
            className: "ptree-collapse",
            icon: COLLAPSE_DEEPEST_ICON,
            onClick: () => {
              void treeWindowPicker?.collapseDeepest?.();
            },
          },
          {
            title: "Filter",
            className: "ptree-filter",
            active: model.hasActiveFilters(),
            icon: FILTER_ICON,
            onClick: handleFilterClick,
          },
          {
            title: "Preferences",
            className: "ptree-pref",
            active: !!activePreferencesWindow,
            icon: SETTINGS_ICON,
            onClick: handlePreferencesClick,
          },
        ] : [],
        shortcutRootNodes: workflowRootNode ? [workflowRootNode] : [],
        ...getFavoriteRenderState(),
        getFavoriteState: (path) => {
          if (typeof model.isFavoritePath === "function" && model.isFavoritePath(path)) {
            return "selected";
          }
          if (typeof model.isFavoriteAncestor === "function" && model.isFavoriteAncestor(path)) {
            return "ancestor";
          }
          return "none";
        },
        onToggleFavorite: (path) => {
          if (typeof model.toggleFavoritePath !== "function") return;
          model.toggleFavoritePath(path);
          persistModelFavorites();
          refreshFavoritesInTreeWindow();
        },
        onRenameFavorite: (path, item, ctx) => {
          if (typeof model.setFavoriteNickname !== "function") return;
          const next = toText(ctx?.name ?? item?.nickname ?? model.getFavoriteNickname?.(path));
          if (!next) return;
          model.setFavoriteNickname(path, next);
          persistModelFavorites();
          refreshFavoritesInTreeWindow();
        },
        onRevertFavoriteNickname: (path) => {
          if (typeof model.setFavoriteNickname !== "function") return;
          model.setFavoriteNickname(path, "");
          persistModelFavorites();
          refreshFavoritesInTreeWindow();
        },
        onDeleteFavorite: (path) => {
          if (typeof model.toggleFavoritePath !== "function" || !model.isFavoritePath?.(path)) return;
          model.toggleFavoritePath(path);
          persistModelFavorites();
          refreshFavoritesInTreeWindow();
        },
        onCreateFavoriteFolder: () => {
          if (typeof model.createFavoriteFolder !== "function") return;
          const existing = typeof model.getFavoriteFolders === "function"
            ? model.getFavoriteFolders()
            : [];
          const names = new Set(existing.map((folder) => toText(folder?.name).toLowerCase()).filter(Boolean));
          let name = "New Folder";
          let n = 2;
          while (names.has(name.toLowerCase())) name = `New Folder ${n++}`;
          model.createFavoriteFolder(name);
          persistModelFavorites();
          refreshFavoritesInTreeWindow();
        },
        onRenameFavoriteFolder: (folderId, folder, ctx) => {
          if (typeof model.renameFavoriteFolder !== "function") return;
          const name = toText(ctx?.name ?? folder?.name);
          if (!name) return;
          model.renameFavoriteFolder(folderId, name);
          persistModelFavorites();
          refreshFavoritesInTreeWindow();
        },
        onDeleteFavoriteFolder: (folderId) => {
          if (typeof model.deleteFavoriteFolder !== "function") return;
          model.deleteFavoriteFolder(folderId);
          persistModelFavorites();
          refreshFavoritesInTreeWindow();
        },
        onReorderFavoriteFolder: (folderId, targetFolderId, ctx) => {
          if (typeof model.reorderFavoriteFolder !== "function") return;
          model.reorderFavoriteFolder(folderId, targetFolderId, toText(ctx?.position) || "before");
          persistModelFavorites();
          refreshFavoritesInTreeWindow();
        },
        onMoveFavoriteToFolder: (path, folderId) => {
          if (typeof model.moveFavoriteToFolder !== "function") return;
          model.moveFavoriteToFolder(path, folderId);
          persistModelFavorites();
          refreshFavoritesInTreeWindow();
        },
        allowBranchSelect: !!options?.allowBranchSelect,
        showFilterButton: true,
        filterButtonTitle: "Filter",
        filterButtonActive: model.hasActiveFilters(),
        onFilterClick: handleFilterClick,
        showPreferencesButton: true,
        preferencesButtonTitle: "Preferences",
        preferencesButtonActive: !!activePreferencesWindow,
        onPreferencesClick: handlePreferencesClick,
        onNodeContextMenu: (node, ctx) => {
          const hidePath = toText(node?.path);
          if (!hidePath) return;
          const nodeName = toText(node?.name) || "selected";
          const event = ctx?.event;
          const pickerEl =
            treeWindowElement
            || (ctx?.element && typeof ctx.element.closest === "function"
              ? ctx.element.closest(".ptree-window")
              : null);
          treeWindowPosition = readWindowPosition(pickerEl) || treeWindowPosition;
          openReservingClassTreeNodeMenu({
            document: window.document,
            x: Number(event?.clientX),
            y: Number(event?.clientY),
            nodePath: hidePath,
            nodeName,
            onCopy: () => {
              void (async () => {
                const ok = await copyTextToClipboard(hidePath, window.document);
                if (!ok) {
                  setStatus("Failed to copy path.");
                  return;
                }
                setStatus(`Copied path: ${hidePath}`);
              })();
            },
            canUnhideAll: hiddenPathMap.size > 0,
            onUnhideAll: () => {
              void unhideAllHiddenPaths();
            },
            onHiddenPaths: () => {
              handleFilterClick({ pickerElement: pickerEl });
            },
            onHide: () => {
              addHiddenPath(hidePath);
              void (async () => {
                try {
                  await persistHiddenPaths();
                } catch (err) {
                  console.error("Failed to save hidden reserving-class path:", err);
                  setStatus("Failed to save hidden path preference.");
                  return;
                }
                closeReservingClassTreeNodeMenu("hide_path");
                const removeResult = typeof treeWindowPicker?.removePath === "function"
                  ? await treeWindowPicker.removePath(hidePath)
                  : null;
                if (removeResult?.removed && Number(removeResult?.remaining || 0) > 0) {
                  return;
                }
                openTreeWindow({ smoothReplaceExisting: true });
              })();
            },
          });
        },
        loadChildren: async (node) => {
          const rawChildren = model.getChildrenForPrefix(node?.path || "");
          return filterHiddenNodes(rawChildren);
        },
        onActivePathChange: (path) => {
          activePath = toText(path);
        },
        onSelect: (path, node) => {
          activePath = toText(path);
          closeReservingClassTreeNodeMenu("selected");
          closeReservingClassFilterWindow("selected");
          closeReservingClassPreferencesWindow("selected");
          if (onSelect) onSelect(toText(path), node);
        },
        onBeforeClose: (ctx) => {
          const nextSize = normalizeWindowSize({ width: ctx?.width, height: ctx?.height });
          if (nextSize.width || nextSize.height) {
            treeWindowSize = nextSize;
          }
          if (Array.isArray(ctx?.expandedPaths)) {
            treeExpandedPaths = normalizeExpandedTreePaths(ctx.expandedPaths);
          }
          const scrollTop = Number(ctx?.scrollTop);
          const scrollLeft = Number(ctx?.scrollLeft);
          treeWindowScroll = {
            top: Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0,
            left: Number.isFinite(scrollLeft) ? Math.max(0, scrollLeft) : 0,
          };
        },
        onClose: (reason) => {
          treeWindowElement = null;
          treeWindowPicker = null;
          if (reason !== internalCloseReason) {
            persistTreeWindowSize(treeWindowSize);
            closeReservingClassTreeNodeMenu(reason || "tree_closed");
            closeReservingClassFilterWindow(reason || "tree_closed");
            closeReservingClassPreferencesWindow(reason || "tree_closed");
            if (onClose) onClose(reason);
          }
        },
      });
      treeWindowPicker = picker || null;
      treeWindowElement = picker?.element || null;
      if (treeWindowElement && !inlineTree) {
        applyWindowSize(treeWindowElement, treeWindowSize);
      }
      if (treeWindowElement && treeWindowPosition && !inlineTree) {
        applyWindowPosition(treeWindowElement, treeWindowPosition);
      } else if (treeWindowElement && anchorElement && !inlineTree) {
        positionWindowBelowAnchor(window.document, treeWindowElement, anchorElement, 8);
      }
      if (treeWindowElement) {
        const measured = readWindowSize(treeWindowElement);
        treeWindowSize = normalizeWindowSize({
          width: measured?.width ?? treeWindowSize?.width,
          height: measured?.height ?? treeWindowSize?.height,
        });
      }
      return true;
    };

    const opened = openTreeWindow();
    if (!opened) return { ok: false, reason: "empty" };

    return {
      ok: true,
      picker: treeWindowPicker,
      model,
      revealPath: (path, revealOptions = {}) => {
        activePath = toText(path);
        if (typeof treeWindowPicker?.revealPath !== "function") return Promise.resolve(false);
        return treeWindowPicker.revealPath(path, revealOptions);
      },
      setActivePath: (path) => {
        activePath = toText(path);
        if (typeof treeWindowPicker?.setActivePath !== "function") return false;
        treeWindowPicker.setActivePath(path);
        return true;
      },
    };
  } catch (err) {
    const statusCode = Number(err?.status || 0);
    closeReservingClassTreeNodeMenu("error");
    closeReservingClassFilterWindow("error");
    closeReservingClassPreferencesWindow("error");
    if (statusCode === 404) {
      if (onProjectMissing) {
        onProjectMissing(projectName, err);
      } else {
        setStatus(`Project "${projectName}" does not exist.`);
      }
      return { ok: false, reason: "project_not_found", status: 404, error: err };
    }

    if (onError) {
      onError(err);
    } else {
      setStatus("Error loading reserving class paths.");
    }
    return { ok: false, reason: "error", status: statusCode || 0, error: err };
  }
}

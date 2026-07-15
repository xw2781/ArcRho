/*
===============================================================================
DFM Cell Notes - shared cell note behavior for ratio and summary tables
===============================================================================
*/

const NOTE_TABLES = {
  main: "ratioMainTable",
  summary: "ratioSummaryTable",
};

const NOTE_PAYLOAD_KEYS = {
  main: "ratio main table",
  summary: "ratio summary table",
};

const notesByTable = new Map([
  [NOTE_TABLES.main, new Map()],
  [NOTE_TABLES.summary, new Map()],
]);

const pendingLegacyNotesByTable = new Map([
  [NOTE_TABLES.main, new Map()],
  [NOTE_TABLES.summary, new Map()],
]);

let notesBox = null;
let notesTextarea = null;
let notesClearButton = null;
let notesActiveIdentity = null;
let notesHideTimer = null;
let noteChangeCallback = () => {};

function getNotesMap(tableId) {
  return notesByTable.get(tableId) || null;
}

function getPendingLegacyNotesMap(tableId) {
  return pendingLegacyNotesByTable.get(tableId) || null;
}

function normalizeNoteText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function normalizeLabelText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function makeLabelKey(rowLabel, colLabel) {
  return JSON.stringify([normalizeLabelText(rowLabel), normalizeLabelText(colLabel)]);
}

function parseLabelKey(key) {
  try {
    const parsed = JSON.parse(String(key || ""));
    if (!Array.isArray(parsed) || parsed.length < 2) return null;
    const rowLabel = normalizeLabelText(parsed[0]);
    const colLabel = normalizeLabelText(parsed[1]);
    return rowLabel && colLabel ? { rowLabel, colLabel } : null;
  } catch {
    return null;
  }
}

function getRatioHeaderLabel(col) {
  const colKey = String(col ?? "");
  if (colKey === "") return "";
  const header = document.querySelector(`#ratioWrap table.ratioMainTable thead th[data-col="${CSS.escape(colKey)}"]`);
  return normalizeLabelText(header?.textContent || "");
}

function getCellRowLabel(cell) {
  return normalizeLabelText(cell?.closest?.("tr")?.querySelector?.("th")?.textContent || "");
}

function getCellColumnLabel(cell) {
  return getRatioHeaderLabel(cell?.dataset?.col ?? cell?.dataset?.c);
}

function getCellIdentity(cell) {
  if (!cell || cell.tagName !== "TD") return null;
  const mainTable = cell.closest("table.ratioMainTable");
  if (mainTable && cell.classList.contains("ratioCell")) {
    const row = String(cell.dataset.r ?? "");
    const col = String(cell.dataset.col ?? cell.dataset.c ?? "");
    const rowLabel = getCellRowLabel(cell);
    const colLabel = getCellColumnLabel(cell);
    if (rowLabel && colLabel && row && col !== "") {
      return {
        tableId: NOTE_TABLES.main,
        key: makeLabelKey(rowLabel, colLabel),
        legacyKey: `${row},${col}`,
        rowLabel,
        colLabel,
      };
    }
  }
  const summaryTable = cell.closest("table.ratioSummaryTable");
  if (summaryTable && cell.classList.contains("summaryCell")) {
    const row = String(cell.dataset.r ?? "");
    const col = String(cell.dataset.col ?? cell.dataset.c ?? "");
    const rowLabel = getCellRowLabel(cell);
    const colLabel = getCellColumnLabel(cell);
    if (rowLabel && colLabel && row && col !== "") {
      return {
        tableId: NOTE_TABLES.summary,
        key: makeLabelKey(rowLabel, colLabel),
        legacyKey: `${row},${col}`,
        rowLabel,
        colLabel,
      };
    }
  }
  return null;
}

function getCellForIdentity(identity) {
  if (!identity) return null;
  const labels = parseLabelKey(identity.key);
  if (!labels) return null;
  const selector = identity.tableId === NOTE_TABLES.main
    ? "#ratioWrap table.ratioMainTable td.ratioCell"
    : identity.tableId === NOTE_TABLES.summary
      ? "#ratioWrap table.ratioSummaryTable td.summaryCell"
      : "";
  if (!selector) return null;
  const cells = document.querySelectorAll(selector);
  for (const cell of cells) {
    const cellIdentity = getCellIdentity(cell);
    if (cellIdentity?.key === identity.key) return cell;
  }
  return null;
}

function migratePendingLegacyNoteForIdentity(identity) {
  const map = getNotesMap(identity?.tableId);
  const legacyMap = getPendingLegacyNotesMap(identity?.tableId);
  if (!map || !legacyMap || !identity?.key || !identity?.legacyKey) return "";
  const text = normalizeNoteText(legacyMap.get(identity.legacyKey));
  if (!text) return "";
  legacyMap.delete(identity.legacyKey);
  if (!map.has(identity.key)) map.set(identity.key, text);
  return String(map.get(identity.key) || "");
}

function migratePendingLegacyNotes() {
  const selectors = [
    "#ratioWrap table.ratioMainTable td.ratioCell",
    "#ratioWrap table.ratioSummaryTable td.summaryCell",
  ];
  selectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((cell) => {
      const identity = getCellIdentity(cell);
      if (identity) migratePendingLegacyNoteForIdentity(identity);
    });
  });
}

function getLegacyCellForKey(tableId, key) {
  const [row, col] = String(key || "").split(",");
  if (!row || col == null) return null;
  const safeRow = CSS.escape(row);
  const safeCol = CSS.escape(col);
  if (tableId === NOTE_TABLES.main) {
    return document.querySelector(`#ratioWrap table.ratioMainTable td.ratioCell[data-r="${safeRow}"][data-col="${safeCol}"]`);
  }
  if (tableId === NOTE_TABLES.summary) {
    return document.querySelector(`#ratioWrap table.ratioSummaryTable td.summaryCell[data-r="${safeRow}"][data-col="${safeCol}"]`);
  }
  return null;
}

function getNote(identity) {
  const map = getNotesMap(identity?.tableId);
  if (!map) return "";
  const direct = String(map.get(identity.key) || "");
  if (direct) return direct;
  return migratePendingLegacyNoteForIdentity(identity);
}

function isSameIdentity(left, right) {
  return !!left && !!right && left.tableId === right.tableId && left.key === right.key;
}

function updateNotesClearButton() {
  if (!notesClearButton || !notesActiveIdentity) return;
  notesClearButton.disabled = !getNote(notesActiveIdentity);
}

function setNote(identity, value) {
  const map = getNotesMap(identity?.tableId);
  if (!map || !identity?.key) return false;
  const legacyMap = getPendingLegacyNotesMap(identity?.tableId);
  const text = normalizeNoteText(value);
  const before = String(map.get(identity.key) || "");
  if (identity.legacyKey && legacyMap) legacyMap.delete(identity.legacyKey);
  if (text) {
    map.set(identity.key, text);
  } else {
    map.delete(identity.key);
  }
  if (before === text) return false;
  applyDfmCellNoteMarkers();
  noteChangeCallback();
  if (isSameIdentity(identity, notesActiveIdentity)) updateNotesClearButton();
  return true;
}

function ensureNotesBox() {
  if (notesBox && notesTextarea) return notesBox;
  notesBox = document.createElement("div");
  notesBox.className = "dfmCellNoteBox";
  notesBox.style.display = "none";
  const header = document.createElement("div");
  header.className = "dfmCellNoteHeader";
  const title = document.createElement("div");
  title.className = "dfmCellNoteTitle";
  title.textContent = "Cell Note";
  notesClearButton = document.createElement("button");
  notesClearButton.className = "dfmCellNoteClearBtn";
  notesClearButton.type = "button";
  notesClearButton.textContent = "Clear";
  notesClearButton.addEventListener("click", () => {
    if (!notesActiveIdentity) return;
    setNote(notesActiveIdentity, "");
    notesTextarea.value = "";
    hideDfmCellNoteBox();
  });
  notesTextarea = document.createElement("textarea");
  notesTextarea.className = "dfmCellNoteText";
  notesTextarea.placeholder = "Add a note";
  notesTextarea.addEventListener("input", () => {
    if (!notesActiveIdentity) return;
    setNote(notesActiveIdentity, notesTextarea.value);
    updateNotesClearButton();
  });
  notesTextarea.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideDfmCellNoteBox();
  });
  notesBox.addEventListener("mouseenter", clearNotesHideTimer);
  notesBox.addEventListener("mouseleave", scheduleNotesHide);
  header.appendChild(title);
  header.appendChild(notesClearButton);
  notesBox.appendChild(header);
  notesBox.appendChild(notesTextarea);
  document.body.appendChild(notesBox);
  document.addEventListener("mousedown", (event) => {
    if (!notesBox || notesBox.style.display !== "block") return;
    if (notesBox.contains(event.target)) return;
    if (event.target?.closest?.("td.dfmCellNote")) return;
    hideDfmCellNoteBox();
  });
  return notesBox;
}

function positionNotesBox(cell) {
  if (!cell || !notesBox) return;
  const rect = cell.getBoundingClientRect();
  const width = 260;
  const gap = 8;
  let left = rect.right + gap;
  if (left + width > window.innerWidth - gap) {
    left = Math.max(gap, rect.left - width - gap);
  }
  let top = rect.top;
  const maxTop = Math.max(gap, window.innerHeight - 180);
  top = Math.max(gap, Math.min(top, maxTop));
  notesBox.style.left = `${left}px`;
  notesBox.style.top = `${top}px`;
}

function clearNotesHideTimer() {
  if (notesHideTimer) {
    clearTimeout(notesHideTimer);
    notesHideTimer = null;
  }
}

function scheduleNotesHide() {
  clearNotesHideTimer();
  notesHideTimer = setTimeout(() => {
    if (notesTextarea && document.activeElement === notesTextarea) return;
    hideDfmCellNoteBox();
  }, 180);
}

export function hideDfmCellNoteBox() {
  clearNotesHideTimer();
  if (notesBox) notesBox.style.display = "none";
  notesActiveIdentity = null;
}

export function showDfmCellNoteEditor(cell, options = {}) {
  const identity = getCellIdentity(cell);
  if (!identity) return false;
  ensureNotesBox();
  notesActiveIdentity = identity;
  notesTextarea.value = getNote(identity);
  notesBox.style.display = "block";
  positionNotesBox(cell);
  updateNotesClearButton();
  if (options.focus) {
    notesTextarea.focus();
    notesTextarea.selectionStart = notesTextarea.value.length;
    notesTextarea.selectionEnd = notesTextarea.value.length;
  }
  return true;
}

function showDfmCellNotePreview(cell) {
  const identity = getCellIdentity(cell);
  if (!identity || !getNote(identity)) return false;
  clearNotesHideTimer();
  return showDfmCellNoteEditor(cell, { focus: false });
}

export function hasDfmCellNote(cell) {
  const identity = getCellIdentity(cell);
  return !!(identity && getNote(identity));
}

export function clearDfmCellNote(cell) {
  const identity = getCellIdentity(cell);
  if (!identity) return false;
  const changed = setNote(identity, "");
  if (isSameIdentity(identity, notesActiveIdentity)) {
    if (notesTextarea) notesTextarea.value = "";
    hideDfmCellNoteBox();
  }
  return changed;
}

export function applyDfmCellNoteMarkers(root = document) {
  const scope = root || document;
  migratePendingLegacyNotes();
  scope.querySelectorAll?.("#ratioWrap td.dfmCellNote, td.dfmCellNote")
    .forEach((cell) => cell.classList.remove("dfmCellNote"));

  notesByTable.forEach((map, tableId) => {
    for (const key of map.keys()) {
      const cell = getCellForIdentity({ tableId, key });
      if (cell) cell.classList.add("dfmCellNote");
    }
  });

  pendingLegacyNotesByTable.forEach((map, tableId) => {
    for (const key of map.keys()) {
      const cell = getLegacyCellForKey(tableId, key);
      if (cell) cell.classList.add("dfmCellNote");
    }
  });
}

function objectFromNotesMap(map) {
  const out = {};
  for (const [key, value] of map.entries()) {
    const text = normalizeNoteText(value);
    const labels = parseLabelKey(key);
    if (!text || !labels) continue;
    if (!out[labels.rowLabel] || typeof out[labels.rowLabel] !== "object" || Array.isArray(out[labels.rowLabel])) {
      out[labels.rowLabel] = {};
    }
    out[labels.rowLabel][labels.colLabel] = text;
  }
  return out;
}

function loadNotesObject(tableId, source) {
  const map = getNotesMap(tableId);
  const legacyMap = getPendingLegacyNotesMap(tableId);
  if (!map || !source || typeof source !== "object" || Array.isArray(source)) return;
  Object.entries(source).forEach(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const rowLabel = normalizeLabelText(key);
      Object.entries(value).forEach(([colKey, noteValue]) => {
        const colLabel = normalizeLabelText(colKey);
        const text = normalizeNoteText(noteValue);
        if (rowLabel && colLabel && text) map.set(makeLabelKey(rowLabel, colLabel), text);
      });
      return;
    }
    const text = normalizeNoteText(value);
    if (key && text) legacyMap?.set(String(key), text);
  });
}

export function buildDfmCellNotesPayload() {
  migratePendingLegacyNotes();
  return {
    [NOTE_PAYLOAD_KEYS.main]: objectFromNotesMap(getNotesMap(NOTE_TABLES.main)),
    [NOTE_PAYLOAD_KEYS.summary]: objectFromNotesMap(getNotesMap(NOTE_TABLES.summary)),
  };
}

export function applyDfmCellNotesPayload(payload) {
  notesByTable.forEach((map) => map.clear());
  pendingLegacyNotesByTable.forEach((map) => map.clear());
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    loadNotesObject(NOTE_TABLES.main, payload[NOTE_PAYLOAD_KEYS.main] || payload.main || payload.ratioMainTable);
    loadNotesObject(NOTE_TABLES.summary, payload[NOTE_PAYLOAD_KEYS.summary] || payload.summary || payload.ratioSummaryTable);
  }
  hideDfmCellNoteBox();
  applyDfmCellNoteMarkers();
}

export function wireDfmCellNotes(options = {}) {
  const container = options.container || document.getElementById("ratioWrap");
  if (!container || container.dataset.cellNotesWired === "1") return;
  container.dataset.cellNotesWired = "1";
  if (typeof options.onChange === "function") noteChangeCallback = options.onChange;

  container.addEventListener("mouseover", (event) => {
    const cell = event.target?.closest?.("td.dfmCellNote");
    if (!cell || !container.contains(cell)) return;
    showDfmCellNotePreview(cell);
  });

  container.addEventListener("mouseout", (event) => {
    const cell = event.target?.closest?.("td.dfmCellNote");
    if (!cell || !container.contains(cell)) return;
    const related = event.relatedTarget;
    if (related && (cell.contains(related) || notesBox?.contains(related))) return;
    scheduleNotesHide();
  });
}

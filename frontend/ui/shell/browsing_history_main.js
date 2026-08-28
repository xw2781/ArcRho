import {
  getBrowsingHistoryEntries,
  normalizeBrowsingHistoryEntry,
} from "/ui/shell/browsing_history.js";
import {
  loadShellActivityHistory,
  normalizeShellActivityEntry,
} from "/ui/shell/shell_activity_history.js";
import { getWorkspaceHistoryEntries } from "/ui/shared/services/workspace_history.js?v=20260828a";
import { localDayKey } from "/ui/shared/services/local_day.js?v=20260828a";
import { attachArcrhoTooltip } from "/ui/shared/components/tooltip/tooltip.js?v=20260812a";
import "/ui/shared/integrations/zoom_bridge.js?v=20260521a";

// How far back each store is read. The stores keep one record per item per day, so this is the
// number of records, not of distinct items.
const MAX_ENTRIES = 100;
// Rows past this one all enter together; a long list should not keep the reader waiting.
const MAX_STAGGERED_ROWS = 12;
const STAGGER_MS = 22;

const kindFilter = document.getElementById("kindFilter");
const timelineEl = document.getElementById("timeline");
const emptyEl = document.getElementById("historyEmpty");
const defaultEmptyText = emptyEl?.textContent || "";
const kindButtons = Array.from(kindFilter?.querySelectorAll(".kindButton") || []);

window.ArcRhoZoomBridge?.wirePageZoomBridge();

function textOf(value) {
  return String(value || "").trim();
}

function formatTimestamp(ts) {
  const n = Number(ts || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  try {
    return new Date(n).toLocaleString();
  } catch {
    return "";
  }
}

// The row shows only the clock time; the day is the header the row sits under.
function formatTime(ts) {
  const n = Number(ts || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Day labels: "Today" and "Yesterday" carry their date beside them ("Thu, Aug 28"); older days are
// the date alone, with the year once it is not this year.
function formatDay(ts) {
  const date = new Date(Number(ts || 0));
  const now = new Date();
  const options = { weekday: "short", month: "short", day: "numeric" };
  if (date.getFullYear() !== now.getFullYear()) options.year = "numeric";
  const dateText = date.toLocaleDateString([], options);
  if (sameDay(date, now)) return { title: "Today", date: dateText };
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return { title: "Yesterday", date: dateText };
  return { title: dateText, date: "" };
}

function folderLeaf(path) {
  const trimmed = textOf(path).replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

function postToShell(payload) {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(payload, "*");
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function openDatasetEntry(entry) {
  const normalized = normalizeBrowsingHistoryEntry(entry);
  if (!normalized) return;
  if (postToShell({ type: "arcrho:open-dataset-from-history", entry: normalized })) return;
  const params = new URLSearchParams();
  params.set("project", normalized.project);
  params.set("path", normalized.path);
  params.set("tri", normalized.tri);
  window.location.href = `/ui/dataset_viewer/dataset_viewer.html?${params.toString()}`;
}

function projectInstanceDetail(entry) {
  const state = entry.projectInstanceState || {};
  const windows = Array.isArray(state.windows) ? state.windows : [];
  const parts = [textOf(state.selectedPath)];
  if (windows.length) {
    const hidden = windows.filter((item) => item.hidden).length;
    parts.push(`${windows.length} window${windows.length === 1 ? "" : "s"}${hidden ? `, ${hidden} hidden` : ""}`);
  }
  return parts;
}

// One source per page type: how its records load, and how a record is named, described, told
// apart from its neighbours, and opened. The timeline merges every source into one stream, so the
// page-type filter is the only place a source shows as a group.
const SOURCES = {
  project_instance: {
    label: "Project Instances",
    async load() {
      return (await loadShellActivityHistory()).filter((entry) => entry.tabType === "project_instance");
    },
    name: (entry) => entry.title,
    detailParts: projectInstanceDetail,
    identity: (entry) => [entry.title, entry.projectInstanceState?.selectedPath],
    open(entry) {
      const normalized = normalizeShellActivityEntry(entry);
      if (normalized) postToShell({ type: "arcrho:open-shell-activity-history-entry", entry: normalized });
    },
  },
  file_explorer: {
    label: "My Workspace Folders",
    load: () => getWorkspaceHistoryEntries({ maxEntries: MAX_ENTRIES }),
    name: (entry) => folderLeaf(entry.path),
    detailParts: (entry) => [entry.path],
    identity: (entry) => [entry.path],
    open: (entry) => postToShell({ type: "arcrho:open-file-explorer-from-history", path: entry.path }),
  },
  dataset: {
    label: "Datasets",
    load: () => getBrowsingHistoryEntries({ maxEntries: MAX_ENTRIES }),
    name: (entry) => entry.tri,
    detailParts: (entry) => [entry.project, entry.path],
    identity: (entry) => [entry.project, entry.path, entry.tri],
    open: openDatasetEntry,
  },
};

// Every record from every source, newest first. A record's key names the source, the thing it
// points at, and the moment it was opened, so a reload can tell a record it already showed from a
// new one that deserves the enter animation.
async function loadRecords() {
  const perSource = await Promise.all(Object.entries(SOURCES).map(async ([kind, source]) => {
    let raw = [];
    try {
      raw = await source.load();
    } catch {
      raw = [];
    }
    return raw.map((entry) => {
      const ts = Number(entry.ts) || 0;
      return {
        kind,
        ts,
        key: [kind, ...source.identity(entry).map(textOf), ts].join("|"),
        name: source.name(entry),
        detailParts: source.detailParts(entry),
        open: () => source.open(entry),
      };
    });
  }));
  return perSource.flat().sort((a, b) => b.ts - a.ts);
}

// Date header: ring on the spine, a caret, then the day and its date. It is a button that folds
// the day's rows away and back.
function buildDayHeader({ title: label, date }, { collapsed, rowsId }) {
  const header = document.createElement("button");
  header.type = "button";
  header.className = "dayHeader";
  header.setAttribute("aria-expanded", collapsed ? "false" : "true");
  header.setAttribute("aria-controls", rowsId);

  const time = document.createElement("span");
  time.className = "dayTime";

  const spine = document.createElement("span");
  spine.className = "spine";
  const mark = document.createElement("span");
  mark.className = "dayMark";
  spine.appendChild(mark);

  const caret = document.createElement("span");
  caret.className = "dayCaret";
  caret.setAttribute("aria-hidden", "true");
  caret.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 6h8l-4 5z" fill="currentColor"/></svg>';

  const text = document.createElement("div");
  text.className = "dayText";
  const title = document.createElement("h2");
  title.className = "dayTitle";
  title.textContent = label;
  const dateEl = document.createElement("span");
  dateEl.className = "dayDate";
  dateEl.textContent = date;
  text.append(title, dateEl);

  header.append(time, spine, caret, text);
  return header;
}

// Row: time | dot on the spine | icon | name | detail | open arrow. The six cells sit straight on
// the timeline's shared columns, which is what lines every detail up under one edge.
function buildRow(record) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "historyRow";
  row.dataset.key = record.key;

  const time = document.createElement("span");
  time.className = "rowTime";
  time.textContent = formatTime(record.ts);
  attachArcrhoTooltip(time, formatTimestamp(record.ts));

  const spine = document.createElement("span");
  spine.className = "spine";
  const tick = document.createElement("span");
  tick.className = "rowTick";
  const dot = document.createElement("span");
  dot.className = "rowDot";
  spine.append(tick, dot);

  const icon = document.createElement("span");
  icon.className = "tabTypeIcon rowIcon";
  icon.dataset.tabType = record.kind;
  icon.setAttribute("aria-hidden", "true");

  const nameEl = document.createElement("span");
  nameEl.className = "rowName";
  nameEl.textContent = record.name;
  const detail = document.createElement("span");
  detail.className = "rowDetail";
  const detailText = record.detailParts.filter(Boolean).join("  ·  ");
  detail.textContent = detailText;
  // Only a truncated detail earns a tooltip, so a short row stays quiet on hover.
  attachArcrhoTooltip(detail, () => (detail.scrollWidth > detail.clientWidth ? detailText : ""));

  const go = document.createElement("span");
  go.className = "rowGo";
  go.setAttribute("aria-hidden", "true");
  go.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';

  row.append(time, spine, icon, nameEl, detail, go);
  return row;
}

let records = [];
let recordsByKey = new Map();
let selectedKind = "all";
// Keys of the day headers and rows on the page now; anything not in here enters with motion.
let shownKeys = new Set();
// Days the user has folded away; a reload keeps them folded.
const collapsedDays = new Set();

function emptyText(shownCount) {
  if (shownCount > 0) return "";
  if (selectedKind !== "all" && records.length) return `No recent ${SOURCES[selectedKind].label}.`;
  return defaultEmptyText;
}

// Draw the timeline under the current page-type filter: one group per day, newest day first,
// each holding its date header and that day's records. Records that were not on the page a
// moment ago slide in, each a beat after the one before; records that stayed do not move.
function paint() {
  if (!timelineEl || !emptyEl) return;

  for (const button of kindButtons) {
    const kind = button.dataset.kind;
    const count = kind === "all" ? records.length : records.filter((record) => record.kind === kind).length;
    const countEl = button.querySelector(".kindCount");
    if (countEl) countEl.textContent = String(count);
  }

  const shown = selectedKind === "all" ? records : records.filter((record) => record.kind === selectedKind);
  const days = [];
  for (const record of shown) {
    const day = localDayKey(record.ts);
    const last = days[days.length - 1];
    if (last && last.day === day) last.records.push(record);
    else days.push({ day, key: `day|${day}`, label: formatDay(record.ts), records: [record] });
  }

  timelineEl.innerHTML = "";
  const nextKeys = new Set();
  let entering = 0;
  const place = (parent, element, key) => {
    nextKeys.add(key);
    if (!shownKeys.has(key)) {
      element.classList.add("isNew");
      element.style.setProperty("--enter-delay", `${Math.min(entering, MAX_STAGGERED_ROWS) * STAGGER_MS}ms`);
      element.addEventListener("animationend", () => element.classList.remove("isNew"), { once: true });
      entering += 1;
    }
    parent.appendChild(element);
  };
  days.forEach((day, index) => {
    const collapsed = collapsedDays.has(day.day);
    const group = document.createElement("section");
    group.className = "dayGroup";
    group.classList.toggle("isCollapsed", collapsed);
    group.dataset.day = day.day;
    group.setAttribute("aria-label", [day.label.title, day.label.date].filter(Boolean).join(", "));
    const rowsId = `dayRows${index}`;
    place(group, buildDayHeader(day.label, { collapsed, rowsId }), day.key);
    const rows = document.createElement("div");
    rows.className = "dayRows";
    const inner = document.createElement("div");
    inner.className = "dayRowsInner";
    inner.id = rowsId;
    inner.inert = collapsed;
    for (const record of day.records) place(inner, buildRow(record), record.key);
    rows.appendChild(inner);
    group.append(rows);
    timelineEl.appendChild(group);
  });
  shownKeys = nextKeys;

  emptyEl.hidden = shown.length > 0;
  emptyEl.textContent = emptyText(shown.length);
}

async function render() {
  records = await loadRecords();
  recordsByKey = new Map(records.map((record) => [record.key, record]));
  paint();
}

// A click on a date header folds or unfolds that day in place; a click on a row opens it.
function toggleDay(group) {
  const day = group.dataset.day || "";
  const collapsed = !group.classList.contains("isCollapsed");
  if (collapsed) collapsedDays.add(day);
  else collapsedDays.delete(day);
  group.classList.toggle("isCollapsed", collapsed);
  group.querySelector(".dayHeader")?.setAttribute("aria-expanded", collapsed ? "false" : "true");
  const inner = group.querySelector(".dayRowsInner");
  if (inner) inner.inert = collapsed;
}

timelineEl?.addEventListener("click", (e) => {
  const header = e.target?.closest?.(".dayHeader");
  if (header) {
    const group = header.closest(".dayGroup");
    if (group) toggleDay(group);
    return;
  }
  const row = e.target?.closest?.(".historyRow");
  const record = recordsByKey.get(row?.dataset.key || "");
  if (record) record.open();
});

// Arrow keys walk the visible rows, Home and End jump to the ends, so the timeline reads from
// the keyboard as one list rather than a pile of buttons. Rows of a folded day are skipped.
timelineEl?.addEventListener("keydown", (e) => {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const rows = Array.from(timelineEl.querySelectorAll(".dayGroup:not(.isCollapsed) .historyRow"));
  if (!rows.length) return;
  const current = rows.indexOf(document.activeElement);
  let next = current;
  if (e.key === "ArrowDown") next = Math.min(rows.length - 1, current + 1);
  else if (e.key === "ArrowUp") next = Math.max(0, current - 1);
  else if (e.key === "Home") next = 0;
  else next = rows.length - 1;
  e.preventDefault();
  rows[next]?.focus();
});

kindFilter?.addEventListener("click", (e) => {
  const button = e.target?.closest?.(".kindButton");
  const kind = button?.dataset.kind;
  if (!kind || kind === selectedKind) return;
  selectedKind = kind;
  for (const item of kindButtons) item.setAttribute("aria-pressed", item === button ? "true" : "false");
  paint();
});

window.addEventListener("message", (e) => {
  const type = String(e?.data?.type || "");
  if (type === "arcrho:browsing-history-updated" || type === "arcrho:tab-activated") {
    void render();
  }
});

// No reload on window focus: the first click on an unfocused page fires focus between mouse-down
// and mouse-up, and rebuilding the rows in that gap swallowed the click. The shell already tells
// the page when its tab is activated and when the history changes.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void render();
});

void render();

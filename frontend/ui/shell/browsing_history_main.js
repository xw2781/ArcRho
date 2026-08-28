import {
  getBrowsingHistoryEntries,
  normalizeBrowsingHistoryEntry,
} from "/ui/shell/browsing_history.js";
import {
  loadShellActivityHistory,
  normalizeShellActivityEntry,
} from "/ui/shell/shell_activity_history.js";
import { getWorkspaceHistoryEntries } from "/ui/shared/services/workspace_history.js?v=20260726a";
import { attachArcrhoTooltip } from "/ui/shared/components/tooltip/tooltip.js?v=20260812a";
import "/ui/shared/integrations/zoom_bridge.js?v=20260521a";

const MAX_ENTRIES = 15;

const filterInput = document.getElementById("filterInput");

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

// Short, scannable time: "Today, 8:15 PM", "Yesterday, 12:57 PM", "Aug 18, 12:57 PM". The full
// local timestamp stays available in the tooltip.
function formatWhen(ts) {
  const n = Number(ts || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  const date = new Date(n);
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, now)) return `Today, ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `Yesterday, ${time}`;
  const dateOptions = { month: "short", day: "numeric" };
  if (date.getFullYear() !== now.getFullYear()) dateOptions.year = "numeric";
  return `${date.toLocaleDateString([], dateOptions)}, ${time}`;
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

// Shared row: icon | name and detail | time.
function buildRow({ tabType, name, detailParts, ts, index }) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "historyRow";
  row.dataset.index = String(index);

  const icon = document.createElement("span");
  icon.className = "tabTypeIcon rowIcon";
  icon.dataset.tabType = tabType;
  icon.setAttribute("aria-hidden", "true");

  const text = document.createElement("div");
  text.className = "rowText";
  const nameEl = document.createElement("span");
  nameEl.className = "rowName";
  nameEl.textContent = name;
  const detail = document.createElement("span");
  detail.className = "rowDetail";
  const detailText = detailParts.filter(Boolean).join("  ·  ");
  detail.textContent = detailText;
  // Only a truncated detail earns a tooltip, so a short row stays quiet on hover.
  attachArcrhoTooltip(detail, () => (detail.scrollWidth > detail.clientWidth ? detailText : ""));
  text.append(nameEl, detail);

  const time = document.createElement("span");
  time.className = "rowTime";
  time.textContent = formatWhen(ts);
  attachArcrhoTooltip(time, formatTimestamp(ts));

  row.append(icon, text, time);
  return row;
}

// One descriptor per group: where it renders, how its entries load, and how a row looks, reads,
// filters, and opens.
const GROUPS = [
  {
    listId: "projectInstanceList",
    emptyId: "projectInstanceEmpty",
    countId: "projectInstanceCount",
    entries: [],
    async load() {
      try {
        return (await loadShellActivityHistory()).filter((entry) => entry.tabType === "project_instance");
      } catch {
        return [];
      }
    },
    searchText: (entry) => [entry.title, entry.projectInstanceState?.selectedPath],
    build: (entry, index) => buildRow({
      tabType: "project_instance",
      name: entry.title,
      detailParts: projectInstanceDetail(entry),
      ts: entry.ts,
      index,
    }),
    open(entry) {
      const normalized = normalizeShellActivityEntry(entry);
      if (normalized) postToShell({ type: "arcrho:open-shell-activity-history-entry", entry: normalized });
    },
  },
  {
    listId: "workspaceList",
    emptyId: "workspaceEmpty",
    countId: "workspaceCount",
    entries: [],
    load: () => getWorkspaceHistoryEntries({ maxEntries: MAX_ENTRIES }),
    searchText: (entry) => [entry.path],
    build: (entry, index) => buildRow({
      tabType: "file_explorer",
      name: folderLeaf(entry.path),
      detailParts: [entry.path],
      ts: entry.ts,
      index,
    }),
    open: (entry) => postToShell({ type: "arcrho:open-file-explorer-from-history", path: entry.path }),
  },
  {
    listId: "historyList",
    emptyId: "historyEmpty",
    countId: "historyCount",
    entries: [],
    load: () => getBrowsingHistoryEntries({ maxEntries: MAX_ENTRIES }),
    searchText: (entry) => [entry.tri, entry.project, entry.path],
    build: (entry, index) => buildRow({
      tabType: "dataset",
      name: entry.tri,
      detailParts: [entry.project, entry.path],
      ts: entry.ts,
      index,
    }),
    open: openDatasetEntry,
  },
];

for (const group of GROUPS) {
  group.listEl = document.getElementById(group.listId);
  group.emptyEl = document.getElementById(group.emptyId);
  group.countEl = document.getElementById(group.countId);
  group.defaultEmptyText = group.emptyEl?.textContent || "";
  group.listEl?.addEventListener("click", (e) => {
    const row = e.target?.closest?.(".historyRow");
    const entry = group.entries[Number(row?.dataset.index ?? -1)];
    if (entry) group.open(entry);
  });
}

function matches(group, entry, query) {
  if (!query) return true;
  return group.searchText(entry).some((text) => textOf(text).toLowerCase().includes(query));
}

// Draw every group from its loaded entries under the current filter. Row indexes point back into
// the unfiltered list so a click resolves the same entry whatever the filter hides.
function paint() {
  const rawQuery = textOf(filterInput?.value);
  const query = rawQuery.toLowerCase();
  for (const group of GROUPS) {
    if (!group.listEl || !group.emptyEl) continue;
    group.listEl.innerHTML = "";
    let shown = 0;
    group.entries.forEach((entry, index) => {
      if (!matches(group, entry, query)) return;
      group.listEl.appendChild(group.build(entry, index));
      shown += 1;
    });
    if (group.countEl) group.countEl.textContent = query ? `${shown} of ${group.entries.length}` : String(group.entries.length);
    group.emptyEl.hidden = shown > 0;
    group.emptyEl.textContent = query && group.entries.length ? `No matches for "${rawQuery}".` : group.defaultEmptyText;
  }
}

async function render() {
  await Promise.all(GROUPS.map(async (group) => {
    group.entries = await group.load();
  }));
  paint();
}

filterInput?.addEventListener("input", paint);
filterInput?.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !filterInput.value) return;
  filterInput.value = "";
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

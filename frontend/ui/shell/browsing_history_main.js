import {
  getBrowsingHistoryEntries,
  normalizeBrowsingHistoryEntry,
} from "/ui/shell/browsing_history.js";
import {
  buildRestoreSummary,
  loadShellActivityHistory,
  normalizeShellActivityEntry,
} from "/ui/shell/shell_activity_history.js";
import { getWorkspaceHistoryEntries } from "/ui/shared/services/workspace_history.js?v=20260726a";
import "/ui/shared/integrations/zoom_bridge.js?v=20260521a";

const MAX_ENTRIES = 15;

const projectInstanceListEl = document.getElementById("projectInstanceList");
const projectInstanceEmptyEl = document.getElementById("projectInstanceEmpty");
const workspaceListEl = document.getElementById("workspaceList");
const workspaceEmptyEl = document.getElementById("workspaceEmpty");
const listEl = document.getElementById("historyList");
const emptyEl = document.getElementById("historyEmpty");
let shellActivityEntries = [];
let workspaceEntries = [];

window.ArcRhoZoomBridge?.wirePageZoomBridge();

function formatTimestamp(ts) {
  const n = Number(ts || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  try {
    return new Date(n).toLocaleString();
  } catch {
    return "";
  }
}

function postOpenDataset(entry) {
  const payload = { type: "arcrho:open-dataset-from-history", entry };
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

function postOpenActivity(entry) {
  const payload = { type: "arcrho:open-shell-activity-history-entry", entry };
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

function postOpenWorkspacePath(path) {
  try { window.parent?.postMessage({ type: "arcrho:open-file-explorer-from-history", path }, "*"); } catch {}
}

function openEntry(entry) {
  const normalized = normalizeBrowsingHistoryEntry(entry);
  if (!normalized) return;

  if (postOpenDataset(normalized)) return;

  const params = new URLSearchParams();
  params.set("project", normalized.project);
  params.set("path", normalized.path);
  params.set("tri", normalized.tri);
  window.location.href = `/ui/dataset_viewer/dataset_viewer.html?${params.toString()}`;
}

function buildRow(entry, index) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "historyRow";
  row.dataset.historyIndex = String(index);
  row.title = `${entry.project} | ${entry.path} | ${entry.tri}`;

  const lineTop = document.createElement("div");
  lineTop.className = "lineTop";

  const projectEl = document.createElement("div");
  projectEl.className = "project";
  projectEl.textContent = entry.project;

  const triEl = document.createElement("div");
  triEl.className = "dataset";
  triEl.textContent = entry.tri;

  lineTop.appendChild(projectEl);
  lineTop.appendChild(triEl);

  const pathEl = document.createElement("div");
  pathEl.className = "path";
  pathEl.textContent = entry.path;

  const timeEl = document.createElement("div");
  timeEl.className = "time";
  timeEl.textContent = formatTimestamp(entry.ts);

  row.appendChild(lineTop);
  row.appendChild(pathEl);
  row.appendChild(timeEl);
  return row;
}

function formatActivityType(tabType) {
  const type = String(tabType || "").trim();
  const labels = {
    dataset: "Dataset",
    dfm: "DFM",
    workflow: "Workflow",
    project_settings: "Project Explorer",
    project_instance: "Project Instance",
    scripting: "Scripting",
    agent_guide: "Agent Guide",
    file_explorer: "File Explorer",
  };
  return labels[type] || type || "Page";
}

function buildActivityRow(entry, index) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "historyRow";
  row.dataset.activityIndex = String(index);
  row.title = `${formatActivityType(entry.tabType)} | ${entry.title}`;

  const lineTop = document.createElement("div");
  lineTop.className = "lineTop";

  const projectEl = document.createElement("div");
  projectEl.className = "project";
  projectEl.textContent = entry.title;

  const typeEl = document.createElement("div");
  typeEl.className = "dataset";
  typeEl.textContent = formatActivityType(entry.tabType);

  lineTop.append(projectEl, typeEl);

  const summary = document.createElement("div");
  summary.className = "path";
  summary.textContent = buildRestoreSummary(entry) || "Open page";

  const badges = document.createElement("div");
  badges.className = "badgeLine";
  if (entry.tabType === "project_instance") {
    const windows = Array.isArray(entry.projectInstanceState?.windows) ? entry.projectInstanceState.windows : [];
    if (windows.length) {
      const nested = document.createElement("span");
      nested.className = "badge";
      nested.textContent = `${windows.length} nested`;
      badges.appendChild(nested);
      const hiddenCount = windows.filter((item) => item.hidden).length;
      if (hiddenCount) {
        const hidden = document.createElement("span");
        hidden.className = "badge";
        hidden.textContent = `${hiddenCount} hidden`;
        badges.appendChild(hidden);
      }
      const dfmCount = windows.filter((item) => item.kind === "dfm").length;
      if (dfmCount) {
        const dfm = document.createElement("span");
        dfm.className = "badge";
        dfm.textContent = `${dfmCount} DFM`;
        badges.appendChild(dfm);
      }
    }
  }

  const timeEl = document.createElement("div");
  timeEl.className = "time";
  timeEl.textContent = formatTimestamp(entry.ts);

  row.appendChild(lineTop);
  row.appendChild(summary);
  if (badges.childElementCount) row.appendChild(badges);
  row.appendChild(timeEl);
  return row;
}

function buildWorkspaceRow(entry, index) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "historyRow";
  row.dataset.workspaceIndex = String(index);
  row.title = entry.path;
  const label = document.createElement("div");
  label.className = "project";
  label.textContent = "My Workspace";
  const path = document.createElement("div");
  path.className = "path";
  path.textContent = entry.path;
  const time = document.createElement("div");
  time.className = "time";
  time.textContent = formatTimestamp(entry.ts);
  row.append(label, path, time);
  return row;
}

async function render() {
  if (!listEl || !emptyEl) return;

  if (projectInstanceListEl && projectInstanceEmptyEl) {
    projectInstanceListEl.innerHTML = "";
    try {
      shellActivityEntries = (await loadShellActivityHistory()).filter((entry) => entry.tabType === "project_instance");
    } catch {
      shellActivityEntries = [];
    }
    if (!shellActivityEntries.length) {
      projectInstanceEmptyEl.style.display = "block";
    } else {
      projectInstanceEmptyEl.style.display = "none";
      shellActivityEntries.forEach((entry, idx) => {
        projectInstanceListEl.appendChild(buildActivityRow(entry, idx));
      });
    }
  }

  if (workspaceListEl && workspaceEmptyEl) {
    workspaceEntries = getWorkspaceHistoryEntries({ maxEntries: MAX_ENTRIES });
    workspaceListEl.innerHTML = "";
    workspaceEmptyEl.style.display = workspaceEntries.length ? "none" : "block";
    workspaceEntries.forEach((entry, index) => workspaceListEl.appendChild(buildWorkspaceRow(entry, index)));
  }

  const entries = getBrowsingHistoryEntries({ maxEntries: MAX_ENTRIES });
  listEl.innerHTML = "";

  if (!entries.length) {
    emptyEl.style.display = "block";
    return;
  }

  emptyEl.style.display = "none";
  entries.forEach((entry, idx) => {
    listEl.appendChild(buildRow(entry, idx));
  });
}

projectInstanceListEl?.addEventListener("click", (e) => {
  const row = e.target?.closest?.(".historyRow[data-activity-index]");
  if (!row) return;
  const idx = Number(row.dataset.activityIndex || -1);
  if (!Number.isFinite(idx) || idx < 0) return;
  const entry = normalizeShellActivityEntry(shellActivityEntries[idx] || null);
  if (!entry) return;
  postOpenActivity(entry);
});

workspaceListEl?.addEventListener("click", (e) => {
  const row = e.target?.closest?.(".historyRow[data-workspace-index]");
  const entry = workspaceEntries[Number(row?.dataset.workspaceIndex || -1)];
  if (entry) postOpenWorkspacePath(entry.path);
});

listEl?.addEventListener("click", (e) => {
  const row = e.target?.closest?.(".historyRow");
  if (!row) return;
  const idx = Number(row.dataset.historyIndex || -1);
  if (!Number.isFinite(idx) || idx < 0) return;
  const entry = getBrowsingHistoryEntries({ maxEntries: MAX_ENTRIES })[idx];
  if (!entry) return;
  openEntry(entry);
});

window.addEventListener("message", (e) => {
  const type = String(e?.data?.type || "");
  if (type === "arcrho:browsing-history-updated" || type === "arcrho:tab-activated") {
    void render();
  }
});

window.addEventListener("focus", () => void render());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void render();
});

void render();

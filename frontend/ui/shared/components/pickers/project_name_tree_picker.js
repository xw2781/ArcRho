import { openFloatingPathTreePicker } from "/ui/shared/components/pickers/path_tree_picker.js";
import { buildWorkflowProjectRootNode } from "/ui/shared/integrations/workflow_picker_options.js";

const DEFAULT_SOURCE = "project_map";
const LOCAL_PROJECT_PREFS_ENDPOINT = "/local-project/preferences";
const PROJECT_NODE_MENU_STYLE_ID = "arcrho-project-name-node-menu-style";
let PROJECT_TREE_CACHE = null;
let activeProjectNodeMenu = null;

function toText(value) {
  return String(value || "").trim();
}

function normalizeNameKey(value) {
  return toText(value).replace(/\s+/g, " ").toLowerCase();
}

function splitTreePath(rawPath) {
  return String(rawPath || "")
    .replace(/\//g, "\\")
    .split("\\")
    .map((part) => toText(part))
    .filter(Boolean);
}

function normalizeTreePath(rawPath) {
  return splitTreePath(rawPath).join("\\");
}

function joinTreePath(folderPath, name) {
  const folder = normalizeTreePath(folderPath);
  const leaf = toText(name);
  if (!leaf) return "";
  return folder ? `${folder}\\${leaf}` : leaf;
}

function splitProjectTreePath(fullPath) {
  const normalized = normalizeTreePath(fullPath);
  if (!normalized) return { folderPath: "", projectName: "" };
  const parts = normalized.split("\\");
  const projectName = parts[parts.length - 1] || "";
  const folderPath = parts.length > 1 ? parts.slice(0, -1).join("\\") : "";
  return { folderPath, projectName };
}

function resolveProjectNameFromNode(path, node) {
  return toText(node?.selectValue)
    || toText(node?.select_value)
    || toText(node?.projectName)
    || toText(node?.project_name)
    || toText(node?.value)
    || toText(node?.name)
    || toText(splitProjectTreePath(path).projectName);
}

function positionPickerBelowAnchor(doc, pickerEl, anchorEl) {
  if (!doc || !pickerEl || !anchorEl || typeof anchorEl.getBoundingClientRect !== "function") return;
  const view = doc.defaultView || window;
  const viewportW = Number(view?.innerWidth || doc.documentElement?.clientWidth || 0);
  const viewportH = Number(view?.innerHeight || doc.documentElement?.clientHeight || 0);
  const margin = 8;
  const gap = 8;
  const anchorRect = anchorEl.getBoundingClientRect();
  const pickerRect = pickerEl.getBoundingClientRect();

  let left = Number(anchorRect?.left || 0);
  if (left + pickerRect.width > viewportW - margin) {
    left = Math.max(margin, viewportW - pickerRect.width - margin);
  }
  left = Math.max(margin, left);

  // Always keep the picker below the input box and avoid covering it.
  const top = Math.max(margin, Number(anchorRect?.bottom || 0) + gap);
  const availableBelow = Math.max(120, viewportH - top - margin);
  pickerEl.style.maxHeight = `${availableBelow}px`;

  pickerEl.style.left = `${left}px`;
  pickerEl.style.top = `${top}px`;
  pickerEl.style.transform = "none";
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

function ensureProjectNodeMenuStyles(doc) {
  if (!doc || doc.getElementById(PROJECT_NODE_MENU_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = PROJECT_NODE_MENU_STYLE_ID;
  style.textContent = `
    .pnctx-menu {
      position: fixed;
      min-width: 176px;
      max-width: min(300px, 86vw);
      background: #fff;
      border: 1px solid #cfcfcf;
      border-radius: 8px;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.2);
      z-index: 5450;
      padding: 4px;
    }
    .pnctx-item {
      width: 100%;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: #222;
      font-size: 12px;
      text-align: left;
      padding: 6px 9px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .pnctx-item:hover {
      background: #eef3ff;
    }
    .pnctx-item:disabled {
      color: #9a9a9a;
      cursor: not-allowed;
    }
    .pnctx-item:disabled:hover {
      background: transparent;
    }
  `;
  doc.head.appendChild(style);
}

function closeProjectNodeMenu(reason = "programmatic") {
  if (!activeProjectNodeMenu) return;
  const { doc, menu, onMouseDown, onEsc, onContextMenu } = activeProjectNodeMenu;
  if (doc && onMouseDown) doc.removeEventListener("mousedown", onMouseDown, true);
  if (doc && onEsc) doc.removeEventListener("keydown", onEsc, true);
  if (doc && onContextMenu) doc.removeEventListener("contextmenu", onContextMenu, true);
  if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
  activeProjectNodeMenu = null;
}

function openProjectNodeMenu(options = {}) {
  const doc = options?.document || window.document;
  ensureProjectNodeMenuStyles(doc);
  closeProjectNodeMenu("replaced");

  const xIn = Number(options?.x);
  const yIn = Number(options?.y);
  const x = Number.isFinite(xIn) ? xIn : 0;
  const y = Number.isFinite(yIn) ? yIn : 0;
  const projectName = toText(options?.projectName);
  const canCopy = !!projectName && typeof options?.onCopy === "function";

  const menu = doc.createElement("div");
  menu.className = "pnctx-menu";

  const item = doc.createElement("button");
  item.type = "button";
  item.className = "pnctx-item";
  item.textContent = "Copy Project Name";
  item.title = item.textContent;
  item.disabled = !canCopy;
  item.addEventListener("click", (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    if (item.disabled) return;
    closeProjectNodeMenu("item_click");
    try { options.onCopy(); } catch {}
  });
  menu.appendChild(item);

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
    closeProjectNodeMenu("outside_click");
  };
  const onEsc = (evt) => {
    if (evt.key !== "Escape") return;
    evt.preventDefault();
    evt.stopPropagation();
    closeProjectNodeMenu("escape");
  };
  const onContextMenu = (evt) => {
    if (menu.contains(evt.target)) return;
    closeProjectNodeMenu("outside_contextmenu");
  };

  doc.addEventListener("mousedown", onMouseDown, true);
  doc.addEventListener("keydown", onEsc, true);
  doc.addEventListener("contextmenu", onContextMenu, true);

  activeProjectNodeMenu = {
    doc,
    menu,
    onMouseDown,
    onEsc,
    onContextMenu,
  };
}

async function fetchProjectNames() {
  const resp = await fetch("/arcrho/projects");
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(detail || `Failed to load projects (${resp.status}).`);
  }
  const out = await resp.json().catch(() => ({}));
  return Array.isArray(out?.projects) ? out.projects : [];
}

async function fetchProjectPaths(source = DEFAULT_SOURCE) {
  const resp = await fetch(`/project_settings/${encodeURIComponent(source)}/folders`);
  if (!resp.ok) return [];
  const out = await resp.json().catch(() => ({}));
  return Array.isArray(out?.project_paths) ? out.project_paths : [];
}

function normalizeLocalProjectPreference(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const projectName = toText(source.projectName || source.project_name || source.project);
  const recentRaw = source.recentProjectNames
    || source.recent_project_names
    || source.recentProjects
    || source.recent_projects
    || [];
  const recentProjectNames = [];
  const seen = new Set();
  for (const item of Array.isArray(recentRaw) ? recentRaw : []) {
    const name = toText(item);
    const key = normalizeNameKey(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    recentProjectNames.push(name);
    if (recentProjectNames.length >= 3) break;
  }
  return { projectName, recentProjectNames };
}

async function fetchLocalProjectPreference() {
  try {
    const resp = await fetch(LOCAL_PROJECT_PREFS_ENDPOINT, { cache: "no-store" });
    if (!resp.ok) return { projectName: "", recentProjectNames: [] };
    const payload = await resp.json().catch(() => ({}));
    return normalizeLocalProjectPreference(payload?.preferences || payload);
  } catch {
    return { projectName: "", recentProjectNames: [] };
  }
}

function mergeRecentProjectNames(projectName, recentProjectNames) {
  const out = [];
  const seen = new Set();
  for (const item of [projectName, ...(Array.isArray(recentProjectNames) ? recentProjectNames : [])]) {
    const name = toText(item);
    const key = normalizeNameKey(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= 3) break;
  }
  return out;
}

async function saveLocalProjectPreference(projectName, currentPreference = null) {
  const project = toText(projectName);
  if (!project) return null;
  const pref = currentPreference || await fetchLocalProjectPreference();
  const recentProjectNames = mergeRecentProjectNames(project, pref?.recentProjectNames);
  const resp = await fetch(LOCAL_PROJECT_PREFS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectName: project,
      recentProjectNames,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!resp.ok) throw new Error(`Failed to update local project preferences (${resp.status}).`);
  const payload = await resp.json().catch(() => ({}));
  return normalizeLocalProjectPreference(payload?.preferences || payload);
}

function buildProjectEntries(projectNames, projectPaths) {
  const byName = new Map();
  for (const rawPath of Array.isArray(projectPaths) ? projectPaths : []) {
    const parsed = splitProjectTreePath(rawPath);
    const projectName = toText(parsed.projectName);
    if (!projectName) continue;
    const key = normalizeNameKey(projectName);
    if (byName.has(key)) continue;
    const folderPath = toText(parsed.folderPath) || "Uncategorized";
    byName.set(key, {
      projectName,
      folderPath,
      fullPath: joinTreePath(folderPath, projectName),
    });
  }

  const seen = new Set();
  const entries = [];
  for (const rawName of Array.isArray(projectNames) ? projectNames : []) {
    const projectName = toText(rawName);
    if (!projectName) continue;
    const key = normalizeNameKey(projectName);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const mapped = byName.get(key);
    const folderPath = toText(mapped?.folderPath) || "Uncategorized";
    entries.push({
      projectName,
      folderPath,
      fullPath: joinTreePath(folderPath, projectName),
    });
  }

  entries.sort((a, b) =>
    String(a.fullPath || "").localeCompare(String(b.fullPath || ""), undefined, {
      sensitivity: "base",
      numeric: true,
    }),
  );
  return entries;
}

function createFolderNode(name, fullPath) {
  return {
    name,
    fullPath,
    folders: new Map(),
    projects: [],
  };
}

function buildProjectTreeNodes(entries) {
  const root = createFolderNode("", "");

  for (const entry of Array.isArray(entries) ? entries : []) {
    const projectName = toText(entry?.projectName);
    if (!projectName) continue;
    const folderParts = splitTreePath(entry?.folderPath || "Uncategorized");
    let current = root;
    let accPath = "";
    for (const part of folderParts) {
      accPath = accPath ? `${accPath}\\${part}` : part;
      const key = part.toLowerCase();
      if (!current.folders.has(key)) {
        current.folders.set(key, createFolderNode(part, accPath));
      }
      current = current.folders.get(key);
    }
    current.projects.push({
      name: projectName,
      fullPath: joinTreePath(accPath, projectName),
    });
  }

  const toPickerChildren = (folderNode) => {
    const children = [];

    const foldersSorted = Array.from(folderNode.folders.values()).sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), undefined, {
        sensitivity: "base",
        numeric: true,
      }),
    );
    for (const folder of foldersSorted) {
      const folderKids = toPickerChildren(folder);
      children.push({
        name: folder.name,
        path: folder.fullPath,
        level_label: "Folder",
        value_type: "folder",
        has_children: folderKids.length > 0,
        children: folderKids,
      });
    }

    const projectsSorted = Array.from(folderNode.projects.values()).sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), undefined, {
        sensitivity: "base",
        numeric: true,
      }),
    );
    for (const project of projectsSorted) {
      children.push({
        name: project.name,
        path: project.fullPath,
        level_label: "Project",
        has_children: false,
      });
    }

    return children;
  };

  return toPickerChildren(root);
}

function buildRecentProjectNode(preference, fullPathByProject) {
  const storedRecent = Array.isArray(preference?.recentProjectNames) ? preference.recentProjectNames : [];
  const recentNames = storedRecent.length ? storedRecent : [preference?.projectName];
  const children = [];
  const seen = new Set();
  for (const recentName of recentNames) {
    const key = normalizeNameKey(recentName);
    const fullPath = fullPathByProject.get(key);
    if (!key || !fullPath || seen.has(key)) continue;
    seen.add(key);
    children.push({
      name: recentName,
      path: fullPath,
      level_label: "Project",
      has_children: false,
    });
    if (children.length >= 3) break;
  }
  if (!children.length) return null;
  return {
    name: "Recent Projects",
    path: "__virtual_recent_projects",
    level_label: "Recent",
    value_type: "recent-folder",
    has_children: true,
    children,
  };
}

async function loadProjectTreeData(options = {}) {
  const forceReload = !!options?.forceReload;
  const source = toText(options?.source || DEFAULT_SOURCE) || DEFAULT_SOURCE;
  if (!forceReload && PROJECT_TREE_CACHE && PROJECT_TREE_CACHE.source === source) {
    const preference = await fetchLocalProjectPreference();
    const recentNode = buildRecentProjectNode(preference, PROJECT_TREE_CACHE.fullPathByProject);
    return {
      ...PROJECT_TREE_CACHE,
      preference,
      rootNodes: recentNode
        ? [recentNode, ...PROJECT_TREE_CACHE.realRootNodes]
        : PROJECT_TREE_CACHE.realRootNodes,
    };
  }

  const [projectNames, projectPaths, preference] = await Promise.all([
    fetchProjectNames(),
    fetchProjectPaths(source),
    fetchLocalProjectPreference(),
  ]);

  const entries = buildProjectEntries(projectNames, projectPaths);
  const fullPathByProject = new Map();
  for (const entry of entries) {
    fullPathByProject.set(normalizeNameKey(entry.projectName), entry.fullPath);
  }

  const realRootNodes = buildProjectTreeNodes(entries);
  const recentNode = buildRecentProjectNode(preference, fullPathByProject);
  const data = {
    source,
    entries,
    realRootNodes,
    rootNodes: recentNode ? [recentNode, ...realRootNodes] : realRootNodes,
    fullPathByProject,
    preference,
  };
  PROJECT_TREE_CACHE = data;
  return data;
}

export function clearProjectNameTreeCache() {
  PROJECT_TREE_CACHE = null;
  closeProjectNodeMenu("clear_cache");
}

export async function openProjectNameTreePicker(options = {}) {
  const setStatus = typeof options?.setStatus === "function" ? options.setStatus : () => {};
  const source = toText(options?.source || DEFAULT_SOURCE) || DEFAULT_SOURCE;
  const title = toText(options?.title) || "Select a Project";
  const initialProject = toText(options?.initialProject);
  const onSelect = typeof options?.onSelect === "function" ? options.onSelect : null;
  const onClose = typeof options?.onClose === "function" ? options.onClose : null;
  const onError = typeof options?.onError === "function" ? options.onError : null;
  const forceReload = !!options?.forceReload;
  const doc = options?.document || window.document;
  const anchorElement = options?.anchorElement || null;

  closeProjectNodeMenu("reopen");

  try {
    const data = await loadProjectTreeData({ source, forceReload });
    const baseRootNodes = Array.isArray(data?.rootNodes) ? data.rootNodes : [];
    const workflowRootNode = buildWorkflowProjectRootNode(options, data?.fullPathByProject);
    const rootNodes = workflowRootNode ? [workflowRootNode, ...baseRootNodes] : baseRootNodes;
    if (!rootNodes.length) {
      setStatus("No projects available.");
      return { ok: false, reason: "empty" };
    }

    const initialPath = toText(options?.initialPath)
      || data.fullPathByProject.get(normalizeNameKey(initialProject))
      || "";

    const picker = openFloatingPathTreePicker({
      title,
      titleIcon: "none",
      rootNodes,
      initialPath,
      defaultExpandedDepth: Number.isInteger(options?.defaultExpandedDepth)
        ? Number(options.defaultExpandedDepth)
        : 1,
      selectOnDoubleClick: !!options?.selectOnDoubleClick,
      allowBranchSelect: false,
      onNodeContextMenu: (node, ctx) => {
        const hasChildren = (Array.isArray(node?.children) && node.children.length > 0)
          || Boolean(node?.hasChildren)
          || Boolean(node?.has_children);
        if (hasChildren) return;

        const projectName = resolveProjectNameFromNode(node?.path, node);
        if (!projectName) return;
        const event = ctx?.event;
        openProjectNodeMenu({
          document: doc,
          x: Number(event?.clientX),
          y: Number(event?.clientY),
          projectName,
          onCopy: () => {
            void (async () => {
              const ok = await copyTextToClipboard(projectName, doc);
              if (!ok) {
                setStatus("Failed to copy project name.");
                return;
              }
              setStatus(`Copied project name: ${projectName}`);
            })();
          },
        });
      },
      onSelect: async (path, node) => {
        closeProjectNodeMenu("selected");
        const projectName = resolveProjectNameFromNode(path, node);
        if (!projectName || !onSelect) return;
        try {
          const savedPreference = await saveLocalProjectPreference(projectName, data?.preference);
          data.preference = savedPreference || data.preference;
          if (PROJECT_TREE_CACHE && PROJECT_TREE_CACHE.source === source) {
            PROJECT_TREE_CACHE.preference = data.preference;
          }
        } catch (err) {
          console.error("Failed to update recent project preference:", err);
          setStatus("Selected project, but recent project preference was not updated.");
        }
        onSelect(projectName, path, node);
      },
      onClose: (reason) => {
        closeProjectNodeMenu(reason || "picker_closed");
        if (onClose) onClose(reason);
      },
      document: doc,
    });

    if (picker?.element && anchorElement) {
      positionPickerBelowAnchor(doc, picker.element, anchorElement);
    }

    return { ok: true, picker };
  } catch (err) {
    if (onError) onError(err);
    else setStatus("Failed to load project tree.");
    return { ok: false, reason: "error", error: err };
  }
}

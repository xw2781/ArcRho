/**
 * Project Settings - Project Explorer tree
 *
 * Renders the folder/project tree, owns its view state (expanded folders and
 * the remembered selection) and the drag-and-drop gestures. All persistence
 * here is view state only; the project map document itself is owned by
 * `project_settings_project_map.js`.
 */
import {
  normalizeTreePath,
} from "/ui/project_settings/project_settings_project_map.js?v=20260807idx1";

const EXPANDED_FOLDERS_SESSION_KEY = "arcrho_project_settings_expanded_folders_v1";
const SELECTED_PROJECT_SESSION_KEY = "arcrho_project_settings_selected_project_v1";
const LOCAL_PROJECT_PREFS_ENDPOINT = "/local-project/preferences";
const PREF_SAVE_DEBOUNCE_MS = 400;

const FOLDER_CLOSED_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;
const FOLDER_OPEN_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg>`;
const FOLDER_ARROW_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/></svg>`;
const PROJECT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>`;
const OPEN_IN_TAB_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-2"/><path d="M13 4h7v7"/><path d="M11 13l9-9"/></svg>`;

/** Nest flat `"A\\B"` folder keys into a renderable node tree. */
function buildHierarchy(flatFolders) {
  const root = {};

  for (const [folderPath, data] of Object.entries(flatFolders)) {
    const parts = folderPath.split("\\");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!current[part]) {
        current[part] = {
          _name: part,
          _fullPath: parts.slice(0, i + 1).join("\\"),
          _children: {},
          _projects: []
        };
      }
      if (i === parts.length - 1) {
        // Leaf folder - add projects
        current[part]._projects = data.projects;
      }
      current = current[part]._children;
    }
  }

  return objectToArray(root);
}

function objectToArray(obj) {
  return Object.values(obj).map(node => ({
    name: node._name,
    fullPath: node._fullPath,
    projects: node._projects || [],
    children: objectToArray(node._children)
  }));
}

function countFolderProjects(node) {
  let count = node.projects.length;
  for (const child of node.children) {
    count += countFolderProjects(child);
  }
  return count;
}

/**
 * @param {object} deps
 * @param {HTMLElement} deps.treeContent
 * @param {Function} deps.fetchImpl
 * @param {Function} deps.getTreeData
 * @param {Function} deps.getSelectedProject
 * @param {Function} deps.selectProject
 * @param {Function} deps.openProjectInNewTab
 * @param {Function} deps.openProjectInstanceTab
 * @param {Function} deps.moveProjectToFolder
 * @param {Function} deps.moveFolderToFolder
 * @param {Function} deps.showProjectContextMenu  `(project, x, y)`
 * @param {Function} deps.showFolderContextMenu   `(folderNode, x, y)`
 */
export function createTreeViewFeature(deps) {
  const {
    treeContent,
    fetchImpl,
    getTreeData,
    getSelectedProject,
    selectProject,
    openProjectInNewTab,
    openProjectInstanceTab,
    moveProjectToFolder,
    moveFolderToFolder,
    showProjectContextMenu,
    showFolderContextMenu,
  } = deps;

  let expandedFolders = new Set();
  let draggedProject = null;
  let draggedFolder = null;
  let preferenceSaveTimer = 0;
  let preferencesLoaded = false;

  // ---- Expanded-folder view state ----

  function getExpandedFoldersSnapshot() {
    return Array.from(expandedFolders)
      .map(normalizeTreePath)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
  }

  function saveExpandedFoldersToSession() {
    try {
      sessionStorage.setItem(EXPANDED_FOLDERS_SESSION_KEY, JSON.stringify(getExpandedFoldersSnapshot()));
    } catch {}
  }

  function loadExpandedFoldersFromSession() {
    try {
      const raw = sessionStorage.getItem(EXPANDED_FOLDERS_SESSION_KEY);
      if (raw == null) return false;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return false;
      expandedFolders = new Set(parsed.map(normalizeTreePath).filter(Boolean));
      return true;
    } catch {
      return false;
    }
  }

  function normalizeExpandedFolderList(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const item of raw) {
      const path = normalizeTreePath(item);
      const key = path.toLowerCase();
      if (!path || seen.has(key)) continue;
      seen.add(key);
      out.push(path);
    }
    return out;
  }

  async function loadExpandedFoldersFromLocalPreferences() {
    try {
      const res = await fetchImpl(LOCAL_PROJECT_PREFS_ENDPOINT, { cache: "no-store" });
      if (!res.ok) return false;
      const payload = await res.json().catch(() => ({}));
      const prefs = payload?.preferences || payload || {};
      const explorerPrefs = prefs?.projectExplorer || prefs?.project_explorer || {};
      const folders = normalizeExpandedFolderList(explorerPrefs?.expandedFolders || explorerPrefs?.expanded_folders || []);
      if (!folders.length && !Array.isArray(explorerPrefs?.expandedFolders) && !Array.isArray(explorerPrefs?.expanded_folders)) {
        return false;
      }
      expandedFolders = new Set(folders);
      saveExpandedFoldersToSession();
      return true;
    } catch (err) {
      console.warn("Failed to load project explorer preferences:", err);
      return false;
    }
  }

  async function saveExpandedFoldersToLocalPreferences() {
    const folders = getExpandedFoldersSnapshot();
    try {
      const res = await fetchImpl(LOCAL_PROJECT_PREFS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectExplorer: {
            expandedFolders: folders,
          },
          updated_at: new Date().toISOString(),
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(detail || `HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn("Failed to save project explorer preferences:", err);
    }
  }

  function persistExpandedFolders(options = {}) {
    saveExpandedFoldersToSession();
    if (!preferencesLoaded) return;
    if (preferenceSaveTimer) {
      window.clearTimeout(preferenceSaveTimer);
      preferenceSaveTimer = 0;
    }
    if (options?.immediate) {
      void saveExpandedFoldersToLocalPreferences();
      return;
    }
    preferenceSaveTimer = window.setTimeout(() => {
      preferenceSaveTimer = 0;
      void saveExpandedFoldersToLocalPreferences();
    }, PREF_SAVE_DEBOUNCE_MS);
  }

  /** Drop expanded paths that no longer exist and re-canonicalize the rest. */
  function syncExpandedFoldersWithTreeData() {
    const treeData = getTreeData();
    if (!treeData || typeof treeData !== "object") return;

    const validPathMap = new Map();
    for (const folderPath of Object.keys(treeData)) {
      const normalized = normalizeTreePath(folderPath);
      if (!normalized) continue;
      const parts = normalized.split("\\");
      let acc = "";
      for (const part of parts) {
        acc = acc ? `${acc}\\${part}` : part;
        const key = acc.toLowerCase();
        if (!validPathMap.has(key)) validPathMap.set(key, acc);
      }
    }

    const nextExpanded = new Set();
    for (const path of expandedFolders) {
      const normalized = normalizeTreePath(path);
      if (!normalized) continue;
      const canonical = validPathMap.get(normalized.toLowerCase());
      if (canonical) nextExpanded.add(canonical);
    }

    expandedFolders = nextExpanded;
    persistExpandedFolders();
  }

  function expandFolder(folderPath) {
    if (!folderPath) return;
    expandedFolders.add(folderPath);
  }

  function collapseFolder(folderPath) {
    expandedFolders.delete(folderPath);
  }

  // ---- Remembered selection ----

  function buildSelectedProjectSnapshot(project) {
    if (!project || typeof project !== "object") return null;
    const name = String(project.name || "").trim();
    if (!name) return null;
    return {
      name,
      folder: normalizeTreePath(project.folder || ""),
    };
  }

  function loadSelectedProjectFromSession() {
    try {
      const raw = sessionStorage.getItem(SELECTED_PROJECT_SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return buildSelectedProjectSnapshot(parsed);
    } catch {
      return null;
    }
  }

  function clearSelectedProjectFromSession() {
    try {
      sessionStorage.removeItem(SELECTED_PROJECT_SESSION_KEY);
    } catch {}
  }

  function saveSelectedProjectToSession(project) {
    const snapshot = buildSelectedProjectSnapshot(project);
    if (!snapshot) {
      clearSelectedProjectFromSession();
      return;
    }
    try {
      sessionStorage.setItem(SELECTED_PROJECT_SESSION_KEY, JSON.stringify(snapshot));
    } catch {}
  }

  // ---- Rendering ----

  function render() {
    treeContent.innerHTML = "";

    const treeData = getTreeData();
    if (!treeData || Object.keys(treeData).length === 0) {
      treeContent.innerHTML = '<div class="tree-empty">No projects found</div>';
      return;
    }

    syncExpandedFoldersWithTreeData();

    // Folders can be nested like "New Jersey\2025 Q1".
    for (const node of buildHierarchy(treeData)) {
      treeContent.appendChild(createFolderNode(node, 0));
    }
  }

  function createFolderNode(node, depth) {
    const container = document.createElement("div");
    container.className = "tree-node";

    const hasChildren = node.children.length > 0 || node.projects.length > 0;
    const isExpanded = expandedFolders.has(node.fullPath);

    const folderEl = document.createElement("div");
    folderEl.className = "tree-folder";
    folderEl.style.paddingLeft = `${4 + depth * 8}px`;
    folderEl.draggable = true;

    const arrowEl = document.createElement("div");
    arrowEl.className = "tree-folder-arrow" + (isExpanded ? " expanded" : "");
    arrowEl.innerHTML = hasChildren ? FOLDER_ARROW_ICON : "";

    const iconEl = document.createElement("div");
    iconEl.className = "tree-folder-icon" + (isExpanded ? " expanded" : "");
    iconEl.innerHTML = isExpanded ? FOLDER_OPEN_ICON : FOLDER_CLOSED_ICON;

    const nameEl = document.createElement("div");
    nameEl.className = "tree-folder-name";
    nameEl.textContent = node.name;

    const countEl = document.createElement("div");
    countEl.className = "tree-folder-count";
    countEl.textContent = countFolderProjects(node);

    folderEl.append(arrowEl, iconEl, nameEl, countEl);
    container.appendChild(folderEl);

    // Children container (create before click handler so we can reference it)
    let childrenEl = null;
    if (hasChildren) {
      childrenEl = document.createElement("div");
      childrenEl.className = "tree-children" + (isExpanded ? " expanded" : "");
      for (const child of node.children) {
        childrenEl.appendChild(createFolderNode(child, depth + 1));
      }
      for (const project of node.projects) {
        childrenEl.appendChild(createProjectNode(project, depth + 1));
      }
      container.appendChild(childrenEl);
    }

    folderEl.addEventListener("click", () => {
      const nowExpanded = expandedFolders.has(node.fullPath);
      if (nowExpanded) {
        expandedFolders.delete(node.fullPath);
      } else {
        expandedFolders.add(node.fullPath);
      }
      const nextExpanded = !nowExpanded;
      arrowEl.classList.toggle("expanded", nextExpanded);
      iconEl.classList.toggle("expanded", nextExpanded);
      iconEl.innerHTML = nextExpanded ? FOLDER_OPEN_ICON : FOLDER_CLOSED_ICON;
      if (childrenEl) childrenEl.classList.toggle("expanded", nextExpanded);
      persistExpandedFolders({ immediate: true });
    });

    folderEl.addEventListener("dragstart", (e) => {
      draggedFolder = node;
      draggedProject = null;
      folderEl.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });

    folderEl.addEventListener("dragend", () => {
      draggedFolder = null;
      folderEl.classList.remove("dragging");
      document.querySelectorAll(".tree-folder.drop-target").forEach(f => f.classList.remove("drop-target"));
    });

    // Accept both project and folder drops.
    folderEl.addEventListener("dragover", (e) => {
      if (draggedProject) {
        if (draggedProject.folder === node.fullPath) return;
      } else if (draggedFolder) {
        // Cannot drop a folder onto itself or onto one of its descendants.
        if (draggedFolder.fullPath === node.fullPath) return;
        if (node.fullPath && node.fullPath.startsWith(draggedFolder.fullPath + "\\")) return;
      } else {
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      folderEl.classList.add("drop-target");
    });

    folderEl.addEventListener("dragleave", () => {
      folderEl.classList.remove("drop-target");
    });

    folderEl.addEventListener("drop", (e) => {
      e.preventDefault();
      folderEl.classList.remove("drop-target");
      if (draggedProject && draggedProject.folder !== node.fullPath) {
        moveProjectToFolder(draggedProject, node.fullPath);
      } else if (draggedFolder && draggedFolder.fullPath !== node.fullPath && (!node.fullPath || !node.fullPath.startsWith(draggedFolder.fullPath + "\\"))) {
        moveFolderToFolder(draggedFolder, node.fullPath);
      }
    });

    folderEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showFolderContextMenu(node, e.clientX, e.clientY);
    });

    return container;
  }

  function createProjectNode(project, depth) {
    const el = document.createElement("div");
    el.className = "tree-project";
    const selected = getSelectedProject();
    if (selected && selected.name === project.name) {
      el.classList.add("active");
    }
    el.style.paddingLeft = `${12 + depth * 8}px`;
    el.draggable = true;

    const iconEl = document.createElement("div");
    iconEl.className = "tree-project-icon";
    iconEl.innerHTML = PROJECT_ICON;

    const nameEl = document.createElement("div");
    nameEl.className = "tree-project-name";
    nameEl.textContent = project.name;
    nameEl.title = project.name;

    const viewDatasetsBtn = document.createElement("button");
    viewDatasetsBtn.type = "button";
    viewDatasetsBtn.className = "tree-project-action";
    viewDatasetsBtn.title = "View project contents in a new tab";
    viewDatasetsBtn.setAttribute("aria-label", `View project contents in a new tab for ${project.name}`);
    viewDatasetsBtn.innerHTML = OPEN_IN_TAB_ICON;
    viewDatasetsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openProjectInstanceTab(project);
    });

    el.append(iconEl, nameEl, viewDatasetsBtn);

    el.addEventListener("click", () => {
      selectProject(project);
    });

    el.addEventListener("dblclick", () => {
      openProjectInNewTab(project);
    });

    el.addEventListener("dragstart", (e) => {
      draggedProject = project;
      draggedFolder = null;
      el.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });

    el.addEventListener("dragend", () => {
      draggedProject = null;
      el.classList.remove("dragging");
      document.querySelectorAll(".tree-folder.drop-target").forEach(f => f.classList.remove("drop-target"));
    });

    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showProjectContextMenu(project, e.clientX, e.clientY);
    });

    return el;
  }

  /**
   * Restore expanded folders from local preferences, falling back to session
   * state. Returns false when neither source had anything to restore.
   */
  async function restoreExpandedFolders() {
    const restoredFromLocalPreferences = await loadExpandedFoldersFromLocalPreferences();
    preferencesLoaded = true;
    return restoredFromLocalPreferences ? true : loadExpandedFoldersFromSession();
  }

  return {
    clearSelectedProjectFromSession,
    collapseFolder,
    expandFolder,
    loadSelectedProjectFromSession,
    persistExpandedFolders,
    render,
    restoreExpandedFolders,
    saveSelectedProjectToSession,
    buildSelectedProjectSnapshot,
  };
}

/**
 * Project Settings - Folder Tree View
 * Displays projects in an expandable folder structure
 */

// ============ Zoom & Hotkey Handling ============
const ZOOM_STORAGE_KEY = "adas_ui_zoom_pct";
const ZOOM_MODE_KEY = "adas_zoom_mode";

function applyZoomValue(v) {
  try {
    if (localStorage.getItem(ZOOM_MODE_KEY) === "host") return;
  } catch {}
  const z = Number(v);
  if (!Number.isFinite(z)) return;
  const scale = Math.max(0.5, Math.min(2, z / 100));
  document.documentElement.style.zoom = String(scale);
  document.body.style.zoom = String(scale);
}

function loadZoomFromStorage() {
  try {
    const raw = localStorage.getItem(ZOOM_STORAGE_KEY);
    if (!raw) return 100;
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0) return v;
  } catch {}
  return 100;
}

applyZoomValue(loadZoomFromStorage());

window.addEventListener("message", (e) => {
  if (e?.data?.type === "adas:set-zoom") {
    applyZoomValue(e.data.zoom);
  }
});

window.addEventListener("mousedown", () => {
  window.parent.postMessage({ type: "adas:close-shell-menus" }, "*");
}, { capture: true });

window.addEventListener("keydown", (e) => {
  const key = (e.key || "").toLowerCase();
  if (e.altKey && key === "w") {
    e.preventDefault();
    window.parent.postMessage({ type: "adas:close-active-tab" }, "*");
    return;
  }
  if (e.ctrlKey && key === "q") {
    e.preventDefault();
    window.parent.postMessage({ type: "adas:hotkey", action: "app_shutdown" }, "*");
    return;
  }
}, { capture: true });

document.addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  window.parent.postMessage({ type: "adas:zoom", deltaY: e.deltaY }, "*");
}, { capture: true, passive: false });

// ============ State ============
let projectData = null;       // Raw JSON data
let treeData = null;          // Parsed tree structure
let selectedProject = null;   // Currently selected project
let expandedFolders = new Set(); // Track expanded folders
let draggedProject = null;    // Currently dragged project
let draggedFolder = null;     // Currently dragged folder node
let contextMenuProject = null; // Project for context menu actions
let contextMenuFolder = null;  // Folder node for context menu (create subfolder)

// ============ DOM Elements ============
const treeContent = document.getElementById("treeContent");
const detailEmpty = document.getElementById("detailEmpty");
const detailView = document.getElementById("detailView");
const detailTitle = document.getElementById("detailTitle");
const detailForm = document.getElementById("detailForm");
const openInTabBtn = document.getElementById("openInTabBtn");
const editSettingsBtn = document.getElementById("editSettingsBtn");
const treePanel = document.getElementById("treePanel");
const resizeHandle = document.getElementById("resizeHandle");
const treeHeader = document.querySelector(".tree-header");
const contextMenu = document.getElementById("contextMenu");
const folderContextMenu = document.getElementById("folderContextMenu");
const treeContextMenu = document.getElementById("treeContextMenu");
const dialogOverlay = document.getElementById("dialogOverlay");
const dialogTitle = document.getElementById("dialogTitle");
const dialogInput = document.getElementById("dialogInput");
const dialogOk = document.getElementById("dialogOk");
const dialogCancel = document.getElementById("dialogCancel");
const confirmOverlay = document.getElementById("confirmOverlay");
const confirmTitle = document.getElementById("confirmTitle");
const confirmMessage = document.getElementById("confirmMessage");
const confirmOk = document.getElementById("confirmOk");
const confirmCancel = document.getElementById("confirmCancel");
const confirmBox = document.getElementById("confirmBox");

// ============ Data Sources ============
const DEFAULT_SOURCE = "Actuarial_NJ";

let currentMtime = null; // Track file modification time for conflict detection

function setStatus(msg) {
  // Send status to app's statusbar
  window.parent.postMessage({ type: "adas:status", text: msg || "" }, "*");
}

// ============ Load JSON Data ============
async function loadProjectData(sourceKey = DEFAULT_SOURCE) {
  setStatus("Loading projects...");
  try {
    const res = await fetch(`/project_settings/${sourceKey}`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const result = await res.json();
    projectData = result.data;
    currentMtime = result.mtime;

    // Load folder structure from E:\ADAS\Team Profile\folder_structure.json (create from project data if empty)
    try {
      let foldersRes = await fetch(`/project_settings/${sourceKey}/folders`);
      if (foldersRes.ok) {
        const foldersResult = await foldersRes.json();
        let folders = Array.isArray(foldersResult.folders) ? foldersResult.folders : [];
        if (folders.length === 0) {
          const initRes = await fetch(`/project_settings/${sourceKey}/folders/init_from_data`, { method: "POST" });
          if (initRes.ok) {
            const initResult = await initRes.json();
            folders = Array.isArray(initResult.folders) ? initResult.folders : [];
          }
        }
        projectData.customFolders = folders;
      } else {
        projectData.customFolders = [];
      }
    } catch {
      projectData.customFolders = [];
    }

    // Migrate "Settings Profile" -> "Project Settings" in headers so next save updates JSON
    for (const sheetName of Object.keys(projectData)) {
      const sheet = projectData[sheetName];
      if (sheet.headers) {
        const idx = sheet.headers.indexOf("Settings Profile");
        if (idx >= 0) {
          sheet.headers[idx] = "Project Settings";
        }
      }
    }

    buildTreeData();
    renderTree();
    setStatus(`Loaded ${countProjects()} projects from ${result.path}`);
  } catch (err) {
    setStatus(`Error loading: ${err.message}`);
    console.error(err);
  }
}

function countProjects() {
  if (!treeData) return 0;
  let count = 0;
  for (const folder of Object.values(treeData)) {
    count += folder.projects.length;
  }
  return count;
}

/** Get the first sheet name (excludes customFolders). */
function getSheetName() {
  return projectData && Object.keys(projectData).find(k => k !== "customFolders");
}

// ============ Build Tree Structure ============
function buildTreeData() {
  treeData = {};

  const sheetName = getSheetName();
  if (!sheetName) return;

  const sheet = projectData[sheetName];
  if (!sheet || !Array.isArray(sheet.rows)) return;
  const headers = sheet.headers || [];
  const rows = sheet.rows || [];

  // Find column indices (support "Project Settings" or legacy "Settings Profile")
  const colIdx = {};
  headers.forEach((h, i) => {
    colIdx[h] = i;
  });
  const settingsCol = colIdx["Project Settings"] ?? colIdx["Settings Profile"] ?? -1;

  // Build folder -> projects map
  for (const row of rows) {
    const folder = row[colIdx["Folder"]] || "Uncategorized";
    const projectName = row[colIdx["Project Name"]] || "";

    if (!projectName) continue;

    if (!treeData[folder]) {
      treeData[folder] = {
        name: folder,
        projects: []
      };
    }

    treeData[folder].projects.push({
      name: projectName,
      settings: settingsCol >= 0 ? (row[settingsCol] || "") : "",
      tablePath: row[colIdx["Table Path"]] || "",
      preload: row[colIdx["Preload"]] || null,
      folder: folder,
      _row: row
    });
  }

  // Merge custom (empty) folders so they appear in the tree
  const customFolders = projectData.customFolders || [];
  for (const folderPath of customFolders) {
    if (folderPath && !treeData[folderPath]) {
      treeData[folderPath] = { name: folderPath.split("\\").pop(), projects: [] };
    }
  }

  // Sort folders
  const sortedFolders = {};
  Object.keys(treeData).sort().forEach(key => {
    sortedFolders[key] = treeData[key];
  });
  treeData = sortedFolders;
}

// ============ Render Tree ============
function renderTree() {
  treeContent.innerHTML = "";

  if (!treeData || Object.keys(treeData).length === 0) {
    treeContent.innerHTML = '<div style="padding:12px;color:#999;">No projects found</div>';
    return;
  }

  // Build hierarchical folder structure
  // Folders can be nested like "New Jersey\2025 Q1"
  const rootFolders = buildHierarchy(treeData);

  for (const node of rootFolders) {
    const el = createFolderNode(node, 0);
    treeContent.appendChild(el);
  }
}

function buildHierarchy(flatFolders) {
  // Parse folder paths and build tree
  // e.g., "New Jersey\2025 Q1" -> { "New Jersey": { "2025 Q1": [...] } }
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

  // Convert to array for rendering
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

function createFolderNode(node, depth) {
  const container = document.createElement("div");
  container.className = "tree-node";

  const hasChildren = node.children.length > 0 || node.projects.length > 0;
  const isExpanded = expandedFolders.has(node.fullPath);
  const totalProjects = countFolderProjects(node);

  // Folder header
  const folderEl = document.createElement("div");
  folderEl.className = "tree-folder";
  folderEl.style.paddingLeft = `${4 + depth * 8}px`;
  folderEl.draggable = true;

  // Arrow indicator
  const arrowEl = document.createElement("div");
  arrowEl.className = "tree-folder-arrow" + (isExpanded ? " expanded" : "");
  arrowEl.innerHTML = hasChildren ? `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/></svg>` : "";

  const iconEl = document.createElement("div");
  iconEl.className = "tree-folder-icon" + (isExpanded ? " expanded" : "");
  // Folder open/closed SVG icons
  if (isExpanded) {
    iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg>`;
  } else {
    iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;
  }

  const nameEl = document.createElement("div");
  nameEl.className = "tree-folder-name";
  nameEl.textContent = node.name;

  const countEl = document.createElement("div");
  countEl.className = "tree-folder-count";
  countEl.textContent = totalProjects;

  folderEl.appendChild(arrowEl);
  folderEl.appendChild(iconEl);
  folderEl.appendChild(nameEl);
  folderEl.appendChild(countEl);

  container.appendChild(folderEl);

  // Children container (create before click handler so we can reference it)
  let childrenEl = null;
  if (hasChildren) {
    childrenEl = document.createElement("div");
    childrenEl.className = "tree-children" + (isExpanded ? " expanded" : "");

    // Render child folders
    for (const child of node.children) {
      childrenEl.appendChild(createFolderNode(child, depth + 1));
    }

    // Render projects
    for (const project of node.projects) {
      childrenEl.appendChild(createProjectNode(project, depth + 1));
    }

    container.appendChild(childrenEl);
  }

  folderEl.addEventListener("click", () => {
    const nowExpanded = expandedFolders.has(node.fullPath);
    if (nowExpanded) {
      expandedFolders.delete(node.fullPath);
      arrowEl.classList.remove("expanded");
      iconEl.classList.remove("expanded");
      iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;
      if (childrenEl) childrenEl.classList.remove("expanded");
    } else {
      expandedFolders.add(node.fullPath);
      arrowEl.classList.add("expanded");
      iconEl.classList.add("expanded");
      iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg>`;
      if (childrenEl) childrenEl.classList.add("expanded");
    }
  });

  // Drag events for folder
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

  // Drop events for folder (accept both project and folder)
  folderEl.addEventListener("dragover", (e) => {
    if (draggedProject) {
      if (draggedProject.folder === node.fullPath) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      folderEl.classList.add("drop-target");
    } else if (draggedFolder) {
      // Cannot drop folder onto itself or onto a descendant
      if (draggedFolder.fullPath === node.fullPath) return;
      if (node.fullPath && node.fullPath.startsWith(draggedFolder.fullPath + "\\")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      folderEl.classList.add("drop-target");
    }
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

  // Right-click: Create subfolder
  folderEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    contextMenuFolder = node;
    contextMenuProject = null;
    hideContextMenu();
    hideTreeContextMenu();
    folderContextMenu.style.left = `${e.clientX}px`;
    folderContextMenu.style.top = `${e.clientY}px`;
    folderContextMenu.classList.add("show");
  });

  return container;
}

function countFolderProjects(node) {
  let count = node.projects.length;
  for (const child of node.children) {
    count += countFolderProjects(child);
  }
  return count;
}

function createProjectNode(project, depth) {
  const el = document.createElement("div");
  el.className = "tree-project";
  if (selectedProject && selectedProject.name === project.name) {
    el.classList.add("active");
  }
  el.style.paddingLeft = `${12 + depth * 8}px`;
  el.draggable = true;

  const iconEl = document.createElement("div");
  iconEl.className = "tree-project-icon";
  iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>`;

  const nameEl = document.createElement("div");
  nameEl.className = "tree-project-name";
  nameEl.textContent = project.name;
  nameEl.title = project.name;

  el.appendChild(iconEl);
  el.appendChild(nameEl);

  el.addEventListener("click", () => {
    selectProject(project);
  });

  el.addEventListener("dblclick", () => {
    openProjectInNewTab(project);
  });

  // Drag events
  el.addEventListener("dragstart", (e) => {
    draggedProject = project;
    draggedFolder = null;
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });

  el.addEventListener("dragend", () => {
    draggedProject = null;
    el.classList.remove("dragging");
    // Remove all drop highlights
    document.querySelectorAll(".tree-folder.drop-target").forEach(f => f.classList.remove("drop-target"));
  });

  // Right-click context menu
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    contextMenuProject = project;
    contextMenuFolder = null;
    hideFolderContextMenu();
    hideTreeContextMenu();
    showContextMenu(e.clientX, e.clientY);
  });

  return el;
}

// ============ Project Selection ============
function selectProject(project) {
  selectedProject = project;
  renderTree(); // Update active state
  showProjectDetails(project);
  // Update tree header to show the last part of the folder name
  if (treeHeader && project.folder) {
    const parts = project.folder.split("\\");
    treeHeader.textContent = parts[parts.length - 1];
  }
}

function showProjectDetails(project) {
  detailEmpty.style.display = "none";
  detailView.style.display = "flex";
  detailTitle.textContent = project.name;

  // Build detail form (Folder is managed via drag & drop in tree)
  const fields = [
    { label: "Project Name", value: project.name, readonly: true },
    { label: "Project Settings", value: project.settings, readonly: false },
    { label: "Table Path", value: project.tablePath, readonly: false }
  ];

  detailForm.innerHTML = "";
  for (const field of fields) {
    const labelEl = document.createElement("div");
    labelEl.className = "detail-label";
    labelEl.textContent = field.label;

    const valueEl = document.createElement("div");
    valueEl.className = "detail-value";

    const input = document.createElement("input");
    input.type = "text";
    input.value = field.value || "";
    input.readOnly = field.readonly;
    input.dataset.field = field.label;

    valueEl.appendChild(input);
    detailForm.appendChild(labelEl);
    detailForm.appendChild(valueEl);
  }

  // Load table summary if table path exists
  loadTableSummary(project.tablePath);
}

// ============ Table Summary ============
async function loadTableSummary(tablePath) {
  const summaryEl = document.getElementById("tableSummary");
  const statsEl = document.getElementById("summaryStats");
  const columnsEl = document.getElementById("summaryColumns");

  if (!tablePath) {
    summaryEl.style.display = "none";
    return;
  }

  summaryEl.style.display = "block";
  statsEl.innerHTML = '<div class="summary-loading">Loading table summary...</div>';
  columnsEl.innerHTML = "";

  try {
    const res = await fetch(`/table_summary?path=${encodeURIComponent(tablePath)}`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text);
    }

    const data = await res.json();

    // Render stats
    statsEl.innerHTML = `
      <div class="stat-item">
        <div class="stat-label">Rows</div>
        <div class="stat-value">${data.row_count.toLocaleString()}</div>
      </div>
      <div class="stat-item">
        <div class="stat-label">Columns</div>
        <div class="stat-value">${data.column_count}</div>
      </div>
      <div class="stat-item">
        <div class="stat-label">File Size</div>
        <div class="stat-value">${data.file_size_str}</div>
      </div>
    `;

    // Render columns table
    let colHtml = `
      <table class="columns-table">
        <thead>
          <tr>
            <th>Column Name</th>
            <th>Data Type</th>
            <th>Values</th>
          </tr>
        </thead>
        <tbody>
    `;

    for (const col of data.columns) {
      colHtml += `
        <tr>
          <td class="col-name">${escapeHtml(col.name)}</td>
          <td class="col-type">${col.type}</td>
          <td class="col-sample" title="${escapeHtml(col.values)}">${escapeHtml(col.values)}</td>
        </tr>
      `;
    }

    colHtml += "</tbody></table>";
    columnsEl.innerHTML = colHtml;

  } catch (err) {
    statsEl.innerHTML = `<div class="summary-error">Error: ${escapeHtml(err.message)}</div>`;
    columnsEl.innerHTML = "";
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ============ Open in New Tab ============
function openProjectInNewTab(project) {
  // Send message to parent to open project in new tab
  window.parent.postMessage({
    type: "adas:open-project",
    project: {
      name: project.name,
      settings: project.settings,
      tablePath: project.tablePath,
      folder: project.folder
    }
  }, "*");

  setStatus(`Opening: ${project.name}`);
}

// ============ Edit Settings ============
function openProjectSettings(project) {
  const settingsPath = project.settings;
  if (!settingsPath) {
    alert("No settings file specified for this project.");
    return;
  }

  // Send message to open settings workbook
  window.parent.postMessage({
    type: "adas:open-workbook",
    path: settingsPath
  }, "*");

  setStatus(`Opening settings: ${settingsPath}`);
}

// ============ Resize Handle ============
let isResizing = false;

resizeHandle.addEventListener("mousedown", (e) => {
  isResizing = true;
  document.body.style.cursor = "col-resize";
  e.preventDefault();
});

document.addEventListener("mousemove", (e) => {
  if (!isResizing) return;
  const newWidth = e.clientX;
  if (newWidth >= 200 && newWidth <= 500) {
    treePanel.style.width = `${newWidth}px`;
  }
});

document.addEventListener("mouseup", () => {
  if (isResizing) {
    isResizing = false;
    document.body.style.cursor = "";
  }
});

// ============ Event Handlers ============
openInTabBtn.addEventListener("click", () => {
  if (selectedProject) {
    openProjectInNewTab(selectedProject);
  }
});

editSettingsBtn.addEventListener("click", () => {
  if (selectedProject) {
    openProjectSettings(selectedProject);
  }
});

// ============ Move Project to Folder ============
async function moveProjectToFolder(project, newFolder) {
  const oldFolder = project.folder;
  if (oldFolder === newFolder) return;

  // Update the _row data in projectData
  const sheetName = getSheetName();
  const sheet = projectData[sheetName];
  const headers = sheet.headers || [];
  const folderIdx = headers.indexOf("Folder");
  
  if (folderIdx === -1) {
    setStatus("Error: Folder column not found");
    return;
  }

  // Update the row
  project._row[folderIdx] = newFolder;
  project.folder = newFolder;

  // Rebuild tree and re-render
  buildTreeData();
  renderTree();
  
  // Update selected project if it was moved
  if (selectedProject && selectedProject.name === project.name) {
    selectedProject = project;
    showProjectDetails(project);
  }

  // Auto-save
  setStatus(`Moving "${project.name}" to "${newFolder}"...`);
  await saveProjectData(DEFAULT_SOURCE);
}

// ============ Custom Prompt Dialog ============
let dialogResolve = null;

function showDialog(title, defaultValue = "") {
  return new Promise((resolve) => {
    dialogResolve = resolve;
    dialogTitle.textContent = title;
    dialogInput.value = defaultValue;
    dialogInput.removeAttribute("readonly");
    dialogInput.removeAttribute("disabled");
    dialogOverlay.classList.add("show");
    // Defer focus so the dialog is painted and context menu / other UI has released focus (fixes Electron/iframe)
    setTimeout(() => {
      dialogInput.focus();
      dialogInput.select();
    }, 50);
  });
}

function hideDialog(result) {
  dialogOverlay.classList.remove("show");
  if (dialogResolve) {
    dialogResolve(result);
    dialogResolve = null;
  }
}

dialogOk.addEventListener("click", () => {
  hideDialog(dialogInput.value.trim());
});

dialogCancel.addEventListener("click", () => {
  hideDialog(null);
});

dialogInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    hideDialog(dialogInput.value.trim());
  } else if (e.key === "Escape") {
    hideDialog(null);
  }
});

// Keep focus inside dialog: stop events from bubbling to parent (helps in Electron/iframe)
const dialogBox = document.getElementById("dialogBox");
dialogOverlay.addEventListener("mousedown", (e) => {
  if (dialogBox.contains(e.target)) {
    e.stopPropagation();
  }
});
dialogOverlay.addEventListener("click", (e) => {
  if (dialogBox.contains(e.target)) {
    e.stopPropagation();
  }
});

// ============ Custom Confirm Dialog ============
let confirmResolve = null;

function showConfirm(message, title = "Confirm") {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    confirmTitle.textContent = title;
    confirmMessage.textContent = message;
    confirmOverlay.classList.add("show");
    setTimeout(() => confirmOk.focus(), 50);
  });
}

function hideConfirm(result) {
  confirmOverlay.classList.remove("show");
  if (confirmResolve) {
    confirmResolve(result);
    confirmResolve = null;
  }
}

confirmOk.addEventListener("click", () => hideConfirm(true));
confirmCancel.addEventListener("click", () => hideConfirm(false));
confirmOverlay.addEventListener("keydown", (e) => {
  if (e.key === "Enter") hideConfirm(true);
  else if (e.key === "Escape") hideConfirm(false);
});
confirmOverlay.addEventListener("mousedown", (e) => {
  if (confirmBox.contains(e.target)) e.stopPropagation();
});
confirmOverlay.addEventListener("click", (e) => {
  if (confirmBox.contains(e.target)) e.stopPropagation();
});

// ============ Context Menu ============
function showContextMenu(x, y) {
  contextMenu.style.left = `${x}px`;
  contextMenu.style.top = `${y}px`;
  contextMenu.classList.add("show");
}

function hideContextMenu() {
  contextMenu.classList.remove("show");
  contextMenuProject = null;
}

function hideFolderContextMenu() {
  folderContextMenu.classList.remove("show");
  contextMenuFolder = null;
}

function hideTreeContextMenu() {
  treeContextMenu.classList.remove("show");
}

// Hide context menus on click outside
document.addEventListener("click", (e) => {
  if (!contextMenu.contains(e.target)) hideContextMenu();
  if (!folderContextMenu.contains(e.target)) hideFolderContextMenu();
  if (!treeContextMenu.contains(e.target)) hideTreeContextMenu();
});

// Right-click on tree blank area: Create root folder
treeContent.addEventListener("contextmenu", (e) => {
  // Only when clicking on blank area (not on a folder or project)
  if (e.target.closest(".tree-folder") || e.target.closest(".tree-project")) return;
  if (!treeContent.contains(e.target)) return;
  e.preventDefault();
  contextMenuFolder = null;
  contextMenuProject = null;
  hideContextMenu();
  hideFolderContextMenu();
  treeContextMenu.style.left = `${e.clientX}px`;
  treeContextMenu.style.top = `${e.clientY}px`;
  treeContextMenu.classList.add("show");
});

// Context menu actions (projects)
contextMenu.addEventListener("click", (e) => {
  const action = e.target.dataset.action;
  if (!action || !contextMenuProject) return;
  
  const project = contextMenuProject;
  hideContextMenu();
  
  if (action === "rename") {
    renameProject(project);
  } else if (action === "duplicate") {
    duplicateProject(project);
  } else if (action === "delete") {
    deleteProject(project);
  }
});

// Folder context menu: Rename, Create subfolder, Delete
folderContextMenu.addEventListener("click", (e) => {
  const action = e.target.dataset.action;
  if (!action || !contextMenuFolder) return;
  const folderNode = contextMenuFolder;
  hideFolderContextMenu();
  if (action === "rename-folder") {
    renameFolder(folderNode);
  } else if (action === "create-subfolder") {
    createSubfolder(folderNode);
  } else if (action === "delete-folder") {
    deleteFolder(folderNode);
  }
});

// Tree context menu: Create root folder
treeContextMenu.addEventListener("click", (e) => {
  if (e.target.dataset.action !== "create-root-folder") return;
  hideTreeContextMenu();
  createRootFolder();
});

async function renameProject(project) {
  const newName = await showDialog("Enter new project name:", project.name);
  if (!newName || newName === project.name) return;
  
  const sheetName = getSheetName();
  const sheet = projectData[sheetName];
  const headers = sheet.headers || [];
  const nameIdx = headers.indexOf("Project Name");
  
  if (nameIdx === -1) {
    setStatus("Error: Project Name column not found");
    return;
  }
  
  // Update the row
  project._row[nameIdx] = newName;
  project.name = newName;
  
  // Rebuild and re-render
  buildTreeData();
  renderTree();
  
  if (selectedProject && selectedProject === project) {
    showProjectDetails(project);
  }
  
  setStatus(`Renamed to "${newName}"`);
  await saveProjectData(DEFAULT_SOURCE);
}

function getNextDuplicateName(baseName) {
  // Get all existing project names
  const sheetName = getSheetName();
  const sheet = projectData[sheetName];
  const headers = sheet.headers || [];
  const nameIdx = headers.indexOf("Project Name");
  const existingNames = new Set(sheet.rows.map(row => row[nameIdx]));
  
  // Remove existing index suffix like "(2)", "(3)" from base name
  const baseWithoutIndex = baseName.replace(/\s*\(\d+\)\s*$/, "").trim();
  
  // Find next available index
  let index = 2;
  let newName = `${baseWithoutIndex} (${index})`;
  while (existingNames.has(newName)) {
    index++;
    newName = `${baseWithoutIndex} (${index})`;
  }
  return newName;
}

async function duplicateProject(project) {
  const suggestedName = getNextDuplicateName(project.name);
  const newName = await showDialog("Enter name for duplicate:", suggestedName);
  if (!newName) return;
  
  const sheetName = getSheetName();
  const sheet = projectData[sheetName];
  const headers = sheet.headers || [];
  const nameIdx = headers.indexOf("Project Name");
  
  if (nameIdx === -1) {
    setStatus("Error: Project Name column not found");
    return;
  }
  
  // Create a copy of the row
  const newRow = [...project._row];
  newRow[nameIdx] = newName.trim();
  
  // Add to rows
  sheet.rows.push(newRow);
  
  // Rebuild and re-render
  buildTreeData();
  renderTree();
  
  setStatus(`Duplicating as "${newName.trim()}"...`);
  await saveProjectData(DEFAULT_SOURCE);
}

async function deleteProject(project) {
  const confirmed = await showConfirm(`Are you sure you want to delete "${project.name}"?`, "Delete Project");
  if (!confirmed) return;
  
  const sheetName = getSheetName();
  const sheet = projectData[sheetName];
  
  // Find and remove the row
  const rowIndex = sheet.rows.indexOf(project._row);
  if (rowIndex === -1) {
    setStatus("Error: Project row not found");
    return;
  }
  
  sheet.rows.splice(rowIndex, 1);
  
  // Clear selection if deleted project was selected
  if (selectedProject && selectedProject.name === project.name) {
    selectedProject = null;
    detailEmpty.style.display = "flex";
    detailView.style.display = "none";
  }
  
  // Rebuild and re-render
  buildTreeData();
  renderTree();
  
  setStatus(`Deleting "${project.name}"...`);
  await saveProjectData(DEFAULT_SOURCE);
}

// ============ Create Folder ============
async function createSubfolder(parentNode) {
  const name = await showDialog("Enter subfolder name:", "");
  if (!name || !name.trim()) return;

  const newPath = parentNode.fullPath ? `${parentNode.fullPath}\\${name.trim()}` : name.trim();
  if (!projectData.customFolders) projectData.customFolders = [];
  if (projectData.customFolders.includes(newPath)) {
    setStatus("Folder already exists.");
    return;
  }

  projectData.customFolders.push(newPath);
  expandedFolders.add(parentNode.fullPath);
  expandedFolders.add(newPath);
  buildTreeData();
  renderTree();
  setStatus(`Created subfolder "${name.trim()}"`);
  await saveProjectData(DEFAULT_SOURCE);
}

async function createRootFolder() {
  const name = await showDialog("Enter root folder name:", "");
  if (!name || !name.trim()) return;

  const newPath = name.trim();
  if (!projectData.customFolders) projectData.customFolders = [];
  if (projectData.customFolders.includes(newPath)) {
    setStatus("Folder already exists.");
    return;
  }

  projectData.customFolders.push(newPath);
  expandedFolders.add(newPath);
  buildTreeData();
  renderTree();
  setStatus(`Created root folder "${newPath}"`);
  await saveProjectData(DEFAULT_SOURCE);
}

async function renameFolder(node) {
  const currentName = node.name;
  const newName = await showDialog("Enter folder name:", currentName);
  if (!newName || newName.trim() === "" || newName === currentName) return;

  const oldPath = node.fullPath;
  const parentPath = oldPath.includes("\\") ? oldPath.replace(/\\[^\\]+$/, "") : "";
  const newPath = parentPath ? `${parentPath}\\${newName.trim()}` : newName.trim();

  if (oldPath === newPath) return;

  const sheetName = getSheetName();
  const sheet = projectData[sheetName];
  const headers = sheet.headers || [];
  const folderIdx = headers.indexOf("Folder");
  if (folderIdx === -1) {
    setStatus("Error: Folder column not found");
    return;
  }

  // Update all rows: folder equals oldPath or starts with oldPath + "\\"
  for (const row of sheet.rows) {
    const f = row[folderIdx] || "";
    if (f === oldPath) {
      row[folderIdx] = newPath;
    } else if (f.startsWith(oldPath + "\\")) {
      row[folderIdx] = newPath + f.slice(oldPath.length);
    }
  }

  // Update customFolders
  if (projectData.customFolders) {
    projectData.customFolders = projectData.customFolders.map(p => {
      if (p === oldPath) return newPath;
      if (p.startsWith(oldPath + "\\")) return newPath + p.slice(oldPath.length);
      return p;
    });
  }

  expandedFolders.delete(oldPath);
  expandedFolders.add(newPath);
  buildTreeData();
  renderTree();
  setStatus(`Renamed folder to "${newName.trim()}"`);
  await saveProjectData(DEFAULT_SOURCE);
}

async function deleteFolder(node) {
  const path = node.fullPath;
  const confirmed = await showConfirm(`Delete folder "${path}"? Projects inside will be moved to the parent folder.`, "Delete Folder");
  if (!confirmed) return;

  const parentPath = path.includes("\\") ? path.replace(/\\[^\\]+$/, "") : "";
  const targetPath = parentPath || "Uncategorized";
  const sheetName = getSheetName();
  const sheet = projectData[sheetName];
  const headers = sheet.headers || [];
  const folderIdx = headers.indexOf("Folder");
  if (folderIdx === -1) {
    setStatus("Error: Folder column not found");
    return;
  }

  // Move all projects in this folder and subfolders to parent (flatten one level)
  for (const row of sheet.rows) {
    const f = row[folderIdx] || "";
    if (f === path) {
      row[folderIdx] = targetPath;
    } else if (f.startsWith(path + "\\")) {
      const rest = f.slice(path.length + 1);
      row[folderIdx] = targetPath === "Uncategorized" ? rest : `${targetPath}\\${rest}`;
    }
  }

  // Remove folder and subfolders from customFolders (always keep customFolders as an array)
  if (Array.isArray(projectData.customFolders)) {
    projectData.customFolders = projectData.customFolders.filter(p => p !== path && !p.startsWith(path + "\\"));
  } else {
    projectData.customFolders = [];
  }

  expandedFolders.delete(path);
  buildTreeData();
  renderTree();
  setStatus(`Deleted folder "${path}"`);
  await saveProjectData(DEFAULT_SOURCE);
}

async function moveFolderToFolder(fromNode, toPath) {
  const oldPath = fromNode.fullPath;
  const newPath = toPath ? `${toPath}\\${fromNode.name}` : fromNode.name;

  if (oldPath === newPath) return;

  const sheetName = getSheetName();
  const sheet = projectData[sheetName];
  const headers = sheet.headers || [];
  const folderIdx = headers.indexOf("Folder");
  if (folderIdx === -1) {
    setStatus("Error: Folder column not found");
    return;
  }

  // Update all rows: folder equals oldPath or starts with oldPath + "\\"
  for (const row of sheet.rows) {
    const f = row[folderIdx] || "";
    if (f === oldPath) {
      row[folderIdx] = newPath;
    } else if (f.startsWith(oldPath + "\\")) {
      row[folderIdx] = newPath + f.slice(oldPath.length);
    }
  }

  // Update customFolders
  if (projectData.customFolders) {
    projectData.customFolders = projectData.customFolders.map(p => {
      if (p === oldPath) return newPath;
      if (p.startsWith(oldPath + "\\")) return newPath + p.slice(oldPath.length);
      return p;
    });
  }

  expandedFolders.delete(oldPath);
  expandedFolders.add(newPath);
  buildTreeData();
  renderTree();
  setStatus(`Moved folder to "${newPath}"`);
  await saveProjectData(DEFAULT_SOURCE);
}

// ============ Save Project Data ============
async function saveProjectData(sourceKey = DEFAULT_SOURCE) {
  if (!projectData) {
    alert("No data to save.");
    return;
  }

  setStatus("Saving...");
  try {
    // Save project data (exclude customFolders - they are stored in folder_structure.json)
    const dataToSave = { ...projectData };
    delete dataToSave.customFolders;

    const res = await fetch(`/project_settings/${sourceKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: dataToSave,
        file_mtime: currentMtime
      })
    });

    if (res.status === 409) {
      alert("File was modified by another user. Refreshing to get latest data.");
      await loadProjectData(sourceKey);
      return;
    }
    if (res.status === 423) {
      alert("File is locked. Another user may have it open.");
      return;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    const result = await res.json();
    currentMtime = result.mtime;

    // Save folder structure to E:\ADAS\Team Profile\folder_structure.json
    const folders = Array.isArray(projectData.customFolders) ? projectData.customFolders : [];
    const foldersRes = await fetch(`/project_settings/${sourceKey}/folders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folders })
    });
    if (!foldersRes.ok) {
      setStatus(`Saved projects, but folder structure save failed: ${foldersRes.status}`);
    } else {
      setStatus("Saved successfully.");
    }
  } catch (err) {
    setStatus(`Save error: ${err.message}`);
    console.error(err);
  }
}

// ============ Initialize ============
(async function init() {
  // Expand first level by default
  expandedFolders.add("New Jersey");

  await loadProjectData(DEFAULT_SOURCE);
})();

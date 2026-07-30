/**
 * Project Settings - Project map store
 *
 * Single owner of the project map document (`projectData`), its conflict-
 * detection mtime, the derived folder/project tree, and every read/write
 * against `/project_settings/<source>`. Tree rendering and project CRUD are
 * layered on top of this store and never talk to those endpoints directly.
 */

const OBSOLETE_PROJECT_MAP_COLUMNS = new Set(["Folder", "Preload", "Project Settings", "Settings Profile"]);

export function toWinPath(pathValue) {
  return String(pathValue || "").trim().replace(/\//g, "\\");
}

export function normalizeTreePath(pathValue) {
  const raw = String(pathValue || "").trim().replace(/\//g, "\\");
  if (!raw) return "";
  const parts = raw.split("\\").map((p) => p.trim()).filter(Boolean);
  return parts.join("\\");
}

export function splitProjectTreePath(fullPath) {
  const normalized = normalizeTreePath(fullPath);
  if (!normalized) return { folderPath: "", projectName: "" };
  const parts = normalized.split("\\");
  const projectName = parts[parts.length - 1] || "";
  const folderPath = parts.length > 1 ? parts.slice(0, -1).join("\\") : "";
  return { folderPath, projectName };
}

export function joinProjectTreePath(folderPath, projectName) {
  const folder = normalizeTreePath(folderPath);
  const name = String(projectName || "").trim();
  if (!name) return "";
  return folder ? `${folder}\\${name}` : name;
}

export function pathEqualsCI(a, b) {
  return normalizeTreePath(a).toLowerCase() === normalizeTreePath(b).toLowerCase();
}

/** Add `folderPath` and each of its ancestors to a plain folder-path list. */
export function ensureFolderPathInList(foldersList, folderPath) {
  const normalized = normalizeTreePath(folderPath);
  if (!normalized || !Array.isArray(foldersList)) return;
  const parts = normalized.split("\\").filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    const nextPath = parts.slice(0, i).join("\\");
    if (!foldersList.some((p) => pathEqualsCI(p, nextPath))) {
      foldersList.push(nextPath);
    }
  }
}

export function buildEmptyProjectRow(headers, projectName) {
  const cols = Array.isArray(headers) ? headers.length : 0;
  const row = new Array(cols).fill("");
  const nameIdx = Array.isArray(headers) ? headers.indexOf("Project Name") : -1;
  if (nameIdx >= 0) {
    row[nameIdx] = String(projectName || "").trim();
  }
  return row;
}

export function removeObsoleteProjectMapColumns(data) {
  if (!data || typeof data !== "object") return data;

  for (const sheetName of Object.keys(data)) {
    if (sheetName === "customFolders" || sheetName === "projectPaths") continue;
    const sheet = data[sheetName];
    if (!sheet || typeof sheet !== "object" || !Array.isArray(sheet.headers)) continue;

    const keepIndexes = [];
    const nextHeaders = [];
    sheet.headers.forEach((header, index) => {
      if (OBSOLETE_PROJECT_MAP_COLUMNS.has(String(header || ""))) return;
      keepIndexes.push(index);
      nextHeaders.push(header);
    });

    if (keepIndexes.length === sheet.headers.length) continue;
    sheet.headers = nextHeaders;
    if (Array.isArray(sheet.rows)) {
      sheet.rows = sheet.rows.map((row) => {
        const sourceRow = Array.isArray(row) ? row : [];
        return keepIndexes.map((index) => sourceRow[index]);
      });
    }
  }

  return data;
}

/**
 * @param {object} deps
 * @param {string} deps.defaultSource   Project map source key.
 * @param {Function} deps.fetchImpl
 * @param {Function} deps.setStatus
 * @param {Function} deps.reloadProjectData  Full page reload after a conflict.
 */
export function createProjectMapStore(deps) {
  const { defaultSource, fetchImpl, setStatus, reloadProjectData } = deps;

  let projectData = null;   // Raw JSON data
  let treeData = null;      // Parsed folder -> projects structure
  let currentMtime = null;  // Track file modification time for conflict detection

  const getProjectData = () => projectData;
  const getTreeData = () => treeData;
  const getMtime = () => currentMtime;

  function ensureFolderStructureState() {
    if (!projectData || typeof projectData !== "object") return;
    if (!Array.isArray(projectData.customFolders)) projectData.customFolders = [];
    if (!Array.isArray(projectData.projectPaths)) projectData.projectPaths = [];
  }

  function ensureFolderPathWithParents(folderPath) {
    ensureFolderStructureState();
    const folder = normalizeTreePath(folderPath);
    if (!folder) return;
    ensureFolderPathInList(projectData.customFolders, folder);
  }

  function getProjectFolderFromStructure(projectName) {
    ensureFolderStructureState();
    const target = String(projectName || "").trim().toLowerCase();
    if (!target) return "Uncategorized";
    for (const fullPath of projectData.projectPaths) {
      const parsed = splitProjectTreePath(fullPath);
      if (String(parsed.projectName || "").trim().toLowerCase() === target) {
        return parsed.folderPath || "Uncategorized";
      }
    }
    return "Uncategorized";
  }

  function addProjectPathToStructure(projectName, folderPath = "Uncategorized") {
    ensureFolderStructureState();
    const project = String(projectName || "").trim();
    if (!project) return;
    const folder = normalizeTreePath(folderPath) || "Uncategorized";
    ensureFolderPathWithParents(folder);
    const full = joinProjectTreePath(folder, project);
    const exists = projectData.projectPaths.some((p) => pathEqualsCI(p, full));
    if (!exists) projectData.projectPaths.push(full);
  }

  function setProjectFolderInStructure(projectName, newFolderPath) {
    ensureFolderStructureState();
    const target = String(projectName || "").trim().toLowerCase();
    if (!target) return;
    const folder = normalizeTreePath(newFolderPath) || "Uncategorized";
    ensureFolderPathWithParents(folder);

    for (let i = 0; i < projectData.projectPaths.length; i++) {
      const parsed = splitProjectTreePath(projectData.projectPaths[i]);
      if (String(parsed.projectName || "").trim().toLowerCase() === target) {
        projectData.projectPaths[i] = joinProjectTreePath(folder, parsed.projectName);
        return;
      }
    }
    projectData.projectPaths.push(joinProjectTreePath(folder, projectName));
  }

  function removeProjectPathFromStructure(projectName) {
    ensureFolderStructureState();
    const target = String(projectName || "").trim().toLowerCase();
    if (!target) return;
    const idx = projectData.projectPaths.findIndex((p) => {
      const parsed = splitProjectTreePath(p);
      return String(parsed.projectName || "").trim().toLowerCase() === target;
    });
    if (idx >= 0) projectData.projectPaths.splice(idx, 1);
  }

  /** First sheet holding a headers/rows table (excludes folder-structure keys). */
  function getSheetName() {
    return projectData && Object.keys(projectData).find((k) => {
      if (k === "customFolders" || k === "projectPaths") return false;
      const v = projectData[k];
      return v && typeof v === "object" && Array.isArray(v.headers) && Array.isArray(v.rows);
    });
  }

  function getSheet() {
    const sheetName = getSheetName();
    return sheetName ? projectData?.[sheetName] : null;
  }

  function countProjects() {
    if (!treeData) return 0;
    let count = 0;
    for (const folder of Object.values(treeData)) {
      count += folder.projects.length;
    }
    return count;
  }

  function buildTreeData() {
    treeData = {};
    ensureFolderStructureState();

    const sheetName = getSheetName();
    if (!sheetName) return;

    const sheet = projectData[sheetName];
    if (!sheet || !Array.isArray(sheet.rows)) return;
    const headers = sheet.headers || [];
    const rows = sheet.rows || [];

    // Find column indices.
    const colIdx = {};
    headers.forEach((h, i) => {
      colIdx[h] = i;
    });

    const projectFolderMap = new Map();
    for (const fullPath of projectData.projectPaths || []) {
      const parsed = splitProjectTreePath(fullPath);
      const pName = String(parsed.projectName || "").trim();
      if (!pName) continue;
      const key = pName.toLowerCase();
      if (!projectFolderMap.has(key)) {
        projectFolderMap.set(key, parsed.folderPath || "Uncategorized");
      }
    }

    // Build folder -> projects map
    for (const row of rows) {
      const projectName = row[colIdx["Project Name"]] || "";
      const folder = projectFolderMap.get(String(projectName || "").trim().toLowerCase()) || "Uncategorized";
      const tablePath = row[colIdx["Table Path"]] || "";

      if (!projectName) continue;

      if (!treeData[folder]) {
        treeData[folder] = {
          name: folder,
          projects: []
        };
      }

      treeData[folder].projects.push({
        name: projectName,
        tablePath: tablePath,
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

  /** Resolve a stored `{name, folder, tablePath}` snapshot back to a live node. */
  function findProjectBySnapshot(snapshot) {
    if (!snapshot || !treeData || typeof treeData !== "object") return null;

    const nameKey = String(snapshot.name || "").trim().toLowerCase();
    if (!nameKey) return null;
    const folderKey = normalizeTreePath(snapshot.folder || "").toLowerCase();
    const tablePathKey = toWinPath(snapshot.tablePath || "").toLowerCase();

    const candidates = [];
    for (const folderData of Object.values(treeData)) {
      const projects = Array.isArray(folderData?.projects) ? folderData.projects : [];
      for (const project of projects) {
        const projectName = String(project?.name || "").trim().toLowerCase();
        if (projectName === nameKey) candidates.push(project);
      }
    }
    if (!candidates.length) return null;

    const byFolderAndTablePath = candidates.find((project) => {
      const projectFolder = normalizeTreePath(project.folder || "").toLowerCase();
      const projectTablePath = toWinPath(project.tablePath || "").toLowerCase();
      return !!folderKey && !!tablePathKey && projectFolder === folderKey && projectTablePath === tablePathKey;
    });
    if (byFolderAndTablePath) return byFolderAndTablePath;

    const byFolder = candidates.find((project) => {
      const projectFolder = normalizeTreePath(project.folder || "").toLowerCase();
      return !!folderKey && projectFolder === folderKey;
    });
    if (byFolder) return byFolder;

    return candidates[0];
  }

  /** Read the project map and its virtual folder structure, then rebuild the tree. */
  async function load(sourceKey = defaultSource) {
    const res = await fetchImpl(`/project_settings/${sourceKey}`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const result = await res.json();
    projectData = result.data;
    currentMtime = result.mtime;
    removeObsoleteProjectMapColumns(projectData);

    // Load virtual folder structure from projects/index.json.
    try {
      let folders = [];
      let projectPaths = [];

      const foldersRes = await fetchImpl(`/project_settings/${sourceKey}/folders`);
      if (foldersRes.ok) {
        const foldersResult = await foldersRes.json();
        folders = Array.isArray(foldersResult.folders) ? foldersResult.folders : [];
        projectPaths = Array.isArray(foldersResult.project_paths) ? foldersResult.project_paths : [];
      }

      projectData.customFolders = Array.isArray(folders) ? folders : [];
      projectData.projectPaths = Array.isArray(projectPaths) ? projectPaths : [];
    } catch {
      projectData.customFolders = [];
      projectData.projectPaths = [];
    }

    buildTreeData();
    return { path: result.path };
  }

  async function updateCurrentMtimeFromResponse(response) {
    try {
      const result = await response.json();
      const nextMtime = Number(result?.mtime);
      if (Number.isFinite(nextMtime)) {
        currentMtime = nextMtime;
      }
      return result;
    } catch {
      return null;
    }
  }

  /** POST the virtual folder structure; throws with a step-labelled message. */
  async function saveFolderStructure(folders, projectPaths, { label = "Folder structure save" } = {}) {
    const res = await fetchImpl(`/project_settings/${defaultSource}/folders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folders, project_paths: projectPaths }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`${label} failed: ${errText}`);
    }
    await updateCurrentMtimeFromResponse(res);
  }

  /**
   * Persist a copy of the project map with `mutateRows(rows)` applied, without
   * touching the in-memory document. Throws on conflict, lock, or HTTP error.
   */
  async function saveProjectMapRows(sheetName, mutateRows) {
    const dataToSave = { ...projectData };
    const currentSheet = dataToSave[sheetName] || {};
    const currentRows = Array.isArray(currentSheet.rows)
      ? currentSheet.rows.map((row) => (Array.isArray(row) ? [...row] : row))
      : [];
    mutateRows(currentRows);
    dataToSave[sheetName] = { ...currentSheet, rows: currentRows };
    delete dataToSave.customFolders;
    delete dataToSave.projectPaths;
    removeObsoleteProjectMapColumns(dataToSave);

    const res = await fetchImpl(`/project_settings/${defaultSource}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: dataToSave,
        file_mtime: currentMtime,
      }),
    });

    if (res.status === 409) {
      throw new Error("File was modified by another user. Please refresh and try again.");
    }
    if (res.status === 423) {
      throw new Error("File is locked. Another user may have it open.");
    }
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Save failed: HTTP ${res.status}: ${errText}`);
    }

    const saveResult = await res.json();
    currentMtime = saveResult.mtime;
    return saveResult;
  }

  /** Save the in-memory project map plus its folder structure. */
  async function save(sourceKey = defaultSource) {
    if (!projectData) {
      alert("No data to save.");
      return false;
    }

    setStatus("Saving...");
    try {
      // Save project data (exclude folder structure fields - stored in projects/index.json folders)
      const dataToSave = { ...projectData };
      delete dataToSave.customFolders;
      delete dataToSave.projectPaths;
      removeObsoleteProjectMapColumns(dataToSave);

      const res = await fetchImpl(`/project_settings/${sourceKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: dataToSave,
          file_mtime: currentMtime
        })
      });

      if (res.status === 409) {
        alert("File was modified by another user. Refreshing to get latest data.");
        await reloadProjectData(sourceKey);
        return false;
      }
      if (res.status === 423) {
        alert("File is locked. Another user may have it open.");
        return false;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const result = await res.json();
      currentMtime = result.mtime;

      // Save virtual folder structure to projects/index.json
      const folders = Array.isArray(projectData.customFolders) ? projectData.customFolders : [];
      const project_paths = Array.isArray(projectData.projectPaths) ? projectData.projectPaths : [];
      const foldersRes = await fetchImpl(`/project_settings/${sourceKey}/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folders, project_paths })
      });
      if (!foldersRes.ok) {
        setStatus(`Saved projects, but project index folder save failed: ${foldersRes.status}`);
        return false;
      }
      await updateCurrentMtimeFromResponse(foldersRes);
      setStatus("Saved successfully.");
      return true;
    } catch (err) {
      setStatus(`Save error: ${err.message}`);
      console.error(err);
      return false;
    }
  }

  return {
    addProjectPathToStructure,
    buildTreeData,
    countProjects,
    ensureFolderPathWithParents,
    ensureFolderStructureState,
    findProjectBySnapshot,
    getMtime,
    getProjectData,
    getProjectFolderFromStructure,
    getSheet,
    getSheetName,
    getTreeData,
    load,
    removeProjectPathFromStructure,
    save,
    saveFolderStructure,
    saveProjectMapRows,
    setProjectFolderInStructure,
    updateCurrentMtimeFromResponse,
  };
}

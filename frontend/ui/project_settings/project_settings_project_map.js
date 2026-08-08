/**
 * Project Settings - Project map store
 *
 * Single owner of the project registry document (`projectData`), its conflict-
 * detection mtime, the derived folder/project tree, and every read/write
 * against `/project_settings/<source>`. The registry is virtual folders plus
 * project paths (`Folder\Sub\Project`); each path's leaf segment is the
 * project name. Tree rendering and project CRUD are layered on top of this
 * store and never talk to those endpoints directly.
 */

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

/**
 * @param {object} deps
 * @param {string} deps.defaultSource   Project map source key.
 * @param {Function} deps.fetchImpl
 * @param {Function} deps.setStatus
 * @param {Function} deps.reloadProjectData  Full page reload after a conflict.
 */
export function createProjectMapStore(deps) {
  const { defaultSource, fetchImpl, setStatus, reloadProjectData } = deps;

  let projectData = null;   // { customFolders: [], projectPaths: [] }
  let treeData = null;      // Parsed folder -> projects structure
  let currentMtime = null;  // Track file modification time for conflict detection

  const getProjectData = () => projectData;
  const getTreeData = () => treeData;
  const getMtime = () => currentMtime;

  function ensureFolderStructureState() {
    if (!projectData || typeof projectData !== "object") {
      projectData = { customFolders: [], projectPaths: [] };
    }
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

  /** Every project name in the registry, in path order. */
  function listProjectNames() {
    ensureFolderStructureState();
    const names = [];
    const seen = new Set();
    for (const fullPath of projectData.projectPaths) {
      const name = String(splitProjectTreePath(fullPath).projectName || "").trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
    return names;
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

    // Build folder -> projects map; each project path's leaf is the project.
    const seenProjects = new Set();
    for (const fullPath of projectData.projectPaths) {
      const parsed = splitProjectTreePath(fullPath);
      const projectName = String(parsed.projectName || "").trim();
      const projectKey = projectName.toLowerCase();
      if (!projectName || seenProjects.has(projectKey)) continue;
      seenProjects.add(projectKey);
      const folder = parsed.folderPath || "Uncategorized";

      if (!treeData[folder]) {
        treeData[folder] = {
          name: folder,
          projects: []
        };
      }

      treeData[folder].projects.push({
        name: projectName,
        folder: folder
      });
    }

    // Merge custom (empty) folders so they appear in the tree
    for (const folderPath of projectData.customFolders) {
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

  /** Resolve a stored `{name, folder}` snapshot back to a live node. */
  function findProjectBySnapshot(snapshot) {
    if (!snapshot || !treeData || typeof treeData !== "object") return null;

    const nameKey = String(snapshot.name || "").trim().toLowerCase();
    if (!nameKey) return null;
    const folderKey = normalizeTreePath(snapshot.folder || "").toLowerCase();

    const candidates = [];
    for (const folderData of Object.values(treeData)) {
      const projects = Array.isArray(folderData?.projects) ? folderData.projects : [];
      for (const project of projects) {
        const projectName = String(project?.name || "").trim().toLowerCase();
        if (projectName === nameKey) candidates.push(project);
      }
    }
    if (!candidates.length) return null;

    const byFolder = candidates.find((project) => {
      const projectFolder = normalizeTreePath(project.folder || "").toLowerCase();
      return !!folderKey && projectFolder === folderKey;
    });
    if (byFolder) return byFolder;

    return candidates[0];
  }

  /** Read the project registry, then rebuild the tree. */
  async function load(sourceKey = defaultSource) {
    const res = await fetchImpl(`/project_settings/${sourceKey}`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const result = await res.json();
    projectData = {
      customFolders: Array.isArray(result.folders) ? result.folders : [],
      projectPaths: Array.isArray(result.project_paths) ? result.project_paths : [],
    };
    currentMtime = result.mtime;

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

  /** POST one registry document; shared by `save` and `saveFolderStructure`. */
  async function postRegistry(sourceKey, folders, projectPaths) {
    return fetchImpl(`/project_settings/${sourceKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folders,
        project_paths: projectPaths,
        file_mtime: currentMtime,
      }),
    });
  }

  /**
   * Persist an explicit folder/path structure without touching the in-memory
   * document. Throws with a step-labelled message on conflict, lock, or error.
   */
  async function saveFolderStructure(folders, projectPaths, { label = "Folder structure save" } = {}) {
    const res = await postRegistry(defaultSource, folders, projectPaths);
    if (res.status === 409) {
      throw new Error(`${label} failed: the project registry was modified by another user. Please refresh and try again.`);
    }
    if (res.status === 423) {
      throw new Error(`${label} failed: the project registry is locked. Another user may have it open.`);
    }
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`${label} failed: ${errText}`);
    }
    await updateCurrentMtimeFromResponse(res);
  }

  /** Save the in-memory registry document. */
  async function save(sourceKey = defaultSource) {
    if (!projectData) {
      alert("No data to save.");
      return false;
    }

    setStatus("Saving...");
    try {
      ensureFolderStructureState();
      const res = await postRegistry(
        sourceKey,
        projectData.customFolders,
        projectData.projectPaths,
      );

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

      await updateCurrentMtimeFromResponse(res);
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
    getTreeData,
    listProjectNames,
    load,
    removeProjectPathFromStructure,
    save,
    saveFolderStructure,
    setProjectFolderInStructure,
    updateCurrentMtimeFromResponse,
  };
}

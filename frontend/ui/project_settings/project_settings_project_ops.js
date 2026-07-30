/**
 * Project Settings - Project and folder operations
 *
 * Create / rename / duplicate / delete for projects, plus virtual folder
 * create / rename / delete / move. Every multi-step operation writes the
 * on-disk folder first, then the folder structure, then the project map, and
 * rolls the earlier steps back in reverse order when a later one fails.
 */
import {
  buildEmptyProjectRow,
  ensureFolderPathInList,
  joinProjectTreePath,
  normalizeTreePath,
  pathEqualsCI,
  splitProjectTreePath,
} from "/ui/project_settings/project_settings_project_map.js?v=20260730split1";

/**
 * @param {object} deps
 * @param {string} deps.defaultSource
 * @param {Function} deps.fetchImpl
 * @param {object} deps.store              Project map store.
 * @param {object} deps.treeView           Project Explorer feature.
 * @param {Function} deps.setStatus
 * @param {Function} deps.showDialog
 * @param {Function} deps.showConfirm
 * @param {Function} deps.showProgress
 * @param {Function} deps.hideProgress
 * @param {Function} deps.appendAuditLogAction
 * @param {Function} deps.getSelectedProject
 * @param {Function} deps.setSelectedProject
 * @param {Function} deps.selectProject
 * @param {Function} deps.showProjectDetails
 * @param {Function} deps.clearProjectSelection
 * @param {Function} deps.reloadProjectData
 */
export function createProjectOpsFeature(deps) {
  const {
    defaultSource,
    fetchImpl,
    store,
    treeView,
    setStatus,
    showDialog,
    showConfirm,
    showProgress,
    hideProgress,
    appendAuditLogAction,
    getSelectedProject,
    setSelectedProject,
    selectProject,
    showProjectDetails,
    clearProjectSelection,
    reloadProjectData,
  } = deps;

  const postJson = (endpoint, body) => fetchImpl(`/project_settings/${defaultSource}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  function refreshTree() {
    store.buildTreeData();
    treeView.render();
  }

  /** Report a blocking failure on both the status bar and a modal alert. */
  function failOperation(message) {
    setStatus(message);
    alert(message);
  }

  /** Restore the previously saved folder structure after a failed step. */
  async function rollbackFolderStructure(foldersBefore, projectPathsBefore) {
    try {
      await store.saveFolderStructure(foldersBefore, projectPathsBefore, { label: "Folder structure rollback" });
      return "";
    } catch (err) {
      return ` ${err.message}`;
    }
  }

  /** Undo an on-disk project folder create/copy after a failed later step. */
  async function rollbackProjectFolder(endpoint, body) {
    try {
      const res = await postJson(endpoint, body);
      if (!res.ok) {
        const text = await res.text();
        return ` Folder rollback failed: ${text}`;
      }
      return "";
    } catch (err) {
      return ` Folder rollback failed: ${err.message}`;
    }
  }

  function findNameColumn(sheet) {
    const headers = Array.isArray(sheet?.headers) ? sheet.headers : [];
    return { headers, nameIdx: headers.indexOf("Project Name") };
  }

  function projectNameTaken(rows, nameIdx, candidate, skipIndex = -1) {
    const key = String(candidate || "").trim().toLowerCase();
    return rows.some((row, idx) => (
      idx !== skipIndex && String((row && row[nameIdx]) || "").trim().toLowerCase() === key
    ));
  }

  // ---- Project operations ----

  async function createProjectInFolder(folderNode) {
    const targetFolderPath = normalizeTreePath(folderNode?.fullPath) || "Uncategorized";
    const enteredName = await showDialog("Enter new project name:", "");
    if (!enteredName) return;
    const newProjectName = enteredName.trim();
    if (!newProjectName) return;

    const projectData = store.getProjectData();
    const sheetName = store.getSheetName();
    const sheet = store.getSheet();
    const { headers, nameIdx } = findNameColumn(sheet);
    const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];
    if (nameIdx === -1) {
      failOperation("Error: Project Name column not found");
      return;
    }
    if (projectNameTaken(rows, nameIdx, newProjectName)) {
      failOperation(`Project "${newProjectName}" already exists.`);
      return;
    }

    const newRow = buildEmptyProjectRow(headers, newProjectName);
    let folderCreated = false;
    let folderStructureSaved = false;
    const foldersBefore = Array.isArray(projectData?.customFolders) ? [...projectData.customFolders] : [];
    const projectPathsBefore = Array.isArray(projectData?.projectPaths) ? [...projectData.projectPaths] : [];
    const foldersNext = [...foldersBefore];
    const projectPathsNext = [...projectPathsBefore];

    setStatus(`Creating "${newProjectName}"...`);

    try {
      // 1) Create project folder on disk first so later saves do not create orphan map entries.
      const createFolderRes = await postJson("create_project_folder", { name: newProjectName });
      if (!createFolderRes.ok) {
        throw new Error(`Folder create failed: ${await createFolderRes.text()}`);
      }
      await createFolderRes.json();
      folderCreated = true;

      // 2) Save folder structure with the new project path.
      ensureFolderPathInList(foldersNext, targetFolderPath);
      const newFullPath = joinProjectTreePath(targetFolderPath || "Uncategorized", newProjectName);
      if (!projectPathsNext.some((p) => pathEqualsCI(p, newFullPath))) {
        projectPathsNext.push(newFullPath);
      }
      await store.saveFolderStructure(foldersNext, projectPathsNext);
      folderStructureSaved = true;

      // 3) Save new empty project row to settings JSON.
      await store.saveProjectMapRows(sheetName, (rowsCopy) => rowsCopy.push(newRow));

      // 4) Commit in-memory/UI after the app server succeeds.
      sheet.rows.push(newRow);
      projectData.customFolders = foldersNext;
      projectData.projectPaths = projectPathsNext;
      treeView.expandFolder(targetFolderPath);
      refreshTree();

      const createdProject = store.findProjectBySnapshot({ name: newProjectName, folder: targetFolderPath });
      if (createdProject) {
        selectProject(createdProject);
      }

      setStatus(`Created project "${newProjectName}"`);
      await appendAuditLogAction(newProjectName, `Created empty project in folder "${targetFolderPath}"`);
    } catch (e) {
      let rollbackError = "";
      if (folderStructureSaved) {
        rollbackError += await rollbackFolderStructure(foldersBefore, projectPathsBefore);
      }
      if (folderCreated) {
        rollbackError += await rollbackProjectFolder("delete_project_folder", { name: newProjectName });
      }
      failOperation(`Create project failed: ${e.message}${rollbackError}`);
      try {
        await reloadProjectData(defaultSource);
      } catch {}
    }
  }

  async function renameProject(project) {
    const enteredName = await showDialog("Enter new project name:", project.name);
    if (!enteredName) return;
    const newName = enteredName.trim();
    const oldName = String(project.name || "").trim();
    if (!newName || newName === oldName) return;

    const projectData = store.getProjectData();
    const sheetName = store.getSheetName();
    const sheet = store.getSheet();
    const { nameIdx } = findNameColumn(sheet);
    if (nameIdx === -1) {
      failOperation("Error: Project Name column not found");
      return;
    }

    const rowIndex = sheet.rows.indexOf(project._row);
    if (rowIndex === -1) {
      failOperation("Error: Project row not found");
      return;
    }
    if (projectNameTaken(sheet.rows, nameIdx, newName, rowIndex)) {
      failOperation(`Project "${newName}" already exists.`);
      return;
    }

    setStatus(`Renaming "${oldName}" to "${newName}"...`);
    let folderRenamed = false;
    let folderStructureSaved = false;
    const oldFolderPath = store.getProjectFolderFromStructure(oldName);
    const foldersBefore = Array.isArray(projectData.customFolders) ? [...projectData.customFolders] : [];
    const projectPathsBefore = Array.isArray(projectData.projectPaths) ? [...projectData.projectPaths] : [];

    try {
      // 1) Rename folder first. If this fails, abort before touching JSON/UI.
      const renameFolderRes = await postJson("rename_project_folder", { old_name: oldName, new_name: newName });
      if (!renameFolderRes.ok) {
        throw new Error(`Folder rename failed: ${await renameFolderRes.text()}`);
      }
      const renameFolderResult = await renameFolderRes.json();

      // Treat missing source folder as a hard failure for rename.
      if (renameFolderResult?.message && /source folder does not exist/i.test(String(renameFolderResult.message))) {
        throw new Error(`Folder rename failed: ${renameFolderResult.message}`);
      }
      folderRenamed = !!(renameFolderResult?.old_folder && renameFolderResult?.new_folder);

      // 2) Save folder structure with renamed project path.
      const foldersNext = [...foldersBefore];
      const projectPathsNext = [...projectPathsBefore];
      let foundPath = false;
      for (let i = 0; i < projectPathsNext.length; i++) {
        const parsed = splitProjectTreePath(projectPathsNext[i]);
        if (String(parsed.projectName || "").trim().toLowerCase() === oldName.toLowerCase()) {
          projectPathsNext[i] = joinProjectTreePath(parsed.folderPath || "Uncategorized", newName);
          foundPath = true;
          break;
        }
      }
      if (!foundPath) {
        projectPathsNext.push(joinProjectTreePath(oldFolderPath || "Uncategorized", newName));
      }
      await store.saveFolderStructure(foldersNext, projectPathsNext);
      folderStructureSaved = true;

      // 3) Save renamed project name into projects/index.json.
      await store.saveProjectMapRows(sheetName, (rowsCopy) => {
        if (rowIndex < 0 || rowIndex >= rowsCopy.length || !Array.isArray(rowsCopy[rowIndex])) {
          throw new Error("Project row not found while preparing save.");
        }
        rowsCopy[rowIndex][nameIdx] = newName;
      });

      // 4) Commit UI updates only after app-server steps succeed.
      project._row[nameIdx] = newName;
      project.name = newName;
      projectData.projectPaths = projectPathsNext;
      refreshTree();
      if (getSelectedProject() === project) {
        showProjectDetails(project);
      }
      setStatus(`Renamed to "${newName}"`);
      await appendAuditLogAction(newName, `Renamed project from "${oldName}" to "${newName}"`);
    } catch (e) {
      let rollbackError = "";
      if (folderStructureSaved) {
        rollbackError += await rollbackFolderStructure(foldersBefore, projectPathsBefore);
      }
      if (folderRenamed) {
        rollbackError += await rollbackProjectFolder("rename_project_folder", { old_name: newName, new_name: oldName });
      }
      failOperation(`Rename failed: ${e.message}${rollbackError}`);
      try {
        await reloadProjectData(defaultSource);
      } catch {}
    }
  }

  function getNextDuplicateName(baseName) {
    const sheet = store.getSheet();
    const { nameIdx } = findNameColumn(sheet);
    const existingNames = new Set(sheet.rows.map(row => row[nameIdx]));

    // Remove an existing index suffix like "(2)" before searching for the next free one.
    const baseWithoutIndex = baseName.replace(/\s*\(\d+\)\s*$/, "").trim();

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
    const newProjectName = newName.trim();
    if (!newProjectName) return;

    const projectData = store.getProjectData();
    const sheetName = store.getSheetName();
    const sheet = store.getSheet();
    const { nameIdx } = findNameColumn(sheet);
    if (nameIdx === -1) {
      failOperation("Error: Project Name column not found");
      return;
    }
    if (projectNameTaken(sheet.rows, nameIdx, newProjectName)) {
      failOperation(`Project "${newProjectName}" already exists.`);
      return;
    }

    setStatus(`Duplicating as "${newProjectName}"...`);
    const newRow = [...project._row];
    newRow[nameIdx] = newProjectName;

    let folderCopied = false;
    let folderStructureSaved = false;
    const foldersBefore = Array.isArray(projectData.customFolders) ? [...projectData.customFolders] : [];
    const projectPathsBefore = Array.isArray(projectData.projectPaths) ? [...projectData.projectPaths] : [];
    try {
      // 1) Copy folder first.
      showProgress(`Duplicating "${project.name}" to "${newProjectName}"...`);
      const copyRes = await postJson("duplicate_project_folder", { old_name: project.name, new_name: newProjectName });
      if (!copyRes.ok) {
        throw new Error(`Folder copy failed: ${await copyRes.text()}`);
      }
      const copyResult = await copyRes.json();
      if (copyResult && copyResult.message) {
        throw new Error(`Folder copy failed: ${copyResult.message}`);
      }
      folderCopied = true;
      showProgress(`Finalizing "${newProjectName}"...`);

      // 2) Save folder structure with the new project path.
      const sourceFolderPath = store.getProjectFolderFromStructure(project.name);
      const foldersNext = [...foldersBefore];
      const projectPathsNext = [...projectPathsBefore];
      const newFullPath = joinProjectTreePath(sourceFolderPath || "Uncategorized", newProjectName);
      if (!projectPathsNext.some((p) => pathEqualsCI(p, newFullPath))) {
        projectPathsNext.push(newFullPath);
      }
      await store.saveFolderStructure(foldersNext, projectPathsNext);
      folderStructureSaved = true;

      // 3) Save duplicated project row to settings JSON.
      await store.saveProjectMapRows(sheetName, (rowsCopy) => rowsCopy.push(newRow));

      // 4) Commit to in-memory/UI only after app-server steps succeed.
      sheet.rows.push(newRow);
      projectData.projectPaths = projectPathsNext;
      refreshTree();
      hideProgress();
      setStatus(`Duplicated "${newProjectName}"`);
      await appendAuditLogAction(newProjectName, `Duplicated from project "${project.name}"`);
    } catch (e) {
      hideProgress();
      let rollbackError = "";
      if (folderStructureSaved) {
        rollbackError += await rollbackFolderStructure(foldersBefore, projectPathsBefore);
      }
      if (folderCopied) {
        rollbackError += await rollbackProjectFolder("delete_project_folder", { name: newProjectName });
      }
      failOperation(`Duplicate failed: ${e.message}${rollbackError}`);
      try {
        await reloadProjectData(defaultSource);
      } catch {}
    }
  }

  async function deleteProject(project) {
    const deletedProjectName = project.name;
    const confirmed = await showConfirm(`Are you sure you want to delete "${project.name}"?`, "Delete Project");
    if (!confirmed) return;

    const sheet = store.getSheet();
    const { nameIdx } = findNameColumn(sheet);
    const deletedNameKey = String(deletedProjectName || "").trim().toLowerCase();

    // Find and remove the row
    const rowIndex = sheet.rows.indexOf(project._row);
    if (rowIndex === -1) {
      setStatus("Error: Project row not found");
      return;
    }
    const removedRow = sheet.rows[rowIndex];
    sheet.rows.splice(rowIndex, 1);

    // If another row with the same project name still exists, keep project path mapping.
    const duplicateNameExists = nameIdx >= 0 && sheet.rows.some((row) => {
      const rowName = String((row && row[nameIdx]) || "").trim().toLowerCase();
      return rowName && rowName === deletedNameKey;
    });
    const removedFolderPath = store.getProjectFolderFromStructure(deletedProjectName);
    if (!duplicateNameExists) {
      store.removeProjectPathFromStructure(deletedProjectName);
    }

    const selected = getSelectedProject();
    if (selected && selected.name === project.name) {
      clearProjectSelection();
    }

    refreshTree();

    setStatus(`Deleting "${project.name}"...`);
    const saved = await store.save(defaultSource);
    if (!saved) {
      sheet.rows.splice(rowIndex, 0, removedRow);
      if (!duplicateNameExists) {
        store.addProjectPathToStructure(deletedProjectName, removedFolderPath || "Uncategorized");
      }
      refreshTree();
      return;
    }

    // If another row with the same project name still exists, keep the folder on disk.
    if (duplicateNameExists) {
      setStatus(`Deleted "${deletedProjectName}". Folder kept because another project with the same name still exists.`);
      return;
    }

    // Delete the project folder on disk (e.g. E:\ArcRho\projects\ProjectName)
    try {
      const res = await postJson("delete_project_folder", { name: deletedProjectName });
      if (res.ok) {
        const result = await res.json();
        setStatus(`Deleted "${deletedProjectName}"` + (result.message ? ` (${result.message})` : ""));
      } else {
        setStatus(`Deleted in data but folder delete failed: ${await res.text()}`);
      }
    } catch (e) {
      setStatus(`Deleted in data but folder delete failed: ${e.message}`);
    }
  }

  async function moveProjectToFolder(project, newFolder) {
    const oldFolder = project.folder;
    if (oldFolder === newFolder) return;
    store.setProjectFolderInStructure(project.name, newFolder);
    project.folder = normalizeTreePath(newFolder) || "Uncategorized";

    refreshTree();

    // Rebuilding the tree replaces the nodes, so re-point the selection at the
    // moved project object that already carries the new folder.
    const selected = getSelectedProject();
    if (selected && selected.name === project.name) {
      setSelectedProject(project);
      showProjectDetails(project);
    }

    setStatus(`Moving "${project.name}" to "${newFolder}"...`);
    const saved = await store.save(defaultSource);
    if (saved) {
      const fromFolder = normalizeTreePath(oldFolder) || "Uncategorized";
      const toFolder = normalizeTreePath(newFolder) || "Uncategorized";
      await appendAuditLogAction(project.name, `Moved project folder: "${fromFolder}" -> "${toFolder}"`);
    }
  }

  // ---- Virtual folder operations ----

  /** Rewrite one folder path prefix across `customFolders` and `projectPaths`. */
  function remapFolderPaths(oldPath, newPath) {
    const projectData = store.getProjectData();
    const oldPrefix = (oldPath + "\\").toLowerCase();

    projectData.customFolders = projectData.customFolders.map((p) => {
      const norm = normalizeTreePath(p);
      if (pathEqualsCI(norm, oldPath)) return newPath;
      if (norm.toLowerCase().startsWith(oldPrefix)) return newPath + norm.slice(oldPath.length);
      return norm;
    });
    store.ensureFolderPathWithParents(newPath);

    projectData.projectPaths = projectData.projectPaths.map((full) => {
      const parsed = splitProjectTreePath(full);
      const folder = normalizeTreePath(parsed.folderPath || "");
      if (pathEqualsCI(folder, oldPath)) {
        return joinProjectTreePath(newPath, parsed.projectName);
      }
      if (folder.toLowerCase().startsWith(oldPrefix)) {
        return joinProjectTreePath(newPath + folder.slice(oldPath.length), parsed.projectName);
      }
      return joinProjectTreePath(folder || "Uncategorized", parsed.projectName);
    });
  }

  async function createFolderAt(newPath, statusMessage, extraExpandPath = "") {
    store.ensureFolderStructureState();
    if (store.getProjectData().customFolders.some((p) => pathEqualsCI(p, newPath))) {
      setStatus("Folder already exists.");
      return;
    }

    store.ensureFolderPathWithParents(newPath);
    if (extraExpandPath) treeView.expandFolder(extraExpandPath);
    treeView.expandFolder(newPath);
    refreshTree();
    setStatus(statusMessage);
    await store.save(defaultSource);
  }

  async function createSubfolder(parentNode) {
    const name = await showDialog("Enter subfolder name:", "");
    if (!name || !name.trim()) return;

    const newPath = normalizeTreePath(parentNode.fullPath ? `${parentNode.fullPath}\\${name.trim()}` : name.trim());
    await createFolderAt(newPath, `Created subfolder "${name.trim()}"`, parentNode.fullPath);
  }

  async function createRootFolder() {
    const name = await showDialog("Enter root folder name:", "");
    if (!name || !name.trim()) return;

    const newPath = normalizeTreePath(name.trim());
    await createFolderAt(newPath, `Created root folder "${newPath}"`);
  }

  async function renameFolder(node) {
    const currentName = node.name;
    const newName = await showDialog("Enter folder name:", currentName);
    if (!newName || newName.trim() === "" || newName === currentName) return;

    const oldPath = normalizeTreePath(node.fullPath);
    const parentPath = oldPath.includes("\\") ? oldPath.replace(/\\[^\\]+$/, "") : "";
    const newPath = normalizeTreePath(parentPath ? `${parentPath}\\${newName.trim()}` : newName.trim());

    if (oldPath === newPath) return;

    store.ensureFolderStructureState();
    remapFolderPaths(oldPath, newPath);

    treeView.collapseFolder(oldPath);
    treeView.expandFolder(newPath);
    refreshTree();
    setStatus(`Renamed folder to "${newName.trim()}"`);
    await store.save(defaultSource);
  }

  async function deleteFolder(node) {
    const path = normalizeTreePath(node.fullPath);
    const confirmed = await showConfirm(`Delete folder "${path}"? Projects inside will be moved to the parent folder.`, "Delete Folder");
    if (!confirmed) return;

    const parentPath = path.includes("\\") ? path.replace(/\\[^\\]+$/, "") : "";
    const targetPath = parentPath || "Uncategorized";
    store.ensureFolderStructureState();
    const projectData = store.getProjectData();
    const pathPrefix = (path + "\\").toLowerCase();

    // Move all projects under this folder to the parent.
    projectData.projectPaths = projectData.projectPaths.map((full) => {
      const parsed = splitProjectTreePath(full);
      const folder = normalizeTreePath(parsed.folderPath || "");
      if (pathEqualsCI(folder, path)) {
        return joinProjectTreePath(targetPath, parsed.projectName);
      }
      if (folder.toLowerCase().startsWith(pathPrefix)) {
        const rest = folder.slice(path.length + 1);
        const movedFolder = targetPath === "Uncategorized" ? rest : `${targetPath}\\${rest}`;
        return joinProjectTreePath(movedFolder, parsed.projectName);
      }
      return joinProjectTreePath(folder || "Uncategorized", parsed.projectName);
    });

    // Remove folder and descendants from customFolders.
    projectData.customFolders = projectData.customFolders.filter((p) => {
      const norm = normalizeTreePath(p);
      return !pathEqualsCI(norm, path) && !norm.toLowerCase().startsWith(pathPrefix);
    });

    treeView.collapseFolder(path);
    refreshTree();
    setStatus(`Deleted folder "${path}"`);
    await store.save(defaultSource);
  }

  async function moveFolderToFolder(fromNode, toPath) {
    const oldPath = normalizeTreePath(fromNode.fullPath);
    const newPath = normalizeTreePath(toPath ? `${toPath}\\${fromNode.name}` : fromNode.name);

    if (oldPath === newPath) return;
    store.ensureFolderStructureState();
    remapFolderPaths(oldPath, newPath);

    treeView.collapseFolder(oldPath);
    treeView.expandFolder(newPath);
    refreshTree();
    setStatus(`Moved folder to "${newPath}"`);
    await store.save(defaultSource);
  }

  return {
    createProjectInFolder,
    createRootFolder,
    createSubfolder,
    deleteFolder,
    deleteProject,
    duplicateProject,
    moveFolderToFolder,
    moveProjectToFolder,
    renameFolder,
    renameProject,
  };
}

/**
 * Project Settings - Project and folder operations
 *
 * Create / rename / duplicate / delete for projects, plus virtual folder
 * create / rename / delete / move. Every multi-step operation writes the
 * on-disk folder first, then the project registry (folders + project paths).
 * Duplicate jobs retain their server target and durable recovery state when
 * frontend metadata finalization cannot finish immediately.
 */
import {
  ensureFolderPathInList,
  joinProjectTreePath,
  normalizeTreePath,
  pathEqualsCI,
  splitProjectTreePath,
} from "/ui/project_settings/project_settings_project_map.js?v=20260807idx1";
import {
  clearPendingDuplicateJob,
  createDuplicateRequestId,
  createDuplicateWorkspaceScope,
  loadPendingDuplicateJob,
  readDuplicateResponseError,
  savePendingDuplicateJob,
  waitForDuplicateProjectJob,
} from "/ui/project_settings/project_settings_duplicate_job.js?v=20260807idx1";

function getLocalStorageSafely() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

const DEFINITIVE_DUPLICATE_SUBMISSION_STATUSES = new Set([
  400, 401, 403, 404, 405, 409, 410, 422,
]);

/**
 * @param {object} deps
 * @param {string} deps.defaultSource
 * @param {Function} deps.fetchImpl
 * @param {object} deps.store              Project map store.
 * @param {object} deps.treeView           Project Explorer feature.
 * @param {Function} deps.setStatus
 * @param {Function} deps.showDialog
 * @param {Function} deps.showConfirm
 * @param {Function} deps.publishShellProgress
 * @param {Function} [deps.waitForDuplicatePoll]
 * @param {Storage} [deps.pendingJobStorage]
 * @param {Function} [deps.duplicateNow]
 * @param {Function} [deps.duplicateRequestIdFactory]
 * @param {number} [deps.duplicateStaleStatusMs]
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
    publishShellProgress,
    waitForDuplicatePoll = (delayMs) => new Promise((resolve) => window.setTimeout(resolve, delayMs)),
    pendingJobStorage: configuredPendingJobStorage,
    duplicateNow = () => Date.now(),
    duplicateRequestIdFactory = createDuplicateRequestId,
    duplicateStaleStatusMs,
    appendAuditLogAction,
    getSelectedProject,
    setSelectedProject,
    selectProject,
    showProjectDetails,
    clearProjectSelection,
    reloadProjectData,
  } = deps;
  const pendingJobStorage = configuredPendingJobStorage === undefined
    ? getLocalStorageSafely()
    : configuredPendingJobStorage;

  const postJson = (endpoint, body) => fetchImpl(`/project_settings/${defaultSource}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const publishDuplicateProgress = (action, progressId, details = {}) => publishShellProgress?.({
    type: "arcrho:project-settings-progress",
    action,
    progressId,
    ...details,
  });

  let duplicateProjectInFlight = false;
  let workspaceScope = "";
  const inMemoryPendingDuplicates = new Map();
  const settledDuplicateJobs = new Map();

  const pendingMemoryKey = (sourceKey, scope) => `${sourceKey}\u0000${scope}`;

  function rememberPendingDuplicate(record) {
    if (!record?.workspaceScope || !record?.requestId) return record;
    const key = pendingMemoryKey(record.sourceKey, record.workspaceScope);
    inMemoryPendingDuplicates.set(key, record);
    settledDuplicateJobs.delete(key);
    return record;
  }

  function settlePendingDuplicate(record) {
    if (!record?.workspaceScope || !record?.requestId) return;
    const key = pendingMemoryKey(record.sourceKey, record.workspaceScope);
    if (inMemoryPendingDuplicates.get(key)?.requestId === record.requestId) {
      inMemoryPendingDuplicates.delete(key);
    }
    settledDuplicateJobs.set(key, record.requestId);
    clearPendingDuplicateJob(
      pendingJobStorage,
      record.sourceKey,
      record.workspaceScope,
      record.requestId,
    );
  }

  function loadPendingDuplicateFor(sourceKey, scope) {
    const key = pendingMemoryKey(sourceKey, scope);
    const stored = loadPendingDuplicateJob(pendingJobStorage, sourceKey, scope);
    if (stored && settledDuplicateJobs.get(key) !== stored.requestId) {
      inMemoryPendingDuplicates.set(key, stored);
      return stored;
    }
    const inMemory = inMemoryPendingDuplicates.get(key);
    return inMemory && settledDuplicateJobs.get(key) !== inMemory.requestId ? inMemory : null;
  }

  const loadPendingDuplicate = () => loadPendingDuplicateFor(defaultSource, workspaceScope);

  function assertCurrentWorkspace(record) {
    if (record?.workspaceScope === workspaceScope && workspaceScope) return;
    const error = new Error("The ArcRho Server connection changed. The recovery record remains with its original workspace.");
    error.code = "DUPLICATE_WORKSPACE_CHANGED";
    throw error;
  }

  async function pollDuplicateProjectJob(record, progressId) {
    return waitForDuplicateProjectJob({
      fetchImpl,
      statusUrl: `/project_settings/${defaultSource}/duplicate_project_folder/status/${encodeURIComponent(record.requestId)}`,
      jobId: record.requestId,
      waitForPoll: waitForDuplicatePoll,
      now: duplicateNow,
      staleStatusMs: duplicateStaleStatusMs,
      isCurrentWorkspace: () => record.workspaceScope === workspaceScope,
      onProgress: (progress) => publishDuplicateProgress("update", progressId, progress),
    });
  }

  function refreshTree() {
    store.buildTreeData();
    treeView.render();
  }

  /** Report a blocking failure on both the status bar and a modal alert. */
  function failOperation(message) {
    setStatus(message);
    alert(message);
  }

  function duplicateLifecycleError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
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

  function projectNameExists(candidate) {
    const key = String(candidate || "").trim().toLowerCase();
    return store.listProjectNames().some((name) => name.toLowerCase() === key);
  }

  function projectNameTaken(candidate, skipName = "") {
    const key = String(candidate || "").trim().toLowerCase();
    const skipKey = String(skipName || "").trim().toLowerCase();
    return key !== skipKey && projectNameExists(candidate);
  }

  // ---- Project operations ----

  async function createProjectInFolder(folderNode) {
    const targetFolderPath = normalizeTreePath(folderNode?.fullPath) || "Uncategorized";
    const enteredName = await showDialog("Enter new project name:", "");
    if (!enteredName) return;
    const newProjectName = enteredName.trim();
    if (!newProjectName) return;

    if (projectNameTaken(newProjectName)) {
      failOperation(`Project "${newProjectName}" already exists.`);
      return;
    }

    const projectData = store.getProjectData();
    let folderCreated = false;
    const foldersBefore = Array.isArray(projectData?.customFolders) ? [...projectData.customFolders] : [];
    const projectPathsBefore = Array.isArray(projectData?.projectPaths) ? [...projectData.projectPaths] : [];
    const foldersNext = [...foldersBefore];
    const projectPathsNext = [...projectPathsBefore];

    setStatus(`Creating "${newProjectName}"...`);

    try {
      // 1) Create project folder on disk first so a failed registry save can
      //    never leave an orphan registry entry.
      const createFolderRes = await postJson("create_project_folder", { name: newProjectName });
      if (!createFolderRes.ok) {
        throw new Error(`Folder create failed: ${await createFolderRes.text()}`);
      }
      await createFolderRes.json();
      folderCreated = true;

      // 2) Save the registry with the new project path.
      ensureFolderPathInList(foldersNext, targetFolderPath);
      const newFullPath = joinProjectTreePath(targetFolderPath || "Uncategorized", newProjectName);
      if (!projectPathsNext.some((p) => pathEqualsCI(p, newFullPath))) {
        projectPathsNext.push(newFullPath);
      }
      await store.saveFolderStructure(foldersNext, projectPathsNext, { label: "Project registry save" });

      // 3) Commit in-memory/UI after the app server succeeds.
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

    if (projectNameTaken(newName, oldName)) {
      failOperation(`Project "${newName}" already exists.`);
      return;
    }

    setStatus(`Renaming "${oldName}" to "${newName}"...`);
    let folderRenamed = false;
    const projectData = store.getProjectData();
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

      // 2) Save the registry with the renamed project path.
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
      await store.saveFolderStructure(foldersNext, projectPathsNext, { label: "Project registry save" });

      // 3) Commit UI updates only after app-server steps succeed.
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
    const existingNames = new Set(store.listProjectNames());

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
    if (duplicateProjectInFlight) {
      setStatus("A project duplication is already in progress.");
      return;
    }
    if (!workspaceScope) {
      failOperation("Project duplication is unavailable until the ArcRho Server connection is resolved.");
      return;
    }
    const existingPending = loadPendingDuplicate();
    if (existingPending) {
      await resumePendingDuplicateProject();
      return;
    }
    duplicateProjectInFlight = true;
    try {
      await runDuplicateProject(project);
    } finally {
      duplicateProjectInFlight = false;
    }
  }

  async function runDuplicateProject(project) {
    const suggestedName = getNextDuplicateName(project.name);
    const newName = await showDialog("Enter name for duplicate:", suggestedName);
    if (!newName) return;
    const newProjectName = newName.trim();
    if (!newProjectName) return;

    if (projectNameTaken(newProjectName)) {
      failOperation(`Project "${newProjectName}" already exists.`);
      return;
    }

    setStatus(`Duplicating as "${newProjectName}"...`);
    let pendingRecord = null;
    let progressId = "project-duplicate-preparing";
    try {
      if (!projectNameExists(project.name)) {
        throw duplicateLifecycleError(
          "DUPLICATE_SUBMISSION_REJECTED",
          `Source project "${project.name}" is no longer present in Project Settings.`,
        );
      }
      const requestId = duplicateRequestIdFactory();
      progressId = `project-duplicate-${requestId}`;
      pendingRecord = {
        version: 3,
        sourceKey: defaultSource,
        workspaceScope,
        requestId,
        sourceName: project.name,
        targetName: newProjectName,
        sourceFolderPath: store.getProjectFolderFromStructure(project.name) || "Uncategorized",
        submittedAt: duplicateNow(),
        submissionAcknowledged: false,
        metadataFinalized: false,
      };
      rememberPendingDuplicate(pendingRecord);
      try {
        pendingRecord = rememberPendingDuplicate(savePendingDuplicateJob(pendingJobStorage, pendingRecord));
      } catch (error) {
        console.warn("Duplicate recovery state could not be persisted; continuing in this page:", error);
        setStatus("Duplicate is prepared in this page, but durable local recovery storage is unavailable. Keep Project Settings open.");
      }

      // Persist the client request ID before any POST.
      publishDuplicateProgress("open", progressId, {
        title: "Duplicate Project",
        label: `Starting copy of "${project.name}"...`,
        completed: 0,
        total: 0,
        countText: "Working...",
      });
      await completePendingDuplicate(pendingRecord, progressId);
    } catch (e) {
      await handlePendingDuplicateFailure(e, pendingRecord, progressId, "Duplicate failed");
    }
  }

  async function submitPendingDuplicate(record, progressId) {
    assertCurrentWorkspace(record);
    publishDuplicateProgress("update", progressId, {
      label: `Submitting copy to "${record.targetName}"...`, completed: 0, total: 0, countText: "Working...",
    });
    let response;
    try {
      response = await postJson("duplicate_project_folder", {
        old_name: record.sourceName,
        new_name: record.targetName,
        request_id: record.requestId,
      });
    } catch (error) {
      throw duplicateLifecycleError(
        "DUPLICATE_SUBMISSION_UNCERTAIN",
        `The copy request response was unavailable (${error?.message || error}). The same request will be retried.`,
      );
    }
    assertCurrentWorkspace(record);
    if (!response.ok) {
      const detail = await readDuplicateResponseError(response);
      const status = Number(response.status) || 0;
      const definitive = DEFINITIVE_DUPLICATE_SUBMISSION_STATUSES.has(status);
      throw duplicateLifecycleError(
        definitive ? "DUPLICATE_SUBMISSION_REJECTED" : "DUPLICATE_SUBMISSION_UNCERTAIN",
        definitive
          ? `The copy request was rejected: ${detail}`
          : `The copy request may still have been accepted: ${detail}. The same request will be retried.`,
      );
    }

    let submission;
    try {
      submission = await response.json();
    } catch {
      throw duplicateLifecycleError(
        "DUPLICATE_SUBMISSION_UNCERTAIN",
        "The copy request returned an invalid response. The same request will be retried.",
      );
    }
    const responseRequestId = String(submission?.job_id || "").trim();
    if (submission?.ok !== true || responseRequestId !== record.requestId) {
      throw duplicateLifecycleError(
        "DUPLICATE_SUBMISSION_UNCERTAIN",
        "The copy request response did not confirm the prepared request ID. The same request will be retried.",
      );
    }

    let acknowledgedRecord = rememberPendingDuplicate({
      ...record,
      submissionAcknowledged: true,
    });
    try {
      acknowledgedRecord = rememberPendingDuplicate(
        savePendingDuplicateJob(pendingJobStorage, acknowledgedRecord),
      );
    } catch (error) {
      console.warn("Acknowledged duplicate state could not be persisted:", error);
      setStatus("Duplicate submitted, but durable local recovery storage is unavailable. Keep Project Settings open.");
    }
    return acknowledgedRecord;
  }

  async function finalizeDuplicateMetadata(record, progressId, copyResult) {
    assertCurrentWorkspace(record);
    const projectData = store.getProjectData();

    // Registry entries are just folder\name paths, so finalization is
    // idempotent: ensure the duplicated project's path exists, nothing else.
    const foldersNext = Array.isArray(projectData.customFolders) ? [...projectData.customFolders] : [];
    const projectPathsNext = Array.isArray(projectData.projectPaths) ? [...projectData.projectPaths] : [];
    const newFullPath = joinProjectTreePath(record.sourceFolderPath || "Uncategorized", record.targetName);
    if (!projectPathsNext.some((path) => pathEqualsCI(path, newFullPath))) {
      projectPathsNext.push(newFullPath);
      await store.saveFolderStructure(foldersNext, projectPathsNext, { label: "Project registry save" });
      assertCurrentWorkspace(record);
      projectData.projectPaths = projectPathsNext;
    }

    treeView.expandFolder(record.sourceFolderPath || "Uncategorized");
    refreshTree();
    let finalizedRecord = { ...record, metadataFinalized: true };
    rememberPendingDuplicate(finalizedRecord);
    try {
      finalizedRecord = rememberPendingDuplicate(savePendingDuplicateJob(pendingJobStorage, finalizedRecord));
    } catch (error) {
      console.warn("Finalized duplicate state could not be persisted:", error);
    }
    if (!record.metadataFinalized) {
      try {
        await appendAuditLogAction(record.targetName, `Duplicated from project "${record.sourceName}"`);
      } catch (error) {
        console.warn("Duplicate audit-log update failed:", error);
      }
    }
    settlePendingDuplicate(finalizedRecord);
    setStatus(`Duplicated "${record.targetName}"`);
    const completed = Math.max(0, Number(copyResult?.progress?.completed) || 0);
    const total = Math.max(0, Number(copyResult?.progress?.total) || 0);
    publishDuplicateProgress("update", progressId, {
      label: `Duplicated "${record.targetName}"`, completed, total, countText: total > 0 ? "" : "Complete",
    });
    publishDuplicateProgress("close", progressId, { autoCloseMs: 850 });
  }

  async function completePendingDuplicate(record, progressId) {
    const activeRecord = record.submissionAcknowledged
      ? record
      : await submitPendingDuplicate(record, progressId);
    const copyResult = activeRecord.metadataFinalized
      ? { progress: { completed: 0, total: 0 } }
      : await pollDuplicateProjectJob(activeRecord, progressId);
    publishDuplicateProgress("update", progressId, {
      label: `Finalizing "${activeRecord.targetName}"...`, completed: 0, total: 0, countText: "Working...",
    });
    await finalizeDuplicateMetadata(activeRecord, progressId, copyResult);
  }

  async function handlePendingDuplicateFailure(error, record, progressId, prefix) {
    publishDuplicateProgress("close", progressId);
    if (record && error?.code === "DUPLICATE_STATUS_NOT_FOUND") {
      const current = loadPendingDuplicateFor(record.sourceKey, record.workspaceScope) || record;
      const retryRecord = rememberPendingDuplicate({
        ...current,
        submissionAcknowledged: false,
      });
      try {
        rememberPendingDuplicate(savePendingDuplicateJob(pendingJobStorage, retryRecord));
      } catch (storageError) {
        console.warn("Duplicate replay state could not be persisted:", storageError);
      }
    }
    const definitive = error?.code === "DUPLICATE_JOB_ERROR"
      || error?.code === "DUPLICATE_SUBMISSION_REJECTED";
    if (record && definitive) {
      settlePendingDuplicate(record);
    }
    const retained = record && loadPendingDuplicateFor(
      record.sourceKey,
      record.workspaceScope,
    )?.requestId === record.requestId;
    const preserved = record && !definitive;
    const retentionDetail = retained
      ? " The recovery record and server-side copy state were both preserved."
      : (preserved ? " The server-side copy state was preserved, but local recovery storage is unavailable." : "");
    failOperation(`${prefix}: ${error.message}${retentionDetail}`);
    try { await reloadProjectData(defaultSource); } catch {}
  }

  async function resumePendingDuplicateProject() {
    if (duplicateProjectInFlight || !workspaceScope) return false;
    const record = loadPendingDuplicate();
    if (!record) return false;
    duplicateProjectInFlight = true;
    const progressId = `project-duplicate-resume-${record.requestId}`;
    publishDuplicateProgress("open", progressId, {
      title: "Duplicate Project",
      label: `Resuming copy to "${record.targetName}"...`,
      completed: 0,
      total: 0,
      countText: "Working...",
    });
    setStatus(`Resuming duplicate request "${record.requestId}"...`);
    try {
      await completePendingDuplicate(record, progressId);
    } catch (error) {
      await handlePendingDuplicateFailure(error, record, progressId, "Duplicate recovery paused");
    } finally {
      duplicateProjectInFlight = false;
    }
    return true;
  }

  function setWorkspaceRoot(workspaceRoot) {
    workspaceScope = createDuplicateWorkspaceScope(workspaceRoot);
    return workspaceScope;
  }

  function requestClose() {
    if (!duplicateProjectInFlight) return false;
    const message = "Project duplication is still running or finalizing. Wait for it to finish before closing Project Settings.";
    setStatus(message);
    alert(message);
    return true;
  }

  async function deleteProject(project) {
    const deletedProjectName = project.name;
    const confirmed = await showConfirm(`Are you sure you want to delete "${project.name}"?`, "Delete Project");
    if (!confirmed) return;

    const removedFolderPath = store.getProjectFolderFromStructure(deletedProjectName);
    store.removeProjectPathFromStructure(deletedProjectName);

    const selected = getSelectedProject();
    if (selected && selected.name === project.name) {
      clearProjectSelection();
    }

    refreshTree();

    setStatus(`Deleting "${project.name}"...`);
    const saved = await store.save(defaultSource);
    if (!saved) {
      store.addProjectPathToStructure(deletedProjectName, removedFolderPath || "Uncategorized");
      refreshTree();
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
    requestClose,
    resumePendingDuplicateProject,
    setWorkspaceRoot,
  };
}

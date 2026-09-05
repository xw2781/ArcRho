// Project Settings feature: the Engine-hosted source table refresh.
//
// The coordinator owns the Source Data panel; this module owns the job that
// sits behind its Import button. It decides who performs the import, submits
// the request, follows the job, and drives the shell's progress window. The
// poll loop and the recovery record live in the sibling job module, which has
// no DOM or shell dependency at all.

import {
  clearPendingSourceRefresh,
  createSourceRefreshRequestId,
  describeSourceRefreshResult,
  loadPendingSourceRefresh,
  normalizeSourceRefreshScope,
  savePendingSourceRefresh,
  sourceRefreshRecoveryStorage,
  sourceRefreshScopeRequestFields,
  waitForSourceRefreshJob,
} from "/ui/project_settings/project_settings_source_refresh_job.js?v=20260905scope1";
import { createDuplicateWorkspaceScope } from "/ui/project_settings/project_settings_duplicate_job.js?v=20260901dup1";

/**
 * @param {object} deps
 * @param {Function} deps.fetchImpl
 * @param {Function} deps.setStatus
 * @param {Function} deps.publishShellProgress posts one shell progress message
 * @param {Function} deps.readResponseErrorDetail
 * @param {object} [deps.storage] recovery store; defaults to localStorage
 */
export function createSourceRefreshFeature({
  fetchImpl,
  setStatus,
  publishShellProgress,
  readResponseErrorDetail,
  storage,
  requestIdFactory = createSourceRefreshRequestId,
  now = () => Date.now(),
  pollOptions = {},
}) {
  const recoveryStorage = storage === undefined ? sourceRefreshRecoveryStorage() : storage;
  let inFlight = false;
  let workspaceScope = "";

  const publishProgress = (action, progressId, details = {}) => publishShellProgress?.({
    type: "arcrho:project-settings-progress",
    action,
    progressId,
    ...details,
  });

  /**
   * Bind this page to one ArcRho Server workspace.
   *
   * A recovery record belongs to the workspace its job was submitted against;
   * the scope hash keeps a record from being replayed after the connection
   * changed, which is the same rule the duplicate job follows.
   */
  function setWorkspaceRoot(workspaceConfig) {
    workspaceScope = createDuplicateWorkspaceScope(workspaceConfig);
    return workspaceScope;
  }

  const isRunning = () => inFlight;

  /** Who can import this project's table, and whether a refresh already runs. */
  async function loadPlan(projectName) {
    try {
      const query = new URLSearchParams({ project_name: String(projectName || "").trim() });
      const response = await fetchImpl(
        `/source_table/refresh_job/plan?${query.toString()}`,
        { cache: "no-store" },
      );
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  function rememberJob(projectName, record) {
    if (!workspaceScope) return;
    savePendingSourceRefresh(recoveryStorage, {
      version: 1,
      projectName,
      workspaceScope,
      submittedAt: now(),
      ...record,
    });
  }

  function forgetJob(projectName, requestId) {
    if (!workspaceScope) return;
    clearPendingSourceRefresh(recoveryStorage, projectName, workspaceScope, requestId);
  }

  /**
   * Submit (or resume) one refresh job and follow it to a terminal state.
   *
   * Returns `{unavailable: true}` when no Engine is running, which is the one
   * outcome the caller handles by doing the work the old way instead.
   */
  async function runJob(projectName, {
    importSource,
    refreshDependents,
    requestId = "",
    datasetTypes = [],
    reservingClassTypes = [],
  }) {
    const jobRequestId = requestId || requestIdFactory();
    const progressId = `source-refresh-${jobRequestId}`;
    const scope = normalizeSourceRefreshScope({ datasetTypes, reservingClassTypes });
    inFlight = true;
    // Persisted before the POST: a response lost in flight still leaves a
    // record that resumes the same job instead of starting a second import.
    rememberJob(projectName, {
      requestId: jobRequestId,
      importSource: !!importSource,
      refreshDependents: !!refreshDependents,
      ...scope,
    });
    publishProgress("open", progressId, {
      title: "Refresh Source Table",
      label: `Submitting the refresh for "${projectName}"...`,
      completed: 0,
      total: 0,
      countText: "Working...",
    });
    try {
      const response = await fetchImpl("/source_table/refresh_job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_name: projectName,
          request_id: jobRequestId,
          import_source: !!importSource,
          force: true,
          refresh_dependents: !!refreshDependents,
          ...sourceRefreshScopeRequestFields(scope),
        }),
      });
      if (!response.ok) {
        const detail = await readResponseErrorDetail(response);
        forgetJob(projectName, jobRequestId);
        publishProgress("close", progressId);
        if (response.status === 503) return { ok: false, unavailable: true, error: detail };
        return { ok: false, error: detail };
      }
      setStatus(`Refreshing the source table for "${projectName}" on ArcRho Server...`);
      const outcome = await waitForSourceRefreshJob({
        fetchImpl,
        projectName,
        jobId: jobRequestId,
        onProgress: (progress) => publishProgress("update", progressId, progress),
        ...pollOptions,
      });
      forgetJob(projectName, jobRequestId);
      const summary = describeSourceRefreshResult(outcome?.result);
      publishProgress("update", progressId, {
        label: summary,
        completed: 1,
        total: 1,
        countText: "",
      });
      publishProgress("close", progressId, { autoCloseMs: 850 });
      setStatus(summary);
      return { ok: true, result: outcome?.result || null };
    } catch (error) {
      publishProgress("close", progressId);
      // A job the server finished and rejected is settled; anything else may
      // still be running, so its recovery record is kept for the next visit.
      if (error?.code === "SOURCE_REFRESH_JOB_ERROR") forgetJob(projectName, jobRequestId);
      const message = String(error?.message || error || "The source table refresh failed.");
      setStatus(message);
      return { ok: false, error: message };
    } finally {
      inFlight = false;
    }
  }

  /** Re-attach to a refresh this page left running before a reload. */
  async function resumePending(projectName) {
    const name = String(projectName || "").trim();
    if (!name || inFlight || !workspaceScope) return null;
    const record = loadPendingSourceRefresh(recoveryStorage, name, workspaceScope);
    if (!record) return null;
    setStatus(`Resuming the source table refresh for "${name}"...`);
    return runJob(name, {
      importSource: record.importSource,
      refreshDependents: record.refreshDependents,
      requestId: record.requestId,
      datasetTypes: record.datasetTypes,
      reservingClassTypes: record.reservingClassTypes,
    });
  }

  return { setWorkspaceRoot, isRunning, loadPlan, runJob, resumePending };
}

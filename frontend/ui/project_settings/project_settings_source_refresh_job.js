// Client half of the Engine-hosted source-table refresh.
//
// The import and the project-wide dependent refresh run on the ArcRho Server
// host; Project Settings owns the request id, polls the job, and drives the
// shell's progress window. The id is persisted before the first POST so a page
// reload, a tab close, or a lost response never orphans a running refresh:
// re-submitting the same id resumes the job the server already has.

const PENDING_JOB_VERSION = 1;
const PENDING_JOB_KEY_PREFIX = "arcrho_project_settings_pending_source_refresh_v1";
const POLL_INTERVAL_MS = 750;
const MAX_STATUS_RETRIES = 8;
// The worker republishes its "processing" status every ~5 s even when a single
// step is still running (SOURCE_REFRESH_STATUS_HEARTBEAT_SECONDS), so a status
// whose updated_at stops moving means the worker died. A queued job has no
// heartbeat owner - it is waiting for an Engine slot - so it gets a separate,
// longer allowance.
const STALE_STATUS_MS = 45 * 1000;
const QUEUED_STALE_STATUS_MS = 180 * 1000;
const SUCCESS_STATUSES = new Set(["success", "completed", "complete", "succeeded"]);
const ERROR_STATUSES = new Set(["error", "failed", "failure", "cancelled", "canceled"]);

const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createSourceRefreshRequestId(cryptoImpl) {
  let cryptoSource = cryptoImpl;
  if (cryptoSource === undefined) {
    try { cryptoSource = globalThis.crypto; } catch { cryptoSource = null; }
  }
  if (typeof cryptoSource?.randomUUID === "function") {
    const uuid = String(cryptoSource.randomUUID()).trim().toLowerCase();
    if (/^[a-z0-9][a-z0-9-]{0,120}$/u.test(uuid)) return `psrefresh_${uuid}`;
  }
  if (typeof cryptoSource?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoSource.getRandomValues(bytes);
    return `psrefresh_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  }
  throw new Error("Secure browser request-ID generation is unavailable.");
}

export function sourceRefreshStatusUrl(projectName, jobId) {
  const params = new URLSearchParams({
    project_name: String(projectName || "").trim(),
    job_id: String(jobId || "").trim(),
  });
  return `/source_table/refresh_job/status?${params.toString()}`;
}

/** The browser store holding refresh-recovery records, or null when blocked. */
export function sourceRefreshRecoveryStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function pendingSourceRefreshStorageKey(projectName, workspaceScope) {
  const project = String(projectName || "").trim().toLowerCase();
  const scope = String(workspaceScope || "").trim();
  if (!project || !scope) return "";
  return `${PENDING_JOB_KEY_PREFIX}:${encodeURIComponent(scope)}:${encodeURIComponent(project)}`;
}

function normalizePendingSourceRefresh(record, projectName, workspaceScope) {
  if (!record || Number(record.version) !== PENDING_JOB_VERSION) return null;
  const normalized = {
    version: PENDING_JOB_VERSION,
    projectName: String(record.projectName || "").trim(),
    workspaceScope: String(record.workspaceScope || "").trim(),
    requestId: String(record.requestId || "").trim(),
    importSource: !!record.importSource,
    refreshDependents: !!record.refreshDependents,
    submittedAt: Number(record.submittedAt) || 0,
  };
  if (
    !REQUEST_ID_RE.test(normalized.requestId)
    || !normalized.projectName
    || normalized.projectName.toLowerCase() !== String(projectName || "").trim().toLowerCase()
    || normalized.workspaceScope !== String(workspaceScope || "").trim()
  ) return null;
  return normalized;
}

export function loadPendingSourceRefresh(storage, projectName, workspaceScope) {
  const key = pendingSourceRefreshStorageKey(projectName, workspaceScope);
  if (!key || !storage?.getItem) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const normalized = normalizePendingSourceRefresh(JSON.parse(raw), projectName, workspaceScope);
    if (!normalized) storage.removeItem?.(key);
    return normalized;
  } catch {
    return null;
  }
}

export function savePendingSourceRefresh(storage, record) {
  const normalized = normalizePendingSourceRefresh(record, record?.projectName, record?.workspaceScope);
  const key = normalized && pendingSourceRefreshStorageKey(normalized.projectName, normalized.workspaceScope);
  if (!key || !storage?.setItem) return null;
  try {
    storage.setItem(key, JSON.stringify(normalized));
  } catch {
    // A refresh must still run when local recovery storage is unavailable; the
    // job simply cannot be picked up again after a reload.
    return null;
  }
  return normalized;
}

export function clearPendingSourceRefresh(storage, projectName, workspaceScope, expectedRequestId = "") {
  const key = pendingSourceRefreshStorageKey(projectName, workspaceScope);
  if (!key || !storage?.removeItem) return false;
  try {
    const existing = loadPendingSourceRefresh(storage, projectName, workspaceScope);
    if (expectedRequestId && existing?.requestId !== expectedRequestId) return false;
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export async function readSourceRefreshResponseError(response) {
  const raw = await response.text();
  try {
    const body = JSON.parse(raw);
    return String(body?.detail || body?.message || raw || `HTTP ${response.status}`).trim();
  } catch {
    return String(raw || `HTTP ${response.status}`).trim();
  }
}

function isRetryableStatusResponse(response) {
  return response?.status === 423 || Number(response?.status) >= 500;
}

/** Summarize a finished job's `result` block for the status bar. */
export function describeSourceRefreshResult(result) {
  if (!result || typeof result !== "object") return "Source table refresh complete.";
  const parts = [];
  if (result.imported) {
    const rows = Number(result.row_count) || 0;
    parts.push(`imported ${rows.toLocaleString("en-US")} row(s)`);
  }
  if (result.dependents_refreshed) {
    const classes = Number(result.classes_refreshed) || 0;
    const datasets = Number(result.datasets_regenerated) || 0;
    const methods = Number(result.methods_updated) || 0;
    parts.push(`refreshed ${datasets} dataset(s) and ${methods} method(s) across ${classes} reserving class(es)`);
  }
  const failed = Number(result.datasets_failed) || 0;
  if (failed > 0) parts.push(`${failed} dataset(s) failed`);
  return parts.length ? `Source table refresh: ${parts.join("; ")}.` : "Source table refresh complete.";
}

/** Poll one submitted source-refresh job until the Engine reports a terminal state. */
export async function waitForSourceRefreshJob({
  fetchImpl,
  projectName,
  jobId,
  onProgress = () => {},
  waitForPoll = (delayMs) => new Promise((resolve) => globalThis.setTimeout(resolve, delayMs)),
  pollIntervalMs = POLL_INTERVAL_MS,
  maxStatusRetries = MAX_STATUS_RETRIES,
  staleStatusMs = STALE_STATUS_MS,
  queuedStaleStatusMs = QUEUED_STALE_STATUS_MS,
  now = () => Date.now(),
}) {
  const statusUrl = sourceRefreshStatusUrl(projectName, jobId);
  let consecutiveFailures = 0;
  let lastFailure = "";
  let lastStatusSignature = "";
  const initialNow = Number(now());
  let lastActivityAt = Number.isFinite(initialNow) ? initialNow : Date.now();

  for (;;) {
    let response;
    try {
      response = await fetchImpl(statusUrl, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
    } catch (error) {
      lastFailure = String(error?.message || error || "Network request failed.");
      response = null;
    }

    if (!response || (!response.ok && isRetryableStatusResponse(response))) {
      if (response) lastFailure = await readSourceRefreshResponseError(response);
      consecutiveFailures += 1;
      if (consecutiveFailures > maxStatusRetries) {
        throw codedError(
          "SOURCE_REFRESH_STATUS_UNAVAILABLE",
          `Source refresh status is unavailable after repeated checks. Job "${jobId}" may still be running on ArcRho Engine.${lastFailure ? ` Last error: ${lastFailure}` : ""}`,
        );
      }
      onProgress({ label: "Waiting for refresh status...", completed: 0, total: 0 });
      await waitForPoll(pollIntervalMs);
      continue;
    }
    if (!response.ok) {
      const detail = await readSourceRefreshResponseError(response);
      if (response.status === 404) {
        // The queued status is published before the request file, so a missing
        // status means this job identity never reached the workspace.
        throw codedError(
          "SOURCE_REFRESH_STATUS_NOT_FOUND",
          `Source refresh status was not found (${detail}). The same submission will be replayed.`,
        );
      }
      throw new Error(`Source refresh status check failed: ${detail}`);
    }

    consecutiveFailures = 0;
    const result = await response.json();
    if (result?.ok === false) {
      throw new Error(String(result.message || result.error || "The source table refresh failed."));
    }
    const progress = result?.progress || {};
    const total = Math.max(0, Number(progress.total) || 0);
    const completed = Math.max(0, Number(progress.completed) || 0);
    onProgress({
      label: String(progress.label || progress.stage || "Refreshing the source table...").trim(),
      completed,
      total,
      countText: total > 0 ? "" : "Working...",
    });
    const status = String(result?.status || "").trim().toLowerCase();
    if (SUCCESS_STATUSES.has(status)) return result;
    if (ERROR_STATUSES.has(status)) {
      throw codedError(
        "SOURCE_REFRESH_JOB_ERROR",
        String(result.message || result.error || "The source table refresh failed."),
      );
    }

    const signature = JSON.stringify([
      status,
      result?.updated_at || "",
      progress.stage || "",
      completed,
      total,
      progress.label || "",
    ]);
    const allowedStaleMs = status === "queued" ? queuedStaleStatusMs : staleStatusMs;
    const currentNow = Number(now());
    const observedAt = Number.isFinite(currentNow) ? currentNow : lastActivityAt;
    if (signature !== lastStatusSignature) {
      lastStatusSignature = signature;
      lastActivityAt = observedAt;
    } else if (observedAt - lastActivityAt >= Math.max(pollIntervalMs, allowedStaleMs)) {
      throw codedError(
        "SOURCE_REFRESH_STATUS_STALE",
        `Source refresh status has stopped updating. Job "${jobId}" appears to have stalled on ArcRho Engine.`,
      );
    }
    await waitForPoll(pollIntervalMs);
  }
}

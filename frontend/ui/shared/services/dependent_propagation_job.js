// Shared poller for Engine-hosted dependent-propagation jobs.
// A save returns `propagation: {job_id, status: "queued"}` (or
// {status: "unchanged"} for a no-op save); pages track the job through the
// app-server status endpoint and surface "Updating dependents..." progress.
// Failed jobs are not auto-retried: downstream methods stay Review Needed and
// the next save or a manual refresh enqueues a fresh walk.

const POLL_INTERVAL_MS = 750;
const MAX_STATUS_RETRIES = 8;
const STALE_STATUS_MS = 15 * 60 * 1000;
const SUCCESS_STATUSES = new Set(["success", "completed", "complete", "succeeded"]);
const ERROR_STATUSES = new Set(["error", "failed", "failure", "cancelled", "canceled"]);

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function dependentPropagationStatusUrl(jobId) {
  return `/dependent_propagation/refresh_dependents/status/${encodeURIComponent(String(jobId || "").trim())}`;
}

export function isEngineUnavailableSaveError(error) {
  if (Number(error?.status) === 503) return true;
  return /ArcRho Engine service is not available/iu.test(String(error?.message || error || ""));
}

async function readStatusResponseError(response) {
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

/** Poll one submitted propagation job until the Engine reports a terminal state. */
export async function waitForDependentPropagationJob({
  fetchImpl,
  statusUrl,
  jobId,
  onProgress = () => {},
  waitForPoll = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  pollIntervalMs = POLL_INTERVAL_MS,
  maxStatusRetries = MAX_STATUS_RETRIES,
  staleStatusMs = STALE_STATUS_MS,
  now = () => Date.now(),
}) {
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
      if (response) lastFailure = await readStatusResponseError(response);
      consecutiveFailures += 1;
      if (consecutiveFailures > maxStatusRetries) {
        throw codedError(
          "PROPAGATION_STATUS_UNAVAILABLE",
          `Dependent-update status is unavailable after repeated checks. Job "${jobId}" may still be running on ArcRho Engine.${lastFailure ? ` Last error: ${lastFailure}` : ""}`,
        );
      }
      onProgress({ label: "Waiting for dependent-update status...", completed: 0, total: 0 });
      await waitForPoll(pollIntervalMs);
      continue;
    }
    if (!response.ok) {
      const detail = await readStatusResponseError(response);
      if (response.status === 404) {
        // Queued statuses are published before the request file, so a missing
        // status means the job identity is wrong or the workspace changed.
        throw codedError(
          "PROPAGATION_STATUS_NOT_FOUND",
          `Dependent-update status was not found (${detail}).`,
        );
      }
      throw new Error(`Dependent-update status check failed: ${detail}`);
    }

    consecutiveFailures = 0;
    const result = await response.json();
    if (result?.ok === false) {
      throw new Error(String(result.message || result.error || "Dependent updates failed."));
    }
    const progress = result?.progress || {};
    const total = Math.max(0, Number(progress.total) || 0);
    const completed = Math.max(0, Number(progress.completed) || 0);
    onProgress({
      label: String(progress.label || progress.stage || "Updating dependents...").trim(),
      completed,
      total,
    });
    const status = String(result?.status || "").trim().toLowerCase();
    if (SUCCESS_STATUSES.has(status)) return result;
    if (ERROR_STATUSES.has(status)) {
      throw codedError(
        "PROPAGATION_JOB_ERROR",
        String(result.message || result.error || "Dependent updates failed."),
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
    const currentNow = Number(now());
    const observedAt = Number.isFinite(currentNow) ? currentNow : lastActivityAt;
    if (signature !== lastStatusSignature) {
      lastStatusSignature = signature;
      lastActivityAt = observedAt;
    } else if (observedAt - lastActivityAt >= Math.max(pollIntervalMs, staleStatusMs)) {
      throw codedError(
        "PROPAGATION_STATUS_STALE",
        `Dependent-update status has not changed for a long time. Job "${jobId}" may still be running on ArcRho Engine.`,
      );
    }
    await waitForPoll(pollIntervalMs);
  }
}

/**
 * Track a save response's `propagation` payload without blocking the save UX.
 * Never throws: terminal problems become `onStatus(text, {tone})` calls, and
 * `onComplete(result)` fires only after the Engine reports success.
 */
export async function trackSavePropagation(propagation, {
  fetchImpl = (...args) => fetch(...args),
  onStatus = () => {},
  onComplete = () => {},
  ...pollOptions
} = {}) {
  if (!propagation || typeof propagation !== "object") return null;
  const status = String(propagation.status || "").trim().toLowerCase();
  if (status === "unchanged") return { status: "unchanged" };
  const jobId = String(propagation.job_id || "").trim();
  if (!jobId) {
    const message = String(propagation.message || "Dependent updates could not be scheduled.").trim();
    onStatus(`Dependent updates were not scheduled: ${message}`, { tone: "warn" });
    return null;
  }

  onStatus("Updating dependents...", { tone: "info" });
  try {
    const result = await waitForDependentPropagationJob({
      fetchImpl,
      statusUrl: dependentPropagationStatusUrl(jobId),
      jobId,
      onProgress: ({ label }) => {
        onStatus(label || "Updating dependents...", { tone: "info" });
      },
      ...pollOptions,
    });
    onStatus(`Dependent updates complete at ${new Date().toLocaleTimeString()}.`, { tone: "info" });
    try { onComplete(result); } catch { /* completion hooks must not break polling callers */ }
    return result;
  } catch (error) {
    const message = String(error?.message || error || "Dependent updates failed.");
    onStatus(
      `Dependent updates did not complete: ${message} Downstream methods remain Review Needed until a save or refresh succeeds.`,
      { tone: "warn" },
    );
    return null;
  }
}

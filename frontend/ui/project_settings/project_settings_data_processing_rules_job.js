// Client half of the Engine-hosted data-processing-rules save.
//
// The save runs on the ArcRho Server host, where the sidecar walk that follows
// the write is local disk; Project Settings owns the request id, submits the
// job, polls its status, and drives the shell's progress window. This module
// has no DOM or shell dependency: it is the poll loop and its status rules,
// and the rules feature owns everything the user sees.

const POLL_INTERVAL_MS = 750;
const MAX_STATUS_RETRIES = 8;
// The worker republishes its "processing" status every ~5 s even when a single
// step is still running (DATA_PROCESSING_RULES_JOB_STATUS_HEARTBEAT_SECONDS),
// so a status whose updated_at stops moving means the worker died. A queued
// job has no heartbeat owner - it is waiting for an Engine slot - so it gets a
// separate, longer allowance.
const STALE_STATUS_MS = 45 * 1000;
const QUEUED_STALE_STATUS_MS = 180 * 1000;
const SUCCESS_STATUSES = new Set(["success", "completed", "complete", "succeeded"]);
const ERROR_STATUSES = new Set(["error", "failed", "failure", "cancelled", "canceled"]);

function codedError(code, message, statusCode = 0) {
  const error = new Error(message);
  error.code = code;
  if (statusCode) error.statusCode = statusCode;
  return error;
}

export function createDataProcessingRulesRequestId(cryptoImpl) {
  let cryptoSource = cryptoImpl;
  if (cryptoSource === undefined) {
    try { cryptoSource = globalThis.crypto; } catch { cryptoSource = null; }
  }
  if (typeof cryptoSource?.randomUUID === "function") {
    const uuid = String(cryptoSource.randomUUID()).trim().toLowerCase();
    if (/^[a-z0-9][a-z0-9-]{0,120}$/u.test(uuid)) return `psrules_${uuid}`;
  }
  if (typeof cryptoSource?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoSource.getRandomValues(bytes);
    return `psrules_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  }
  throw new Error("Secure browser request-ID generation is unavailable.");
}

export function dataProcessingRulesJobStatusUrl(projectName, jobId) {
  const params = new URLSearchParams({
    project_name: String(projectName || "").trim(),
    job_id: String(jobId || "").trim(),
  });
  return `/data_processing_rules/save_job/status?${params.toString()}`;
}

/**
 * Summarize a finished save's response for the rules status line.
 *
 * An Engine save carries a `refresh` block: the datasets and methods it
 * rebuilt after the write, and anything it could not. A direct save (no
 * Engine) only counted the generated caches the change made stale; those
 * rebuild when they are next opened, and the text says so.
 */
export function describeDataProcessingRulesSaveResult(payload) {
  const refresh = payload?.refresh;
  if (refresh && typeof refresh === "object") {
    const classesTotal = Number(refresh.classes_total) || 0;
    const classes = Number(refresh.classes_refreshed) || 0;
    const datasets = Number(refresh.datasets_regenerated) || 0;
    const methods = Number(refresh.methods_updated) || 0;
    const failures = (Array.isArray(refresh.failures) ? refresh.failures : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    const parts = [];
    if (classesTotal > 0 || datasets > 0 || methods > 0) {
      parts.push(`Refreshed ${datasets} dataset(s) and ${methods} method(s) in ${classes} reserving class(es).`);
    }
    if (failures.length) {
      parts.push(`${failures.length} problem(s) during the refresh; first: ${failures[0]}`);
    }
    return { text: parts.join(" "), failed: failures.length > 0 };
  }
  const invalidated = Number(
    payload?.impact?.generated_caches_rejected
    || payload?.impact?.invalidated_count
    || payload?.impact?.cleared_count
    || 0,
  );
  return {
    text: invalidated > 0
      ? `${invalidated} generated cache file(s) will refresh when next opened.`
      : "",
    failed: false,
  };
}

async function readResponseError(response) {
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

/**
 * Poll one submitted rules-save job until the Engine reports a terminal state.
 *
 * Resolves with the terminal status; its `result` is the save route's own
 * response. A job the Engine refused rejects with `code`
 * `DATA_PROCESSING_RULES_JOB_ERROR` and the HTTP `statusCode` the direct save
 * would have answered with, so a stale revision (409) is handled as before.
 */
export async function waitForDataProcessingRulesJob({
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
  const statusUrl = dataProcessingRulesJobStatusUrl(projectName, jobId);
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
      if (response) lastFailure = await readResponseError(response);
      consecutiveFailures += 1;
      if (consecutiveFailures > maxStatusRetries) {
        throw codedError(
          "DATA_PROCESSING_RULES_STATUS_UNAVAILABLE",
          `The save status is unavailable after repeated checks. Job "${jobId}" may still be running on ArcRho Engine.${lastFailure ? ` Last error: ${lastFailure}` : ""}`,
        );
      }
      onProgress({ stage: "", label: "Waiting for the save status...", completed: 0, total: 0 });
      await waitForPoll(pollIntervalMs);
      continue;
    }
    if (!response.ok) {
      const detail = await readResponseError(response);
      if (response.status === 404) {
        // The queued status is published before the request file, so a missing
        // status means this job identity never reached the workspace.
        throw codedError(
          "DATA_PROCESSING_RULES_STATUS_NOT_FOUND",
          `The save status was not found (${detail}).`,
        );
      }
      throw new Error(`The save status check failed: ${detail}`);
    }

    consecutiveFailures = 0;
    const result = await response.json();
    const progress = result?.progress || {};
    const total = Math.max(0, Number(progress.total) || 0);
    const completed = Math.max(0, Number(progress.completed) || 0);
    onProgress({
      stage: String(progress.stage || "").trim(),
      label: String(progress.label || progress.stage || "Saving data processing rules...").trim(),
      completed,
      total,
    });

    const status = String(result?.status || "").trim().toLowerCase();
    if (SUCCESS_STATUSES.has(status)) return result;
    if (ERROR_STATUSES.has(status)) {
      throw codedError(
        "DATA_PROCESSING_RULES_JOB_ERROR",
        String(result.message || "The data processing rules save failed."),
        Number(result.status_code) || 0,
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
        "DATA_PROCESSING_RULES_STATUS_STALE",
        `The save has stopped reporting progress. Job "${jobId}" appears to have stalled on ArcRho Engine.`,
      );
    }
    await waitForPoll(pollIntervalMs);
  }
}

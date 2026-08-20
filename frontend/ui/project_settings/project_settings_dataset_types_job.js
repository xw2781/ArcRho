// Client half of the Engine-hosted dataset-type change.
//
// Changing a project's dataset-type table rewrites the file and then re-derives
// every sidecar's dependency graph, so the server answers the POST with a job
// identity instead of doing that work inside the request. This module owns the
// job: how a submission is identified, how its status is polled, and when a
// status that stopped moving means the worker died. It has no DOM and no shell
// dependency, so the feature module can drive whatever surface it likes.

const POLL_INTERVAL_MS = 750;
const MAX_STATUS_RETRIES = 8;
// The Engine republishes its "processing" status every ~5 s even while one
// stage is still running (DATASET_TYPES_CHANGE_STATUS_HEARTBEAT_SECONDS), so a
// status whose updated_at stops moving means the worker died. A queued job has
// no heartbeat owner - it is waiting for an Engine slot - so it gets a
// separate, longer allowance.
const STALE_STATUS_MS = 45 * 1000;
const QUEUED_STALE_STATUS_MS = 180 * 1000;
const SUCCESS_STATUSES = new Set(["success"]);
const ERROR_STATUSES = new Set(["error"]);

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** A submission identity the server will accept and a retry can reuse. */
export function createDatasetTypesChangeRequestId(cryptoImpl) {
  let cryptoSource = cryptoImpl;
  if (cryptoSource === undefined) {
    try { cryptoSource = globalThis.crypto; } catch { cryptoSource = null; }
  }
  if (typeof cryptoSource?.randomUUID === "function") {
    const uuid = String(cryptoSource.randomUUID()).trim().toLowerCase();
    if (/^[a-z0-9][a-z0-9-]{0,120}$/u.test(uuid)) return `psdtc_${uuid}`;
  }
  if (typeof cryptoSource?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoSource.getRandomValues(bytes);
    return `psdtc_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  }
  throw new Error("Secure browser request-ID generation is unavailable.");
}

export function datasetTypesChangeStatusUrl(projectName, jobId) {
  const params = new URLSearchParams({
    project_name: String(projectName || "").trim(),
    job_id: String(jobId || "").trim(),
  });
  return `/dataset_types/change_job/status?${params.toString()}`;
}

/**
 * The rows a submission carried, as one comparable string.
 *
 * A retry may reuse its request id only while it is retrying the *same* table:
 * the server returns an already-published job untouched, so replaying an id
 * under different rows would silently drop the newer edit.
 */
export function datasetTypesRowsSignature(rows) {
  try {
    return JSON.stringify(rows ?? []);
  } catch {
    return "";
  }
}

function isRetryableStatusResponse(response) {
  if (!response) return true;
  const status = Number(response.status) || 0;
  return status === 408 || status === 423 || status === 429 || status >= 500;
}

async function readResponseError(response) {
  if (!response) return "";
  try {
    const body = await response.json();
    const detail = String(body?.detail || body?.message || "").trim();
    if (detail) return detail;
  } catch {
    try {
      const text = await response.text();
      if (String(text || "").trim()) return String(text).trim();
    } catch {
      /* fall through to the status line */
    }
  }
  return `HTTP ${response.status}`;
}

/** `1 dataset` / `4 datasets`, with the irregular plural supplied when needed. */
const plural = (count, singular, pluralWord = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralWord}`;

/** What the finished job did, in the units the user was watching. */
export function describeDatasetTypesChangeResult(status) {
  const result = status?.result || {};
  const rows = Math.max(0, Number(result.rows_written) || 0);
  const updated = Math.max(0, Number(result.datasets_updated) || 0);
  const classes = Math.max(0, Number(result.classes_total) || 0);
  const recalculated = Math.max(0, Number(result.datasets_recalculated) || 0);

  const sentences = [`${plural(rows, "dataset type")} saved.`];
  if (updated > 0) {
    sentences.push(
      classes > 0
        ? `${plural(updated, "dataset")} updated across ${plural(classes, "reserving class", "reserving classes")}.`
        : `${plural(updated, "dataset")} updated.`,
    );
  } else {
    sentences.push("No datasets needed updating.");
  }
  if (recalculated > 0) {
    sentences.push(`${plural(recalculated, "calculated dataset")} recalculated.`);
  }
  return sentences.join(" ");
}

/**
 * Follow one dataset-type change job to its terminal status.
 *
 * Resolves with the terminal status payload, or throws a coded error: an
 * unreachable status, a status that stopped moving, or a job the Engine ended
 * in error. Every one of those leaves the table on screen unsaved, which is
 * what the caller reports.
 */
export async function waitForDatasetTypesChangeJob({
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
  const statusUrl = datasetTypesChangeStatusUrl(projectName, jobId);
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
          "DATASET_TYPES_CHANGE_STATUS_UNAVAILABLE",
          `Dataset type change status is unavailable after repeated checks. Job "${jobId}" may still be running on ArcRho Engine.${lastFailure ? ` Last error: ${lastFailure}` : ""}`,
        );
      }
      onProgress({ stage: "", label: "Waiting for the change status...", completed: 0, total: 0 });
      await waitForPoll(pollIntervalMs);
      continue;
    }
    if (!response.ok) {
      const detail = await readResponseError(response);
      if (response.status === 404) {
        // The queued status is published before the request file, so a missing
        // status means this job identity never reached the workspace.
        throw codedError(
          "DATASET_TYPES_CHANGE_STATUS_NOT_FOUND",
          `Dataset type change status was not found (${detail}).`,
        );
      }
      throw new Error(`Dataset type change status check failed: ${detail}`);
    }

    consecutiveFailures = 0;
    const result = await response.json();
    const progress = result?.progress || {};
    const total = Math.max(0, Number(progress.total) || 0);
    const completed = Math.max(0, Number(progress.completed) || 0);
    onProgress({
      stage: String(progress.stage || "").trim(),
      label: String(progress.label || progress.stage || "Applying dataset type changes...").trim(),
      completed,
      total,
    });

    const status = String(result?.status || "").trim().toLowerCase();
    if (SUCCESS_STATUSES.has(status)) return result;
    if (ERROR_STATUSES.has(status)) {
      throw codedError(
        "DATASET_TYPES_CHANGE_JOB_ERROR",
        String(result.message || "The dataset type change failed."),
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
        "DATASET_TYPES_CHANGE_STATUS_STALE",
        `The dataset type change has stopped reporting progress. Job "${jobId}" appears to have stalled on ArcRho Engine.`,
      );
    }
    await waitForPoll(pollIntervalMs);
  }
}

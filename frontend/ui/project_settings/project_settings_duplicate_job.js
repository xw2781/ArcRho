const PENDING_JOB_VERSION = 3;
const PENDING_JOB_KEY_PREFIX = "arcrho_project_settings_pending_duplicate_v3";
const POLL_INTERVAL_MS = 750;
const MAX_STATUS_RETRIES = 8;
const STALE_STATUS_MS = 15 * 60 * 1000;
const SUCCESS_STATUSES = new Set(["success", "completed", "complete", "succeeded"]);
const ERROR_STATUSES = new Set(["error", "failed", "failure"]);
const CANCELLED_STATUSES = new Set(["cancelled", "canceled"]);

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function fnv64Hex(value) {
  let hash = 14695981039346656037n;
  for (const character of String(value)) {
    hash ^= BigInt(character.charCodeAt(0));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function createDuplicateRequestId(cryptoImpl) {
  let cryptoSource = cryptoImpl;
  if (cryptoSource === undefined) {
    try { cryptoSource = globalThis.crypto; } catch { cryptoSource = null; }
  }
  if (typeof cryptoSource?.randomUUID === "function") {
    const uuid = String(cryptoSource.randomUUID()).trim().toLowerCase();
    if (/^[a-z0-9][a-z0-9-]{0,120}$/u.test(uuid)) return `psdup_${uuid}`;
  }
  if (typeof cryptoSource?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoSource.getRandomValues(bytes);
    return `psdup_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  }
  throw new Error("Secure browser request-ID generation is unavailable.");
}

function normalizeWorkspaceScopePart(value, fallback = "") {
  return String(value || fallback)
    .trim()
    .replace(/[\\/]+/g, "\\")
    .replace(/\\+$/g, "")
    .toLowerCase();
}

export function createDuplicateWorkspaceScope(workspaceConfig) {
  const config = workspaceConfig && typeof workspaceConfig === "object"
    ? workspaceConfig
    : { workspace_root: workspaceConfig };
  const workspaceRoot = normalizeWorkspaceScopePart(config.workspace_root);
  if (!workspaceRoot) return "";
  const paths = config.paths && typeof config.paths === "object" ? config.paths : {};
  const projectsDir = normalizeWorkspaceScopePart(paths.projects_dir, "projects");
  const requestsDir = normalizeWorkspaceScopePart(paths.requests_dir, "requests");
  return `ws_${fnv64Hex(JSON.stringify([workspaceRoot, projectsDir, requestsDir]))}`;
}

export function pendingDuplicateStorageKey(sourceKey, workspaceScope) {
  const source = String(sourceKey || "").trim();
  const scope = String(workspaceScope || "").trim();
  if (!source || !scope) return "";
  return `${PENDING_JOB_KEY_PREFIX}:${encodeURIComponent(source)}:${encodeURIComponent(scope)}`;
}

function normalizePendingDuplicateJob(record, sourceKey, workspaceScope) {
  if (!record || Number(record.version) !== PENDING_JOB_VERSION) return null;
  const normalized = {
    version: PENDING_JOB_VERSION,
    sourceKey: String(record.sourceKey || "").trim(),
    workspaceScope: String(record.workspaceScope || "").trim(),
    requestId: String(record.requestId || "").trim(),
    sourceName: String(record.sourceName || "").trim(),
    targetName: String(record.targetName || "").trim(),
    sourceFolderPath: String(record.sourceFolderPath || "Uncategorized").trim() || "Uncategorized",
    submittedAt: Number(record.submittedAt) || 0,
    submissionAcknowledged: !!record.submissionAcknowledged,
    metadataFinalized: !!record.metadataFinalized,
  };
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(normalized.requestId)
    || !normalized.sourceName
    || !normalized.targetName
    || normalized.sourceKey !== String(sourceKey || "").trim()
    || normalized.workspaceScope !== String(workspaceScope || "").trim()
  ) return null;
  if (/^(?:[a-z]:[\\/]|[\\/]{2}|\/)/iu.test(normalized.sourceFolderPath)) return null;
  return normalized;
}

export function loadPendingDuplicateJob(storage, sourceKey, workspaceScope) {
  const key = pendingDuplicateStorageKey(sourceKey, workspaceScope);
  if (!key || !storage?.getItem) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const normalized = normalizePendingDuplicateJob(JSON.parse(raw), sourceKey, workspaceScope);
    if (!normalized) storage.removeItem?.(key);
    return normalized;
  } catch {
    return null;
  }
}

export function savePendingDuplicateJob(storage, record) {
  const normalized = normalizePendingDuplicateJob(record, record?.sourceKey, record?.workspaceScope);
  const key = normalized && pendingDuplicateStorageKey(normalized.sourceKey, normalized.workspaceScope);
  if (!key || !storage?.setItem) throw new Error("Local duplicate-job recovery storage is unavailable.");
  storage.setItem(key, JSON.stringify(normalized));
  return normalized;
}

export function clearPendingDuplicateJob(storage, sourceKey, workspaceScope, expectedRequestId = "") {
  const key = pendingDuplicateStorageKey(sourceKey, workspaceScope);
  if (!key || !storage?.removeItem) return false;
  try {
    const existing = loadPendingDuplicateJob(storage, sourceKey, workspaceScope);
    if (expectedRequestId && existing?.requestId !== expectedRequestId) return false;
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export async function readDuplicateResponseError(response) {
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

function unavailableStatusError(jobId, cause = "") {
  const detail = String(cause || "").trim();
  return codedError(
    "DUPLICATE_STATUS_UNAVAILABLE",
    `Project copy status is unavailable after repeated checks. Job "${jobId}" may still be running; its recovery record was retained.${detail ? ` Last error: ${detail}` : ""}`,
  );
}

/** Poll one submitted duplicate job until the Engine reports a terminal state. */
export async function waitForDuplicateProjectJob({
  fetchImpl,
  statusUrl,
  jobId,
  onProgress = () => {},
  waitForPoll = (delayMs) => new Promise((resolve) => window.setTimeout(resolve, delayMs)),
  pollIntervalMs = POLL_INTERVAL_MS,
  maxStatusRetries = MAX_STATUS_RETRIES,
  staleStatusMs = STALE_STATUS_MS,
  now = () => Date.now(),
  isCurrentWorkspace = () => true,
}) {
  let consecutiveFailures = 0;
  let lastFailure = "";
  let lastStatusSignature = "";
  const initialNow = Number(now());
  let lastActivityAt = Number.isFinite(initialNow) ? initialNow : Date.now();
  const assertCurrentWorkspace = () => {
    if (!isCurrentWorkspace()) {
      throw codedError(
        "DUPLICATE_WORKSPACE_CHANGED",
        `The ArcRho Server connection changed while job "${jobId}" was active. Its recovery record was retained for the original workspace.`,
      );
    }
  };

  for (;;) {
    assertCurrentWorkspace();
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
    assertCurrentWorkspace();

    if (!response || (!response.ok && isRetryableStatusResponse(response))) {
      if (response) lastFailure = await readDuplicateResponseError(response);
      consecutiveFailures += 1;
      if (consecutiveFailures > maxStatusRetries) throw unavailableStatusError(jobId, lastFailure);
      onProgress({
        label: "Copy is still running; waiting for status...",
        completed: 0,
        total: 0,
        countText: "Reconnecting...",
      });
      await waitForPoll(pollIntervalMs);
      continue;
    }
    if (!response.ok) {
      const detail = await readDuplicateResponseError(response);
      if (response.status === 404) {
        throw codedError(
          "DUPLICATE_STATUS_NOT_FOUND",
          `Project copy status was not found (${detail}). The same submission will be replayed.`,
        );
      }
      throw new Error(`Progress check failed: ${detail}`);
    }

    consecutiveFailures = 0;
    const result = await response.json();
    if (result?.ok === false) throw new Error(String(result.message || result.error || "Project copy failed."));
    const progress = result?.progress || {};
    const total = Math.max(0, Number(progress.total) || 0);
    const completed = Math.max(0, Number(progress.completed) || 0);
    onProgress({
      label: String(progress.label || progress.stage || "Duplicating project...").trim(),
      completed,
      total,
      countText: total > 0 ? "" : "Working...",
    });
    const status = String(result?.status || "").trim().toLowerCase();
    if (SUCCESS_STATUSES.has(status)) return result;
    if (CANCELLED_STATUSES.has(status)) {
      throw codedError(
        "DUPLICATE_JOB_CANCELLED",
        String(result.message || "Project duplication was cancelled."),
      );
    }
    if (ERROR_STATUSES.has(status)) {
      throw codedError(
        String(progress.stage || "").trim().toLowerCase() === "recovery_required"
          ? "DUPLICATE_JOB_RECOVERY_REQUIRED"
          : "DUPLICATE_JOB_ERROR",
        String(result.message || result.error || "Project copy failed."),
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
        "DUPLICATE_STATUS_STALE",
        `Project copy status has not changed for a long time. Job "${jobId}" may still be running; its recovery record was retained.`,
      );
    }
    await waitForPoll(pollIntervalMs);
  }
}

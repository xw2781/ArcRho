// Advisory open-window change watch.
// A window remembers the stat fingerprint of the object it opened (dataset
// sidecar, or method JSON + output sidecar) and polls it on an interval.
// When another user or an automation process — including the Engine-hosted
// dependent-propagation job — rewrites the object, the fingerprint moves and
// the window shows a one-time "close and reopen" alert. One poll costs one
// or two server-side stats; failures are ignored and never surface to the
// user. Self-saves must rebase the watch through pause()/resume()/rebase()
// so the alert only fires for outside changes.

export const OBJECT_CHANGE_FINGERPRINT_URL = "/object_change/fingerprint";
export const OBJECT_UPDATED_TITLE = "Updated Outside This Window";
export const OBJECT_UPDATED_MESSAGE =
  "The dataset is updated by another user or external automation process "
  + "since last opened, please close and reopen to view the updated values.";
export const OBJECT_UPDATED_REFRESH_ACTION = "refresh";
export const OBJECT_UPDATED_REFRESH_LABEL = "Refresh Now";
export const PROPAGATION_SCOPE_STARTED_MESSAGE = "arcrho:dependent-propagation-started";
export const PROPAGATION_SCOPE_FINISHED_MESSAGE = "arcrho:dependent-propagation-finished";
export const DEFAULT_POLL_INTERVAL_MS = 5000;
const MAX_PROPAGATION_SCOPE_PAUSE_MS = 20 * 60 * 1000;

function normalizedScopeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Show the one-time advisory alert with a "Refresh Now" action that reloads
 * the window in place (the plan's "close and reopen" without the manual
 * steps). A dirty window blocks the reload so unsaved work is never
 * discarded silently; `onBlockedRefresh` lets the page explain why.
 */
export function showObjectUpdatedAlert({
  showMessageBox,
  isDirty = () => false,
  onBlockedRefresh = () => {},
  reloadImpl = () => window.location.reload(),
}) {
  return showMessageBox({
    title: OBJECT_UPDATED_TITLE,
    message: OBJECT_UPDATED_MESSAGE,
    tone: "warn",
    actions: [{ id: OBJECT_UPDATED_REFRESH_ACTION, label: OBJECT_UPDATED_REFRESH_LABEL }],
    // The window is showing stale values, so refreshing is the only sane exit:
    // no OK button, no close button, no Esc/overlay dismissal.
    showOk: false,
    dismissible: false,
  }).then((action) => {
    if (action !== OBJECT_UPDATED_REFRESH_ACTION) return;
    if (isDirty()) {
      onBlockedRefresh();
      return;
    }
    reloadImpl();
  });
}

/**
 * Pause the page's change watch while a dependent-propagation job started by
 * this app instance is rewriting the page's reserving class, and rebase when
 * it finishes. Project Instance broadcasts the start/finish scope messages,
 * so the advisory alert only fires for rewrites this app did not cause. A
 * failsafe timer resumes the watch if the finish broadcast never arrives.
 */
export function wireSamePropagationScopePause({
  watch,
  getProject,
  getReservingClass,
  windowRef = window,
  maxPauseMs = MAX_PROPAGATION_SCOPE_PAUSE_MS,
  setTimeoutImpl = (...args) => setTimeout(...args),
  clearTimeoutImpl = (...args) => clearTimeout(...args),
}) {
  const pausedJobs = new Map();

  function scopeMatches(message) {
    const project = normalizedScopeText(message?.project);
    const reservingClass = normalizedScopeText(message?.reservingClass);
    if (!project || !reservingClass) return false;
    return project === normalizedScopeText(getProject())
      && reservingClass === normalizedScopeText(getReservingClass());
  }

  function releaseJob(jobId) {
    const timer = pausedJobs.get(jobId);
    if (timer === undefined) return;
    pausedJobs.delete(jobId);
    clearTimeoutImpl(timer);
    void watch.resume();
  }

  function handleMessage(event) {
    const message = event?.data;
    const jobId = String(message?.jobId || "").trim();
    if (!jobId) return;
    if (message?.type === PROPAGATION_SCOPE_STARTED_MESSAGE) {
      if (!scopeMatches(message) || pausedJobs.has(jobId)) return;
      watch.pause();
      pausedJobs.set(jobId, setTimeoutImpl(() => releaseJob(jobId), maxPauseMs));
      return;
    }
    if (message?.type === PROPAGATION_SCOPE_FINISHED_MESSAGE) {
      releaseJob(jobId);
    }
  }

  windowRef.addEventListener("message", handleMessage);
  return () => {
    windowRef.removeEventListener("message", handleMessage);
    for (const jobId of Array.from(pausedJobs.keys())) releaseJob(jobId);
  };
}

/**
 * Method-page convenience wrapper: keeps one watch alive for the page's
 * current method identity. `ensure` starts the watch on first use, rebases it
 * after a self-save, and recreates it when the identity changes (rename or
 * Save As). `pause`/`resume` bracket a save so it cannot race the poll.
 */
export function createMethodObjectChangeWatchController({
  methodType,
  onChange,
  watchFactory = createObjectChangeWatch,
}) {
  let watch = null;
  let watchKey = "";
  return {
    ensure({ projectName, reservingClass, methodName, outputDataset = "" }) {
      const project = String(projectName || "").trim();
      const reservingClassName = String(reservingClass || "").trim();
      const name = String(methodName || "").trim();
      const output = String(outputDataset || "").trim();
      if (!project || !reservingClassName || !name) return;
      const key = JSON.stringify([project, reservingClassName, name, output]);
      if (watch && key === watchKey) {
        void watch.rebase();
        return;
      }
      watch?.stop();
      watchKey = key;
      watch = watchFactory({
        identity: {
          project_name: project,
          reserving_class: reservingClassName,
          kind: "method",
          method_type: methodType,
          name,
          output_dataset: output,
        },
        onChange,
      });
      watch.start();
    },
    pause() {
      watch?.pause();
    },
    resume() {
      void watch?.resume();
    },
    stop() {
      watch?.stop();
    },
  };
}

export function createObjectChangeWatch({
  identity,
  onChange = () => {},
  fetchImpl = (...args) => fetch(...args),
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  isSuspended = () => false,
  setIntervalImpl = (...args) => setInterval(...args),
  clearIntervalImpl = (...args) => clearInterval(...args),
}) {
  let baselineToken = null;
  let baselineGeneration = 0;
  let timer = null;
  let pauseDepth = 0;
  let pollInFlight = false;
  let alerted = false;
  let stopped = false;

  async function fetchToken() {
    const response = await fetchImpl(OBJECT_CHANGE_FINGERPRINT_URL, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(identity),
    });
    if (!response?.ok) throw new Error(`HTTP ${response?.status}`);
    const result = await response.json();
    const token = String(result?.token || "").trim();
    if (!token) throw new Error("Missing fingerprint token.");
    return token;
  }

  async function poll() {
    if (stopped || alerted || pauseDepth > 0 || pollInFlight) return;
    if (isSuspended()) return;
    pollInFlight = true;
    const generation = baselineGeneration;
    try {
      const token = await fetchToken();
      if (stopped || alerted || pauseDepth > 0) return;
      // A rebase while this poll was in flight makes its result stale.
      if (generation !== baselineGeneration) return;
      if (baselineToken === null) {
        baselineToken = token;
        return;
      }
      if (token !== baselineToken) {
        alerted = true;
        stopTimer();
        onChange();
      }
    } catch {
      // Advisory watch: a failed poll is skipped, never surfaced.
    } finally {
      pollInFlight = false;
    }
  }

  function stopTimer() {
    if (timer !== null) {
      clearIntervalImpl(timer);
      timer = null;
    }
  }

  return {
    /** Begin polling; the first successful poll records the baseline. */
    start() {
      if (stopped || alerted || timer !== null) return;
      timer = setIntervalImpl(() => { void poll(); }, intervalMs);
      void poll();
    },
    /** Suspend polling around a self-save so it cannot race the write. */
    pause() {
      pauseDepth += 1;
    },
    /** End a pause; by default re-reads the baseline so the self-save's new
     * fingerprint is not reported as an outside change. */
    async resume({ rebase = true } = {}) {
      if (rebase && !stopped && !alerted) await this.rebase();
      pauseDepth = Math.max(0, pauseDepth - 1);
    },
    /** Replace the baseline with the current fingerprint (after self-saves). */
    async rebase() {
      if (stopped || alerted) return;
      baselineGeneration += 1;
      const generation = baselineGeneration;
      try {
        const token = await fetchToken();
        if (generation === baselineGeneration) baselineToken = token;
      } catch {
        // Poll self-heals: a null baseline is re-read on the next poll.
        if (generation === baselineGeneration) baselineToken = null;
      }
    },
    stop() {
      stopped = true;
      stopTimer();
    },
    hasAlerted() {
      return alerted;
    },
  };
}

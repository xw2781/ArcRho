// Advisory open-window change watch.
// A window remembers the stat fingerprint of the object it opened (dataset
// sidecar, or method JSON + output sidecar) and polls it on an interval.
// When another user or an automation process — including the Engine-hosted
// dependent-propagation job — rewrites the object, the fingerprint moves and
// the window shows a one-time "close and reopen" alert. One poll costs one
// or two server-side stats; failures are ignored and never surface to the
// user. Self-saves must rebase the watch through pause()/resume()/rebase()
// so the alert only fires for outside changes.
//
// A moved fingerprint says nothing about who moved it, so the alert reads the
// attribution the write itself recorded (the sidecar audit entry) through a
// second endpoint — once, at alert time. The poll stays stat-only; naming the
// person or the automation task costs one payload read per alert, not per
// poll, which matters on a mapped drive.

export const OBJECT_CHANGE_FINGERPRINT_URL = "/object_change/fingerprint";
export const OBJECT_CHANGE_ATTRIBUTION_URL = "/object_change/attribution";
export const OBJECT_UPDATED_TITLE = "Updated Outside This Window";
export const OBJECT_UPDATED_MESSAGE =
  "The dataset is updated by another user or external automation process "
  + "since last opened, please close and reopen to view the updated values.";
const OBJECT_UPDATED_CLOSING = " Please close and reopen to view the updated values.";
export const OBJECT_UPDATED_REFRESH_ACTION = "refresh";
export const OBJECT_UPDATED_REFRESH_LABEL = "Refresh Now";
export const PROPAGATION_SCOPE_STARTED_MESSAGE = "arcrho:dependent-propagation-started";
export const PROPAGATION_SCOPE_FINISHED_MESSAGE = "arcrho:dependent-propagation-finished";
export const DEFAULT_POLL_INTERVAL_MS = 5000;
const MAX_PROPAGATION_SCOPE_PAUSE_MS = 20 * 60 * 1000;

function normalizedScopeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function attributionText(value) {
  return String(value ?? "").trim();
}

/**
 * Epoch milliseconds for a persisted ArcRho timestamp, or null.
 * These are UTC ISO-8601; one written without its `Z` would otherwise be read
 * as local time, so an unmarked value is treated as the UTC it is. String
 * comparison is not a substitute: the writers differ in precision, and
 * `...:11.205Z` sorts *before* `...:11Z` lexicographically.
 */
export function parseObjectChangeTime(value) {
  const text = attributionText(value);
  if (!text) return null;
  const marked = /(?:Z|[+-]\d{2}:?\d{2})$/u.test(text) ? text : `${text}Z`;
  const parsed = Date.parse(marked);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Render a recorded write time in the reader's local time, or as stored. */
export function formatObjectChangeTime(value) {
  const text = attributionText(value);
  if (!text) return "";
  const parsed = parseObjectChangeTime(text);
  return parsed === null ? text : new Date(parsed).toLocaleString();
}

/**
 * Compose the advisory message from the attribution the write recorded.
 * Falls back to the generic sentence whenever the payload named nobody, so a
 * missing or unreadable audit entry never degrades the alert into silence.
 */
export function objectUpdatedMessage(attribution) {
  const user = attributionText(attribution?.user);
  const action = attributionText(attribution?.action);
  const automatic = !!attribution?.automatic;
  if (!user && !(automatic && action)) return OBJECT_UPDATED_MESSAGE;
  const subject = attribution?.subject === "method" ? "method" : "dataset";
  // Always the recorded name, never "you": the account that wrote the object
  // is the fact the reader needs, and an automation runs as whoever queued it,
  // so collapsing that to "you" would hide which of your own actions did this.
  const by = automatic
    ? `by the ${action || "automatic refresh"} automation${user ? ` running as ${user}` : ""}`
    : `by ${user}`;
  const when = formatObjectChangeTime(attribution?.at);
  const tail = when ? ` at ${when}.` : " since it was opened.";
  return `This ${subject} was updated ${by}${tail}${OBJECT_UPDATED_CLOSING}`;
}

/**
 * Show the one-time advisory alert with a "Refresh Now" action that reloads
 * the window in place (the plan's "close and reopen" without the manual
 * steps). A dirty window blocks the reload so unsaved work is never
 * discarded silently; `onBlockedRefresh` lets the page explain why.
 * `attribution` names the writer in the message when the watch could read it.
 */
export function showObjectUpdatedAlert({
  showMessageBox,
  attribution = null,
  isDirty = () => false,
  onBlockedRefresh = () => {},
  reloadImpl = () => window.location.reload(),
}) {
  return showMessageBox({
    title: OBJECT_UPDATED_TITLE,
    message: objectUpdatedMessage(attribution),
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
  // Mirrored here because a Save As or rename replaces the watch mid-save: a
  // fresh watch starts unpaused and would baseline while the save is still
  // writing, so the pause the save took has to survive the swap.
  let pauseDepth = 0;
  return {
    ensure({ projectName, reservingClass, methodName, outputDataset = "", selfWriteStamp = "" }) {
      const project = String(projectName || "").trim();
      const reservingClassName = String(reservingClass || "").trim();
      const name = String(methodName || "").trim();
      const output = String(outputDataset || "").trim();
      if (!project || !reservingClassName || !name) return;
      const key = JSON.stringify([project, reservingClassName, name, output]);
      if (watch && key === watchKey) {
        watch.noteSelfWrite(selfWriteStamp);
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
      watch.noteSelfWrite(selfWriteStamp);
      for (let held = 0; held < pauseDepth; held += 1) watch.pause();
      watch.start();
    },
    noteSelfWrite(stamp) {
      watch?.noteSelfWrite(stamp);
    },
    pause() {
      pauseDepth += 1;
      watch?.pause();
    },
    resume() {
      pauseDepth = Math.max(0, pauseDepth - 1);
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
  let selfWriteAt = null;

  function postIdentity(url) {
    return fetchImpl(url, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(identity),
    });
  }

  async function fetchToken() {
    const response = await postIdentity(OBJECT_CHANGE_FINGERPRINT_URL);
    if (!response?.ok) throw new Error(`HTTP ${response?.status}`);
    const result = await response.json();
    const token = String(result?.token || "").trim();
    if (!token) throw new Error("Missing fingerprint token.");
    return token;
  }

  // Read once, after the fingerprint moved, so the alert can name the writer.
  // Advisory like the poll: a failure leaves the generic message in place.
  async function fetchAttribution() {
    try {
      const response = await postIdentity(OBJECT_CHANGE_ATTRIBUTION_URL);
      if (!response?.ok) return null;
      const result = await response.json();
      return result?.attribution || null;
    } catch {
      return null;
    }
  }

  /**
   * Decide that a moved fingerprint is only this window's own write showing
   * up late. A share read can be answered from the SMB redirector's cache,
   * which serves metadata seconds old and can flip back and forth between the
   * cached and current copy (measured on a Client PC: `os.stat` regressing up
   * to 16 s after a server-side write). So a post-save rebase can baseline on
   * the pre-save stat and then "detect" the user's own save. The stat cannot
   * be made trustworthy — holding a handle open would fail the concurrent
   * atomic replace — but staleness only ever reports an *older* state than
   * the truth, never a newer one. A recorded write no newer than the newest
   * write this window knows it made therefore cannot be an outside change.
   */
  function isOwnWriteArrivingLate(attribution) {
    if (selfWriteAt === null) return false;
    const at = parseObjectChangeTime(attribution?.at);
    return at !== null && at <= selfWriteAt;
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
        const attribution = await fetchAttribution();
        if (stopped || alerted || pauseDepth > 0) return;
        if (generation !== baselineGeneration) return;
        if (isOwnWriteArrivingLate(attribution)) {
          // Adopt the fingerprint we can now see and keep watching; a later
          // outside write still moves it past this window's own stamp.
          baselineToken = token;
          return;
        }
        alerted = true;
        stopTimer();
        onChange(attribution);
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
    /**
     * Record the time of a write this window made or already has in view, as
     * the object itself recorded it (a sidecar `updated_at`). Anything not
     * newer than this is this window's own state, however late the share
     * reports it. Only moves forward, so an older payload cannot lower the bar.
     */
    noteSelfWrite(stamp) {
      const parsed = parseObjectChangeTime(stamp);
      if (parsed === null) return;
      selfWriteAt = selfWriteAt === null ? parsed : Math.max(selfWriteAt, parsed);
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

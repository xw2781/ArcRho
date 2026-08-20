// Debounce + single-flight scheduling for the auto-saving Project Settings grids.
//
// The single-flight slot is the dangerous part, and it is why this lives in its
// own module with no DOM dependency: a save whose promise never settles - a
// request that hung on a network drive rather than failing - would otherwise
// hold the slot for the rest of the page's life. Every later edit would land in
// `pending` and never be sent, so the grid kept accepting changes, the file
// stopped receiving them, and nothing on screen said so. The watchdog below is
// the guarantee that cannot happen: the worst case is a reported failure
// instead of silent divergence.

export const AUTO_SAVE_DEBOUNCE_MS = 700;
// How long one auto-save may occupy the slot before the scheduler stops
// believing in it. A save request answers in well under a second; long work
// runs as an Engine job the feature follows separately, so anything past this
// is a request that will never come back.
export const AUTO_SAVE_WATCHDOG_MS = 120000;

const defaultProjectKey = (name) => String(name || "").trim().toLowerCase();

/**
 * @param {Function} runSave saves one project; may resolve, reject or hang
 * @param {object} [options]
 * @param {Function} [options.onStalled] called with the project whose save
 *   passed the watchdog without settling
 * @param {Function} [options.normalizeProjectKey] project identity function
 * @param {number} [options.debounceMs]
 * @param {number} [options.watchdogMs]
 * @param {Function} [options.setTimeoutImpl] injected for tests
 * @param {Function} [options.clearTimeoutImpl] injected for tests
 * @returns {Function} schedule(projectName)
 */
export function createAutoSaveScheduler(runSave, {
  onStalled,
  normalizeProjectKey = defaultProjectKey,
  debounceMs = AUTO_SAVE_DEBOUNCE_MS,
  watchdogMs = AUTO_SAVE_WATCHDOG_MS,
  setTimeoutImpl = (...args) => globalThis.setTimeout(...args),
  clearTimeoutImpl = (...args) => globalThis.clearTimeout(...args),
} = {}) {
  const timers = new Map();
  const inFlight = new Map();
  const pending = new Set();

  function clearTimer(key) {
    const timerId = timers.get(key);
    if (timerId !== undefined) {
      clearTimeoutImpl(timerId);
      timers.delete(key);
    }
  }

  function schedule(projectName) {
    const key = normalizeProjectKey(projectName);
    if (!key) return;
    clearTimer(key);
    timers.set(key, setTimeoutImpl(() => trigger(projectName), debounceMs));
  }

  async function trigger(projectName) {
    const key = normalizeProjectKey(projectName);
    if (!key) return;
    clearTimer(key);
    if (inFlight.get(key)) {
      pending.add(key);
      return;
    }
    inFlight.set(key, true);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight.set(key, false);
      // The edits that arrived while this save was running are still only in
      // the grid, so they get their own save rather than being dropped.
      if (pending.has(key)) {
        pending.delete(key);
        schedule(projectName);
      }
    };
    const watchdog = setTimeoutImpl(() => {
      try {
        onStalled?.(projectName);
      } finally {
        release();
      }
    }, watchdogMs);

    try {
      await runSave(projectName);
    } catch {
      // A feature reports its own save failures; this wrapper only owes the
      // caller a released slot.
    } finally {
      clearTimeoutImpl(watchdog);
      release();
    }
  }

  return schedule;
}

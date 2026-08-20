/*
===============================================================================
Shared progress popup - centered spinner card shown while a window is busy
===============================================================================
Each caller creates its own popup instance so one window can own separate
busy states (for example dataset loading and method saving) without the
instances fighting over a single DOM node.
*/

const STYLE_ID = "arcrhoProgressPopupStyles";
// Marks the card as sized for countable work rather than for its message.
const MEASURED_CLASS = "is-measured";

/**
 * What a determinate bar should read, or `null` to keep the spinner.
 *
 * Separated from the DOM so the rule has one home and can be checked: a total
 * of zero stays indeterminate, because "0 of 0" reads as finished and a caller
 * that has not counted its work yet must not claim it has.
 *
 * @param {{completed?: number, total?: number, unit?: string}} [progress]
 * @returns {{completed: number, total: number, percent: number, text: string}|null}
 */
export function describeProgressBar(progress) {
  const total = Math.max(0, Math.trunc(Number(progress?.total) || 0));
  if (!progress || total <= 0) return null;
  const completed = Math.min(total, Math.max(0, Math.trunc(Number(progress.completed) || 0)));
  const percent = Math.round((completed / total) * 100);
  const unit = String(progress.unit || "").trim();
  return {
    completed,
    total,
    percent,
    text: unit
      ? `${completed} of ${total} ${unit} (${percent}%)`
      : `${completed} of ${total} (${percent}%)`,
  };
}

function ensureStyles(doc) {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const link = doc.createElement("link");
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  link.href = "/ui/shared/components/progress_popup/progress_popup.css?v=20260820dtjob1";
  (doc.head || doc.documentElement)?.appendChild(link);
}

/**
 * Creates a blocking progress popup controller.
 *
 * @param {Object} [options]
 * @param {Document} [options.documentRef=document] - Document that owns the popup.
 * @param {string} [options.title='Working'] - Default card title.
 * @param {boolean} [options.showElapsed=true] - Whether the elapsed counter is rendered.
 * @param {boolean} [options.measured=false] - Keep the card at a fixed size for
 *   its whole life. Set it when the popup will report countable progress: the
 *   card would otherwise start narrow around its first short message and jump
 *   wider the moment a bar and a long step label arrive.
 * @returns {{show: Function, hide: Function, isVisible: Function}}
 */
export function createArcRhoProgressPopup({
  documentRef = document,
  title = "Working",
  showElapsed = true,
  measured = false,
} = {}) {
  const doc = documentRef;
  const defaultTitle = String(title || "Working");
  ensureStyles(doc);

  let overlayEl = null;
  let elapsedFrame = null;
  let startedAt = 0;

  function isVisible() {
    return !!(overlayEl && overlayEl.isConnected);
  }

  /**
   * Shows the popup, or retargets an already visible one.
   *
   * @param {string} [message] - Body text describing the current work.
   * @param {Object} [options]
   * @param {string} [options.title] - Overrides the card title for this call.
   * @param {{completed: number, total: number, unit?: string}} [options.progress]
   *   Countable work. Given one, the card shows a determinate bar and a count
   *   instead of the indeterminate spinner, because a job whose denominator is
   *   known should not be presented as one whose end nobody can see. Omit it
   *   again and the spinner comes back.
   */
  function show(message = "", options = {}) {
    ensureStyles(doc);
    const reuseExisting = isVisible();
    if (!reuseExisting) {
      const overlay = doc.createElement("div");
      overlay.className = "arcrho-load-popup-overlay";
      overlay.innerHTML = `
        <div class="arcrho-load-popup-card" role="alert" aria-live="polite" aria-busy="true">
          <div class="arcrho-load-popup-title"></div>
          <div class="arcrho-load-popup-msg"></div>
          <div class="arcrho-load-popup-spinner" aria-hidden="true"></div>
          <div class="arcrho-load-popup-progress" hidden>
            <div class="arcrho-load-popup-progress-track">
              <div class="arcrho-load-popup-progress-fill"></div>
            </div>
            <div class="arcrho-load-popup-progress-count"></div>
          </div>
          <div class="arcrho-load-popup-elapsed">Elapsed: 0.0s</div>
        </div>
      `;
      const elapsedEl = overlay.querySelector(".arcrho-load-popup-elapsed");
      if (elapsedEl) elapsedEl.hidden = !showElapsed;
      doc.body.appendChild(overlay);
      overlayEl = overlay;
    }
    const titleEl = overlayEl.querySelector(".arcrho-load-popup-title");
    if (titleEl) titleEl.textContent = String(options.title || defaultTitle);
    const msgEl = overlayEl.querySelector(".arcrho-load-popup-msg");
    if (msgEl) msgEl.textContent = String(message || "Working...");
    applyProgress(options.progress);

    // A popup shown at window boot keeps its running elapsed counter when a
    // later step re-announces it; only a fresh popup restarts the clock. The
    // progress above is applied before this returns, so a long job can keep
    // updating its bar without restarting its own clock.
    if (reuseExisting && elapsedFrame) return;

    startedAt = performance.now();
    if (elapsedFrame) cancelAnimationFrame(elapsedFrame);
    const elapsedEl = overlayEl.querySelector(".arcrho-load-popup-elapsed");
    const tick = () => {
      if (!overlayEl) return;
      const sec = (performance.now() - startedAt) / 1000;
      if (elapsedEl) elapsedEl.textContent = `Elapsed: ${sec.toFixed(1)}s`;
      elapsedFrame = requestAnimationFrame(tick);
    };
    elapsedFrame = requestAnimationFrame(tick);
  }

  /** Switches the card between the spinner and a determinate bar. */
  function applyProgress(progress) {
    if (!overlayEl) return;
    const wrap = overlayEl.querySelector(".arcrho-load-popup-progress");
    const spinner = overlayEl.querySelector(".arcrho-load-popup-spinner");
    const fill = overlayEl.querySelector(".arcrho-load-popup-progress-fill");
    const count = overlayEl.querySelector(".arcrho-load-popup-progress-count");
    if (!wrap || !spinner) return;

    const card = overlayEl.querySelector(".arcrho-load-popup-card");
    const bar = describeProgressBar(progress);
    card?.classList.toggle(MEASURED_CLASS, measured || Boolean(bar));
    if (!bar) {
      // A measured popup keeps an empty track rather than swapping a spinner
      // for a bar later: that swap is the one remaining thing that would
      // change the card's height mid-job.
      wrap.hidden = !measured;
      spinner.hidden = measured;
      if (measured) {
        if (fill) fill.style.width = "0%";
        if (count) count.textContent = "";
      }
      return;
    }

    wrap.hidden = false;
    spinner.hidden = true;
    if (fill) fill.style.width = `${bar.percent}%`;
    if (count) count.textContent = bar.text;
    card?.setAttribute("aria-valuenow", String(bar.completed));
    card?.setAttribute("aria-valuemax", String(bar.total));
  }

  /** Removes the popup and stops the elapsed counter. */
  function hide() {
    if (elapsedFrame) {
      cancelAnimationFrame(elapsedFrame);
      elapsedFrame = null;
    }
    if (!overlayEl) return;
    overlayEl.parentNode?.removeChild(overlayEl);
    overlayEl = null;
  }

  return { show, hide, isVisible };
}

/**
 * Wraps one progress popup instance in a scope counter for blocking work that
 * can overlap, such as a method save started from the save bar while a bridge
 * dialog is saving the same window. Each `begin` call owns its own scope and
 * the popup stays up until the last open scope is dismissed, so a scope that
 * ends early cannot pull the spinner out from under the work still running.
 *
 * @param {Object} [options] - Passed through to `createArcRhoProgressPopup`.
 * @returns {{begin: Function, isVisible: Function}}
 */
export function createArcRhoBusyOverlay(options = {}) {
  const popup = createArcRhoProgressPopup(options);
  let depth = 0;

  /**
   * Opens one busy scope and returns its handle.
   *
   * @param {string} [message] - Body text describing the first step.
   * @returns {{setMessage: Function, dismiss: Function}}
   */
  function begin(message) {
    depth += 1;
    popup.show(message);
    let dismissed = false;
    return {
      setMessage(text) {
        if (!dismissed) popup.show(text);
      },
      // Called before any dialog this scope opens, and again when it ends.
      dismiss() {
        if (dismissed) return;
        dismissed = true;
        depth = Math.max(0, depth - 1);
        if (depth === 0) popup.hide();
      },
    };
  }

  return { begin, isVisible: popup.isVisible };
}

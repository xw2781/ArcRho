/*
===============================================================================
Shared progress popup - centered spinner card shown while a window is busy
===============================================================================
Each caller creates its own popup instance so one window can own separate
busy states (for example dataset loading and method saving) without the
instances fighting over a single DOM node.
*/

const STYLE_ID = "arcrhoProgressPopupStyles";

function ensureStyles(doc) {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const link = doc.createElement("link");
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  link.href = "/ui/shared/components/progress_popup/progress_popup.css?v=20260813e";
  (doc.head || doc.documentElement)?.appendChild(link);
}

/**
 * Creates a blocking progress popup controller.
 *
 * @param {Object} [options]
 * @param {Document} [options.documentRef=document] - Document that owns the popup.
 * @param {string} [options.title='Working'] - Default card title.
 * @param {boolean} [options.showElapsed=true] - Whether the elapsed counter is rendered.
 * @returns {{show: Function, hide: Function, isVisible: Function}}
 */
export function createArcRhoProgressPopup({
  documentRef = document,
  title = "Working",
  showElapsed = true,
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

    // A popup shown at window boot keeps its running elapsed counter when a
    // later step re-announces it; only a fresh popup restarts the clock.
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

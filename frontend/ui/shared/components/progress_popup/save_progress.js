/*
===============================================================================
Shared save progress - one saving animation for every ArcRho editor window
===============================================================================
Every method window and the Dataset window run the same shape of save: prepare
the object (recalculate, refresh origin labels, re-read sources), write it,
then queue the dependent updates. This module owns that vocabulary so all of
them raise the same card, report the same steps, and drop the spinner at the
same point, instead of each page wording and sequencing its own.

A page creates one instance and wraps its save entry point in `run`:

    const saveProgress = createArcRhoSaveProgress({ subject: "Cape Cod" });
    async function saveCapeCod() {
      return saveProgress.run((progress) => runCapeCodSave(progress));
    }

Inside the save, `progress.writing()` announces the write step and
`progress.finish()` drops the spinner before any dialog the save opens, so a
review warning or an error message box never appears behind it. `run` always
dismisses on the way out, including when the save throws, so a page cannot
strand the overlay by adding a new early return.

*/

import { createArcRhoBusyOverlay } from "/ui/shared/components/progress_popup/progress_popup.js?v=20260813e";
import { showPageMessageBox } from "/ui/shared/components/message_box/message_box.js?v=20260816a";
import { openMethodReviewDataset } from "/ui/shared/components/message_box/method_save_review_warning.js?v=20260813e";

/**
 * Creates the saving animation controller for one window.
 *
 * @param {Object} options
 * @param {string} options.subject - Saved object name, such as `Cape Cod`.
 * @param {string} [options.noun='method'] - Word the step messages use for the
 *   saved object; the Dataset window passes `dataset`.
 * @param {Document} [options.documentRef] - Document that owns the popup.
 * @returns {{run: Function, isVisible: Function}}
 */
export function createArcRhoSaveProgress({ subject, noun = "method", documentRef } = {}) {
  const savedSubject = String(subject || "").trim() || "Method";
  const savedNoun = String(noun || "").trim() || "method";
  const overlay = createArcRhoBusyOverlay({ documentRef, title: `Saving ${savedSubject}` });

  /**
   * Runs one save behind the saving animation.
   *
   * @param {(progress: {writing: Function, finish: Function}) => Promise<any>} work
   * @returns {Promise<any>} Whatever `work` resolves to.
   */
  async function run(work) {
    let message = `Preparing the ${savedNoun} before saving.`;
    let scope = overlay.begin(message);
    const progress = {
      /** Announces the write and dependent-update step. */
      writing() {
        message = `Saving the ${savedNoun} and updating dependent objects.`;
        scope.setMessage(message);
      },
      /** Retargets the card headline; used by queued refresh flows that
       *  still poll a propagation job. Engine-hosted saves complete inline,
       *  so an ordinary save never streams live updates. */
      setMessage(text) {
        const line = String(text || "").trim();
        if (!line) return;
        message = line;
        scope.setMessage(message);
      },
      /** Drops the spinner; call before any dialog the save opens. */
      finish() {
        scope.dismiss();
      },
    };
    try {
      return await work(progress);
    } finally {
      scope.dismiss();
    }
  }

  return { run, isVisible: overlay.isVisible };
}

/**
 * Stand-in for hosts that install a page module without a document, such as
 * unit tests. It runs the save with inert progress calls.
 *
 * @type {{run: Function, isVisible: Function}}
 */
export const inertArcRhoSaveProgress = {
  run: (work) => work({
    writing() {},
    setMessage() {},
    finish() {},
  }),
  isVisible: () => false,
};

/**
 * Shows the post-save notice naming the dependent datasets the Engine
 * refreshed during the save. Explicit Save commands await this so the user
 * sees exactly which dataset instances were rewritten. A save that refreshed
 * nothing has nothing to report, so it resolves without raising a dialog
 * rather than interrupting the user to say that no dependent needed an update.
 *
 * The notice does not time out: the list of refreshed datasets is the only
 * record the user gets of what the save rewrote, so it waits for them to read
 * it. Any normal dismissal closes it - OK, the close button, Esc, or a click
 * anywhere in the window outside the box - which the message box already
 * provides, so the notice only has to decline the auto-close timer.
 *
 * Each refreshed dataset is one row of its own, and each row is the same link
 * the review warning uses: clicking it asks the containing Project Instance to
 * open that name, which lands on the owning method page when the dataset is a
 * method output and on the dataset page otherwise. Reusing
 * `openMethodReviewDataset` keeps one owner for that request, so the notice
 * never grows its own copy of the message. The rows stay clickable while the
 * notice is up, so a save that refreshed several dependents can be walked
 * through one at a time.
 *
 * @param {string[]} refreshedDatasets - Names from the save response's
 *   `propagation.refreshed_datasets`.
 * @param {Object} [options]
 * @param {Document} [options.documentRef] - Document that owns the notice.
 * @param {Window} [options.windowRef] - Window whose parent Project Instance
 *   opens a clicked dataset; defaults to the page's own window.
 * @returns {Promise<void>} Resolves when the user dismisses the notice,
 *   immediately when no dependent was refreshed.
 */
export async function showSavedDependentsNotice(refreshedDatasets, { documentRef, windowRef } = {}) {
  const names = (Array.isArray(refreshedDatasets) ? refreshedDatasets : [])
    .map((name) => String(name || "").trim())
    .filter(Boolean);
  if (!names.length) return;
  await showPageMessageBox({
    title: "Saved",
    message: names.length === 1
      ? "1 dependent dataset was updated:"
      : `${names.length} dependent datasets were updated:`,
    links: names.map((name) => ({
      label: name,
      ariaLabel: `Open related method or dataset ${name} in Project Instance`,
    })),
    onLinkClick: (item) => openMethodReviewDataset(item?.label, windowRef ? { windowRef } : {}),
    documentRef: documentRef || document,
  });
}

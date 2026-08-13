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

import { createArcRhoBusyOverlay } from "/ui/shared/components/progress_popup/progress_popup.js?v=20260813a";

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
    const scope = overlay.begin(`Preparing the ${savedNoun} before saving.`);
    const progress = {
      /** Announces the write and dependent-update step. */
      writing() {
        scope.setMessage(`Saving the ${savedNoun} and updating dependent objects.`);
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
  run: (work) => work({ writing() {}, finish() {} }),
  isVisible: () => false,
};

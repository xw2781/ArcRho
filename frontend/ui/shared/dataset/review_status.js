// Review status of a persisted dataset or method output.
//
// `arcrho_api.dataset_index_contract` owns the codes a sidecar's `status`
// field may carry: 0 for Updated and 2 for Review Needed. This module is the
// frontend's single reading of that rule, so every surface that reacts to the
// flag - the Project Instance Status column, a method window deciding whether
// Save stays available while nothing has been edited - agrees about what the
// stored number means.

export const STATUS_CURRENT = 0;
export const STATUS_REVIEW_NEEDED = 2;

/** Normalizes any persisted `status` value to one of the two canonical codes. */
export function normalizeReviewStatus(value) {
  return Number(value) === STATUS_REVIEW_NEEDED ? STATUS_REVIEW_NEEDED : STATUS_CURRENT;
}

/** True when the object carries the Needs Review flag. */
export function statusNeedsReview(value) {
  return normalizeReviewStatus(value) === STATUS_REVIEW_NEEDED;
}
